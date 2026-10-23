# 2.0 发布前验收清单

本次复审后的实现与验收以 [U01–U11 实施记录](upgrades/2x-hardening.md) 和候选账本为准。下表保留上一轮本地验收历史；新候选必须绑定自己的源码身份、CI 和产物。Claude/Cursor 与 fork publisher 尚无本次真实宿主记录，保持实验性，不能勾成已验。


当前交付为 2.0 升级 PR。提交、合并和正式发布分别记录：只有该 PR 当前 head 的远程必需 CI 检查通过后才合并；本轮不创建 release/tag，不执行 `npm publish`。代码能力及 F01–F21 对照见 [实施记录](upgrade-implementation.md)，发布操作见 [PUBLISH](../PUBLISH.md)。

以下“已验”只适用于链接报告中的环境和实现。候选提交有影响行为的修改时，重跑相应检查；不能把旧提交的绿色结果移到新提交。

## 已执行的本地验收

| 状态 | 范围 | 证据 |
| --- | --- | --- |
| 已验 | Linux / Node 22.23.4：构建、测试类型检查、46 个文件 / 414 项测试、全新 tarball 安装与 CLI/MCP 调用 | [Node 22 报告](validation/node22-linux.json) |
| 已验 | Linux / Node 24.19.0：构建、测试类型检查、协议生成一致性、46 个文件 / 414 项测试 | [验收摘要](validation/upgrade-summary.json) |
| 已验 | Vitest、pytest、Go、Cargo、Maven、Gradle 的 30 个真实 runner 场景，覆盖成功、失败、零收集、多模块、缺 runner | [原生执行报告](validation/runtime-linux-node24.json) |
| 已验 | 本地 tarball 的空消费端安装、CLI、SDK、实际 stdio MCP、收据及可信 publisher 数据校验 | [安装包报告](validation/package-linux-node24.json) |
| 已验 | reviewdog 0.21.2 本地 SARIF reporter 与门禁退出码保留 | [实际结果](validation/reviewdog-smoke.json) |
| 已验 | Cosign 3.1.4 离线正确签名通过，篡改内容、错误 identity/issuer 拒绝 | [实际结果](validation/cosign-smoke.json) |
| 已验 | 生产依赖审计 0 项已知公告 | [审计结果](validation/dependency-audit.json) |

## 合并门槛：远程 CI

- [ ] 记录升级 PR 链接、当前 head SHA 和 CI run URL；本地摘要不能代替远程结果。
- [ ] `.github/workflows/ci.yml` 的 Ubuntu/macOS/Windows × Node 22/24 构建、生成一致性、类型检查、全套测试及 tarball 消费端检查全部成功。
- [ ] 三个 OS 的原生 runner job 安装指定工具链并以 `--require` 完成全部场景；工具缺失不能使整个验收静默跳过。故意缺 runner/零收集夹具须符合其预期不完整语义。
- [ ] Go 启动器构建及 CLI 冒烟成功；PR evidence job 产出的 evidence/receipt/manifest 可复核。
- [ ] 对失败检查保留 job 日志与复现；修复后等待新 head 的检查完成。取消、排队、跳过和未触发均不记为成功，不绕过分支保护。

建议将远程验收记录存为 `docs/validation/release/<candidate-sha>/ci.json`，包含 run/job URL、attempt、OS、Node/工具链版本、结果、artifact 摘要及候选 SHA；链接到 PR。只在该记录存在后把 Windows/macOS 改标“已验”。

## 发布门槛：真实宿主

在真实消费项目中，用候选构建的绝对 CLI 路径执行 `init-agent --local-cli /absolute/path/to/dist/cli.js`。保留宿主准确版本、OS、安装配置、候选 SHA 和脱敏交互记录。CLI stdin 替身测试不能勾选以下项目。

| 状态 | 操作 | 通过条件 |
| --- | --- | --- |
| 待验 | Claude Code：分别制造 `passed`、断言失败、缺 runner/零收集；触发 `Stop` 与 `SubagentStop` | `passed` 正常结束；失败/不完整响应被宿主按阻断协议处理；拒绝原因对应同一 evidence，不能误报已完成。 |
| 待验 | Claude Code：实际编辑触发 `PostToolUse`，新会话触发 `SessionStart` | 上下文进入正确会话和项目；不会撤销已完成编辑或声称这两个事件能阻断写入。 |
| 待验 | Claude Code：慢检查期间取消；重复 Stop，观察 `stop_hook_active`；输入损坏和预算耗尽 | 检查及后代进程结束，无残留；再入不形成无限循环；超时/错误不能转成通过，宿主仍能响应用户操作。 |
| 待验 | Cursor：失败/不完整结果触发 stop followup；重试到 loop limit，并由用户主动结束 | 实际 followup 与证据一致、循环有界；用户能够结束；报告准确称其为建议，不称强制阻断。 |
| 待验 | Cursor：取消慢检查、含空格路径和多 workspace 的实际项目 | 使用正确 cwd，不跨项目写产物；取消后无残留进程；不会把别的 workspace 的通过结果用于当前项目。 |
| 待验 | 两个宿主：通过安装后生成的 MCP 配置实际启动 server 并调用两个工具 | 握手及工具调用成功；CLI/MCP/钩子对同次证据的判定一致；`claimDone` 只对应 `passed`。 |

