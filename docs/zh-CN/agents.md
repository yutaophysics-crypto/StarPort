# Agent 工具：模型、权限与用量

[English](../agents.md) | 简体中文

星港通过各工具自己的原生接口和已有登录来驱动它们。本页说明每个工具怎样接入、星港里的选项是什么意思，以及任务运行时星港显示什么。除特别说明外，选项按对话保存。

## 接入方式

| 工具 | 接入方式 | 原生会话 |
| --- | --- | --- |
| Codex | 本机 Codex App Server（JSON-RPC） | 可续接的线程 |
| Claude Code | 官方 Claude Agent SDK 驱动本机 CLI | 可续接的会话 |
| Antigravity | 本机 AGY CLI 的流式 JSON | 可续接的会话 |
| DeepSeek Harness | 已发布的官方 SDK（JSON-RPC） | 每轮新建 SDK 会话 |

星港只用一次的工位（压缩、排程、伙伴之间的调用、工作流步骤和考位）会向 Codex 请求临时线程。Codex 不保存这些线程，所以它们不会出现在 Codex app 的列表里。对话和 @伙伴 的工位仍是可续接的线程，照常列出。不支持临时线程的 Codex 版本仍像以前一样保存。

**设置 → 连接与数据** 把安装状态和真实连接检查分开显示：工具装好了，账号不一定能用。用工具自己的登录方式登录后，点 **重新检查工具**。星港不保存 API Key、登录令牌或账号密码。

星港按以下顺序寻找工具：你在 **连接与数据** 里填写的路径、当前 `PATH`，然后是各工具的标准用户安装目录。Antigravity 最后还会查找星港自己 `.runtime/antigravity` 文件夹里的副本。Antigravity 的对话和用量查询都在它平常的本机登录环境中运行；星港不注入 SSH 标记，否则原工具可能改用另一套凭据存储。

在 Windows 上，DeepSeek Harness 桌面版可以启用 `dsh` 命令。星港会识别 `PATH` 里官方的 `resources/runtime/cli/bin/dsh.cmd`；如果启用命令时星港已经在运行，就在 **连接与数据** 里填入该文件的完整路径。之后星港直接使用桌面版自带的运行时和已有登录，不需要另装 CLI。桌面版的模型偏好作为默认值，SDK profile 里明确保存的偏好优先。DeepSeek 账号登录的额度在桌面版里查看，它与开放平台的 API 余额是两回事。

## 模型与思考强度

可以从列表里选模型、选 **跟随工具默认**，或填写 **自定义模型**。Codex 从 App Server 的 `model/list` 读取目录，Antigravity 从 `agy models` 读取，Claude Code 通过官方 SDK 读取本机 CLI 的目录。Claude 模型按 `resolvedModel` 显示完整名称，例如 Claude Opus 5.5，保存的值仍是原工具的别名或标识。DeepSeek 使用已安装工具的目录、你的配置和已保存的默认值。读取目录从不发送模型消息；Claude 的目录查询还会关闭工具、启动钩子和会话保存。工具升级后，点模型列表旁的 **刷新列表**。

思考强度取决于工具和具体模型。Claude Code 和 Codex 从各自的原生模型目录读取支持的档位，Claude 的 `xhigh` 显示为 **Extra**。DeepSeek 从已安装的适配器读取档位（包括 **Off**）；第三方 DeepSeek 服务只有声明了 `reasoningEfforts` 才显示自定义档位。Antigravity 使用其 CLI 提供的 Low、Medium、High。

星港无法确认某个模型的能力时（例如选了 **跟随工具默认**、自定义模型，或目录读取失败），只提供工具默认档位并说明原因。切换模型不会悄悄降低已保存的档位：不兼容的档位会提示你重新选择，发送前还会再检查一次。各工具的选择分别保存。实际能否使用仍取决于你的账号和原工具的访问策略。

## 权限

权限修改从下一条消息开始生效，任务运行中不能修改。星港每次启动或续接原生会话时都会重新发送所选权限，所以收窄后的设置不会继承之前更宽的权限。星港不修改任何工具的全局设置。

### Codex

输入框下方和侧栏的 **权限** 选择器提供：

