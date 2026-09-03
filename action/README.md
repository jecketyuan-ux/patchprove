# patchprove GitHub Action

Runs the patchprove CLI on a pull request and posts (or updates) a sticky summary comment.

```yaml
# .github/workflows/patchprove.yml
name: patchprove
on: pull_request
permissions:
  contents: read
  pull-requests: write
  # required when upload-sarif: true
  security-events: write
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jecketyuan-ux/patchprove/action@v1.2.0
        with:
          fail-on: high
          upload-sarif: true
```

The action still creates or updates a **sticky** PR comment (`<!-- patchprove-sticky -->`). The markdown has **Open gaps**, **Accepted gaps**, **Contract**, and a **Receipt** section (content hash). A later run on the same PR notes **unchanged** / **changed** versus the last comment. `evidence.json` and the receipt are uploaded as the `patchprove-evidence` artifact.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `fail-on` | `""` | `high`, `critical`, or `none`. Empty means use `.patchprove.yml` (or comment only). |
| `cwd` | workspace | Repo to analyze |
| `out` | `evidence.json` | Evidence JSON path |
| `accept` | `""` | Comma-separated gap ids or path patterns to accept |
| `ignore` | `""` | Comma-separated path globs to exclude |
| `upload-sarif` | `false` | Generate SARIF (findings, gaps, **failed contract clauses**) and upload via `github/codeql-action/upload-sarif@v3` |
| `sarif-file` | `patchprove.sarif` | SARIF path when `upload-sarif` is true |
| `receipt` | `""` | Receipt path. Empty writes `<out>.receipt.json`. Set to `false` to skip. |
| `upload-artifacts` | `true` | Upload `evidence.json` and the receipt as workflow artifacts |
| `github-token` | `${{ github.token }}` | Needed for the sticky comment |

## Permissions

| Permission | When |
| --- | --- |
| `contents: read` | Always |
| `pull-requests: write` | Sticky PR comment |
| `security-events: write` | Required for `upload-sarif: true` |

SARIF upload uses GitHub code scanning. **`security-events: write` is required** when `upload-sarif: true` — without it `upload-sarif` fails. On fork PRs the token may not be allowed to write security events — omit `upload-sarif` or run it only on same-repo PRs.

The SARIF run includes findings, gaps, and **failed contract clauses** (so Code Scanning shows a broken SPEC gate). Accepted gaps are included with `suppressions.status: accepted` so they stay visible without failing the scan the same way as open gaps.
