import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  activeStateDbPath,
  profileHome,
  getActiveProfileNameSync,
  safeWriteFile,
} from "./utils";
import Database from "better-sqlite3";
import { t } from "../shared/i18n";
import { getAppLocale } from "./locale";
import { getDbConnection } from "./db";
import { getSessionContextFolders } from "./session-context-folder-store";
import {
  isSharedConversationVisible,
  limitSharedConversationRows,
  projectCompressionLineages,
} from "./session-lineage";
import {
  applySessionActivity,
  ensureSharedSessionSchema,
  readSessionActivity,
  sessionLineageSelectList,
} from "./session-schema";

/**
 * The session cache lives alongside its own profile's data so profiles
 * don't share a single cache file. The default profile keeps
 * ~/.hermes/desktop/sessions.json; named profiles use
 * ~/.hermes/profiles/<name>/desktop/sessions.json (issue #311).
 */
function cacheFilePath(): string {
  return join(
    profileHome(getActiveProfileNameSync()),
    "desktop",
    "sessions.json",
  );
}

export interface CachedSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number | null;
  source: string;
  messageCount: number;
  model: string;
  contextFolder: string | null;
  parentSessionId?: string | null;
  endReason?: string | null;
  modelConfig?: string | null;
  relationshipType?: string;
  lineageRootId?: string;
  lineageMemberIds?: string[];
  compressionSegmentCount?: number;
  cwd?: string | null;
  archived?: boolean;
  pinned?: boolean;
  lastActive?: number | null;
  isWorking?: boolean;
  activityPhase?: string;
  activityStartedAt?: number;
  activityHeartbeatAt?: number;
}

interface CacheData {
  sessions: CachedSession[];
  lastSync: number;
}

// Match WebUI's deterministic first-user fallback. Canonical state.db titles
// remain authoritative; this is used only when the shared row has no title.
function generateTitle(message: string): string {
  if (!message || !message.trim())
    return t("sessions.newConversation", getAppLocale());
  const text = message.replace(/\n\n\[Attached files: [^\]]+\]$/, "").trim();
  if (!text) return t("sessions.newConversation", getAppLocale());
  return text.slice(0, 64).trimEnd();
}

function readCache(): CacheData {
  const file = cacheFilePath();
  try {
    if (!existsSync(file)) return { sessions: [], lastSync: 0 };
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as CacheData;
    return {
      lastSync: typeof parsed.lastSync === "number" ? parsed.lastSync : 0,
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((s) => ({
            ...s,
            contextFolder:
              typeof s.contextFolder === "string" ? s.contextFolder : null,
          }))
        : [],
    };
  } catch {
    return { sessions: [], lastSync: 0 };
  }
}

function writeCache(data: CacheData): void {
  try {
    safeWriteFile(cacheFilePath(), JSON.stringify(data));
  } catch {
    // non-fatal
  }
}

// Pinned conversations are a separate sidebar section, so they must not be
// lost behind the first-page limit applied by the renderer. Keep this ordering
// stable for both the cache-only and DB-sync paths so pagination offsets remain
// correct after the first page is loaded.
function orderSidebarRows(rows: CachedSession[]): CachedSession[] {
  const pinned = rows.filter((session) => session.pinned && !session.archived);
  const rest = rows.filter((session) => !(session.pinned && !session.archived));
  return [...pinned, ...rest];
}

function getDb(): Database.Database | null {
  return getDbConnection(true);
}

// Attach each session's linked folder in a single batched store read, so a
// full sync stays a couple of queries rather than two per row. The result is
// written into the JSON cache by `syncSessionCache`, which lets the renderer's
// fast read path (`listCachedSessions`) stay DB-free.
function attachContextFolders(sessions: CachedSession[]): CachedSession[] {
  const folders = getSessionContextFolders(sessions.map((s) => s.id));
  return sessions.map((session) => ({
    ...session,
    contextFolder: folders.get(session.id) ?? null,
  }));
}

