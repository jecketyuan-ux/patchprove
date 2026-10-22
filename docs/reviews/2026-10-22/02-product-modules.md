# patchprove 功能模块、数据完整性与竞品评审报告

日期：2026-10-22（Asia/Shanghai）。基线：`188e07e` / `1.2.0`。相关材料：[代码审查报告](01-code-audit.md)、[升级优化方案](03-upgrade-roadmap.md)、[验证记录](evidence/validation.json)、[竞品许可证快照](evidence/competitor-licenses.json)。

## 1. 产品判断：方向成立，可信闭环尚未完成

patchprove 找到的是实际需求：AI 代理能够生成看似完整的补丁，审查者仍缺少针对当前变更的检查记录和未验证事项清单。无模型的核心把确定性工具执行与模型意见分开，CLI/MCP 使代理和人可以消费同一份结果，gap 和 accepted 状态保留了人工判断的位置。

**现有产品已经形成“本地变更摘要与验证辅助”的主流程，但“当前补丁已按策略充分验证”的闭环仅部分成立。** 判断依据是代码身份未绑定、计划执行范围未核账、部分失败/遗漏未进入统一判定。增加更多语言名称或宿主包装，不会自动补上这些缺口。

适合继续发展的定位是：**为现有 CI、测试工具和代理工作流添加可核验的变更验证记录，清楚说明本次证明了什么、还缺什么。** 不应宣称证明任意代码正确、识别所有缺少断言的新分支、替代全量测试，或提供经过校准的生产事故概率。

### 1.1 用户、任务与成功条件

| 用户 | 要完成的任务 | 产品成功条件 |
|---|---|---|
| 补丁作者 / coding agent | 知道下一步补哪些验证，再检查能否结束 | 缺口有稳定身份、明确范围与可操作原因；失败不被声明为完成 |
| PR reviewer / maintainer | 判断这份证据是否属于当前补丁、是否可接受残余风险 | 代码版本、检查范围、策略、豁免和证据来源可追溯 |
| CI / 平台维护者 | 接入现有构建测试并形成稳定门禁 | 明确退出码、依赖与权限边界、失败/跳过/缓存状态，不因发布评论失败丢失结果 |
| 插件及下游消费者 | 扩展语言并稳定消费协议 | 类型/Schema/运行时规则一致，插件分类贯穿契约，版本兼容可测试 |
| 本地及隐私敏感用户 | 无模型账号、无默认数据外传地验证 | 默认核验不依赖服务；被执行工具和可选集成的网络行为有明确边界 |

### 1.2 应固化为可测试的不变量

1. 每个检查结果属于一个明确代码快照；差异、配置和命令所见的代码一致。
2. 每个计划检查范围都有实际结果或明确缺失原因；一个语言成功不能覆盖另一个语言未执行。
3. 命名、结构依赖和历史运行覆盖是不同强度的关系；“映射到测试”不等于“执行到变更分支”。
4. 不相关的辅助输入不能静默删除已知受影响测试；缩减范围必须说明依据和排除原因。
5. 接受缺口的规则只能影响被授权的范围，记录仍然可见。
6. CLI、SDK、MCP、hook 和 Action 使用同一策略判定，表现形式可以不同。
7. 完整性校验、签名验证、签名者信任和执行可信度分别表达。

## 2. 模块完整性矩阵

“完整”仅表示表中限定能力已有实现和相应证据，不代表不存在缺陷。“部分完成”表示主流程存在但关键边界不足；“缺失”是所需能力/数据尚未实现；“未验证”指本次没有实际集成证据；“不适用”按现有定位判断。不给基于代码行数的虚假完成百分比。

