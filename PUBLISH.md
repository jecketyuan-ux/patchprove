# Publishing patchprove

The working tree declares **2.0.0**. This does not establish an npm release or tag. Do not assume an `@v2` Action tag or registry version exists. Publishing is a separate maintainer decision.

## Package contents

`package.json` includes `dist/`, `schema/`, `action/`, `examples/`, current `docs/`, `README.md`, and `LICENSE`. Audit records under `docs/reviews/` and raw candidate archives under `docs/validation/` are excluded from the tarball and remain available in Git. npm also includes its standard package metadata. Inspect the real tarball listing; this list is not a substitute for it. Both bins belong to the **patchprove** package: `patchprove` and `patchprove-mcp`.

```sh
npm ci
npm run build
npm test
npm run pack:check
npm pack
```

Before publishing, install the tarball in a clean environment and exercise both bins, MCP transport initialization/tool calls, installed schema loading, protocol 1/2 output, receipt verification, and artifact validation. The maintained test/CI definitions are described in [docs/validation.md](docs/validation.md); record which checks actually ran, including native runner/OS gaps. Keep package-content assertions aligned with the manifest.

Review the migration, dependency audit, package contents, and host examples. Signing credentials must stay out of repository tool environments and published files. Test workflows do not imply automatic publication.

Stable release requires the exact candidate to pass [all live acceptance gates](docs/upgrades/2.0-stabilization.md). Run `npm run check:acceptance -- --ledger /reviewed/acceptance.json --tarball /reviewed/patchprove.tgz` from its clean source checkout. Every current-head CI job, Windows group, Claude/Cursor scenario and same/fork publisher scenario must pass. Missing or not-run resources block release. `PATCHPROVE_ACCEPTANCE_LEDGER` and `PATCHPROVE_ACCEPTANCE_TARBALL` provide the same explicit paths for lifecycle/automation use; no default archive or older green record is inferred. This command validates recorded consistency and raw bytes, not producer honesty. Review the actual linked runs before release authorization.

Normal publication from a source checkout runs this gate through `prepublishOnly`. Packing and installing remain available without a completed live ledger. `--ignore-scripts` explicitly bypasses npm lifecycle hooks and is not an approved release procedure; the hook is an operational guard, not a security boundary.

After release authorization, a maintainer with npm access may run `npm publish`, then create and push the reviewed `v2.0.0` tag. Update registry examples and pin Action usage to that released, reviewed commit. These external operations are not performed by documentation or package verification.
