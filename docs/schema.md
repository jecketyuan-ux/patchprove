---
title: Schema
---

# Evidence schema stability

patchprove publishes a versioned evidence pack (`schema/evidence.schema.json`) and, from v1.2, a sibling **receipt** (`schema/receipt.schema.json`).

`schemaVersion` on the pack and `evidence.schemaVersion` in code are **semver for the JSON shape**, not the npm package version. Package / `toolVersion` can move independently (for example v1.1.0 still emitted evidence `schemaVersion` `1.0.0`).

## Semver rules (1.x)

| Change | What we do |
| --- | --- |
| Additive optional field, new optional enum member, or new optional sibling document (receipt) | Stay on **1.x**. Current packs emit **1.2.0**. Older 1.0.x packs remain valid 1.x documents. |
| Rename, remove, or change the meaning of a required field; tighten a required enum; change hash algorithm | Bump the **major** `schemaVersion` (`2.0.0`) and call it out in the changelog. |
| `toolVersion` / npm package | Follows the package semver. Does not by itself bump `schemaVersion`. |

The published JSON Schema accepts any `schemaVersion` matching `^1.[0-9]+.[0-9]+$`. Consumers should:

- Treat unknown **optional** fields as ignorable.
- Reject a **major** they do not understand.
- Not require a specific 1.x patch (a 1.0.0 pack is still a 1.x pack).

CI and unit tests validate fixtures and freshly built packs against `schema/evidence.schema.json`.

## Receipt (v1.2)

`patchprove run` writes `<out>.receipt.json` by default (`--receipt [path]`, `--no-receipt` to skip).

The receipt records:

- `contentHash` — `sha256:` + hex digest of a **canonicalized subset** of the evidence
- `toolVersion`, `evidenceSchemaVersion`
- `argv` and an effective-options summary
- `exitCode` and `failOnOutcome` (`ok` / `fail-on` / `contract` / `new-gaps`)
- per-check digests (`command` + `exitCode` + `status`)
- optional `signature` (`hmac-sha256` or `ed25519`)

Hash input **excludes** wall-clock fields: `generatedAt`, `checks[].durationMs`, `checks[].detail`, and the post-hash `receipt` pointer. Object keys are sorted so the same stable fields always hash the same.

**Success bar:** the same diff, run twice → the same `contentHash`.

```bash
patchprove run --out evidence.json          # also writes evidence.receipt.json
patchprove receipt verify evidence.json
patchprove receipt verify evidence.json evidence.receipt.json
```

### Optional signing

`--sign` uses `PATCHPROVE_SIGNING_KEY`. If the env var is empty, signing is skipped and the receipt is still hashed.

| Key form | Algorithm |
| --- | --- |
| `hmac:<secret>` or any other non-PEM string | HMAC-SHA256 over the `contentHash` string |
| `ed25519:<base64 PKCS8 DER>` or a PEM `BEGIN PRIVATE KEY` | Ed25519 over the `contentHash` string; the receipt stores the SPKI public key so verify does not need the private key |

This is a checksum plus an optional MAC/signature — not a PKI, timestamp authority, or “verified build” ceremony.

## Contract results in SARIF

SARIF 2.1 (`--sarif`) includes **failed** contract clauses as results (rule ids `required-gate`, `max-residual-risk`, `required-mapped-tests`, `forbidden-unproven`, `accepted-residual-risk`) in addition to findings and gaps. GitHub Code Scanning shows them when the Action runs with `upload-sarif: true` and `security-events: write`.
