import { describe, expect, it, vi } from "vitest";
import type { SessionCacheRefreshedNotice } from "../shared/session-refresh";
import { subscribeToSessionCacheRefreshed } from "./session-refresh";

describe("session refresh preload subscription", () => {
  it("forwards typed notices and removes the exact wrapped listener", () => {
    let registeredHandler:
      | ((event: Electron.IpcRendererEvent, notice: unknown) => void)
      | null = null;
    const ipc = {
      on: vi.fn(
        (
          _channel: string,
          handler: (event: Electron.IpcRendererEvent, notice: unknown) => void,
        ) => {
          registeredHandler = handler;
        },
      ),
      removeListener: vi.fn(),
    };
    const callback = vi.fn();
    const notice: SessionCacheRefreshedNotice = {
      scope: {
        mode: "local",
        profile: "default",
        connectionGeneration: 4,
      },
      generation: 9,
    };

    const unsubscribe = subscribeToSessionCacheRefreshed(ipc, callback);
    expect(ipc.on).toHaveBeenCalledWith(
      "session-cache-refreshed",
      expect.any(Function),
    );

    expect(registeredHandler).not.toBeNull();
    const handler = registeredHandler as unknown as (
      event: Electron.IpcRendererEvent,
      value: unknown,
    ) => void;
    handler({} as Electron.IpcRendererEvent, notice);
    expect(callback).toHaveBeenCalledWith(notice);

    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(
      "session-cache-refreshed",
      handler,
    );
  });
});
