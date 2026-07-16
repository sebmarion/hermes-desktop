# Thread projection convergence implementation plan

1. Add failing Hermes One tests for parent-only sidebar rows and a compression
   chain whose preferred path ends empty while a newer sibling has messages.
2. Make Hermes One choose the visible sibling only when the preferred terminal
   is empty, preserve meaningful root titles, and suppress child/reference rows
   from the top-level sidebar.
3. Add a failing Hermes WebUI regression proving canonical `state.db` titles
   replace cross-surface placeholder titles, then minimally broaden placeholder
   recognition.
4. Run focused tests, full relevant repository gates, TypeScript checks, and
   LAT/GitNexus structural checks where available.
5. Build and restart `/Applications/Hermes One.app` from
   `/Users/seb/hermes-one-src`, restart the launchd-managed Hermes WebUI, and
   repeat the live logical-thread and pin comparison.
