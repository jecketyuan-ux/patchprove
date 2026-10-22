---
title: Contract
---

# Verification contract

Discovery order is `.patchprove/spec.yml`, `.patchprove/spec.yaml`, then root `SPEC.md` containing a YAML fence or link. Explicit `--spec` or configuration `spec:` selects a file. The [spec schema](../schema/spec.schema.json) describes its shape; contract schema `1.0` is independent of evidence protocol 2.

```yaml
schemaVersion: "1.0"
requiredGates: [tests, secrets]
maxResidualRisk: medium
requiredMappedTests:
  - glob: src/auth/**
    reason: auth changes need mapped tests
forbiddenUnproven:
  - glob: src/crypto/**
acceptedResidualRisk:
  policy: listed-only
```

| Clause | Evaluation |
| --- | --- |
| `requiredGates` | Each listed check must pass, including when configuration disabled it |
| `maxResidualRisk` | Maximum allowed summary risk from findings and open gaps |
| `requiredMappedTests` | Changed, classified sources matching the glob need a nonempty test mapping |
| `forbiddenUnproven` | Matching sources must not remain in `impact.unmappedSources` |
| `acceptedResidualRisk` | `none`: no residual risk, open gaps, or findings; `listed-only`: no open gaps; `allow`: other clauses still apply |

The acceptance policy may be a shorthand string or `{ policy: ... }`. Truly omitted policy defaults to `allow`; explicit `null`, booleans, numbers, arrays, missing object policy, and unknown policy values fail parsing. Source classification comes from the current impact analysis, including permitted external plugins. A glob with no relevant changed source passes vacuously. A mapped test does not prove that a branch is asserted or exercised.

`evidence.contract` records each clause and its affected paths. Any failed clause fails the shared verification decision, even without a risk threshold. A passing contract alone does not turn missing planned execution or snapshot provenance into `passed`.

Gap acceptance is separate configuration (`acceptGaps` or `--accept`). Path rules must jointly cover all files in an aggregate; an explicit ID accepts the group. Rules can record `ruleId`, `reason`, `owner`, `expiresAt`, and `ticket`; expired rules do not apply. Acceptance retains the gap and never removes findings. `listed-only` concerns open gaps and does not itself permit findings above `maxResidualRisk` or a configured `failOn` threshold.

Failed clauses can be emitted to SARIF. The lenient contract in this repository is a wiring/reporting fixture, not proof of strict policy coverage. See [validation](validation.md).
