# Changelog

All notable changes to this project are documented here.

## 1.1.0 — 2026-09-03

### Added

- **Java / Gradle / Maven affected-test filtering** — multi-module path → subproject; package path → Surefire/Gradle FQCN (`gradle :api:test --tests com.acme.api.RouterTest`, `mvn -pl api -am test -Dtest=…`). Prefers Gradle when both tools exist; naming fallback otherwise.
- **Go module-path + `internal/` resolution** — parse `go.mod`; resolve in-module imports; coarse `internal/` visibility. `go test` targets affected packages (`./pkg`, `./pkg/...`), not a whole-module blind run.
- **Rust workspace / multi-crate mapping** — `[workspace]` members → crate; `cargo test -p <pkg>` for affected crates. Single-crate repos still work.
- **External plugin loading** — v1.1 API documented in `docs/plugins.md`. Load local JS modules from `.patchprove.yml` `plugins:`, `PATCHPROVE_PLUGINS`, or `.patchprove/plugins/*`. Built-ins stay default; remote URLs rejected. Example: `examples/plugins/widget.mjs`.
- Golden fixtures + regression tests: `test/fixtures/java-multimodule/`, `go-internal/`, `rust-workspace/`, `test/fixtures/golden/language-mapping.json`.

### Changed

- Package / `toolVersion` **1.1.0**. Evidence `schemaVersion` stays **1.0.0** (no new evidence fields).
- Affected-test gate iterates loaded plugins (built-ins + explicit extras).

## 1.0.0 — 2026-09-02

### Added

- **Contract / SPEC** — primary `.patchprove/spec.yml` (or a `SPEC.md` yaml fence / link). Declares `requiredGates`, `maxResidualRisk`, `requiredMappedTests`, `forbiddenUnproven`, `acceptedResidualRisk.policy`. `patchprove run` records `evidence.contract` (pass/fail + clauses). A failed loaded contract exits `1`.
- **Import-graph test mapping** for JS/TS (relative `import` / `require` / `import()`, reverse map from tests, one-hop BFS) and Python import heuristics. `mappingStrategy` / per-source `via`: `naming` | `coverage` | `graph`, plus `mappingFallbacks`.
- **Language plugins** — Go, Rust, Java (plus existing JS/TS and Python): naming, optional graph, `go test` / `cargo test` / `mvn`/`gradle` detection. Documented in `docs/plugins.md`.
- **Baseline comparison** — `--baseline`, auto-load `.patchprove/baseline.json` or config `baseline:`. New open gaps are regressions. `patchprove baseline save`. `--fail-on-new-gaps high|critical`.
- **Host integration** — Claude Code `SessionStart` + `SubagentStop` examples; Cursor rule pack at `examples/cursor/`. `init-agent` installs Cursor files by default (`--no-cursor` to skip).
- **Docs site** under `docs/` (GitHub Pages) including a [case study](docs/case-study.md).
- **Experimental Go thin launcher** (`go/`, `make go-build`) that execs the Node CLI. See `docs/standalone.md`.

### Changed

- Package / `toolVersion` **1.0.0**. Evidence `schemaVersion` **1.0.0**.
- Affected-test gate dispatches through language plugins (still vitest/jest/pytest for JS/Python).

## 0.3.0 — 2026-09-02

### Added

- **MCP server** (stdio) via `@modelcontextprotocol/sdk`:
  - `prove_patch` — same pipeline as `patchprove run` (`cwd`, `base`/`head`, `failOn`, `accept`, `config`, …) and returns structured evidence plus a short human summary
  - `list_gaps` — open (non-accepted) gaps from a fresh run or from `evidencePath`
  - bins: `patchprove-mcp` and `patchprove mcp` (`node dist/mcp.js`)
- **`patchprove hook stop|post`** — prints Claude Code or Cursor hook JSON after a local CLI run. Agents must not claim done while open gaps remain.
- **`patchprove init-agent`** — idempotent install of `.claude/skills/patchprove/SKILL.md`, merge of hook snippets into `.claude/settings.json`, and optional `.mcp.json`. `--force` overwrites; `--dry-run` prints the plan.
- Examples: `examples/hooks/` (Claude Code + Cursor), `examples/mcp/` config snippets, `examples/skills/patchprove/` for [cc-kit](https://github.com/jecketyuan-ux/cc-kit) (`npx cc-kit skill add <git-url>#examples/skills/patchprove`).
- `formatShortSummary` for MCP / hook output.

### Changed

- Package / `toolVersion` **0.3.0**. Evidence `schemaVersion` stays **0.2.0** (no new evidence fields).

## 0.2.0 — 2026-09-02

### Added

- Config file `.patchprove.yml` / `.patchprove.yaml` at the repo root (`failOn`, `ignorePaths`, `gates`, `acceptGaps`). CLI flags override or extend config.
- Known-accepted gaps via `acceptGaps` or `--accept`. They stay in the evidence pack (`accepted`, `acceptedReason`) but do not raise summary risk or trip `--fail-on`.
- Coverage-first test mapping: `coverage/coverage-final.json` (Istanbul/V8 or a source→tests map) and Cobertura `coverage.xml`, with naming-heuristic fallback. Evidence records `impact.mappingStrategy` (`naming` | `coverage`).
- `--ignore`, `--disable-gate`, `--sarif`, `--config`, and `--fail-on none`.
- GitHub Action: clearer markdown (open vs accepted gaps), optional `upload-sarif` via `github/codeql-action/upload-sarif`.
- `summary.acceptedGapCount`; JSON Schema bumped to `0.2.0`.
- Pack-ready `0.2.0` (`files`, `bin`, `publishConfig`). See `PUBLISH.md`. CI runs `npm pack --dry-run`.
- `ROADMAP.md`.

### Changed

- Human and markdown reports show mapping strategy and an Accepted gaps section.
- `schemaVersion` / package version `0.2.0` (additive fields; consumers should accept the new version).

## 0.1.0 — 2026-09-02

### Added

- `patchprove run` CLI: analyze `git diff` (working tree vs HEAD) or a `--base` / `--head` range.
- Coarse impact mapping for TypeScript/JavaScript and Python via naming heuristics.
- Deterministic gates when tools exist in the target repo: typecheck, lint, affected tests, secret scan.
- High-risk path highlighting for lockfiles, `.github/workflows/**`, and auth/crypto-ish paths.
- Versioned `evidence.json` plus JSON Schema at `schema/evidence.schema.json`.
- `--fail-on high|critical` exit status.
- GitHub Action under `action/` that posts or updates a sticky PR comment.
- Unit and integration tests for schema shape, risk classification, and test mapping.
