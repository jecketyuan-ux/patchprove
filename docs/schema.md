---
title: Schema and receipts
---

# Evidence, receipt, and artifact contracts

This checkout emits evidence **2.0.0** by default and **1.3.0** with `--protocol 1`. Tool/package version is 2.0.0; shape versions and package releases are separate concepts. [Migration](migration-v2.md) explains changed defaults. The published [evidence](../schema/evidence.schema.json), [receipt](../schema/receipt.schema.json), and [spec](../schema/spec.schema.json) schemas define producer structure.

## Evidence

Both evidence formats retain `repo`, `range`, `impact`, `checks`, `gaps`, `findings`, `summary`, `contract`, and `baselineComparison`. Four check IDs (`typecheck`, `lint`, `tests`, `secrets`) retain `passed | failed | skipped` summaries.

Protocol 2 additionally requires:

| Field | Meaning |
| --- | --- |
| `snapshot` | Resolved refs/tree, content and patch digests, mode, dirty/consistency state |
| `verificationPlan` | Required/optional check scopes and, when needed, exact tool-unit identity |
| `executionRecords` | Individual commands/argv/scopes, statuses, exits, timing, output hashes, and available tool/provenance metadata |
| `effectivePolicy` | Resolved gates, thresholds, ignore/accept rules, plugin list, source-file digests, and policy hash |
| `verification` | `passed | failed | incomplete`, strictness, and structured reasons |

Mapping edges distinguish heuristic, structural, and historical evidence with available input digest/origin/freshness. Semantic fingerprints identify gaps/findings separately from display IDs. Accepted gaps remain visible and are excluded from open-gap risk. `summary.risk` is the maximum finding/open-gap risk, not a probability of failure.

Runtime readers validate known structures and supported major versions, reject invalid enums/counters/duplicate identities/inconsistent summaries, and retain unknown optional fields. Explicit normalization covers fields absent from historical 1.0/1.1 evidence; recent compatibility packs must supply required structure. Missing historical provenance remains missing and produces an incomplete decision rather than invented execution proof. Producers use stricter unknown-field schemas. Required-field or semantic breaks need a new major; additive fields do not authorize silently accepting new known-enum values.

## Three identities

- `snapshot.contentHash` and `patchHash` identify captured code inputs and the patch. Snapshot guards detect drift or a target/execution mismatch.
- Receipt `contentHash` identifies the version-specific canonical evidence subset. Object keys are sorted; timestamps, selected timing/output fields, and the post-hash receipt pointer are excluded as implemented by that canonicalization version. Protocol 2 also normalizes temporary execution-directory strings in command arguments.
- Protocol 2 `evidenceHash`, `executionHash`, and `payloadHash` bind the full run and receipt envelope, including volatile metadata. They need not match across repeated runs.

The same canonical input produces the same digest. The same diff does not guarantee identical evidence hashes across policy, tool outcomes, paths, versions, or environments. A digest is not an assertion that the producer executed honestly.

## Receipt 2.0

By default, runs write `<out>.receipt.json`. The envelope includes `canonicalizationVersion: "2"`, evidence and execution hashes, snapshot/policy hashes, effective policy, verification decision, tool identity, argv/options, exit outcome, and generation time. `payloadHash` covers the full envelope except its self-reference and signature. Optional HMAC-SHA256 or Ed25519 signatures authenticate that payload hash.

```sh
patchprove run --out evidence.json
patchprove receipt verify evidence.json
patchprove receipt verify evidence.json evidence.receipt.json --require-signature
patchprove receipt verify evidence.json --require-signature --trusted-key sha256:EXPECTED_HEX
```

`--sign` uses `PATCHPROVE_SIGNING_KEY`: `hmac:<secret>` (or a raw non-PEM secret), `ed25519:<base64 PKCS8 DER>`, or an Ed25519 PEM private key. In protocol 2 a missing key is an error; a malformed key is also an error. Signing variables are removed from spawned tool environments. This does not isolate host filesystem secrets or sandbox project tools/plugins.

Unsigned receipts establish internal integrity only. Verification reports hash/payload matching, cryptographic signature status, and configured signer trust separately. `--require-signature` rejects missing/unverifiable signatures. Ed25519's embedded SPKI public key proves mathematical consistency, not identity; pin its independently trusted SHA-256 DER fingerprint with `--trusted-key`. Supplying trusted keys also requires a signature. HMAC verification requires the shared secret; public-key fingerprint policy applies to Ed25519.

## Historical receipt 1.2

Compatibility evidence uses the historical **1.2.0 receipt**, not a redefined 2.0 signature under an old version number. Its signature covers only the historical canonical evidence hash; receipt metadata is not authenticated. The old algorithm excludes evidence `generatedAt`, check `durationMs`/`detail`, and the receipt pointer. New optional compatibility fields remain part of the otherwise unchanged algorithm. Missing-key signing retains historical behavior in protocol 1.

CLI verification requires `--allow-legacy` to accept this format explicitly. A valid old signature cannot establish trust in unsigned old metadata or supply missing snapshot provenance.

## Artifact sets and SARIF

Evidence, receipt, optional SARIF, and manifest paths must be distinct. Files are staged/replaced and the digest manifest is published last; consumers should validate manifest digests before treating the set as complete. This detects partial/mixed outputs rather than making multiple file renames a universal atomic transaction.

SARIF includes findings, open/accepted gaps, and failed contract clauses. Accepted gaps carry suppression information. Uploading to GitHub Code Scanning requires the appropriate repository permissions and an actual successful upload; generating SARIF alone does not establish that a hosted service accepted it.

`test/sarif-schema.test.ts` validates representative output against the unchanged official OASIS 2.1.0 draft-04 schema pinned in [the fixture provenance](../test/fixtures/schema/provenance.json), including accepted gaps, every failed contract kind, Unicode/reserved characters, and platform paths. The retained OASIS license notice governs that schema. Default tests use vendored bytes and do not fetch schemas. The optional [reviewdog smoke](reviewdog.md) records an actual local consumer run and remains separate from GitHub upload or hosted reporter validation.
