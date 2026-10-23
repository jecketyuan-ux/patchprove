---
title: Language plugins
---

# Language plugins and support levels

Built-ins implement selection and commands for JS/TS, Python, Go, Rust, and Java. A language appearing in this table does not mean every build system, platform, or compiler semantic has been validated. Actual native runner results and environmental skips are in [validation](validation.md).

| Plugin | Selection | Test command family | Current boundary |
| --- | --- | --- | --- |
| JS/TS | Test/spec extensions including mts/cts, naming, import graph, supported alias/workspace patterns | Vitest / Jest | Static parsing cannot resolve arbitrary runtime module behavior |
| Python | Naming and import-path heuristics | pytest | Dynamic imports and environment-dependent resolution |
| Go | Module-path imports, same-package tests, coarse internal visibility | affected-package go test | go.work/multiple modules, build tags, cgo, generated code |
| Rust | Package/workspace units, integration tests, inline unit tests | cargo test, scoped by package where appropriate | Macros, build scripts, target/feature semantics |
| Java | Same-module package-path Test/Tests/IT naming | Gradle --tests FQCN or Maven -Dtest=FQCN | Naming/build-file parsing rather than full dependency compilation |

Typecheck/lint commands are independent units: tsc and configured pyright/mypy, ESLint and Ruff. Missing configured executables are not silent successes. Execution records retain each attempted scope; partial language execution makes the aggregate incomplete. A required contract gate still applies when an optional configuration gate is disabled.

## Local plugin API

The existing v1.1-style `LanguagePlugin` interface remains available: `id`, `languages`, `extensions`, `isTestFile`, and `testCandidates` are required. Optional methods include import parsing/resolution, `packageTests`, `detect`, `testCommand`, and `missingTestRunnerReason`. `PluginContext` supplies `cwd`, the file set, and optional `readFile`. See [the interface](../src/plugins/types.ts) and [widget example](../examples/plugins/widget.mjs).

```js
export default {
  id: "example-widget",
  languages: ["other"],
  extensions: [".widget"],
  isTestFile(rel) { return rel.endsWith("_test.widget"); },
  testCandidates(rel) { return [rel.replace(/\.widget$/, "_test.widget")]; },
};
```

Modules may default-export the object or export `plugin`; supported local JS/ESM/CJS files are loaded. Extra plugin IDs cannot replace built-ins. Config paths, `PATCHPROVE_PLUGINS`, and `.patchprove/plugins/` discovery follow the documented resolver order (directory, environment, configuration; later matching external IDs win). Remote URL specs are rejected; no registry or download mechanism is provided.

Protocol 2 requires explicit local-plugin permission (`--allow-plugins`). Locality is not safety: importing a plugin runs repository-controlled JavaScript with caller privileges. Inspect/authorize plugins and run untrusted repositories in an appropriate external sandbox. Execution-tree isolation and environment-variable filtering do not contain filesystem/network access or arbitrary plugin code. Protocol 1 preserves compatibility discovery behavior.

```yaml
plugins:
  - examples/plugins/widget.mjs
```

```sh
patchprove run --allow-plugins
```

Impact and contracts consume the same classified source results, so an external extension cannot bypass a required mapped-test clause merely because built-ins do not recognize it. Coverage/graph/naming relationships remain selection evidence rather than branch/assertion proof.

Accepting a gap never removes findings. An auth/crypto path finding can keep residual risk high even when its tests execute and all mapping gaps are accepted. Use a considered risk/contract policy rather than assuming `acceptGaps` overrides findings.

New plugins should declare `capabilities: { contractVersion: 1, testedRunners: ["runner@version"], granularity: "file", reportFormats: ["vitest-json"], unknownResult: "incomplete" }`. A `testCommand` may supply `reportFormat` for the supported fresh-report interfaces (`vitest-json`, `jest-json`, `pytest-junit`). An unsupported/missing report adapter keeps execution unproven even if console output or exit zero looks successful. This contract does not grant local-plugin trust or OS isolation.

Windows Gradle 8.12.1 with JDK 17 is tested on non-ASCII paths with `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`. The default ANSI worker environment produced `ClassNotFoundException` before executing test cases; it is a known unsupported combination for that path. This is an explicit test/deployment setting, not an automatic override of project encodings. Evidence records the recognized declared encoding without capturing other JVM options. The harness retains infrastructure XML separately and never counts it as a user-test failure.
