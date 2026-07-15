# Background Session Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Hermes One's session cache and visible session lists current on a reliable five-second cadence while its window is open, including while minimized, unfocused, or occluded.

**Architecture:** A dependency-injected Electron main-process coordinator owns the 5,000 ms timer and the one process-wide single-flight synchronization gate. It reuses the existing local/remote/SSH session routing, publishes a typed scoped generation notice after a successful current-scope sync, and lets each renderer consumer re-read its own exact cache window while preserving request-order guards. Chromium renderer throttling remains enabled.

**Tech Stack:** Electron 39, TypeScript 5.9, React 19, Vitest 4 with fake timers and Testing Library, electron-vite, electron-builder, macOS app bundle tooling.

---

## File map

- Create `src/shared/session-refresh.ts`: shared typed scope and refresh-notice contract.
- Create `src/main/session-refresh-coordinator.ts`: timer, scope validation, process-wide single-flight gate, queued newest-scope follow-up, publication, and disposal.
- Create `src/main/session-refresh-coordinator.test.ts`: deterministic coordinator cadence/concurrency/scope/disposal/error tests.
- Create `src/preload/session-refresh.ts`: isolated typed Electron event subscription helper.
- Create `src/preload/session-refresh.test.ts`: subscription forwarding and cleanup tests without importing the full preload graph.
- Modify `src/main/ipc/register.ts`: extract the existing mode-aware session sync function and route `sync-session-cache` through the coordinator gate supplied by `IpcContext`.
- Modify `src/main/app/start.ts`: own connection-generation state, instantiate/start/stop the coordinator, publish notices, and expose its current scope/request functions to IPC.
- Modify `src/preload/index.ts` and `src/preload/index.d.ts`: expose typed `getSessionRefreshScope` and `onSessionCacheRefreshed` bridge methods.
- Create `src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx`: protect loaded-window pagination and stale-read handling on refresh notices.
- Modify `src/renderer/src/screens/Layout/SidebarRecentSessions.tsx`: remove the 60-second renderer timer, keep initial/focus/mutation behavior, and reload the exact loaded window on a matching notice.
- Modify `src/renderer/src/screens/Sessions/Sessions.test.tsx`: replace renderer-interval expectations with scoped notice, hidden/unmount, exact-window, and stale-read tests.
- Modify `src/renderer/src/screens/Sessions/Sessions.tsx`: accept `activeProfile`, remove the 30-second renderer timer, keep initial/focus/mutation behavior, and reload the first 50 cached rows on a matching notice.
- Modify `src/renderer/src/screens/Layout/Layout.tsx`: pass the active profile to the Sessions modal.
- Create `scripts/verify-background-session-refresh.js`: packaged-app CDP driver that opens the Sessions modal and polls its DOM/cache from Node without focusing the minimized renderer.
- Modify `lat.md/sidebar-navigation.md`: record the new main-process ownership and invariants.

### Task 1: Shared contract and coordinator red tests

**Files:**

- Create: `src/shared/session-refresh.ts`
- Create: `src/main/session-refresh-coordinator.test.ts`
- Test: `src/main/session-refresh-coordinator.test.ts`

- [ ] **Step 1: Define the shared serializable contract**

```ts
export interface SessionRefreshScope {
  mode: "local" | "remote" | "ssh";
  profile: string;
  connectionGeneration: number;
}

export interface SessionCacheRefreshedNotice {
  scope: SessionRefreshScope;
  generation: number;
}

export function sameSessionRefreshScope(
  left: SessionRefreshScope,
  right: SessionRefreshScope,
): boolean {
  return (
    left.mode === right.mode &&
    left.profile === right.profile &&
    left.connectionGeneration === right.connectionGeneration
  );
}
```

- [ ] **Step 2: Write fake-timer tests for the coordinator's externally visible contract**

Cover these cases with a deferred-promise helper and dependency spies:

```ts
expect(SESSION_REFRESH_INTERVAL_MS).toBe(5_000);
expect(refresh).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(4_999);
expect(refresh).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(refresh).toHaveBeenCalledTimes(1);
```

Also assert: no live window skips a tick; interval and explicit `request()` calls for the same scope share one promise; multiple ticks during slow work do not overlap; a different current scope queues exactly one immediate newest-scope follow-up; an old-scope completion does not publish; successful current-scope work publishes monotonically increasing generations; errors log once, preserve liveness, and retry at the next tick; `stop()` clears the interval and suppresses a late publication.

