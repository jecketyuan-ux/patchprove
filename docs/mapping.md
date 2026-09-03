---
title: Test mapping
---

# Test mapping

Deterministic. No LLM. Strategies, in order, per changed source:

1. **coverage** — `coverage/coverage-final.json` or Cobertura XML (explicit source→tests, else basename pairing)
2. **graph** — parse imports from tests, reverse-map to changed modules (JS/TS, Python heuristics, plus plugin graphs)
3. **naming** — `foo.ts` → `foo.test.ts` / `foo.spec.ts`; `foo.py` → `test_foo.py`; Go `foo.go` → `foo_test.go`; Java package-path `*Test.java`; Rust crate `tests/`.

Evidence:

- `impact.mappingStrategy` — primary for the run (`coverage` if a coverage map loaded; else `graph` if the import graph had edges; else `naming`)
- `impact.mappingFallbacks` — other strategies that actually mapped a file
- `impact.mappedTests[].via` — `naming` \| `coverage` \| `graph` for that source

## Graph (JS/TS)

Light-weight: no bundler. The runner reads tracked files, parses `import` / `export from` / `require()` / `import()`, resolves relative specifiers (including `.js` → `.ts`), then BFS from test files. A changed source maps to every test that can reach it.

Python uses `from` / `import` path heuristics (`pkg.mod` → `pkg/mod.py`, relative dots, `src/` prefix).

Go adds same-package `*_test.go` neighbors even without an explicit import. v1.1 also resolves `go.mod` module-path imports and applies coarse `internal/` visibility (only packages under the parent of the last `internal` segment can import it). Affected-test gating uses `go test ./pkg` or `./pkg/...`, not a whole-module blind run.

Java maps `*/src/main/java/<pkg>/<Name>.java` to the same module’s `src/test/java/<pkg>/<Name>Test.java` (also `Tests` / `IT`). Gradle projects from `settings.gradle*` become `:subproject:test --tests <FQCN>`. Maven multi-module `pom.xml` uses `-pl <module> -am -Dtest=<FQCN>`.

Rust workspaces (`[workspace]` in the root `Cargo.toml`) map files to crate packages and run `cargo test -p <pkg>`. A single-crate repo still works (`cargo test` or `cargo test -p <name>`).

Golden fixtures that lock this behavior: `test/fixtures/java-multimodule/`, `test/fixtures/go-internal/`, `test/fixtures/rust-workspace/`, compared in `test/golden.test.ts`.

## External Go / Java repo + `--fail-on high`

In a repo that is not this one:

```yaml
# .patchprove.yml
failOn: high
```

```bash
npx patchprove run --base origin/main --fail-on high
```

The fixtures above are the stand-in layouts. Exit `1` when residual risk is high (unmapped sources, auth/crypto paths, failed gates). See [plugins.md](plugins.md) for the exact gate commands.
