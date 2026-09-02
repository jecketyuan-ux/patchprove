---
title: Case study
---

# Case study: almost-right agent PR

An agent was asked to “fix login lockout.” Types were clean. Lint was clean. It updated `src/auth/session.test.ts` for the TTL constant. The PR description read as done.

## What moved

| Path | What the agent claimed | What patchprove mapped |
| --- | --- | --- |
| `src/auth/session.ts` | lockout branch + TTL | colocated `session.test.ts` (`naming` / `graph`) — **the new lockout branch is still unasserted** |
| `src/utils/hash.ts` | “shared helper, no behavior change” | **no mapped test** |
| `.github/workflows/ci.yml` | “just a trigger tweak” | high-risk **workflow** finding |

## Evidence (synthetic fixture, same shape as dogfood)

```
patchprove  v1.0.0  ·  impact → checks → gaps → risk
model-free evidence pack  ·  not a CI replacement

range     working tree vs HEAD
files     3 changed  ·  typescript  ·  mapping graph
risk      HIGH
contract  fail  ·  2 clauses

IMPACT
  .github/workflows/ci.yml  ⚠ workflow → no mapped test
  src/auth/session.ts  ⚠ auth-crypto → src/auth/session.test.ts (graph)
  src/utils/hash.ts → no mapped test

CHECKS
  · typecheck                  skipped
  · lint                       skipped
  · affected tests             skipped
  ✓ secret scan (regex)        passed

CONTRACT
  ✗ Forbidden unproven paths src/utils/**: src/utils/hash.ts
  ✓ Residual risk high within max critical

GAPS
  • No nearby test mapped for src/utils/hash.ts  [medium]

FINDINGS
  • High-risk path (auth-crypto): src/auth/session.ts  [high]
  • High-risk path (workflow): .github/workflows/ci.yml  [high]

SUMMARY  HIGH   1 passed · 0 failed · 3 skipped · 1 open gaps · 0 accepted · 2 findings
```

The lockout branch in `session.ts` never got a test. `hash.ts` moved with the patch and has **no** mapped test. CI workflow bits changed. A `forbiddenUnproven: src/utils/**` contract clause failed the process (`exit 1`) even though `--fail-on` could have been omitted.

That is the product: **almost-right is not proven.** Merge when a human accepts the residual gaps — not because another model said “LGTM.”

## Reproduce from this repo

The integration fixture in `test/run.integration.test.ts` seeds that tree (auth session + hash + workflow) and asserts unmapped `hash.ts`, auth/workflow findings, and high residual risk. v1.0 adds a SPEC.md forbidden-unproven glob on `src/utils/**` so the same patch fails the contract.