- **请求批准**：在工作文件夹内工作；需要额外权限时由你批准或拒绝。
- **帮我批准**：文件夹和网络限制不变，但额外权限请求交给 Codex 原生的 [自动审核](https://learn.chatgpt.com/docs/sandboxing/auto-review)。审核可能拒绝，并不是全部放行。
- **完全访问权限**：Codex 原生的完全访问配置。可以修改电脑允许访问的任何文件并联网，不再询问；系统和组织策略仍然生效。

点 **应用权限**（或 **启用完全访问权限**）确认。新对话从 **请求批准** 开始；旧对话保留原来的只读范围，直到你应用新的选项。如果本机 Codex 版本不支持自动审核，该选项会被禁用，运行也会被拒绝。Codex 返回的策略限制或错误不会被悄悄绕过。

### Claude Code

**工作方式** 提供 **请求批准**、**计划 / 只读分析**（新对话的默认值）、**普通对话（需审批的操作拒绝）**、**允许编辑文件**、**自动审核** 和 **跳过权限审批**。

- 需要审批的操作会通过 SDK 的 `canUseTool` 显示为卡片，可选 **允许这一次** 或 **拒绝**。**普通对话（需审批的操作拒绝）** 使用原生的 `dontAsk` 行为，直接拒绝这类操作。
- **自动审核**（原生 `auto`）由 Claude Code 自己决定是否放行；能否使用取决于你的账号、模型和设置。
- **跳过权限审批**（原生 `bypassPermissions`）只在你明确选择时启用。之后大部分工具操作直接执行，包括工作文件夹以外的文件操作。
- Claude Code 自己的允许和拒绝规则、强制询问规则、计划模式限制以及提问，都保持原生行为。如果原生初始化没有启用所选模式，星港会报告错误，而不是换成别的模式。

**使用独立 Git 工作树** 让这个对话在自己的工作树里运行。

### Antigravity

**工具权限** 默认为 **允许所有工具**：星港每次启动或续接会话时都会传入原生的 `--dangerously-skip-permissions`，自动批准命令执行和文件读写。**遵循原工具权限** 沿用 Antigravity 自己的规则；由于星港以非交互方式运行 Antigravity，需要弹窗审批的操作会被拒绝。**启用终端沙箱** 是独立的设置，选中后继续生效。这些选项只影响星港启动的会话。见 Antigravity 的 [非交互模式权限](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode)。

## 审批与提问

Agent 提出的问题可以在对话下方回答，完成后点 **提交回答**。Codex 原生的 `requestUserInput` 和 Claude 的 `AskUserQuestion`（包括多选和自由填写）会直接回传给原工具。助手写出一个问题并附上两个以上的简短选项时，星港也会生成回答表单，把你的选择作为普通回复发送；这只是便捷入口，不代替权限审批。已提交的回答留在对话里，你的草稿和附件保留。

停止任务会撤销待处理的审批，不会自动放行。星港暂不处理的请求，例如 Codex 的额外权限扩展和 MCP 交互认证，会被拒绝并说明原因。

## 排队与引导

任务进行中按 Enter，消息会进入输入框上方的 **等待队列**。可以修改或删除；正在修改的消息会暂停排队，直到你保存或取消。队列保存在本地，刷新后仍在。当前任务成功完成后，排队的消息按顺序逐条开始。Codex、Claude Code 和 Antigravity 续用原生会话；DeepSeek 会等子任务结束并交回结果后，把对话记录交给下一次 SDK 会话。停止、失败或服务重启后，剩下的消息留在队列里，等你手动继续。

Codex 和 Claude Code 可以用 **引导** 把排队的消息交给正在运行的任务。Codex 使用原生的 [`turn/steer`](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)。Claude 通过原生流式输入以 `next` 优先级接收，在两次工具调用之间的间隙读取，不打断当前操作；只有原工具确认收到后，星港才把它显示为已发送。Antigravity 和 DeepSeek 支持排队、修改和删除，任务结束后继续。排队和引导的消息都可以带附件。排队和引导都不会批准任何权限。

## 执行过程与子代理

**执行过程显示** 提供 **隐藏**、**概览** 和 **完整** 三档，四个工具共用，刷新后保留。默认的概览模式下，任务运行时步骤保持展开；点步骤或子代理可以查看它的记录。任务完成、失败或停止后，过程收进 **查看任务过程**。隐藏过程不会隐藏审批、错误或停止按钮。

过程按工具实际报告的顺序保存和显示。Codex 显示公开的思考摘要、命令的实时输出、退出代码、文件差异和原生计划。Claude 显示公开的 thinking、原生工具名称、输入和结果。Antigravity 使用原生的步骤状态，DeepSeek 分开显示 reasoning、回复、步骤和结构化的工具结果。工具的输入和输出可以完整展开。工具没有公开的思考，星港不会补写；Codex 的原始 reasoning 块和签名也不显示。

失败、拒绝、停止和未确认结束分别显示；下一步开始或对话结束都不算工具调用成功的证据。任务结束时，星港立即显示保存后的最终状态。任务运行期间，页面每 5 秒以及重新连接后都会核对一次状态，不调用模型，也不清空草稿。

子代理显示在所属回复里面，包括任务说明、原生状态、最新操作、最后活动时间和运行时长。Codex 使用原生的协作与子线程通知，Claude 把子任务和原生工具作用域关联起来，DeepSeek 使用 SDK 的子代理事件，Antigravity 读取本机的子任务日志。各工具提供的细节不同；子任务没有详细步骤时星港会说明，没有结束证据时显示为未确认。

DeepSeek 的一轮回复结束，不等于任务结束。星港会保留 SDK 进程，直到父代理空闲、所有已知子代理结束，并且父代理处理完可续跑子代理的结果。停止按钮仍能中断整棵执行树。

导入的 Codex 和 Claude 对话会保留可以显示的过程。仍绑定原生会话的旧星港记录，在打开时会从原工具的本机记录恢复过程，不调用模型，也不重放工具。

## 上下文指示

输入框下方的 **上下文** 显示当前工具最近一次报告的上下文占用；点开可以看到 token 数、窗口大小和统计口径。Codex 使用 `thread/tokenUsage/updated` 里的 `last.totalTokens / modelContextWindow`。Claude 使用主会话最近一次请求的输入（包含缓存读写，不包含输出），对比模型报告的窗口大小，口径与 [Claude Code 状态栏字段](https://code.claude.com/docs/en/statusline#context-window-fields) 一致。累计用量、子代理和其他模型不计入这个百分比。

这个数值按原生会话分别保存。换了模型、工作文件夹或原生会话后，显示 **待获取**，直到下一次报告；识别到原生压缩时会清除旧数值。未发送的草稿和还没交给它的其他工具消息不计算在内。它不是账号剩余额度，也不预测工具何时压缩。Antigravity 和 DeepSeek 暂不报告上下文占用，显示 **暂不支持**。

## 剩余用量

在当前工具下点 **查询剩余用量**。弹窗可以在四个工具之间切换、刷新，并展开完整的厂商报告。每次查询都显示查询时间；没有数据、没有登录和查询失败都会明确说明，绝不显示其他账号的结果。

| 工具 | 查询内容 |
| --- | --- |
| Codex | 原生 `account/rateLimits/read`：各限额桶、剩余比例、重置时间、额外额度和可用重置次数，以及 Codex 返回的其他字段 |
| Claude Code | SDK 原生的 `/usage` 报告：订阅、会话 / 每周 / 各模型限额、额外用量与支出，以及这台电脑的用量归因 |
| Antigravity | 原生 `/usage` 和 `/credits` 文本报告，保持原格式；CLI 需要单独登录，与 IDE 分开 |
| DeepSeek Harness | 官方 `/user/balance`：可用状态、总余额、赠送余额和充值余额，保持原始币种和精度；第三方服务需在该服务处查询 |

查询使用工具现有的登录或服务配置。不会开始模型轮次、发送聊天消息、修改对话或兑换额度。厂商没有提供的字段不做估算。工具可能从自己的缓存返回结果；显示的时间是星港这次查询结束的时间。对 Claude，明确配置的 `--settings`（包括代理和工作目录规则）会保留，只在查询时禁用 hooks；SDK 的用量方法仍是实验接口，版本不兼容时会明确报错。

本地接口是 `GET /api/providers/{codex|claude|antigravity|deepseek}/usage?workspace=<绝对路径>`，受本地令牌和同源校验保护。DeepSeek 还接受 `service` 参数；自定义服务的凭据绝不会发往官方地址。

## 目标与计划模式

Codex 的目标模式使用原生的 `thread/goal/set/get` 状态，而不是靠提示词模拟。星港在每轮结束后检查目标，目标仍有效就继续。暂停会更新原生目标并中断当前轮。停止服务会停止工作；重启后需要你手动继续。不提供定时唤醒。

**计划模式** 使用 Codex 原生的 `collaborationMode: plan`，以及 Claude Code 和 Antigravity 各自的原生计划设置。当前的 DeepSeek SDK 没有对应接口，所以对 DeepSeek 禁用该选项，不用提示词冒充。

## 切换工具

各工具共享的是用户消息和完整回复，不是彼此的内部状态或工具缓存。切回某个工具时，它会收到自己还没见过的消息。失败或中断的回复仍然可见，但不会当作已完成的答案交给下一个工具。预算和压缩见 [长对话的上下文](../../README.zh-CN.md#长对话的上下文)。

## 参考

[Codex App Server](https://learn.chatgpt.com/docs/app-server) · [Claude Code 非交互模式](https://code.claude.com/docs/en/headless) · [Claude /usage](https://code.claude.com/docs/en/costs#using-the-usage-command) · [Antigravity CLI](https://antigravity.google/docs/cli/headless/) · [Antigravity /usage](https://antigravity.google/docs/cli/commands/usage/) · [AI Credits](https://antigravity.google/docs/cli/credits/) · [DeepSeek SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk) · [DeepSeek 余额](https://api-docs.deepseek.com/api/get-user-balance/)
