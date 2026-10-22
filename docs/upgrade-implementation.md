# 升级实施与验收记录

实施日期：2026-10-22。审查基线：`188e07e` / `1.2.0`。当前工作树实现 `2.0.0`，尚未发布；显式 `--protocol 1` 输出 `1.3.0` 兼容证据及旧版收据。原 [代码审查](reviews/2026-10-22/01-code-audit.md)、[模块评审](reviews/2026-10-22/02-product-modules.md) 和 [升级方案](reviews/2026-10-22/03-upgrade-roadmap.md) 保留为历史记录，不能用其中“尚未实施”的基线描述判断当前代码。

## 工作包对照

| 工作包 | 已实现结果 | 主要实现与验证入口 |
| --- | --- | --- |
| W01 Git 身份与路径 | 最终工作树快照覆盖暂存、未暂存、未跟踪内容；NUL 路径、二进制摘要、初始仓库、范围解析、采集漂移与执行后漂移检查；独立目标 worktree | `src/git.ts`、`src/snapshot.ts`；`test/git.test.ts`、`snapshot.test.ts`、`run-snapshot-drift.integration.test.ts` |
| W02 计划与选择 | 命名、依赖图、覆盖关系保守合并；测试自身变更、删除前图、动态依赖全测试回退、配置/资源的明确缺口；计划范围与实际执行逐项核账 | `src/evidence.ts`、`coverage.ts`、`graph.ts`、`plugins/`；mapping/language/gates 回归及真实原生夹具 |
| W03 统一策略判定 | `passed/failed/incomplete` 单一判定；失败优先；严格默认；完整范围豁免、到期规则、配置类型校验、外部插件显式授权 | `src/decision.ts`、`spec.ts`、`accept.ts`、`config.ts`；decision/spec/accept/config/run-upgrade 测试 |
| W04 执行与扫描 | 总预算传递到 Git、工具探测与执行；进程树终止、取消、stdin、输出字节限制/摘要；全部选定新增行同时接受内建扫描及可选 gitleaks 扫描 | `src/exec.ts`、`detect.ts`、`gates.ts`；exec/detect/git-budget/gates 测试 |
| W05 来源与基线 | 快照、逐执行记录、工具版本、映射来源、同次读取的有效配置/外链契约/基线摘要、稳定指纹、兼容性诊断；产物原子发布及 manifest 独立校验 | `src/run.ts`、`baseline.ts`、`fingerprint.ts`、`artifacts.ts`；baseline/policy-inputs/receipt/artifacts 测试 |
| W06 入口与分发 | CLI/SDK/MCP/钩子共享决策与产物服务；初始化明确 package/bin 与本地路径；循环/总时限控制；规范 SARIF；只读执行与可信代码发布分离 | CLI、mcp、hook、init-agent、Action；实际 stdio/钩子/全新安装测试及 publisher 替身测试 |
| W07 真实执行与平台验收 | 30 个真实 runner 场景、安装包冒烟、测试类型检查、固定工具版本与 CI OS/Node 矩阵 | [原生执行结果](validation/runtime-linux-node24.json)、[Node 22 验证](validation/node22-linux.json)、[安装包结果](validation/package-linux-node24.json)、[验证说明](validation.md) |
| W08 严格协议与迁移 | v2 必需来源/执行/计划/判定；完整载荷签名和独立可信密钥策略；历史 reader、兼容输出、已知主版本可选字段兼容、未知主版本拒绝；Schema 生成 wire types 与漂移检测 | `schema/`、`src/generated/`、`validation.ts`、`receipt.ts`、`scripts/generate-protocol.mjs`；[迁移说明](migration-v2.md) |
| W09 可选生态与语料 | Nx/Turbo 计划/实际/缓存导入、testmon 历史关系影响实际选择、离线 Cosign 包装、真实 reviewdog 本地 reporter、固定补丁语料与可扩展本地 checkout 输入 | `src/adapters.ts`、[生态说明](ecosystem.md)、[reviewdog 验证](reviewdog.md)、`scripts/benchmark-corpus.mjs` |

## 审查问题到回归的对应

