---
title: Standalone
---

# Standalone (experimental)

The supported CLI is still **Node 20+ ESM**. v1.0 ships a **Go thin launcher** that finds `node` and execs `dist/cli.js`. It is not a rewrite.

## Go thin launcher

```bash
npm run build
make go-build          # → bin/patchprove
./bin/patchprove run --help
```

Or:

```bash
go build -o bin/patchprove ./go
```

Resolution order:

1. `PATCHPROVE_CLI` (absolute path to `cli.js`)
2. `cli.js` / `dist/cli.js` next to the binary
3. Walk up from cwd for this repo’s `package.json` (`name: patchprove`) + `dist/cli.js`
4. `node_modules/patchprove/dist/cli.js`

If `node` is missing, the launcher exits `2` and tells you to install Node 20+.

Goreleaser is optional; this repo does not auto-publish binaries. A stub `.goreleaser.yml` documents the layout.

## Not in scope

- Rewriting the CLI in Rust or Go
- Node SEA / `pkg` packaging (see `experiments/standalone/` for a pointer)

The Node `patchprove` / `patchprove-mcp` bins remain the product.
