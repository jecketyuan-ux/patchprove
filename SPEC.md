# patchprove contract

Primary file: [.patchprove/spec.yml](.patchprove/spec.yml)

This repo uses a **lenient** dogfood contract so the evidence pack is always evaluated, without failing CI on residual high-risk path findings. Consumer repos should tighten `maxResidualRisk` and `forbiddenUnproven` until the pack is a real merge gate.

```yaml
schemaVersion: "1.0"
requiredGates: []
maxResidualRisk: critical
acceptedResidualRisk:
  policy: allow
```
