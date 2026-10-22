# 审查证据索引

报告：[代码审查](../01-code-audit.md)、[功能/数据/竞品](../02-product-modules.md)、[升级方案](../03-upgrade-roadmap.md)。基线提交为 `188e07e03da3f3a21cd64f574f35a1fab0a384c7`。本目录是审计材料，不是升级后的功能实现。

| 材料 | 作用 | 验证边界 |
|---|---|---|
| [validation.json](validation.json) | 构建、116 项测试、CLI、实际 MCP stdio、包清单与环境 | Linux/Node24；其他平台和完整语言工具链未实跑 |
| [findings.json](findings.json) | F01—F21 的等级、类别、代码位置、报告行和复现索引 | open 表示尚未修复；设计限制与缺陷分开 |
| [reproduce.mjs](reproduce.mjs)、[reproduction-results.json](reproduction-results.json) | 12 个核心情景：Git、范围、聚合、hash、基线、路径、reader | `/bin/true` 是聚合逻辑替身；密钥是公开测试格式，非真实凭证 |
| [policy-probes.mjs](policy-probes.mjs)、[policy-results.json](policy-results.json) | 6 类策略/插件/Schema/扩展名情景 | 使用当前构建的原始模块和正式示例插件；不改产品代码 |
| [execution-probes.mjs](execution-probes.mjs)、[execution-results.json](execution-results.json) | 真实 Vitest 目标错配、fresh MCP、真实 CLI 参数；有界 timeout/输出实验 | gitleaks 仅参数/范围替身，未运行真实 gitleaks；未尝试耗尽内存 |
| [integration-probes.mjs](integration-probes.mjs)、[integration-results.json](integration-results.json) | MCP 初始化配置、npm 元数据；评论作者与分页 | 无远端包安装/执行；GitHub fetch 完全替换为本地 mock，未发送评论 |
| [integration-notes.md](integration-notes.md) | 集成探针说明 | 不把模拟 HTTP 权限判断当真实 GitHub 可利用漏洞 |
| [dependency-audit.json](dependency-audit.json) | 生产依赖公告和传播关系快照 | 10 个受影响节点，不是 10 个独立已证实项目漏洞 |
| [competitor-licenses.json](competitor-licenses.json) | 6 个组件的固定 commit、LICENSE URL/SHA-256 | 只覆盖指定组件，不推及所有依赖和商业服务 |
| [competitor-sources.json](competitor-sources.json) | 报告采用的外部来源 URL 与核对日期 | 竞品未安装运行，性能/准确率/封网表现未测 |
| [baseline-files.json](baseline-files.json) | 基线 tracked 文件的 Git blob ID 与分类 | 用于识别被审查内容；不是逐行穷尽验证的声明 |
| [artifact-validation.json](artifact-validation.json) | 文档链接、JSON、脚本语法与生产文件未变核对 | 本报告材料自身检查，不取代产品测试 |

## 复核方法

在仓库根目录准备依赖并构建。以下脚本以被审查版本的现有缺陷为预期，**退出 0 或 `reproduced:true` 表示成功复现缺陷，不表示产品已经通过修复验收**。修复以后它们可能不再得到相同结果，应转成正式的健康行为回归测试。

```sh
npm run build
node docs/reviews/2026-10-22/evidence/reproduce.mjs
node docs/reviews/2026-10-22/evidence/policy-probes.mjs
node docs/reviews/2026-10-22/evidence/execution-probes.mjs
node docs/reviews/2026-10-22/evidence/integration-probes.mjs
```

核心和执行脚本向 stdout 输出 JSON；policy 脚本刷新旁边的 `policy-results.json`。所有目标仓库/进程 fixture 都放在临时目录并清理。当前脚本的运行证据来自 Linux/Node v24.19.0，使用 POSIX 可执行文件和符号链接，不保证 Windows 可直接运行。

初始化包名的 registry 核对是可选的只读联网查询：

```sh
node docs/reviews/2026-10-22/evidence/integration-probes.mjs --registry-check
```

本次查询在 2026-10-22 返回 E404。未来 npm 名称注册状态可能变化；不运行该查询时输出会标记未查询。脚本不安装或执行远端包，不能当作供应链攻击演示。

已有包清单验证使用临时可写 cache，先单独成功构建，再跳过 prepack 重复执行：

```sh
npm pack --dry-run --json --ignore-scripts --cache /tmp/patchprove-review-npm-cache
```

`validation.json` 的包文件数是当时包含正在编写的审查资料的快照，不作为最终发行包大小承诺。没有创建或发布 npm tarball；没有真实 GitHub 评论、宿主拦截、依赖升级或功能修复。