- [ ] **Step 3: Run the coordinator test to verify RED**

Run: `npx vitest run src/main/session-refresh-coordinator.test.ts`

Expected: FAIL because `session-refresh-coordinator.ts` and its exports do not exist.

- [ ] **Step 4: Commit the contract and red tests**

```bash
git add src/shared/session-refresh.ts src/main/session-refresh-coordinator.test.ts
git commit -m "test: specify background session refresh coordinator"
```

### Task 2: Main-process coordinator

**Files:**

- Create: `src/main/session-refresh-coordinator.ts`
- Modify: `src/main/session-refresh-coordinator.test.ts`
- Test: `src/main/session-refresh-coordinator.test.ts`

- [ ] **Step 1: Implement the minimal dependency-injected coordinator**

Use this public surface and keep Electron imports out of the module:

```ts
export const SESSION_REFRESH_INTERVAL_MS = 5_000;

export interface SessionRefreshCoordinatorOptions<T> {
  getScope: () => SessionRefreshScope;
  hasLiveWindow: () => boolean;
  refresh: (scope: SessionRefreshScope) => Promise<T>;
  publish: (notice: SessionCacheRefreshedNotice) => void;
  logError?: (message: string, error: unknown) => void;
}

export interface SessionRefreshCoordinator<T> {
  start(): void;
  stop(): void;
  request(): Promise<T>;
  getCurrentScope(): SessionRefreshScope;
}
```

Internally keep one `inFlight` record, one optional newest-scope pending request, one monotonic generation, the interval handle, and a disposed flag. Same-scope callers return the current promise. A different-scope caller updates the one pending record; after current settlement, immediately run the latest current scope. Before publication compare the captured scope with `getScope()` and check both `!disposed` and `hasLiveWindow()`.

- [ ] **Step 2: Run the coordinator tests and make only contract-driven corrections**

Run: `npx vitest run src/main/session-refresh-coordinator.test.ts`

Expected: PASS with all cadence, concurrency, stale-scope, failure, and disposal cases green.

- [ ] **Step 3: Run node typechecking**

Run: `npm run typecheck:node`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 4: Commit the coordinator**

```bash
git add src/main/session-refresh-coordinator.ts src/main/session-refresh-coordinator.test.ts
git commit -m "feat: add main-process session refresh coordinator"
```

### Task 3: Canonical session-sync routing and app lifecycle

**Files:**

- Modify: `src/main/ipc/register.ts:388-396,2167-2200`
- Modify: `src/main/app/start.ts:1-145`
- Test: `src/main/session-refresh-coordinator.test.ts`

- [ ] **Step 1: Extract the existing mode-aware routing without changing semantics**

Export an async function next to `registerIpcHandlers`:

```ts
export async function syncSessionCacheForCurrentConnection(): Promise<
  CachedSession[]
> {
  const conn = getConnectionConfig();
  if (conn.mode === "remote") return remoteListCachedSessions(conn, 50);
  if (conn.mode === "ssh" && conn.ssh) {
    return withSshDashboardSessions(
      conn,
      (config) => remoteListCachedSessions(config, 50),
      () => sshListCachedSessions(conn.ssh, 50),
      activeSshProfile(),
    );
  }
  try {
    return syncSessionCache();
  } catch (error) {
    console.error("sync-session-cache failed; using local cache", error);
    return listCachedSessions(50);
  }
}
```

Add `requestSessionCacheSync: () => Promise<CachedSession[]>` and `getSessionRefreshScope: () => SessionRefreshScope` to `IpcContext`. Make the `sync-session-cache` handler call `requestSessionCacheSync`, and add `get-session-refresh-scope` returning the current serializable scope.

- [ ] **Step 2: Instantiate the coordinator before IPC registration**

In `start.ts`, maintain `let connectionGeneration = 0`, derive scope from `getPublicConnectionConfig().mode`, `getActiveProfileNameSync()`, and that generation, and instantiate the coordinator with `syncSessionCacheForCurrentConnection`. Publish only through:

```ts
mainWindow?.webContents.send("session-cache-refreshed", notice);
```

Pass `requestSessionCacheSync: coordinator.request` and `getSessionRefreshScope: coordinator.getCurrentScope` into `registerIpcHandlers`.

- [ ] **Step 3: Wire exact lifecycle ownership**

