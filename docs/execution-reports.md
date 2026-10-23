---
title: Execution facts and strict completion
---

An argument passed to a runner is a request, not evidence that a test ran. New producer records include `testExecution`: requested, collected, executed, skipped and unknown scopes; separate case counts; parser/format identity; report status and digest. `ExecutionRecord.scope` contains observed execution scopes. Required unknown or skipped work keeps strict verification incomplete, even when the process exits zero. A report with failed cases establishes failure.

| Runner | Evidence | Minimum granularity |
| --- | --- | --- |
| Vitest / Jest | Unique invocation JSON report and assertion outcomes | File |
| pytest | Unique xunit1 JUnit report; collected module classname takes precedence over inherited definition location | File |
| Go | `go test -json` case/package events plus `go list -json` package identity and eligible files | Package |
| Cargo | Complete stable libtest summaries from a separately invoked crate; truncated/missing summaries are unknown | Crate |
| Maven / Gradle | Fresh, bounded XML matched to selected classes; testcase outcomes including skipped/failure/error | File/class |

`counts.collected = executed + skipped` and `executed = passed + failed`. Missing or invalid reports carry zero **known** counts and `reportStatus`; those values do not assert that zero tests ran. Counts are exact only for the validated report scope. `sourceFiles` and optional `eligibleSourceFiles` explain the package/crate plan. Coarse units do not establish individual-file, branch, assertion-quality, feature/target or build-tag coverage. Normal projects with intentionally skipped tests may remain incomplete under strict policy; inspect the reason rather than silently waiving cases.

The reader rejects duplicate execution identities, mismatching nested/top-level copies, passed records without exit zero, contradictory counts/scopes, and stored decisions that disagree with the shared evaluator. Known historical 1.x/2.x packs remain readable according to their existing optional fields; absent new facts must not be invented. SDK evaluation also fails closed on conflicting copies. A signature authenticates the supplied record, not the truthfulness of an external runner.

JS resolution records use parser version `2`, configuration hashes, graph input hash, and classified import resolutions. Nearest package `imports`, conditional target unions and wildcards are supported conservatively. Unresolved internal, dynamic, unreadable or invalid configuration inputs expand selection to all known tests. Built-ins and declared external packages do not trigger that fallback. Static parsers do not establish arbitrary compiler/runtime resolution. A caller-supplied snapshot reader remains authoritative; it does not fall back to current checkout bytes.