| 模块 | 状态 | 正常流程与现有依据 | 异常边界、数据及真实集成结论 |
|---|---|---|---|
| Git 变更获取 | 部分完成 | 工作树、三点 range、untracked、行数和路径排序；集成 fixture | 混合暂存覆盖、C-quoted 路径、range/checkout 错配；缺快照冻结与漂移检测（F01/F04/F08） |
| 配置及 CLI 覆盖 | 部分完成 | 仓库根 YAML、标量覆盖、accept/ignore 追加、gate 开关 | 未保留完整生效策略；未知键无诊断、已知 policy 类型错误；配置可被重复读取（F13/F20） |
| 命名映射 | 部分完成 | 五类语言的确定性候选和 fixture | 命名关系本身有局限；声明的 mts/cts 测试仍漏识别（F17），重复 basename 可产生弱关联 |
| 依赖图 | 部分完成 | JS/Python regex、插件 resolver、测试反向可达关系 | alias、动态/条件导入、资源、构建规则、未解析依赖缺少 unknown 表达；删除需要旧图 |
| 覆盖数据输入 | 部分完成 | Istanbul/Cobertura、自定义 source→tests 关系及 fallback | 普通报告并无逐测试归因；无 commit/producer/freshness；无关文件可抑制 graph（F05） |
| 测试计划与执行 | 部分完成 | Vitest/Jest/pytest/Go/Cargo/Maven/Gradle 命令生成与执行 | 缺计划/实际收集对照、分语言结果；测试自身修改与删除缺闭环（F02/F06） |
| typecheck | 部分完成 | tsc、pyright、mypy；跳过状态 | 采用互斥优先级，混合 TS+Python 不逐范围执行；Go/Rust/Java 没有独立同等检查能力 |
| lint | 部分完成 | eslint 或 ruff | 同样只选一种工具；项目/工作区级配置及遗漏范围不完整 |
| 密钥扫描 | 部分完成 | gitleaks 或新增行 regex；发现不输出密钥值 | 后端范围不同；regex 准确率未知；gitleaks 工作树参数仅 staged（F11） |
| 路径风险 | 完整：有限规则标记 | workflow、lockfile、auth/crypto 规则及 max 聚合 | 不是漏洞确认或概率风险；测试通过不会消除路径 high，策略应说明 |
| gaps | 部分完成 | 未映射、无映射测试、缺工具、部分不支持语言 | 未配置/禁用/不适用/不支持区分不完整；unsupported 扩展白名单遗漏 C/C++/shell 等 |
| accepted gaps | 部分完成 | 保留 accepted 和 reason，不删除证据 | 聚合项部分路径越界接受（F15）；没有到期、规则身份或责任数据；只作用 gaps |
| SPEC 契约 | 部分完成 | required gate、max risk、mapped tests、forbidden unproven、accept policy | 外部插件再分类不一致（F14）；依赖薄弱聚合数据，无法弥补静默遗漏 |
| baseline | 部分完成 | 新增/解决 gaps、findings 对照和新 gap 阈值 | 序号身份冲突（F07）、未知版本/坏数据（F10）；缺策略和仓库兼容性判断 |
| evidence JSON | 部分完成 | 类型、版本、发布 Schema、正向 fixture | 缺快照/执行范围/生效策略；消费前向兼容无实测方案（F18） |
| receipt 与可选签名 | 部分完成 | canonical hash、HMAC/Ed25519、verify 单元和集成测试 | 不绑定代码内容、元数据未签、effective options 不准确（F04/F09/F20） |
| 终端 / Markdown | 完整：基本展示 | 影响、检查、gap/accepted/findings/contract/receipt 分区 | 展示质量不能补上缺数据；应显示“映射/执行/覆盖”的差别 |
| SARIF | 部分完成 | findings/gaps/failed clauses 输出和单元测试 | 完整规范、URI 编码、真实 Code Scanning/不同 reporter 未实跑 |
| CLI / SDK | 部分完成 | 构建、命令帮助、退出码、导出；本次 Linux/Node24 实跑 | 其他 Node/平台与全新安装未验证；测试文件未整体类型检查 |
| MCP | 部分完成 | 实际 stdio handshake、tool list 和 fixture tool call 成功 | 错误完成信号、参数不对等、默认初始化包解析错误（F03/F16/F19） |
| Claude/Cursor hooks | 部分完成；宿主未验证 | 响应适配与配置合并 fixture | 没消费完整宿主上下文；再入、超时、循环与不同事件失败语义需要实测 |
| init-agent | 部分完成 | 幂等 merge、dry-run、force、规则模板 | 配置字符串测试不能代替从安装到连接；MCP 默认命令错误（F19） |
| GitHub Action | 部分完成；真实 PR 未验证 | composite build、Markdown、artifact、SARIF、末步 gate | head/merge 身份、fork 权限、评论 marker/分页、并发和失败降级（F04/F21） |
| 外部插件 API | 部分完成 | 本地三来源、排序、内置 ID 不替换、load fixture | 动态 import 信任边界；无版本/digest/capability；`detect?` 未在主流程形成检测协议 |
| Go 启动器 | 完整：实验性转发；本地未运行 | 文档诚实说明依赖 Node 并执行 CLI | 不是实际独立单二进制，真实独立移植不适用本轮优先级 |
| 真实项目效果数据 | 缺失 / 未验证 | synthetic case study、golden 和 dogfood | 无可核实召回率、误阻断率、生产缺陷检出/用户采用指标 |

