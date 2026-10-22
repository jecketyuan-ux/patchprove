---
title: Validation and delivery
---

The repository separates unit checks, real runtime execution, installed-package checks, and measured selection experiments. CI configuration is an intended gate; a checked-in workflow is not evidence that a remote runner has already passed.

Run the checks from a Node 22 or 24 checkout after `npm ci`:

```sh
npm run build
npm run typecheck:test
npm test
npm run test:runtimes
npm run test:package
npm run test:corpus
```

`test:package` makes a local tarball, installs it into a fresh temporary consumer with `--ignore-scripts`, and checks the installed CLI, public module, receipt verification, and stdio MCP initialization/tool calls. It does not publish to a registry. Installation may download the package's declared dependencies using a temporary npm cache. Runtime CLI/MCP operations use local Git/files and stdio. This proves the tested tarball's behavior in that environment; it does not prove every consumer configuration.

`test:runtimes` reads `test/fixtures/runtimes/manifest.json`. The 30 small fixtures cover Vitest, pytest, Go test, Cargo, Maven, and Gradle, with successful tests, failing tests, no collected tests, multiple modules/packages, and a deliberately unavailable runner. Tests run in temporary copies. For installed toolchains, the harness executes the actual affected-test command and the full suite, checks their expected outcomes, and records commands, counts when available, durations, hashes, and versions. Java full-suite counts come from test-result XML. A successful process with zero collected tests does not count as verification.

Tool availability requires matching version output. In particular, an executable named `go` is not sufficient: GNU Go, the board game, is not the Go compiler. Missing local toolchains are reported as skipped. CI runs `npm run test:runtimes -- --require`, which fails if any required toolchain is unavailable. To isolate one runner, use `npm run test:runtimes -- --engine=python --require`. `PATCHPROVE_RUNTIME_REPORT` selects the JSON report path; the default is the operating system's temporary directory.

The older Go internal-import fixtures remain structural mapping tests. Some intentionally violate Go's `internal` visibility rules and must not be treated as executable successful builds. The new runtime fixtures are independent and contain valid packages.

The checked-in CI matrix covers Ubuntu, macOS, and Windows with Node 22 and 24 for build, TypeScript checking of source/tests, unit tests, and tarball installation. Separate jobs install Python 3.12/pytest, Go 1.23.6, Rust 1.85, JDK 17/Maven, and Gradle 8.12.1 and require real runtime fixtures on all three operating systems. Those external setup/download steps need network access. Action references are immutable commit SHAs resolved from their official repositories. Native runtime results on other operating systems must come from CI; the development environment used to create this work is Linux.

The retained Linux validation uses Node 24.19.0/Vitest, Python 3.12/pytest 8.3.5, Go 1.23.6, Rust/Cargo 1.85, Temurin JDK 17.0.13, Maven 3.9.9, and Gradle 8.12.1. Portable toolchains and dependency caches were prepared under `/tmp`; the initial executable named `go` was GNU Go and was rejected until the real compiler was placed on PATH. Each runtime's five scenarios is checked independently. Missing-runner scenarios deliberately produce skipped records; Go/Cargo/Maven zero-test runs also produce skipped records and cannot establish completion. Vitest/pytest/Gradle report unsuccessful test discovery through nonzero exits.

The [runtime report](validation/runtime-linux-node24.json), [installed-package report](validation/package-linux-node24.json), and [seeded-corpus report](validation/corpus-linux-node24.json) retain the actual local outcomes. The runtime report records selected/full counts and commands; durations include build/tool caches and are not speedup measurements. Native fixture runs caught and led to fixes for Python interpreter fallback that defined tests without invoking pytest and quiet Maven runs that exited successfully with zero tests.

The separate [Node 22 Linux report](validation/node22-linux.json) records an official Node 22.23.4 distribution, verified against Node.js's versioned SHA-256 manifest, with its npm 10.9.9. Build, source/test typechecking, all 414 tests across 46 files, and fresh tarball installation/CLI/MCP/publisher checks passed under that runtime. The project dependencies were reused and its lockfile remained unchanged. Linux is locally verified under Node 22 and 24; macOS and Windows results still require an actual remote CI run.