Start the coordinator after `createWindow()` inside `app.whenReady()`. Increment `connectionGeneration` before sending `connection-config-changed`. Keep the coordinator alive but idle when macOS has no windows because `hasLiveWindow` returns false. Call `coordinator.stop()` first in `before-quit` so an in-flight completion cannot publish during teardown.

- [ ] **Step 4: Run focused tests and node typechecking**

Run: `npx vitest run src/main/session-refresh-coordinator.test.ts && npm run typecheck:node`

Expected: PASS; the extracted local/remote/SSH branches compile unchanged and one coordinator owns all `sync-session-cache` calls.

- [ ] **Step 5: Commit main-process integration**

```bash
git add src/main/ipc/register.ts src/main/app/start.ts
git commit -m "feat: run session refresh from Electron main"
```

### Task 4: Typed preload bridge

**Files:**

- Create: `src/preload/session-refresh.ts`
- Create: `src/preload/session-refresh.test.ts`
- Modify: `src/preload/index.ts:340-390,1000-1030`
- Modify: `src/preload/index.d.ts:335-390,920-980`
- Test: `src/preload/session-refresh.test.ts`

- [ ] **Step 1: Write a failing subscription-contract test**

With a fake object exposing `on` and `removeListener`, prove that the helper forwards only the notice argument and returns an unsubscribe function that removes the exact wrapped handler:

```ts
const unsubscribe = subscribeToSessionCacheRefreshed(ipc, callback);
registeredHandler({} as Electron.IpcRendererEvent, notice);
expect(callback).toHaveBeenCalledWith(notice);
unsubscribe();
expect(ipc.removeListener).toHaveBeenCalledWith(
  "session-cache-refreshed",
  registeredHandler,
);
```

- [ ] **Step 2: Run the preload test to verify RED**

Run: `npx vitest run src/preload/session-refresh.test.ts`

Expected: FAIL because the subscription helper does not exist.

- [ ] **Step 3: Implement the helper and expose both typed methods**

Add:

```ts
getSessionRefreshScope: (): Promise<SessionRefreshScope> =>
  ipcRenderer.invoke("get-session-refresh-scope"),
onSessionCacheRefreshed: (callback) =>
  subscribeToSessionCacheRefreshed(ipcRenderer, callback),
```

Mirror both declarations in `index.d.ts`, importing or structurally reusing the shared types so runtime and global `Window` typings cannot drift.

- [ ] **Step 4: Run preload test and both typechecks**

Run: `npx vitest run src/preload/session-refresh.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the bridge**

```bash
git add src/preload/session-refresh.ts src/preload/session-refresh.test.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: expose session refresh notices to renderer"
```

### Task 5: Sidebar exact-window refresh

**Files:**

- Create: `src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx`
- Modify: `src/renderer/src/screens/Layout/SidebarRecentSessions.tsx:20-45,220-450`
- Test: `src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx`

- [ ] **Step 1: Write RED component tests around a captured notice callback**

Install a minimal `window.hermesAPI` mock with `onSessionCacheRefreshed`, `getSessionRefreshScope`, `listCachedSessions`, and `syncSessionCache`. Render the sidebar open with `activeProfile="default"`, load more than 30 rows through the scroll path, emit a matching notice, and assert the follow-up cache read requests `Math.max(loadedRows, 30) + 1` from offset zero. Assert rows already loaded are not truncated and `hasMore` is recomputed from the sentinel.

Add a deferred-read case: emit two matching notices, resolve the newer exact-window read first and the older read second, and assert the older result cannot overwrite the newer UI. Emit a notice for another profile and assert no cache read occurs. Unmount and assert the exact subscription is removed.

- [ ] **Step 2: Run the sidebar test to verify RED**

Run: `npx vitest run src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx`

Expected: FAIL because the sidebar has no refresh-notice subscription and still owns a renderer interval.

- [ ] **Step 3: Implement notice-driven exact-window reads**

Remove `RECENT_REFRESH_MS` and its `setInterval`. Retain initial cache + explicit sync, focus, context-folder mutation, profile-switch, and session-switch behavior. Add a request-generation ref shared by initial, focus, profile, and notice reads. On a notice, first ask `getSessionRefreshScope`; continue only when it still equals the notice and `notice.scope.profile === activeProfile`, then increment the guard and read:

```ts
const loadedLimit = Math.max(
  RECENT_SESSIONS_PAGE_SIZE,
  sessionsRef.current.length,
);
const rows = await window.hermesAPI.listCachedSessions(loadedLimit + 1, 0);
```

Apply only when the guard and mounted/open/profile checks remain current. Keep previous rows on failure.

- [ ] **Step 4: Run sidebar tests and web typechecking**

Run: `npx vitest run src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx && npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit sidebar behavior**

