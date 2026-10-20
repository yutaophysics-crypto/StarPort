import AppKit
import WebKit

struct Configuration: Decodable, Sendable {
    let root: String
    let node: String
    let port: Int
    let python: String
    let proxyAudit: String?
    let environment: [String: String]
}

final class StarPortBridge: NSObject, WKScriptMessageHandler {
    private weak var owner: StarPortApplication?
    init(owner: StarPortApplication) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let owner = owner, let config = owner.configuration,
              message.frameInfo.isMainFrame else { return }
        let source = message.frameInfo.securityOrigin
        // Only the local personal workbench may ask the app to open a remote window.
        guard source.protocol == "http", ["127.0.0.1", "localhost"].contains(source.host), source.port == config.port,
              let body = message.body as? [String: String], body["action"] == "openGroup",
              let value = body["url"], let url = owner.groupURL(value) else {
            if source.protocol == "http" && source.port == config.port {
                owner.showError("群聊地址无效", "请填写 HTTPS 群聊服务地址；本机服务可使用回环地址。")
            }
            return
        }
        var destination = url
        if let code = body["launchCode"] {
            guard code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
            parts.fragment = "connect=" + code
            if let room = body["roomId"] {
                guard room.range(of: "^[a-f0-9-]{36}$", options: .regularExpression) != nil else { return }
                parts.fragment! += "&room=" + room
            }
            guard let launchURL = parts.url else { return }
            destination = launchURL
        }
        owner.openWindow(url: destination, groupOrigin: url)
    }
}

