import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import type { RequestListener } from "http";

// hermes.ts pulls in the full main-process import graph; mock the modules with
// import-time side effects (installer → electron) and the two seams under
// test (config's readEnv / secrets' providerListSafe). Everything else
// (run-stream, url-key-map, …) is pure and loads for real.
vi.mock("./installer", () => ({
  HERMES_HOME: "/tmp/hermes-test-home",
  HERMES_REPO: "/tmp/hermes-test-repo",
  HERMES_PYTHON: "python3",
  hermesCliArgs: vi.fn(() => []),
  getEnhancedPath: vi.fn(() => ""),
}));
vi.mock("./config", () => ({
  getApiServerKey: vi.fn(() => ""),
  getConnectionConfig: vi.fn(() => ({
    mode: "local",
    remoteUrl: "",
    apiKey: "",
    remoteAuthMode: "auto",
    ssh: {},
  })),
  getConfigValue: vi.fn(() => null),
  getModelConfig: vi.fn(),
  readEnv: vi.fn(() => ({})),
}));
vi.mock("./ssh-tunnel", () => ({
  getSshTunnelUrl: vi.fn(() => null),
  isSshTunnelActive: vi.fn(() => false),
  isSshTunnelHealthy: vi.fn(() => false),
  startSshTunnel: vi.fn(),
}));
vi.mock("./utils", () => ({
  pidIsAliveAs: vi.fn(() => false),
  stripAnsi: (s: string) => s,
  profileHome: vi.fn(() => "/tmp/hermes-test-home"),
  profilePaths: vi.fn(() => ({
    configFile: "/tmp/hermes-test-home/config.yaml",
    envFile: "/tmp/hermes-test-home/.env",
  })),
  normalizeProfileName: (p?: string) => p,
  getActiveProfileNameSync: vi.fn(() => undefined),
}));
vi.mock("./gateway-ports", () => ({ getProfilePort: vi.fn(() => 8642) }));
vi.mock("./models", () => ({ readModels: vi.fn(() => []) }));
vi.mock("./secrets", () => ({ providerListSafe: vi.fn(() => ({})) }));
vi.mock("child_process", () => {
  const spawn = vi.fn();
  return { spawn, ChildProcess: class {}, default: { spawn } };
});

import { spawn } from "child_process";
import {
  getApiServerKey,
  getConnectionConfig,
  getConfigValue,
  getModelConfig,
  readEnv,
} from "./config";
import type { ConnectionConfig } from "./config";
import { providerListSafe } from "./secrets";
import {
  reasoningEffortForProfile,
  getRemoteAuthHeader,
  sendMessage,
  shouldForceCliForSessionOverride,
  stopHealthPolling,
  transcribeAudio,
} from "./hermes";
import type { ChatCallbacks } from "./hermes";

const mockedGetModelConfig = vi.mocked(getModelConfig);
const mockedGetApiServerKey = vi.mocked(getApiServerKey);
const mockedGetConnectionConfig = vi.mocked(getConnectionConfig);
const mockedReadEnv = vi.mocked(readEnv);
const mockedProviderListSafe = vi.mocked(providerListSafe);
const mockedSpawn = vi.mocked(spawn);

describe("reasoningEffortForProfile", () => {
  afterEach(() => {
    vi.mocked(getConfigValue).mockReturnValue(null);
  });

  it("migrates legacy max and passes literal ultra only to Sol models", () => {
    vi.mocked(getConfigValue).mockReturnValue("max");

    expect(reasoningEffortForProfile(undefined, "gpt-5.6-sol")).toBe("ultra");
    expect(reasoningEffortForProfile(undefined, "gpt-5.6")).toBe("ultra");
    expect(reasoningEffortForProfile(undefined, "gpt-5.5")).toBeNull();

    vi.mocked(getConfigValue).mockReturnValue("ultra");
    expect(reasoningEffortForProfile(undefined, "gpt-5.6-sol")).toBe("ultra");
  });
});

