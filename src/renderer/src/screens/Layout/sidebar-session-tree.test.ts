import { describe, expect, it } from "vitest";
import {
  attachSidebarChildSessions,
  type SidebarSessionRow,
} from "./sidebar-session-tree";

function row(
  id: string,
  overrides: Partial<SidebarSessionRow> = {},
): SidebarSessionRow {
  return { id, title: id, ...overrides };
}

describe("sidebar child-session tree", () => {
  it("returns parent-only rows and bubbles loaded child state to the parent", () => {
    const result = attachSidebarChildSessions([
      row("child", {
        parentSessionId: "parent",
        relationshipType: "child_session",
        pinned: true,
        isWorking: true,
        activityPhase: "tool",
      }),
      row("parent"),
      row("unrelated"),
    ]);

    expect(result.map((session) => session.id)).toEqual([
      "parent",
      "unrelated",
    ]);
    expect(result[0]).toMatchObject({
      id: "parent",
      pinned: true,
      isWorking: true,
      activityPhase: "tool",
    });
    expect(result[0].children).toBeUndefined();
  });

  it("does not promote a pinned child into a duplicate top-level row", () => {
    const result = attachSidebarChildSessions([
      row("child", {
        parentSessionId: "parent",
        relationshipType: "child_session",
        pinned: true,
      }),
      row("parent"),
    ]);

    expect(result.map((session) => session.id)).toEqual(["parent"]);
    expect(result[0]).toMatchObject({ id: "parent", pinned: true });
  });

  it("keeps orphan child references out of the primary list", () => {
    const result = attachSidebarChildSessions([
      row("child", {
        parentSessionId: "missing-parent",
        relationshipType: "child_session",
      }),
    ]);

    expect(result).toEqual([]);
  });
});
