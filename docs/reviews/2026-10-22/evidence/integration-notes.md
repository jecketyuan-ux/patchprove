# 集成复现说明

在仓库构建完成后运行：

```sh
node docs/reviews/2026-10-22/evidence/integration-probes.mjs --registry-check
```

脚本只在临时目录写 fixture 并自动清理；stdout 为 JSON。GitHub `fetch` 完全替换为本地 mock，不发送评论。`--registry-check` 只查询 npm 元数据，不安装或执行远程包。本次输出保存在 [integration-results.json](integration-results.json)。

- MCP 配置来自原始 [mergeMcpConfig](../../../../src/init-agent.ts#L162)，对照 [package.json 的包名和 bins](../../../../package.json#L2)；[现有测试](../../../../test/init-agent.test.ts#L60)仅验证配置字符串。没有本地 bin 的 npx 将查询配置中的包名；本次 registry 查询返回 E404。若未来同名包被注册，输出可能变化；本次未验证恶意包利用。
- sticky marker 作者冲突调用原始 [post-comment.mjs](../../../../action/post-comment.mjs#L65)，注入带公开 marker 的普通用户评论。脚本实际选择该 URL 发起 mock PATCH；模拟权限拒绝时退出 2。真实 GitHub token 的编辑权限未测试。
- 分页 fixture 有 101 条评论，原机器人报告位于第 101 条。原始脚本只读取第一页，随后发起 mock POST，证明会漏掉后页已有报告。

生成结果的 `sourceEvidence` 保留 commit 188e07e 的准确源文件与行号。报告中的 checkout 身份、Cursor 宿主期限、`pull_request_target` 边界属于其他静态审阅结论，未用该脚本冒充真实宿主/GitHub 验证。
