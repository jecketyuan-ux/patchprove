---
title: Baseline
---

# Baseline comparison

Compare the current open gaps/findings against a previous evidence pack. **New gaps are regressions.** Resolved gaps are recorded, not hidden.

## Load order

1. `patchprove run --baseline <evidence.json>`
2. `.patchprove.yml` `baseline:` path (typically last committed evidence)
3. `.patchprove/baseline.json` if it exists

## Save

```bash
patchprove baseline save
patchprove baseline save --from evidence.json --out .patchprove/baseline.json
```

Default output is `.patchprove/baseline.json`. Commit it so PRs can regress against a known pack.

## Fail on new high gaps

```yaml
# .patchprove.yml
baseline: .patchprove/baseline.json
failOnNewGaps: high
```

```bash
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
```

`evidence.baselineComparison`:

- `newGaps` / `resolvedGaps`
- `newFindings` / `resolvedFindings`
- `regression` — true when `newGaps.length > 0`
- `failOnNewGaps` — threshold copied from config when set

A new gap at or above `failOnNewGaps` exits `1`.
