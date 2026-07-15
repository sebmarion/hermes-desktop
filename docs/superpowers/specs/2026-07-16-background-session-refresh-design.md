# Background Session Refresh

Hermes One should keep its session surfaces current every five seconds while the primary app window remains open, including when the window is unfocused, occluded, or minimized.

## Problem

The recent-session sidebar currently refreshes every 60 seconds, while the full Sessions modal refreshes every 30 seconds. Both schedules live in the renderer and can be delayed when Chromium throttles a background or minimized window.

The existing focus listeners reduce staleness after the user returns, but they do not keep the open app synchronized in the background. Setting `backgroundThrottling: false` would keep the session timers accurate, but it would also keep unrelated renderer work such as animation and Office rendering active while hidden.

## Goals

The change must provide predictable background synchronization without globally disabling Electron's renderer throttling.

- Refresh the session cache on a five-second cadence while the main window exists.
- Update both the recent-session sidebar and the full Sessions modal from the same result.
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

The coordinator owns the interval, one in-flight refresh promise, a pending-tick flag, and disposal state. A tick starts a refresh only when the prior refresh has completed. If another tick arrives during an in-flight refresh, the coordinator records one pending run instead of starting concurrent work.

The existing `sync-session-cache` IPC handler's local/remote/SSH routing becomes a reusable function. Both the IPC handler and the coordinator call that function, keeping one canonical routing path.

After a successful refresh, the coordinator sends a `session-cache-refreshed` event containing the normalized cached-session rows to the primary window. The preload bridge exposes a typed subscription with an unsubscribe function.

The sidebar and Sessions modal subscribe to this event and apply the rows through their existing comparison and stale-request guards. Their initial load and focus listeners remain, while their independent 60-second and 30-second renderer intervals are removed.

## Lifecycle

The app lifecycle starts the coordinator after Electron is ready and the primary window has been created.

Ticks skip publication when there is no live primary window. Closing or quitting the app stops the interval, marks the coordinator disposed, and suppresses publication from any refresh that was already in flight. Recreating a macOS window reuses the running coordinator and receives the next scheduled result within five seconds.

## Data flow

The background refresh follows one path for every connection mode.

1. The main-process coordinator ticks every 5,000 milliseconds.
2. It invokes the existing mode-aware session synchronization function.
3. Local mode synchronizes `state.db` into the desktop session cache; remote and SSH modes use their existing dashboard or fallback paths.
4. On success, the main process publishes the rows to the renderer.
5. The sidebar updates its currently loaded window without discarding pagination state.
6. The Sessions modal updates its visible first page without showing a loading spinner.

## Concurrency and stale results

The coordinator allows at most one synchronization request at a time.

Multiple interval ticks collapse into one pending follow-up. Renderer consumers ignore results after unmount and retain their existing request-generation checks so an older initial or focus refresh cannot overwrite a newer coordinator result.

## Error handling

A failed background refresh leaves the existing UI and cache presentation intact.

The coordinator logs a concise diagnostic, clears its in-flight state, and retries on the next five-second tick. It does not surface a toast for transient background failures. Existing explicit loads and user-triggered actions keep their current error behavior.

## Testing

The implementation follows test-driven development.

- Coordinator unit tests use fake timers to prove the 5,000 ms cadence.
- A slow-refresh test proves ticks never create overlapping requests and at most one follow-up is queued.
- Disposal tests prove intervals stop and late promises cannot publish.
- IPC/preload tests prove the typed event subscription and cleanup contract.
- Sidebar and Sessions tests prove pushed rows are applied while their surfaces are mounted and that the old renderer intervals are gone.
- Existing session, lint, typecheck, and full Vitest suites must remain green.

## Documentation

`lat.md/sidebar-navigation.md` will document the main-process five-second coordinator, both consumers, the single-flight rule, and the reason renderer throttling remains enabled.

## Packaging and live verification

The release must be built from `sebmarion/hermes-desktop` on `main`, producing `Hermes One.app` with package name `hermes-desktop` and executable `Hermes One`.

Before installation, the bundle identity, version, signature, and executable are read back. The current Hermes One bundle is retained as a rollback. Live verification observes coordinator-driven refreshes while the real Hermes One window is minimized and confirms the restored window displays externally created session changes without a focus-triggered wait.

## Rollback

Rollback restores the preserved Hermes One bundle and reverts the Hermes Desktop commit. No Hermes Agent checkout or user session database is reset or deleted.
