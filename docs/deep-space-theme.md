# 深空 · Deep Space

第三套独立主题。右上角选择「深空」；英文界面显示 **Deep Space**。选择保存在当前浏览器中，刷新后继续使用。

视觉以轨道船坞的观景舷窗为中心：银白色飞船、石墨灰工作台、暖琥珀色引导灯。新对话页展示主视觉，阅读对话时背景自动压暗。工具选择使用细分隔线，聊天、执行过程、设置和目录选择使用清楚的深色面板。

## 实现

- 样式：`public/deep-space.css`。主题面板限定在 `html[data-theme=deep-space]`；手机顶栏和主题按钮的紧凑尺寸规则对三套主题共享。
- 主题注册：`public/theme.js`；切换时同步页面色、图标和按钮状态。默认主题仍为星港，已有偏好保留。
- 主视觉：`public/assets/deep-space.webp`，1672 × 941，128,938 字节。本地加载，不依赖远程图片。
- 图标：`public/assets/deep-space-icon.svg`。
- 生成模式：内置 `image_gen`，新图生成。原图压缩为 WebP，未裁剪或重新绘制。完整提示词见 [deep-space-prompt.txt](deep-space-prompt.txt)。
- 支持中英文、窄窗口和系统减少动态效果偏好。

星港和蔚蓝的样式文件与开始修改前的备份逐字节一致。此次修改不需要重启星港服务。

## 验证 · 2026-10-05

- 在独立临时数据库和假适配器上检查界面，没有向厂商发送消息。
- 检查 1600 × 1000、1440 × 900、1280 × 720、390 × 844；中英文主题按钮不重叠，页面无横向溢出。
- 检查新对话、消息、思考与工具过程、公式、代码、对话菜单、设置和文件夹选择器。
- 检查三套主题按钮状态、浏览器保存、页面色与图标；深空刷新后保持选择。
- 当前页面浏览器警告和错误均为零。
- 现有 122 项测试全部通过。生产服务直接返回主题资源，未重启服务或修改生产会话。

界面验证入口：`tests/deep-space-ui-fixture.mjs`。截图保存在 `.data/deep-space-theme-check/`，包括 `welcome-final.png`、`welcome-english.png`、`welcome-mobile.png`、`conversation-1600.png`、`settings.png` 和 `folder-picker.png`。
