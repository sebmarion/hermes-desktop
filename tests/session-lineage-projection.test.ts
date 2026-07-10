import { describe, expect, it } from "vitest";
import {
  buildCompressionLineageProjection,
  projectCompressionLineages,
  type CompressionLineageRow,
} from "../src/main/session-lineage";

interface FixtureRow extends CompressionLineageRow {
  title: string | null;
  contextFolder: string | null;
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
    ...overrides,
  };
}

describe("compression lineage projection", () => {
  it("collapses a five-segment compression chain into its live tip", () => {
    const rows = [
      row("root", {
        endReason: "compression",
        startedAt: 10,
        messageCount: 100,
        title: "Stable title",
        contextFolder: "/repo",
      }),
      row("segment-2", {
        parentSessionId: "root",
        endReason: "compression",
        startedAt: 20,
        messageCount: 90,
      }),
      row("segment-3", {
        parentSessionId: "segment-2",
        endReason: "compression",
        startedAt: 30,
        messageCount: 80,
      }),
      row("segment-4", {
        parentSessionId: "segment-3",
        endReason: "compression",
        startedAt: 40,
        messageCount: 70,
      }),
      row("tip", {
        parentSessionId: "segment-4",
        startedAt: 50,
        messageCount: 60,
        title: null,
      }),
    ];

    expect(projectCompressionLineages(rows)).toEqual([
      expect.objectContaining({
        id: "tip",
        lineageRootId: "root",
        compressionSegmentCount: 5,
        startedAt: 50,
        messageCount: 60,
        title: "Stable title",
        contextFolder: "/repo",
      }),
    ]);
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
});