describe("Sol Ultra API transport", () => {
  const baseCapabilities = {
    features: {
      run_submission: true,
      run_events_sse: true,
      run_stop: true,
      run_approval_response: true,
      tool_progress_events: true,
    },
    endpoints: {
      runs: { path: "/v1/runs" },
      run_events: { path: "/v1/runs/{run_id}/events" },
      run_approval: { path: "/v1/runs/{run_id}/approval" },
      run_stop: { path: "/v1/runs/{run_id}/stop" },
    },
  };

  async function listen(
    handler: RequestListener,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }

  function configureRemoteSol(url: string): void {
    mockedGetConnectionConfig.mockReturnValue(
      testConnection({ mode: "remote", remoteUrl: url, apiKey: "test-key" }),
    );
    mockedGetModelConfig.mockReturnValue({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as ReturnType<typeof getModelConfig>);
    vi.mocked(getConfigValue).mockReturnValue("ultra");
  }

  afterEach(() => {
    vi.mocked(getConfigValue).mockReturnValue(null);
    stopHealthPolling();
  });

  it("fails closed when the gateway does not advertise Sol Ultra", async () => {
    const paths: string[] = [];
    const server = await listen((req, res) => {
      paths.push(req.url || "");
      if (req.url === "/v1/capabilities") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(baseCapabilities));
        return;
      }
      res.statusCode = 500;
      res.end("unexpected fallback");
    });
    configureRemoteSol(server.url);

    try {
      const error = new Promise<string>((resolve) => {
        void sendMessage("hello", {
          onChunk: () => undefined,
          onDone: () => undefined,
          onError: resolve,
        });
      });
      expect(await error).toMatch(/Ultra.*support/i);
      expect(paths).toEqual(["/v1/capabilities"]);
    } finally {
      await server.close();
    }
  });

  it("sends the literal ultra request through /v1/runs", async () => {
    let runBody: Record<string, unknown> | null = null;
    const server = await listen((req, res) => {
      if (req.url === "/v1/capabilities") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ...baseCapabilities,
            features: {
              ...baseCapabilities.features,
              request_scoped_reasoning_effort: true,
              sol_ultra_reasoning: true,
            },
          }),
        );
        return;
      }
      if (req.url === "/v1/runs" && req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk.toString()));
        req.on("end", () => {
          runBody = JSON.parse(raw) as Record<string, unknown>;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ run_id: "run_ultra", status: "started" }));
        });
        return;
      }
      if (req.url === "/v1/runs/run_ultra/events") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          'event: run.completed\ndata: {"event":"run.completed","output":"done"}\n\n',
        );
        return;
      }
      res.statusCode = 500;
      res.end("unexpected request");
    });
    configureRemoteSol(server.url);

    try {
      const done = new Promise<void>((resolve, reject) => {
        void sendMessage("hello", {
          onChunk: () => undefined,
          onDone: () => resolve(),
          onError: (error) => reject(new Error(error)),
        });
      });
      await done;
      expect(runBody).toMatchObject({
        model: "gpt-5.6-sol",
        input: "hello",
        reasoning_effort: "ultra",
      });
    } finally {
      await server.close();
    }
  });

  it("does not fall back to chat completions when an Ultra run fails", async () => {
    const paths: string[] = [];
    const server = await listen((req, res) => {
      paths.push(req.url || "");
      if (req.url === "/v1/capabilities") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ...baseCapabilities,
            features: {
              ...baseCapabilities.features,
              request_scoped_reasoning_effort: true,
              sol_ultra_reasoning: true,
            },
          }),
        );
        return;
      }
      if (req.url === "/v1/runs" && req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ run_id: "run_failed", status: "started" }));
        return;
      }
      if (req.url === "/v1/runs/run_failed/events") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          'event: run.failed\ndata: {"event":"run.failed","error":"app-server unavailable"}\n\n',
        );
        return;
      }
      res.statusCode = 500;
      res.end("unexpected legacy fallback");
    });
    configureRemoteSol(server.url);

    try {
      const error = new Promise<string>((resolve) => {
        void sendMessage("hello", {
          onChunk: () => undefined,
          onDone: () => undefined,
          onError: resolve,
        });
      });
      expect(await error).toMatch(/cannot fall back.*app-server unavailable/i);
      expect(paths).toEqual([
        "/v1/capabilities",
        "/v1/runs",
        "/v1/runs/run_failed/events",
      ]);
    } finally {
      await server.close();
    }
  });
});

function testConnection(
  fields: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    mode: "local",
    remoteUrl: "",
    apiKey: "",
    remoteAuthMode: "auto",
    remoteChatTransport: "auto",
    sshChatTransport: "auto",
    ssh: {
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      remotePort: 8642,
      localPort: 8642,
    },
    ...fields,
  };
}

describe("remote authentication headers", () => {
  // @lat: [[remote-dashboard-oauth#Test specifications#OAuth bearer suppression]]
  it("does not reuse a stored token after the remote resolves to OAuth", () => {
    mockedGetConnectionConfig.mockReturnValue(
      testConnection({
        mode: "remote",
        remoteUrl: "https://hermes.example",
        apiKey: "stale-token",
        remoteAuthMode: "oauth",
      }),
    );

    expect(getRemoteAuthHeader()).toEqual({});

    mockedGetConnectionConfig.mockReturnValue(
      testConnection({
        mode: "remote",
        remoteUrl: "https://hermes.example",
        apiKey: "current-token",
        remoteAuthMode: "token",
      }),
    );
    expect(getRemoteAuthHeader()).toEqual({
      Authorization: "Bearer current-token",
    });
  });
});

