import type {
  SessionCacheRefreshedNotice,
  SessionRefreshScope,
} from "../shared/session-refresh";
import { sameSessionRefreshScope } from "../shared/session-refresh";

export const SESSION_REFRESH_INTERVAL_MS = 5_000;

export interface SessionRefreshCoordinatorOptions<T> {
  getScope: () => SessionRefreshScope;
  hasLiveWindow: () => boolean;
  refresh: (scope: SessionRefreshScope) => Promise<T>;
  publish: (notice: SessionCacheRefreshedNotice) => void;
  logError?: (message: string, error: unknown) => void;
}

export interface SessionRefreshCoordinator<T> {
  start(): void;
  stop(): void;
  request(): Promise<T>;
  getCurrentScope(): SessionRefreshScope;
}

interface InFlight<T> {
  scope: SessionRefreshScope;
  promise: Promise<T>;
}

interface Pending<T> {
  scope: SessionRefreshScope;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createPending<T>(scope: SessionRefreshScope): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { scope, promise, resolve, reject };
}

export function createSessionRefreshCoordinator<T>(
  options: SessionRefreshCoordinatorOptions<T>,
): SessionRefreshCoordinator<T> {
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: InFlight<T> | null = null;
  let pending: Pending<T> | null = null;
  let refreshGeneration = 0;
  let disposed = false;

  const logError =
    options.logError ??
    ((message: string, error: unknown): void => {
      console.error(message, error);
    });

  const startRun = (scope: SessionRefreshScope): Promise<T> => {
    let refreshPromise: Promise<T>;
    try {
      refreshPromise = Promise.resolve(options.refresh(scope));
    } catch (error) {
      refreshPromise = Promise.reject(error);
    }
    const promise = refreshPromise
      .then((value) => {
        if (
          !disposed &&
          options.hasLiveWindow() &&
          sameSessionRefreshScope(scope, options.getScope())
        ) {
          refreshGeneration += 1;
          options.publish({ scope, generation: refreshGeneration });
        }
        return value;
      })
      .catch((error: unknown) => {
        logError("Background session refresh failed", error);
        throw error;
      })
      .finally(() => {
        if (inFlight?.promise !== promise) return;
        inFlight = null;

        const queued = pending;
        pending = null;
        const currentScope = options.getScope();
        const needsCurrentScopeRun = !sameSessionRefreshScope(
          scope,
          currentScope,
        );
        if (
          disposed ||
          !options.hasLiveWindow() ||
          (!queued && !needsCurrentScopeRun)
        ) {
          return;
        }

        const followUp = startRun(currentScope);
        if (queued) {
          followUp.then(queued.resolve, queued.reject);
        } else {
          void followUp.catch(() => undefined);
        }
      });

    inFlight = { scope, promise };
    return promise;
  };

  const request = (): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("Session refresh coordinator is stopped"));
    }

    const scope = options.getScope();
    if (!inFlight) return startRun(scope);
    if (sameSessionRefreshScope(inFlight.scope, scope)) {
      return inFlight.promise;
    }

    if (!pending) pending = createPending(scope);
    else pending.scope = scope;
    return pending.promise;
  };

  return {
    start(): void {
      if (disposed || interval) return;
      interval = setInterval(() => {
        if (!options.hasLiveWindow()) return;
        void request().catch(() => undefined);
      }, SESSION_REFRESH_INTERVAL_MS);
    },

    stop(): void {
      if (disposed) return;
      disposed = true;
      if (interval) clearInterval(interval);
      interval = null;
    },

    request,

    getCurrentScope(): SessionRefreshScope {
      return options.getScope();
    },
  };
}
