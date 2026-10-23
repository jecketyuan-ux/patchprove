---
title: Migrate to 2.0
---

# 迁移到 2.0

当前代码实现 2.0.0；这不表示 npm、Git tag 或外部 CI 已经发布/执行。先从本地 checkout 构建，或安装经过检查的本地产物。无需云服务、模型账户或遥测。

## 先比较两种输出

```sh
npm ci
npm run build
node dist/cli.js run --out /tmp/evidence-v2.json
node dist/cli.js run --protocol 1 --out /tmp/evidence-v1.json
```

第一条生成默认 2.0 证据与 2.0 receipt；第二条生成兼容的 1.3 证据与历史算法的 1.2 receipt。它们是两次验证运行，不能假设执行身份或 digest 相同。把输出放在分析范围之外可避免它们影响下一次 working-tree 捕获。

## 默认行为变化

| 项目 | 2.0 默认 | 迁移选择 |
| --- | --- | --- |
| 判定 | passed / failed / incomplete；后两者 exit 1 | 读取 verification.status 与 reasons |
| 严格度 | 必需范围未执行、开放验证 gap、缺来源或快照漂移不通过 | --no-strict 可放宽进程门禁；不会把真实失败改成通过 |
| 兼容形状 | 必需 snapshot、plan、executions、policy、decision | --protocol 1 输出 1.3 并采用兼容默认 |
| 配置 | 未知键报错；非法已知类型立即报错 | 协议 1 记录未知键警告；--strict-config 可升级为错误 |
| 本地插件 | 明确允许后加载 | 审查代码后使用 --allow-plugins |
| 签名 | --sign 缺密钥报错 | 配置签名密钥或显式不请求签名 |

真实失败检查、失败契约和触发的拒绝阈值始终产生 failed。`--no-strict` 的 exit 0 不能被代理当作已完成；只接受 `verification.status === "passed"`。旧 `claimDone` 只是此条件的兼容别名。

## 更新策略与基线

修正拼错的配置键和错误类型。接受聚合 gap 的路径规则必须共同覆盖所有文件；明确 gap ID 表示接受整组。可配置 ruleId、owner、expiresAt、ticket 和 reason。过期规则失效，接受 gap 不影响 findings。契约 requiredGates 不因 disable-gate 自动满足。

旧 baseline 会经过版本/结构校验。没有快照或生效策略的旧文件不能补写成已验证；保留原件，用当前执行结果创建新 baseline。查看 compatibility 与 changedGaps/changedFindings，不能仅检查 newGaps 是否为空。failOnNewGaps 仍只针对新增开放 gap，不自动包含风险升高或新增 finding。

## 更新签名消费者

```sh
patchprove receipt verify /tmp/evidence-v2.json
patchprove receipt verify /tmp/evidence-v2.json --require-signature
patchprove receipt verify /tmp/evidence-v2.json --require-signature --trusted-key sha256:EXPECTED_HEX
patchprove receipt verify /tmp/evidence-v1.json --allow-legacy
```

无签名只证明内部摘要一致。嵌入的 Ed25519 公钥不自动可信；trusted-key 应来自独立可信来源。HMAC 验证需要同一共享密钥。2.0 签名覆盖完整 receipt envelope，包含快照、执行、生效策略、判定与退出信息。1.2 仍使用历史 evidence-only 签名，不能用它认证未签的旧 metadata。

子进程环境去除签名/认证变量；这不是操作系统沙箱。项目检查和本地插件仍可访问运行用户有权访问的文件/网络。对不可信仓库使用外部隔离环境；--isolate 用于固定执行树，不提供该安全边界。按需要设置 --timeout-ms 和 --max-output-bytes。

## 更新入口

未发布 checkout 推荐 `patchprove init-agent --local-cli /absolute/path/to/dist/cli.js`。发布后 MCP 启动应绑定包与 bin：`npx --yes --package=patchprove@VERSION patchprove-mcp`。不要把 bin 名误当作独立 npm 包。

MCP、CLI、hook 与 Action 使用同一判定；产物需按入口的显式参数启用。Claude Code 停止响应受真实宿主协议约束，Cursor followup 是建议而非强制阻断。本地 transport/fixture 通过不能冒充真实宿主验证。跨 Node/OS/native runner 的执行范围见 [validation](validation.md)，导出适配器边界见 [ecosystem](ecosystem.md)。

## Execution-proof hardening before the 2.0 release

New records separate requested/collected/executed/skipped/unknown scopes and counts. An excluded, all-skipped, reporter-missing or partially executed suite can now be incomplete where older producers reported passed. Normal Vitest/pytest runs require fresh machine reports; Java consumes fresh testcase outcomes, Go uses package events, Cargo retains crate granularity. Do not copy argv into scope in custom adapters. Known optional fields remain compatible; contradictory copies or stored decisions are rejected.

`sign:true` creates a receipt through MCP/SDK artifact operations; combining it with `receipt:false` is an error. Missing/invalid required signing material fails before repository checks. Input budgets apply by default and can be raised explicitly. Project policy is additive; required project gates override a global optional disable. Sticky PR comments now default off and remain experimental pending live same-repository/fork acceptance; serialize enabled publishers per PR.

See [execution reports](execution-reports.md), [project policy](project-policy.md), [budgets](resource-budgets.md) and [live-host acceptance](host-acceptance.md). Historical signed bytes are never silently rewritten or re-signed by the reader.

Earlier unpublished 2.0 packs may contain successful test records whose scope only reflected requested argv. Readers retain those historical signed objects unchanged. New completion evaluation requires observed machine-result facts; MCP completion stays false for missing facts. Receipt verification requires explicit `--allow-legacy` for this historical scope contract, even if the v2 envelope signature itself is valid. A genuine old-producer signed fixture protects this compatibility boundary. Imported/cache task metadata cannot replace missing test-result facts in a required execution plan.
