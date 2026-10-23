# patchprove 2.0 功能模块、数据完整性与竞品评审

日期：2026-10-22（UTC）。基线：`6fa50972f424ee0b6c8e2b1a8506b7ee3f804f0d` / `2.0.0`，与 main 合并提交 `dc79f449f0d919a395c9132d44575267066b34ad` 的代码树相同。定位为成熟开源的本地确定性验证工具。本报告配合 [代码审查](01-code-audit.md)、[升级方案](03-upgrade-roadmap.md)、[证据索引](evidence/README.md) 使用。

## 1. 产品目标和用户任务

**模块数量已足以支撑一次完整的变更验证工作流，模块可靠性和证据粒度尚不足以支撑“所有必需范围均已验证”的稳定承诺。** 最重要的缺口不是缺少可视化或新语言，而是选择集合、实际执行集合、可信结论三者之间仍有断点。

| 用户 | 核心任务 | 必须交付的可观察结果 |
| --- | --- | --- |
| 开发者 | 修改后知道需要跑什么、还有什么未验证 | 选择理由、实际执行范围、失败及未完成原因、可重放命令 |
| 编码代理 | 判断能否结束本次工作并解释原因 | 机器可读三态；不得把 warning、skip、缺执行器或未运行解释为完成 |
| 项目维护者 | 按仓库规则控制变更与例外 | 生效策略、契约、到期豁免、基线差异及可审计的覆盖范围 |
| CI/集成维护者 | 在无写凭证的执行环境生成结果 | 固定 head/tree/run，明确原始门禁结果，安全地转交报告发布 |
| 证据消费者 | 复核这份记录属于谁、什么代码、什么策略 | 完整性、签名、可信 signer 分开验证，并知道记录没有证明什么 |

目标不是替代完整 CI、编译器、SAST、业务验收或人的代码审查。`passed` 只应表示公开策略在本次范围内被满足；项目现有 README 已正确收窄这一表述，但 R01/R02 表明实现尚未完全兑现这个较窄承诺。

## 2. 功能模块完整性矩阵

分类规则：**完整**表示在明确声明的范围和本轮证据内闭环，不代表无缺陷；**部分完成**表示已有实现但语义/异常/验证存在缺口；**缺失**表示所需能力尚未建设；**不适用**表示明确不在产品目标；**尚未验证**表示不能依据本轮材料判断实际集成结果。每个模块分别评价正常流程、异常流程、数据和真实集成，不用单一百分比分数掩盖差异。

