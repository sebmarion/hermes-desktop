# Sol Ultra Request Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes One's GPT-5.6 Sol `Ultra` option execute a real, request-scoped Codex app-server Ultra turn without silently degrading to `max`, raw Responses, TUI, or CLI.

**Architecture:** Hermes Agent owns the execution contract: `/v1/runs` validates `reasoning_effort`, applies it only to the new run, and treats `ultra` as a Sol-only request that forces `codex_app_server` and disables provider fallback. Hermes One discovers this behavior through `/v1/capabilities`, sends the literal `ultra`, and fails closed whenever that exact transport is unavailable.

**Tech Stack:** Python 3.11+, aiohttp, pytest, TypeScript, Electron, React, Vitest, LAT, GitNexus.

---

### Task 1: Agent request-scoped reasoning contract

**Files:**

- Modify: `/Users/seb/.hermes/hermes-agent/gateway/platforms/api_server.py`
- Test: `/Users/seb/.hermes/hermes-agent/tests/gateway/test_api_server.py`
- Test: `/Users/seb/.hermes/hermes-agent/tests/gateway/test_api_server_runs.py`

- [x] Add failing tests proving `/v1/capabilities` advertises request-scoped Sol Ultra.
- [x] Add failing tests proving `/v1/runs` rejects invalid effort values and non-Sol Ultra before allocating a run.
- [x] Add a failing construction test proving Ultra creates a Sol agent with `reasoning_config.effort=ultra`, `api_mode=codex_app_server`, and `fallback_model=None`.
- [x] Run `scripts/run_tests.sh tests/gateway/test_api_server.py tests/gateway/test_api_server_runs.py -q` and confirm the new tests fail for the missing contract.
- [x] Implement validation, request propagation, capability metadata, and a non-secret Ultra activation log.
- [x] Re-run the two Agent test files and confirm they pass.

### Task 2: Hermes One stores and displays literal Ultra

**Files:**

- Modify: `/Users/seb/hermes-desktop/src/renderer/src/screens/Chat/hooks/useReasoningEffort.ts`
- Modify: `/Users/seb/hermes-desktop/src/renderer/src/screens/Chat/ReasoningEffortPicker.tsx`
- Test: `/Users/seb/hermes-desktop/src/renderer/src/screens/Chat/hooks/useReasoningEffort.test.ts`
- Test: `/Users/seb/hermes-desktop/src/renderer/src/screens/Chat/ReasoningEffortPicker.test.tsx`

- [x] Change the Sol-only option value from `max` to `ultra` while keeping the user-facing `Ultra` label.
- [x] Add failing normalization and picker tests for literal `ultra`; assert stale `max` no longer masquerades as Ultra.
- [x] Run the focused Vitest files and confirm the red state.
- [x] Implement the minimal type, normalization, and option changes.
- [x] Re-run the focused Vitest files and confirm green.

### Task 3: Capability-gated fail-closed transport

**Files:**

- Modify: `/Users/seb/hermes-desktop/src/main/run-stream.ts`
- Modify: `/Users/seb/hermes-desktop/src/main/hermes.ts`
- Test: `/Users/seb/hermes-desktop/src/main/run-stream.test.ts`
- Test: `/Users/seb/hermes-desktop/src/main/hermes.test.ts`

- [x] Add failing pure tests for the Sol Ultra capability predicate and literal Ultra request payload.
- [x] Add failing transport tests proving missing capabilities and run failures do not fall back to legacy chat or CLI.
- [x] Run the focused Vitest files and confirm the intended failures.
- [x] Add a capability predicate, literal request body, TUI bypass, legacy-fallback suppression, and unavailable-API failure path.
- [x] Re-run focused tests and `npm run typecheck`.

### Task 4: Documentation and repository verification

**Files:**

- Modify: `/Users/seb/hermes-desktop/lat.md/model-selection.md`

- [x] Replace the old `Ultra == max` LAT statement with the request-scoped app-server contract and fail-closed invariant.
- [x] Run `lat check`.
- [x] Run GitNexus `detect-changes` in both repositories and review affected symbols/flows.
- [x] Run focused Agent tests, focused Hermes One tests, desktop typecheck, scoped lint, and the proportional full suites.
- [ ] Commit and push both canonical `main` branches.

### Task 5: Package and live acceptance

**Files:**

- Build output: `/Users/seb/hermes-desktop/dist/`
- Deployment target: `/Applications/Hermes One.app`

- [ ] Record installed bundle id, version, executable, signature, and source identity before replacement.
- [ ] Build the macOS app from the verified Hermes One tree.
- [ ] Replace only `/Applications/Hermes One.app`, preserving all `~/.hermes` and app-support state.
- [ ] Re-read bundle identity/signature/hash and restart Hermes One plus the profile gateway.
- [ ] Verify `/v1/capabilities` advertises Sol Ultra.
- [ ] Submit a Sol Ultra `/v1/runs` request and prove from status/logs that effort is `ultra`, runtime is `codex_app_server`, provider fallback is disabled, and multi-agent is enabled.
