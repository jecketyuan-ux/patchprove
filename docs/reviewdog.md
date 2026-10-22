---
title: reviewdog SARIF smoke
---

# Optional reviewdog integration smoke

On 2026-10-22, a real **reviewdog 0.21.2** Linux x86_64 binary parsed Patchprove's SARIF with `-f=sarif -reporter=local -filter-mode=nofilter`. The [saved report](validation/reviewdog-smoke.json) records actual commands, exits, stdout/stderr, platform, hashes, and the CLI verification result. This is local reporter validation on Linux/Node 24.19.0, not GitHub publication, a remote CI run, or an assertion of compatibility with every reviewdog version.

## Pinned tool source

- Official [release v0.21.2](https://github.com/reviewdog/reviewdog/releases/tag/v0.21.2).
- Release tag resolves to source commit `a431794dd959800d59924993457dc58b32f03cad` (annotated tag object `b690dba88fcde8e83628d8aec7d67eff1981b7df`).
- [Linux x86_64 archive](https://github.com/reviewdog/reviewdog/releases/download/v0.21.2/reviewdog_0.21.2_Linux_x86_64.tar.gz): SHA-256 `30413aa3c7443e9c3c157fe5766cad40e3bb39a32e210ee69b710a8d5c4b8e51`.
- That archive digest was matched against the release's official [checksums.txt](https://github.com/reviewdog/reviewdog/releases/download/v0.21.2/checksums.txt) before execution. Its extracted binary has SHA-256 `b0c2ceed45468850f9922784ffd90147a3e74246f19686ceec8a1ca95ec390fc`.
- reviewdog is [MIT licensed](https://github.com/reviewdog/reviewdog/blob/a431794dd959800d59924993457dc58b32f03cad/LICENSE), copyright 2016 haya14busa. The downloaded archive contains that license. The binary and archive remain in `/tmp`; neither is vendored into this repository.

The release archive and checksum file were downloaded directly from those official GitHub asset URLs, and only the expected binary/license/readme members were extracted. Checksums detect changed bytes relative to the recorded release; they are not a separate signing or upstream build attestation policy.

## Reproduce with an explicitly installed binary

Prepare a reviewed local reviewdog 0.21.2 binary and build Patchprove. The optional smoke never downloads tools, calls a hosted reporter, or requires a write token:

```sh
npm run build
REVIEWDOG_BIN=/tmp/patchprove-reviewdog-0.21.2/reviewdog \
  PATCHPROVE_REVIEWDOG_REPORT=/tmp/reviewdog-smoke.json \
  node scripts/test-reviewdog.mjs
```

The recorded run used the same command with `PATCHPROVE_REVIEWDOG_REPORT=/workspace/patchprove/docs/validation/reviewdog-smoke.json` to retain the report in the checkout. The script requires the pinned reviewdog version and, on Linux x86_64, checks the extracted binary digest. Other operating systems are not claimed validated by this saved run.

| Case | Observed outcome |
| --- | --- |
| Representative `toSarif` document | Five results became four local diagnostics; the accepted gap was suppressed; parser exit 0 |
| Unicode, spaces, `#`, and literal Git backslash paths | Percent-encoded artifact URIs survived the real parser, including `%5C` for a literal backslash |
| Failed contract and synthetic secret/path findings | Diagnostics retained their rule IDs and levels; no credential values were used |
| `-fail-level=error` | reviewdog exit 1 as expected for error-level diagnostics |
| Empty SARIF results | Exit 0 with empty stdout |
| Actual Patchprove CLI with a required tests gate and no tests | CLI produced `verification.status: failed`, exit 1; reviewdog parsed its SARIF with exit 0; the combined gate remained exit 1 |

The CLI case uses a temporary Git repository, exercises the real compiled CLI, and removes the temporary checkout afterward. The harness itself exits successfully only when all assertions hold; its report records the deliberately failing verification and preserved combined status.

## Preserve the producer's decision

reviewdog's default `-fail-level=none` can exit 0 while reporting diagnostics. Parser success must not replace Patchprove's verification exit status. A shell integration can retain both statuses explicitly:

```sh
set +e
patchprove run --out evidence.json --sarif report.sarif
prove_status=$?
reviewdog -f=sarif -reporter=local -filter-mode=nofilter < report.sarif
reviewdog_status=$?
if [ "$prove_status" -ne 0 ]; then
  exit "$prove_status"
fi
exit "$reviewdog_status"
```

Generating or locally parsing SARIF does not establish that GitHub Code Scanning or another hosted reporter accepted it. The vendored official schema tests and this runtime parser smoke address different boundaries; see [validation](validation.md) for the broader test matrix.