| 模块 | 总体状态 | 正常流程 | 异常流程 | 数据支撑 | 真实集成验证 |
| --- | --- | --- | --- | --- | --- |
| 最终工作树/暂存/未跟踪 | 完整（声明范围） | 最终磁盘内容与 HEAD 比较，修复暂存覆盖 | 空仓库、删除、重命名、NUL 路径有回归 | 内容/补丁摘要、dirty、refs | 隔离 Git 集成及三 OS CI；非任意 Git 布局保证 |
| 提交范围/执行快照 | 完整（声明范围） | 解析 refs、默认隔离目标 head | 漂移与不匹配明确失败/不完整 | tree、merge-base、前后身份 | range/drift 集成；不是环境密封证明 |
| 大仓库/大型二进制 | 部分完成 | 二进制内容纳入身份 | 子进程输出有界；读文件/压缩未有总预算 | 缺各阶段字节/内存预算证据 | 未压测，L01 |
| 命名/导入图/影响传播 | 部分完成 | 多策略并集、跨模块关系、base 图 | 动态依赖有回退；内部未解析别名可漏选 | 每边来源/精度；内部 unknown 分类不足 | 真实 Vitest 反例 R02 |
| 覆盖率映射 | 部分完成 | 可导入显式 source→test，普通覆盖不删图边 | 损坏/未知/历史关系需保守解释 | 来源/hash/freshness 已有；并非逐分支当前归因 | 合成夹具较多，真实 producer 数据有限 |
| 测试自身变更/删除源码 | 部分完成 | 测试直接选择，删除参考旧图 | 被 runner 排除后仍冒称执行 R01 | 计划存在，实际集合不足 | Git/mapping 回归；R01 为真实执行反例 |
| JS/TS | 部分完成 | Vitest/Jest、tsc/ESLint；常见 alias/workspace | package imports、全 skip/exclude 是当前缺陷 | 有命令与总数，缺逐文件实际结果 | Vitest 真执行；Jest 等组合不能据此一概已验 |
| Python | 部分完成 | pytest/解释器回退、pyright/mypy、Ruff | 动态导入、项目配置与 deselection 边界 | 当前按语言聚合，总数不足以核账全部文件 | pytest 原生夹具；完整多项目生产发现链仍需补 |
| Go | 部分完成 | 模块/同包测试，`go test -json` | go.work、build tags、cgo、平台文件不完整 | JSON 可用，但当前仍归入请求 scope | 原生夹具/启动器 CI；非所有 workspace 语义 |
| Rust | 部分完成 | crate/workspace、inline/integration、Cargo | macros/build scripts/cfg/忽略测试边界 | crate 粒度与源码关联需说明，不能冒称精细执行 | Cargo 原生夹具；真实复杂 workspace 样本不足 |
| Java | 部分完成 | Maven/Gradle、类/模块筛选 | 新鲜报告匹配较严格；构建插件模型有限 | 读取本次 XML 匹配选定类，优于只看总数 | Maven/Gradle 原生夹具；不能代表任意 Gradle task |
| 类型检查/lint | 部分完成 | 可执行多个已配置工具 | 未配置与不适用缺完整项目级契约；根检测有边界 | 根范围 `.` 为主，缺每项目适用性图 | 单测及部分集成，未逐项声称所有工具原生已验 |
| 测试执行与核账 | 部分完成，发布阻塞 | 统一进程执行/语言记录 | 缺 runner/零收集已防护；排除/全跳过 R01 | 请求 scope 和实际 scope 混用 | 30 原生场景不覆盖 R01 反例 |
| 内建密钥扫描 | 完整（规则与新增行范围） | 同一选定新增行集合 | findings 保留、范围不随后端缩小 | 路径/规则/发现可追溯 | 不等于完整泄密检测或历史全仓扫描 |
| 可选 gitleaks | 部分完成 | 与内建共享补丁输入范围 | 替身验证参数与失败处理 | 缺固定真实引擎的验收记录 | 本轮未定位真实 gitleaks 全矩阵，待补 |
| 配置/契约/豁免 | 完整（当前契约范围） | 优先级、required gates、全范围接受与到期 | 未知/非法字段明确拒绝，失败不被豁免洗掉 | 同次读取的来源/hash、reason/owner 等 | config/spec/accept 回归；项目级适用性扩展另议 |
| 风险与基线 | 部分完成 | 稳定语义 fingerprint、来源兼容、新旧比较 | 严重性/范围改变显式呈现 | 当前阈值主要作用新 gaps，非所有 findings 变化 | 合成场景充分；跨真实仓库长期演进样本有限 |
| 共享判定 | 完整（函数规则），依赖输入质量 | 三态、失败优先、显式 strict | 上游伪完整记录仍会被信任 R01/R03 | reasons 可定位，但无法弥补事实缺失 | CLI/MCP/钩子共享；不意味着真实宿主均验证 |
| Schema/reader | 部分完成 | 版本、类型、摘要、生成 wire types | 矛盾副本/嵌套重复未拒绝 R03 | 单字段充分，跨字段不变量不足 | 结构测试与本轮畸形输入复现 |
| 收据/签名/manifest | 完整（声明的完整性/信任范围） | 完整载荷、HMAC/Ed25519、trusted key、manifest | 篡改、缺签名、旧协议策略、写冲突回归 | 可绑定记录，不能证明生产者诚实或记录语义正确 | 本地/安装包/CI 校验；签名操作意图有 R05 |
| CLI/SDK | 完整（基础分发路径） | 统一分析/产物、协议 1/2、安装后入口 | 无可用结果 exit2，失败/不完整区分 | 输出与机器协议可用 | 六个 Node/OS job 的 tarball 消费端检查 |
| MCP | 部分完成 | 真 stdio 握手/调用，策略参数丰富 | sign-only 静默忽略 R05；文件导入 R03 | `claimDone` 已受统一判定约束 | 已验证 transport；真实宿主 MCP 配置消费待验 |
| Claude/Cursor 钩子 | 部分完成；宿主尚未验证 | stdin、预算、再入/循环保护，正确区分阻断/建议 | 取消与宿主事件语义需实际确认 | 有 worker/证据，缺宿主版本化实录 | 替身/进程测试通过，不能视为真实宿主体验 |
| 初始化 | 部分完成 | package/bin/绝对本地 CLI、合并与备份 | 幂等及路径回归 | 生成配置可审查 | tarball/MCP 已验；不同宿主版本最终加载待验 |
| Action/可信 publisher | 部分完成 | 只读执行，默认分支校验后重建报告 | 作者/分页已修；旧 run 覆盖新评论 R06 | head 绑定 run，未绑定最新 PR 状态 | evidence CI 已验，实际同仓库/fork 发布待验 |
| SARIF/reviewdog | 部分完成 | 结构化输出，本地 reviewdog 消费 | 门禁退出码保留 | 诊断位置/级别，不是执行事实补充 | 真实 reviewdog 0.21.2 本地已验；GitHub Code Scanning 上传待验 |
| Nx/Turbo/testmon adapter | 部分完成 | 有来源的导出包装、区分 plan/import/cache/run | 非法状态/计数有 R04 | caller 提供 snapshot 与 input hash；不认证来源 | 自定义导出夹具为主；未证明任意上游版本兼容 |
| 离线 Cosign wrapper | 完整（限定调用范围） | supplied bundle/root、identity/issuer 校验 | 真实正/反例已验证 | 外部 artifact 身份，与 patchprove 执行语义不同 | Linux/Cosign 3.1.4；不外推所有版本/平台 |
| Go 启动器 | 部分完成，实验性 | 转发到 Node CLI，构建冒烟 | 仍需 Node 及正确安装布局 | 不是独立验证内核 | 远程启动器 job 成功，不等于独立单二进制产品 |
| 真实项目效果评测 | 缺失充分数据，harness 已有 | 三个固定种子、可扩展 manifest | 未知/flake/环境分类已有方向 | 不足以估计现实漏选/误阻断 | 本轮未完成真实 10 项目/50 补丁研究 |
| SaaS/遥测/模型评审 | 不适用 | 不纳入本轮产品目标 | — | 不应为增长而默认收集代码或遥测 | 无需为“完整度”补齐 |

