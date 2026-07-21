# GPT-5.6 Sol Ultra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Hermes One select the GPT-5.6 Sol `max` reasoning level through an `Ultra` chat option.

**Architecture:** Keep the existing persisted `agent.reasoning_effort` setting and request serialization. Add `max` to the shared effort type/parser, make the picker receive the active model and append a Sol-only option, and preserve the existing request path. A stale stored `max` value is normalized to `auto` when the active model is not Sol.

**Tech Stack:** Electron main process, React/TypeScript renderer, Vitest, lat.md.

---

### Task 1: Add the failing reasoning-level tests

**Files:**
- Test: `src/renderer/src/screens/Chat/hooks/useReasoningEffort.test.ts`
- Test: `src/renderer/src/screens/Chat/ReasoningEffortPicker.test.tsx`

- [ ] **Step 1: Add normalizer coverage** for accepting `max` and rejecting unknown values.
- [ ] **Step 2: Add picker coverage** proving GPT-5.6 Sol exposes an `Ultra` option and another model does not.
- [ ] **Step 3: Run the focused tests** and verify they fail because `max` and the model-aware option do not exist yet.

### Task 2: Implement model-aware Ultra support

**Files:**
- Modify: `src/renderer/src/screens/Chat/hooks/useReasoningEffort.ts`
- Modify: `src/renderer/src/screens/Chat/ReasoningEffortPicker.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/main/hermes.ts`
- Modify: `src/shared/i18n/locales/en/chat.ts`

- [ ] **Step 1:** Add `max` to `ReasoningEffort` and `normalizeReasoningEffort`.
- [ ] **Step 2:** Add a narrow GPT-5.6 Sol model predicate accepting `gpt-5.6-sol` and `gpt-5.6` aliases.
- [ ] **Step 3:** Pass the active model into the picker and append a localized `Ultra` option only for Sol.
- [ ] **Step 4:** Extend main-process config normalization so `max` reaches both legacy API and runs request bodies unchanged.
- [ ] **Step 5:** Normalize a stale `max` selection to `auto` when the active model is not Sol, avoiding unsupported requests.
- [ ] **Step 6:** Run focused tests and confirm green.

### Task 3: Verify and document the completed behavior

- [ ] **Step 1:** Run `npm run typecheck` and `npm run lint`.
- [ ] **Step 2:** Run `git diff --check` and `lat check`.
- [ ] **Step 3:** Run GitNexus `detect_changes` if the index accepts the changed tree; otherwise record the same database-version blocker.
- [ ] **Step 4:** Update the relevant `lat.md` chat/model-selection section with the Sol-only `max` contract.
