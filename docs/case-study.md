---
title: Case study
---

# Synthetic case: an almost-right login patch

This is an authored example, not a measured production defect or a recall/accuracy study. The author knows the imagined patch omitted a lockout assertion. patchprove does not infer that omission from a nearby mapped test.

| Changed path | Recorded evidence | What remains unknown |
| --- | --- | --- |
| `src/auth/session.ts` | A nearby `session.test.ts` can be mapped; auth/crypto path finding | Whether the changed branch has an assertion or adequate coverage |
| `src/utils/hash.ts` | No mapped test; an unmapped-source gap | Whether a broader suite exercises the helper |
| `.github/workflows/ci.yml` | Workflow path finding | Whether the workflow change is behaviorally correct |

A contract with `forbiddenUnproven: [src/utils/**]` fails for the unmapped helper. Actual failed checks also fail verification. Without those failures, required unexecuted scopes and open verification gaps make a strict run incomplete. The integration fixtures exercise these recorded outcomes; they do not prove the fabricated lockout bug was detected.

Accepting the helper gap preserves that exception in evidence. It cannot remove the auth/crypto or workflow findings. A `failOn: high` policy may therefore still fail. A mapped test is a selection relationship, not a test-quality or branch-coverage verdict.

The repository's lenient dogfood contract checks configuration, artifact, and reporting wiring. Its result is not evidence that strict gates, every supported toolchain, or real host blocking behavior have been validated. See [validation](validation.md) for the checks actually executed.
