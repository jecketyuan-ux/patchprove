# 2.0 复审后的升级实施与验收

日期：2026-10-23（Asia/Shanghai）。基线 `6fa5097`，分支 `codex/patchprove-v2-hardening`。依据 [复审 U01–U11 方案](../reviews/2026-10-22-v2/03-upgrade-roadmap.md)。历史审查及验收 JSON 保留原观察时点；本次结果见[候选索引](../validation/release/current.json)。本记录不是 npm/tag/release 发布声明。

| 工作包 | 已实现内容 | 实际验收和边界 |
| --- | --- | --- |
| U01 执行范围核账 | 新鲜 JSON/JUnit、Go 事件、Cargo crate 汇总；请求/收集/执行/跳过/未知分别记录；缺报告和部分执行保持不完整 | 六执行器 30 场景；真实继承 pytest 用例暴露并修复归属问题。项目自带 skip、Java helper 未执行仍明确阻断严格完成 |
| U02 解析与回退 | package imports 条件/通配/最近作用域；内部/外部/内置分类；坏配置、动态、内部未知保守回退；解析配置/输入摘要 | `#value`、覆盖组合、正常外部依赖、baseUrl、坏配置、删除/测试变更回归。不是完整编译器语义 |
| U03 单一事实 | 拒绝副本冲突、重复身份、退出码/计数/范围矛盾及错误存储判定；SDK 直接求值也不能放过副本冲突 | reader/收据/MCP/共享判定回归；已知历史包兼容，不改写签名字节 |
| U04 adapter 合同 | 原子拒绝未知状态、非法计数/时间/cache/dryRun；公开 envelope schema；原生 producer 显式版本合同 | 真实 Turbo 2.5.0 plan/run/cache/failure；Nx/testmon 标准化导出保留，任意原生版本兼容仍为实验性 |
| U05 入口参数 | sign-only 创建收据；签名与 no-receipt 冲突、缺/坏 key 提前失败；连续 MCP 调用保留签名材料且不下传 | CLI/SDK/MCP 有效签名和验证、冲突及缺/坏 key 回归；签名/信任/完整性继续区分 |
| U06 publisher 时序 | PR head 两次复核；可信 head/run/attempt 标记；拒绝旧 attempt；按 PR 串行；有界输入/网络 | 本地分页、伪 marker、旧 head/attempt、最后复核、重试和原门禁保留通过。评论默认关闭；真实同仓库/fork 完整矩阵仍需外部验收 |
| U07 依赖与账本 | Vitest 固定 4.1.12，Vite/worker/source map 链更新；逐公告处置和候选索引 | 完整与生产审计均为零，不等于所有依赖绝对安全；旧 PR #7 CI 仅作历史记录 |
| U08 生产链 | 安装 tarball 后原始 detectTools/插件执行；修复 pytest 模块发现回退；真实扫描器矩阵；CI 扩展 | 本地安装链 24 场景、Gitleaks 8.24.3 十场景通过；本环境没有真实 Claude/Cursor，不将 stdin 替身当宿主验收 |
| U09 资源与环境 | 文件/总字节/数量/JSON/图预算；流式快照；期限/取消；拒绝不可读取的大型产物；工具/锁/配置摘要及非密封标签 | 独立进程 64 MiB 拒绝、深度 1000 JSON、16 MiB 快照、32 MiB 取消测量。同步段轮询 deadline，异步取消在下个让出点处理 |
| U10 项目与上游 | 共享执行单元；项目 required/optional/not-applicable、原因/到期、适用范围与 cwd；插件能力声明；真实 Turbo exporter | 项目必需门禁、独立 Vitest 配置、到期例外、密钥适用性回归；真实 reviewdog 本地 SARIF 消费。Cosign 固定版本 SDK 离线四场景通过 |
| U11 真实语料 | 独立 native 全量真值、受控补丁、选择/执行、失败归因/unknown/额外选择/阻断/耗时、来源许可证 | 首批五项目/五语言/十补丁；八个已归因失败单元未观察到漏选；三例正常补丁因 skip/未知范围被严格策略阻断。不是历史 PR，不宣称零漏检或性能倍数 |

构建、Schema 漂移检查、源码/测试类型检查和 Node 22/24 回归通过，具体计数、命令、版本及摘要以候选账本为准。安装包、真实 runner、外部服务和语料分别记录，不能互相替代。新 CI 增加原始安装链与资源/上游合同门禁；远程结果只能绑定实际运行的 PR head。

迁移说明：[执行事实](../execution-reports.md)、[项目策略](../project-policy.md)、[资源预算](../resource-budgets.md)、[生态合同](../ecosystem.md)、[2.0 迁移](../migration-v2.md)。真实语料用 `npm run test:projects -- --manifest=/absolute/path/local-manifest.json` 运行；[模板](../../examples/corpus/real-projects.json) 固定仓库提交和补丁，依赖及本地路径由调用者显式准备，不自动克隆执行外部代码。

外部出口继续保留 `not-run`：[真实宿主与 GitHub 验收表](../host-acceptance.md)。没有记录，不能宣称 Claude/Cursor 强制行为或完整 fork publisher 已稳定。十项目/五十历史补丁和更多构建模型属于语料扩展，不把十个受控样本改名成五十个真实变更。SaaS、遥测、LLM 主判定、重写及通用缓存按方案继续暂缓。

本次公开 registry 只读查询返回 `1.0.0`、`1.1.0`，未发现 `2.0.0`，因此保留未发布候选版本；查询不构成发布授权。没有发布 npm 包、tag 或 release。

后续 CI 暴露并保留两项条件：大型自审报告需显式匹配生成/reader/publisher 的 JSON 预算；Windows Gradle 8.12.1/JDK17 的中文路径验收使用明确的 UTF-8 JVM 配置，默认 ANSI 环境的 ClassNotFound 失败不计作断言执行。旧 2.0 无机器事实的数据可按原签名字节读取，但新的完成判定保持 incomplete，收据兼容验证需显式 allow-legacy。

最终核心代码候选与本地全套记录见 [fbaa4cb 账本](../validation/release/fbaa4cb/candidate.json)。CI 自审显式忽略自己的存档数据，Git 快照身份仍绑定全部存档字节；源码、测试和正常门禁不在该忽略范围。最终 PR head 需重新通过完整远程 CI。
