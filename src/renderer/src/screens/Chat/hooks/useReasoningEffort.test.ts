import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
} from "./useReasoningEffort";

describe("normalizeReasoningEffort", () => {
  it("accepts literal ultra for GPT-5.6 Sol", () => {
    expect(normalizeReasoningEffort("ultra", "gpt-5.6-sol")).toBe("ultra");
  });

  it("migrates the legacy mislabeled max value to ultra for Sol", () => {
    expect(normalizeReasoningEffort("max", "gpt-5.6-sol")).toBe("ultra");
  });

  it("falls back to auto for unknown values", () => {
    expect(normalizeReasoningEffort("ultra", "gpt-5.5")).toBe(
      DEFAULT_REASONING_EFFORT,
    );
  });
});
