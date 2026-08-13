# Test environment

Vitest uses jsdom for renderer and main-process suites, with shared compatibility setup applied before every test file.

[[src/renderer/src/test/setup.ts]] replaces Node 25's unusable process-level `localStorage` global with a deterministic in-memory `Storage` implementation. This keeps renderer tests isolated without requiring a Node `--localstorage-file`.

Integration tests that spawn real child processes allow scheduler headroom for loaded full-suite runs, while short poll intervals keep successful checks fast.
