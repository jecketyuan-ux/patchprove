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

### v1.1 — language mapping + external plugins

- Java/Gradle (and Maven) affected-test filtering: multi-module + package-path FQCN, `gradle --tests` / `mvn -Dtest=`
- Go `go.mod` module-path import resolution and coarse `internal/` visibility; `go test ./pkg/...` on affected packages
- Rust Cargo workspace / multi-crate mapping; `cargo test -p <pkg>`
- Documented v1.1 plugin API + deterministic local external plugin load (config / env / `.patchprove/plugins`)
- Golden fixtures for Java, Go, Rust, and plugin load

### v1.0 — merge/agent gate

- **SPEC.md / `.patchprove/spec.yml` contract** — required gates, max residual risk, required mapped tests, forbidden unproven globs, accepted residual-risk policy. Evaluated on `run`; fail-on / exit `1` on contract failure
- **Import/module-graph mapping** (JS/TS + Python heuristics) beside coverage and naming. `mappingStrategy`: `naming` | `coverage` | `graph`
- **Language plugins** — Go, Rust, Java (plus JS/TS/Python) without a CLI rewrite
- **Baseline evidence comparison** — `--baseline`, `.patchprove/baseline.json`, `patchprove baseline save`, new gaps = regression
- **Tighter host integration** — Claude Code SessionStart / SubagentStop; Cursor rule pack; `init-agent --cursor`
- **Docs site** (`docs/`) + case study
- **Experimental Go thin launcher** (`go/`) that execs the Node CLI — not a rewrite

## Next — v1.2

Still deterministic and model-free unless explicitly re-scoped:

- Signed / hashed evidence receipts
- Optional SARIF for contract clauses
- Evidence / contract schema refinements if receipts need new fields
- First-class blocking stop semantics if Cursor adds them
- A real single-binary port only if the Node CLI becomes a liability for air-gapped hosts

Out of scope: telemetry, LLM-as-primary review, vendor API keys, rewriting the entire CLI in Rust.
