# Hermes One and Hermes WebUI thread projection convergence

## Goal

Hermes One and Hermes WebUI must derive the same logical conversation identity,
title, and pin from Hermes Agent's canonical `state.db` rows. Presentation-only
rows owned by one surface may remain surface-specific, but they must not change
the identity of a shared conversation.

## Shared contract

- The primary sidebar list is parent-only. Rows classified as
  `relationship_type=child_session` are reference metadata, never independent
  top-level conversations, even when their parent is outside the loaded page.
- A compression lineage renders as one logical row. The normal deterministic
  continuation path remains preferred, but a zero-message terminal segment may
  not hide a newer message-bearing sibling in the same lineage.
- The visible logical row inherits a meaningful root title when the selected tip
  has only a generated placeholder such as `Untitled`, `Cli Session`, or
  `Continue the unfinished task from the parent`.
- A pin on any compression segment pins the logical conversation. Physical
  lineage segments and child/reference rows never create duplicate pinned rows.
- Projection does not rewrite identity, messages, archive state, or pins. A
  missing title may be filled once from the deterministic first-user fallback
  (or a legacy UI title) and propagated through its compression lineage so
  `state.db` becomes authoritative for both surfaces.

## Staging

Stage A fixes and tests the unambiguous shared-lineage rules above. A live
comparison then identifies the remaining surface-owned imports and diagnostic
rows. Stage B may change their presentation policy, but only from measured
remaining differences; it will not silently migrate or delete user data.

## Verification

Both products need unit regressions for parent-only rows, empty-terminal lineage
selection, placeholder-title fallback, and logical pins. After their repository
gates pass, rebuild/restart Hermes One and Hermes WebUI and compare active and
archived logical keys, titles, and pins from the live projections.
