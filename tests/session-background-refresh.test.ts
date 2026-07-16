import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Hermes One background session refresh", () => {
  it("keeps the primary renderer clock running while minimized", () => {
    const source = readFileSync(
      join(process.cwd(), "src/main/app/start.ts"),
      "utf8",
    );
    expect(source).toContain("backgroundThrottling: false");
  });

  it("mounts revision polling independently of sidebar expansion", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/renderer/src/screens/Layout/SidebarRecentSessions.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("useSessionRevisionPoll({");
    expect(source).not.toContain(
      "const timer = setInterval(() => void refresh(), RECENT_REFRESH_MS)",
    );
  });
});
