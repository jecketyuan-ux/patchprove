# Contributing

Thanks for helping make agent patches more honest before merge.

## Requirements

- Node.js 20 or 22
- git

## Setup

```bash
git clone https://github.com/jecketyuan-ux/patchprove.git
cd patchprove
npm install
npm run build
npm test
node dist/cli.js run --help
```

## What belongs in v0.x

patchprove is an **evidence pack + gap driver**, not a coding agent and not an LLM reviewer.

Good changes:

- Sharper mapping heuristics (still deterministic)
- Better tool detection / gate commands
- Schema-compatible evidence fields
- Action comment quality

Out of scope unless discussed first:

- LLM-as-primary review
- Telemetry
- Vendor API coupling
- Single-binary rewrite as the default (the Go launcher is experimental and still execs Node)

## Tests

Please add or extend tests when you touch:

- `src/mapping.ts` — fixture-style path cases
- `src/risk.ts` — path classification and fail-on
- `src/evidence.ts` / schema — keep `schema/evidence.schema.json` in lockstep
- CLI flags — help text and exit codes
- `src/config.ts` — `.patchprove.yml` load + CLI override
- `src/coverage.ts` — coverage map parse + naming fallback
- `src/accept.ts` — accepted gaps must not raise summary risk
- `src/mcp-tools.ts` — `prove_patch` / `list_gaps` handlers (fixtures; no live MCP client)
- `src/init-agent.ts` — temp-dir writes, idempotent merge, `--force` / `--dry-run`
- `src/spec.ts` — contract parse + evaluation fixtures
- `src/graph.ts` — import reverse-map
- `src/plugins/` — language plugins
- `src/baseline.ts` — regression vs saved evidence
- `src/receipt.ts` — canonical hash, verify, optional HMAC/ed25519
- `src/sarif.ts` — findings, gaps, and failed contract clauses

```bash
npm test
npm run build
```

## Schema changes

Evidence `schemaVersion` is `1.2.0` (1.x is additive; see [docs/schema.md](docs/schema.md)). Breaking field or enum changes require a **major** schema version bump and a CHANGELOG entry. Keep `schema/evidence.schema.json` in lockstep with `src/types.ts`. Fixture JSON that looks like an evidence pack must validate against the published schema (`test/schema-fixtures.test.ts`). Package / `toolVersion` is `1.2.0`.

## Pull requests

1. Branch from `main`.
2. Keep the PR focused.
3. Update `CHANGELOG.md`.
4. CI must stay green (`npm run build`, `npm test`, `patchprove run --help`, `patchprove init-agent --help`).
