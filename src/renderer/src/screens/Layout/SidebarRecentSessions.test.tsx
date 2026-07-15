import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionCacheRefreshedNotice } from "../../../../shared/session-refresh";
import SidebarRecentSessions from "./SidebarRecentSessions";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: () => {},
  }),
}));

interface TestSession {
  id: string;
  title: string;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
  contextFolder: null;
}

function makeSessions(count: number, titlePrefix = "Session"): TestSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `${titlePrefix} ${index + 1}`,
    startedAt: 2_000_000_000 - index,
    source: "desktop",
    messageCount: 1,
    model: "test-model",
    contextFolder: null,
  }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installHermesAPI(sessions: TestSession[]): {
  listCachedSessions: ReturnType<typeof vi.fn>;
  getSessionRefreshScope: ReturnType<typeof vi.fn>;
  emitRefresh: (notice: SessionCacheRefreshedNotice) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let refreshListener: ((notice: SessionCacheRefreshedNotice) => void) | null =
    null;
  const unsubscribe = vi.fn(() => {
    refreshListener = null;
  });
  const listCachedSessions = vi.fn((limit = sessions.length, offset = 0) =>
    Promise.resolve(sessions.slice(offset, offset + limit)),
  );
  const getSessionRefreshScope = vi.fn().mockResolvedValue({
    mode: "local",
    profile: "default",
    connectionGeneration: 0,
  });
  const api = {
    listCachedSessions,
    syncSessionCache: vi.fn().mockResolvedValue(sessions),
    getSessionRefreshScope,
    onSessionCacheRefreshed: vi.fn(
      (listener: (notice: SessionCacheRefreshedNotice) => void) => {
        refreshListener = listener;
        return unsubscribe;
      },
    ),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    setSessionContextFolder: vi.fn().mockResolvedValue(undefined),
    selectFolder: vi.fn().mockResolvedValue(null),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    listCachedSessions,
    getSessionRefreshScope,
    emitRefresh: (notice) => refreshListener?.(notice),
    unsubscribe,
  };
}

function renderSidebar(scrollRoot: HTMLDivElement): ReturnType<typeof render> {
  return render(
    <SidebarRecentSessions
      open={true}
      activeProfile="default"
      currentSessionId={null}
      loadingSessionIds={new Set()}
      resumingSessionId={null}
      onSelect={() => {}}
      scrollRootRef={{ current: scrollRoot }}
    />,
  );
}

function refreshNotice(
  profile = "default",
  generation = 1,
): SessionCacheRefreshedNotice {
  return {
    scope: { mode: "local", profile, connectionGeneration: 0 },
    generation,
  };
}

describe("SidebarRecentSessions background refresh", () => {
  it("reloads the full loaded window plus one sentinel without truncating", async () => {
    const sessions = makeSessions(61);
    const api = installHermesAPI(sessions);
    const scrollRoot = document.createElement("div");
    Object.defineProperties(scrollRoot, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    renderSidebar(scrollRoot);

    expect(await screen.findByText("Session 30")).toBeTruthy();
    scrollRoot.scrollTop = 400;
    await act(async () => {
      scrollRoot.dispatchEvent(new Event("scroll"));
    });
    expect(await screen.findByText("Session 61")).toBeTruthy();

    api.listCachedSessions.mockClear();
    await act(async () => {
      api.emitRefresh(refreshNotice());
    });

    await waitFor(() => {
      expect(api.listCachedSessions).toHaveBeenCalledWith(
        sessions.length + 1,
        0,
      );
    });
    expect(screen.getByText("Session 61")).toBeTruthy();
  });

  it("ignores another profile's notice and unsubscribes on unmount", async () => {
    const api = installHermesAPI(makeSessions(2));
    const scrollRoot = document.createElement("div");
    const view = renderSidebar(scrollRoot);
    expect(await screen.findByText("Session 1")).toBeTruthy();
    api.listCachedSessions.mockClear();

    await act(async () => {
      api.emitRefresh(refreshNotice("work"));
      await Promise.resolve();
    });
    expect(api.listCachedSessions).not.toHaveBeenCalled();

    view.unmount();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let an older notice read overwrite a newer one", async () => {
    const api = installHermesAPI(makeSessions(1, "Initial"));
    const scrollRoot = document.createElement("div");
    renderSidebar(scrollRoot);
    expect(await screen.findByText("Initial 1")).toBeTruthy();

    const older = deferred<TestSession[]>();
    const newer = deferred<TestSession[]>();
    api.listCachedSessions.mockClear();
    api.listCachedSessions
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    await act(async () => {
      api.emitRefresh(refreshNotice("default", 2));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      api.emitRefresh(refreshNotice("default", 3));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listCachedSessions).toHaveBeenCalledTimes(2);

    newer.resolve(makeSessions(1, "Newest"));
    expect(await screen.findByText("Newest 1")).toBeTruthy();

    older.resolve(makeSessions(1, "Older"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Newest 1")).toBeTruthy();
    expect(screen.queryByText("Older 1")).toBeNull();
  });

  it("does not truncate a page that appends while a notice read is pending", async () => {
    const sessions = makeSessions(61);
    const api = installHermesAPI(sessions);
    const scrollRoot = document.createElement("div");
    Object.defineProperties(scrollRoot, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    renderSidebar(scrollRoot);
    expect(await screen.findByText("Session 30")).toBeTruthy();

    const noticeRows = deferred<TestSession[]>();
    const nextPage = deferred<TestSession[]>();
    api.listCachedSessions.mockClear();
    api.listCachedSessions
      .mockImplementationOnce(() => noticeRows.promise)
      .mockImplementationOnce(() => nextPage.promise);

    await act(async () => {
      api.emitRefresh(refreshNotice());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listCachedSessions).toHaveBeenCalledWith(31, 0);

    scrollRoot.scrollTop = 400;
    await act(async () => {
      scrollRoot.dispatchEvent(new Event("scroll"));
    });
    expect(api.listCachedSessions).toHaveBeenCalledWith(31, 30);

    await act(async () => {
      nextPage.resolve(sessions.slice(30, 61));
      await Promise.resolve();
      noticeRows.resolve(makeSessions(31, "Refreshed"));
      await Promise.resolve();
    });
    expect(await screen.findByText("Session 60")).toBeTruthy();
    expect(screen.queryByText("Refreshed 1")).toBeNull();
  });

  it("does not append a stale page after a notice replaces the window", async () => {
    const sessions = makeSessions(61);
    const api = installHermesAPI(sessions);
    const scrollRoot = document.createElement("div");
    Object.defineProperties(scrollRoot, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    renderSidebar(scrollRoot);
    expect(await screen.findByText("Session 30")).toBeTruthy();

    const stalePage = deferred<TestSession[]>();
    api.listCachedSessions.mockClear();
    api.listCachedSessions
      .mockImplementationOnce(() => stalePage.promise)
      .mockResolvedValueOnce(makeSessions(31, "Refreshed"));

    scrollRoot.scrollTop = 400;
    await act(async () => {
      scrollRoot.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    expect(api.listCachedSessions).toHaveBeenCalledWith(31, 30);

    await act(async () => {
      api.emitRefresh(refreshNotice());
    });
    expect(await screen.findByText("Refreshed 1")).toBeTruthy();

    stalePage.resolve(sessions.slice(30, 61));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Refreshed 1")).toBeTruthy();
    expect(screen.queryByText("Session 31")).toBeNull();
  });
});