`test:corpus` starts with three deterministic local seed patches. Its manifest fixes the seed repository commit, patch SHA-256, runtime requirement, test list, and license information. It verifies the baseline, applies a patch, selects affected tests using the core mapping code, and executes selected/full suites. Each result reports failing-test misses, additional selected passing tests, unknown outcomes, dependency diagnostics, and durations. No accuracy percentage or real-world 50-patch result is claimed. A variable dynamic import is included to expose conservative fallback behavior.

Set `PATCHPROVE_CORPUS_REPORT` to retain the JSON report. Additional cases can use `repository.kind: local-checkout` with a prepared local repository path and immutable `baseCommit`, plus a patch/digest, license, environment, and test paths. Pass the manifest with `npm run test:corpus -- --manifest=/absolute/path/manifest.json`. The harness currently runs Node's built-in test runner; other runtimes require an explicit harness implementation. It does not automatically clone or execute downloaded external projects. Review external fixtures and licenses before adding them. Measured misses belong in the report; infrastructure errors and unknown test outcomes fail the harness.

PR evidence execution and publication use separate workflow trust boundaries. `.github/workflows/ci.yml` executes PR code with read-only repository permissions and without persisted checkout credentials, verifies its evidence/receipt integrity and artifact manifest, and uploads JSON/SARIF plus the manifest. `.github/workflows/publish-evidence.yml` runs on the trusted default branch after the named workflow completes. It downloads the artifact from that exact run, restricts the manifest to expected filenames, validates committed bytes, schemas, and receipt hashes, checks the workflow head SHA, and renders Markdown with trusted code. Only the final comment step receives the write token. The publisher does not execute artifact scripts or use PR-provided Markdown. No workflow executes PR code through `pull_request_target` with write credentials.

An unsigned receipt establishes internal integrity and matching metadata, not producer identity or the truth of a declared execution. Workflow provenance and optional trusted signatures are separate controls. A valid report may describe failed or incomplete verification; publishing that report does not change its decision to passed. The workflow-run publisher becomes active after its trusted files reach the default branch.

SARIF output is checked offline by `test/sarif-schema.test.ts` against the unchanged official OASIS 2.1.0 draft-04 schema at commit `1742a253eb654bf8a4ed7c60eaef7412b2c23553`. The fixture retains upstream license terms, source URLs, and SHA-256 digests. Representative cases cover accepted-gap suppressions, failed contracts, Unicode/reserved characters, POSIX/Windows paths, and literal Git backslashes. Invalid enum and URI controls confirm that structural and format validation are active.

An actual optional [reviewdog 0.21.2 local-reporter smoke](reviewdog.md) also passed on Linux with the official checksum-verified binary: five representative SARIF results produced four unsuppressed diagnostics, error-level gating returned 1, empty output returned 0, and a failing Patchprove CLI run retained exit 1 when the reporter succeeded. [The recorded JSON](validation/reviewdog-smoke.json) contains commands, versions, digests, and outcomes. `REVIEWDOG_BIN=/absolute/path/to/reviewdog node scripts/test-reviewdog.mjs` reruns it after building. No default test or CLI operation downloads reviewdog; this does not establish hosted reporter or GitHub upload behavior.

The optional real Cosign SDK smoke also passed on Linux with checksum-verified official Cosign v3.1.4. It verified the official release checksum blob/bundle against the pinned repository trust root and exact certificate identity/issuer, then rejected a modified blob, incorrect identity, and incorrect issuer. All four cases used explicit offline inputs and unusable HTTP proxy settings; [the actual report](validation/cosign-smoke.json) records SDK commands, digests, versions, and results. `COSIGN_BIN=/absolute/path/to/reviewed/cosign node scripts/test-cosign.mjs` reruns the optional harness without downloads. See [ecosystem boundaries](ecosystem.md#optional-offline-cosign-verification); this is not a hosted signing, other-version, or cross-platform validation claim.
