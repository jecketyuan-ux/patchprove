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
| Model | None | None (no LLM path) |

**AI-on-AI reviewers** (another model summarizing or “approving” the diff) add a second opinion in the same uncertain medium. patchprove stays on the other axis: *what did a deterministic tool actually run, and what did it never see?* Use it beside CI and beside a human/LLM review — not instead of them.

A later single-binary (Rust/Go) may ship for air-gapped hosts. v1.2 is TypeScript + Node ESM, with an **experimental Go thin launcher** that execs the Node CLI. Docs: [docs/](docs/index.md).

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
node dist/cli.js init-agent --help
```

Requires Node 20+. Maintainers: see [PUBLISH.md](PUBLISH.md) for `npm publish` (pack-ready; this repo does not auto-publish).

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

# evaluate SPEC.md / .patchprove/spec.yml (contract failure also exits 1)
patchprove run --spec .patchprove/spec.yml --fail-on high

# compare open gaps against a saved baseline (new high gaps can fail)
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
patchprove baseline save

# accept a known gap (still listed; does not raise risk / fail-on)
patchprove run --accept src/generated/** --fail-on high

# hashable receipt (default: evidence.receipt.json next to --out)
patchprove run --receipt
patchprove receipt verify evidence.json
patchprove run --sign   # optional; needs PATCHPROVE_SIGNING_KEY

# install skill + Claude Code hook + Cursor rule pack + optional MCP snippet (idempotent)
patchprove init-agent
patchprove init-agent --cursor
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Repo to analyze (config is loaded from that repo’s root) |
| `--config <file>` | Explicit `.patchprove.yml` / `.yaml` path |
| `--json` | Print evidence JSON to stdout |
| `--format human\|json\|markdown` | Stdout format (markdown is what the Action posts) |
| `--out <file>` | Write `evidence.json` (default `evidence.json`) |
| `--fail-on high\|critical\|none` | Exit `1` when summary risk meets the threshold. `none` disables a config `failOn`. CLI overrides config. |
| `--fail-on-new-gaps high\|critical\|none` | Exit `1` when a **new** open gap vs baseline meets the threshold. |
| `--baseline <file>` | Compare against this evidence JSON (else config `baseline` or `.patchprove/baseline.json`). |
| `--spec <file>` | Explicit `SPEC.md` or `.patchprove/spec.yml`. |
| `--base <ref>` / `--head <ref>` | Analyze `base...head` instead of the working tree |
| `--accept <path-or-id>` | Accept a gap id or path pattern (repeatable). CLI adds to config `acceptGaps`. |
| `--ignore <glob>` | Exclude a path glob from impact / gaps / findings (repeatable). CLI adds to config `ignorePaths`. |
| `--disable-gate typecheck\|lint\|tests\|secrets` | Turn a gate off (repeatable). CLI overrides config `gates`. |
| `--sarif <file>` | Write SARIF 2.1 from findings, gaps, and **failed contract clauses** |
| `--receipt [file]` | Write a hashable receipt (default on: `<out>.receipt.json`) |
| `--no-receipt` | Skip the receipt file |
| `--sign` | Sign the receipt with `PATCHPROVE_SIGNING_KEY` (HMAC or ed25519). No key → hash only |

Other commands: `patchprove receipt verify`, `patchprove init-agent`, `patchprove hook stop|post|session|subagent-stop`, `patchprove baseline save`, `patchprove mcp` (see below).

Exit codes: `0` ok (or below threshold), `1` fail-on / **contract failure** / new-gap threshold met, `2` usage/runtime error.

## Config file

Load from the repo root (the git toplevel of `--cwd`): **`.patchprove.yml`**, or **`.patchprove.yaml`** if the `.yml` file is absent.

CLI flags **override** config when provided (`--fail-on`, `--disable-gate`). `--accept` and `--ignore` **add** to the config lists.

```yaml
# .patchprove.yml
failOn: high          # high | critical | null
ignorePaths:
  - dist/**
  - vendor/**
  - coverage/**
gates:
  typecheck: true
  lint: true
  tests: true
  secrets: true
baseline: .patchprove/baseline.json
failOnNewGaps: high
spec: .patchprove/spec.yml
plugins:
  - examples/plugins/widget.mjs   # optional local JS plugin; never fetched from the network
acceptGaps:
  - src/generated/**
  - id: gap-unmapped-src/legacy/hash.ts
    reason: third-party vendored helper
  - path: "**/*.generated.ts"
    reason: codegen