describe("transcribeAudio API route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockedGetApiServerKey.mockReset();
    mockedGetApiServerKey.mockReturnValue("");
    mockedGetConnectionConfig.mockReset();
    mockedGetConnectionConfig.mockReturnValue(
      testConnection({
        mode: "remote",
        remoteUrl: "http://remote.test:8642",
        apiKey: "remote-key",
      }),
    );
    mockedGetModelConfig.mockReset();
    mockedReadEnv.mockReset();
    mockedProviderListSafe.mockReset();
    mockedGetModelConfig.mockReturnValue({
      baseUrl: "https://api.groq.com/openai/v1",
    } as ReturnType<typeof getModelConfig>);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, transcript: "transcribed" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentRequest(): [string, RequestInit] {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return fetchMock.mock.calls[0] as [string, RequestInit];
  }

  function sentJsonBody(): { data_url: string; mime_type: string } {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as {
      data_url: string;
      mime_type: string;
    };
  }

  it("posts desktop recordings to the Hermes audio endpoint", async () => {
    await expect(
      transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default"),
    ).resolves.toBe("transcribed");

    const [url, init] = sentRequest();
    expect(url).toBe("http://remote.test:8642/api/audio/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer remote-key",
    });
    expect(sentJsonBody()).toEqual({
      data_url: "data:audio/webm;base64,AQID",
      mime_type: "audio/webm",
    });
  });

  it("strips a remote /v1 suffix before calling the desktop audio route", async () => {
    mockedGetConnectionConfig.mockReturnValue(
      testConnection({
        mode: "remote",
        remoteUrl: "http://remote.test:8642/v1",
        apiKey: "",
      }),
    );

    await transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default");

    const [url] = sentRequest();
    expect(url).toBe("http://remote.test:8642/api/audio/transcribe");
  });

  it("surfaces backend transcription errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "404 page not found",
    });

    await expect(
      transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default"),
    ).rejects.toThrow("Transcription failed (404). 404 page not found");
  });
});

describe("sendMessage session model override routing", () => {
  const noopCallbacks: ChatCallbacks = {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };

  function fakeChildProcess(): unknown {
    return {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      killed: false,
    };
  }

  function cliArgs(): string[] {
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    return mockedSpawn.mock.calls[0][1] as string[];
  }

  beforeEach(() => {
    mockedGetApiServerKey.mockReset();
    mockedGetApiServerKey.mockReturnValue("");
    mockedGetConnectionConfig.mockReset();
    mockedGetConnectionConfig.mockReturnValue(
      testConnection({
        mode: "local",
        remoteUrl: "",
        apiKey: "",
      }),
    );
    mockedGetModelConfig.mockReset();
    mockedReadEnv.mockReset();
    mockedReadEnv.mockReturnValue({});
    mockedProviderListSafe.mockReset();
    mockedProviderListSafe.mockReturnValue({});
    mockedSpawn.mockReset();
    mockedSpawn.mockReturnValue(fakeChildProcess() as ReturnType<typeof spawn>);
    // Persisted default: GPT-5.5 on the (sticky) OpenAI-Codex provider.
    mockedGetModelConfig.mockReturnValue({
      provider: "openai-codex",
      model: "gpt-5.5",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as ReturnType<typeof getModelConfig>);
  });

  afterEach(() => {
    stopHealthPolling();
  });

  // @lat: [[model-selection#Session model override#Text-only legacy fallback routes via CLI]]
  it("routes a cross-provider override through the CLI with its provider + model", async () => {
    await sendMessage(
      "hello",
      noopCallbacks,
      "default",
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "gemini", model: "gemini-2.5-pro", baseUrl: "" },
    );

    const args = cliArgs();
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gemini-2.5-pro");
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("gemini");
  });

  // @lat: [[model-selection#Session model override#Attachment turns stay on session transport]]
  it("keeps attachment turns off the CLI override fallback", () => {
    const persisted = {
      provider: "openai-codex",
      model: "gpt-5.5",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as ReturnType<typeof getModelConfig>;
    const effective = {
      provider: "gemini",
      model: "gemini-2.5-pro",
      baseUrl: "",
    } as ReturnType<typeof getModelConfig>;

    expect(
      shouldForceCliForSessionOverride(
        persisted,
        effective,
        { provider: "gemini", model: "gemini-2.5-pro", baseUrl: "" },
        [
          {
            id: "img-1",
            kind: "image",
            name: "cat.png",
            mime: "image/png",
            size: 12,
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      ),
    ).toBe(false);
  });
});
