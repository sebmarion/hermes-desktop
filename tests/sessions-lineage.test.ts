import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestSessionRow {
  id: string;
  source: string;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  model: string;
  title: string | null;
  parent_session_id?: string | null;
  end_reason?: string | null;
  model_config?: string | null;
  pinned?: boolean | number | null;
  isWorking?: boolean;
}

interface TestMessageRow {
  id: number;
  session_id: string;
  content: string;
  timestamp: number;
}

const state = vi.hoisted(() => ({
  hasLineageColumns: true,
  sessions: [] as TestSessionRow[],
  messages: [] as TestMessageRow[],
}));

function missingColumnError(): Error & { code: string } {
  const error = new Error("no such column: s.parent_session_id") as Error & {
    code: string;
  };
  error.code = "SQLITE_ERROR";
  return error;
}

const fakeDb = {
  prepare(sql: string) {
    if (
      !state.hasLineageColumns &&
      (/s\.(parent_session_id|end_reason|model_config)/.test(sql) ||
        /title,\s*parent_session_id,\s*end_reason,\s*model_config/.test(sql))
    ) {
      throw missingColumnError();
    }

    return {
      all(...args: unknown[]) {
        if (/PRAGMA\s+table_info\(['"]?sessions/i.test(sql)) {
          const base = [
            "id",
            "source",
            "started_at",
            "ended_at",
            "message_count",
            "model",
            "title",
          ];
          const names = state.hasLineageColumns
            ? [...base, "parent_session_id", "end_reason", "model_config"]
            : base;
          return names.map((name, cid) => ({ cid, name }));
        }

        if (sql.includes("LOWER(COALESCE(s.title")) {
          const query = String(args[0]).replaceAll("%", "").toLowerCase();
          return state.sessions
            .filter(
              (row) =>
                (row.title || "").toLowerCase().includes(query) ||
                row.id.toLowerCase().includes(query),
            )
            .sort((a, b) => b.started_at - a.started_at)
            .map((row) => ({ ...row, session_id: row.id }));
        }

        if (sql.includes("FROM messages m") && sql.includes("LIKE")) {
          const query = String(args[0]).replaceAll("%", "").toLowerCase();
          return state.messages
            .filter((message) => message.content.toLowerCase().includes(query))
            .map((message) => {
              const session = state.sessions.find(
                (row) => row.id === message.session_id,
              );
              if (!session) throw new Error("missing test session");
              return {
                ...session,
                message_id: message.id,
                content: message.content,
                session_id: message.session_id,
              };
            })
            .sort(
              (a, b) =>
                b.started_at - a.started_at || a.message_id - b.message_id,
            );
        }

        if (sql.includes("FROM sessions")) {
          return [...state.sessions].sort(
            (a, b) => b.started_at - a.started_at,
          );
        }

        throw new Error(`Unhandled SQL in lineage test: ${sql}`);
      },
      get() {
        if (sql.includes("sqlite_master")) return undefined;
        throw new Error(`Unhandled SQL in lineage test: ${sql}`);
      },
    };
  },
};

vi.mock("../src/main/db", () => ({
  getDbConnection: () => fakeDb,
}));

vi.mock("../src/main/session-cache", () => ({
  removeSessionFromCache: vi.fn(),
}));

import { listSessions, searchSessions } from "../src/main/sessions";

beforeEach(() => {
  state.hasLineageColumns = true;
  state.sessions = [];
  state.messages = [];
});

describe("shared session activity overlay", () => {
  it("marks the visible compression tip when an older lineage id is active", async () => {
    const { applySessionActivity } = await import("../src/main/session-schema");
    const rows = applySessionActivity(
      [
        {
          id: "tip",
          title: "Conversation",
          lineageRootId: "root",
        },
      ],
      new Map([
        [
          "root",
          {
            isWorking: true as const,
            activityPhase: "tool",
            activityStartedAt: 10,
            activityHeartbeatAt: 20,
          },
        ],
      ]),
    );

    expect(rows[0]).toMatchObject({
      id: "tip",
      isWorking: true,
      activityPhase: "tool",
      activityHeartbeatAt: 20,
    });
  });
});

describe("local compression lineage reads", () => {
  it("matches WebUI visibility by hiding internal and empty session rows", async () => {
    const { isSharedConversationVisible } =
      await import("../src/main/session-lineage");

    expect(
      isSharedConversationVisible({
        id: "webui-chat",
        source: "webui",
        messageCount: 1,
      }),
    ).toBe(true);
    expect(
      isSharedConversationVisible({
        id: "cli-chat",
        source: "tui",
        messageCount: 1,
      }),
    ).toBe(true);
    expect(
      isSharedConversationVisible({
        id: "delegate",
        source: "subagent",
        messageCount: 2,
      }),
    ).toBe(false);
    expect(
      isSharedConversationVisible({
        id: "empty",
        source: "webui",
        messageCount: 0,
      }),
    ).toBe(false);
    expect(
      isSharedConversationVisible({
        id: "active-empty",
        source: "webui",
        messageCount: 0,
        isWorking: true,
      }),
    ).toBe(true);
  });

  it("keeps the WebUI-sized recent window for imported CLI conversations", async () => {
    const { limitSharedConversationRows } =
      await import("../src/main/session-lineage");
    const rows = [
      { id: "webui", source: "webui", messageCount: 1, lastActive: 1 },
      ...Array.from({ length: 21 }, (_, index) => ({
        id: `tui-${index}`,
        source: "tui",
        messageCount: 1,
        lastActive: 100 - index,
      })),
    ];

    const limited = limitSharedConversationRows(rows);
    expect(limited.map((row) => row.id)).toContain("webui");
    expect(limited.filter((row) => row.source === "tui")).toHaveLength(20);
  });

  it("keeps a root pin when the visible continuation has no pin metadata", async () => {
    const { projectCompressionLineages } =
      await import("../src/main/session-lineage");
    const projected = projectCompressionLineages([
      {
        id: "tip",
        source: "webui",
        startedAt: 20,
        endedAt: null,
        messageCount: 2,
        title: null,
        parentSessionId: "root",
        pinned: false,
      },
      {
        id: "root",
        source: "webui",
        startedAt: 10,
        endedAt: 15,
        messageCount: 4,
        title: "Pinned root",
        endReason: "compression",
        pinned: true,
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({ id: "tip", pinned: true }),
    ]);
  });

  it("keeps a pin set on an intermediate compression segment", async () => {
    const { projectCompressionLineages } =
      await import("../src/main/session-lineage");
    const projected = projectCompressionLineages([
      {
        id: "tip",
        source: "webui",
        startedAt: 30,
        endedAt: null,
        messageCount: 2,
        title: null,
        parentSessionId: "middle",
        pinned: false,
      },
      {
        id: "middle",
        source: "webui",
        startedAt: 20,
        endedAt: 25,
        messageCount: 3,
        title: null,
        parentSessionId: "root",
        endReason: "compression",
        pinned: true,
      },
      {
        id: "root",
        source: "webui",
        startedAt: 10,
        endedAt: 15,
        messageCount: 4,
        title: "Pinned root",
        endReason: "compression",
        pinned: false,
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({ id: "tip", pinned: true }),
    ]);
  });

  it("keeps list and search working against the pre-lineage session schema", () => {
    state.hasLineageColumns = false;
    state.sessions = [
      {
        id: "legacy-session",
        source: "cli",
        started_at: 10,
        ended_at: null,
        message_count: 1,
        model: "legacy-model",
        title: "Legacy searchable title",
      },
    ];

    expect(listSessions()).toEqual([
      expect.objectContaining({ id: "legacy-session", messageCount: 1 }),
    ]);
    expect(searchSessions("searchable")).toEqual([
      expect.objectContaining({ sessionId: "legacy-session" }),
    ]);
  });

  it("paginates after collapse and redirects old-segment search hits to the tip", () => {
    state.sessions = [
      {
        id: "newer-independent",
        source: "webui",
        started_at: 40,
        ended_at: null,
        message_count: 2,
        model: "other-model",
        title: "Other",
      },
      {
        id: "tip",
        source: "webui",
        started_at: 30,
        ended_at: null,
        message_count: 3,
        model: "tip-model",
        title: null,
        parent_session_id: "middle",
      },
      {
        id: "middle",
        source: "webui",
        started_at: 20,
        ended_at: 25,
        message_count: 8,
        model: "middle-model",
        title: null,
        parent_session_id: "root",
        end_reason: "compression",
      },
      {
        id: "root",
        source: "webui",
        started_at: 10,
        ended_at: 15,
        message_count: 10,
        model: "root-model",
        title: "Needle lineage title",
        end_reason: "compression",
      },
      {
        id: "older-independent",
        source: "webui",
        started_at: 5,
        ended_at: null,
        message_count: 1,
        model: "older-model",
        title: "Older",
      },
    ];
    state.messages = [
      {
        id: 1,
        session_id: "middle",
        content: "The best meaningful needle snippet from an old segment",
        timestamp: 21,
      },
    ];

    expect(listSessions(1, 2).map((session) => session.id)).toEqual([
      "older-independent",
    ]);

    expect(searchSessions("needle", 10)).toEqual([
      expect.objectContaining({
        sessionId: "tip",
        title: "Needle lineage title",
        startedAt: 30,
        messageCount: 3,
        model: "tip-model",
        snippet: expect.stringContaining("best meaningful"),
      }),
    ]);
  });
});
