import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRefreshScope } from "../shared/session-refresh";
import {
  createSessionRefreshCoordinator,
  SESSION_REFRESH_INTERVAL_MS,
} from "./session-refresh-coordinator";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function localScope(
  profile = "default",
  connectionGeneration = 0,
): SessionRefreshScope {
  return { mode: "local", profile, connectionGeneration };
}

describe("session refresh coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every five seconds only while a live window exists", async () => {
    let hasLiveWindow = true;
    const refresh = vi.fn().mockResolvedValue(["fresh"]);
    const publish = vi.fn();
    const coordinator = createSessionRefreshCoordinator({
      getScope: () => localScope(),
      hasLiveWindow: () => hasLiveWindow,
      refresh,
      publish,
    });

    expect(SESSION_REFRESH_INTERVAL_MS).toBe(5_000);
    coordinator.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      scope: localScope(),
      generation: 1,
    });

    hasLiveWindow = false;
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    hasLiveWindow = true;
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      scope: localScope(),
      generation: 2,
    });
  });

  it("shares one in-flight request across explicit callers and interval ticks", async () => {
    const slow = deferred<string[]>();
    const refresh = vi.fn().mockReturnValue(slow.promise);
    const coordinator = createSessionRefreshCoordinator({
      getScope: () => localScope(),
      hasLiveWindow: () => true,
      refresh,
      publish: vi.fn(),
    });

    coordinator.start();
    const first = coordinator.request();
    const second = coordinator.request();
    expect(second).toBe(first);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);

    slow.resolve(["done"]);
    await expect(first).resolves.toEqual(["done"]);
    await expect(second).resolves.toEqual(["done"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("drops an old scope and immediately runs one newest-scope follow-up", async () => {
    let scope = localScope("default", 0);
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const refresh = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const coordinator = createSessionRefreshCoordinator({
      getScope: () => scope,
      hasLiveWindow: () => true,
      refresh,
      publish,
    });

    const oldRequest = coordinator.request();
    scope = localScope("work", 1);
    const newestRequest = coordinator.request();
    const joinedNewestRequest = coordinator.request();
    expect(joinedNewestRequest).toBe(newestRequest);
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve(["old"]);
    await expect(oldRequest).resolves.toEqual(["old"]);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(localScope("work", 1));

    second.resolve(["new"]);
    await expect(newestRequest).resolves.toEqual(["new"]);
    await expect(joinedNewestRequest).resolves.toEqual(["new"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      scope: localScope("work", 1),
      generation: 1,
    });
  });

  it("retries a failed background refresh on the next cadence", async () => {
    const error = new Error("temporary failure");
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(["recovered"]);
    const publish = vi.fn();
    const logError = vi.fn();
    const coordinator = createSessionRefreshCoordinator({
      getScope: () => localScope(),
      hasLiveWindow: () => true,
      refresh,
      publish,
      logError,
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(logError).toHaveBeenCalledWith(
      "Background session refresh failed",
      error,
    );
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("stops future ticks and suppresses publication from late work", async () => {
    const slow = deferred<string[]>();
    const refresh = vi.fn().mockReturnValue(slow.promise);
    const publish = vi.fn();
    const coordinator = createSessionRefreshCoordinator({
      getScope: () => localScope(),
      hasLiveWindow: () => true,
      refresh,
      publish,
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    coordinator.stop();
    slow.resolve(["late"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