## 3. 多语言支持深度

| 语言 | 已有识别与映射 | 已有命令 | 重要边界 | 本次原生执行证据 |
|---|---|---|---|---|
| JS/TS | relative import/require/dynamic string、命名、graph | Vitest/Jest、tsc、eslint | mts/cts 测试误识别；tsconfig aliases/workspace export 不完整；Jest `--passWithNoTests` 允许零收集 exit0 | 真实 Vitest 已验证目标版本失败对照；未实跑 Jest、alias monorepo |
| Python | import/from 的路径启发式、命名 | pytest、pyright/mypy、ruff | `from pkg import util`、`from . import other` 仅抓包名/点，可能落到 `__init__.py`；虚拟环境和动态加载需独立上下文 | 未实跑 pytest；只有映射/调度 fixture |
| Go | go.mod module path、same-package、internal 可见性启发式 | 按包 `go test ./pkg` 或子树 | go.work、多 module、build tags/cgo/生成物未形成完整模型；存在同名非工具链 binary 的检测边界 | 无实际 Go 工具链；不能以 PATH 存在 go 认定通过 |
| Rust | root/workspace member、crate 及外部 tests 路径 | `cargo test -p` | 仅 inline unit tests 的常见 crate 可能无独立 mapped test；跨 crate `use alpha::foo`、feature/macro、workspace glob/依赖传播不完整 | Cargo/Rust 缺失，未实跑 |
| Java | module/src/main→src/test、package FQCN、Gradle/Maven 模块启发式 | Gradle task+`--tests`、Maven `-pl/-am/-Dtest` | 自定义 source set、动态 build 脚本、继承/反射、依赖模块无匹配测试时的 runner 行为需真实验证 | JRE 存在但完整工具链缺失，未实跑 |

插件“存在”、命令“生成正确”、runner“实际收集期望测试”、真实仓库“完整影响验证”是四层支持等级。当前 Java/Go/Rust golden 主要支撑前两层，不能把它们写成最后一层已经成立。

对不支持语言和资源变更，应识别“这是受影响范围但不知道如何验证”，再按策略全量回退或报告 incomplete。仅把某些扩展名列入 low gap、其余忽略，会让扩展支持表与实际门禁脱节。

## 4. 证据数据够不够

### 4.1 数据完整性矩阵

