---
title: Baseline
---

# Baseline comparison

Baselines compare current open gaps and findings with saved evidence. They do not supply missing execution proof or automatically accept existing debt.

Lookup order is explicit `--baseline`, configuration `baseline:`, then `.patchprove/baseline.json`. Runtime readers validate structure and supported majors before comparison; malformed documents fail at the input boundary.

An explicitly selected or configured baseline must exist. A missing configured path is an error even if a default baseline happens to exist; it cannot silently select a different comparison policy. Saving uses atomic file replacement so existing readers retain the previous complete file.

```sh
patchprove run --out evidence.json
patchprove baseline save --from evidence.json
patchprove run --baseline .patchprove/baseline.json --fail-on-new-gaps high
```

Review the saved pack and its decision before treating it as a reference. Saving evidence is not an approval. To retain old source material, keep the previous baseline separately when creating a migrated one.

| Result | Meaning |
| --- | --- |
| `newGaps` / `resolvedGaps` | Open gap identities added/removed |
| `newFindings` / `resolvedFindings` | Finding identities added/removed |
| `changedGaps` / `changedFindings` | Matched identities with changed severity or scope |
| `compatibility` | Repository/policy/snapshot provenance compatibility, reasons, and baseline content digest |
| `regression` | New or changed open gaps exist |

Semantic fingerprints use rule/kind and normalized location/scope, not ordinal IDs such as `path-1`. Historical records without fingerprints use the same semantic fallback. Aggregate gap scope changes are reported separately. Renaming a source/location can therefore produce resolved and new findings; the tool does not claim to infer behavioral equivalence.

`failOnNewGaps: high|critical` applies only to **new open gaps** at or above the threshold. Severity/scope changes and new findings are visible but are not silently folded into that threshold. Normal risk/contract rules still apply; strict completeness also considers remaining open verification gaps.

Missing old snapshot/policy provenance, differing repository roots, differing policies, or incompatible snapshot formats produce explicit compatibility reasons. An incompatible baseline makes verification incomplete; it must not be read as a clean regression comparison. Repository roots are currently path-based, so cross-machine relocation may need a fresh comparable baseline. Preserve the original artifact and use [migration](migration-v2.md) to create current evidence rather than fabricating historical provenance.
