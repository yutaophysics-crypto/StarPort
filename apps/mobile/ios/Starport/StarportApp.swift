import SwiftUI
import UIKit
import WebKit

@main
struct StarportApp: App {
    @AppStorage("starport.mobile.server") private var serverAddress = ""
    @State private var presentingServer = false
    @State private var entry = ""
    @State private var invalid = false
    @State private var loadError: String?
    @State private var generation = 0

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image("StarportMark").resizable().frame(width: 27, height: 27).accessibilityHidden(true)
                    Text("星港").font(.headline)
                    if let host = origin(serverAddress)?.host {
                        Text(host).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button("服务器", action: configure)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 48)
                Divider()
                if let url = origin(serverAddress) {
                    StarportBrowser(server: url, error: $loadError).id(generation)
                } else {
                    VStack(spacing: 16) {
                        Text("连接星港服务器后，查看你的电脑和对话。").multilineTextAlignment(.center)
                        Button("连接服务器", action: configure).buttonStyle(.borderedProminent)
                    }.padding().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Color(red: 0.04, green: 0.09, blue: 0.15))
            .preferredColorScheme(.dark)
            .sheet(isPresented: $presentingServer) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("星港服务器").font(.title2.weight(.semibold))
                    TextField("https://starport.example.com", text: $entry)
                        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        .onSubmit(connect)
                    if invalid { Text("请输入 HTTPS 服务器地址").foregroundStyle(.pink) }
                    HStack {
                        Spacer()
                        Button("取消") { presentingServer = false }
                        Button("连接", action: connect).buttonStyle(.borderedProminent)
                    }
                }.padding(24).presentationDetents([.medium, .large])
            }
            .alert("连接失败", isPresented: Binding(get: { loadError != nil }, set: { if !$0 { loadError = nil } })) {
                Button("取消", role: .cancel) { loadError = nil }
                Button("设置地址", action: configure)
            } message: {
                Text(loadError ?? "")
            }
        }
    }

    private func configure() {
        entry = serverAddress
        invalid = false
        presentingServer = true
    }

    private func connect() {
        guard let url = origin(entry) else { invalid = true; return }
        serverAddress = url.absoluteString
        generation += 1
        presentingServer = false
    }

    private func origin(_ text: String) -> URL? {
        guard var address = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              address.scheme?.lowercased() == "https", let host = address.host, !host.isEmpty,
              address.user == nil, address.password == nil, address.query == nil, address.fragment == nil,
              address.path.isEmpty || address.path == "/" else { return nil }
        address.scheme = "https"
        address.path = ""
        return address.url
    }
}

private struct StarportBrowser: UIViewRepresentable {
    let server: URL
    @Binding var error: String?

    func makeCoordinator() -> Coordinator { Coordinator(server: server, error: $error) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "StarportMobile/1"
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: server.appendingPathComponent("remote", isDirectory: true)))
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let server: URL
        @Binding var error: String?
        init(server: URL, error: Binding<String?>) {
            self.server = server
            self._error = error
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.user == nil, url.password == nil,
                  url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            let sameServer = host == server.host?.lowercased() && (url.port ?? 443) == (server.port ?? 443)
            let accountCenter = url.path == "/account" || url.path == "/account/"
            decisionHandler(sameServer || accountCenter ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let reply = response.response as? HTTPURLResponse,
               reply.statusCode == 404, reply.url?.path == "/remote" || reply.url?.path == "/remote/" {
                error = "这台服务器还未更新到支持手机访问的版本。"
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) {
            if (failure as NSError).code != NSURLErrorCancelled { error = "无法打开服务器，请检查地址和网络后重试。" }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            var responder: UIResponder? = webView
            while let current = responder, !(current is UIViewController) { responder = current.next }
            guard let host = responder as? UIViewController else { completionHandler(false); return }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确认", style: .default) { _ in completionHandler(true) })
            host.present(alert, animated: true)
        }
    }
}
