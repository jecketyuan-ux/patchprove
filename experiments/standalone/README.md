# Node Single Executable Application / pkg

v1.0 ships the **Go thin launcher** (`go/` + `make go-build`) instead of SEA/`pkg`.

Those Node packagers are brittle with ESM + optional native bits and are not required for the Node CLI.

If you experiment here, keep `npm run build` / `node dist/cli.js` as the source of truth and do not break the published `patchprove` bin.
