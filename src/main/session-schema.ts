import type Database from "better-sqlite3";

export const SESSION_ACTIVITY_TTL_SECONDS = 20;

export interface SessionActivityView {
  isWorking: true;
  activityPhase: string;
  activityStartedAt: number;
  activityHeartbeatAt: number;
}

const LINEAGE_COLUMNS = [
  "parent_session_id",
  "end_reason",
  "model_config",
  "archived",
  "pinned",
  "cwd",
  "last_activity_at",
] as const;

/**
 * Build a compatible SELECT fragment for optional Hermes lineage columns.
 * Older state.db schemas predate these fields, so callers receive NULL aliases
 * instead of issuing a query that fails before read-only projection can run.
 */
export function sessionLineageSelectList(
  db: Database.Database,
  tableAlias = "",
): string {
  let columns = new Set<string>();
  try {
    const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name?: unknown;
    }>;
    columns = new Set(
      rows
        .map((row) => (typeof row.name === "string" ? row.name : ""))
        .filter(Boolean),
    );
  } catch {
    // Treat an unreadable schema probe like an old schema. The subsequent
    // sessions query still reports any non-lineage database problem normally.
  }

  const prefix = tableAlias ? `${tableAlias}.` : "";
  return LINEAGE_COLUMNS.map((column) =>
    columns.has(column) ? `${prefix}${column}` : `NULL AS ${column}`,
  ).join(", ");
}

/** Add the shared pin bit to an older local state.db without rewriting data. */
export function ensureSharedSessionSchema(db: Database.Database): void {
  try {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(sessions)").all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => (typeof row.name === "string" ? row.name : ""))
        .filter(Boolean),
    );
    if (!columns.has("pinned")) {
      db.exec(
        "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
      );
    }
  } catch {
    // Read-only/legacy databases remain readable through the optional SELECT.
  }
}

/** Add the cross-client runtime activity table without rewriting session data. */
export function ensureSharedSessionActivitySchema(db: Database.Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_activity (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at REAL NOT NULL,
        heartbeat_at REAL NOT NULL,
        PRIMARY KEY (session_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_activity_heartbeat
        ON session_activity (heartbeat_at);
    `);
  } catch {
    // A locked/read-only/legacy database remains readable; the activity writer
    // treats this as a best-effort capability and will simply no-op.
  }
}

function hasSessionActivityTable(db: Database.Database): boolean {
  try {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_activity'",
        )
        .get(),
    );
  } catch {
    return false;
  }
}

/** Read fresh runtime activity without making old state.db schemas fail. */
export function readSessionActivity(
  db: Database.Database,
  sessionIds: readonly string[],
  now = Date.now() / 1000,
): Map<string, SessionActivityView> {
  if (!hasSessionActivityTable(db)) return new Map();
  const ids = Array.from(new Set(sessionIds.filter(Boolean)));
  if (ids.length === 0) return new Map();

  const activity = new Map<string, SessionActivityView>();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(",");
    let rows: Array<{
      session_id: string;
      phase: string | null;
      started_at: number | null;
      heartbeat_at: number | null;
    }>;
    try {
      rows = db
        .prepare(
          `SELECT session_id, phase, started_at, heartbeat_at
           FROM session_activity
           WHERE heartbeat_at >= ? AND session_id IN (${placeholders})`,
        )
        .all(now - SESSION_ACTIVITY_TTL_SECONDS, ...chunk) as typeof rows;
    } catch {
      return new Map();
    }
    for (const row of rows) {
      const sessionId = String(row.session_id || "");
      const startedAt = Number(row.started_at || 0);
      const heartbeatAt = Number(row.heartbeat_at || 0);
      if (
        !sessionId ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(heartbeatAt)
      ) {
        continue;
      }
      const previous = activity.get(sessionId);
      if (!previous) {
        activity.set(sessionId, {
          isWorking: true,
          activityPhase: String(row.phase || "running"),
          activityStartedAt: startedAt,
          activityHeartbeatAt: heartbeatAt,
        });
        continue;
      }
      previous.activityStartedAt = Math.min(
        previous.activityStartedAt,
        startedAt,
      );
      if (heartbeatAt >= previous.activityHeartbeatAt) {
        previous.activityHeartbeatAt = heartbeatAt;
        previous.activityPhase = String(row.phase || "running");
      }
    }
  }
  return activity;
}

/** Overlay active state after compression projection, using lineage aliases. */
export function applySessionActivity<
  T extends {
    id: string;
    lineageRootId?: string;
    lineageMemberIds?: string[];
  },
>(rows: T[], activity: Map<string, SessionActivityView>): T[] {
  return rows.map((row) => {
    const aliases = [
      row.id,
      row.lineageRootId,
      ...(row.lineageMemberIds ?? []),
    ].filter(Boolean) as string[];
    const candidates = aliases
      .map((id) => activity.get(id))
      .filter((value): value is SessionActivityView => Boolean(value));
    if (candidates.length === 0) return row;
    const selected = candidates.reduce((best, candidate) =>
      candidate.activityHeartbeatAt >= best.activityHeartbeatAt
        ? candidate
        : best,
    );
    return {
      ...row,
      isWorking: true,
      activityPhase: selected.activityPhase,
      activityStartedAt: Math.min(
        ...candidates.map((candidate) => candidate.activityStartedAt),
      ),
      activityHeartbeatAt: Math.max(
        ...candidates.map((candidate) => candidate.activityHeartbeatAt),
      ),
    } as T;
  });
}
