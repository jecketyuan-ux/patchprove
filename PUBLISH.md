# Publishing patchprove

The package is pack-ready at version **1.2.0**. CI runs `npm pack --dry-run`; nothing publishes automatically.

## What gets published

`package.json` `files`:

- `dist/` — compiled ESM (`bin` → `dist/cli.js`, `patchprove-mcp` → `dist/mcp.js`)
- `schema/` — `evidence.schema.json`
- `action/` — composite GitHub Action
- `examples/` — agent skill, hooks, MCP config snippets
- `README.md`, `LICENSE`

`npx patchprove` resolves the `bin` entry after `npm run build` (also the `prepack` script).

## Maintainer publish

Requires an npm account with access to the `patchprove` package (or first publish if the name is still free).

```bash
npm ci
npm run build
npm test
npm pack --dry-run    # inspect the tarball listing
npm publish           # public; publishConfig.access is public
```

Then tag the release:

```bash
git tag v1.2.0
git push origin v1.2.0
```

Pin the Action at `jecketyuan-ux/patchprove/action@v1.2.0` after the tag exists.

Do **not** publish from CI or from a cloud agent unless `NPM_TOKEN` is present and you intend to release.
