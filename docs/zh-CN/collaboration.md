# 群聊、手机端与绑定电脑

[English](../collaboration.md) | 简体中文

> **开发中：** 群聊、手机端和自行托管的服务器都还没有完成，可能有问题，行为和保存的数据也可能还会变。

星港新增独立的多人账号与群聊服务。手机端以可安装 PWA 交付；电脑端继续使用原来的本地工作台和 CLI 适配器。

## 本机开始使用

1. 打开星港，点击 **群聊与手机**。登录窗口填写服务器地址、该服务器的账号和密码；可在选定服务器创建账号，是否开放注册由服务器管理员决定。已保存登录时直接打开该账号上次查看的群聊。
2. 群主创建群聊，分享服务器地址与动态邀请码。加入者登录这个服务器的账号后，在群聊页面点击 **加入**，粘贴邀请码。不能用其他服务器的账号直接加入；不同服务器的同名账号不会被合并。
3. **我的电脑 → 设置这台电脑的 Agent** 为这个服务器账号选择完整工作目录和执行权限。模型登录、CLI 凭据与私人工作台记录留在本机。手机登录同一服务器账号，选择自己的电脑、模型和目录，再发起 Agent 调用。
4. **另一个账号窗口** 打开空白登录，可同时连接另一服务器或同一服务器的另一账号。Mac 群聊窗口中按 `⌘N` 可新开当前账号的群聊窗口；Windows 使用独立 Edge 应用窗口。一个窗口退出不改变其他窗口，**连接与数据 → 群聊连接设置 → 忘记连接** 则移除这个服务器账号的保存登录并断开它的本机 Agent。
5. 点击左下角账号右侧的 **ⓘ**，查看当前账号和登录时填写的服务器地址；地址可复制。退出账号放在这个信息面板中，查看信息不会退出登录。
6. 消息编辑器 `Enter` 发送，`Shift+Enter`、`Ctrl+Enter` 换行；中文输入法选字时不会发送。

自己部署服务器：在 **设置 → 连接与数据 → 本机服务器** 配置端口与对外地址，再启动。账号、群聊记录与管理操作保存在该服务器的电脑，星港源码不预设任何人的服务器地址。注册开关、账号创建、停用和重置密码都在这个面板。跨网络使用需要一个可达的 HTTPS 入口，详见 [服务器与账号部署](account-center.md)。

## 每个人自己的模型与额度

| 手机中的入口 | 实际执行方式 | 凭据所在位置 |
|---|---|---|
| ChatGPT / Codex | 现有 Codex App Server 适配器，支持原工具的 ChatGPT 登录 | 调用者绑定电脑上的 Codex 登录 |
| Claude Code | 官方 Agent SDK 驱动调用者的 CLI | 调用者电脑上的 Claude 登录或原生配置 |
| Antigravity | 调用者的 AGY CLI / stream-json | 调用者电脑上的 AGY 登录 |
| DeepSeek Harness | 原生 SDK / JSON-RPC | 调用者电脑上的 Harness 模型配置 |

每位调用者先在自己的电脑安装、登录所需工具，或在原工具中配置自己的 API Key。手机与群聊服务器不接收模型密钥，也不会借用群主或其他成员的电脑、登录或额度。群聊服务器只存账号、群成员、消息、设备能力和任务状态。不要把模型密钥当作群聊消息发送。

调用者的账号必须与目标电脑登记的星港账号一致。手机不能指定任意电脑、文件路径、可执行程序或权限参数；只能从本人已连接电脑发布的目录和工具中选择。模型目录来自这台电脑的原工具，亦支持手动填写原工具接受的模型标识。

## 电脑权限与审批

电脑端连接时选择远程执行方式：

- **只读分析**：Codex 使用原生 read-only；Claude 使用 plan；AGY 使用 plan、原生权限和终端沙箱。DeepSeek 的当前适配器没有可验证的只读模式，此模式不开放 DeepSeek 调用。
- **允许执行与编辑**：Codex 在工作目录内工作并请求额外权限；Claude 使用 acceptEdits，需审批的操作发送到手机；AGY 使用 accept-edits、自动批准工具和终端沙箱；DeepSeek 沿用原工具能力与配置。

