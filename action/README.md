# patchprove GitHub Action

Run the Action on `pull_request` with read-only contents permission, a checkout of the PR, and `fetch-depth: 0`. Pin the action to a reviewed commit. For forks or other untrusted code, set `comment: false` and publish the saved report from a separate trusted workflow. The action rejects `pull_request_target` analysis because repository tools execute patch code.

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@v4 # Pin to a reviewed commit in production.
    with:
      fetch-depth: 0
      persist-credentials: false
  - uses: jecketyuan-ux/patchprove/action@v2 # Pin to a reviewed commit.
    with:
      fail-on: high
      comment: false
      isolate: true
```

The action writes protocol 2 evidence, an execution receipt, a manifest, and Markdown. `verification.status` must be `passed` for exit 0; failed checks, contracts, thresholds, incomplete required execution, and missing provenance cannot be hidden by a zero-gap summary. `--protocol 1` is available for compatibility through `protocol: '1'`.

Inputs mirror CLI options: `cwd`, `base`, `head`, `config`, `spec`, `baseline`, `fail-on`, `fail-on-new-gaps`, comma-separated `accept`, `ignore`, `disable-gate`, and `adapter-input`, plus `strict`, `isolate`, `timeout-ms`, `max-output-bytes`, `allow-plugins`, and `strict-config`. Artifact controls are `out`, `receipt` (`false` disables), `sign`, `upload-artifacts`, `upload-sarif`, and `sarif-file`. Signing reads `PATCHPROVE_SIGNING_KEY` from the analysis step environment. Keep signing material in a trusted workflow; repository tools do not receive it.

`comment` defaults to true. Publication uses `github-token` only in the publication step and updates a comment only when both its sticky marker and expected bot author match. It paginates comments and retries transient API failures. Publication failures are reported separately and preserve the verification exit status. Upload steps and the final gate run even when publication fails.

Outputs are `status` (0 or 1 when analysis completes), `evidence` (absolute JSON path), and `comment-file` (Markdown path). The `patchprove-evidence` artifact contains the evidence, receipt, manifest, optional SARIF, and Markdown. A trusted `workflow_run` publisher can download that artifact and invoke `action/post-comment.mjs` with `GITHUB_TOKEN`, `GITHUB_EVENT_PATH`, and `COMMENT_FILE`. Only use a publisher from the default branch, constrain the triggering workflow/repository/PR, and treat downloaded report contents as data. Never execute scripts from the downloaded artifact or a PR checkout. Use workflow concurrency per PR to serialize publication.

Receipt verification can require a signature and a trusted key fingerprint:

```sh
patchprove receipt verify evidence.json --require-signature --trusted-key sha256:YOUR_KEY_FINGERPRINT
```

Historical receipts require the explicit `--allow-legacy` compatibility option.

Validate an artifact set before consuming its files:

```sh
patchprove artifacts verify evidence.json.manifest.json
```

The command returns JSON and exits 0 for a matching set, 1 for missing or altered artifacts, or 2 for an unreadable or invalid manifest. Receipts authenticate evidence content; the manifest checks the exact published bytes of every file in the set.

Output destinations must differ from verification inputs. For example, when `--baseline evidence.json` reads an existing pack, write the new pack with `--out current-evidence.json`. This also applies to MCP `baseline` and `out`; an overlapping destination is rejected before writing any artifact.