记录建议：`docs/validation/release/<candidate-sha>/claude-code.md` 与 `cursor.md`；每项包含复现步骤、预期、实际、关联 evidence/receipt 摘要和通过/失败/未判定。不提交凭证、私有代码或未脱敏宿主日志。

## 发布门槛：GitHub 实际端到端

可信 publisher workflow 只有进入默认分支后才生效。因此以下验证可在升级 PR 合并后、正式发布前，以最小验收 PR 完成；不把本地 publisher 替身结果当作已发送评论。

| 状态 | 操作 | 通过条件 |
| --- | --- | --- |
| 待验 | 同仓库验收 PR：分别提交通过、失败/不完整样例 | 执行 job 保持只读；artifact 包含固定文件；可信默认分支校验 head、manifest、schema、receipt 后生成报告。报告忠实保留失败/不完整，不因发布成功改成通过。 |
| 待验 | 从 fork 发起验收 PR | PR 代码不取得写权限或发布凭证；可信 publisher 只读取对应 run 的数据，正确识别目标 PR；不执行 artifact 脚本或直接采用其 Markdown。 |
| 待验 | 更新同一 PR，多页已有评论并存在相同 marker 的其他作者评论 | sticky 评论仅更新预期 bot 作者的目标评论；不覆盖其他作者内容；保留新 head/run 关联。 |
| 待验 | 权限不足、缺 artifact、错误 head/摘要、取消 run 等异常 | 不发布伪造或不匹配数据；错误可定位；评论/上传错误不覆盖原始验证门禁结果，artifact 与日志仍可追踪。 |
| 待验 | 对外声称支持 GitHub SARIF 上传时，实际执行相应上传步骤 | GitHub 接受 SARIF，路径和诊断对应候选证据；否则仅声明已验证本地 SARIF/reviewdog，不声明 Code Scanning 已验。 |

记录建议：`docs/validation/release/<candidate-sha>/github.md`，列出同仓库/fork PR、workflow run、artifact 和实际 bot 评论链接及测试权限。不要为了通过验收放宽写权限、改用带写凭证的 `pull_request_target` 或绕过校验。

## 效果宣称门槛：真实开源语料

当前 [语料结果](validation/corpus-linux-node24.json) 只有三个确定性种子补丁。它证明实验流程可运行，不能证明真实项目准确率。原评审提出的十项目/五十补丁是建议抽样规模，不是提交此升级 PR 的硬门槛。

- [ ] 为真实样本固定仓库、许可证、base commit、补丁来源及 SHA-256、依赖/工具链和全量测试命令；先验证未打补丁时的基线。
- [ ] 人工确认补丁改变的行为及应失败测试；分别跑选中集合与全量集合，区分真正漏选、额外执行、回退、环境错误和 flaky。不能建立真值的样本标为未判定。
- [ ] 对新增运行时实现明确的语料 harness；现有 `benchmark-corpus.mjs` 的 Node 内建 test runner 不能冒称已经比较了 Python/Go/Rust/Java 真实项目。
- [ ] 在 `docs/validation/release/<candidate-sha>/corpus/` 保留 manifest、人工归因、分母、结果和环境；任何效果或性能声明都引用这些测量条件。不承诺未经证明的“零漏检”。

## 正式发布前最后核对

- [ ] 复核 [开发依赖公告快照](validation/development-dependency-audit.json)：本次完整审计报告 7 项公告（含 2 项 critical），生产依赖审计仍为 0。涉及 Vitest/Vite 测试工具链、worker 与 source-map；默认 CI 使用只读 `vitest run`，不启用可远程访问的测试 API/开发服务器，发布包不携带开发依赖。仍需逐项记录版本修复及调用链分诊，不能把生产审计为 0 写成全部依赖无公告，也不能用强制升级跳过迁移验证。
- [ ] 本页仍为“待验”的支持平台/宿主能力已取得实际记录；未验证能力明确缩小公开支持范围，不能直接勾选完成。
- [ ] 对候选提交重新核对迁移文档、依赖审计、包内容与版本；从最终 tarball 验证双 bin、协议 1/2、安装后 schema、签名策略及产物验证。
- [ ] 维护者保留灰度项目的旧/新判定差异、缺工具/缺证据原因及回退记录，不把兼容开关当作隐藏实际失败的方法。
- [ ] 发布操作单独记录候选 SHA、tarball digest、registry/tag 目标和结果。本清单及 CI 均不会自动执行发布。
