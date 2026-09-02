---
title: Language plugins
---

# Language plugins

Built-in plugins live under `src/plugins/`. Each plugin declares:

- `id`, `languages`, `extensions`
- `isTestFile` / `testCandidates` (naming heuristics)
- optional `parseImports` / `resolveImport` / `packageTests` (graph mapping)
- optional `testCommand` (affected-test gate: `vitest`/`jest`, `pytest`, `go test`, `cargo test`, `mvn test` / `gradle test`)

| Plugin | Extensions | Tests | Gate |
| --- | --- | --- | --- |
| javascript | `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.mts` `.cts` | `*.test.*`, `*.spec.*`, `__tests__/` | vitest / jest |
| python | `.py` | `test_*.py`, `*_test.py` | pytest |
| go | `.go` | `*_test.go` (same package) | `go test ./pkg` |
| rust | `.rs` | `tests/**`, `*_test.rs` | `cargo test` |
| java | `.java` | `src/test/**`, `*Test.java` | `mvn test -Dtest=…` or `gradle test --tests` |

## Adding a plugin

1. Create `src/plugins/<id>.ts` exporting a `LanguagePlugin`.
2. Register it in `src/plugins/index.ts` `builtinPlugins`.
3. Add fixture tests (naming +, if useful, import parse/resolve).
4. Keep the implementation TypeScript — do not rewrite the CLI.

Detection of `go.mod`, `Cargo.toml`, `pom.xml`, and Gradle files is in `src/detect.ts`. Missing binaries become skipped checks / `tool-missing` gaps, not silent passes.
