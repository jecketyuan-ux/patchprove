---
title: Optional ecosystem evidence
---

patchprove can import explicit Nx, Turborepo, and testmon JSON exports. It does not start those tools, read testmon's private database, query a hosted service, or send source code to a model. The default pipeline needs no model or network service. Installing dependencies and preparing external exports are separate caller actions.

Pass one or more inputs with `--adapter-input nx:plan.json`, `--adapter-input turbo:summary.json`, or `--adapter-input testmon:dependencies.json`. MCP and the library accept `adapterInputs: [{adapter, path}]`.

Each input uses this envelope:

```json
{
  "schemaVersion": "1",
  "adapter": "nx",
  "adapterVersion": "20.0.0",
  "snapshotHash": "<64 hex characters from evidence.snapshot.contentHash>",
  "inputHash": "<64 hex SHA-256 of canonical data JSON>",
  "data": {
    "tasks": {
      "api:test": {
        "target": {"project": "api", "target": "test"},
        "scope": ["apps/api/src/value.ts", "apps/api/src/value.test.ts"]
      }
    },
    "taskResults": {"api:test": {"status": "success", "exitCode": 0}}
  }
}
```

Use the exported `adapterInputHash(data)` helper to generate `inputHash`. It recursively sorts object keys, preserves array order, serializes JSON, and returns lowercase SHA-256 hex. `snapshotHash` must equal the analyzed snapshot's exact content hash. Export this value from the same prepared snapshot as the upstream run; output files must not alter that snapshot. Both hashes are required. A mismatched hash or malformed input produces an error diagnostic and imports none of that input. Hashes bind the declaration to data and a snapshot; they do not authenticate who created it.

The supported formats are deliberately bounded:

| Adapter | Supported exported data | Interpretation |
| --- | --- | --- |
| Nx | `tasks` or `taskGraph.tasks`, as an object keyed by task ID or an array with `id`; optional `taskResults` keyed by task ID | `target.target` chooses `tests`, `lint`, or `typecheck`. Explicit `scope` contains repository paths. |
| Turbo | `tasks` array with `taskId`, `task`, `directory`, `cache.status`, and optional `execution.exitCode/startTime/endTime` | Dry plans contain no execution proof. Directory scope is preserved; provide explicit file `scope` when required by the verification plan. |
| testmon | `{"mappings":[{"source":"src/a.py","tests":["tests/test_a.py"]}]}` | Historical dependency edges, with `origin: testmon-export` and the export digest. An edge does not prove that a test executed. |

Nx task outcomes recognize explicit success/failure/skipped states and local/remote cache hits. Turbo recognizes cache `HIT` and execution exit codes. A failed task takes precedence over a cache declaration. Unknown task states are rejected. These fields describe the supported import contract; arbitrary Nx/Turbo versions or human console output are not promised compatible.

Set `data.mode: "plan"` (or `data.dryRun: true`) when wrapping a dry plan. Predicted cache hits in that plan do not establish that checks executed or their results were reused. Use `data.mode: "run"` for an actual run export. Keep the original machine data fields and add explicit scope only when you can trace it to that run.

The adapter preserves the upstream task states `imported`, `executed`, `cached`, `failed`, and `skipped` in its task result. An upstream execution becomes an `imported` execution record with provenance; a cache hit stays `cached`. Neither becomes a local `passed` record. Plan-only tasks produce no execution records. Build tasks do not prove tests or typechecking. Completion still requires the verification plan's scopes and provenance to match. The CLI does not trust a project directory as a substitute for every required test file.

For Python dependency data, create the documented testmon source-to-test export in your own tooling. patchprove intentionally does not depend on undocumented SQLite schemas or start a testmon collection run. The caller is responsible for ensuring the export describes the named snapshot.

## Optional offline Cosign verification

The library's `verifyCosignBundle` wrapper invokes a caller-installed Cosign using `verify-blob --offline`, a supplied bundle, a supplied trusted-root file, and exact certificate identity/OIDC issuer constraints. All paths and trust values are explicit. It uses the same timeout, cancellation, output limit, and child-environment rules as other commands. It never signs, starts keyless identity login, or fetches trust material on the caller's behalf. Bundle/trust preparation remains an explicit caller action.

