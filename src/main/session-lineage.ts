export interface CompressionLineageRow {
  id: string;
  parentSessionId?: string | null;
  endReason?: string | null;
  modelConfig?: string | Record<string, unknown> | null;
  source?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActive?: number | null;
  messageCount?: number | null;
  title?: string | null;
  cwd?: string | null;
  archived?: boolean | number | null;
  pinned?: boolean | number | null;
  contextFolder?: string | null;
  relationshipType?: string;
  lineageRootId?: string;
  lineageMemberIds?: string[];
  compressionSegmentCount?: number;
}

export interface CompressionLineageProjection<T extends CompressionLineageRow> {
  projected: T[];
  canonicalBySessionId: Map<string, T>;
}

function modelConfigRecord(
  value: CompressionLineageRow["modelConfig"],
): Record<string, unknown> {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hasRelationshipMarker(row: CompressionLineageRow): boolean {
  const config = modelConfigRecord(row.modelConfig);
  return Boolean(config._branched_from || config._delegate_from);
}

function isCompressionContinuation(
  parent: CompressionLineageRow | undefined,
  child: CompressionLineageRow,
): boolean {
  if (!parent || parent.endReason !== "compression") return false;
  if (child.parentSessionId !== parent.id) return false;
  if (child.relationshipType === "child_session") return false;
  if ((child.source || "").toLowerCase() === "tool") return false;
  if (hasRelationshipMarker(child)) return false;

  const parentSource = (parent.source || "").trim().toLowerCase();
  const childSource = (child.source || "").trim().toLowerCase();
  if (!parentSource || !childSource || parentSource !== childSource)
    return false;

  // A child that started before the compression parent actually closed is a
  // concurrent/subthread session, not a continuation. WebUI uses the same
  // boundary guard; without it Hermes One incorrectly folds these rows into
  // the parent's lineage and never renders the subthread independently.
  if (parent.endedAt != null) {
    const parentEnded = Number(parent.endedAt);
    const childStarted = Number(child.startedAt);
    if (
      !Number.isFinite(parentEnded) ||
      !Number.isFinite(childStarted) ||
      childStarted < parentEnded
    ) {
      return false;
    }
  }
  return true;
}

function activityScore(row: CompressionLineageRow): number {
  const value = row.lastActive ?? row.startedAt ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageCount(row: CompressionLineageRow): number {
  const value = row.messageCount ?? 0;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function continuationPriority(row: CompressionLineageRow): number {
  if (row.endReason === "compression") return 0;
  if (row.endedAt == null) return 1;
  return 2;
}

function compareContinuationCandidates(
  a: CompressionLineageRow,
  b: CompressionLineageRow,
): number {
  return (
    continuationPriority(a) - continuationPriority(b) ||
    Number(messageCount(b) > 0) - Number(messageCount(a) > 0) ||
    activityScore(b) - activityScore(a) ||
    (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
    b.id.localeCompare(a.id)
  );
}

const GENERIC_CONVERSATION_TITLES = new Set([
  "untitled",
  "new chat",
  "new conversation",
  "cli session",
  "tui session",
  "acp session",
  "continue the unfinished task from the parent",
]);

function isGenericConversationTitle(title: string | null | undefined): boolean {
  const normalized = (title || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  return GENERIC_CONVERSATION_TITLES.has(normalized);
}

function isGeneratedContinuationTitle(
  tipTitle: string | null | undefined,
  rootTitle: string | null | undefined,
): boolean {
  const tip = (tipTitle || "").trim();
  const root = (rootTitle || "").trim();
  const prefix = `${root} #`;
  return Boolean(
    root && tip.startsWith(prefix) && /^\d+$/.test(tip.slice(prefix.length)),
  );
}

function mergeRootFallbacks<T extends CompressionLineageRow>(
  root: T,
  tip: T,
  segmentCount: number,
): T {
  const merged = {
    ...root,
    ...tip,
  } as T;

  if (segmentCount > 1) {
    merged.lineageRootId = root.id;
    merged.compressionSegmentCount = segmentCount;
  }

  // Compression continuations do not always inherit desktop-only metadata or a
  // generated title. Keep the root values only when the selected tip lacks one.
  const rootTitle = root.title?.trim();
  const tipTitle = tip.title?.trim();
  if (
    rootTitle &&
    (!tipTitle ||
      isGeneratedContinuationTitle(tipTitle, rootTitle) ||
      (isGenericConversationTitle(tipTitle) &&
        !isGenericConversationTitle(rootTitle)))
  ) {
    merged.title = rootTitle;
  } else if (tipTitle) {
    merged.title = tipTitle;
  }
  if (!tip.contextFolder && root.contextFolder) {
    merged.contextFolder = root.contextFolder;
  }
  if (!tip.cwd && root.cwd) merged.cwd = root.cwd;
  if (tip.archived == null && root.archived != null)
    merged.archived = root.archived;
  if (Boolean(root.pinned) && !Boolean(tip.pinned)) merged.pinned = true;
  return merged;
}

/** Match the user-facing WebUI conversation list for local state.db rows. */
export function isSharedConversationVisible(
  row: Pick<CompressionLineageRow, "source" | "messageCount"> & {
    message_count?: number | null;
    isWorking?: boolean;
  },
): boolean {
  const count =
    row.messageCount ??
    (typeof row.message_count === "number" ? row.message_count : 0);
  if (count <= 0 && !row.isWorking) return false;
  const source = (row.source || "").trim().toLowerCase();
  if (!source) return false;
  if (
    source === "subagent" ||
    source === "tool" ||
    source === "cron" ||
    source.startsWith("cron-") ||
    source === "webhook" ||
    source === "messaging"
  ) {
    return false;
  }
  return new Set([
    "webui",
    "cli",
    "tui",
    "acp",
    "api_server",
    "external_agent",
    "external-agent",
    "claude_code",
    "desktop",
  ]).has(source);
}

export const SHARED_CLI_VISIBLE_LIMIT = 20;

export function isSharedCliConversation(
  row: Pick<CompressionLineageRow, "source">,
): boolean {
  return new Set([
    "cli",
    "tui",
    "acp",
    "external_agent",
    "external-agent",
    "claude_code",
  ]).has((row.source || "").trim().toLowerCase());
}

/** Keep state.db rows aligned with WebUI's capped imported-session window. */
export function limitSharedConversationRows<T extends CompressionLineageRow>(
  rows: readonly T[],
): T[] {
  const visible = rows.filter(isSharedConversationVisible);
  const imported = visible
    .filter(isSharedCliConversation)
    .slice(0, SHARED_CLI_VISIBLE_LIMIT);
  return [
    ...visible.filter((row) => !isSharedCliConversation(row)),
    ...imported,
  ].sort(
    (a, b) => activityScore(b) - activityScore(a) || b.id.localeCompare(a.id),
  );
}

/**
 * Collapse each read-only compression chain into one visible canonical tip.
 * Branches, delegated children, tool runs, and cross-source children remain
 * independent. The function never mutates its input rows or persistent state.
 */
export function buildCompressionLineageProjection<
  T extends CompressionLineageRow,
>(rows: readonly T[]): CompressionLineageProjection<T> {
  const copied = rows
    .filter((row) => row && typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({ ...row })) as T[];
  const byId = new Map(copied.map((row) => [row.id, row] as const));
  const continuationChildren = new Map<string, T[]>();
  const continuationChildIds = new Set<string>();

  for (const child of copied) {
    const parentId = child.parentSessionId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!isCompressionContinuation(parent, child)) continue;
    const children = continuationChildren.get(parentId) ?? [];
    children.push(child);
    continuationChildren.set(parentId, children);
    continuationChildIds.add(child.id);
  }
  for (const children of continuationChildren.values()) {
    children.sort(compareContinuationCandidates);
  }

  // Keep non-compression parent links visible as child sessions. The renderer
  // uses this marker to attach branches/delegates/tools and cross-source rows
  // beneath a loaded parent without treating them as duplicate conversations.
  for (const row of copied) {
    if (row.parentSessionId && !continuationChildIds.has(row.id)) {
      row.relationshipType = row.relationshipType || "child_session";
    }
  }

  const projected: CompressionLineageProjection<T>["projected"] = [];
  const canonicalBySessionId = new Map<string, T>();
  const consumed = new Set<string>();

  const projectRoot = (root: T): void => {
    const stack: Array<{ row: T; depth: number }> = [{ row: root, depth: 1 }];
    const members: Array<{ row: T; depth: number }> = [];
    const seen = new Set<string>();

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current.row.id)) continue;
      seen.add(current.row.id);
      members.push(current);
      const children = continuationChildren.get(current.row.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ row: children[index], depth: current.depth + 1 });
      }
    }

    // Follow the same deterministic forward path as Hermes Agent:
    // compression child -> live child -> closed sibling. We still consume all
    // continuation-looking siblings so malformed stale-parent fan-out projects
    // to one row, but a newer ws_orphan_reap sibling cannot steal the tip.
    let selected = { row: root, depth: 1 };
    const pathSeen = new Set<string>([root.id]);
    while (true) {
      const children = continuationChildren.get(selected.row.id) ?? [];
      const next = children.find((child) => !pathSeen.has(child.id));
      if (!next) break;
      pathSeen.add(next.id);
      selected = { row: next, depth: selected.depth + 1 };
    }
    // Preserve the deterministic continuation path while it leads to a real
    // transcript. A malformed/stale fan-out can leave that path at a
    // zero-message terminal even though a later sibling contains the visible
    // continuation. In that case only, fall back to the newest message-bearing
    // member so the whole logical conversation cannot disappear.
    if (messageCount(selected.row) <= 0) {
      const messagefulFallback = members
        .map(({ row }) => row)
        .filter((row) => messageCount(row) > 0)
        .sort(
          (a, b) =>
            activityScore(b) - activityScore(a) ||
            (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
            b.id.localeCompare(a.id),
        )[0];
      if (messagefulFallback) {
        selected = {
          row: messagefulFallback,
          depth:
            members.find(({ row }) => row.id === messagefulFallback.id)
              ?.depth ?? 1,
        };
      }
    }
    const canonical = mergeRootFallbacks(root, selected.row, members.length);
    canonical.lineageMemberIds = members.map(({ row }) => row.id);
    if (members.some(({ row }) => Boolean(row.pinned))) {
      canonical.pinned = true;
    }

    projected.push(canonical);
    for (const { row } of members) {
      consumed.add(row.id);
      canonicalBySessionId.set(row.id, canonical);
    }
  };

  for (const row of copied) {
    if (!continuationChildIds.has(row.id)) projectRoot(row);
  }

  // Corrupt cyclic parent links have no natural root. Surface each remaining
  // component once instead of hiding it or looping forever.
  for (const row of copied) {
    if (!consumed.has(row.id)) projectRoot(row);
  }

  projected.sort(
    (a, b) => activityScore(b) - activityScore(a) || b.id.localeCompare(a.id),
  );
  return { projected, canonicalBySessionId };
}

export function projectCompressionLineages<T extends CompressionLineageRow>(
  rows: readonly T[],
): CompressionLineageProjection<T>["projected"] {
  return buildCompressionLineageProjection(rows).projected;
}

/** Return every physical segment represented by one projected session row. */
export function compressionLineageMemberIdsForSession<
  T extends CompressionLineageRow,
>(rows: readonly T[], sessionId: string): string[] {
  const projection = buildCompressionLineageProjection(rows);
  const canonical = projection.canonicalBySessionId.get(sessionId);
  if (!canonical) return [sessionId];
  return rows
    .filter(
      (row) => projection.canonicalBySessionId.get(row.id)?.id === canonical.id,
    )
    .map((row) => row.id);
}