## 3. “数据是否足够及完整”的逐项判断

### 3.1 足以支持什么结论

现有数据已足以回答“这份 evidence 自称针对哪个代码内容、使用什么策略和工具、命令怎样退出、哪些已知问题被接受、产物是否内部一致”。**尚不足以在一般项目中可靠回答“所有选择的测试都实际运行了”“所有受影响测试都被选中”“测试本身充分验证了行为”**。这三个问题必须分别补充执行事实、依赖解析/不确定性、测试质量证据。

| 数据对象/关键问题 | 已有字段或机制 | 仍缺什么/当前缺陷 | 对结论的约束 |
| --- | --- | --- | --- |
| 代码身份：到底验证了哪份代码 | resolved refs、tree、contentHash、patchHash、dirty、漂移状态 | 外部依赖内容、运行时读取的外部文件不完整密封 | 可证明记录绑定仓库快照；不能保证任何机器必然得到同结果 |
| 计划：为何要求这些检查 | verificationPlan、scope、required、reason、unitId | 项目级 required/optional/not-applicable 和 runner 配置模型不足 | strict 仅对当前计划生效；计划遗漏不会自动变成缺口 |
| 执行：真正运行了哪些测试 | command/argv/cwd、exit、duration、outputHash、语言/单元、collectedTests | R01：请求 scope 代替实际 scope，skip/deselection 未核账 | 现有成功记录不能总是证明逐文件执行 |
| 遗漏/跳过：哪些没有执行 | skipped 记录、缺 runner/零收集、gaps/reasons | 缺同一次成功命令内部的逐文件未执行原因 | 跨语言缺口比同语言细粒度缺口完善 |
| 映射：关系从哪里来 | naming/graph/coverage/testmon、precision、inputHash、freshness | R02 内部未知与外部模块未分；历史运行环境/源报告版本不足 | 图边存在不等于行为覆盖；unknown 不能被正常边掩盖 |
| 策略：本次实际生效什么 | effectivePolicy、配置/外链 spec/baseline 摘要、plugins、阈值、ignore/accept | 依赖配置和工具环境还不能完全重建 | 能审计显式选择；ignore 会缩小分析范围，需可见 |
| 问题身份：跨版本是否同一个问题 | semantic fingerprint、规则/范围、compatibility | 重命名及真实长期演进需更多数据；finding 的风险策略另有边界 | 比序号稳健；不能等同跨任意重构精确跟踪 |
| 事实一致性：同一 ID 是否只有一个真值 | Schema、顶层唯一性、summary counts/risk | R03 双份 execution 互相矛盾，R04 导入静默规范化 | 必须补跨对象语义验证，签名不能代替它 |
| 可信来源：谁产生了记录 | v2 receipt、HMAC/Ed25519、trusted key，Cosign wrapper | unsigned 默认只验证自洽；外部 adapter hash 不是 producer 认证 | 不能将“签名数学有效”写成“可信维护者真实执行” |
| 交付追溯：哪个候选经过哪些验收 | 远程 job、报告 JSON、包 smoke、manifest | R07 当前状态没有统一 SHA/run 索引 | 当前已有真实 CI 证据；需要索引整理，不必伪造重跑 |
| 效果：漏选和误阻断概率 | 三个种子补丁、selection/full 结果及限制 | 多样真实项目、人工真值、分母、flake 处理、缓存条件 | 目前不支持全生态准确率、零漏检或性能倍数宣传 |

