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
- Single-binary rewrite (Rust/Go is a later track)

## Tests

Please add or extend tests when you touch:

- `src/mapping.ts` — fixture-style path cases
- `src/risk.ts` — path classification and fail-on
- `src/evidence.ts` / schema — keep `schema/evidence.schema.json` in lockstep
- CLI flags — help text and exit codes

```bash
npm test
npm run build
```

## Schema changes

`schemaVersion` is `0.1.0`. Additive optional fields are fine. Breaking field or enum changes require a schema version bump and a CHANGELOG entry.

## Pull requests

1. Branch from `main`.
2. Keep the PR focused.
3. Update `CHANGELOG.md`.
4. CI must stay green (`npm run build`, `npm test`, `patchprove run --help`).
