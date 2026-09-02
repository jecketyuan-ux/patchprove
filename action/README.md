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
      - uses: jecketyuan-ux/patchprove/action@v0.3.0
        with:
          fail-on: high
          upload-sarif: true
```

The action still creates or updates a **sticky** PR comment (`<!-- patchprove-sticky -->`). The markdown now has separate **Open gaps** and **Accepted gaps** sections.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `fail-on` | `""` | `high`, `critical`, or `none`. Empty means use `.patchprove.yml` (or comment only). |
| `cwd` | workspace | Repo to analyze |
| `out` | `evidence.json` | Evidence JSON path |
| `accept` | `""` | Comma-separated gap ids or path patterns to accept |
| `ignore` | `""` | Comma-separated path globs to exclude |
| `upload-sarif` | `false` | Generate SARIF and upload via `github/codeql-action/upload-sarif@v3` |
| `sarif-file` | `patchprove.sarif` | SARIF path when `upload-sarif` is true |
| `github-token` | `${{ github.token }}` | Needed for the sticky comment |

## Permissions

| Permission | When |
| --- | --- |
| `contents: read` | Always |
| `pull-requests: write` | Sticky PR comment |
| `security-events: write` | Required for `upload-sarif: true` |

SARIF upload uses GitHub code scanning. On fork PRs the token may not be allowed to write security events — omit `upload-sarif` or run it only on same-repo PRs.

Accepted gaps are included in SARIF with `suppressions.status: accepted` so they stay visible without failing the scan the same way as open gaps.