| 数据域 | 当前已有 | 缺失或不准确 | 足够用于什么 / 还不能用于什么 |
|---|---|---|---|
| 代码身份 | repo cwd/root、原始 base/head、文件状态和行数 | resolved commits、merge-base、tree、文件/patch digest、漂移 | 能展示路径清单；不足以绑定执行代码 |
| 测试选择理由 | source→tests、via、primary strategy | 每条边的证据、未解析依赖、置信类型、排除理由 | 能解释部分启发式；不足以声称完整影响集 |
| coverage 来源 | 内部 origin/file、source/tests 索引 | evidence 不保留来源详情、生产器、版本、生成命令、快照/环境/有效期 | 能读报告并猜测关联；不足以证明本次分支被覆盖 |
| 执行计划 | mapped test 文件列表 | changed test、删除传播、按项目/语言的必需任务、工具范围 | 不能核算所有应执行任务 |
| 实际执行 | 四个聚合 check、命令字符串、退出码、耗时、截断输出 | argv 数组、cwd、执行器版本、收集数、case ID、timeout/truncation、缓存/导入状态 | 能记录命令结果；不能证明每个映射测试都被执行 |
| 策略身份 | 可观察部分 contract/result、gap accepted reason | 完整 effective config、ignore/disable/accept/plugin 来源与 digest | 难以独立重建为什么变更被排除或放行 |
| 契约目标 | clauses、files、passed | 匹配数量、统一源分类、契约内容 digest | 主流程可审计；插件目标可能被漏算 |
| baseline | 路径、新增/解决项目 | baseline digest、repo/snapshot/policy 兼容性、稳定身份和升级信息 | 可粗略对比；不能据序号保证回归跟踪 |
| 豁免责任 | accepted、reason（可为空） | 单路径授权、rule ID、责任/到期/关联工单 | 能看见已接受；不足以治理长期风险 |
| 发现强度 | kind/risk/message/path/line | rule version、stable fingerprint、事实与启发式分层 | 可标记高风险路径；不能解释为漏洞概率 |
| 证据完整性 | canonical evidence hash、可选签名 | 快照绑定、完整元数据签名、外部 signer 信任策略 | 能验证所哈希字段未变；不能认证完整运行来源 |
| 支持效果 | 116 项测试、synthetic/golden/dogfood | 真实 runner/corpus、缺陷 ground truth、召回/误阻断、平台矩阵 | 能作为开发回归基础；不足以证明泛化准确性 |

这些缺口并不需要新增中心业务数据库才能解决。优先把每次运行所需的数据完整地纳入本地版本化证据与附件，后续有实际组织级需求再决定存储服务。

### 4.2 覆盖率、确定性与风险的精确含义

普通 Istanbul/Cobertura 通常汇总源文件的行/函数/分支命中，不天然提供“每个测试执行过哪些源”的关系。当前 parser 接受额外 `tests/testFiles/meta.tests` 或自定义 map，其他情况靠 basename/naming。因此显示 coverage 的运行级策略名称，不能当成逐测试追踪，更不能据此判断新增 lockout 分支缺断言。

当前工具没有计算本次补丁的行/分支覆盖率；不得把“mapped source 比例”标成代码覆盖率。相同稳定字段的 hash 可重复，但绝对路径、命令、工具结果和 baseline 路径也参与哈希，跨机器相同补丁不保证同 hash；相同统计的不同代码反而可能同 hash（F04）。需要分离代码内容身份和运行证据身份。

`summary.risk` 是 findings 与开放 gaps 的最大规则等级。auth/workflow 改动即使测试通过仍可 high，这是保守路径规则，尚无概率校准。应分别展示“路径敏感性”“已知失败严重性”“验证完整度”和“策略结论”，避免一个颜色承担所有语义。

## 5. 功能闭环和文档可信度

| 用户路径 | 已经闭环的部分 | 断点及产品后果 |
|---|---|---|
| 作者修改 → 本地 run → 补验证 | 影响/检查/gaps 能直接阅读 | 部分变更根本未进入证据；tests-only/删除可能无 gap，作者不知道还缺什么 |
| agent 调 MCP → 判断可否结束 | 结构化工具和文本说明 | F03 把无 gap 误作完成；配置参数不对等；默认初始化 MCP 在空环境可能无法启动 |
| PR 执行 → 发布评论 → 阻止合并 | composite、artifact、最终 gate 已具备 | 验证对象可能是 merge 而标签是 head；fork 权限/评论失败会干扰反馈，实际门禁取决于仓库策略 |
| 接受技术债 → 保存 baseline → 判断新增回归 | accepted 可见，new gaps 阈值存在 | 聚合路径接受越界、序号身份不稳、基线和当前策略不可比较 |
| 留存收据 → 第三方复核 | 可重算 evidence hash | 代码、完整运行参数及信任身份未绑定，不能据此追溯实际执行内容 |

建议修正以下公开表述，功能修复与文档校准同时交付：

