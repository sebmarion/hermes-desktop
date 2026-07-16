import Database from "better-sqlite3";
import { existsSync } from "fs";
import { join } from "path";
import { ensureSharedSessionActivitySchema } from "./session-schema";
import { profileHome } from "./utils";

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface LocalSessionActivityHandle {
  setPhase: (phase: string) => void;
  stop: () => void;
}

function openActivityDatabase(profile?: string): Database.Database | null {
  const dbPath = join(profileHome(profile), "state.db");
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath);
  } catch (error) {
    console.warn("[session-activity] Failed to open state.db:", error);
    return null;
  }
}

/** Publish local Hermes One work into the shared profile state.db. */
export function startLocalSessionActivity(
  sessionId: string,
  runId: string,
  options: { profile?: string; phase?: string; source?: string } = {},
): LocalSessionActivityHandle {
  const noop: LocalSessionActivityHandle = {
    setPhase: () => undefined,
    stop: () => undefined,
  };
  if (!sessionId.trim() || !runId.trim()) return noop;

  const db = openActivityDatabase(options.profile);
  if (!db) return noop;
  ensureSharedSessionActivitySchema(db);

  const startedAt = Date.now() / 1000;
  let phase = options.phase?.trim() || "running";
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let upsert: Database.Statement<
    [string, string, string, string, number, number]
  >;
  let remove: Database.Statement<[string, string]>;
  try {
    upsert = db.prepare(`
      INSERT INTO session_activity
        (session_id, run_id, source, phase, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, run_id) DO UPDATE SET
        source = excluded.source,
        phase = excluded.phase,
        started_at = MIN(session_activity.started_at, excluded.started_at),
        heartbeat_at = MAX(session_activity.heartbeat_at, excluded.heartbeat_at)
    `);
    remove = db.prepare(
      "DELETE FROM session_activity WHERE session_id = ? AND run_id = ?",
    );
  } catch (error) {
    console.warn("[session-activity] Failed to prepare state.db write:", error);
    try {
      db.close();
    } catch {
      // Best effort cleanup.
    }
    return noop;
  }

  const beat = (): void => {
    if (stopped) return;
    try {
      upsert.run(
        sessionId,
        runId,
        options.source?.trim() || "hermes_one",
        phase,
        startedAt,
        Date.now() / 1000,
      );
    } catch (error) {
      console.warn("[session-activity] Failed to heartbeat state.db:", error);
    }
  };

  beat();
  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    setPhase: (nextPhase: string): void => {
      if (stopped) return;
      const normalized = String(nextPhase || "running").trim() || "running";
      phase = normalized;
      beat();
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        remove.run(sessionId, runId);
      } catch (error) {
        console.warn("[session-activity] Failed to clear state.db:", error);
      }
      try {
        db.close();
      } catch {
        // Best effort cleanup.
      }
    },
  };
}
