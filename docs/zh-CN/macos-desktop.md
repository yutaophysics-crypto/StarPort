# Mac 独立窗口

[English](../macos-desktop.md) | 简体中文

Mac 入口是原生 AppKit 窗口内的 WKWebView。页面、后端和 CLI 仍复用星港，应用窗口共用一份本机数据。页面没有浏览器标签栏和地址栏。

## 安装与更新

要求 macOS 14+、Node.js 24+ 和 Apple Command Line Tools。缺少编译工具时可运行 `xcode-select --install`，按系统提示完成安装。在项目目录运行：

```sh
npm ci
npm run install:macos
```

默认安装到 `~/Applications/StarPort.app`；后续更新会复用当前项目已安装的应用位置，包括原有中文名称的应用。可用 `--output /Applications/StarPort.app` 指定位置。安装器编译应用、使用蔚蓝品牌图标并生成本机配置；替换前将旧应用保存在 `.data/source-backups/macos-app-日期/`。本机路径、应用包、聊天数据库和凭据不提交到仓库。

应用记录当前项目路径和 Node 可执行文件路径，移动项目或更换 Node 位置后需要重新安装入口。`npm run launch` 会优先打开匹配本项目、端口和数据目录的独立应用；`--no-open` 继续只启动服务，避免原生应用启动服务时递归打开自己。Windows 和 Linux 的启动方式保留。

如果项目或启动检查脚本在文稿文件夹，macOS 首次启动可能询问「文稿」访问权限；允许后才能读取项目和本机数据。应用采用本机临时签名，重新编译后系统可能再次询问。检查超时或拒绝权限时不会跳过代理检查；完成权限后退出应用再启动。

## 多窗口

第一次点击 Dock 图标启动应用和页面，之后普通点击切回已有窗口；上次使用的窗口被最小化时会恢复它。使用 `⌘N` 或屏幕顶部菜单栏的「文件 → 新建窗口」打开新的独立窗口。页面内没有增加新建窗口按钮；Shift + 点击 Dock 不是新窗口入口。窗口菜单列出已打开的窗口，`⌘W` 关闭当前窗口，`⌘Q` 退出窗口应用；后台星港服务和已经开始的任务继续运行。关闭全部窗口后，再点击 Dock 会打开一个窗口。

每个窗口有自己的页面状态，可以停留在不同对话。数据库、分组、对话记录和工具登录共用；这是多窗口，不是不同账号或不同数据目录的隔离实例。草稿仍沿用星港现有按对话保存的规则。窗口共用 WebKit 的持久化网站存储，主题、语言等设置可复用；浏览器原有的网站存储不会复制进原生应用。

文件选择、附件和备份下载、网页确认框使用原生系统对话框。外部文档链接由默认浏览器打开，本机星港页面在应用中显示。

在桌面工作台的「群聊与手机」中点击「打开群聊」，群聊会成为同一个星港应用中的独立窗口，公网 HTTPS 服务也可使用。个人工作台和群聊共用 Dock 图标与窗口菜单。`⌘N` 根据当前窗口类型打开新的工作台或群聊窗口；普通点击 Dock 仍恢复当前窗口。每个群聊窗口只在所选群聊服务的同源地址内导航，外部网页交给浏览器。

群聊窗口使用你在星港中登录的服务器账号打开，不需要在每个窗口重新登录。Safari 的登录不会复制进星港原生窗口。手机和直接通过浏览器访问群聊的方式继续可用。

## 本机代理检查与群聊地址

已有固定代理配置的电脑，可以指定自己的只读检查脚本：

```sh
npm run install:macos -- --proxy-audit /absolute/path/claude-proxy-audit.py
```

应用在每个新建工作台窗口加载前运行这个脚本，非零退出时停止打开工作台并提示检查代理。重新安装会保留已配置的检查脚本，除非显式改成其他路径。它不修改 CLI 设置、代理节点或防火墙规则。

应用的本机配置在 `Contents/Resources/starport-config.json` 中。安装时可用 `--node`、`--python`、`--port` 指定运行环境，用 `--collaboration-url https://groups.example.com` 把统一群聊服务设为默认群聊地址。

实现参考：[Apple WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate)、[Dock 再次启动事件](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldhandlereopen(_:hasvisiblewindows:))、[WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate)。
