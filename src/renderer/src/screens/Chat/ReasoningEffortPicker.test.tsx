import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("lucide-react", () => ({
  Brain: () => null,
  Check: () => null,
  ChevronDown: () => null,
}));

import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

describe("ReasoningEffortPicker", () => {
  it("shows Ultra for GPT-5.6 Sol", () => {
    render(
      <ReasoningEffortPicker
        model="gpt-5.6-sol"
        value="auto"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "chat.reasoningEffort.auto" }));

    expect(screen.getByText("chat.reasoningEffort.max")).toBeTruthy();
  });

  it("does not show Ultra for other models", () => {
    render(
      <ReasoningEffortPicker
        model="gpt-5.5"
        value="auto"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "chat.reasoningEffort.auto" }));

    expect(screen.queryByText("chat.reasoningEffort.max")).toBeNull();
  });
});