- `docs/case-study.md` 已写明 synthetic，但“新增 lockout 分支未断言”是样例的人为已知条件，工具没有相应分支/断言证据。应准确描述它实际检出的是未映射 helper 和高风险路径。
- `docs/plugins.md` 末段暗示 acceptGaps 能消除 auth/crypto 路径 high；实际 findings 不受 gap acceptance 影响，集成测试也固定了这个行为。
- README 中文概述把“有未接受 gap”泛称为 exit1；普通 CLI 仍依赖 failOn/contract/new-gap 策略，hook 另有阻止结束的逻辑，应分别说明。
- “缺少检查是 first-class gap”并非覆盖所有情况：未配置、被禁用及未支持的范围有些只有 skip，有些无 gap。明确区分状态后再宣传。
- “同 diff 两次同 hash”应限定稳定运行上下文，且补内容身份；当前是同一稳定证据子集可重复。
- “五类语言支持”需展示支持层级；“local-only 插件”需要说明执行目标仓库代码的信任前提。
- lenient dogfood 的 contract 证明接线与格式，不能用于证明严格门禁可靠性。
- `CONTRIBUTING.md` 的 v0.x 表述、发布文档的包内文件清单等需要与 1.2 实际包内容同步。

## 6. 联网竞品与开源项目分析

### 6.1 方法和关系

本次实时核对官方文档、官方仓库和 LICENSE。六个开源组件的许可证使用固定 commit URL 和 SHA-256 留证，见 [competitor-licenses.json](evidence/competitor-licenses.json)。未运行这些竞品，所有速度、准确率、资源开销、全量封网和实际易用性比较均为**未测量**。文档“未见”某能力，不等于整个项目绝无该能力。

这组项目没有被核实为与 patchprove 每个环节完全相同的直接替代品，也不能据此宣称 patchprove 业界唯一。真实竞争来自成熟工具的组合；测试/任务编排、诊断发布、模型审查、证据签名分别解决相邻问题。

| 项目 / 当前许可证 | 关系与选择粒度 | 执行证据、缺口和策略 | 本地、模型、网络与集成成本 |
|---|---|---|---|
| **Nx / MIT** | 相邻：Git+project graph 选择 targets 及依赖项目；Jest/Vitest Atomizer 可拆到测试文件，不是仅项目粒度 [N1,N2] | 本地执行与缓存；需区分重新执行和恢复。锁文件变化默认全量，也支持精细配置。未在所读文档建立通用 patch-gap-receipt 契约 | 核心不要求 LLM；本地 cache，可禁 Cloud，遥测可配置。已有 Nx 项目接入成本较低；采用项目图和 targets 是前提 |
| **Turborepo / MIT** | 相邻：affected 默认包级；当前 future flag 支持 task inputs 粒度；浅历史可全量回退 [T1] | dry JSON 是计划，run summary 才是运行记录；可强制忽略缓存。已有 HMAC 远程缓存验证，hash/HMAC 不是独有差异 [T2] | 核心无 LLM，本地 cache 可独立使用；远程 cache 和遥测有开关。适合现有 turbo monorepo，不能用 wrapper exit0 代替子任务核账 |
| **pytest-testmon / MIT** | 相邻：测试选择最直接重叠；Coverage.py 收集逐测试执行依赖，可到方法，首次全跑建库 [P1] | 实际执行 pytest 并更新本地依赖库；失败测试重跑；不追踪静态资源和外部服务。其数据不是对所有未知行为的证明 | 无 LLM；本地 `.testmondata` 默认，可选云 tmnet。需 Python pytest 插件、历史建库及环境有效性管理 |
| **reviewdog / MIT** | 互补：消费 linter/compiler/SARIF，按 diff 过滤诊断，不发现测试依赖 [R1] | 有 reporter 与 `fail-level`；默认阈值 none，added filter 可隐藏范围外诊断。适合发布发现，不自动产生完整验证计划 | 本地 reporter 可用；远端 PR 注释需 API/凭据。接现有 SARIF 的成本低，多平台发布比自建更可取 |
| **CodeRabbit CLI / 未核实为开源内核** | 相邻模型审查：本地/PR、committed/uncommitted/base、agent 工作流 [C1] | 输出审查建议不能等同实跑测试；headless 模式有 skipped、failed/incomplete 状态和退出码 [C3] | hosted review 需 WSS/HTTPS 后端，self-hosted 仍需服务连接 [C2]；官方 skills 仓库 MIT 不代表 CLI/backend 也 MIT。接入方便与否取决于账号、网络和部署 |
| **PR-Agent / MIT（当前仓库）** | 相邻开源模型审查：review/describe/improve，多 provider；Local Git Provider 比较 committed HEAD 与 target merge-base [A1,A2] | 输出文本/建议；local provider 要干净工作树，不能假定验证未提交变化，更不能等同测试执行 | 仍依赖 LLM，但可用 Ollama+local Git，不能说必须云模型/联网；安装和托管 provider 有各自网络前提 |
| **Sigstore/Cosign / Apache-2.0** | 互补：签 artifact/blob 与验证 digest/身份/issuer，不选择或运行测试 [S1] | bundle 可含证书、时间和透明日志证据；消费者指定信任身份。签名证明字节来源，不证明测试完备 | keyless 签名通常涉及 OIDC/Fulcio/Rekor；完整 bundle/信任根下有离线验证路径 [S2]。宜作为可选签名适配，不重建 CA/日志生态 |

