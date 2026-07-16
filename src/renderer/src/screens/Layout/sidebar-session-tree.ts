export interface SidebarSessionRow {
  id: string;
  title: string;
  parentSessionId?: string | null;
  relationshipType?: string;
  pinned?: boolean;
  isWorking?: boolean;
  activityPhase?: string;
  children?: SidebarSessionRow[];
}

/** Return the parent-only conversation list used by Hermes WebUI.
 *
 * Child-session rows are reference metadata, not independent conversations.
 * When their visible ancestor is loaded, bubble working/pin state to it; when
 * it is not loaded, suppress the orphan reference instead of promoting it.
 */
export function attachSidebarChildSessions<T extends SidebarSessionRow>(
  rows: readonly T[],
): T[] {
  const copied = rows.map((row) => ({ ...row, children: undefined })) as T[];
  const byId = new Map(copied.map((row) => [row.id, row] as const));

  for (const row of copied) {
    if (row.relationshipType !== "child_session") continue;

    let parent = row.parentSessionId
      ? byId.get(row.parentSessionId)
      : undefined;
    const seen = new Set<string>([row.id]);
    while (
      parent &&
      parent.relationshipType === "child_session" &&
      parent.parentSessionId &&
      !seen.has(parent.id)
    ) {
      seen.add(parent.id);
      parent = byId.get(parent.parentSessionId);
    }
    if (!parent || parent.relationshipType === "child_session") continue;

    if (row.pinned) parent.pinned = true;
    if (row.isWorking) {
      parent.isWorking = true;
      parent.activityPhase = row.activityPhase ?? parent.activityPhase;
    }
  }

  return copied.filter((row) => row.relationshipType !== "child_session");
}
