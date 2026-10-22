---
title: Test mapping
---

# Test selection and its limits

Selection conservatively merges available coverage relationships, import/package graph edges, and filename candidates. A weak coverage hint must not discard known graph or naming relationships. Changed test files enter execution directly. Unsupported sources/resources/configuration and unresolved dependency boundaries remain explicit uncertainty; deleted-source relationships may use the base graph where available, with a gap when they cannot be established.

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| Explicit source-to-test export | Historical relationship between a source and named tests | Current branch coverage or assertion quality |
| Import/package graph | Statically resolvable dependency reachability | Dynamic imports, all runtime dependencies, or test assertions |
| Filename candidates | A plausible nearby test | Execution or behavioral coverage |
| Ordinary Istanbul/Cobertura report | Recorded source hit data and heuristic pairing where possible | Per-test attribution without explicit relationships |

`impact.mappingStrategy` summarizes the primary strategy; `mappingFallbacks` records additional strategies. Per-source `via` is a coarse label. Detailed `mappingEvidence` retains each edge's precision (`heuristic`, `structural`, `historical`), origin, available input digest, and freshness. Ordinary reports have unknown freshness unless snapshot provenance establishes more. A coverage strategy label is not a percentage of changed lines covered.

JS/TS graph parsing handles supported import/export/require forms and configured alias/workspace patterns. Unresolved/dynamic cases are not a full compiler model. Python import resolution remains heuristic. Go supports module imports, same-package tests, and coarse internal visibility. Rust selects affected crate/workspace test units including inline cases. Java uses module/package naming and test filters. See [plugins](plugins.md) for commands and unresolved language boundaries.

Selection and execution are separate. `verificationPlan` names required scopes; `executionRecords` show which units ran. A missing runner or omitted language cannot be covered by another unit's successful record. Reports of zero collected tests cannot establish a successful test gate. Disabling an optional gate is an explicit policy choice, while a required contract gate still must pass.

Golden and parser fixtures verify selection behavior. Native runner tests verify actual invocation/result behavior only for their recorded versions/environments. Neither proves zero missed affected tests across arbitrary projects. See [validation](validation.md), and [ecosystem](ecosystem.md) for snapshot-bound Nx/Turbo/testmon exports.