群聊执行沿用 CLI 的权限语义。选择工作目录不等同于所有 CLI 的操作系统级文件隔离；Claude 已配置的 `--restricted` 和本机沙箱仍然生效。无需更改原来的 Claude 限制配置。

只有本次调用者能看到和回应审批/问题、停止自己的任务。其他群友只能看到共享回复与简要执行进度，不会收到审批命令参数或电脑路径配置。

电脑使用主动向群聊服务发出的连接，不需要向公网开放本地 `3210` 端口。电脑需保持开机且星港工作台正在运行。手机退到后台不会停止已经开始的电脑任务；等待审批的任务需调用者回来回应。

## 离线、恢复与重复执行

- 电脑离线时，新任务保存在服务端队列中，等待该电脑上线。
- 手机断网时保留应用外壳与本机草稿；不缓存聊天内容或账号接口，也不在后台自动补发消息。
- 发送与调用使用幂等标识。相同请求重试不会额外生成任务。
- 已开始任务的电脑租约失效、执行桥重启或设备被撤销时，任务明确标为中断，保留已发布回复。不会自动重跑有不确定结果的命令；调用者确认后重新发起。
- 执行结果使用连续事件序号，迟到的数据不能覆盖已结束任务。无法发布的结果另保存在电脑执行数据目录中。

## 在手机上使用与安装

手机需要访问群聊服务的 **HTTPS 地址**，不能用 `127.0.0.1` 访问另一台电脑。先完成下面的部署，再在手机登录同一星港账号，打开 **我的电脑** 选择执行电脑。

账号属于你登录的服务器；群聊、成员和邀请码属于对应群聊服务器。两台电脑各自打开 `127.0.0.1:3218` 仍是两个不同服务器。加入同一个群时必须填写群主提供的同一个 HTTPS 群聊地址。使用独立账号服务的部署，须信任同一个账号服务才能共用账号。