```bash
git add src/renderer/src/screens/Layout/SidebarRecentSessions.tsx src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx
git commit -m "feat: refresh sidebar from main-process notices"
```

### Task 6: Sessions modal notice refresh

**Files:**

- Modify: `src/renderer/src/screens/Sessions/Sessions.test.tsx`
- Modify: `src/renderer/src/screens/Sessions/Sessions.tsx:1-30,285-370,550-595`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx:885-905`
- Test: `src/renderer/src/screens/Sessions/Sessions.test.tsx`

- [ ] **Step 1: Replace timer tests with RED notice tests**

Delete imports and assertions for `SESSIONS_REFRESH_MS`. Extend the mock with a captured `onSessionCacheRefreshed` callback and `getSessionRefreshScope`. Prove a matching notice while `visible` quietly reads `listCachedSessions(50, 0)`, updates rows without a spinner, and never calls `syncSessionCache` itself. Prove hidden, mismatched-profile, and unmounted consumers do no work. Prove two deferred notice reads cannot apply out of order. Keep the focus, initial-load, connection-change, deletion, and search tests.

- [ ] **Step 2: Run the Sessions test to verify RED**

Run: `npx vitest run src/renderer/src/screens/Sessions/Sessions.test.tsx`

Expected: FAIL because the component has no `activeProfile` prop or notice subscription and still owns the 30-second interval.

- [ ] **Step 3: Implement first-page notice refresh**

Add `activeProfile: string` to `SessionsProps` and pass `activeProfile` from `Layout.tsx`. Remove `SESSIONS_REFRESH_MS` and `setInterval`, retaining the focus listener. Subscribe only while visible; on a matching current scope, increment `loadRequestId`, read `listCachedSessions(50, 0)`, and apply only if the request id, visibility, profile, and mounted state remain current. Preserve the currently rendered rows when the read fails or transiently returns empty.

- [ ] **Step 4: Run both renderer suites and web typechecking**

Run: `npx vitest run src/renderer/src/screens/Sessions/Sessions.test.tsx src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx && npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit Sessions behavior**

```bash
git add src/renderer/src/screens/Sessions/Sessions.tsx src/renderer/src/screens/Sessions/Sessions.test.tsx src/renderer/src/screens/Layout/Layout.tsx
git commit -m "feat: refresh session modal from shared generations"
```

### Task 7: Living architecture documentation

**Files:**

- Modify: `lat.md/sidebar-navigation.md`
- Test: `lat.md/sidebar-navigation.md`

- [ ] **Step 1: Document runtime ownership and invariants**

Add a `## Background session refresh` section explaining: main process owns one 5-second timer; renderer background throttling remains enabled; local/remote/SSH use one routing path; all explicit/timer callers share one in-flight gate; scope is mode + connection generation + profile; old-scope results are discarded; sidebar reloads loaded-window-plus-sentinel; Sessions reloads 50; failures retain visible rows; macOS no-window state is idle and quit disposes the coordinator.

- [ ] **Step 2: Run LAT validation**

Run: `lat check`

Expected: PASS with no broken references or invalid LAT structure.

- [ ] **Step 3: Commit documentation**

```bash
git add lat.md/sidebar-navigation.md
git commit -m "docs: explain background session refresh ownership"
```

### Task 8: Packaged-app acceptance driver

**Files:**

- Create: `scripts/verify-background-session-refresh.js`
- Reuse: `scripts/e2e-attach.js`

- [ ] **Step 1: Implement the exact CDP acceptance driver**

Build `scripts/verify-background-session-refresh.js` on the existing `scripts/e2e-attach.js` helper. It must support:

```text
node scripts/verify-background-session-refresh.js prepare
node scripts/verify-background-session-refresh.js wait-present <marker> [timeoutMs]
node scripts/verify-background-session-refresh.js wait-absent <marker> [timeoutMs]
```

`prepare` attaches to `CDP_PORT`, sends `Meta+K`, and waits for `.sessions-modal` plus `.sessions-list`. The wait modes poll from the Node process with `setTimeout` and a fresh `page.evaluate` each time (never `page.waitForFunction`, whose renderer-side polling can itself be throttled). Each sample returns `document.visibilityState`, `document.hasFocus()`, matching `.sessions-card-title` text, and `window.hermesAPI.listCachedSessions(50, 0)` results. A successful wait prints one JSON receipt containing the matching cached session id, first-observed timestamp, visibility, focus state, and DOM/cache match booleans; it exits nonzero when the condition misses its deadline.

