---
title: Project policies and runner working directories
---

Project policies supplement global gates in `.patchprove.yml`. A required project gate executes even when that optional global gate is disabled. An explicit not-applicable policy requires a reason. Expired exceptions become required. Date-only expiration is the end of that UTC day. Paths must resolve to directories inside the repository; duplicate/escaping paths and unknown keys are rejected.

```yaml
gates: { typecheck: false, lint: false, tests: true, secrets: true }
projects:
  - path: packages/api
    gates:
      tests: required
      lint: required
  - path: packages/fixtures
    gates:
      lint:
        mode: not-applicable
        reason: Public upstream parser fixtures
        expiresAt: 2027-01-01
```

A project is applicable when changed paths or selected tests affect it, or its repository policy changes. `projectScopes` records that decision. The nearest declared applicable project owns a selected test. Commands run from that project's directory and use its own detected configuration/tools; shared root Node binaries may supply a declared but missing local tool. This does not prove that installed dependency bytes are identical or sandboxed.

Required project tests with no selected mapping conservatively select all known project tests; no known test scope/executor remains incomplete. Required missing linters/typecheckers do not disappear behind global disable flags. Optional gates follow the global setting. Not-applicable gates retain their reason in plan/records. Secrets exceptions exclude only owned project paths; explicit required secrets still execute when the global optional scanner is disabled.

Plans and runners consume shared execution-unit descriptions. Plugins can declare `capabilities` (`contractVersion:1`, tested runner versions, granularity, report formats, `unknownResult:"incomplete"`). Legacy plugin shape remains loadable with explicit local authorization; unsupported result formats cannot manufacture successful execution proof. See [plugins](plugins.md), [execution facts](execution-reports.md), and [resource budgets](resource-budgets.md).
