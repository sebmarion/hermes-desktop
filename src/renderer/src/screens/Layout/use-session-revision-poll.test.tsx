import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_REVISION_POLL_MS,
  useSessionRevisionPoll,
} from "./use-session-revision-poll";

function Harness({
  profile,
  onChange,
}: {
  profile: string;
  onChange: () => void;
}): React.JSX.Element {
  useSessionRevisionPoll({ profile, onChange });
  const [mounted] = useState(true);
  return <div data-mounted={mounted} />;
}

describe("useSessionRevisionPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not rebuild the session list while the revision is unchanged", async () => {
    const getSessionRevision = vi.fn().mockResolvedValue("rev-a");
    const onChange = vi.fn();
    Object.assign(window, { hermesAPI: { getSessionRevision } });
    render(<Harness profile="default" onChange={onChange} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REVISION_POLL_MS * 3);
    });

    expect(getSessionRevision).toHaveBeenCalledTimes(4);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refreshes once after a real revision change even while the document is hidden", async () => {
    const getSessionRevision = vi
      .fn()
      .mockResolvedValueOnce("rev-a")
      .mockResolvedValueOnce("rev-b")
      .mockResolvedValue("rev-b");
    const onChange = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { hermesAPI: { getSessionRevision } });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    render(<Harness profile="default" onChange={onChange} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REVISION_POLL_MS * 2);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps only one revision request in flight", async () => {
    let resolveRevision: ((value: string) => void) | undefined;
    const getSessionRevision = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRevision = resolve;
        }),
    );
    Object.assign(window, { hermesAPI: { getSessionRevision } });
    render(<Harness profile="default" onChange={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REVISION_POLL_MS * 4);
    });
    expect(getSessionRevision).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRevision?.("rev-a");
      await Promise.resolve();
    });
  });

  it("refreshes when a previously missing state.db appears", async () => {
    const getSessionRevision = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("created-rev");
    const onChange = vi.fn();
    Object.assign(window, { hermesAPI: { getSessionRevision } });
    render(<Harness profile="default" onChange={onChange} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REVISION_POLL_MS);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-baselines instead of comparing revisions across profiles", async () => {
    const getSessionRevision = vi
      .fn()
      .mockResolvedValueOnce("default-rev")
      .mockResolvedValueOnce("worker-rev");
    const onChange = vi.fn();
    Object.assign(window, { hermesAPI: { getSessionRevision } });
    const view = render(<Harness profile="default" onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
    });

    view.rerender(<Harness profile="worker" onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});