- [ ] **Step 2: Verify syntax and formatting**

Run: `npx prettier --check scripts/verify-background-session-refresh.js && node --check scripts/verify-background-session-refresh.js`

Expected: formatting and syntax checks pass.

- [ ] **Step 3: Commit the acceptance driver**

```bash
git add scripts/verify-background-session-refresh.js
git commit -m "test: add minimized session refresh acceptance driver"
```

### Task 9: Full verification and direct-main publication

**Files:**

- Verify: all changed source, tests, docs, lockfile, and packaging metadata

- [ ] **Step 1: Install the locked dependency graph if needed**

Run: `npm ci`

Expected: exit 0 and no changes to `package-lock.json`.

- [ ] **Step 2: Run formatting check through Prettier without rewriting unrelated files**

Run: `npx prettier --check src/shared/session-refresh.ts src/main/session-refresh-coordinator.ts src/main/session-refresh-coordinator.test.ts src/main/app/start.ts src/main/ipc/register.ts src/preload/session-refresh.ts src/preload/session-refresh.test.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/screens/Layout/SidebarRecentSessions.tsx src/renderer/src/screens/Layout/SidebarRecentSessions.test.tsx src/renderer/src/screens/Sessions/Sessions.tsx src/renderer/src/screens/Sessions/Sessions.test.tsx src/renderer/src/screens/Layout/Layout.tsx scripts/verify-background-session-refresh.js lat.md/sidebar-navigation.md`

Expected: all listed files use Prettier formatting.

- [ ] **Step 3: Run the complete verification matrix**

Run: `npm test && npm run lint && npm run typecheck && lat check`

Expected: all Vitest files pass, ESLint exits 0, both TypeScript projects exit 0, and LAT validation exits 0.

- [ ] **Step 4: Inspect scope before the final commit**

Run: `git status --short && git diff --check && git diff --stat origin/main...HEAD && git log --oneline origin/main..HEAD`

