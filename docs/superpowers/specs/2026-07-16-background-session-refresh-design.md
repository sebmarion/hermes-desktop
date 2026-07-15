# Background Session Refresh

Hermes One should keep its session surfaces current every five seconds while the primary app window remains open, including when the window is unfocused, occluded, or minimized.

## Problem

The recent-session sidebar currently refreshes every 60 seconds, while the full Sessions modal refreshes every 30 seconds. Both schedules live in the renderer and can be delayed when Chromium throttles a background or minimized window.

The existing focus listeners reduce staleness after the user returns, but they do not keep the open app synchronized in the background. Setting `backgroundThrottling: false` would keep the session timers accurate, but it would also keep unrelated renderer work such as animation and Office rendering active while hidden.

## Goals

The change must provide predictable background synchronization without globally disabling Electron's renderer throttling.

- Refresh the session cache on a five-second cadence while the main window exists.
- Update both the recent-session sidebar and the full Sessions modal from the same successful refresh generation.
- Continue running when the window is unfocused, occluded, or minimized.
- Prevent overlapping refresh work when a local database or remote connection is slow.
- Preserve the currently rendered rows when a refresh fails and retry on the next cadence.
- Keep the existing immediate initial load, focus refresh, profile switching, mutation refresh, and pagination behavior.
- Preserve local, remote HTTP, and SSH/dashboard routing semantics.

## Non-goals

This change does not alter session persistence, session ordering, title generation, search behavior, chat streaming, or background execution of Hermes Agent itself.

It does not disable Electron background throttling globally and does not introduce a new daemon, dependency, or persistent preference.

## Approaches considered

Three approaches were considered before selecting the coordinator design.

### Main-process refresh coordinator

The Electron main process owns a five-second coordinator, calls the existing mode-aware session synchronization path, and publishes the latest rows to the renderer. This is the selected approach because the main-process timer is not governed by renderer visibility throttling and only session work remains active in the background.

### Unthrottled renderer timer

Changing both renderer intervals to five seconds and setting `backgroundThrottling: false` is smaller, but it keeps every renderer timer and animation eligible to run while minimized. That is an unnecessarily broad battery and GPU cost for a session-list requirement.

### Filesystem watcher

Watching `state.db` and its WAL can avoid polling in local mode, but it is unreliable across SQLite file replacement and does not cover remote HTTP or SSH sessions. It would still need a separate polling path and would add platform-specific failure modes.

## Architecture

The implementation introduces a small, dependency-injected refresh coordinator in the Electron main process.

The coordinator owns the interval, a pending-tick flag, and disposal state. A process-wide session-sync gate owns the single in-flight refresh promise and is shared by every caller of session synchronization, including interval ticks, the `sync-session-cache` IPC handler used by initial/focus loads, and explicit mutation follow-ups. Callers requesting the same scope join the in-flight promise. A request for a different scope marks one pending run for that newer scope.

The existing `sync-session-cache` IPC handler's local/remote/SSH routing becomes a reusable function behind that gate. Both the IPC handler and the coordinator enter through the gate, keeping one canonical routing path and one concurrency owner.

Each refresh captures a scope identity derived from the active connection mode, connection configuration generation, and active profile. After a successful refresh, the coordinator rechecks that identity and drops the result when the scope changed while work was in flight.

For a current result, the coordinator sends a typed `session-cache-refreshed` notice containing the scope identity and a monotonic refresh generation to the primary window. The preload bridge exposes a typed subscription with an unsubscribe function. The notice deliberately does not carry a fixed-size row payload: each consumer reloads the exact window it owns after the canonical sync succeeds.

The sidebar and Sessions modal subscribe to this notice. The sidebar re-reads `max(loaded row count, page size) + 1` rows so it preserves pagination and recomputes `hasMore`; the Sessions modal re-reads its first 50 rows. Their initial load and focus listeners remain, while their independent 60-second and 30-second renderer intervals are removed.

## Lifecycle

The app lifecycle starts the coordinator after Electron is ready and the primary window has been created.

Ticks skip synchronization and publication when there is no live primary window. Closing the last window on macOS leaves the app-owned coordinator running but idle; recreating a window reuses it and receives the next scheduled result within five seconds. Quitting the application stops the interval, marks the coordinator disposed, and suppresses publication from any refresh that was already in flight. On Windows and Linux, closing the last window quits the application and therefore follows the quit path.

## Data flow

The background refresh follows one path for every connection mode.

1. The main-process coordinator ticks every 5,000 milliseconds.
2. It invokes the existing mode-aware session synchronization function.
3. Local mode synchronizes `state.db` into the desktop session cache; remote and SSH modes use their existing dashboard or fallback paths.
4. On success, the main process verifies that the captured connection/profile scope is still current.
5. The main process publishes the scoped refresh-generation notice to the renderer.
6. The sidebar reads its exact loaded window plus one sentinel row, preserving pagination and recomputing `hasMore`.
7. The Sessions modal reads its visible first page without showing a loading spinner.

## Concurrency and stale results

The process-wide session-sync gate allows at most one synchronization request at a time across coordinator ticks, initial loads, focus refreshes, and explicit IPC calls.

Multiple interval ticks and same-scope IPC requests join or collapse into the current work. A profile or connection change invalidates the captured scope and records one immediate pending run for the new scope; completion from the old scope is discarded before publication. When the current promise settles, the gate starts that one newer-scope run before accepting another interval tick.

Renderer consumers ignore notices after unmount, reject notices whose scope does not match their current profile/connection generation, and increment their request-generation guard before the exact-window read. An older initial, focus, or background read therefore cannot overwrite a newer result.

## Error handling

A failed background refresh leaves the existing UI and cache presentation intact.

The coordinator logs a concise diagnostic, clears its in-flight state, and retries on the next five-second tick. It does not surface a toast for transient background failures. Existing explicit loads and user-triggered actions keep their current error behavior.

## Testing

The implementation follows test-driven development.

- Coordinator unit tests use fake timers to prove the 5,000 ms cadence.
- A slow-refresh test proves interval, initial-load, and focus callers share one in-flight request and at most one follow-up is queued.
- Disposal tests prove intervals stop and late promises cannot publish.
- Scope tests prove a profile/connection switch discards an old in-flight result and immediately refreshes the new scope.
- IPC/preload tests prove the typed notice subscription and cleanup contract.
- Sidebar tests prove a notice reloads the currently loaded page window plus a sentinel row without truncating pagination.
- Sessions tests prove a notice reloads the first page while mounted and that the old renderer intervals are gone.
- Existing session, lint, typecheck, and full Vitest suites must remain green.

## Documentation

`lat.md/sidebar-navigation.md` will document the main-process five-second coordinator, both consumers, the single-flight rule, and the reason renderer throttling remains enabled.

## Packaging and live verification

The release must be built from `sebmarion/hermes-desktop` on `main`, producing `Hermes One.app` with package name `hermes-desktop` and executable `Hermes One`.

Before installation, the bundle identity, version, signature, and executable are read back. The current Hermes One bundle is retained as a rollback. Live verification observes coordinator-driven refreshes while the real Hermes One window is minimized and confirms the restored window displays externally created session changes without a focus-triggered wait.

## Rollback

Rollback restores the preserved Hermes One bundle and reverts the Hermes Desktop commit. No Hermes Agent checkout or user session database is reset or deleted.
