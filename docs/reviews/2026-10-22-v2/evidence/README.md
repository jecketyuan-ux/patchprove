# 2.0 复审证据索引与重放说明

审查日期：2026-10-22 UTC。固定 checkout `6fa50972f424ee0b6c8e2b1a8506b7ee3f804f0d`；main merge `dc79f449f0d919a395c9132d44575267066b34ad`；共同 tree `a617c4a025c3ec598d451092b9c5c3035698995e`。配套 [代码审查](../01-code-audit.md)、[模块评审](../02-product-modules.md)、[升级方案](../03-upgrade-roadmap.md)。

## 证据清单

| 编号 | 文件 | 证明范围与限制 |
| --- | --- | --- |
| E01 | [local-validation.json](local-validation.json) | 本轮协议生成检查、构建、测试类型检查成功，Node 24.19.0/Linux；47 文件、433 项，430 pass、3 平台限定 skip、0 fail。保留逐文件摘要与原始 Vitest JSON 摘要值；完整运行日志在本次 workspace 的 `/tmp/patchprove-v2-reaudit-tests.log` |
| E02 | [remote-ci.json](remote-ci.json) | 通过 GitHub 只读 API 取得的 run/job/step 元数据；run 39816468628、attempt 1、head 6fa5097、11 job success。记录本轮读取时间及原运行时间。不是本轮重新触发 CI，不把 main merge SHA 冒称原 run head |
| E03 | [probe-spec.mjs](probe-spec.mjs)、[spec-results.json](spec-results.json)、[说明](spec-probe-notes.md) | 真实 Vitest 的 R01 排除/全 skip、R02 package imports；R04 adapter 合成输入。5 组场景和负对照均正常运行；完整 evidence、runner 输出、原始基线与改变后全量结果保留。未实测其他 runner 的同类反例 |
| E04 | [probe-record-consistency.mjs](probe-record-consistency.mjs)、[record-consistency.json](record-consistency.json)、[contradictory-evidence.json](contradictory-evidence.json) | R03 未签名合成数据：副本矛盾/嵌套重复被 reader 接受，MCP 可返回 claimDone。不是可信签名绕过；合成 snapshot/hash 不代表真实执行 |
| E05 | [probe-entry-boundaries.mjs](probe-entry-boundaries.mjs)、[entry-boundaries.json](entry-boundaries.json) | R05 的真实 MCP SDK 调用与 sign-only/receipt 对照；R06 的本地 fetch 替身。未发远程 GitHub 评论、未提供真实 token |
| E06 | [npm-audit-all.json](npm-audit-all.json)、[npm-audit-production.json](npm-audit-production.json) | 本轮 lockfile 审计，保存命令/时间/原始 npm 结果；7 受影响包、10 唯一 GHSA URL；生产 0。公告存在不等同项目可利用性已证实，未执行 audit fix |
| E07 | [external-sources.json](external-sources.json) | 9 个官方文档/仓库页面摘录，7 份官方 LICENSE 文本及来源、读取时间。含 Nx/Turbo/testmon/reviewdog/CodeRabbit/PR-Agent/Cosign/StrykerJS。是在线文档调研，不是这些产品的实跑对比 |
| E08 | [manifest.json](manifest.json) | 本目录证据及三份报告的 SHA-256/字节数；生成时绑定代码树。仅方便发现意外修改，未签名，不认证作者身份 |

## 重放

从仓库根目录运行，先安装当前锁文件依赖并构建。已有完整构建时不需要为阅读报告重复安装。下面探针使用独立临时仓库和本仓库已安装 runner，不下载工具、不修改产品源码、不创建 PR 或发布。

```sh
npm ci
npm run check:protocol
npm run build
npm run typecheck:test
npm test

node docs/reviews/2026-10-22-v2/evidence/probe-spec.mjs . /tmp/patchprove-v2-spec-repeat.json
node docs/reviews/2026-10-22-v2/evidence/probe-record-consistency.mjs
node docs/reviews/2026-10-22-v2/evidence/probe-entry-boundaries.mjs
```

**探针退出 0 表示预期反例及对照成功复现，不表示产品健康或修复完成。** 当前 `passed` 反例正是报告建议阻止发布的依据。修复后应将健康预期转换成正式回归，并在新候选记录结果；不要保留“发现错误所以成功”的审查断言作为产品验收门槛。

`probe-spec.mjs` 在临时目录保留 fixture，路径见其结果。Linux 是本轮复现环境；虽然已有三 OS 的产品 CI，本轮新探针没有因此自动成为三 OS 已验。`probe-record-consistency.mjs` 还会写 `/tmp/patchprove-v2-contradictory-records.json` 和 `/tmp/patchprove-v2-standards-repro-results.json`，仅包含合成数据。入口探针在结束时删除自己的临时项目。

依赖审计可重跑 `npm audit --json --package-lock-only` 及加 `--omit=dev` 的变体；随公告源变化结果可能不同，应保存新时间与锁文件身份。外部文档为检索时的动态分支/页面快照，不声明永久不变；接入组件前需固定实际版本。PR-Agent 当前主分支许可证不能倒推为所有历史版本许可。

## 证据边界

- 当前项目历史验收位于 [docs/validation](../../../validation.md) 及相关 JSON。新报告保留它们原样，并指出当前状态页尚未同步远程结果。
- 既有原生 harness 注入部分工具检测和 JS 命令；它证明真实 runner 行为，不单独证明全部生产发现链。
- 未完成真实 Claude/Cursor 宿主、实际同仓库/fork publisher 端到端、真实 gitleaks 全矩阵及十项目/五十真实补丁研究。它们是后续验收，不是本报告已经运行的实验。
- 签名/manifest 自洽、真实执行、策略满足、程序正确和业务需求完成分别需要不同证据；不得互相替代。

## 校验本目录

`manifest.json` 覆盖三份报告、此索引和全部其他证据文件，不包含它自身。可使用任何 SHA-256 工具按其 `path`（相对于 `docs/reviews/2026-10-22-v2/`）逐项复算。manifest 不属于受审产品产物，也不伪称是 patchprove 签发的收据。
