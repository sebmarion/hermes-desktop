import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
} from "./useReasoningEffort";

describe("normalizeReasoningEffort", () => {
  it("accepts max for GPT-5.6 Sol", () => {
    expect(normalizeReasoningEffort("max", "gpt-5.6-sol")).toBe("max");
  });

  it("falls back to auto for unknown values", () => {
    expect(normalizeReasoningEffort("ultra")).toBe(DEFAULT_REASONING_EFFORT);
    expect(normalizeReasoningEffort("max", "gpt-5.5")).toBe(
      DEFAULT_REASONING_EFFORT,
    );
  });
});
