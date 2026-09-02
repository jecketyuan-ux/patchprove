# patchprove

**Evidence pack for AI/agent patches: impact → checks → gaps → risk.**

Model-free verification so humans and agents know what’s still unproven before merge.

> This is an **evidence pack + gap driver for agent/PR patches**, not a CI replacement.
> It does not “approve” a change. It records what ran, what was skipped, and what is still a gap — then ranks residual risk.

## Why this exists

Agents (and tired humans) ship patches that *look* complete: types pass on the author’s machine, a happy-path test is green, the PR description is confident. Reviewers still cannot answer:

1. **Impact** — what actually moved, and which tests are *near* it?
2. **Checks** — which deterministic gates ran vs skipped because the repo has no `tsc` / `eslint` / `pytest`?
3. **Gaps** — which changed sources have no mapped test at all?
4. **Risk** — did this touch lockfiles, workflows, auth/crypto paths, or look like a leaked key?

patchprove writes that as a terminal report plus a versioned `evidence.json`. Agents can read the JSON. Humans can read the comment.

## Why not “just CI”?

CI is the merge contract for *your* repo: the jobs you already pay to run on every PR. patchprove is not that.

| | CI | patchprove |
| --- | --- | --- |
| Job | Pass/fail the pipeline you configured | Show what is still **unproven** on *this* diff |
| Scope | Whole suite, whole build, deploy gates | Affected files + mapped tests + high-risk paths |
| Skip | Hidden in a grey check or a missing job | First-class **gap** with a risk level |
| Audience | Merge queue | Human reviewer **and** the agent that just patched |
| Model | None | None (v0.1 has no LLM path) |

**AI-on-AI reviewers** (another model summarizing or “approving” the diff) add a second opinion in the same uncertain medium. patchprove stays on the other axis: *what did a deterministic tool actually run, and what did it never see?* Use it beside CI and beside a human/LLM review — not instead of them.

A later single-binary (Rust/Go) may ship for air-gapped hosts. v0.1 is TypeScript + Node ESM so it can land now.

## Install

```bash
# one-shot
npx patchprove run --help

# global
npm install -g patchprove
patchprove run

# from this repo
npm install
npm run build
node dist/cli.js run --help
```

Requires Node 20+.

## Quickstart

```bash
# working tree vs HEAD (staged + unstaged + untracked)
patchprove run

# PR range
patchprove run --base origin/main --head HEAD

# machine-readable only
patchprove run --json --out evidence.json

# fail a script or CI job when residual risk is high or worse
patchprove run --fail-on high
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Repo to analyze |
| `--json` | Print evidence JSON to stdout |
| `--format human\|json\|markdown` | Stdout format (markdown is what the Action posts) |
| `--out <file>` | Write `evidence.json` (default `evidence.json`) |
| `--fail-on high\|critical` | Exit `1` when summary risk meets the threshold |
| `--base <ref>` / `--head <ref>` | Analyze `base...head` instead of the working tree |

Exit codes: `0` ok (or below threshold), `1` fail-on met, `2` usage/runtime error.

## What it does (v0.1)

1. **Detect changed files** via `git diff` (working tree vs `HEAD`, or `--base`/`--head`).
2. **Map nearby tests** (coarse, naming only):
   - `foo.ts` → `foo.test.ts` / `foo.spec.ts` / `__tests__/foo.ts` / `tests/foo.test.ts`
   - `foo.py` → `test_foo.py` / `foo_test.py` / `tests/test_foo.py`
3. **Run gates when the target repo actually has the tools** (detected from `package.json`, lockfiles, `tsconfig`, `pyproject.toml`, config files, local `node_modules/.bin`):
   - typecheck: `tsc --noEmit`, or `pyright` / `mypy` if configured
   - lint: `eslint` or `ruff`
   - affected tests: `vitest` / `jest` / `pytest` on the mapped subset — if nothing maps, that is a **gap**, not a silent skip
   - secret scan: `gitleaks` if installed, otherwise regex for known key patterns + high-entropy tokens on **added** lines
4. **Highlight high-risk paths**: lockfiles, `.github/workflows/**`, auth/crypto-ish names (`auth`, `jwt`, `oauth`, `crypto`, `secret`, `session`, …).
5. **Write** a human report and `evidence.json` (`schemaVersion: "0.1.0"`).

No telemetry. No Anthropic/OpenAI account. Not a coding agent, skills pack, MCP memory, or API proxy.

## Sample: almost-right agent patch

An agent “fixes login lockout.” Types are clean. Lint is clean. It even updates `src/auth/session.test.ts` for the TTL constant. The PR reads as done.

What patchprove sees:

```
patchprove  v0.1.0  ·  impact → checks → gaps → risk
model-free evidence pack  ·  not a CI replacement

range     working tree vs HEAD
files     3 changed  ·  typescript
risk      HIGH

IMPACT
  .github/workflows/ci.yml  ⚠ workflow → no mapped test
  src/auth/session.ts  ⚠ auth-crypto → src/auth/session.test.ts
  src/utils/hash.ts → no mapped test

CHECKS
  · typecheck                  skipped
      No typechecker configured (tsc / pyright / mypy)
  · lint                       skipped
      No linter configured (eslint / ruff)
  · affected tests             skipped
      No test runner configured (vitest / jest / pytest)
  ✓ secret scan (regex)        passed

GAPS
  • No nearby test mapped for src/utils/hash.ts  [medium]

FINDINGS
  • High-risk path (auth-crypto): src/auth/session.ts  [high]
  • High-risk path (workflow): .github/workflows/ci.yml  [high]

SUMMARY  HIGH   1 passed · 0 failed · 3 skipped · 1 gaps · 2 findings
```

The lockout branch in `session.ts` never got a test. `hash.ts` moved with the patch and has **no** mapped test. CI workflow bits changed. Checks that did not run are visible instead of implied-green.

That is the product: **almost-right is not proven.** Merge when a human accepts the residual gaps — not because another model said “LGTM.”

## Evidence schema

JSON Schema: [`schema/evidence.schema.json`](schema/evidence.schema.json)

Top-level shape:

- `schemaVersion` — `0.1.0`
- `impact` — changed files, mapped tests, unmapped sources, languages
- `checks[]` — `typecheck` | `lint` | `tests` | `secrets` with `passed` / `failed` / `skipped`
- `gaps[]` — unmapped tests, missing tools, unsupported languages; each has a `risk`
- `findings[]` — high-risk paths, secrets, failed checks; each has a `risk`
- `summary.risk` — `none` | `low` | `medium` | `high` | `critical` (max of gaps + findings)

## GitHub Action

```yaml
# .github/workflows/patchprove.yml
name: patchprove
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jecketyuan-ux/patchprove/action@v0.1.0
        with:
          fail-on: high   # or critical; omit to comment only
```

The action builds the CLI from this repo, analyzes `base...head`, writes `evidence.json`, and creates or updates a **sticky** PR comment (`<!-- patchprove-sticky -->`).

## 中文

patchprove 是给 **Agent / PR 补丁** 用的证据包：影响面 → 实际跑过的检查 → 缺口 → 风险。它不是 CI 替代品，也不是「再用一个模型审一次」的 AI-on-AI。默认不调大模型、不采集遥测。人类和 Agent 都能在合并前看到：**哪些事仍然没被证明。**

```bash
npx patchprove run --base origin/main --fail-on high
```

## License

[MIT](LICENSE)