“离线可运行”还取决于依赖是否预置、测试/构建命令是否联网。对方没有 LLM 前提不代表已审计零遥测；本报告只陈述有官方依据的默认模式和开关。

### 6.2 最值得借鉴的差异

1. **保守回退有明确先例**：Nx 对锁文件、Turbo 对缺比较历史会扩大范围。patchprove 不确定依赖或删除影响时，应报告 incomplete 或全量回退，而非把未知表现为空集合。
2. **选择与执行必须分开**：Turbo 已区分 dry plan、实际 summary 和缓存；patchprove 需要在此基础上补 gap/策略/快照，不能以 mapped list 或 exit0 代替执行记录。
3. **运行覆盖也有边界**：testmon 强于当前命名猜测的逐测试归因，但也明确静态资源和外部服务盲区。升级应保留来源和未知信息。
4. **状态语义是基础质量**：CodeRabbit 的 incomplete 状态值得参考；“没有 findings”与“审查完成”、以及“验证通过”必须分开。
5. **签名需要声明信任策略**：Cosign 的 identity/issuer 是重要边界。patchprove 可以保留轻量本地密钥，同时增加完整签名载荷和外部信任输入。
6. **CLI、离线、无模型、hash 单项都不是独有优势**。可建立差异的组合是：绑定当前变更、选择理由、实际执行/缓存/导入/跳过状态、开放缺口、策略及可独立核验收据。

### 6.3 自建与集成取舍

| 能力 | 决策 | 保留在 patchprove 的责任 |
|---|---|---|
| 快照、验证计划、状态与证据协议 | 自建核心领域模型 | 保证不变量、版本迁移、来源及可解释判定 |
| Nx/Turbo 图、调度、缓存 | 通过薄适配器消费计划及运行摘要 | 验证输入身份；明确 cached/executed，不把子任务静默省略 |
| 逐测试覆盖 | 先接已文档化的 coverage/trace；Python 做 testmon 对照实验 | 校验新鲜度和环境；不绑定未承诺稳定的私有 DB 结构 |
| 多平台 PR 注释 | 优先 SARIF/reviewdog recipe | 保留完整报告和门禁；选合适 filter，避免 added 模式隐藏 gaps |
| 公有签名身份体系 | 可选 Cosign adapter | 负责 receipt 语义和信任策略接口，默认本地流程仍可用 |
| 模型审查 | 保持外部可选互补 | 来源标注；不把模型未发现问题换算成确定性 checks passed |

### 6.4 官方来源索引

所有链接于 2026-10-22 核对；动态文档可能变化，许可证固定版本见 JSON 侧车。