Expected: only the planned Hermes Desktop files changed; no whitespace errors; commits are limited to the approved background-refresh design/implementation.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add src scripts/verify-background-session-refresh.js docs/superpowers/plans/2026-07-16-background-session-refresh.md lat.md/sidebar-navigation.md
git commit -m "fix: close session refresh verification gaps"
```

Skip this commit when there are no remaining changes.

- [ ] **Step 6: Push user-fork main, never upstream**

Run: `git remote -v && git branch --show-current && git push origin main`

Expected: `origin` is `sebmarion/hermes-desktop`, branch is `main`, and the push succeeds. Do not push `upstream` and do not open an upstream PR.

### Task 10: Build, install, and minimized live acceptance

**Files:**

- Create: `scripts/verify-background-session-refresh.js`
- Build artifact: `dist/mac*/Hermes One.app` or the exact `electron-builder` output reported by the command
- Install target: `/Applications/Hermes One.app`
- Rollback bundle: `/private/tmp/Hermes One.rollback-<timestamp>.app`

- [ ] **Step 1: Build the real Hermes One macOS bundle**

Run: `npm run build:mac`

Expected: electron-vite and electron-builder exit 0 and produce a bundle whose `CFBundleName`/product is `Hermes One`, package version is `0.7.3`, executable is `Hermes One`, and main entry resolves to `out/main/index.js`.

- [ ] **Step 2: Read back bundle identity and signature before installation**

Run the matching artifact path through `plutil -p <artifact>/Contents/Info.plist`, `codesign --verify --deep --strict --verbose=2 <artifact>`, and `file <artifact>/Contents/MacOS/Hermes\ One`.

Expected: Hermes One identity is correct, the strict signature verifies, and the executable contains the current Mac architecture. If signing/notarization credentials are unavailable, stop before replacing the installed app and report the exact gate.

- [ ] **Step 3: Preserve rollback and install atomically**

Quit Hermes One cleanly, copy `/Applications/Hermes One.app` to a timestamped `/private/tmp` rollback bundle, install the verified new bundle with `ditto`, and rerun `plutil`, `codesign --verify --deep --strict`, and `file` against `/Applications/Hermes One.app`.

Expected: installed read-back exactly matches the built artifact and rollback remains intact.

- [ ] **Step 4: Launch with opt-in CDP and prove the deployed process owns the installed executable**

Quit all existing Hermes One processes, then launch the installed executable directly so the opt-in environment is guaranteed to reach Electron:

```bash
ENABLE_CDP=1 CDP_PORT=19334 "/Applications/Hermes One.app/Contents/MacOS/Hermes One"
```

Keep that process running in its PTY/session, wait for its primary window, then read back the running PID/executable with `pgrep`/`ps` plus the app bundle metadata. Run `CDP_PORT=19334 node scripts/verify-background-session-refresh.js prepare` while the app is still focused.

Expected: the live process path is `/Applications/Hermes One.app/Contents/MacOS/Hermes One`, version is 0.7.3, and the renderer loads without a crash or error dialog.

- [ ] **Step 5: Establish the exact external-create command and marker**

Set a unique marker before minimizing, but do not create the session yet:

```bash
MARKER="BGREFRESH-$(date -u +%Y%m%dT%H%M%SZ)"
```

The external mutation will use the supported Hermes CLI one-shot interface, which creates a normal durable session through Hermes Agent rather than editing SQLite:

```bash
~/.local/bin/hermes --oneshot "$MARKER Reply with exactly OK." --ignore-rules
```

This intentionally makes one minimal configured-model request. Record the CLI start/end timestamps and output. The marker is the first title token, so the CDP driver can identify the resulting session deterministically and return its durable id for cleanup.

- [ ] **Step 6: Prove refresh while minimized and unfocused**

With the Sessions modal already open from `prepare`, minimize Hermes One and move focus to Finder:

```bash
osascript -e 'tell application "System Events" to tell process "Hermes One" to set value of attribute "AXMinimized" of window 1 to true' -e 'tell application "Finder" to activate'
osascript -e 'tell application "System Events" to tell process "Hermes One" to return {frontmost, value of attribute "AXMinimized" of window 1}'
```

Expected precondition receipt: `{false, true}`. Only after that receipt, execute the one-shot command from Step 5. Immediately start the Node-side observer:

```bash
CDP_PORT=19334 node scripts/verify-background-session-refresh.js wait-present "$MARKER" 12000
```

Then rerun the AppleScript state read-back. Acceptance requires: `frontmost=false`, `AXMinimized=true`, CDP receipt `visibilityState="hidden"`, `hasFocus=false`, matching cached session id present, matching `.sessions-card-title` present, and first observation no later than 10 seconds after CLI completion (one five-second refresh plus up to one sampling cadence). CDP attachment/evaluation must not activate or restore the app.

- [ ] **Step 7: Restore, verify stable presentation, and clean up externally**

Restore the minimized window only after the hidden-state receipt. Confirm the marker is already rendered on the first restored frame, with no focus-triggered waiting period, pagination truncation, or loading flash. Parse `sessionId` from the CDP JSON receipt, then clean up through the supported external CLI:

```bash
~/.local/bin/hermes sessions delete --yes "$SESSION_ID"
CDP_PORT=19334 node scripts/verify-background-session-refresh.js wait-absent "$MARKER" 12000
```

Expected: the canonical delete succeeds and the modal drops the row on a later refresh generation without a manual reload.

- [ ] **Step 8: Capture final deployment evidence**

Record: origin/main commit SHA, built artifact path and SHA-256, installed bundle SHA-256 or deterministic bundle tree receipt, strict signature result, version/executable read-back, live PID/path, minimized state evidence, external mutation id/timestamps, refresh-observation timestamp, cleanup result, and rollback path.

- [ ] **Step 9: Roll back both deployment and source publication on any regression**

Before the implementation push, record `PRE_RELEASE_SHA=$(git rev-parse origin/main)`; after it, record `RELEASE_SHA=$(git rev-parse HEAD)`. If launch, signature, identity, or live session behavior fails, quit the new app, restore the timestamped rollback bundle with `ditto`, reverify it, and relaunch it. Then create a normal public revert on user-fork `main` (never reset or force-push):

```bash
git revert --no-commit "$PRE_RELEASE_SHA..$RELEASE_SHA"
git commit -m "revert: background session refresh release"
git push origin main
```

Run the complete verification matrix on the restored source state and report the failed gate plus the rollback/revert SHA. Do not reset or delete `~/.hermes`, its profiles, or `state.db`; if revert conflicts prevent a safe automatic rollback, leave the verified old app installed and report the exact source conflict instead of force-pushing.
