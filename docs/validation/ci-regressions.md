# 2.0 PR 跨平台回归记录

升级 PR：<https://github.com/jecketyuan-ux/patchprove/pull/7>。以下失败记录不能作为合并依据；合并须核对 PR 当前 head 的新一轮完整 CI。

| 远程运行 | 已暴露的问题 | 修复和保留的验证 |
| --- | --- | --- |
| [39811582275](https://github.com/jecketyuan-ux/patchprove/actions/runs/39811582275) | macOS `/var` 与 `/private/var` 目录身份不一致；Windows batch 参数二次转义、stdin EOF 和测试路径假设 | 统一路径身份；batch 使用已转义命令行；保留成功和失败退出码；真实 Windows `.cmd/.bat` 参数及 Maven/Gradle 探测回归。 |
| [39813303592](https://github.com/jecketyuan-ux/patchprove/actions/runs/39813303592) | macOS 全套单元测试通过但安装后的 MCP 因入口别名静默退出；Windows `RUNNER~1` 与长路径使输出排除、策略路径和覆盖数据匹配失效 | MCP 启动入口解析真实路径；文件身份采用原生 realpath 以展开 Windows 短路径；新增目录别名及文件符号链接的真实 stdio 回归，保持暂存/工作区与策略断言。 |
| [39814358568](https://github.com/jecketyuan-ux/patchprove/actions/runs/39814358568) | Windows 原生相对路径包含反斜杠，变更路径排除成功但内容快照仍纳入嵌套报告，重复执行哈希不稳定 | 相对排除路径按宿主分隔符转换为 Git POSIX 路径；新增嵌套输出写入前后快照身份一致、相邻源码变化仍改变身份的回归，同时保留 POSIX 合法反斜杠文件名语义。 |

目录别名 MCP 回归在 Linux 上复现了修复前的 `Connection closed`，修复后握手及 `tools/list` 成功。原生工具链的日志和报告由每轮 CI artifact 保留，必须以候选 SHA 对应结果为准。测试预算调整只用于真实宿主启动和 CI 调度；显式短超时、取消及退出码断言仍保留。

第二轮 Windows 原生执行为 29/30：Maven 多模块的 `-pl alpha` reactor 匹配受临时目录短路径影响。原生 harness 现在像产品 `analyze` 的 Git 根目录一样使用真实长路径，同时记录请求路径和实际执行路径；保留模块选择与真实测试计数断言。第三轮 [Windows 原生 job](https://github.com/jecketyuan-ux/patchprove/actions/runs/39814358568/job/119948822842) 日志确认 30/30 通过，包括 Maven 多模块，三个语料夹具亦完成；该事实不替代最新候选的完整 CI 成功结论。

发布前真实宿主、可信 GitHub publisher 和效果样本要求仍见 [发布验收清单](../release-readiness.md)，本记录不代表这些验收已完成。
