import type { SessionCacheRefreshedNotice } from "../shared/session-refresh";

interface SessionRefreshIpc {
  on(
    channel: string,
    listener: (
      event: Electron.IpcRendererEvent,
      notice: SessionCacheRefreshedNotice,
    ) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (
      event: Electron.IpcRendererEvent,
      notice: SessionCacheRefreshedNotice,
    ) => void,
  ): unknown;
}

export function subscribeToSessionCacheRefreshed(
  ipc: SessionRefreshIpc,
  callback: (notice: SessionCacheRefreshedNotice) => void,
): () => void {
  const handler = (
    _event: Electron.IpcRendererEvent,
    notice: SessionCacheRefreshedNotice,
  ): void => callback(notice);
  ipc.on("session-cache-refreshed", handler);
  return () => ipc.removeListener("session-cache-refreshed", handler);
}
