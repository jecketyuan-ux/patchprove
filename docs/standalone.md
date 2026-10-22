---
title: Standalone
---

# Experimental Go launcher

The CLI and MCP server are Node 22+ ESM programs. The Go launcher locates Node and forwards to the compiled CLI; distributing that executable alone does not provide a standalone verification runtime.

```sh
npm run build
make go-build
./bin/patchprove run --help
```

CLI resolution uses `PATCHPROVE_CLI`, paths next to the launcher, then up to eight ancestor directories for this package or `node_modules/patchprove/dist/cli.js`. Use an explicit absolute `PATCHPROVE_CLI` path when discovery is unsuitable. Missing Node or CLI files cause exit 2. Arguments, stdin/stdout/stderr, and the child exit status are forwarded.

The wrapper does not remove the need for target-project dependencies, Git, language runners, or platform validation. The optional GoReleaser configuration is packaging scaffolding, not proof of released binaries or executed cross-platform tests. A future independent runtime requires separate implementation and validation; it is not part of the 2.0 release claim.