A real SDK smoke passed on Linux x86_64/Node 24.19.0 with official **Cosign v3.1.4**, source commit `0e48502cf5ef34e2e60bbd3617aa19945712f705`. The [binary](https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64) SHA-256 is `424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa`, matching the official release checksum list. The binary remains in `/tmp` and is not distributed by patchprove.

The small public fixture is that release's `cosign_checksums.txt` blob and `.sigstore.json` bundle, plus `pkg/cosign/testdata/trusted_root_pgi.json` from the pinned official source commit. [Fixture provenance](../test/fixtures/cosign/provenance.json) records exact source URLs, byte digests, and the retained upstream Apache-2.0 license. The accepted certificate identity is `keyless@projectsigstore.iam.gserviceaccount.com`, with issuer `https://accounts.google.com`; this is fixed smoke-test policy, not a general trusted-signer default.

| Actual SDK case | Result |
| --- | --- |
| Original blob, fixed bundle/root, exact identity and issuer | Exit 0, `Verified OK` |
| Modified blob | Exit 1, signature verification rejected |
| Incorrect certificate identity | Exit 1, identity policy rejected |
| Incorrect OIDC issuer | Exit 1, issuer policy rejected |

[The recorded report](validation/cosign-smoke.json) contains versions, exact SDK-generated commands/argv, digests, durations, stdout/stderr, and outcomes. All four cases used unusable HTTP/HTTPS/ALL proxy settings alongside explicit offline inputs. This checks the offline verification path without ordinary HTTP lookup; it is not an operating-system network sandbox or an upstream signing/build attestation claim. Cosign 3.1.4 emits a deprecation warning for `--offline` and recommends supplying the bundle and trusted root; it still accepts the wrapper's flag, and that warning is retained in the results.

```sh
npm run build
COSIGN_BIN=/absolute/path/to/reviewed/cosign \
  PATCHPROVE_COSIGN_REPORT=/tmp/cosign-smoke.json \
  node scripts/test-cosign.mjs
```

The optional harness requires a pinned local binary, checks its checksum/version, validates fixture digests, and invokes the actual SDK wrapper. It does not download tools, trust roots, or bundles. Default tests and CLI operations do not install or require Cosign. Successful verification of this official fixture does not prove arbitrary producer honesty, receipt semantics, other Cosign versions, hosted signing workflows, or other operating systems.

SARIF can be consumed by reviewdog in the read-only execution job:

```sh
patchprove run --sarif patchprove.sarif --out evidence.json
reviewdog -f=sarif -name=patchprove -reporter=local < patchprove.sarif
```

The local reporter prints annotations without a write token. Preserve the CLI exit code if a verification failure occurs. For GitHub comment publication, use the two-stage workflow described in [validation](validation.md): verify the artifact and regenerate the report using trusted code before supplying a token to the publisher. The repository does not install reviewdog automatically or claim compatibility with every reviewdog version.

## Tested native Turbo producer contract

`exportTurboEvidence({plan, summary?, snapshotHash})` accepts Turbo **2.5.0**, native JSON format `version:"1"`, and joins task scope to the supplied dry plan. It records plan/summary digests in the caller-bound data. Unsupported native versions are rejected rather than guessed. Omitting summary exports a plan with no execution records. A run export preserves executed/cached/failed states as imported evidence, without inventing test counts. The [adapter envelope schema](../schema/adapter.schema.json) is also exported as `patchprove/adapter-schema`. Normalized envelope v1 remains available for existing Nx/Turbo/testmon integrations; Nx and testmon native producer compatibility remains experimental.

Run `TURBO_BIN=/absolute/path/to/turbo npm run test:upstream` with a separately installed 2.5.0 binary. The harness disables Turbo telemetry and exercises actual dry plans, execution, cache hits and failures in a disposable workspace. It never downloads tools or sends feedback. Snapshot/input hashes bind the caller's supplied data; they do not authenticate its producer.
