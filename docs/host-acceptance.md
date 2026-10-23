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
