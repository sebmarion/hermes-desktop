import { describe, expect, it } from "vitest";
import {
  buildCompressionLineageProjection,
  compressionLineageMemberIdsForSession,
  projectCompressionLineages,
  type CompressionLineageRow,
} from "../src/main/session-lineage";
import { applySessionActivity } from "../src/main/session-schema";

interface FixtureRow extends CompressionLineageRow {
  title: string | null;
  contextFolder: string | null;
  endedAt: number | null;
  model: string;
}

function row(id: string, overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id,
    parentSessionId: null,
    endReason: null,
    modelConfig: null,
    source: "webui",
    startedAt: 1,
    messageCount: 1,
    title: id,
    contextFolder: null,
    endedAt: null,
    model: "fixture-model",
    ...overrides,
  };
}

describe("compression lineage projection", () => {
  it("collapses a five-segment compression chain into its live tip", () => {
    const rows = [
      row("9f7b4ba1c85b", {
        endReason: "compression",
        startedAt: 10,
        endedAt: 15,
        messageCount: 100,
        model: "root-model",
        title: "Stable title",
        contextFolder: "/repo",
      }),
      row("20260709_234944_dd18e9", {
        parentSessionId: "9f7b4ba1c85b",
        endReason: "compression",
        startedAt: 20,
        messageCount: 90,
      }),
      row("20260710_000932_457187", {
        parentSessionId: "20260709_234944_dd18e9",
        endReason: "compression",
        startedAt: 30,
        messageCount: 80,
      }),
      row("20260710_021107_6cafa0", {
        parentSessionId: "20260710_000932_457187",
        endReason: "compression",
        startedAt: 40,
        messageCount: 70,
      }),
      row("20260710_081930_ba149a", {
        parentSessionId: "20260710_021107_6cafa0",
        startedAt: 50,
        endedAt: 55,
        messageCount: 60,
        model: "tip-model",
        title: null,
      }),
    ];

    expect(projectCompressionLineages(rows)).toEqual([
      expect.objectContaining({
        id: "20260710_081930_ba149a",
        lineageRootId: "9f7b4ba1c85b",
        lineageMemberIds: [
          "9f7b4ba1c85b",
          "20260709_234944_dd18e9",
          "20260710_000932_457187",
          "20260710_021107_6cafa0",
          "20260710_081930_ba149a",
        ],
        compressionSegmentCount: 5,
        startedAt: 50,
        endedAt: 55,
        messageCount: 60,
        model: "tip-model",
        title: "Stable title",
        contextFolder: "/repo",
      }),
    ]);
  });

  it("applies activity from any physical compression segment to the visible tip", () => {
    const projected = projectCompressionLineages([
      row("root", { endReason: "compression", endedAt: 10 }),
      row("tip", { parentSessionId: "root", startedAt: 20 }),
    ]);

    const [active] = applySessionActivity(
      projected,
      new Map([
        [
          "root",
          {
            isWorking: true as const,
            activityPhase: "tool",
            activityStartedAt: 1,
            activityHeartbeatAt: 2,
          },
        ],
      ]),
    );

    expect(active).toMatchObject({
      id: "tip",
      isWorking: true,
      activityPhase: "tool",
    });
  });

  it("keeps branches, delegated children, and tool sessions independent", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("tip", { parentSessionId: "root", startedAt: 20 }),
      row("branch", {
        parentSessionId: "root",
        modelConfig: JSON.stringify({ _branched_from: "root" }),
        startedAt: 30,
      }),
      row("delegate", {
        parentSessionId: "root",
        modelConfig: JSON.stringify({ _delegate_from: "root" }),
        startedAt: 40,
      }),
      row("tool", {
        parentSessionId: "root",
        source: "tool",
        startedAt: 50,
      }),
    ];

    const projected = projectCompressionLineages(rows);
    expect(projected.map((item) => item.id)).toEqual([
      "tool",
      "delegate",
      "branch",
      "tip",
    ]);
    expect(projected.find((item) => item.id === "tip")).toMatchObject({
      lineageRootId: "root",
      compressionSegmentCount: 2,
    });
    expect(projected.find((item) => item.id === "branch")).toMatchObject({
      relationshipType: "child_session",
    });
    expect(projected.find((item) => item.id === "delegate")).toMatchObject({
      relationshipType: "child_session",
    });
    expect(projected.find((item) => item.id === "tool")).toMatchObject({
      relationshipType: "child_session",
    });
  });

  it("keeps a child started before compression parent close as a subthread", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10, endedAt: 100 }),
      row("subthread", {
        parentSessionId: "root",
        startedAt: 90,
        messageCount: 4,
      }),
    ];

    const projected = projectCompressionLineages(rows);

    expect(projected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["root", "subthread"]),
    );
    expect(projected).toHaveLength(2);
    expect(
      projected.find((item) => item.id === "subthread"),
    ).not.toHaveProperty("lineageRootId");
  });

  it("honors an explicit child-session marker from the WebUI API", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10, endedAt: 100 }),
      row("subthread", {
        parentSessionId: "root",
        startedAt: 110,
        relationshipType: "child_session",
      }),
    ];

    const projected = projectCompressionLineages(rows);

    expect(projected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["root", "subthread"]),
    );
    expect(projected).toHaveLength(2);
  });

  it("keeps cross-source, unknown-source, and missing-parent rows independent", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("cross-source", {
        parentSessionId: "root",
        source: "gateway",
        startedAt: 20,
      }),
      row("unknown-source", {
        parentSessionId: "root",
        source: "",
        startedAt: 30,
      }),
      row("missing-parent", {
        parentSessionId: "not-present",
        startedAt: 40,
      }),
    ];

    expect(projectCompressionLineages(rows).map((item) => item.id)).toEqual([
      "missing-parent",
      "unknown-source",
      "cross-source",
      "root",
    ]);
  });

  it("chooses the newest messageful continuation when compression has siblings", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("stale-child", {
        parentSessionId: "root",
        startedAt: 20,
        messageCount: 4,
      }),
      row("live-child", {
        parentSessionId: "root",
        startedAt: 30,
        messageCount: 8,
      }),
      row("empty-newer-child", {
        parentSessionId: "root",
        startedAt: 40,
        messageCount: 0,
      }),
    ];

    const projected = projectCompressionLineages(rows);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "live-child",
      lineageRootId: "root",
      compressionSegmentCount: 4,
    });
  });

  it("follows a compression child before a newer live sibling", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("compressed-child", {
        parentSessionId: "root",
        endReason: "compression",
        startedAt: 20,
      }),
      row("newer-live-sibling", {
        parentSessionId: "root",
        startedAt: 40,
      }),
      row("real-tip", {
        parentSessionId: "compressed-child",
        startedAt: 30,
      }),
    ];

    expect(projectCompressionLineages(rows)).toEqual([
      expect.objectContaining({ id: "real-tip", lineageRootId: "root" }),
    ]);
  });

  it("falls back from an empty terminal path to the newest messageful sibling", () => {
    const rows = [
      row("root", {
        endReason: "compression",
        startedAt: 10,
        title: "Comandero webpage analysis",
        pinned: true,
      }),
      row("compressed-child", {
        parentSessionId: "root",
        endReason: "compression",
        startedAt: 20,
        messageCount: 37,
        title: "Continue the unfinished task from the parent",
      }),
      row("empty-terminal", {
        parentSessionId: "compressed-child",
        startedAt: 30,
        messageCount: 0,
        title: "Continue the unfinished task from the parent",
      }),
      row("visible-sibling", {
        parentSessionId: "root",
        startedAt: 40,
        messageCount: 4,
        title: "Continue the unfinished task from the parent",
      }),
    ];

    expect(projectCompressionLineages(rows)).toEqual([
      expect.objectContaining({
        id: "visible-sibling",
        title: "Comandero webpage analysis",
        messageCount: 4,
        pinned: true,
        lineageRootId: "root",
        lineageMemberIds: [
          "root",
          "compressed-child",
          "empty-terminal",
          "visible-sibling",
        ],
      }),
    ]);
  });

  it("uses the trimmed root title over a generated continuation suffix", () => {
    expect(
      projectCompressionLineages([
        row("root", {
          endReason: "compression",
          title: "Canonical conversation title ",
        }),
        row("tip", {
          parentSessionId: "root",
          startedAt: 20,
          title: "Canonical conversation title #14",
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "tip",
        title: "Canonical conversation title",
      }),
    ]);
  });

  it("prefers a live child over a newer closed orphan sibling", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("live", {
        parentSessionId: "root",
        startedAt: 20,
        endedAt: null,
      }),
      row("orphan", {
        parentSessionId: "root",
        startedAt: 30,
        endedAt: 40,
        endReason: "ws_orphan_reap",
      }),
    ];

    expect(projectCompressionLineages(rows)[0].id).toBe("live");
  });

  it("maps every segment id to the same canonical tip without looping on bad cycles", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("tip", { parentSessionId: "root", startedAt: 20 }),
      row("cycle-a", {
        parentSessionId: "cycle-b",
        endReason: "compression",
        startedAt: 30,
      }),
      row("cycle-b", {
        parentSessionId: "cycle-a",
        endReason: "compression",
        startedAt: 40,
      }),
    ];

    const projection = buildCompressionLineageProjection(rows);
    expect(projection.canonicalBySessionId.get("root")?.id).toBe("tip");
    expect(projection.canonicalBySessionId.get("tip")?.id).toBe("tip");
    expect(projection.projected.map((item) => item.id)).toContain("tip");
  });

  it("expands a projected deletion to lineage segments but not branches", () => {
    const rows = [
      row("root", { endReason: "compression", startedAt: 10 }),
      row("middle", {
        parentSessionId: "root",
        endReason: "compression",
        startedAt: 20,
      }),
      row("tip", { parentSessionId: "middle", startedAt: 30 }),
      row("branch", {
        parentSessionId: "root",
        startedAt: 40,
        modelConfig: { _branched_from: "root" },
      }),
    ];

    expect(compressionLineageMemberIdsForSession(rows, "tip").sort()).toEqual([
      "middle",
      "root",
      "tip",
    ]);
    expect(compressionLineageMemberIdsForSession(rows, "branch")).toEqual([
      "branch",
    ]);
  });
});
