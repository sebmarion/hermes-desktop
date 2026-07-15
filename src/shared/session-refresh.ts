export interface SessionRefreshScope {
  mode: "local" | "remote" | "ssh";
  profile: string;
  connectionGeneration: number;
}

export interface SessionCacheRefreshedNotice {
  scope: SessionRefreshScope;
  generation: number;
}

export function sameSessionRefreshScope(
  left: SessionRefreshScope,
  right: SessionRefreshScope,
): boolean {
  return (
    left.mode === right.mode &&
    left.profile === right.profile &&
    left.connectionGeneration === right.connectionGeneration
  );
}
