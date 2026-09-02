# Changelog

All notable changes to this project are documented here.

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
