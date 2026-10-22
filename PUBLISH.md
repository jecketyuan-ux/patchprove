# Publishing patchprove

The working tree declares **2.0.0**. This does not establish an npm release or tag. Do not assume an `@v2` Action tag or registry version exists. Publishing is a separate maintainer decision.

## Package contents

`package.json` includes `dist/`, `schema/`, `action/`, `examples/`, `docs/`, `README.md`, and `LICENSE`. Dated audit records under `docs/reviews/` are excluded from the tarball. npm also includes its standard package metadata. Inspect the real tarball listing; this list is not a substitute for it. Both bins belong to the **patchprove** package: `patchprove` and `patchprove-mcp`.

```sh
npm ci
npm run build
npm test
npm run pack:check
npm pack
```

Before publishing, install the tarball in a clean environment and exercise both bins, MCP transport initialization/tool calls, installed schema loading, protocol 1/2 output, receipt verification, and artifact validation. The maintained test/CI definitions are described in [docs/validation.md](docs/validation.md); record which checks actually ran, including native runner/OS gaps. Keep package-content assertions aligned with the manifest.

Review the migration, dependency audit, package contents, and host examples. Signing credentials must stay out of repository tool environments and published files. Test workflows do not imply automatic publication.

After release authorization, a maintainer with npm access may run `npm publish`, then create and push the reviewed `v2.0.0` tag. Update registry examples and pin Action usage to that released, reviewed commit. These external operations are not performed by documentation or package verification.
