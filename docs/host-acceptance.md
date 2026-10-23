---
title: Live host acceptance (experimental)
---

Claude Code and Cursor integrations are **experimental** until a candidate-specific live-host record is retained. This environment has no installed Claude Code, Cursor, or authenticated interactive host session. JSON/stdio fixture tests do not substitute for a host run. Core CLI/SDK/MCP validation can proceed independently.

Use a disposable Git project, the reviewed candidate tarball, and the host's documented current hook configuration. Record the exact host version, OS, Node version, candidate source identity and tarball SHA-256 before starting. Do not put credentials or chat contents in the record.

| Scenario | Claude Code observation | Cursor observation |
| --- | --- | --- |
| Successful required checks | Stop may finish; `verification.status=passed` | Advisory response reports passed |
| Failing test/contract | Stop/SubagentStop requests blocking with the failing unit | Advisory response describes failure; do not claim host enforcement |
| Missing runner/excluded/all skipped tests | Incomplete blocks Stop under strict policy | Incomplete advice and missing scope remain visible |
| Slow check then cancel | Process group exits; no orphan runner; no passed evidence | Cancellation returns control; no false completion |
| Repeated Stop and loop limit | Re-entry metadata bounds calls; final response does not loop | Follow-up count is bounded; no repeated autonomous request |
| Multiple workspaces | Each event resolves its explicit cwd and policy | Each workspace uses its own project/config |
| Spaces and non-ASCII paths | Hooks and MCP execute without shell interpolation | Same path behavior |
| Existing configuration | `init` merges without deleting unrelated hooks/settings | Same merge/rollback behavior |
| Real MCP startup | Host initializes server, lists tools, calls `prove_patch` and `list_gaps` | Same protocol interaction in the actual host |

Retain a JSON record with `candidate`, `tarballSha256`, `host{name,version}`, `platform`, `scenario`, `expected`, `observed`, `status: passed|failed|incomplete|not-run`, and a redacted local log path/digest. Revert the temporary project/config after the run. A failed/incomplete scenario is not retried into a success without a linked fix or documented environmental cause.

For GitHub publication, use separate read-only analysis and trusted publisher workflows. Exercise same-repository and fork PRs with passed/failed/incomplete verification, missing artifact, wrong digest/head, cancellation, old-success/new-failure ordering, rerun attempts, pagination/spoofed authors, and denied permissions. Record run/attempt/artifact/comment URLs and preserve the original verification exit. Per-PR concurrency must serialize publishers; GitHub comments have no atomic compare-and-swap contract. Publication remains experimental until these live cases are recorded. Never execute fork artifact scripts or run PR code with the publisher token.

These are runnable acceptance criteria, not claims that the live cases have passed. No npm publication, tag, release, or external test message is performed by these instructions.

## Candidate-bound acceptance ledger

Stable release now requires every current external feature's live cases to pass. Use `scripts/check-acceptance.mjs` to generate a **not-run** template after building a reviewed candidate archive:

```sh
npm run build
npm pack --ignore-scripts --pack-destination /tmp
node scripts/check-acceptance.mjs --template --tarball /tmp/patchprove-2.0.0.tgz > /tmp/acceptance.json
```

Run this from a clean candidate checkout. Keep acceptance records/logs outside that checkout. Every record must repeat the exact commit/tree/runtime/tarball identity. Populate only observations actually performed, retaining a relative raw `log: { path, bytes, sha256 }` and `method: "live"`. A discovered binary, CLI substitute, previous candidate or human expectation cannot change `not-run` into `passed`.

Required IDs are emitted by the template: `host:claude-code:*`, `host:cursor:*`, `github:same-repository:*`, `github:fork:*`, and `windows:*`. Host records include actual host/version, platform/Node and verification. Claude failure/incomplete cases record `hostAction: "blocked"`; Cursor records `"advised"`. Cancellation establishes `orphanProcesses: 0`.

GitHub records include repository/headRepository, real run URL/attempt, original and preserved exits, actual resulting comment URL when publication is expected, and explicit absence of stale/unverified publication for rejection cases. Windows records retain non-ASCII and space paths, actual JVM/Gradle, executed/failed assertions and infrastructure errors. The native group requires all thirty declared fixture scenarios with no skipped/failed cases.

The top-level CI record identifies the exact successful current-head run/attempt and all twelve required successful jobs, with a raw log reference. Run:

```sh
node scripts/check-acceptance.mjs --ledger /tmp/acceptance.json --tarball /tmp/patchprove-2.0.0.tgz
node scripts/check-acceptance.mjs --ledger /tmp/acceptance.json --tarball /tmp/patchprove-2.0.0.tgz --matrix
```

Both forms fail closed for missing, failed, incomplete, not-run, stale or internally inconsistent records. This verifies recorded bytes and relationships; it is not proof that an untrusted producer honestly ran a host. The actual source runs require review. See [implementation and remaining release blockers](upgrades/2.0-stabilization.md).
