---
title: Input budgets and environment provenance
---

CLI, SDK and MCP share bounded input reads. Defaults are 32 MiB per file, 256 MiB total distinct input paths, 50,000 files, 8 MiB JSON, nesting depth 64, 200,000 JSON structural tokens, and 500,000 graph relationships/import expressions. JSON budgets are checked before parsing. Artifact serialization also rejects packs exceeding their configured reader budgets before publishing any file. Snapshot blobs are streamed through hashing/compression. Exceeded budgets produce an explicit error; they never become empty successful analysis.

| CLI / Action input | SDK / MCP `inputLimits` |
| --- | --- |
| `--max-input-file-bytes` | `maxFileBytes` |
| `--max-input-total-bytes` | `maxTotalBytes` |
| `--max-input-files` | `maxFiles` |
| `--max-json-bytes` | `maxJsonBytes` |
| `--max-json-depth` | `maxJsonDepth` |
| `--max-json-nodes` | `maxJsonNodes` |
| `--max-graph-edges` | `maxGraphEdges` |

All values must be positive safe integers. Explicitly raise a budget for known large repositories, for example `--max-input-file-bytes 67108864`. This does not increase process output limits (`--max-output-bytes`) or the total deadline (`--timeout-ms`). SDK callers may provide `signal: AbortSignal`; MCP tool cancellation/transport and execution timeout are separate host concerns. Deadline checks span Git/input/graph/tool phases; bounded synchronous parsing polls deadlines, and event-loop cancellation takes effect at the next asynchronous boundary.

`environment` records OS/architecture, Node/Git identity, detected tool paths/versions, dependency-lock hashes, known native configuration hashes and effective input limits. It deliberately does not capture all environment variables. `hermetic:false` remains explicit: installed dependencies, ignored/generated files, external configuration, network services, arbitrary plugin code and unrecorded target/environment settings are not sealed. Snapshot isolation is not an OS sandbox.

`npm run test:resources` measures fixed oversized/deep inputs, streamed capture and cancellation in separate processes with a 256 MiB V8 heap limit. The JSON report records hardware, RSS, CPU, sizes, timings and cancellation latency. Measurements describe one environment; defaults are bounded engineering choices, not universal performance guarantees.

For intentionally larger evidence packs, pass the same trusted JSON ceiling to `patchprove receipt verify`, for example `--max-json-nodes 2000000 --max-json-bytes 16777216`. Reader ceilings are explicit caller policy; the reader never expands limits just because an artifact asks for them. The trusted publisher has a fixed 16 MiB/two-million-token ceiling and abbreviates Markdown for the PR comment while preserving full artifacts.
