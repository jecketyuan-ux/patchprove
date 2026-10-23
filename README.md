# patchprove

The 2026-10-23 hardening implements fresh test-result reconciliation, conservative unresolved-import fallback, semantic readers, signing intent checks, stale-publisher guards, project policies and input budgets. See [current implementation and evidence](docs/upgrades/2x-hardening.md), [execution facts](docs/execution-reports.md), [project policy](docs/project-policy.md) and [limits](docs/resource-budgets.md). Live Claude/Cursor and fork-publisher acceptance remain experimental; historical CI is not evidence for this candidate.


**Evidence for a patch: snapshot → impact → planned checks → execution → gaps → decision.**

patchprove runs configured tools and records what they establish about a Git change. It uses no LLM, cloud service, or telemetry. A successful decision means the recorded policy was satisfied; it does not establish that every behavior is correct or replace repository CI and review.

This checkout implements **2.0.0**. That is not an announcement that an npm release, Git tag, or hosted CI run exists. See [implementation and audit traceability](docs/upgrade-implementation.md), [migration](docs/migration-v2.md), [validation](docs/validation.md), and [publishing](PUBLISH.md).

## Install from this checkout

Requires Node 22+ and Git. Install the target project's test/build dependencies separately.

```sh
npm ci
npm run build
node dist/cli.js run --help
node dist/cli.js run --cwd /path/to/target-repo --out /tmp/evidence.json

# Optional local installation; inspect the tarball before installing.
npm pack
npm install -g ./patchprove-2.0.0.tgz
```

Examples below use the installed `patchprove` command. Registry installation and version-pinned `npx` commands require a separately published package.

## Run and interpret the result

```sh
patchprove run                                      # final working tree vs HEAD
patchprove run --base origin/main --head HEAD --isolate
patchprove run --json --out evidence.json
patchprove run --spec .patchprove/spec.yml --fail-on high
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
patchprove run --protocol 1 --out evidence-v1.json    # compatibility shape 1.3.0
```

Protocol 2 is strict by default. All entry points consume the shared `verification` decision:

| Decision | Meaning | Default CLI exit |
| --- | --- | --- |
| `passed` | Applicable required scopes completed and policy held | `0` |
| `failed` | A check, contract, or rejection threshold failed | `1` |
| `incomplete` | Required execution/provenance is missing, a snapshot drifted, or an open verification gap remains | `1` |
| No usable result | Invalid input or a runtime/artifact error | `2` |

`--no-strict` permits incomplete coverage at the process boundary. Protocol 1 defaults to compatibility behavior. Neither converts an actual failed check or failed contract into successful verification. Agents should inspect `verification.status`; deprecated `claimDone` is true only for `passed`.

Checks retain `passed | failed | skipped` summaries. Per-unit `executionRecords` retain command, argv, scope, outcome, exit code, timeout, output digest, and available tool version. One language's success cannot cover another language's missing runner. Changed tests are selected directly. Zero collected tests do not establish success. Pure documentation changes can pass when no runtime checks apply.

## Configuration and acceptance

The repository root's `.patchprove.yml` takes precedence over `.patchprove.yaml`. CLI scalars override configuration; `--accept` and `--ignore` append entries.

```yaml
failOn: high
gates:
  typecheck: true
  lint: true
  tests: true
  secrets: true
ignorePaths: [dist/**, coverage/**]
acceptGaps:
  - ruleId: generated-code
    path: src/generated/**
    reason: generated output; generator has its own tests
    owner: platform
    expiresAt: "2027-01-01"
    ticket: ENG-42
```

Protocol 2 rejects unknown configuration keys. Protocol 1 records warnings; `--strict-config` makes them errors. Known fields with invalid types fail parsing. `failOn: null` disables that threshold, not failures or strict completeness.

Accepted gaps remain visible with `acceptedReason` and `acceptedBy`. Path rules may jointly accept an aggregate gap only when they cover **every** file; an explicit gap ID accepts the entire group. Expired rules do not apply. Acceptance affects gaps, not auth/crypto, workflow, secret, or other findings. `--ignore` removes matching paths from analysis and changes the policy scope.

`--disable-gate tests` disables an optional gate; it cannot satisfy `requiredGates: [tests]` in a contract. Missing, disabled, unsupported, and inapplicable checks have different meanings: inspect skips, diagnostics, gaps, and planned scopes together. Every skip is not automatically a gap.

## Contract and baseline

`.patchprove/spec.yml` or `.patchprove/spec.yaml` is discovered automatically; `SPEC.md` may contain YAML or link to it. `--spec` selects a file explicitly.

