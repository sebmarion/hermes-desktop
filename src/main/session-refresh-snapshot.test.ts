import { describe, expect, it } from "vitest";
import type { SessionRefreshScope } from "../shared/session-refresh";
import { createSessionRefreshSnapshotStore } from "./session-refresh-snapshot";

function scope(
  profile = "default",
  connectionGeneration = 0,
): SessionRefreshScope {
  return { mode: "remote", profile, connectionGeneration };
}

describe("session refresh snapshot store", () => {
  it("tracks the largest requested window for each exact scope", () => {
    const snapshots = createSessionRefreshSnapshotStore<string>(50);

    expect(snapshots.desiredLimit(scope())).toBe(50);
    expect(snapshots.recordWindow(scope(), 30, 30)).toBe(60);
    expect(snapshots.recordWindow(scope(), 10, 0)).toBe(60);
    expect(snapshots.desiredLimit(scope())).toBe(60);
    expect(snapshots.desiredLimit(scope("work"))).toBe(50);
    expect(snapshots.desiredLimit(scope("default", 1))).toBe(50);
  });

  it("serves slices only after one coordinated refresh covers the window", () => {
    const snapshots = createSessionRefreshSnapshotStore<string>(50);
    const currentScope = scope();
    const rows = Array.from({ length: 60 }, (_, index) => `row-${index + 1}`);

    snapshots.recordWindow(currentScope, 30, 30);
    snapshots.store(currentScope, 50, rows.slice(0, 50));
    expect(snapshots.read(currentScope, 30, 30)).toBeNull();

    snapshots.store(currentScope, 60, rows);
    expect(snapshots.read(currentScope, 30, 30)).toEqual(rows.slice(30, 60));
  });

  it("treats a short response as complete for the attempted coverage", () => {
    const snapshots = createSessionRefreshSnapshotStore<string>(50);
    const currentScope = scope();

    snapshots.store(currentScope, 80, ["only-row"]);

    expect(snapshots.read(currentScope, 30, 30)).toEqual([]);
  });
});
