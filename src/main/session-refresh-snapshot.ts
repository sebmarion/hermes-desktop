import type { SessionRefreshScope } from "../shared/session-refresh";

export interface SessionRefreshSnapshotStore<T> {
  recordWindow(
    scope: SessionRefreshScope,
    limit?: number,
    offset?: number,
  ): number;
  desiredLimit(scope: SessionRefreshScope): number;
  store(scope: SessionRefreshScope, coverageLimit: number, rows: T[]): void;
  read(scope: SessionRefreshScope, limit?: number, offset?: number): T[] | null;
}

interface Snapshot<T> {
  coverageLimit: number;
  rows: T[];
}

function scopeKey(scope: SessionRefreshScope): string {
  return JSON.stringify([
    scope.mode,
    scope.profile,
    scope.connectionGeneration,
  ]);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function createSessionRefreshSnapshotStore<T>(
  defaultLimit: number,
): SessionRefreshSnapshotStore<T> {
  const desiredLimits = new Map<string, number>();
  const snapshots = new Map<string, Snapshot<T>>();
  const normalizedDefaultLimit = Math.max(1, Math.floor(defaultLimit));

  const requestedEnd = (limit?: number, offset?: number): number =>
    positiveInteger(offset, 0) + positiveInteger(limit, normalizedDefaultLimit);

  return {
    recordWindow(scope, limit, offset): number {
      const key = scopeKey(scope);
      const desired = Math.max(
        normalizedDefaultLimit,
        desiredLimits.get(key) ?? 0,
        requestedEnd(limit, offset),
      );
      desiredLimits.set(key, desired);
      return desired;
    },

    desiredLimit(scope): number {
      return desiredLimits.get(scopeKey(scope)) ?? normalizedDefaultLimit;
    },

    store(scope, coverageLimit, rows): void {
      snapshots.set(scopeKey(scope), {
        coverageLimit: Math.max(0, Math.floor(coverageLimit)),
        rows: rows.slice(),
      });
    },

    read(scope, limit, offset): T[] | null {
      const snapshot = snapshots.get(scopeKey(scope));
      const end = requestedEnd(limit, offset);
      if (!snapshot || snapshot.coverageLimit < end) return null;
      const start = positiveInteger(offset, 0);
      return snapshot.rows.slice(start, end);
    },
  };
}
