#!/usr/bin/env node

const { attach } = require("./e2e-attach");

const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 12_000;

function usage() {
  console.error(
    "Usage: node scripts/verify-background-session-refresh.js " +
      "prepare | wait-present <marker> [timeoutMs] | " +
      "wait-absent <marker> [timeoutMs]",
  );
}

function parseTimeout(raw) {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid timeout: ${raw}`);
  }
  return value;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sample(page, marker) {
  return page.evaluate(async (expectedMarker) => {
    const normalizedMarker = expectedMarker.toLowerCase();
    const domTitles = Array.from(
      document.querySelectorAll(".sessions-card-title"),
    )
      .map((node) => node.textContent?.trim() || "")
      .filter((title) => title.toLowerCase().includes(normalizedMarker));
    const cached = await window.hermesAPI.listCachedSessions(50, 0);
    const cachedMatches = cached
      .filter((session) =>
        session.title.toLowerCase().includes(normalizedMarker),
      )
      .map((session) => ({ id: session.id, title: session.title }));

    return {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      domTitles,
      cachedMatches,
    };
  }, marker);
}

async function prepare(page) {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+K" : "Control+K",
  );
  await page.locator(".sessions-modal").waitFor({ state: "visible" });
  await page.locator(".sessions-list").waitFor({ state: "visible" });
  return {
    command: "prepare",
    observedAt: new Date().toISOString(),
    visibilityState: await page.evaluate(() => document.visibilityState),
    hasFocus: await page.evaluate(() => document.hasFocus()),
    modalVisible: await page.locator(".sessions-modal").isVisible(),
    listVisible: await page.locator(".sessions-list").isVisible(),
  };
}

async function waitForMarker(page, command, marker, timeoutMs) {
  const startedAt = Date.now();
  const shouldBePresent = command === "wait-present";
  let latest = null;

  while (Date.now() - startedAt <= timeoutMs) {
    latest = await sample(page, marker);
    const cachePresent = latest.cachedMatches.length > 0;
    const domPresent = latest.domTitles.length > 0;
    const matched = shouldBePresent
      ? cachePresent && domPresent
      : !cachePresent && !domPresent;
    if (matched) {
      return {
        command,
        marker,
        observedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        visibilityState: latest.visibilityState,
        hasFocus: latest.hasFocus,
        domMatch: domPresent,
        cacheMatch: cachePresent,
        sessionId: latest.cachedMatches[0]?.id || null,
        cachedTitle: latest.cachedMatches[0]?.title || null,
        domTitle: latest.domTitles[0] || null,
      };
    }
    await pause(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${command} ${marker}; ` +
      `last sample=${JSON.stringify(latest)}`,
  );
}

async function main() {
  const [command, marker, rawTimeout] = process.argv.slice(2);
  if (
    !["prepare", "wait-present", "wait-absent"].includes(command) ||
    (command !== "prepare" && !marker)
  ) {
    usage();
    process.exitCode = 2;
    return;
  }

  const timeoutMs = parseTimeout(rawTimeout);
  const { browser, page } = await attach();
  try {
    const receipt =
      command === "prepare"
        ? await prepare(page)
        : await waitForMarker(page, command, marker, timeoutMs);
    console.log(JSON.stringify(receipt));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
