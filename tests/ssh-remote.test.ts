import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/main/locale", () => ({
  getAppLocale: () => "en",
}));

import {
  buildRemoteHermesCmd,
  sshSetConfigValue,
  buildGatewayStartCommand,
  buildGatewayStopCommand,
  buildGatewayStatusCommand,
  parseHermesProfileListOutput,
  selectSshProfiles,
  sshListCachedSessions,
  sshListSessions,
  sshSearchSessions,
} from "../src/main/ssh-remote";
import type { SshProfileInfo } from "../src/main/ssh-remote";
import type { SshConfig } from "../src/main/ssh-tunnel";

function profile(
  name: string,
  overrides: Partial<SshProfileInfo> = {},
): SshProfileInfo {
  return {
    name,
    path: name === "default" ? "~/.hermes" : `~/.hermes/profiles/${name}`,
    isDefault: name === "default",
    isActive: name === "default",
    model: "",
    provider: "auto",
    hasEnv: false,
    hasSoul: false,
    skillCount: 0,
    gatewayRunning: false,
    ...overrides,
  };
}

/** The `then` clause of the leading `if` — the systemd-managed branch. */
function systemdBranch(command: string): string {
  return command.slice(command.indexOf("then"), command.indexOf("else"));
}

const sshConfig: SshConfig = {
  host: "example.test",
  port: 22,
  username: "hermes",
  keyPath: "",
  remotePort: 8642,
  localPort: 18642,
};

function runWithHermesShim(command: string): Buffer {
  const home = mkdtempSync(join(tmpdir(), "hermes-ssh-cmd-home-"));
  // Install the shim at a path buildRemoteHermesCmd PROBES BY ABSOLUTE PATH
  // ($HOME/.local/bin/hermes), not just on PATH. The command runs under
  // `bash -lc` (a login shell), which re-sources /etc/profile and RESETS PATH —
  // so a shim reachable only via a prepended PATH entry is dropped, and the
  // final `command -v hermes` fallback then finds either nothing (clean CI
  // container → the test fails) or a real host hermes (dev box → the test
  // passes for the wrong reason). Placing the shim at the probed absolute
  // location makes the `[ -x $HOME/.local/bin/hermes ]` branch fire first,
  // independent of login-shell PATH behavior and of whether a real hermes
  // exists on the host. PATH is still prepended as belt-and-suspenders.
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  const hermes = join(localBin, "hermes");
  writeFileSync(
    hermes,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "doctor" ]; then',
      '  printf "doctor stderr preserved\\\\n" >&2',
      "  exit 0",
      "fi",
      'printf "%s\\\\0" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(hermes, 0o755);
  return execFileSync("bash", ["-lc", command], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    },
  });
}

