---
title: Test mapping
---

# Test mapping

Deterministic. No LLM. Strategies, in order, per changed source:

1. **coverage** — `coverage/coverage-final.json` or Cobertura XML (explicit source→tests, else basename pairing)
2. **graph** — parse imports from tests, reverse-map to changed modules (JS/TS, Python heuristics, plus plugin graphs)
3. **naming** — `foo.ts` → `foo.test.ts` / `foo.spec.ts`; `foo.py` → `test_foo.py`; Go `foo.go` → `foo_test.go`; etc.

Evidence:

- `impact.mappingStrategy` — primary for the run (`coverage` if a coverage map loaded; else `graph` if the import graph had edges; else `naming`)
- `impact.mappingFallbacks` — other strategies that actually mapped a file
- `impact.mappedTests[].via` — `naming` \| `coverage` \| `graph` for that source

## Graph (JS/TS)

Light-weight: no bundler. The runner reads tracked files, parses `import` / `export from` / `require()` / `import()`, resolves relative specifiers (including `.js` → `.ts`), then BFS from test files. A changed source maps to every test that can reach it.

Python uses `from` / `import` path heuristics (`pkg.mod` → `pkg/mod.py`, relative dots, `src/` prefix).

Go adds same-package `*_test.go` neighbors even without an explicit import.
