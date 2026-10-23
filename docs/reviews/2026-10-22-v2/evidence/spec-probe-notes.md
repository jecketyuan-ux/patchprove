# patchprove 2.0 规格轴审查探针

本记录针对 `188e07e...6fa5097` 升级实现；本次观察代码为 `6fa50972f424ee0b6c8e2b1a8506b7ee3f804f0d`，tree `a617c4a025c3ec598d451092b9c5c3035698995e`。这些是审查证据，不是产品健康回归测试；脚本观察到缺陷时退出 0 仅表示实验及对照正常，不表示产品验收通过。修复后应把期望健康行为转为正式测试。

执行前仓库应已构建并安装依赖。脚本使用该仓库已安装的真实 Vitest，通过 Node 执行其 JS 入口；不下载 runner，不改受审仓库文件，不提交或发布。

```sh
node docs/reviews/2026-10-22-v2/evidence/probe-spec.mjs . /tmp/spec-review-results.json
```

第一个参数为仓库根目录（默认 cwd）；第二个可选参数为结果 JSON。所有 fixture 都建立在独立临时 Git 仓库，使用临时目录内的 node_modules 链接。结果保存 HEAD/tree、Node/OS、完整证据、实际 runner 输出和对照。临时目录故意保留供复核。本目录保存的是主审再次执行产生的 [spec-results.json](spec-results.json)，不是仅转述独立审阅的首次输出。Node v24.19.0/Linux，真实 Vitest 3.2.7；五组实验的 controlsPassed 均为 true。

| 场景 | 观察 | 对照与解释边界 |
|---|---|---|
| `selected-scope-not-executed` | 两个变更测试都进入计划；Vitest exclude 排除一个，实际只运行另一个；执行记录仍声称两文件 passed，严格判定 passed | 原始全量基线通过；移除 runner 排除后的坏补丁全量运行失败。未要求强行执行被配置排除的测试，而是要求显式记录未执行并按策略处理，不能声称已执行。 |
| `unresolved-package-import` | package.json imports 中的 `#value` 未映射；仅 nearby 测试通过，依赖测试漏选；warning 没有触发严格不完整或保守回退 | 同一项目原始全量基线通过；坏补丁全量失败。另建 `relative-import-negative-control`，只将依赖导入形式改为相对路径，测试正确选中、严格判定 failed。未将此个例推算为全生态漏选率。 |
| `all-skipped-variant` | 唯一修改测试被 test.skip 标记，真实 Vitest 输出 1 skipped / 0ms execution，仍得到 passed 和 collectedTests=1 | 基线启用的正常测试通过；取消 skip 后原测试体真实失败。与第一个场景合并为执行核账根因，不另算独立发现。临时 fixture 最后保留的是取消 skip 的对照代码；结果 JSON 中 evidence 属于取消前的准确快照。 |
| `adapter-input-validation` | 未知 Nx status 加 exitCode=0 被解释成 executed；已知 success 加 collectedTests 字符串 "0" 被静默丢字段，均无诊断 | 未知 status 无 exitCode 被拒绝；合法 collectedTests=0 被保留；合法成功及 count=1 正常接收。仅验证公共 reader 契约，不声称完整 analyze 门禁可被绕过；合成导出并非真实 Nx 运行。 |

确认的规格发现为 P1 / P1 / P2 三项。P1 是错误的成功/范围证据；P2 是外部输入契约不严。证据不是远程可利用性证明。未运行其他语言对应同类变体，不能将 Vitest 结果当作 pytest/Go/Cargo/Java 全部版本的验证。