// Sync from hermes DB to local cache — only fetches new/updated sessions
export function syncSessionCache(): CachedSession[] {
  const cache = readCache();
  const db = getDb();
  if (!db)
    return orderSidebarRows(cache.sessions.filter(isSharedConversationVisible));

  try {
    const lineageColumns = sessionLineageSelectList(db, "s");
    // Refresh all lightweight metadata before projection. The previous cache
    // already performed an all-session phase for stale counts; fetching the
    // lineage columns in the same O(N) pass also makes pagination correct.
    const rows = db
      .prepare(
        `SELECT s.id, s.started_at, s.ended_at, s.source, s.message_count, s.model, s.title,
                ${lineageColumns}
         FROM sessions s
         ORDER BY s.started_at DESC`,
      )
      .all() as Array<{
      id: string;
      started_at: number;
      ended_at: number | null;
      source: string;
      message_count: number;
      model: string;
      title: string | null;
      parent_session_id: string | null;
      end_reason: string | null;
      model_config: string | null;
      archived?: number | boolean | null;
      pinned?: number | boolean | null;
      cwd?: string | null;
      last_activity_at?: number | null;
    }>;

    const existingById = new Map(
      cache.sessions.map((session) => [session.id, session] as const),
    );
    const refreshed: CachedSession[] = [];

    for (const row of rows) {
      const existing = existingById.get(row.id);
      refreshed.push({
        id: row.id,
        // state.db owns shared titles. Do not let a cache-only fallback become
        // authoritative again after the canonical title was cleared or never
        // written; the deterministic first-user pass below will regenerate and
        // backfill the missing value for both clients.
        title: row.title || "",
        startedAt: row.started_at,
        endedAt: row.ended_at,
        source: row.source,
        messageCount: row.message_count,
        model: row.model || "",
        contextFolder: existing?.contextFolder ?? null,
        parentSessionId: row.parent_session_id,
        endReason: row.end_reason,
        modelConfig: row.model_config,
        ...(Object.prototype.hasOwnProperty.call(row, "cwd")
          ? { cwd: row.cwd ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(row, "archived")
          ? { archived: Boolean(row.archived) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(row, "pinned")
          ? { pinned: Boolean(row.pinned) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(row, "last_activity_at")
          ? { lastActive: row.last_activity_at ?? null }
          : {}),
      });
    }

    const activity = readSessionActivity(
      db,
      refreshed.map((session) => session.id),
    );
    const projected = applySessionActivity(
      projectCompressionLineages(attachContextFolders(refreshed)),
      activity,
    ).filter(isSharedConversationVisible);
    const generatedTitleBackfills: Array<{
      sessionId: string;
      title: string;
    }> = [];
    for (const session of projected) {
      if (session.title) continue;
      try {
        const msg = db
          .prepare(
            `SELECT content FROM messages
             WHERE session_id = ? AND role = 'user' AND content IS NOT NULL
             ORDER BY timestamp, id LIMIT 1`,
          )
          .get(session.lineageRootId ?? session.id) as
          | { content: string }
          | undefined;
        if (msg) {
          session.title = generateTitle(msg.content);
          generatedTitleBackfills.push({
            sessionId: session.id,
            title: session.title,
          });
        } else {
          session.title = t("sessions.newConversation", getAppLocale());
        }
      } catch {
        session.title = t("sessions.newConversation", getAppLocale());
      }
    }
    if (generatedTitleBackfills.length > 0) {
      updateStateDb((writableDb) => {
        for (const backfill of generatedTitleBackfills) {
          updateCompressionLineageField(
            writableDb,
            backfill.sessionId,
            "title",
            backfill.title,
          );
        }
      });
    }
    const updated: CacheData = {
      sessions: projected,
      lastSync: Math.floor(Date.now() / 1000),
    };
    writeCache(updated);
    return orderSidebarRows(updated.sessions);
  } catch {
    return orderSidebarRows(cache.sessions.filter(isSharedConversationVisible));
  }
}

// Fast read from cache only (no DB access). `contextFolder` is persisted into
// the cache by `syncSessionCache`, and folder changes trigger a re-sync (the
// renderer fires `hermes-session-context-folder-changed`), so the cached value
// stays current without this path touching the DB.
export function listCachedSessions(limit = 50, offset = 0): CachedSession[] {
  const cache = readCache();
  return orderSidebarRows(limitSharedConversationRows(cache.sessions)).slice(
    offset,
    offset + limit,
  );
}

// Update title for a specific session
export function updateSessionTitle(sessionId: string, title: string): void {
  const cache = readCache();
  const idx = cache.sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) {
    cache.sessions[idx].title = title;
    writeCache(cache);
  }
  // Also persist in state.db so the rename survives cache rebuilds
  try {
    const dbPath = activeStateDbPath();
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      try {
        db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
          title,
          sessionId,
        );
        updateCompressionLineageField(db, sessionId, "title", title);
      } finally {
        db.close();
      }
    }
  } catch {
    // ignore DB errors — cache update above is the fast path
  }
}

function updateStateDb(callback: (db: Database.Database) => void): boolean {
  try {
    const dbPath = activeStateDbPath();
    if (!existsSync(dbPath)) {
      console.error(`[session-cache] state.db is unavailable at ${dbPath}`);
      return false;
    }
    // Reuse the app's profile-aware connection. This closes a cached
    // read-only handle before opening the writable one, avoiding a second
    // connection racing the sidebar's long-lived state.db reader.
    const db = getDbConnection(false);
    if (!db) {
      console.error(
        `[session-cache] failed to open writable state.db at ${dbPath}`,
      );
      return false;
    }
    callback(db);
    return true;
  } catch (error) {
    console.error("[session-cache] shared state.db mutation failed", error);
    return false;
  }
}

