import Database from "better-sqlite3";
import { createHash } from "crypto";
import { statSync } from "fs";
import { activeStateDbPath } from "./utils";

interface RevisionConnection {
  path: string;
  identity: string;
  db: Database.Database;
}

/**
 * Cheaply detects commits made by any other state.db connection.
 *
 * The read-only connection stays open because SQLite's PRAGMA data_version is
 * defined relative to a connection. File identity closes the replacement gap:
 * if a restore swaps state.db underneath us, the old handle is discarded and
 * the new database starts a fresh revision epoch.
 */
export class SessionRevisionTracker {
  private entry: RevisionConnection | null = null;

  revision(path: string): string | null {
    let identity: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        this.close();
        return null;
      }
      identity = `${stat.dev}:${stat.ino}`;
    } catch {
      this.close();
      return null;
    }

    if (
      !this.entry ||
      this.entry.path !== path ||
      this.entry.identity !== identity
    ) {
      this.close();
      try {
        this.entry = {
          path,
          identity,
          db: new Database(path, { readonly: true, fileMustExist: true }),
        };
      } catch {
        this.entry = null;
        return null;
      }
    }

    try {
      const dataVersion = Number(
        this.entry.db.pragma("data_version", { simple: true }),
      );
      if (!Number.isFinite(dataVersion)) return null;
      return createHash("sha256")
        .update(`${path}\0${identity}\0${dataVersion}`)
        .digest("hex");
    } catch {
      this.close();
      return null;
    }
  }

  close(): void {
    if (!this.entry) return;
    try {
      this.entry.db.close();
    } catch {
      // Best-effort shutdown. A stale handle must never keep the old epoch.
    }
    this.entry = null;
  }
}

const activeSessionRevisionTracker = new SessionRevisionTracker();

export function getActiveSessionRevision(): string | null {
  return activeSessionRevisionTracker.revision(activeStateDbPath());
}

export function closeActiveSessionRevisionTracker(): void {
  activeSessionRevisionTracker.close();
}
