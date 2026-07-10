export interface CompressionLineageRow {
  id: string;
  parentSessionId?: string | null;
  endReason?: string | null;
  modelConfig?: string | Record<string, unknown> | null;
  source?: string | null;
  startedAt?: number | null;
  lastActive?: number | null;
  messageCount?: number | null;
  title?: string | null;
  contextFolder?: string | null;
  lineageRootId?: string;
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
  if ((child.source || "").toLowerCase() === "tool") return false;
  if (hasRelationshipMarker(child)) return false;

  const parentSource = (parent.source || "").trim().toLowerCase();
  const childSource = (child.source || "").trim().toLowerCase();
  return !parentSource || !childSource || parentSource === childSource;
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
  if (!tip.title && root.title) merged.title = root.title;
  if (!tip.contextFolder && root.contextFolder) {
    merged.contextFolder = root.contextFolder;
  }
  return merged;
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
    children.sort(
      (a, b) => activityScore(b) - activityScore(a) || b.id.localeCompare(a.id),
    );
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

    const messageful = members.filter(({ row }) => messageCount(row) > 0);
    const candidates = messageful.length > 0 ? messageful : members;
    const selected = candidates.reduce((best, candidate) => {
      const scoreDelta = activityScore(candidate.row) - activityScore(best.row);
      if (scoreDelta > 0) return candidate;
      if (scoreDelta === 0 && candidate.depth >= best.depth) return candidate;
      return best;
    });
    const canonical = mergeRootFallbacks(root, selected.row, members.length);

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
