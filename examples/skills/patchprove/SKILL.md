---
name: patchprove
description: Run model-free patch evidence (impact → checks → gaps → risk) before claiming a change is done. Use when finishing a patch, before saying done, after edits that need verification, or when the user asks to prove residual gaps. Not a CI replacement and not an LLM review.
license: MIT
compatibility: Designed for Claude Code, Cursor, and similar agents. Requires git and Node 20+. Works via `patchprove` CLI or MCP tools prove_patch / list_gaps.
---

# patchprove

patchprove is an **evidence pack + gap driver**: impact → checks → gaps → risk. It is model-free. It does not approve a change.

## When to use

- Before claiming a task is done
- After a non-trivial edit, especially auth/crypto, workflows, lockfiles, or untested sources
- When the user asks to verify, prove, or list remaining gaps
- When a Stop / stop hook surfaces open gaps

Do **not** treat a green typecheck or a confident PR description as proof.

## Hard rule

**Do not claim done while open (non-accepted) gaps remain.**

Accepted gaps (`accepted: true`) stay in the pack for audit. They do not raise summary risk or trip `--fail-on`. Everything else in `gaps[]` is still unproven.

## How to run

Prefer the CLI (deterministic, local):

```bash
npx patchprove run --fail-on high
npx patchprove run --base origin/main --head HEAD --fail-on high --out evidence.json
```

Or MCP tools (same pipeline as `patchprove run`):

- `prove_patch` — `{ cwd?, base?, head?, failOn?, accept?, config?, out? }` → structured evidence + short summary
- `list_gaps` — same args, or `{ evidencePath }` to read an existing `evidence.json`

If MCP is not configured, use the CLI. Do not invent evidence.

## How to read the result

1. **Impact** — what moved; which tests mapped (`naming`, `coverage`, or `graph`)
2. **Checks** — typecheck / lint / affected tests / secrets: passed, failed, or skipped
3. **Gaps** — unmapped sources, missing tools, unsupported languages
4. **Risk** — max of findings + **open** gaps (`none` … `critical`)

If the repo has `SPEC.md` or `.patchprove/spec.yml`, contract failures mean the patch is not done. If a baseline exists, new gaps are regressions — do not claim done. A receipt (`evidence.receipt.json`) hashes the pack so the same diff verifies as the same `contentHash`; run `patchprove receipt verify evidence.json` when you need to re-check.

If `list_gaps.claimDone` is false or `summary.gapCount > 0`, keep working or get an explicit human accept (`--accept` / `acceptGaps` in `.patchprove.yml`).

## Do not

- Do not replace CI with this pack
- Do not ask another model to “LGTM” the diff instead of running patchprove
- Do not hide skipped gates
- Do not mark accepted gaps as closed
