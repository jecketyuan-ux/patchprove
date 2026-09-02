# patchprove GitHub Action

Runs the patchprove CLI on a pull request and posts (or updates) a sticky summary comment.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: jecketyuan-ux/patchprove/action@v0.1.0
  with:
    fail-on: high
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `fail-on` | `""` | `high` or `critical`. Empty means comment only. |
| `cwd` | workspace | Repo to analyze |
| `out` | `evidence.json` | Evidence JSON path |
| `github-token` | `${{ github.token }}` | Needed for the sticky comment |

Permissions: `contents: read`, `pull-requests: write`.