| 原问题 | 当前修复与回归 |
| --- | --- |
| F01、F08 | 一致的真实工作树补丁与 Unicode/特殊路径身份；Git/snapshot 测试验证未暂存密钥行、空仓库、重命名/删除与字面量路径。 |
| F02 | 每种语言都有执行记录；缺执行器、只执行部分范围、零收集不再汇总成成功；gates、decision 与 30 个原生场景验证。 |
| F03 | MCP `claimDone` 仅对应共享判定 `passed`；失败与不完整状态均可追踪到原因；实际 stdio 和钩子协议回归。 |
| F04 | 补丁内容而非行数统计进入代码身份；范围在目标快照执行；采集和执行漂移保留为不完整；receipt-v2 与两种 range 集成回归。 |
| F05、F06 | 覆盖率不移除图已知关系；改变测试选自身；删除源码使用 base 图，不能分析的范围保留缺口；mapping-regressions。 |
| F07 | 基线按语义 fingerprint 匹配，严重性/范围变化独立呈现，来源不可比明确说明；baseline 测试。 |
| F09 | v2 签整个收据载荷、完整 evidence 与执行摘要；稳定内容摘要和运行摘要分离；可信 Ed25519 指纹和必需签名策略；旧算法保持原义；receipt-v2 篡改、降级、缺签名和未知 signer 回归。 |
| F10、F18 | 共享 JSON Schema 的运行时 reader 验证结构/版本/计数；历史规范化受版本限制；已知主版本允许新增字段；wire types 从 Schema 生成并检查漂移；validation/protocol 测试。 |
| F11 | gitleaks 不再缩小工作区范围；与内建扫描使用同一选定新增行集合；gates 参数及实际扫描回归。 |
| F12 | 超时状态独立于最后退出码；POSIX 进程组与 Windows 终止适配；有界 UTF-8 捕获、完整输出摘要、取消与 stdin 共用执行器；exec/detect/git-budget 回归。 |
| F13、F14 | 契约非法字段明确报错；契约消费本次 impact 分类，插件源码不会被默认扩展名检查绕过；spec/config 回归。 |
| F15 | 多文件缺口必须被规则共同完整覆盖；显式 ID 语义清晰，接受原因/来源/到期可追溯；accept 回归。 |
| F16 | MCP 转发契约、基线、新缺口阈值、协议、预算、插件授权、adapter 与产物参数；mcp-tools 和实际 stdio 回归。 |
| F17 | `.mts/.cts` 及 JS/TS alias/workspace、Python 子模块、Rust 内联测试与依赖 crate 映射补全；language/plugin 回归。 |
| F19 | 初始化明确版本、bin 和绝对本地 CLI，幂等合并与备份；全新 tarball 消费端实际 MCP 握手和调用成功。 |
| F20 | 收据记录解析后的策略，外链 YAML 及配置/基线绑定实际读取字节；不接受过期判定或与判定矛盾的退出元数据；policy-inputs/receipt-v2 回归。 |
| F21 | 评论限定 bot 作者、marker 和分页，处理重试；评论失败保留验证退出码；可信默认分支校验 manifest/receipt/head 后重建 Markdown，未实际发布评论。 |

## 实施中追加发现并修复的边界

- Python 解释器回退曾直接运行测试文件，测试函数未执行。真实 pytest 失败夹具发现后改用 `python -m pytest`。
- Maven 静默输出曾把空测试类的进程成功当成测试成功。现在只读取本次新增或更新、匹配选定类及模块的 Surefire/Gradle 报告；旧报告或部分模块不能补足未执行范围。
- workspace 包通过 `node_modules` 链接进入活动 checkout，曾使隔离范围执行错误代码。复用依赖前比较源/目标 manifest 并拒绝解析到物理依赖目录外的链接；版本化依赖默认仍参与快照。内部包存储链接可用。依赖复用有明确诊断，不宣称环境完全密封。
- 补丁采集期间发现的漂移曾被之后的新身份覆盖。当前保留采集身份与不一致状态。
- 临时 worktree 路径曾影响稳定哈希；契约、基线与命令路径已规范化。完整运行摘要仍保护原始运行数据。
- 外部策略加载与后续取摘要之间存在时间窗口；配置、契约及基线现在使用同次读取的字节生成身份，并在结束时复查。
- 输出与源代码、配置、契约、基线或目标提交新增文件相撞，以及目录链接别名，均明确拒绝。钩子工作进程也保留真实产物选项用于校验。产物集写入失败回滚、符号链接和并发锁有独立回归。

## 可复核的验收

```sh
npm ci
npm run check:protocol
npm run build
npm run typecheck:test
npm test
npm run test:runtimes -- --require
npm run test:package
npm run test:corpus
npm audit --omit=dev
```

原生测试须先安装 [验证说明](validation.md) 指定工具链；缺工具不能记为通过。可选 reporter 和 Cosign 验证使用显式本地二进制，不在默认命令中下载工具。`patchprove artifacts verify evidence.json.manifest.json` 校验产物集；`patchprove receipt verify evidence.json --require-signature --trusted-key <fingerprint>` 另行实施签名和信任策略。未知签名者、完整性自洽与可信来源是分别报告的事实。

Linux 的 Node 22.23.4 与 24.19.0 均已完成构建、测试类型检查、46 个测试文件/414 项测试和全新安装验证。原生 30 个场景在 Linux/Node 24 上实跑；reviewdog 0.21.2 本地 reporter 与 Cosign 3.1.4 离线正反例也已验证。生产依赖审计为 0 项告警。完整摘要见 [验收记录](validation/upgrade-summary.json)。

Windows/macOS 的外部 CI 和真实 Claude/Cursor 宿主行为仍需要其运行环境验收。仓库 CI 已配置这些检查，不把配置文件当成远程运行成功的证据。三个固定种子补丁的测试选择实验记录漏选、额外执行、未知和耗时，不能推出真实生态准确率，也不冒称完成十项目/五十真实开源补丁的人工作业；该数量在原模块报告中属于建议抽样目标。没有性能或竞品准确率倍数承诺。

没有发布 npm 包、创建 release、上传外部产物或发送 PR 评论。正式发布、维护者灰度切换和跨平台验证属于后续受控交付动作。提交 PR 后按 [发布前验收清单](release-readiness.md) 记录当前 head 的远程 CI 与实际集成结果。核心默认流程继续保持无模型、无遥测和无服务依赖。
