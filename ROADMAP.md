# Roadmap

Current follow-up: [U01–U11 implementation and acceptance](docs/upgrades/2x-hardening.md), based on the immutable [2.0 re-audit](docs/reviews/2026-10-22-v2/03-upgrade-roadmap.md). Implemented code, measured results and external not-run gates are tracked separately.


The working tree implements the 2.0 upgrade; publishing and external validation remain separate activities. The dated [2026-10-22 review](docs/reviews/2026-10-22/03-upgrade-roadmap.md) is an immutable historical assessment, not a current feature-status list.

## Implemented in this checkout

- Final-working-tree and resolved-range snapshots, content/patch digests, drift checks, and optional isolated execution.
- Planned scopes and per-unit execution records; one shared passed/failed/incomplete decision across CLI, MCP, hooks, and Action.
- Conservative test selection, changed-test execution, scoped skips, bounded processes, and signing-variable removal from tool environments.
- Validated policy/acceptance, semantic baseline fingerprints, versioned readers, and protocol 1 compatibility output.
- Protocol 2 receipt envelopes, optional HMAC/Ed25519 signing, explicit signature/trusted-key policy, and artifact manifests.
- Explicit local-plugin permission, corrected package/bin launchers, and export-based Nx/Turbo/testmon adapters with optional offline Cosign bundle verification.

Implementation and fixture coverage do not establish complete language semantics, native runner compatibility, external CI results, or live host enforcement. Current evidence belongs in [docs/validation.md](docs/validation.md).

## Release gates

1. Complete build, regression, package-install/transport, native-runner, schema, and artifact checks in the intended environment.
2. Execute and retain results from the declared Node/OS CI matrix; resolve failures before declaring those platforms validated.
3. Exercise actual supported host versions, including cancellation, re-entry, and advisory/blocking responses.
4. Review tarball contents, migration guidance, dependency state, and release references before a separate authorized publish/tag operation.

## Further work

- Expand real-project corpora and report denominators for missed affected tests, unknown scopes, fallbacks, and false blocking.
- Broaden language/build-system semantics where current heuristics explicitly report uncertainty.
- Add adapters only against documented machine interfaces with version, input, and snapshot provenance; distinguish cached, imported, and executed results.
- Consider a standalone runtime only if measured deployment needs justify replacing the experimental Node-dependent launcher.

No telemetry, hosted service, LLM dependency, or ecosystem performance claim is part of this upgrade.
