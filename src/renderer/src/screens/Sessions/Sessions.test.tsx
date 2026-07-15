import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCacheRefreshedNotice } from "../../../../shared/session-refresh";

// useI18n needs an I18nProvider; the Sessions tab only uses `t` for labels,
// so a pass-through mock keeps these tests focused on the refresh behaviour.
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: () => {},
  }),
}));

import Sessions from "./Sessions";

const baseProps = {
  onResumeSession: (): void => {},
  onNewChat: (): void => {},
  currentSessionId: null,
  activeProfile: "default",
};

function installHermesAPI(initialSessions: unknown[] = []): {
  listCachedSessions: ReturnType<typeof vi.fn>;
  syncSessionCache: ReturnType<typeof vi.fn>;
  searchSessions: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  deleteSessions: ReturnType<typeof vi.fn>;
  emitConnectionConfigChanged: () => void;
  emitRefresh: (notice: SessionCacheRefreshedNotice) => void;
  unsubscribeRefresh: ReturnType<typeof vi.fn>;
} {
  let connectionConfigChanged: (() => void) | null = null;
  let refreshListener: ((notice: SessionCacheRefreshedNotice) => void) | null =
    null;
  const unsubscribeRefresh = vi.fn(() => {
    refreshListener = null;
  });
  const api = {
    listCachedSessions: vi.fn().mockResolvedValue(initialSessions),
    syncSessionCache: vi.fn().mockResolvedValue(initialSessions),
    searchSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteSessions: vi.fn().mockResolvedValue({ requested: 0, deleted: 0 }),
    getSessionRefreshScope: vi.fn().mockResolvedValue({
      mode: "local",
      profile: "default",
      connectionGeneration: 0,
    }),
    onSessionCacheRefreshed: vi.fn(
      (callback: (notice: SessionCacheRefreshedNotice) => void) => {
        refreshListener = callback;
        return unsubscribeRefresh;
      },
    ),
    onConnectionConfigChanged: vi.fn((callback: () => void) => {
      connectionConfigChanged = callback;
      return () => {
        if (connectionConfigChanged === callback) {
          connectionConfigChanged = null;
        }
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    ...api,
    emitConnectionConfigChanged: () => connectionConfigChanged?.(),
    emitRefresh: (notice) => refreshListener?.(notice),
    unsubscribeRefresh,
  };
}

function refreshNotice(
  profile = "default",
  generation = 1,
): SessionCacheRefreshedNotice {
  return {
    scope: { mode: "local", profile, connectionGeneration: 0 },
    generation,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sessionSearchResult(
  title: string | null,
  snippet: string,
  sessionId?: string,
): {
  sessionId: string;
  title: string | null;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
  snippet: string;
} {
  return {
    sessionId:
      sessionId ??
      (title ?? snippet)
        .replace(/<</g, "")
        .replace(/>>/g, "")
        .toLowerCase()
        .replace(/\s+/g, "-"),
    title,
    startedAt: Math.floor(Date.now() / 1000),
    source: "desktop",
    messageCount: 1,
    model: "gpt-5.5",
    snippet,
  };
}

describe("Sessions tab live refresh (#322)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the first cached page on a matching notice while visible", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const afterMount = api.syncSessionCache.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);
    api.listCachedSessions.mockResolvedValue([
      {
        id: "background-session",
        title: "Background session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);

    await act(async () => {
      api.emitRefresh(refreshNotice());
    });
    await waitFor(() => {
      expect(api.listCachedSessions).toHaveBeenCalledWith(50, 0);
    });
    expect(api.syncSessionCache).toHaveBeenCalledTimes(afterMount);
    expect(screen.getByText("Background session")).toBeTruthy();
    expect(screen.queryByText("sessions.loading")).toBeNull();
  });

  it("does no notice work while hidden", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={false} />);
    await act(async () => {});

    api.listCachedSessions.mockClear();
    await act(async () => {
      api.emitRefresh(refreshNotice());
      await Promise.resolve();
    });
    expect(api.listCachedSessions).not.toHaveBeenCalled();
  });

  it("ignores mismatched profiles and unsubscribes on unmount", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    const view = render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    api.listCachedSessions.mockClear();

    await act(async () => {
      api.emitRefresh(refreshNotice("work"));
      await Promise.resolve();
    });
    expect(api.listCachedSessions).not.toHaveBeenCalled();

    view.unmount();
    expect(api.unsubscribeRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the window regains focus", async () => {
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const afterMount = api.syncSessionCache.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterMount + 1);
  });

  it("keeps visible sessions when a quiet refresh transiently returns empty", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "ssh-session",
        title: "SSH session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "deepseek-v4-pro",
      },
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    expect(screen.getByText("SSH session")).toBeTruthy();

    api.listCachedSessions.mockResolvedValue([]);

    await act(async () => {
      api.emitRefresh(refreshNotice());
    });

    expect(screen.getByText("SSH session")).toBeTruthy();
    expect(screen.queryByText("sessions.empty")).toBeNull();
  });

  it("does not let an older notice read overwrite a newer one", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "initial",
        title: "Initial session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);
    render(<Sessions {...baseProps} visible={true} />);
    expect(await screen.findByText("Initial session")).toBeTruthy();

    const older = deferred<unknown[]>();
    const newer = deferred<unknown[]>();
    api.listCachedSessions.mockClear();
    api.listCachedSessions
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    await act(async () => {
      api.emitRefresh(refreshNotice("default", 2));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      api.emitRefresh(refreshNotice("default", 3));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listCachedSessions).toHaveBeenCalledTimes(2);

    newer.resolve([
      {
        id: "newest",
        title: "Newest session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);
    expect(await screen.findByText("Newest session")).toBeTruthy();

    older.resolve([
      {
        id: "older",
        title: "Older session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Newest session")).toBeTruthy();
    expect(screen.queryByText("Older session")).toBeNull();
  });

  it("lets a notice that supersedes the initial sync finish loading", async () => {
    vi.useRealTimers();
    const initialSync = deferred<unknown[]>();
    const api = installHermesAPI();
    api.syncSessionCache.mockReturnValue(initialSync.promise);
    api.listCachedSessions.mockResolvedValue([
      {
        id: "generation-winner",
        title: "Generation winner",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);

    const view = render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector(".sessions-loading")).not.toBeNull();

    await act(async () => {
      api.emitRefresh(refreshNotice());
    });
    await waitFor(() => {
      expect(api.listCachedSessions).toHaveBeenCalledWith(50, 0);
    });
    expect(view.container.querySelector(".sessions-loading")).toBeNull();
    expect(screen.getByText("Generation winner")).toBeTruthy();
  });

  it("lets the initial sync finish when a notice cache read fails", async () => {
    vi.useRealTimers();
    const initialSync = deferred<unknown[]>();
    const failedNotice = deferred<unknown[]>();
    const api = installHermesAPI();
    api.syncSessionCache.mockReturnValue(initialSync.promise);
    api.listCachedSessions.mockReturnValueOnce(failedNotice.promise);

    const view = render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector(".sessions-loading")).not.toBeNull();

    await act(async () => {
      api.emitRefresh(refreshNotice());
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.listCachedSessions).toHaveBeenCalledTimes(1);
    });
    failedNotice.reject(new Error("temporary cache failure"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    initialSync.resolve([
      {
        id: "initial-winner",
        title: "Initial winner",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "test-model",
      },
    ]);
    expect(await screen.findByText("Initial winner")).toBeTruthy();
    expect(view.container.querySelector(".sessions-loading")).toBeNull();
  });

  it("clears stale rows and reloads when the connection source changes", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "local-session",
        title: "Local session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "gpt-5.5",
      },
    ]);
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    expect(screen.getByText("Local session")).toBeTruthy();

    api.listCachedSessions.mockResolvedValue([]);
    api.syncSessionCache.mockResolvedValue([
      {
        id: "remote-session",
        title: "Remote session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "tui",
        messageCount: 2,
        model: "deepseek-v4-pro",
      },
    ]);

    await act(async () => {
      api.emitConnectionConfigChanged();
    });

    await waitFor(() => {
      expect(screen.getByText("Remote session")).toBeTruthy();
    });
    expect(screen.queryByText("Local session")).toBeNull();
  });

  it("renders sessions recovered by sync when the fast cache starts empty", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    api.syncSessionCache.mockResolvedValue([
      {
        id: "recovered-session",
        title: "Recovered older conversation",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 4,
        model: "gpt-5.5",
      },
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText("Recovered older conversation")).toBeTruthy();
    });
    expect(screen.queryByText("sessions.empty")).toBeNull();
  });

  it("ignores stale search results from earlier keystrokes", async () => {
    const api = installHermesAPI();
    let resolveBroadSearch:
      | ((value: ReturnType<typeof sessionSearchResult>[]) => void)
      | undefined;
    api.searchSessions.mockImplementation((query: string) => {
      if (query === "h") {
        return new Promise((resolve) => {
          resolveBroadSearch = resolve;
        });
      }
      if (query === "hello") {
        return Promise.resolve([
          sessionSearchResult("Hello match", "<<hello>>"),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "h" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    fireEvent.change(search, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(screen.getByText("Hello match")).toBeTruthy();

    await act(async () => {
      resolveBroadSearch?.([
        sessionSearchResult("Broad h match", "<<hermes>>"),
      ]);
    });

    expect(screen.getByText("Hello match")).toBeTruthy();
    expect(screen.queryByText("Broad h match")).toBeNull();
  });

  it("uses matched text as the visible title for untitled search results", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    api.searchSessions.mockResolvedValue([
      sessionSearchResult(
        null,
        "<<Live PR499>> smoke test. Reply exactly: OK",
        "session-722999",
      ),
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "Live PR499" } });

    await waitFor(() => {
      expect(screen.getByText(/smoke test\. Reply exactly: OK/)).toBeTruthy();
    });
    expect(screen.queryByText("sessions.title 722999")).toBeNull();
  });

  it("does not repopulate search results after clearing the input", async () => {
    const api = installHermesAPI();
    let resolveSearch:
      | ((value: ReturnType<typeof sessionSearchResult>[]) => void)
      | undefined;
    api.searchSessions.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    fireEvent.click(screen.getByRole("button", { name: "" }));

    await act(async () => {
      resolveSearch?.([sessionSearchResult("Late hello", "<<hello>>")]);
    });

    expect(search).toHaveProperty("value", "");
    expect(screen.queryByText("Late hello")).toBeNull();
    expect(screen.queryByText("sessions.empty")).toBeTruthy();
  });
});

describe("Sessions tab — delete affordance (#408)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("calls deleteSession when the trash button is clicked + confirmed", async () => {
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "sessions.deleteConfirm",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    expect(api.deleteSession).toHaveBeenCalledWith("sess-abc-123");
  });

  it("does NOT call deleteSession when the confirm is cancelled", async () => {
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteCancel" }),
      );
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("stops click propagation so the card's resume handler doesn't fire", async () => {
    // Regression: the trash button is nested inside a clickable card.
    // Clicking trash must NOT also resume the session (would open the chat
    // the user is trying to delete).
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    installHermesAPI(sessions);
    const onResume = vi.fn();

    render(
      <Sessions {...baseProps} onResumeSession={onResume} visible={true} />,
    );
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(onResume).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Sessions tab — bulk delete selection (#490)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes the selected sessions after confirmation", async () => {
    const sessions = [
      {
        id: "sess-one",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
      {
        id: "sess-two",
        title: "Second chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 1,
        model: "gpt-4",
      },
      {
        id: "sess-three",
        title: "Third chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 2,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("First chat"));
      fireEvent.click(screen.getByText("Second chat"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "sessions.deleteSelectedConfirm",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    await waitFor(() => {
      expect(api.deleteSessions).toHaveBeenCalledWith(["sess-one", "sess-two"]);
    });
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("selects only visible search results", async () => {
    const api = installHermesAPI([
      {
        id: "main-session",
        title: "Main chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 1,
        model: "gpt-4",
      },
    ]);
    api.searchSessions.mockResolvedValue([
      sessionSearchResult("Search one", "<<bulk>> one"),
      sessionSearchResult("Search two", "<<bulk>> two"),
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "bulk" } });
    await waitFor(() => {
      expect(screen.getByText("Search one")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectVisible" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    await waitFor(() => {
      expect(api.deleteSessions).toHaveBeenCalledWith([
        "search-one",
        "search-two",
      ]);
    });
    expect(api.deleteSessions).not.toHaveBeenCalledWith(["main-session"]);
  });

  it("does not delete selected sessions when the bulk confirm is cancelled", async () => {
    const sessions = [
      {
        id: "sess-one",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("First chat"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteCancel" }),
      );
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteSessions).not.toHaveBeenCalled();
  });
});
