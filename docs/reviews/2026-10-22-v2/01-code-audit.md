# patchprove 2.0 项目代码审查报告

审查日期：2026-10-22（UTC）。本轮目标：独立判断 **2.0 发布门槛与后续 2.x 路线**。本报告评审当前实现，不覆盖或改写 [1.2.0 历史审查](../2026-10-22/01-code-audit.md)。配套：[功能与数据评审](02-product-modules.md)、[升级方案](03-upgrade-roadmap.md)、[证据索引](evidence/README.md)。

## 1. 结论和审查基线

**建议暂缓正式发布当前 2.0 候选。** 项目已经具备值得继续建设的架构基础：统一三态判定、真实代码身份、可追溯策略、受限子进程、版本化协议和完整载荷签名均已落地；跨平台 CI 也已真实通过。但本轮真实 Vitest 项目复现了两条严格模式错误放行路径：已选择测试未执行却被记为成功，以及未解析的仓库内别名导致关联失败测试漏选。它们直接影响产品的核心承诺，应先修复再发布。

这不是“所有旧问题仍未修复”，也不是“CI 通过没有价值”。原有缺陷的大部分具体触发方式已有修复和回归；新增反例说明，部分更广泛的验收目标仍未实现。导入证据、adapter 输入、签名参数和评论时序另有边界缺陷。**合并条件已经满足的事实，与现在发现需要补做的发布修复应分别记录。**

