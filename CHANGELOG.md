# Changelog

All notable changes to this project are documented here.

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
