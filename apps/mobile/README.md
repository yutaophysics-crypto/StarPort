# 星港手机版

手机通过星港服务器查看账号下的电脑，并在所选电脑的原有对话里发任务。支持查看历史、批准或拒绝操作、回答模型问题、停止当前任务。每个对话沿用电脑上设置的 Agent 和权限。竖屏逐级进入，横屏有足够宽度时三个区域同时显示。

## 连接电脑

1. 更新星港电脑端与星港服务器。使用手机能访问的 HTTPS 服务地址。个人部署可沿用 [星港群聊服务器的部署方式](../../docs/zh-CN/collaboration.md)，电脑工作台继续只监听本机。
2. 在每台电脑的星港打开 **群聊与手机 → 我的电脑 → 设置这台电脑的 Agent**。使用同一服务器账号，为各台电脑分别命名，填写要开放的工作目录，勾选 **允许同一账号从手机查看和操作上述目录内的桌面对话**。
3. 手机安装后填写同一个 HTTPS 服务器地址，用该账号登录。点选电脑，再打开已有对话。多台电脑可同时保持连接。每次发送都明确指定电脑和对话。
4. 要撤销访问，在相应电脑取消勾选或断开账号连接。远程任务使用所选对话现有的权限。群聊里的「绑定电脑」选择不会决定手机工作台的发送目的地。

电脑主动轮询服务器。服务器转发指定对话的操作和结果，短暂在内存保存请求与结果，不复制桌面对话数据库，也不把手机的 IP、请求头、账号登录凭据或模型密钥交给 Agent。服务器本身接收网络连接，并能处理收发内容，请使用自己信任的星港服务器。对话内容里外链和远程媒体不会由客户端自动加载。

## 打包

- **安卓**：安装 JDK 17、Gradle 8.13 和 Android SDK Platform 36 / Build Tools 36.0.0。在 `apps/mobile/android` 运行 `gradle assembleDebug`。正式包通过 `gradle assembleRelease` 构建，可用 `STARPORT_ANDROID_KEYSTORE`、`STARPORT_ANDROID_STORE_PASSWORD`、`STARPORT_ANDROID_KEY_ALIAS`、`STARPORT_ANDROID_KEY_PASSWORD` 设置自己的签名。日后升级需要继续使用同一包名和签名。
- **卓易通**：使用签名后的通用 APK，从支持安装的入口导入。安装支持取决于实际设备和卓易通版本。本项目没有绑定 Google Play 服务，也没有原生 CPU 架构专用库。
- **iPhone / iPad**：在 Mac 的 Xcode 打开 `ios/Starport.xcodeproj`，选择 Starport scheme。模拟器构建不需要分发证书。真机安装或通过 TestFlight 分发需设置自己的 Developer Team 和签名。最低 iOS 16。GitHub 的 iOS build 工作流提供未签名的模拟器构建。
- **浏览器**：同一服务器的 `/remote/` 也可打开电脑对话。原有群聊 PWA 仍从服务器根路径进入。

## 隔离测试

运行 `node scripts/run-tests.mjs tests/mobile-remote.test.mjs` 验证账号、设备、对话路由和手机 IP 的隔离。运行 `node tests/mobile-ui-fixture.mjs` 可启动一套使用模拟 Agent 的测试服务，终端会显示测试账号和端口。连接 MuMu 时用 `adb reverse tcp:<端口> tcp:<端口>`，Debug 版可连接 `http://127.0.0.1:<端口>`。Release 版始终要求 HTTPS。