function updateCompressionLineageField(
  db: Database.Database,
  sessionId: string,
  field: "title" | "archived" | "pinned",
  value: string | number,
): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{
        name?: unknown;
      }>
    )
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
  if (
    !["id", "parent_session_id", "end_reason", "source"].every((column) =>
      columns.has(column),
    )
  ) {
    if (columns.has(field)) {
      db.prepare(`UPDATE sessions SET ${field} = ? WHERE id = ?`).run(
        value,
        sessionId,
      );
    }
    return;
  }
  const branchGuard = columns.has("model_config")
    ? "(child.model_config IS NULL OR NOT json_valid(child.model_config) OR (COALESCE(json_extract(child.model_config, '$._branched_from'), '') = '' AND COALESCE(json_extract(child.model_config, '$._delegate_from'), '') = ''))"
    : "1 = 1";
  const lineageCte = `WITH RECURSIVE lineage(id, source) AS (
       SELECT id, LOWER(TRIM(COALESCE(source, ''))) FROM sessions WHERE id = ?
       UNION
       SELECT parent.id, LOWER(TRIM(COALESCE(parent.source, '')))
       FROM sessions child
       JOIN lineage current ON current.id = child.id
       JOIN sessions parent ON parent.id = child.parent_session_id
       WHERE parent.end_reason = 'compression'
         AND LOWER(TRIM(COALESCE(parent.source, ''))) = current.source
         AND LOWER(TRIM(COALESCE(child.source, ''))) = current.source
         AND ${branchGuard}
       UNION
       SELECT child.id, LOWER(TRIM(COALESCE(child.source, '')))
       FROM sessions parent
       JOIN lineage current ON current.id = parent.id
       JOIN sessions child ON child.parent_session_id = parent.id
       WHERE parent.end_reason = 'compression'
         AND LOWER(TRIM(COALESCE(child.source, ''))) = current.source
         AND LOWER(TRIM(COALESCE(child.source, ''))) <> 'tool'
         AND ${branchGuard}
     )`;
  if (field === "title") {
    // state.db enforces title uniqueness. Keep one canonical title on the
    // requested visible segment and clear hidden physical copies in the same
    // statement; assigning the same title to every segment aborts the write.
    db.prepare(
      `${lineageCte}
       UPDATE sessions
       SET title = CASE WHEN id = ? THEN ? ELSE NULL END
       WHERE id IN (SELECT id FROM lineage)`,
    ).run(sessionId, sessionId, value);
    return;
  }
  db.prepare(
    `${lineageCte}
     UPDATE sessions SET ${field} = ?
     WHERE id IN (SELECT id FROM lineage)`,
  ).run(sessionId, value);
}

export function updateSessionWorkspace(sessionId: string, cwd: string): void {
  const normalized = cwd.trim();
  if (!normalized) return;
  if (
    !updateStateDb((db) => {
      db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(
        normalized,
        sessionId,
      );
    })
  ) {
    throw new Error(
      "Shared state.db is unavailable; workspace was not changed.",
    );
  }
  const cache = readCache();
  const next = cache.sessions.map((session) =>
    session.id === sessionId ? { ...session, cwd: normalized } : session,
  );
  if (next.some((session, index) => session !== cache.sessions[index])) {
    writeCache({ ...cache, sessions: next });
  }
}

export function updateSessionArchived(
  sessionId: string,
  archived: boolean,
): void {
  if (
    !updateStateDb((db) => {
      updateCompressionLineageField(
        db,
        sessionId,
        "archived",
        archived ? 1 : 0,
      );
    })
  ) {
    throw new Error(
      "Shared state.db is unavailable; archive state was not changed.",
    );
  }
  const cache = readCache();
  const next = cache.sessions.map((session) =>
    session.id === sessionId ? { ...session, archived } : session,
  );
  writeCache({ ...cache, sessions: next });
}

export function updateSessionPinned(sessionId: string, pinned: boolean): void {
  if (
    !updateStateDb((db) => {
      ensureSharedSessionSchema(db);
      updateCompressionLineageField(db, sessionId, "pinned", pinned ? 1 : 0);
    })
  ) {
    throw new Error(
      "Shared state.db is unavailable; pin state was not changed.",
    );
  }
  const cache = readCache();
  const next = cache.sessions.map((session) =>
    session.id === sessionId ? { ...session, pinned } : session,
  );
  writeCache({ ...cache, sessions: next });
}

// Remove a session entry from the local cache. Called after the underlying
// row in state.db is deleted so the renderer's fast-path cache doesn't keep
// surfacing a session that no longer exists.
export function removeSessionFromCache(sessionId: string): void {
  const cache = readCache();
  const next = cache.sessions.filter((s) => s.id !== sessionId);
  if (next.length !== cache.sessions.length) {
    cache.sessions = next;
    writeCache(cache);
  }
}