final class StarPortWindow: NSWindowController, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    let webView: WKWebView
    let groupOrigin: URL?
    private let hostApplication: StarPortApplication
    private var titleObservation: NSKeyValueObservation?

    init(owner: StarPortApplication, number: Int, configuration: WKWebViewConfiguration = WKWebViewConfiguration(), groupOrigin: URL? = nil) {
        self.hostApplication = owner
        self.groupOrigin = groupOrigin
        configuration.websiteDataStore = .default()
        // Each view owns its bridge; popup configurations must not share handlers.
        configuration.userContentController = WKUserContentController()
        configuration.userContentController.add(StarPortBridge(owner: owner), name: "starportDesktop")
        webView = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "\(groupOrigin == nil ? "星港" : "星港群聊") · 窗口 \(number)"
        window.minSize = NSSize(width: 760, height: 520)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("StarPortWindow")
        super.init(window: window)
        window.delegate = self
        if groupOrigin != nil {
            titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
                if let title = view.title, !title.isEmpty { self?.window?.title = title }
            }
        }
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window.center()
        if number > 1 { window.setFrameOrigin(NSPoint(x: window.frame.origin.x + CGFloat((number - 1) % 5) * 24,
                                                    y: window.frame.origin.y - CGFloat((number - 1) % 5) * 24)) }
    }

    required init?(coder: NSCoder) { fatalError("Unavailable") }
    func windowDidBecomeKey(_ notification: Notification) { hostApplication.didActivate(self) }
    func windowWillClose(_ notification: Notification) { hostApplication.remove(self) }
    func webViewDidClose(_ webView: WKWebView) { window?.close() }
    private func isInternal(_ url: URL) -> Bool {
        if hostApplication.isLocal(url) { return true }
        if groupOrigin != nil, hostApplication.isAccountCenter(url) { return true }
        guard let group = groupOrigin, url.user == nil, url.password == nil else { return false }
        let port: (URL) -> Int = { $0.port ?? ($0.scheme == "https" ? 443 : 80) }
        return url.scheme == group.scheme && url.host?.lowercased() == group.host?.lowercased() && port(url) == port(group)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isInternal(url) {
            // Export links become downloads in the current window, not empty popup windows.
            if url.path.hasPrefix("/api/") { webView.load(navigationAction.request); return nil }
            return hostApplication.openWindow(configuration: configuration, url: url, groupOrigin: groupOrigin).webView
        }
        if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if isInternal(url) || ["about", "blob", "data"].contains(url.scheme ?? "") {
            decisionHandler(.allow)
        } else {
            if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let window = window else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename; panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code != NSURLErrorCancelled { hostApplication.showError("下载失败", error.localizedDescription, window: window) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window = window else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "星港"; alert.informativeText = message; alert.addButton(withTitle: "好")
        present(alert) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "星港"; alert.informativeText = message
        alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        present(alert) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "星港"; alert.informativeText = prompt
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field; alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        present(alert) { result in completionHandler(result == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }
}

final class StarPortApplication: NSObject, NSApplicationDelegate {
    var configuration: Configuration!
    private var windows: [StarPortWindow] = []
    private weak var lastActiveWindow: StarPortWindow?
    private var nextNumber = 0
    private let startup = DispatchQueue(label: "starport.desktop.startup")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()
        do {
            guard let file = Bundle.main.url(forResource: "starport-config", withExtension: "json") else { throw CocoaError(.fileNoSuchFile) }
            configuration = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: file))
            openWindow()
        } catch { showError("星港配置无法读取", "请重新安装星港的 Mac 应用入口。"); NSApp.terminate(nil) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard configuration != nil else { return true }
        if windows.isEmpty { openWindow() }
        else if let window = (lastActiveWindow ?? windows.last)?.window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func didActivate(_ controller: StarPortWindow) { lastActiveWindow = controller }
    func remove(_ controller: StarPortWindow) {
        windows.removeAll { $0 === controller }
        if lastActiveWindow === controller { lastActiveWindow = windows.last }
    }
    func isLocal(_ url: URL) -> Bool {
        ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? "") && ["http", "https"].contains(url.scheme ?? "")
    }
    func groupURL(_ value: String) -> URL? {
        if let local = URLComponents(string: value), let config = configuration,
           local.scheme == "http", ["127.0.0.1", "localhost"].contains(local.host ?? ""),
           local.port == config.port, local.user == nil, local.password == nil,
           local.query == nil, local.fragment == nil,
           local.path.range(of: "^/group-windows/[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil { return local.url }
        guard let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", parts.port == nil || (1...65535).contains(parts.port!),
              scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)) else { return nil }
        var normalized = parts; normalized.scheme = scheme; normalized.host = host; normalized.path = "/"
        return normalized.url
    }
    func isAccountCenter(_ url: URL) -> Bool {
        guard let config = configuration, url.user == nil, url.password == nil else { return false }
        var value = config.environment["STARPORT_ACCOUNT_URL"]
        if value == nil, let data = try? Data(contentsOf: URL(fileURLWithPath: config.root).appendingPathComponent("config/account-center.json")),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] { value = object["url"] }
        guard let value = value, let account = URL(string: value),
              url.scheme == account.scheme, url.host?.lowercased() == account.host?.lowercased(),
              (url.port ?? (url.scheme == "https" ? 443 : 80)) == (account.port ?? (account.scheme == "https" ? 443 : 80)) else { return false }
        return url.path == "/account" || url.path.hasPrefix("/account/")
    }

    @discardableResult func openWindow(configuration webConfiguration: WKWebViewConfiguration = WKWebViewConfiguration(), url: URL? = nil, groupOrigin: URL? = nil) -> StarPortWindow {
        nextNumber += 1
        let controller = StarPortWindow(owner: self, number: nextNumber, configuration: webConfiguration, groupOrigin: groupOrigin)
        windows.append(controller); controller.showWindow(nil); NSApp.activate(ignoringOtherApps: true)
        if let url = url { controller.webView.load(URLRequest(url: url)); return controller }
        controller.webView.loadHTMLString("<html lang='zh'><meta charset='utf-8'><body style='font:16px system-ui;background:#0d1725;color:#e3edf5;display:grid;place-items:center;height:90vh'>正在打开星港…</body></html>", baseURL: nil)
        let config = configuration!
        startup.async {
            do {
                if let audit = config.proxyAudit {
                    try Self.run(config, config.python, [audit], failure: "请先打开 Clash Verge 和 LuLu，并确认 Claude 固定线路。")
                }
                try Self.run(config, config.node, [config.root + "/scripts/launch.mjs", "--no-open"], failure: "本机星港服务未能启动，请检查星港目录中的 .data/server.log。")
                DispatchQueue.main.async {
                    if self.windows.contains(where: { $0 === controller }) {
                        controller.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(config.port)/")!))
                    }
                }
            } catch {
                DispatchQueue.main.async { self.showError("星港暂时无法打开", error.localizedDescription, window: controller.window) }
            }
        }
        return controller
    }

    nonisolated private static func run(_ config: Configuration, _ executable: String, _ arguments: [String], failure: String) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: config.root)
        var environment = ProcessInfo.processInfo.environment
        config.environment.forEach { environment[$0.key] = $0.value }
        environment["PATH"] = URL(fileURLWithPath: config.node).deletingLastPathComponent().path + ":" + NSHomeDirectory() + "/.local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        process.environment = environment
        // Startup only needs the exit status. Avoid keeping a pipe open across
        // detached server processes; their own output goes to server.log.
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let completion = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completion.signal() }
        try process.run()
        guard completion.wait(timeout: .now() + 60) == .success else {
            if process.isRunning { process.terminate() }
            throw NSError(domain: "StarPort", code: 1, userInfo: [NSLocalizedDescriptionKey: failure + "\n启动检查超时，请重试。"])
        }
        if process.terminationStatus != 0 { throw NSError(domain: "StarPort", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: failure]) }
    }
    func showError(_ title: String, _ message: String, window: NSWindow? = nil) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message; alert.addButton(withTitle: "好")
        if let window = window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }
    private func activeView() -> WKWebView? { windows.first { $0.window === NSApp.keyWindow }?.webView }
    @objc private func newWindow() {
        guard configuration != nil else { return }
        if let origin = windows.first(where: { $0.window === NSApp.keyWindow })?.groupOrigin {
            if origin.path.hasPrefix("/group-windows/") {
                activeView()?.evaluateJavaScript("globalThis.StarportGroupDesktop?.newWindow()", completionHandler: nil)
            } else { openWindow(url: origin, groupOrigin: origin) }
        } else { openWindow() }
    }
    @objc private func reloadPage() { activeView()?.reload() }
    @objc private func goBack() { activeView()?.goBack() }
    @objc private func goForward() { activeView()?.goForward() }
    @objc private func zoomIn() { if let view = activeView() { view.pageZoom = min(2, view.pageZoom + 0.1) } }
    @objc private func zoomOut() { if let view = activeView() { view.pageZoom = max(0.6, view.pageZoom - 0.1) } }
    @objc private func resetZoom() { activeView()?.pageZoom = 1 }

    private func buildMenus() {
        let bar = NSMenu()
        func menu(_ title: String) -> NSMenu { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); let submenu = NSMenu(title: title); item.submenu = submenu; bar.addItem(item); return submenu }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, target: AnyObject? = nil) { let item = NSMenuItem(title: title, action: action, keyEquivalent: key); item.target = target; menu.addItem(item) }
        let app = menu("星港")
        add(app, "关于星港", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", target: NSApp)
        app.addItem(.separator()); add(app, "隐藏星港", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        app.addItem(.separator()); add(app, "退出星港", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        let file = menu("文件")
        add(file, "新建窗口", #selector(newWindow), "n", target: self)
        add(file, "关闭窗口", #selector(NSWindow.performClose(_:)), "w")
        let edit = menu("编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { add(edit, title, NSSelectorFromString(action), key) }
        let view = menu("显示"); add(view, "刷新页面", #selector(reloadPage), "r", target: self)
        add(view, "返回", #selector(goBack), "[", target: self); add(view, "前进", #selector(goForward), "]", target: self)
        add(view, "放大", #selector(zoomIn), "+", target: self); add(view, "缩小", #selector(zoomOut), "-", target: self); add(view, "实际大小", #selector(resetZoom), "0", target: self)
        let window = menu("窗口"); NSApp.windowsMenu = window
        add(window, "最小化", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(window, "前置所有窗口", #selector(NSApplication.arrangeInFront(_:)), "", target: NSApp)
        NSApp.mainMenu = bar
    }
}

let app = NSApplication.shared
let delegate = StarPortApplication()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