```

| Field | Type | Meaning |
| --- | --- | --- |
| `failOn` | `high` \| `critical` \| `null` | Same as `--fail-on`. `null` / omit = never fail the process. |
| `ignorePaths` | glob list | Drop matching paths from impact, gaps, and findings. |
| `gates` | booleans | Enable or disable `typecheck`, `lint`, `tests`, `secrets`. Disabled gates are skipped (`Disabled by config`) and do not create tool-missing gaps. |
| `baseline` | path | Evidence JSON to compare (overridden by `--baseline`). |
| `failOnNewGaps` | `high` \| `critical` \| `null` | Fail when a new open gap vs baseline meets this risk. |
| `spec` | path | Contract file (overridden by `--spec`). |
| `acceptGaps` | strings or `{ id?, path?, reason? }` | Known-accepted gaps. A string starting with `gap-` is an id; otherwise it is a path pattern. |
| `plugins` | path list | Local JS modules implementing the [v1.1 plugin API](docs/plugins.md). Also `PATCHPROVE_PLUGINS` or `.patchprove/plugins/*`. Built-ins stay loaded. |

A path pattern without glob metacharacters matches that path or anything under it (`src/generated` ≡ `src/generated` and `src/generated/**`).

## Contract (SPEC)

Primary: **`.patchprove/spec.yml`**. `SPEC.md` may embed a fenced yaml block or link to that file. See [docs/contract.md](docs/contract.md).

```yaml
# .patchprove/spec.yml
schemaVersion: "1.0"
requiredGates: [tests, secrets]
maxResidualRisk: medium
requiredMappedTests:
  - glob: src/auth/**
forbiddenUnproven:
  - glob: src/crypto/**
acceptedResidualRisk:
  policy: listed-only
```

`evidence.contract` records pass/fail per clause. A loaded contract that fails exits `1`.

## Baseline

```bash
patchprove baseline save                          # writes .patchprove/baseline.json
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
```

New open gaps versus the baseline are regressions (`evidence.baselineComparison`). See [docs/baseline.md](docs/baseline.md).

## Language plugins

Built-in: JS/TS, Python, **Go**, **Rust**, **Java**. v1.1 mapping is project-aware: Gradle/Maven multi-module FQCN filters, `go.mod` + `internal/` import resolution with `go test ./pkg/...`, Cargo workspace `cargo test -p <crate>`.

External plugins are **opt-in and local** (`.patchprove.yml` `plugins:`, `PATCHPROVE_PLUGINS`, or `.patchprove/plugins/*`). Example: [`examples/plugins/widget.mjs`](examples/plugins/widget.mjs). See [docs/plugins.md](docs/plugins.md).

## Evidence receipts

After `patchprove run`, a **receipt** (`evidence.receipt.json` by default) records a canonical content hash of the pack plus enough metadata to audit the run. Same diff twice → same `contentHash` (timestamps and check durations are excluded from the hash). See [docs/schema.md](docs/schema.md).

```bash
patchprove run --out evidence.json          # writes evidence.receipt.json
patchprove receipt verify evidence.json     # recompute hash; exit 1 on mismatch
```

Optional signing is intentionally small:

```bash
export PATCHPROVE_SIGNING_KEY="hmac:a-long-random-secret"
# or: PATCHPROVE_SIGNING_KEY="ed25519:$(openssl ...)"  / a PEM private key
patchprove run --sign --out evidence.json
```

If `--sign` is set but the env var is empty, signing is skipped and the hash is still written. Ed25519 receipts store the public key so `receipt verify` does not need the private key. HMAC verify needs the same secret.

## Known-accepted gaps

Gaps matching `acceptGaps` or `--accept`:

- Stay in `evidence.gaps[]` with `accepted: true` and `acceptedReason`
- Appear in the report under **Accepted gaps** (audit trail)
- Do **not** raise `summary.risk` or trip `--fail-on`
- `summary.gapCount` counts **open** gaps only; `summary.acceptedGapCount` is separate

## What it does (v1.2)

1. **Detect changed files** via `git diff` (working tree vs `HEAD`, or `--base`/`--head`), minus `ignorePaths`.
2. **Map nearby tests** (deterministic, no LLM), in order:
   - **coverage** when a map is present (`coverage/coverage-final.json`, then Cobertura XML)
   - **graph** — parse imports from tests (JS/TS relative `import`/`require`/`import()`; Python `from`/`import` heuristics; Go module-path + same-package `*_test.go`) and reverse-map to changed modules
   - **naming** — `foo.ts` → `foo.test.ts` / `foo.spec.ts`; `foo.py` → `test_foo.py`; `foo.go` → `foo_test.go`; Rust crate `tests/`; Java module + package-path `*Test.java`
   - Evidence records `impact.mappingStrategy` and per-source `via`: `coverage` \| `graph` \| `naming`
3. **Run gates when enabled and the target repo actually has the tools**, including language plugins:
   - typecheck: `tsc --noEmit`, or `pyright` / `mypy`
   - lint: `eslint` or `ruff`
   - affected tests: `vitest` / `jest` / `pytest` / `go test ./pkg` / `cargo test -p <crate>` / `mvn -Dtest=FQCN` / `gradle --tests FQCN` on the mapped subset
   - secret scan: `gitleaks` if installed, otherwise regex on **added** lines
4. **Evaluate the contract** if `.patchprove/spec.yml` or `SPEC.md` is present (required gates, max residual risk, mapped-test globs, forbidden unproven paths).
5. **Compare a baseline** if `--baseline`, config `baseline`, or `.patchprove/baseline.json` exists. New open gaps are regressions.
6. **Highlight high-risk paths**: lockfiles, `.github/workflows/**`, auth/crypto-ish names.
7. **Write** a human report, `evidence.json` (`schemaVersion: "1.2.0"`), a hashable **receipt**, and optionally SARIF (findings, gaps, failed contract clauses).

No telemetry. No Anthropic/OpenAI account. Not a CI replacement and not an LLM reviewer.

See **[docs/](docs/index.md)** for the contract, mapping, plugins, baseline, [schema](docs/schema.md), and [case study](docs/case-study.md).

## Sample: almost-right agent patch

An agent “fixes login lockout.” Types are clean. Lint is clean. It even updates `src/auth/session.test.ts` for the TTL constant. The PR reads as done.

What patchprove sees:

```
patchprove  v1.2.0  ·  impact → checks → gaps → risk
model-free evidence pack  ·  not a CI replacement

range     working tree vs HEAD
files     3 changed  ·  typescript  ·  mapping naming
risk      HIGH

IMPACT
  .github/workflows/ci.yml  ⚠ workflow → no mapped test
  src/auth/session.ts  ⚠ auth-crypto → src/auth/session.test.ts (naming)
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

ACCEPTED GAPS
  (none)

FINDINGS
  • High-risk path (auth-crypto): src/auth/session.ts  [high]
  • High-risk path (workflow): .github/workflows/ci.yml  [high]

SUMMARY  HIGH   1 passed · 0 failed · 3 skipped · 1 open gaps · 0 accepted · 2 findings
```

The lockout branch in `session.ts` never got a test. `hash.ts` moved with the patch and has **no** mapped test. CI workflow bits changed. Checks that did not run are visible instead of implied-green.

That is the product: **almost-right is not proven.** Merge when a human accepts the residual gaps — not because another model said “LGTM.”

## Evidence schema

JSON Schema: [`schema/evidence.schema.json`](schema/evidence.schema.json). Semver rules: [docs/schema.md](docs/schema.md).

Top-level shape (`schemaVersion` **1.2.0**, 1.x additive):

- `schemaVersion` — `1.2.0` (1.0.0 packs remain valid 1.x documents)
- `impact` — changed files, mapped tests, unmapped sources, languages, **`mappingStrategy`**, optional **`mappingFallbacks`**
- `impact.mappedTests[].via` — optional `naming` \| `coverage` \| `graph`
- `checks[]` — `typecheck` \| `lint` \| `tests` \| `secrets` with `passed` / `failed` / `skipped`
- `gaps[]` — unmapped tests, missing tools, unsupported languages; each has a `risk`; accepted gaps add `accepted` + `acceptedReason`
- `findings[]` — high-risk paths, secrets, failed checks; each has a `risk`
- `contract` — loaded/passed + clause results when a SPEC is present
- `baselineComparison` — new/resolved gaps vs a previous pack (or `null`)
- `receipt` — optional pointer (`contentHash`, path) written after the hash is computed; excluded from the hash
- `summary.risk` — `none` \| `low` \| `medium` \| `high` \| `critical` (max of findings + **open** gaps)
- `summary.gapCount` — open gaps; `summary.acceptedGapCount` — accepted gaps

## GitHub Action

```yaml
# .github/workflows/patchprove.yml
name: patchprove
on: pull_request
permissions:
  contents: read
  pull-requests: write
  security-events: write   # only required for upload-sarif
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jecketyuan-ux/patchprove/action@v1.2.0
        with:
          fail-on: high   # or critical / none; omit to use config or comment only
          upload-sarif: true
```

The action builds the CLI from this repo, analyzes `base...head`, writes `evidence.json` + a receipt, uploads both as workflow artifacts, and creates or updates a **sticky** PR comment (`<!-- patchprove-sticky -->`) with Impact, Checks, Contract, Receipt (content hash), Open gaps, Accepted gaps, and Findings. A later run on the same PR notes whether the receipt hash is **unchanged** or **changed**.

Set `upload-sarif: true` to generate SARIF from findings, gaps, and **failed contract clauses**, then upload it with `github/codeql-action/upload-sarif`. That needs **`security-events: write`**. Accepted gaps are uploaded with SARIF suppressions (`status: accepted`). See [action/README.md](action/README.md).

## MCP server

stdio MCP server, same pipeline as `patchprove run`. Tools:

| Tool | What it does |
| --- | --- |
| `prove_patch` | Run impact → checks → gaps → risk. Args: `cwd`, `base`, `head`, `failOn`, `accept`, `config`, `out`, `ignore`, `disableGate`. Returns structured evidence plus a short human summary. |
| `list_gaps` | Open (non-accepted) gaps from a fresh run (same args) or from `evidencePath` pointing at an `evidence.json`. |

Bins:

```bash
npx patchprove-mcp          # dist/mcp.js
node dist/mcp.js
npx patchprove mcp
```

Register the server (copy-paste snippets also live under [`examples/mcp/`](examples/mcp/)).

**Claude Desktop** — merge into `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "patchprove": {
      "command": "npx",
      "args": ["-y", "patchprove-mcp"]
    }
  }
}
```

**Claude Code** — project [`.mcp.json`](https://code.claude.com/docs/en/mcp) (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "patchprove": {
      "command": "npx",
      "args": ["-y", "patchprove-mcp"]
    }
  }
}
```

`patchprove init-agent` writes this file (idempotent merge of `mcpServers.patchprove`).

**Cursor** — project `.cursor/mcp.json` or Cursor Settings → MCP, same `mcpServers.patchprove` object as above.

From a local clone (no npm publish):

```json
{
  "mcpServers": {
    "patchprove": {
      "command": "node",
      "args": ["/absolute/path/to/patchprove/dist/mcp.js"]
    }
  }
}
```

Log to stderr only; stdout is the MCP protocol.

## Agent hooks

**Pattern: the agent must not claim done while open gaps remain.**

Ready-to-copy configs: [`examples/hooks/`](examples/hooks/). They call the **CLI** (deterministic, local), not another model.

```bash
# Claude Code Stop — block the turn when open gaps or fail-on
npx patchprove hook stop --adapter claude-code --fail-on high

# Claude Code PostToolUse — surface gaps after Edit/Write
npx patchprove hook post --adapter claude-code --fail-on high

# Claude Code SessionStart / SubagentStop
npx patchprove hook session --adapter claude-code --fail-on high
npx patchprove hook subagent-stop --adapter claude-code --fail-on high

# Cursor stop — follow-up message (Cursor cannot hard-block a turn)
npx patchprove hook stop --adapter cursor --fail-on high
```

- Claude Code: merge [`examples/hooks/claude-code.settings.json`](examples/hooks/claude-code.settings.json) into `.claude/settings.json`
- Cursor: copy [`examples/hooks/cursor.hooks.json`](examples/hooks/cursor.hooks.json) to `.cursor/hooks.json`

`hook` prints **only** host JSON on stdout. Accepted gaps do not trip the gate.

## init-agent and cc-kit

Install the skill + Claude Code hook + optional MCP snippet into a repo:

```bash
npx patchprove init-agent
npx patchprove init-agent --dry-run
npx patchprove init-agent --force
npx patchprove init-agent --no-cursor
npx patchprove init-agent --no-mcp --cli "node /path/to/patchprove/dist/cli.js"
```

Writes (idempotent; `--force` overwrites a diverged skill or the patchprove hook / MCP snippet):

- `.claude/skills/patchprove/SKILL.md`
- merge into `.claude/settings.json` (Stop, PostToolUse, SessionStart, SubagentStop)
- `.mcp.json` (`mcpServers.patchprove`) unless `--no-mcp`
- `.cursor/rules/patchprove.mdc` and `.cursor/hooks.json` unless `--no-cursor`

The same skill lives at [`examples/skills/patchprove/`](examples/skills/patchprove/) so [cc-kit](https://github.com/jecketyuan-ux/cc-kit) can install it from git **without** an npm publish:

```bash
npx cc-kit skill add https://github.com/jecketyuan-ux/patchprove.git#examples/skills/patchprove
npx cc-kit skill add ./examples/skills/patchprove
npx cc-kit doctor
```

`init-agent` is the small install path that also drops the hook snippet. cc-kit `skill add` is skill-only; copy [`examples/hooks/`](examples/hooks/) or run `init-agent` for hooks.

## 中文

patchprove 是给 **Agent / PR 补丁** 用的证据包：影响面 → 实际跑过的检查 → 缺口 → 风险。它不是 CI 替代品，也不是「再用一个模型审一次」的 AI-on-AI。默认不调大模型、不采集遥测。人类和 Agent 都能在合并前看到：**哪些事仍然没被证明。**

v1.2 在 v1.1 语言映射 / 插件之上增加**可哈希（可选签名）的证据回执**、契约条款进 SARIF，以及 Action 产物与回执对比。有未接受的缺口、契约失败、或相对基线的新高风险缺口时，进程以 `1` 退出。**Agent 不得声称做完。**

```bash
npx patchprove run --base origin/main --fail-on high
npx patchprove init-agent
```

## License

[MIT](LICENSE)
