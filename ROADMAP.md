# Roadmap

patchprove stays an **evidence pack + gap driver**: impact → checks → gaps → risk. Model-free. Not a CI replacement, not an LLM reviewer.

## Done

### v0.1 — evidence pack CLI

- `patchprove run` on a working tree or `base...head` range
- Naming-heuristic test mapping for JS/TS and Python
- Deterministic gates when tools exist: typecheck, lint, affected tests, secret scan
- High-risk path findings, versioned `evidence.json`, sticky GitHub Action comment
- `--fail-on high|critical`

### v0.2 — config, accepted gaps, coverage mapping, SARIF

- `.patchprove.yml` / `.yaml` (`failOn`, `ignorePaths`, `gates`, `acceptGaps`) with CLI override
- Known-accepted gaps that remain visible but do not inflate risk / fail-on
- Coverage-map test selection (`coverage/coverage-final.json`, `coverage.xml`) with naming fallback
- Action markdown sections for accepted gaps; optional SARIF upload
- npm pack-ready `0.2.0`

### v0.3 — MCP, agent hooks, init-agent, cc-kit skill

- stdio MCP server (`prove_patch`, `list_gaps`) via `@modelcontextprotocol/sdk`
- Claude Code + Cursor hook examples; `patchprove hook stop|post`
- `patchprove init-agent` writes skill + hook merge + optional `.mcp.json`
- Skill at `examples/skills/patchprove/` installable with [cc-kit](https://github.com/jecketyuan-ux/cc-kit) from a git path (no npm publish required)
- Pack-ready `0.3.0`

## Next: v1.0

Still deterministic and model-free:

- **SPEC.md / contract file** — declare required gates and accepted residual risk in-repo
- **Richer test selection** — import/module-graph mapping beside coverage (still no LLM)
- **Language plugins** beyond JS/TS/Python (Go, Rust mapping) without a rewrite
- **Tighter host integration** — more hook events / first-class Cursor rule pack if the hosts add blocking stop semantics

Out of scope until a later track: Rust/Go single binary, telemetry, LLM-as-primary review.
