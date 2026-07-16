import Database from "better-sqlite3";
import { mkdtempSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRevisionTracker } from "./session-revision";

const roots: string[] = [];

function makeDb(name = "state.db"): string {
  const root = mkdtempSync(join(tmpdir(), "hermes-one-session-revision-"));
  roots.push(root);
  const path = join(root, name);
  const db = new Database(path);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)");
  db.close();
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// The checked-in native dependency is rebuilt for Electron. Run these real
// SQLite contracts under `ELECTRON_RUN_AS_NODE=1`; the ordinary Node/Vitest
// suite has a different native ABI and skips only this file.
const describeWithNativeSqlite = process.versions.electron
  ? describe
  : describe.skip;

describeWithNativeSqlite("SessionRevisionTracker", () => {
  it("stays stable while idle and changes after an external commit", () => {
    const path = makeDb();
    const tracker = new SessionRevisionTracker();
    const first = tracker.revision(path);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(tracker.revision(path)).toBe(first);

    const writer = new Database(path);
    writer
      .prepare("INSERT INTO sessions (id, title) VALUES (?, ?)")
      .run("external", "External run");
    writer.close();

    expect(tracker.revision(path)).not.toBe(first);
    tracker.close();
  });

  it("fails closed for a missing database and does not create it", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "hermes-one-session-revision-missing-")),
      "state.db",
    );
    roots.push(dirname(path));
    const tracker = new SessionRevisionTracker();

    expect(tracker.revision(path)).toBeNull();
    expect(
      () => new Database(path, { readonly: true, fileMustExist: true }),
    ).toThrow();
    tracker.close();
  });

  it("changes epoch when state.db is replaced", () => {
    const path = makeDb();
    const replacement = makeDb("replacement.db");
    const tracker = new SessionRevisionTracker();
    const first = tracker.revision(path);

    renameSync(replacement, path);

    expect(tracker.revision(path)).not.toBe(first);
    tracker.close();
  });
});