function parseNulArgs(output: Buffer): string[] {
  const parts = output.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

describe("ssh remote config writes", () => {
  it.each([
    ["quote", 'bad"value'],
    ["backslash", "bad\\value"],
    ["newline", "bad\nvalue"],
    ["carriage return", "bad\rvalue"],
  ])(
    "rejects YAML-breaking %s values before remote writes",
    async (_name, value) => {
      await expect(
        sshSetConfigValue(sshConfig, "base_url", value),
      ).rejects.toThrow("Config value contains illegal characters");
    },
  );
});

describe("SSH compression lineage reads", () => {
  it("projects before pagination and keeps the best old-segment search snippet", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-ssh-lineage-"));
    const binDir = join(home, "bin");
    const hermesDir = join(home, ".hermes");
    const keyPath = join(home, "id_test");
    const sshShim = join(binDir, "ssh");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(hermesDir, { recursive: true });
    writeFileSync(keyPath, "test key");
    writeFileSync(
      sshShim,
      [
        "#!/bin/sh",
        'for arg in "$@"; do remote_command="$arg"; done',
        'exec /bin/sh -c "$remote_command"',
        "",
      ].join("\n"),
    );
    chmodSync(sshShim, 0o755);

    execFileSync("/usr/bin/sqlite3", [
      join(hermesDir, "state.db"),
      `
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, source TEXT, started_at INTEGER,
          ended_at INTEGER, message_count INTEGER, model TEXT, title TEXT,
          parent_session_id TEXT, end_reason TEXT, model_config TEXT
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY, session_id TEXT, content TEXT, timestamp INTEGER
        );
        INSERT INTO sessions VALUES
          ('newer', 'webui', 50, NULL, 2, 'other-model', 'Newer', NULL, NULL, NULL),
          ('tip', 'webui', 30, NULL, 3, 'tip-model', NULL, 'middle', NULL, NULL),
          ('middle', 'webui', 20, 25, 8, 'middle-model', NULL, 'root', 'compression', NULL),
          ('root', 'webui', 10, 15, 10, 'root-model', 'Needle lineage', NULL, 'compression', NULL),
          ('delegate', 'webui', 8, NULL, 2, 'delegate-model', 'Delegate', 'root', NULL, '{"_delegate_from":"root"}'),
          ('unknown-root', NULL, 7, 8, 1, 'unknown-model', 'Unknown root', NULL, 'compression', NULL),
          ('unknown-child', NULL, 6, NULL, 1, 'unknown-model', 'Unknown child', 'unknown-root', NULL, NULL),
          ('older', 'webui', 5, NULL, 1, 'older-model', 'Older', NULL, NULL, NULL);
        INSERT INTO messages VALUES
          (1, 'tip', 'needle', 31),
          (2, 'middle', 'The best meaningful needle snippet from an old segment', 21),
          (3, 'unknown-root', 'unknown-source root', 7),
          (4, 'unknown-child', 'unknown-source child', 6);
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100
        )
        INSERT INTO messages (id, session_id, content, timestamp)
          SELECT value + 100, 'tip', 'needle short ' || value, 31 + value
          FROM sequence;
      `,
    ]);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${binDir}:${previousPath || ""}`;
    const config = { ...sshConfig, keyPath };
    try {
      expect(
        (await sshListSessions(config, 1, 2)).map((session) => session.id),
      ).toEqual(["delegate"]);
      expect(
        (await sshListCachedSessions(config, 1, 2)).map(
          (session) => session.id,
        ),
      ).toEqual(["delegate"]);
      const visibleIds = (await sshListSessions(config, 20, 0)).map(
        (session) => session.id,
      );
      expect(visibleIds).toContain("unknown-root");
      expect(visibleIds).toContain("unknown-child");

      const results = await sshSearchSessions(config, "needle", 10);
      expect(results).toEqual([
        expect.objectContaining({
          sessionId: "tip",
          title: "Needle lineage",
          startedAt: 30,
          messageCount: 3,
          model: "tip-model",
          snippet: expect.stringContaining("best meaningful"),
        }),
      ]);

      const unknownResults = await sshSearchSessions(
        config,
        "unknown-source",
        10,
      );
      expect(unknownResults.map((result) => result.sessionId).sort()).toEqual([
        "unknown-child",
        "unknown-root",
      ]);
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ssh Hermes command quoting", () => {
  it("shell-quotes the whole sh script without dropping per-argument quoting", () => {
    const command = buildRemoteHermesCmd([
      "kanban",
      "create",
      "My task title",
      "--triage",
      "--json",
    ]);

    expect(command).not.toContain(
      "sh -c '[ -x $HOME/hermes-agent/.venv/bin/hermes ] && exec $HOME/hermes-agent/.venv/bin/hermes 'kanban' 'create'",
    );
    expect(command).toContain(
      `$HOME/hermes-agent/.venv/bin/hermes '"'"'kanban'"'"'`,
    );
  });

  it.each([
    [
      "multi-word title",
      ["kanban", "create", "My task title", "--triage", "--json"],
    ],
    [
      "multiline markdown body",
      [
        "kanban",
        "create",
        "My task title",
        "--body",
        "first line\n- bullet one\n- bullet two",
        "--triage",
        "--json",
      ],
    ],
    [
      "single quote in user input",
      ["kanban", "create", "User's task", "--json"],
    ],
  ])(
    "preserves %s",
    (_name, expectedArgs) => {
      const command = buildRemoteHermesCmd(expectedArgs);
      expect(parseNulArgs(runWithHermesShim(command))).toEqual(expectedArgs);
    },
    30000,
  );

  it("preserves existing extraShell redirects", () => {
    const output = runWithHermesShim(
      buildRemoteHermesCmd(["doctor"], " 2>&1"),
    ).toString("utf8");
    expect(output).toBe("doctor stderr preserved\n");
  }, 30000);
});

describe("ssh gateway commands (issue #285)", () => {
  it("detects a systemd hermes.service unit before acting", () => {
    for (const cmd of [
      buildGatewayStartCommand(),
      buildGatewayStopCommand(),
      buildGatewayStatusCommand(),
    ]) {
      expect(cmd).toContain("systemctl list-unit-files hermes.service");
      expect(cmd.indexOf("if ")).toBeLessThan(cmd.indexOf("else"));
    }
  });

  it("start prefers systemd, falling back to nohup only without a unit", () => {
    const cmd = buildGatewayStartCommand();
    expect(cmd).toContain("systemctl start hermes.service");
    expect(cmd).toContain("sudo -n systemctl start hermes.service");
    // The nohup fallback must live in the else branch — never alongside
    // systemd, where it would strand the unit in a restart crash-loop.
    expect(cmd).toContain("nohup hermes gateway start");
    expect(systemdBranch(cmd)).not.toContain("nohup");
  });

  it("stop routes through systemd, else hermes gateway stop", () => {
    const cmd = buildGatewayStopCommand();
    expect(cmd).toContain("systemctl stop hermes.service");
    expect(cmd).toContain("hermes gateway stop");
    expect(systemdBranch(cmd)).not.toContain("hermes gateway stop");
    expect(systemdBranch(cmd)).not.toContain("kill");
  });

  it("status reports the systemd unit state when managed", () => {
    const cmd = buildGatewayStatusCommand();
    expect(cmd).toContain("systemctl is-active hermes.service");
    expect(cmd).toContain("gateway.pid");
    expect(systemdBranch(cmd)).not.toContain("gateway.pid");
  });
});

describe("buildRemoteHermesCmd venv probe (issue #284)", () => {
  const cmd = buildRemoteHermesCmd(["--version"]);

  it("probes explicit remote launcher hooks before default install paths", () => {
    const configLauncher = "$HOME/.config/hermes-desktop/remote-hermes";
    const legacyLauncher = "$HOME/.hermes/desktop-remote-hermes";
    expect(cmd).toContain(configLauncher);
    expect(cmd).toContain(legacyLauncher);
    expect(cmd.indexOf(configLauncher)).toBeLessThan(
      cmd.indexOf("$HOME/hermes-agent/.venv/bin/hermes"),
    );
  });

  it("probes both .venv and venv for every install base", () => {
    for (const base of [
      "$HOME/hermes-agent",
      "$HOME/.hermes/hermes-agent",
      "/opt/hermes/hermes-agent",
    ]) {
      expect(cmd).toContain(`${base}/.venv/bin/hermes`);
      expect(cmd).toContain(`${base}/venv/bin/hermes`);
    }
  });

  it("probes ~/.local/bin where pip --user installs a wrapper", () => {
    expect(cmd).toContain("$HOME/.local/bin/hermes");
  });

  it("does not bake in deployment-specific managed runtime defaults", () => {
    expect(cmd).not.toContain("/projects/hermes-runtime");
    expect(cmd).not.toContain("sudo -n -u hermes");
  });

  it("does not probe the /usr/local/bin sudo-wrapper it deliberately bypasses", () => {
    expect(cmd).not.toContain("/usr/local/bin/hermes");
  });

  it("still falls back to bare hermes on PATH", () => {
    expect(cmd).toContain("command -v hermes");
  });
});

describe("parseHermesProfileListOutput", () => {
  it("parses the Hermes profile table used by managed SSH launchers", () => {
    const profiles = parseHermesProfileListOutput(`
 Profile              Model                        Gateway      Alias        Distribution
 ───────────────      ───────────────────────────  ───────────  ───────────  ────────────────────
 ◆default             gpt-5.5                      running      —            —
  biz-office          gpt-5.5                      running      biz-office   —
  finance-accounting  gpt-5.5                      stopped      finance-accounting —
  marketing           gpt-5.5                      running      marketing    —
`);

    expect(profiles.map((p) => p.name)).toEqual([
      "default",
      "biz-office",
      "finance-accounting",
      "marketing",
    ]);
    expect(profiles.find((p) => p.name === "default")?.isActive).toBe(true);
    expect(profiles.find((p) => p.name === "marketing")?.gatewayRunning).toBe(
      true,
    );
    expect(
      profiles.find((p) => p.name === "finance-accounting")?.gatewayRunning,
    ).toBe(false);
  });

  it("marks default active when the table has no active marker", () => {
    const profiles = parseHermesProfileListOutput(`
 Profile          Model       Gateway
 default          gpt-5.5     running
 marketing        gpt-5.5     stopped
`);

    expect(profiles.find((p) => p.name === "default")?.isActive).toBe(true);
    expect(profiles.find((p) => p.name === "marketing")?.isActive).toBe(false);
  });
});

describe("selectSshProfiles", () => {
  it("prefers the launcher runtime over an equal-length home-directory scan", () => {
    // Greptile P1: a managed install whose launcher reports the SAME profile
    // count as the SSH user's ~/.hermes scan must still surface the launcher's
    // live state (correct HERMES_HOME, real gateway status), not the stale scan.
    const launcher = {
      present: true,
      profiles: [
        profile("default", { gatewayRunning: true, model: "gpt-5.5" }),
      ],
    };
    const scanned = [profile("default", { gatewayRunning: false })];

    const result = selectSshProfiles(launcher, scanned);

    expect(result).toBe(launcher.profiles);
    expect(result[0].gatewayRunning).toBe(true);
  });

  it("prefers the launcher even when the home-directory scan has more profiles", () => {
    const launcher = { present: true, profiles: [profile("default")] };
    const scanned = [profile("default"), profile("leftover-home-profile")];

    expect(selectSshProfiles(launcher, scanned)).toBe(launcher.profiles);
  });

  it("falls back to the filesystem scan when no launcher is configured", () => {
    // Without a launcher, launcher.profiles is empty and the richer scan wins.
    const launcher = { present: false, profiles: [] };
    const scanned = [profile("default"), profile("marketing")];

    expect(selectSshProfiles(launcher, scanned)).toBe(scanned);
  });

  it("falls back to the scan when a launcher exists but returns no profiles", () => {
    const launcher = { present: true, profiles: [] };
    const scanned = [profile("default")];

    expect(selectSshProfiles(launcher, scanned)).toBe(scanned);
  });

  it("returns launcher profiles when the scan is empty", () => {
    const launcher = { present: true, profiles: [profile("default")] };

    expect(selectSshProfiles(launcher, [])).toBe(launcher.profiles);
  });
});
