# Changelog

## 0.1.0 — 2026-07-13

First published version: the StoaChain edge for `@ancientpantheon/khronoton-core`.

- **`createStoachainRuntime(config?) → Promise<ChainRuntime>`** — wraps the
  `@stoachain/*` stack once and returns the core `ChainRuntime` seam (dirty-read,
  submit, listen, gas + constants), so a host injects one object into the core
  automaton instead of reaching for `@stoachain/*` directly.
- Loads the five `@stoachain/*` modules (`kadena-stoic-legacy` client, `stoa-core`
  signing + gas, `stoa-core`/`ouronet-core` constants) with **sequential
  `await import()`**, not `Promise.all` — concurrent dynamic import of these ESM
  modules crashes on Node 24 (`ERR_INTERNAL_ASSERTION`) because they `require()`
  each other while still loading. An optional `nodeBaseUrl` routes `getPactUrl`.
- `@stoachain/*` are **peer dependencies** (`^4.3.6`) so the host owns the chain
  stack and its version; `@ancientpantheon/khronoton-core` is a direct dependency.
- Dual-condition `.` export (ESM `import` + CJS `require`), tsup ESM build.
- 10 tests: 8 over mocked seams plus 2 real-runtime integration tests that build
  the factory against the actual `@stoachain/*` packages (the guard that keeps the
  published factory runnable, not just mock-green).