| 项目 | 本次固定值或结果 |
| --- | --- |
| 实际评审 checkout | `6fa50972f424ee0b6c8e2b1a8506b7ee3f804f0d`，package `2.0.0` |
| 已合并 main | `dc79f449f0d919a395c9132d44575267066b34ad`，来自 [PR #7](https://github.com/jecketyuan-ux/patchprove/pull/7) |
| 代码树一致性 | 两个提交 tree 均为 `a617c4a025c3ec598d451092b9c5c3035698995e`；当前审查可用于该合并代码树 |
| 升级回溯起点 | `188e07e03da3f3a21cd64f574f35a1fab0a384c7` / `1.2.0` |
| 本轮重新执行 | 协议生成一致性、构建、测试类型检查成功；Linux / Node `24.19.0`，47 文件、433 项测试：430 通过、3 项平台限定跳过、0 失败 |
| 远程证据 | [CI 39816468628](https://github.com/jecketyuan-ux/patchprove/actions/runs/39816468628)，head 为 `6fa5097`、attempt 1，11 个 job 全部 completed/success |
| 远程范围 | Ubuntu/macOS/Windows × Node 22/24；三个 OS 的原生 runner 夹具；Go 启动器；只读 PR evidence。以 [记录](evidence/remote-ci.json) 的 job/step 为准 |
| 新反例 | 真实 Vitest、未签名合成证据、adapter 数据、MCP 调用、评论 API 本地替身；详见各问题的验证边界 |
| 本轮变更 | 仅新增审查报告和复现材料；未改产品功能，未发布包/tag/release，未发送远程评论 |

严重度含义：P1 表示常规使用下核心验证结论错误，应阻止当前候选发布；P2 表示受限输入/集成条件下的正确性或可信度缺陷，应在对应能力正式承诺前解决。未发现可据现有证据定为 P0 的问题。依赖公告的 critical/high 等级不直接换算为项目 P0/P1。

## 2. 设计理念、需求、目标与 RoadMap

### 2.1 从实现还原产品定义

README 定义的主链路是 **snapshot → impact → planned checks → execution → gaps → decision**。产品服务于本地开发者、编码代理、CI 维护者及审阅证据的维护者：对一个明确 Git 变更，说明哪些检查被要求、哪些真的执行、哪些仍缺证据，并让这些结论能跨入口和机器读取。

其差异化是确定性的“变更验证记录与策略判定”。业务需求是否正确、测试断言是否充分、任意动态语言依赖是否全部可知，均不能由 `passed` 自动证明。无 LLM、无默认遥测、无服务依赖是有效的产品边界；让 CLI/SDK/MCP 共用内核比各入口复制规则更符合这一定位。

| 需求/承诺 | 实现与测试入口 | 当前用户结果 |
| --- | --- | --- |
| 验证的是实际补丁内容 | `git.ts`、`snapshot.ts`；Git、snapshot、drift 集成测试 | 工作树/范围身份与漂移已有较完整闭环；执行环境并非密封环境 |
| 测试选择有依据，不因额外数据缩小已知关系 | `evidence.ts`、`graph.ts`、`coverage.ts`、plugins；mapping/language 测试 | 并集及动态回退已落地；未解析静态别名仍可能漏选，见 R02 |
| 已要求范围都有执行证明或缺口 | `run.ts:122`、`gates.ts`、`decision.ts`；原生及 gates 测试 | 跨语言缺 runner 能识别；同一 runner 内的实际执行范围仍失真，见 R01 |
| CLI/MCP/钩子/Action 解释一致 | `decision.ts`、`run.ts`、`mcp-tools.ts`、`hook.ts` | 决策函数共享；共享错误会同时传播，参数组合仍有 R05 |
| 外部数据经结构和语义验证 | JSON Schema、`validation.ts`、`adapters.ts` | 基础类型/版本检查显著改善；跨副本不变量和未知状态仍有 R03/R04 |
| 收据绑定本次结果，并区分来源信任 | `receipt.ts`、`artifacts.ts`；receipt-v2/artifacts 测试 | v2 完整载荷签名已实现；校验和、签名、可信 signer 是三个不同问题 |
| 成熟开源交付可复核 | CI、安装包 harness、CONTRIBUTING、发布清单 | 远程矩阵真实通过；当前文档未跟进，真实宿主和 GitHub publisher 验收仍缺 |

### 2.2 RoadMap 的实际完成程度

当前 [ROADMAP](../../../ROADMAP.md) 已将“实现”“发布门槛”“后续生态”分开，方向合理。原方案的 W01—W09 在代码中都有对应物，但不能把“存在实现”直接写成“所有验收完成”：

| 原工作包 | 当前状态 | 本轮判断 |
| --- | --- | --- |
| W01 Git 身份与路径 | 主要目标已实现并有回归 | 保留大文件/特殊 Git 布局的边界；未发现旧混合暂存问题回归 |
| W02 验证计划与选择 | **部分满足** | R01/R02 直接违反完整执行与不确定时回退的目标 |
| W03 统一策略判定 | 主流程已实现 | 必须确保其输入真实且一致；目前无法替上游弥补 R01/R02/R03 |
| W04 执行资源与扫描 | 主要目标已实现 | 子进程已受控；进程外的文件读取/同步压缩仍有资源边界 |
| W05 来源与基线 | 主要机制已实现 | 标识与签名不等于执行真实性；现有执行事实仍需 R01 修复 |
| W06 入口与分发 | **部分满足** | R05/R06；实际宿主与 fork publisher 尚未完成验收 |
| W07 平台与真实执行 | 已有真实远程矩阵 | 原生 harness 有工具注入边界；未覆盖本轮选中但被排除/全跳过案例 |
| W08 严格协议 | **部分满足** | 协议形状/签名已实现，语义一致性仍有 R03 |
| W09 生态与语料 | 有限实现与样例 | 自定义导出契约，非任意上游原生格式；R04；三个种子不能证明真实准确率 |

下一步应以验证不变量为单位修复，而非再增加一轮语言数量、签名算法或前端展示功能。具体实施拆解见 [升级方案](03-upgrade-roadmap.md)。

## 3. 方法、范围与证据强度

代码阅读覆盖核心分析/执行/决策/协议、五类插件、配置与契约、基线、产物、CLI/SDK/MCP/钩子、Action、安装包、CI 与 Go 启动器。对升级 diff 同时进行独立的规范轴与规格轴审阅，并在临时 Git 仓库构造新反例。没有对生产项目进行攻击或发送远程写操作。

- **已复现缺陷**：可由本目录脚本重放，包含对照或明确实际输出。真实 runner 与合成输入分别标注。
- **静态分析风险**：代码路径存在风险，但未在本轮压测或真实平台触发，不提升为已复现漏洞。
- **功能缺失/设计限制**：产品尚未建设，或文档明确不承诺，不与实现 bug 混淆。
- **未验证事项**：宿主、真实 GitHub 端到端、真实项目统计等缺少足够证据，不能写成通过或失败。

本轮测试 [摘要](evidence/local-validation.json) 说明现有断言通过；新增审查脚本是当前反例的记录，不是已经并入产品测试的修复回归。远程 CI 属于同一代码树的既有成功运行，本轮读取并留存其结果，未把它伪称为新触发的 CI。

## 4. 已复现问题与修复验收

### R01 · P1 · 请求测试范围被直接当作实际执行范围

**位置**：[gates.ts](../../../src/gates.ts) 25—37、91—117、170—191；[decision.ts](../../../src/decision.ts) 73—86。

**触发与复现**：临时项目中修改 `good.test.js` 与 `blocked.test.js`；后者包含失败断言，却被 Vitest `exclude` 排除。运行默认协议 2 分析；再用不排除该文件的配置运行全量测试作为对照。另有仅包含 `test.skip` 的真实 runner 变体。

**实际**：第一种只运行 1 文件/1 测试，记录的成功 `scope` 却包含两个选择路径，最终 `strict:true / passed / reasons:[]`。对照执行被排除文件失败。全跳过变体中 runner 显示 1 skipped、测试执行时间 0ms，仍形成 `passed`、`collectedTests:1` 的记录。

**预期**：请求集合、收集集合、实际执行集合、跳过集合分开。未观察到执行的必需文件必须产生未完成范围；全跳过不能作为必需运行成功，除非策略有明确、可追溯的豁免。

**根因与影响**：除 Java 的新鲜报告核账外，其他 runner 将命令参数中的完整 `scope` 传给成功记录，仅从人类输出提取总数。总数包含 skipped 等状态，无法证明逐路径执行。影响 CLI/MCP/钩子/Action 共用的判定输入；本轮确认 Vitest，Python/Go/Rust 同类边界需要补测，不能直接断言它们全部复现。

**建议**：以受支持版本的机器报告建立 `requested/collected/executed/skipped` 集合及测试结果状态；报告缺失/未知格式时保守 `incomplete`。不得通过加大总数、重命名 `collectedTests` 或输出中搜索路径来补齐证明。

**回归**：两个文件仅一个被执行、全 skip、部分 skip、deselected、runner filter、reporter 失败、输出截断、单个项目零执行但另一个项目成功，以及对应正常全部执行对照。证据：[规格探针](evidence/probe-spec.mjs)、[结果](evidence/spec-results.json)。

### R02 · P1 · 仓库内静态别名未解析，警告未阻止漏选放行

**位置**：[plugins/js.ts](../../../src/plugins/js.ts) 159—215；[graph.ts](../../../src/graph.ts) 94—100；[evidence.ts](../../../src/evidence.ts) 159—189。

**触发与复现**：`package.json` 定义 `imports: {"#value":"./src/value.js"}`。同名测试只断言值大于 0，另一个测试通过 `#value` 断言值等于 1。将源码从 1 改为 2，运行 patchprove，再运行全量 Vitest。相对导入对照能被正确映射。

**实际**：只选中同名通过测试；`#value` 依赖产生 warning，未产生足以阻止严格通过的缺口。patchprove 为 `passed`，全量 runner 发现依赖测试失败。

**预期**：解析受支持的 package imports；无法证明相关仓库内依赖时，在受影响项目/语言范围回退，或明确 `incomplete`。不能将“还有一个测试可运行”当作其余依赖均已覆盖。

**根因与影响**：JS resolver 处理 tsconfig/jsconfig paths 与包 exports，未处理本例 package imports；只有 `mapping-dynamic-dependency` 触发全已知测试回退。未解析的内置模块、外部依赖、仓库内别名共用 warning，丢失了采取策略所需的分类。影响常规 Node package imports 项目；其他未解析形式是待验证风险，不扩展为已证实列表。

**建议与回归**：区分内置/外部/内部已解析/内部未解析/动态；支持最近 package scope、条件与通配 imports，并保留解析器版本及配置来源。测试本例、`#x/*`、条件导出、嵌套 package、坏配置、外部 `node:` 内置模块，以及未知内部路径触发安全回退的反例。证据同 R01。

### R03 · P2 · 导入证据的两份执行事实可以矛盾

**位置**：[validation.ts](../../../src/validation.ts) 96—120；[decision.ts](../../../src/decision.ts) 29；[run.ts](../../../src/run.ts) 265—273。

**触发与复现**：从合法形状的协议 2 合成证据出发，同一 ID 的顶层 `executionRecords` 保持 `passed/exitCode:0`，仅把 `checks[].records` 副本改为 `failed/exitCode:1`。分别调用 `validateEvidence`、`evaluateVerification` 和 MCP `listGaps({evidencePath})`；另插入嵌套重复 ID。

**实际/预期**：读取器接受两个反例；矛盾包被判 `passed`、`claimDone:true`。应拒绝身份重复及事实冲突，错误指向具体 JSON pointer。当前仅校验顶层 ID 与若干摘要计数，决策优先顶层数组。

**影响边界**：这是未签名导入数据的一致性缺陷。未证明正常新运行会产生这种矛盾，未测试或宣称绕过可信签名。修改已有可信签名的 evidence 仍应导致绑定哈希失配；签名也不能替生产者自动验证语义。

**建议与回归**：以一份执行事实为权威，其他视图由引用/投影生成；兼容期对两个副本强制一致，校验 checkId、scope、status、exitCode、计数及 decision。覆盖空数组遮蔽、嵌套重复、同 ID 不同检查、摘要不符、缺计划单元及历史 1.x 的合法差异。证据：[脚本](evidence/probe-record-consistency.mjs)、[结果](evidence/record-consistency.json)、[输入](evidence/contradictory-evidence.json)。

### R04 · P2 · adapter 对未知任务状态和错误计数字段未严格拒绝

**位置**：[adapters.ts](../../../src/adapters.ts) 54—68、118—129；对照 [导出契约](../../ecosystem.md) 的 unknown/malformed 拒绝承诺。

**复现**：两个 Nx 导出输入分别包含未知 `status` 加 `exitCode:0`，以及已知 success 加字符串 `collectedTests:"0"`，摘要与 snapshotHash 均合法。前者被接受为 task executed / record imported，后者丢弃错误计数，两者均为 `diagnostics:[]`。合法 success/数值计数和未知状态无 exit0 是对照。

**预期/原因**：应先校验枚举与字段类型，再推导执行结果；目前 `exit===0` 分支早于未知状态拒绝，计数只在合法时复制，非法时静默忽略。影响调用者生成或上游演进后的导出文件。

**边界**：已证明 reader 不遵循契约，未证明该输入单独足以绕过完整 `analyze` 的计划/本地执行门禁。建议 versioned adapter Schema、原子拒绝单份非法输入、状态与退出码冲突检查；回归覆盖未知/空值/负数/字符串计数、cache 与 failure 冲突、plan 误当 run、缺 scope。证据同 [规格结果](evidence/spec-results.json)。

### R05 · P2 · MCP 显式签名请求可以被静默忽略

**位置**：[mcp-tools.ts](../../../src/mcp-tools.ts) 68—71；对照 [schema 签名约定](../../schema.md)。

**复现**：未设置签名 key，调用 `provePatch({cwd, sign:true})`，不设置 out/receipt/sarif。调用返回，未生成 receipt，也未报缺 key。加入 `receipt:true` 的对照立即报 `Signing was required but no signing key was provided`。

**原因/影响**：是否进入产物分支只看 out/sarif/receipt，不看 sign；代理能提出签名要求而得不到显式错误。这里没有产生“伪造的有效签名”，问题是输入意图与执行行为不一致。

**建议/验收**：将 sign 与 receipt 的组合规则集中校验：明确要求签名即生成 receipt，或要求 caller 显式请求 receipt 并返回组合错误；`sign:true, receipt:false` 同样不得静默。验证缺 key、错误 key、合法 key、receipt 路径和 CLI/SDK/MCP 参数矩阵。证据：[脚本](evidence/probe-entry-boundaries.mjs)、[结果](evidence/entry-boundaries.json)。

### R06 · P2 · 旧 CI 运行可以覆盖新 head 的 sticky 评论

**位置**：[post-comment.mjs](../../../action/post-comment.mjs) 27—32、60—74；[verify-publish.mjs](../../../scripts/verify-publish.mjs) 31—34；[publisher workflow](../../../.github/workflows/publish-evidence.yml)。

**复现**：本地 API 替身返回现有 bot 评论，描述较新的 head B；传入旧 run/head A 及其 Markdown。publisher 直接 PATCH 替换为 A，未查询 PR 当前 head，也无按 PR 的时序约束。未向 GitHub 实际发评论。

**预期/影响**：迟到的旧 run 不应把“当前结果”覆盖成旧结果。现有校验只证明 artifact 属于触发该 publisher 的 run，不证明它仍是 PR 最新 head。作者限制、分页与重试修复仍有效，但不足以解决时序。

**建议/回归**：保留结构化 head/run/attempt 元数据；在发送前核对 PR 当前 head，并按 PR 串行处理、拒绝已过时结果。对同 head 不同 attempt 定义顺序；无法完全消除 API 检查与写入之间竞争时，展示明确 head/run 链接并避免称为当前结论。验证旧成功晚于新失败、重跑、关闭 PR、fork、权限失败；本轮不宣称修改了分支门禁或能利用写权限执行 PR 代码。证据同 R05。

### R07 · P2 · 当前验收文档没有绑定已经成功的远程候选

**位置**：[validation.md](../../validation.md) 32；[upgrade-implementation.md](../../upgrade-implementation.md) 67—69；[release-readiness.md](../../release-readiness.md) 的远程 CI 待办。

**实际**：当前页面仍以 46 文件/414 项本地测试及 Windows/macOS 待验证描述交付状态；本轮已确认同代码树的 47 文件/433 项与 11 个成功远程 job。发布清单还将“7 个受影响依赖包”写作“7 项公告”，实际去重公告为 10 个。

**预期/建议**：历史 JSON 不改写；新增以 candidate SHA、tree、run/attempt/job URL、时间、artifact 摘要为键的验收账本，让“当前状态”引用它。合并完成、未发布、宿主待验分别展示。回归用文档一致性检查检查引用，不把当前环境的单次结果覆盖原报告。证据：[本地摘要](evidence/local-validation.json)、[远程记录](evidence/remote-ci.json)、依赖原始 JSON。

## 5. 安全、资源与供应链评审

### 5.1 已建立的边界

外部插件需显式许可；项目命令仍以调用者权限执行。隔离 worktree 防止执行树污染当前 checkout，不是 OS sandbox。签名变量从子进程环境移除不能保护宿主磁盘凭证，也不抵御已经获得同进程执行权的插件。只读 PR 执行与默认分支可信 publisher 分离，artifact 作为数据读取并重新渲染，是正确的权限边界。不能把 unsigned receipt 的内部一致性描述为可信构建者的执行证明。

v2 receipt 将 evidence、execution、snapshot、policy、verification 和退出元数据纳入载荷；trusted-key 策略与数学签名有效性分开，较 1.x 有实质提升。签名保护“记录未被改动”，R01 说明它也可能保护一份生产时就不准确的记录。没有必要为修复这个问题再添加一种签名算法。

### 5.2 依赖审计 D01：公告已确认，实际可利用性未全部确认

本轮 `npm audit --json --package-lock-only`：**7 个受影响包，10 个不同 GHSA URL**；按包统计 low 1、moderate 1、high 3、critical 2。`--omit=dev` 为 **0**。这不是“10 个可利用漏洞”，也不是“所有依赖安全”。原始输入、命令和时间见 [完整审计](evidence/npm-audit-all.json) 与 [生产审计](evidence/npm-audit-production.json)。

| 依赖组 | 公告等级/调用位置 | 项目实际风险分诊 |
| --- | --- | --- |
| Vitest / @vitest/mocker | direct Vitest 汇总 critical；mocker moderate；测试开发依赖 | 影响构建/测试环境；文件读取与注册注入公告需要对应 mock/server 路径。当前默认 CI 为 `vitest run`，没有证据表明暴露远程测试 API；不能仅据此消除所有路径 |
| Tinypool | critical；Vitest worker 实际使用 | 原型污染 gadget 需要污染前提，不能称安装即 RCE；默认测试调用有可达组件，应优先升级并验证 worker 行为 |
| Vite / vite-node | high / low 汇总；Vitest 工具链 | 包括开发服务器、launch-editor、跨源和路径访问公告；生产包不携带这批 devDependencies，维护者开发服务器与测试输入仍需逐项分诊 |
| source-map-js / PostCSS | high；转译/映射链 | 恶意 indexed source map 可阻塞事件循环的公告；本轮未构造利用，不宣称已可攻击发布用户 |

升级应选择经核实的修复版本组合，保留公告→锁文件版本→调用入口→验证结果。不能以 `npm audit fix --force` 替代 Vitest/Vite 主版本迁移，也不能简单覆盖不兼容传递依赖。正式发布前应关闭可达高风险项，或给出有依据、有期限的维护者处置记录。

### 5.3 静态风险与设计边界 L01—L04

| 项目 | 证据与分类 | 建议及本轮限制 |
| --- | --- | --- |
| L01 文件/JSON 处理内存无整体预算 | `snapshot.ts:161–167` 全文件读入、复制和同步 deflate；`mcp-tools.ts:60`、`adapters.ts:79` 同步读 JSON。**静态资源风险** | 大型未忽略文件或导入可占用内存、延迟响应；子进程 deadline 不等于整个进程的 CPU/内存预算。未进行 OOM 压测；增加 byte/file/total 限额、流式哈希及阶段取消 |
| L02 执行计划与执行器重复登记 | `run.ts:122` 与 `gates.ts:75` 分别列工具。**维护性风险** | 用共享执行单元描述生成计划与执行，降低新增 runner 只改一处的漂移 |
| L03 工具“未配置”与“策略不要求”缺少完整范围模型 | type/lint 计划主要基于根目录检测；requiredGates 可要求 gate，但非完整的每项目适用性表。**设计缺口** | 不能把可选门禁未启用一概当 bug；应增加项目级 required/optional/not-applicable 及理由，避免用户误解 strict 的范围 |
| L04 非密封环境与语言模型边界 | 外部依赖、环境变量、生成物、动态依赖、Go build tags、Rust macros、Java 构建模型等。**已公开设计限制** | 记录环境/工具/锁文件摘要、能力边界与 unknown；按真实需求接入成熟工具，不承诺任意仓库可重复执行 |

## 6. 测试为什么未能发现这些问题

现有测试覆盖了很多重要失败路径，新增反例仍揭示了具体遗漏：

1. 原生夹具验证成功/失败/零收集/多模块/缺 runner，但未覆盖“runner 成功，只执行请求范围的一部分”与“全 skip”。总数大于零不是逐路径执行证明。
2. JS alias 测试覆盖 tsconfig 与 workspace，不代表覆盖 package imports。未知导入与动态调用走不同分支，动态回退用例无法保护 R02。
3. 结构校验测试覆盖顶层重复/计数，不涵盖两个执行副本之间的交叉不变量；各个字段合法不代表整份证据一致。
4. MCP 参数转发测试不等于组合语义测试，sign-only 未进入产物分支。publisher 的作者/分页/重试测试不覆盖并发 run 时序。
5. `scripts/test-runtimes.mjs:85–90` 在正常场景注入工具信息，JS 还替换插件命令。真实 runner 确实运行了，但这些结果不能单独证明生产发现链和原始 JS 命令组装。应补安装后完整 CLI 样例，不否定已有原生执行结果。
6. 三个种子补丁证明语料流程可工作，无法估计真实生态漏选概率、误阻断率或收益。重复运行它们不会自动增加样本代表性。

## 7. 旧问题闭环核对

以下“原触发已闭环”依据当前实现、对应回归及本轮全套测试，不表示逐一重放了旧报告所有临时脚本，也不表示该领域从此完整。

| 旧发现 | 当前结论 |
| --- | --- |
| F01 暂存覆盖、F08 特殊路径 | 原触发已闭环；最终磁盘树和 NUL 路径处理 |
| F02 混合语言部分执行 | 原缺 runner 场景已修；完整目标部分满足，R01 是同 runner 内的新反例 |
| F03 失败时 MCP claimDone | 原 fresh-run 判定已统一；R03 是导入数据一致性的新边界 |
| F04 快照身份 | 内容/补丁摘要、范围隔离与漂移回归已建立；环境密封并非本轮实现目标 |
| F05 coverage 丢图边、F06 测试变更/删除 | 原触发已闭环；整体映射可靠性仍受 R02 及语言边界限制 |
| F07 序号基线 | 稳定 fingerprint 和兼容诊断已实现；不延伸为 findings/severity 变化都受 failOnNewGaps 控制 |
| F09 签名载荷/信任 | v2 完整载荷及显式信任策略已实现；v1 历史语义保留 |
| F10 reader、F18 Schema 兼容 | 结构/版本/生成检查已实现；语义一致性未完全闭环，R03 |
| F11 gitleaks 范围 | 范围实现和替身参数回归已修；本轮未定位到真实 gitleaks 版本的 staged/unstaged/untracked/ignore/range 验收记录，不能写作真实引擎全矩阵已验 |
| F12 超时输出 | 原子进程问题已有回归；L01 是不同阶段的资源限制 |
| F13 契约类型、F14 插件分类、F15 聚合豁免 | 原触发已闭环；仍须按有效策略理解通过范围 |
| F16 MCP 参数 | 原字段补齐；参数组合尚有 R05 |
| F17 .mts/.cts | 原扩展名问题已修；不等同所有 JS 模块解析已完备，R02 |
| F19 初始化命令 | package/bin 与真实安装后 MCP 已验证；真实宿主配置消费待验 |
| F20 有效策略记录 | 同次读取、策略摘要和外链来源已实现 |
| F21 评论作者/分页 | 原触发已修；当前 head/run 顺序仍有 R06，远程 publisher 端到端待验 |

## 8. 独立评审轴与发布建议

为避免把规范违例和产品建议混成一个总分，保留两条独立审阅轴：

| 轴 | 结论与数量 | 各轴最严重发现 |
| --- | --- | --- |
| 规范轴 | 2 项硬性违例：R03、R07；2 项维护性判断：重复执行单元登记、原生 harness 的验证边界 | P2：证据副本一致性/身份检查不满足 CONTRIBUTING 与 schema 说明 |
| 规格轴 | 3 项偏差：R01、R02、R04；另列宿主/语料等验收缺口 | P1：实际执行范围与不确定映射回退不满足原 RoadMap |
| 主审补充 | R05/R06；D01 依赖分诊；L01—L04 静态风险/设计限制 | 参数意图及集成时序需要修复；不覆盖前两轴的独立结论 |

正式发布的顺序应为：修复 R01/R02 并补真正失败→修复通过的回归；完成 R03—R06 的边界修复或明确缩小对应能力承诺；处置 D01，更新 R07 账本；在新候选上重跑受影响的远程检查；完成真实宿主与同仓库/fork publisher 验收，或明确标为实验性/不在稳定支持范围。真实项目语料决定后续效果宣称，不宜拿未经完成的统计承诺替代核心错误放行修复。

本审查不认证所有安全性、性能或所有语言项目的正确性。它给出的是固定代码树、已执行验证和明确边界下，可供维护者复核的发布与升级依据。
