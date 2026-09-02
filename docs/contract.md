---
title: Contract
---

# Contract (`SPEC.md` / `.patchprove/spec.yml`)

v1.0 can load an in-repo **contract** and evaluate it on every `patchprove run`. The contract is the merge/agent gate: required checks, mapped tests, and how much residual risk is allowed.

## Primary file

**Primary:** `.patchprove/spec.yml` (or `.patchprove/spec.yaml`)

`SPEC.md` at the repo root is also supported:

- Embed a fenced `yaml` / `yml` block, or
- Link to the yaml (`[contract](.patchprove/spec.yml)`)

If both exist, the yaml file wins. Override with `--spec <file>` or `spec:` in `.patchprove.yml`.

JSON Schema: [`schema/spec.schema.json`](https://github.com/jecketyuan-ux/patchprove/blob/main/schema/spec.schema.json)

## Shape

```yaml
# .patchprove/spec.yml
schemaVersion: "1.0"
requiredGates:
  - tests
  - secrets
maxResidualRisk: medium          # none | low | medium | high | critical
requiredMappedTests:
  - glob: src/auth/**
    reason: auth paths must have a mapped test
forbiddenUnproven:
  - glob: src/crypto/**
    reason: crypto changes cannot ship unmapped
acceptedResidualRisk:
  policy: listed-only            # none | listed-only | allow
```

| Field | Meaning |
| --- | --- |
| `requiredGates` | Each listed gate (`typecheck`, `lint`, `tests`, `secrets`) must **pass** |
| `maxResidualRisk` | `summary.risk` must be at or below this (open gaps + findings) |
| `requiredMappedTests` | Changed mappable files matching `glob` must have mapped tests |
| `forbiddenUnproven` | Matching changed sources must not appear in `unmappedSources` |
| `acceptedResidualRisk.policy` | `none` = no residual risk/open gaps/findings; `listed-only` = no **open** gaps (everything leftover must be in `acceptGaps`); `allow` = only the other clauses apply |

## Evidence

`evidence.contract`:

```json
{
  "loaded": true,
  "passed": false,
  "source": "/repo/.patchprove/spec.yml",
  "format": "yaml",
  "clauses": [
    { "id": "forbidden-unproven-0", "kind": "forbidden-unproven", "passed": false, "message": "…" }
  ]
}
```

A loaded contract that fails **exits 1**, even if `--fail-on` is unset. That is the gate.
