---
layout: home
title: patchprove
---

# patchprove

**Evidence pack for AI/agent patches: impact → checks → gaps → risk.**

Model-free verification so humans and agents know what is still unproven before merge. Not a CI replacement. Not an LLM reviewer. Strong enough to use as a **merge / agent gate**.

```bash
npx patchprove run --fail-on high
npx patchprove run --base origin/main --head HEAD --fail-on high --out evidence.json
```

Exit `1` when residual risk meets `--fail-on`, when a loaded **contract** fails, or when `--fail-on-new-gaps` sees a new high gap versus baseline.

## Docs

- [Contract (`SPEC.md`)](contract.md) — required gates, max residual risk, mapped-test globs
- [Test mapping](mapping.md) — naming, coverage, import graph
- [Language plugins](plugins.md) — JS/TS, Python, Go, Rust, Java
- [Baseline comparison](baseline.md) — regression gaps
- [Case study](case-study.md) — an almost-right agent PR caught by patchprove
- [Standalone launcher](standalone.md) — experimental Go thin wrapper around the Node CLI

Source: [github.com/jecketyuan-ux/patchprove](https://github.com/jecketyuan-ux/patchprove)
