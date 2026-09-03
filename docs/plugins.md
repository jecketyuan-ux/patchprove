---
title: Language plugins
---

# Language plugins (v1.1 API)

patchprove maps changed sources to nearby tests through **language plugins**. Built-ins cover JS/TS, Python, Go, Rust, and Java. External plugins are optional, **local-only**, and never fetched from the network.

This is the stable-enough **v1.1 plugin API**. Additive optional fields may appear in later 1.x releases; required fields will not be renamed without a major bump.

## Built-ins

Built-in plugins live under `src/plugins/` and are always loaded.

Each plugin declares:

- `id`, `languages`, `extensions`
- `isTestFile` / `testCandidates` (naming heuristics; `testCandidates` may receive a `PluginContext`)
- optional `parseImports` / `resolveImport` / `resolveImportFiles` / `packageTests` (graph mapping)
- optional `testCommand` (affected-test gate)
- optional `missingTestRunnerReason`

| Plugin | Extensions | Tests | Gate (v1.1) |
| --- | --- | --- | --- |
| javascript | `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.mts` `.cts` | `*.test.*`, `*.spec.*`, `__tests__/` | vitest / jest |
| python | `.py` | `test_*.py`, `*_test.py` | pytest |
| go | `.go` | `*_test.go` (same + importing packages; `go.mod` + `internal/` visibility) | `go test ./pkg` or `./pkg/...` |
| rust | `.rs` | crate `tests/**`, `*_test.rs` | `cargo test -p <crate>` (workspace or single crate) |
| java | `.java` | `src/test/**`, `*Test.java` (module + package path) | `gradle :mod:test --tests FQCN` or `mvn -pl … -Dtest=FQCN` |

Detection of `go.mod`, `Cargo.toml`, `pom.xml`, and Gradle files is in `src/detect.ts`. Missing binaries become skipped checks / `tool-missing` gaps, not silent passes.

### Language mapping (v1.1)

- **Java / Gradle** — when `settings.gradle` / `settings.gradle.kts` / `build.gradle*` exist, changed `*/src/main/java/…` files map to the same-module `src/test/java` class (`FooTest`, `FooTests`, `FooIT`, …). Gate prefers `gradle test --tests <FQCN>` or `:subproject:test --tests <FQCN>`. Maven uses Surefire `-Dtest=<FQCN>` and `-pl <module> -am` for multi-module `pom.xml`. Naming-only fallback if no build files.
- **Go** — `go.mod` `module` path resolves in-repo imports. `internal/` is visible only under the parent of the last `internal` segment. `go test` targets affected packages (`./pkg`, `./pkg/...`), not a blind whole-module run.
- **Rust** — `[workspace]` members map files to crates; `cargo test -p <pkg>` for affected crates. A root `[package]` (no workspace) is a single crate.

## Interface

A plugin is a JS object (TypeScript `LanguagePlugin` in `src/plugins/types.ts`):

```js
export default {
  id: "example-widget",          // unique; must not collide with built-ins
  languages: ["other"],          // javascript | typescript | python | go | rust | java | other
  extensions: [".widget"],       // including the leading dot
  isTestFile(rel) { /* boolean */ },
  testCandidates(rel, ctx) {     // repo-relative candidate test paths
    return [`${rel.replace(/\.widget$/, "")}_test.widget`];
  },
  // optional:
  parseImports(sourceText, rel) { return []; },
  resolveImport(fromFile, specifier, existing, ctx) { return null; },
  resolveImportFiles(fromFile, specifier, existing, ctx) { return []; },
  packageTests(rel, existing, ctx) { return []; },
  testCommand(cwd, mappedTests, tools, ctx) { return null; },
  missingTestRunnerReason(tools) { return null; },
};
```

`PluginContext` (`ctx`) is `{ cwd, existing, readFile? }`. Use it to read `go.mod`, `Cargo.toml`, or Gradle/Maven files. Tests inject `readFile`.

Export either `export default plugin` or `export const plugin = { … }`. ESM (`.mjs` / `.js` in an ESM package) and CJS (`.cjs`) are accepted.

## Loading external plugins

Built-ins are the default. Extras load only from **explicit local** sources, in this order (same `id` → later wins; built-in ids cannot be replaced):

1. `.patchprove/plugins/*.{js,mjs,cjs}` (sorted by filename)
2. `PATCHPROVE_PLUGINS` — comma / `:` / `;` separated local paths (or directories of JS modules)
3. `.patchprove.yml` `plugins:` list (paths relative to the repo root, or absolute)

```yaml
# .patchprove.yml
plugins:
  - examples/plugins/widget.mjs
```

```bash
PATCHPROVE_PLUGINS=./examples/plugins/widget.mjs npx patchprove run
```

`https://`, `http://`, `data:`, and `ftp:` specs are **rejected**. There is no plugin registry and no install-from-URL.

A one-file example that proves the load path: [`examples/plugins/widget.mjs`](https://github.com/jecketyuan-ux/patchprove/blob/main/examples/plugins/widget.mjs).

## Adding a built-in

1. Create `src/plugins/<id>.ts` exporting a `LanguagePlugin`.
2. Register it in `src/plugins/builtin.ts` `builtinPlugins`.
3. Add fixture tests (naming +, if useful, import parse/resolve + gate args).
4. Keep the implementation TypeScript — do not rewrite the CLI.

## Wiring `--fail-on high` on an external Go or Java repo

patchprove is not CI. In another repo you still run it as a **gap gate** on the diff:

```yaml
# .patchprove.yml  (copy next to go.mod or the Gradle/Maven root)
failOn: high
gates:
  tests: true
  secrets: true
```

```bash
npx patchprove@1.2.0 run --fail-on high
npx patchprove@1.2.0 run --base origin/main --head HEAD --fail-on high --out evidence.json
```

What you get:

| Repo | Impact | Gate when the binary exists |
| --- | --- | --- |
| Go (`go.mod`) | Changed packages → same-package `*_test.go` + tests that import the module path (`internal/` rules apply) | `go test ./internal/auth ./pkg/api` (or `./pkg/...` when a parent + child are both affected) |
| Java (Gradle) | `module/src/main/java/…/Foo.java` → `module/src/test/java/…/FooTest.java` | `gradle :module:test --tests com.acme.FooTest` |
| Java (Maven) | Same package-path mapping | `mvn -pl module -am test -Dtest=com.acme.FooTest` |

Stand-in layouts used by this repo’s golden tests (same shapes as a real external checkout):

- `test/fixtures/go-internal/` — module `example.com/shop` + `internal/` + `pkg/api`
- `test/fixtures/java-multimodule/` — Gradle `include("api", "core")` and a parent `pom.xml`

Auth/crypto path names (e.g. `internal/auth/…`) still raise **high** residual risk even when tests map. That is why `--fail-on high` is a useful merge/agent gate: mapped tests are recorded; high-risk paths and unmapped sources still fail the process unless you `acceptGaps`.