- N1：[Nx affected](https://nx.dev/docs/features/ci-features/affected)、[cache](https://nx.dev/docs/features/cache-task-results)、[commands](https://nx.dev/docs/reference/nx-commands)。
- N2：[Nx Jest](https://nx.dev/docs/technologies/test-tools/jest/introduction)、[Vitest](https://nx.dev/docs/technologies/test-tools/vitest/introduction)、[telemetry](https://nx.dev/docs/reference/telemetry)。
- T1：[Turbo run reference](https://turborepo.com/docs/reference/run)、[CI](https://turborepo.com/docs/crafting-your-repository/constructing-ci)。
- T2：[Turbo remote caching](https://turborepo.com/docs/core-concepts/remote-caching)、[telemetry](https://turborepo.com/docs/telemetry)。
- P1：[testmon 官方说明](https://testmon.org/)、[仓库](https://github.com/tarpas/pytest-testmon)。
- R1：[reviewdog 官方 README](https://github.com/reviewdog/reviewdog/blob/master/README.md)。
- C1：[CodeRabbit CLI](https://docs.coderabbit.ai/cli)、[Codex 集成](https://docs.coderabbit.ai/cli/codex-integration)。
- C2：[CodeRabbit network requirements](https://docs.coderabbit.ai/cli/network-requirements)。
- C3：[CodeRabbit headless integration](https://docs.coderabbit.ai/cli/headless-cli-integration)、[skills LICENSE](https://github.com/coderabbitai/skills/blob/main/LICENSE)。
- A1：[PR-Agent 当前仓库](https://github.com/The-PR-Agent/pr-agent)、[本地安装](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/installation/locally.md)。
- A2：[PR-Agent Local Git Provider](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/usage-guide/local_git_provider.md)、[模型配置模板](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/.secrets_template.toml)。
- S1：[Sigstore quickstart](https://docs.sigstore.dev/quickstart/quickstart-cosign)。
- S2：[Sigstore 验签](https://docs.sigstore.dev/cosign/verifying/verify/)、[Cosign](https://github.com/sigstore/cosign)、[self-managed keys](https://docs.sigstore.dev/cosign/key_management/signing_with_self-managed_keys/)。

许可证核验：Nx `cb7daf5a`、Turbo `b90e6ea3`、testmon `dccc58d2`、reviewdog `849f8668`、PR-Agent `9533564b`、Cosign `f8e6ea94`。PR-Agent 曾经的项目路径及历史许可证不能替代当前 MIT 事实；CodeRabbit 免费或开放 skills 不等于审查内核开源。

## 7. 真实样本与效果验证方案

建立三个层次，避免用小型合成 fixture 直接声称生产准确率：

| 层次 | 样本与控制 | 必须回答的问题 |
|---|---|---|
| A：确定性边界语料 | 本次探针转正式回归；Git 状态、Unicode、删除、多个 runner、契约、签名、旧 Schema | 已知错误是否被修复；同一个不变量是否在所有入口成立 |
| B：原生 runner 语料 | 五语言各有最小真实项目及故意失败测试；包含模块/工作区和零收集场景 | 生成命令是否真的选中并执行目标；依赖缺失和失败是否准确表达 |
| C：真实开源补丁 | 固定项目 commit、合法来源/许可证、补丁 ID、全量 suite、环境镜像、人工 ground truth；每语言先试点两个项目，每项目五个可复现补丁 | 选择与全量结果是否一致；哪些失败漏选、额外执行与回退成本多大 |

初始十个项目/五十个补丁只是建立流程的建议样本，不能代表整个生态。选择包含历史真实缺陷、共享配置/资源、动态加载、依赖更新、重命名/删除，避免只挑命名匹配成功的项目。全量 suite 的失败还可能来自外部服务/flake，需重复确认和人工归因；若无法建立真值，记为未判定而非成功。

指标必须附分母与条件：计划执行覆盖率、确认受影响测试的漏选数量及比例、选择集合/全量集合比例、误阻断、unknown/回退比例、冷启动/热缓存耗时及资源；缓存命中与实跑分开。安全关键固定语料要求零已知错误放行，真实开放语料逐条披露遗漏；未测量之前不提供“准确率 99%”或竞品倍数结论。

## 8. 产品优先级结论

现有功能模块数量已经足以支撑下一阶段。短板集中在跨模块一致性、证据数据和真实验证深度。按“错误放行修复 → 快照/执行/策略数据 → 原生 runner 与平台验证 → 严格协议 → 生态适配”推进，能够在保留轻量定位的同时建立可辩护的可信度。具体工作包、接口、工期估算和发布门槛见升级方案。