### 3.2 推荐的数据模型演进

保留当前三态与 2.x 消费者能理解的基本字段，增量增加以下记录；任何强制新增字段或改变旧字段含义都必须明确协议版本和迁移规则。

1. **执行单元事实**：`requestedScope`、`collectedScope`、`executedScope`、`skippedScope` 与 reason；如需用例粒度，再记录 runner 原生 test ID、passed/failed/skipped/todo，避免将文件粒度冒称语句覆盖。
2. **报告来源**：runner/version、reporter/version、原始报告摘要、生成时间、解析器版本、本次 run ID；从本次新报告生成事实，不接受旧报告补足新执行。
3. **解析结果**：`resolved-internal / external / builtin / unresolved-internal / dynamic` 与受影响范围，保留 resolution config 摘要。未解析不等于不存在依赖。
4. **适用性与不确定性**：每项目门禁是 required/optional/not-applicable，理由、来源和到期；fallback/unknown 数据进入判定和用户说明，避免只留下日志 warning。
5. **发布账本**：候选 SHA/tree、验证命令、OS/Node/runner、run/attempt/job/artifact URL、包摘要、宿主版本、通过/失败/未判定、验证边界。无默认外传，维护者自行保存。

## 4. 竞品与开源项目联网对照

调研日为 2026-10-22 UTC。主要依据官方文档、官方仓库和实际许可证文本；[原始摘录与许可证快照](evidence/external-sources.json) 保留检索时间。未运行这些产品的统一性能或准确率实验，所有相应比较均为**未知**，不使用官方营销倍率作本项目结论。

### 4.1 比较对象与公开事实