- **iPhone / iPad**：Safari 打开群聊网址，通过分享菜单添加到主屏幕；提供该选项的版本中开启“作为 Web App 打开”。参考 [Apple 官方说明](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27)。
- **Android**：支持的浏览器中选择“安装应用”或“添加到桌面”。本项目包含 manifest、192/512 图标与 service worker，HTTPS 部署满足这些基础安装条件。参考 [Chrome 安装条件](https://web.dev/articles/install-criteria)。
- **HarmonyOS**：使用系统浏览器访问同一响应式网址；浏览器提供“添加至桌面/安装”时可使用该入口。安装提示和 service worker 取决于系统与浏览器版本，不把 PWA 宣称为 HAP 原生包；不支持安装的浏览器仍可在线使用网页。参考 [华为浏览器桌面快捷方式说明](https://consumer.huawei.com/cn/support/content/zh-cn00448896/)。

当前交付包含桌面与手机布局、触控、独立应用显示、安装引导、离线外壳与草稿保留。iOS/Android/HarmonyOS 真机验收与应用商店发布需要相应设备和账号，不包含原生 IPA/APK/HAP 包。

## 自行部署

群聊服务与电脑执行桥是分开的。公网服务器只运行群聊服务，不需要安装或登录任何模型 CLI。

### Docker + HTTPS

在部署主机安装 Docker Compose，为一个域名配置 DNS，并开放 80/443。复制 `deploy/.env.example` 为 `deploy/.env`，把 `STARPORT_DOMAIN` 改成自己的域名，然后：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build
```

Caddy 管理 HTTPS；群聊后端仅在 Docker 内部开放。数据库存放在 `group_data` 卷，不能把旧电脑的 `.data`、CLI 登录、密钥、模型运行时或个人记忆打包进服务器镜像。`.dockerignore` 已排除这些目录。

在 `.env` 中设置 `STARPORT_ACCOUNT_URL=https://accounts.example.com/account`。群聊服务不接收账号密码；新账号注册由账号服务的 `STARPORT_ALLOW_REGISTRATION` 控制。群聊仍只允许通过群主邀请加入。

每台电脑先在本地 **群聊与手机** 登录账号服务，再输入该 HTTPS 地址和邀请码加入。也可设置 `STARPORT_COLLAB_URL=https://groups.example.com` 后启动工作台，把这个统一群聊服务设为默认地址。

### 直接运行 Node

要求 Node.js 24+：

```sh
npm ci
STARPORT_ACCOUNT_URL=https://accounts.example.com/account STARPORT_PUBLIC_URL=https://groups.example.com STARPORT_COLLAB_HOST=127.0.0.1 npm run start:collaboration
```

通过你自己的 HTTPS 反向代理转发到 `127.0.0.1:3218`。Windows PowerShell 用 `$env:STARPORT_PUBLIC_URL='https://groups.example.com'` 等环境变量赋值。未经 TLS 的非本机服务地址会被电脑连接器拒绝。

可选环境变量：`STARPORT_COLLAB_PORT`（默认 3218）、`STARPORT_COLLAB_DATA`（默认 `.data/collaboration`）、`STARPORT_COLLAB_HOST`、`STARPORT_PUBLIC_URL`、`STARPORT_ALLOW_REGISTRATION`。

### 在不同网络上测试本机群聊服务器

可使用 [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) 给本机群聊服务生成临时公网 HTTPS 入口，无需域名或 Cloudflare 账号：

```sh
cloudflared tunnel --url http://127.0.0.1:3218
```

记录输出的 `https://随机名称.trycloudflare.com`。群聊后端的 `STARPORT_PUBLIC_URL` 必须是这个地址；隧道要保留请求的 Host，转发到本机 3218。此入口只转发群聊服务，不转发个人工作台 3210。两端无需互相处于同一局域网，也不需要安装自签名证书。

正常启动器可读取当前数据目录中的 `local-services.json`（不提交到 Git）：

```json
{
  "collaborationUrl": "https://groups.example.com",
  "server": true,
  "events": "poll"
}
```

`collaborationUrl` 设置电脑端的群聊默认地址；`server: true` 表示这台电脑还运行本机群聊后端，并将公开地址设为同一 HTTPS 地址。其他参与电脑省略 `server`，仅连接远程服务。使用 `npm run launch` 或桌面入口应用配置；已启动的后端需要在没有任务运行时重启。隧道或 HTTPS 反向代理须单独启动，启动器不会创建公网入口。

Quick Tunnel 不支持 SSE，设置 `events: "poll"` 后，群聊页面每 5 秒刷新，仍可发送消息、查看任务进度与处理审批。默认 `events: "sse"` 保留实时推送。直接运行群聊后端时，对应环境变量为 `STARPORT_COLLAB_EVENTS=poll`。

每位成员必须在统一服务上注册、登录，再通过该服务生成的邀请加入。另一台电脑原有本机服务中的账号不会自动迁移。已有绑定须确认服务地址和账号，不能把其他服务的设备授权直接复制过来。同一数据库迁移公开地址后，原群聊与邀请码仍保留，但旧邀请链接中的 `127.0.0.1` 不适合分享，应重新生成链接。

临时网址随隧道进程结束而失效，重新创建隧道会换网址；这时需更新服务公开地址、两端连接配置和邀请链接。长期运行应改用固定域名的 Cloudflare Tunnel 或已有的 Docker + HTTPS 部署。这台电脑作为服务器时须持续开机并保持服务及隧道运行。

## 数据位置与验证

- 原有本地记录：`.data/hub.sqlite`，不作迁移、不自动共享。
- 群聊服务：`.data/collaboration/collaboration.sqlite`，或部署的 `/data`。
- 电脑连接：`.data/collaboration-link.json`。只保存受保护的设备授权，不保存星港密码或复制模型密钥；Windows 限制为当前用户与 SYSTEM，其他系统使用 0600。
- 电脑群聊执行记录：`.data/collaboration-workers/<分区>/worker.sqlite`，不读取本地个人聊天和共同记忆。
- 当前账号与窗口的存储方式见 [服务器与账号部署](account-center.md)。

`npm test` 包含群成员/设备隔离、两位调用者与四个适配器、重复提交、租约/重启、手机审批/停止和原工作台回归测试。`node tests/collaboration-ui-fixture.mjs` 是隔离的界面验收服务，使用模拟工具与测试账号，不调用真实模型。

账号服务按账号 UUID 保存最近的群聊记录，仅包含服务器地址、群 ID 和更新时间。群聊服务器使用与账号、服务器及原登录会话绑定的有限授权来更新此记录；该授权不能登录账号服务、读取账号数据或修改账号设置，原账号登录会话退出或到期后失效。打开窗口时会验证当前成员关系，过期的记录不会绕过加入权限。
