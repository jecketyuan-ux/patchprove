# 当前代码候选验收账本

核心代码：`fbaa4cbe8bd436dc67026d6cbdf5f3d8d5bb4740`，tree `3f3939c0a7c77b06828874b6466d01ddf6bfcddf`。本地对应提交、运行文件摘要、命令和真实结果见 candidate.json。记录完成后追加账本及 CI 存档排除参数，最终 PR head 仍须单独通过完整远程 CI；不借用历史绿灯。

- Node 22/24：各 54 个文件，488 通过、3 个按平台跳过。
- 六执行器 30 场景；安装后原始 CLI/detectTools/插件 24 场景；Gitleaks 10、Turbo 4、资源预算 4、Cosign 4，以及 reviewdog 消费。
- 五固定开源项目、十受控补丁；八已归因失败单元未观察到漏选。90 个请求单元中有八次 scope unknown，三例正常补丁因 skip/未知范围被严格策略阻断。不是历史 PR，不宣称零漏检。Java 全量原始 XML、JSON/JUnit、日志、补丁和许可证单独保存。
- 宿主和完整 fork publisher 真实验收仍 not-run，保持实验性；不发布 npm/tag/release。

manifest.json 记录目录中所有文件的字节摘要，排除其自身。CI 远程记录保留 run/head/job/artifact 链接与结果；需要以 PR 当前提交的检查为准。Windows/JDK17 Gradle 中文路径测试声明 UTF-8 JVM 环境，不把原 ANSI 环境的 ClassNotFound 失败计作断言执行。