| 对象/关系 | 官方资料与本次核实内容 | 对 patchprove 的启示 |
| --- | --- | --- |
| [Nx](https://nx.dev/docs/features/ci-features/affected)：影响分析/任务执行的相邻能力 | Git 变更→project graph→依赖项目；锁文件变化默认全部项目 affected，也可配置 auto/pattern | 不确定时采用可解释的保守回退；优先消费成熟项目图，而非在所有构建系统中重写一个图 |
| [Turborepo](https://turborepo.com/docs/crafting-your-repository/constructing-ci)：任务图/缓存的相邻能力 | `--affected`、package/task 选择、浅克隆缺历史时回退全部任务；缓存与实际任务执行是不同事实 | 明确项目/任务粒度；记录实际 cache hit 与 plan 预测，不把计划当执行 |
| [pytest-testmon](https://www.testmon.org/)：可集成的 Python 动态依赖组件 | 用 Coverage.py 收集测试与已执行代码依赖；先全量建 `.testmondata`，每次执行更新；可按环境分数据 | 映射数据要有生成、更新、失效生命周期；历史边不等于本次执行证明 |
| [reviewdog](https://github.com/reviewdog/reviewdog)：诊断反馈组件 | 差异过滤、多诊断格式、SARIF 2.1.0、PR/Checks reporter；支持本地输出 | 把展示/评论交给成熟集成，保留原门禁退出码；评论不是验证事实来源 |
| [CodeRabbit CLI](https://docs.coderabbit.ai/cli/overview)：开发者/代理评审工作流的替代选择 | CLI 认证、`cr --agent`、交互/自动化工作流；[self-hosted](https://docs.coderabbit.ai/self-hosted) 支持企业自部署和自带模型 provider | 借鉴可执行反馈和修复循环；模型意见与确定性测试证据分开。自部署的数据路径仍取决于模型与配置，不能据名称认定离线 |
| [PR-Agent](https://github.com/The-PR-Agent/pr-agent)：开源模型评审工作流的替代选择 | `/review`、`/improve`、`/ask`；多 Git provider；CLI/Action/Docker/self-host；多模型及本地模型接入 | 扩展接口和部署选择可借鉴；LLM 审查不应成为 patchprove 主判定的必要依赖 |
| [Sigstore/Cosign](https://docs.sigstore.dev/cosign/verifying/verify/)：可信来源验证组件 | digest/签名、bundle、trusted chain、certificate identity/OIDC issuer；blob 验证需 bundle 或对应签名资料 | 完整性、签名及信任策略分开；可信身份也不自动证明测试足够 |
| [StrykerJS](https://stryker-mutator.io/docs/stryker-js/introduction/)：测试有效性的相邻组件 | mutation testing，覆盖 JavaScript/TypeScript 等项目 | 弥补“测试运行过但断言弱”的不同问题；可导入结果，初期无需内建昂贵 mutation 执行 |

PR-Agent 旧地址 `qodo-ai/pr-agent` 本次跳转到 `The-PR-Agent/pr-agent`。本次读取的新主分支 LICENSE 为 MIT；不能把旧版本的许可或商业产品关系直接套给当前仓库，也不能反过来将当前许可证推定适用于历史制品。

### 4.2 能力矩阵

“非主目标”表示产品不以该能力为核心，不能据本次资料证明完全不具备；“未实测”表示没有运行实验。

| 产品 | 测试选择 | 实际执行证明粒度 | 验证缺口/策略门禁 | 本地/离线定位 |
| --- | --- | --- | --- | --- |
| patchprove 当前 | 多语言命名/静态图/历史覆盖并集；R02 | 命令/单元/请求 scope；R01 尚需修复 | 显式 gaps + 三态 + 契约/豁免；输入质量受 R03/R04 影响 | 核心本地无模型；安装依赖/项目命令可能联网 |
| Nx | 项目图与 affected task | 任务执行/缓存结果；不在本次资料中等同逐测试文件证明 | 任务退出/配置；跨工具验证缺口非主目标 | 本地任务可用；远程缓存/云功能另配置 |
| Turborepo | package/task affected | 任务执行与缓存；不是 patchprove 式证明协议 | task graph/退出码；证据缺口协议非主目标 | 本地可运行；远程缓存可选 |
| testmon | 实际历史运行建立的 Python 依赖 | pytest 执行，依赖数据库有更新机制 | 选择正确性受历史/环境影响；统一多工具策略非主目标 | 本地 `.testmondata`；云存储为可选能力 |
| reviewdog | 非主目标，过滤诊断而非选择测试 | 消费外部诊断，不由 SARIF 自动证明执行 | reporter 的 level/filter/fail 行为 | 本地 reporter 可离线；远程反馈需 API |
| CodeRabbit | 本次未验证测试选择能力 | 模型评审意见不能当执行证明 | 提供评审/代理反馈；本次未验证确定性执行缺口协议 | SaaS 与企业自部署；独立离线运行未验证 |
| PR-Agent | 本次未验证测试选择能力 | 模型调用/评审结果，不自动证明项目测试执行 | 指令与配置化评审；依赖模型和 Git provider 工作流 | 可自行部署/接本地模型；端到端离线未验证 |
| Cosign | 不适用 | 验证被签 artifact/声明；不运行项目测试 | 身份/issuer/信任策略 | supplied bundle/root 可离线校验；准备与签发另论 |
| StrykerJS | 为 mutation 调度相关测试，非本次变更影响算法对照 | mutation 与测试执行结果，关注断言有效性 | mutation score/配置，非通用验证缺口协议 | 本地工具；实际成本随项目而变，未实测 |

| 对象 | 多语言/生态深度 | 集成成本与扩展方向 | 当前所核实许可证 |
| --- | --- | --- | --- |
| patchprove | 五类语言的有限模型；工具存在与深度须分开 | Node+Git+目标工具链；插件显式授权；SDK/MCP/导出 adapter | 仓库 MIT |
| Nx | 项目/构建系统/插件生态；具体语言执行依赖 executor | 采用 workspace/project graph、targets；可接导出接口 | [MIT](https://github.com/nrwl/nx/blob/master/LICENSE)；不据此推定云产品条款 |
| Turborepo | 主要 JS/TS monorepo task 生态 | package/task 配置、缓存输入声明；适合导出任务结果 | [MIT](https://github.com/vercel/turborepo/blob/main/LICENSE) |
| testmon | Python/pytest，动态覆盖依赖更深入 | 安装 pytest 插件、维护数据库与环境标识；需文档化导出 | [MIT](https://github.com/tarpas/pytest-testmon/blob/main/LICENSE) |
| reviewdog | 语言无关的诊断格式和 reporter | 接 SARIF/diagnostic，远程 reporter 需权限配置 | [MIT](https://github.com/reviewdog/reviewdog/blob/master/LICENSE) |
| CodeRabbit | 多语言评审体验；精度未作可比测量 | 账号/部署/模型及集成配置；工作流可借鉴 | 商业服务；本次未取得其核心的开源许可证，不按开源组件处理 |
| PR-Agent | 多 provider、多模型；模型决定部分语言能力 | provider/model 凭证或本地服务、部署、提示配置 | [当前主分支 MIT](https://github.com/The-PR-Agent/pr-agent/blob/main/LICENSE) |
| Cosign | 语言无关的 artifact/签名生态 | bundle、root、身份与信任材料；已有可选 wrapper | [Apache-2.0](https://github.com/sigstore/cosign/blob/main/LICENSE) |
| StrykerJS | JS/TS 等 mutation；其他 Stryker 生态不在本轮实测 | runner/plugin 配置及额外算力；优先导入固定格式结果 | [Apache-2.0](https://github.com/stryker-mutator/stryker-js/blob/master/LICENSE) |

这些许可证是本次在线读取的文本快照，不是所有版本和组件的法律结论。接入时应固定版本与来源，分别核对依赖、制品和服务条款。没有对上述产品给出准确率、运行速度或成本优劣的数值排名。

### 4.3 可借鉴能力和不应跟进的方向

最值得借鉴的是 Nx/Turbo 的明确不确定性回退、testmon 的数据生命周期、reviewdog 的诊断消费接口、Cosign 的信任分层和模型评审工具的可操作反馈。现有 adapter 应先完成来源/版本/状态校验与真实 producer 合同测试，再扩张类型。

StrykerJS 说明测试质量是独立维度：即使 R01/R02 修复，“所有测试执行且通过”仍不能证明断言充分。可在证据中接入 mutation/coverage 报告并说明范围，但不应为此把默认本地验证变为全量昂贵扫描。SaaS、多租户、遥测、模型主审和重写语言没有现成证据支持进入当前优先级。

## 5. 真实验收和样本数据建设

### 5.1 当前可确认、待补与不适用的验收

| 层级 | 当前证据 | 下一项有价值的验收 |
| --- | --- | --- |
| 协议/规则回归 | 本轮 47 文件 430 pass + 3 skip；结构、hash、策略、进程边界 | R01—R06 的失败→修复通过案例及合法对照 |
| 原生 runner | 三 OS CI job；每 OS harness 定义的 30 场景 | 通过原始插件和 detectTools 的安装后 CLI；补排除/跳过/多配置/工具版本变化 |
| gitleaks 后端 | 可定位到替身参数回归 | 固定真实版本的 staged/unstaged/untracked/ignore/range、后端失败与无后端对照 |
| 包和 transport | 实际 tarball 消费端、SDK、CLI、stdio MCP | 修复候选重新验证，而不是继承旧候选绿灯 |
| Claude/Cursor | 配置与协议替身、worker 预算/再入测试 | 固定宿主版本，真实 stop/subagent/cancel/multi-workspace/MCP 使用记录 |
| GitHub publisher | 只读 evidence job、可信代码分离、本地输入校验 | 同仓库/fork 实际通过/失败/不完整与乱序 run；正式写操作另按任务授权执行 |
| SARIF/Cosign | reviewdog 本地真消费、Cosign 指定版本正反例 | 若宣称 Code Scanning，增加真实上传记录；Cosign 无需变成默认依赖 |
| 真实项目效果 | 三个种子，miss/extra/unknown 和计时 harness | 按真实解析/执行边界分层抽样；规模可先小后大 |

### 5.2 可复现语料设计

分三层：A 层固定回归反例作为发布门槛；B 层固定 runner/构建系统的生产链路 smoke；C 层真实开源项目补丁用于效果测量。初期建议每类语言先至少一个可运行项目，再扩展到原方案建议的十项目/五十补丁；数量是研究规模建议，不是准确率证明。

每个样本保存 repository URL、许可证、base commit、补丁来源与摘要、人工行为判断、完整测试命令、依赖锁/工具链、平台、候选版本、冷/热缓存条件和结果。先验证原始基线，再分别运行选择集和全量集；没有可靠全量基线或存在不可归因 flaky 的样本标为 unknown，不从分母中静默删除。

应报告的指标及口径：

- **已确认漏选**：全量中因补丁而失败、且不在选择集合内的测试；需要人工排除环境/flake。它只是可观察漏选的下界，不是所有受影响测试的真值。
- **执行遗漏**：请求且按策略必需，但实际结果中没有执行证明的测试文件/单元；用请求范围作分母，与选择漏选分开。
- **额外执行**：选择集相对事先建立的影响真值的多余部分；若仅定义为“选中但通过”，必须注明通过不等于没必要执行。
- **误阻断/回退/未知**：按每次决策记录原因、分母和人工归因；显式策略禁止通过不算误阻断。
- **耗时与资源**：固定硬件/并发/缓存/工具链，记录采集、映射、工具、写产物各阶段及分布；本轮没有可发布的竞品性能比值。

## 6. 优先投入判断

当前最强的资产是跨入口统一证据与决策内核，当前最弱的环节是执行事实粒度和映射不确定性策略。优先完成“准确记录→安全判定→真实集成→真实效果数据”的顺序，再建设更深的语言或外部工具接口。下一份 [升级方案](03-upgrade-roadmap.md) 将每项投入对应到具体发现、收益、兼容方式、工作量和验收条件。
