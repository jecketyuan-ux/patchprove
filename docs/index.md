---
layout: home
title: patchprove
---

# patchprove

Evidence for a patch: snapshot, impact, checks, gaps, and a shared verification decision. The working tree implements 2.0.0; release and external validation are separate activities. No LLM, hosted service, account, or telemetry is required by patchprove.

Protocol 2 defaults to strict verification. `passed` exits 0; `failed` and `incomplete` exit 1; invalid input/runtime errors exit 2. Compatibility output is available through `--protocol 1`. A pass means the recorded policy held, not that every branch is correct.

- [Migration to 2.0](migration-v2.md) — strict defaults, compatibility output, signing changes
- [Upgrade implementation](upgrade-implementation.md) — W01–W09 and F01–F21 implementation and acceptance evidence
- [Contract](contract.md) — required gates, risk, and mapped-test policies
- [Mapping](mapping.md) — selection evidence and uncertainty
- [Plugins](plugins.md) — language support levels and local-code trust
- [Baseline](baseline.md) — semantic identity, scope/severity changes, compatibility
- [Schema and receipts](schema.md) — digests, signed envelopes, and signer trust
- [Validation](validation.md) — executed tests versus configured CI/host support
- [reviewdog smoke](reviewdog.md) — optional real SARIF consumer and verification exit preservation
- [Ecosystem](ecosystem.md) — exported task evidence and optional Cosign verification
- [Synthetic case study](case-study.md) — what a sample can actually establish
- [Experimental launcher](standalone.md) — Go wrapper that still requires Node

Start with the repository [README](../README.md). Historical [review records](reviews/2026-10-22/01-code-audit.md) describe the audited baseline and remain unchanged.