```yaml
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

A failed contract fails verification. Required mapped tests use impact's source classification, including allowed external plugins. Mapping establishes a relationship, not branch coverage or assertion quality. See [contracts](docs/contract.md) and the [synthetic case study](docs/case-study.md).

```sh
patchprove baseline save --from evidence.json
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
```

Baselines compare semantic fingerprints rather than sequential display IDs. New/resolved items, severity/scope changes, and repository/policy/provenance compatibility are separate results. `failOnNewGaps` applies to new open gaps, not changed severity or findings. See [baselines](docs/baseline.md).

## Snapshots, receipts, and trust

Snapshot identity binds source content and patch bytes to resolved refs. Range runs materialize the selected head in an isolated execution tree by default. If isolation is disabled through the SDK, the execution tree must match that head. Working-tree runs check for input drift. Output paths are excluded explicitly from capture. Isolation protects the checkout from execution-tree changes; it is not an operating-system sandbox.

Runs write evidence, a receipt by default, optional SARIF, and an artifact manifest. Distinct output paths and digests detect partial or mixed output sets. `--no-receipt` disables receipt production; `--sarif report.sarif` enables SARIF. See the [schema and receipt contract](docs/schema.md).

```sh
patchprove receipt verify evidence.json
PATCHPROVE_SIGNING_KEY='hmac:replace-with-a-long-random-secret' patchprove run --sign
patchprove receipt verify evidence.json --require-signature
# Ed25519: pin the expected SPKI public-key SHA-256 fingerprint.
patchprove receipt verify evidence.json --require-signature --trusted-key sha256:EXPECTED_HEX
```

Version 2 signatures cover the receipt envelope: evidence/execution hashes, snapshot, effective policy, decision, and exit metadata. `--sign` without a key fails in protocol 2. Unsigned receipts establish internal integrity only. An embedded Ed25519 public key can verify a signature mathematically; `--trusted-key` identifies an accepted signer. HMAC verification needs the shared secret.

Legacy receipt 1.2 authenticates its historical canonical evidence hash, not the full metadata envelope; use `--allow-legacy` when explicitly accepting that format. A matching hash does not prove that a producer honestly ran tools. Stable canonical evidence fields reproduce `contentHash`; the same diff alone does not guarantee the same hash across policies, results, paths, or environments. Snapshot, canonical evidence, and full execution/receipt identities have separate digests.

## Tool and language scope

| Language | Selection and execution implemented | Limits |
| --- | --- | --- |
| JS/TS | Naming/import graph, configured alias/workspace resolution; Vitest/Jest, tsc, ESLint | Static parsing has unresolved/dynamic boundaries |
| Python | Naming/import heuristics; pytest, pyright/mypy, Ruff | Dynamic imports and environment-specific resolution need fallback |
| Go | Module imports, same-package tests, coarse internal visibility; affected-package go test | Incomplete go.work, build-tag, cgo, and generated-code models |
| Rust | Crate/workspace selection, integration and inline-test units; Cargo | Macros/build scripts/platform behavior is not statically proven |
| Java | Module/package naming; Maven/Gradle test filters | Naming/build-file parsing is not a compiler dependency graph |

Implementation and executed runtime validation are separate. See the [validation matrix](docs/validation.md) for actual runner/platform coverage. Fixture command assertions do not establish native runner behavior. Ordinary Istanbul/Cobertura data alone does not identify which test covers a changed branch. See [mapping](docs/mapping.md).

External local plugins require explicit permission in protocol 2 (`--allow-plugins`). They execute repository JavaScript with the caller's privileges; locality is not a trust boundary. Project tools can execute repository code and use the network. Spawned tool environments remove signing/authentication variables; filesystem credentials and the rest of the host remain outside that protection. `--timeout-ms` and `--max-output-bytes` bound execution/output capture and retain timeout/truncation evidence. See [plugins](docs/plugins.md).

## MCP, hooks, and GitHub Action

```sh
patchprove init-agent --local-cli /absolute/path/to/patchprove/dist/cli.js
node /absolute/path/to/patchprove/dist/mcp.js
patchprove hook stop --adapter claude-code
patchprove hook stop --adapter cursor
```

`init-agent` merges the skill, hook entries, and optional MCP configuration while preserving unrelated settings; `--dry-run` previews changes. `--local-cli` suits this unreleased checkout. After publication, bind package and bin explicitly: `npx --yes --package=patchprove@VERSION patchprove-mcp`.

MCP `prove_patch` and `list_gaps` use the shared pipeline, including spec/baseline, strictness, limits, and explicit artifact controls. MCP stdout carries protocol messages; hook stdout carries host JSON. Claude Code Stop/SubagentStop responses can request blocking through the host protocol; PostToolUse/SessionStart add context. Cursor follow-ups are advisory. Transport/fixture tests do not establish behavior inside live host installations.

Hook input is capped at 64 KiB and the default total hook budget is 30 seconds. Host re-entry (`stop_hook_active`) or a loop count of three suppresses another response. These guards and host-specific response handling limit enforcement; a hook exit code alone is not the verification decision.

The [GitHub Action](action/README.md) preserves verification status when comment publication fails, separates publication credentials from analysis, and uploads artifacts. Use a reviewed commit reference and the intended PR-head checkout. Workflow definitions are not evidence that hosted Actions or real host sessions executed. See [ecosystem adapters](docs/ecosystem.md) for Nx/Turbo/testmon exports and optional offline Cosign verification boundaries.

## More

- [Documentation](docs/index.md) · [Migration](docs/migration-v2.md)
- [Contributing](CONTRIBUTING.md) · [Publishing](PUBLISH.md) · [Roadmap](ROADMAP.md)
- [Experimental Go launcher](docs/standalone.md) · [MIT license](LICENSE)

## 中文

当前工作区实现 2.0，尚不代表已经发布。默认严格判定：`failed` 与 `incomplete` 都以 `1` 退出，参数或运行错误以 `2` 退出。`--protocol 1` 输出兼容的 1.3 证据；它和 `--no-strict` 不会把失败检查改成通过。测试映射不等于覆盖新增分支，接受 gap 也不会消除 findings。完整性、签名有效性、签名者信任和执行真实性应分别判断。详见[迁移说明](docs/migration-v2.md)。
