# macOS desktop windows

English | [Chinese](zh-CN/macos-desktop.md)

The macOS application uses AppKit and WKWebView around the same StarPort frontend, service and adapters. Windows share the local database and have no browser tab strip or address bar.

## Install and update

Requirements: macOS 14 or later, Node.js 24 or later and Apple Command Line Tools. If needed, run `xcode-select --install` and complete the system installer.

```sh
npm ci
npm run install:macos
```

New installations default to `~/Applications/StarPort.app`. Updates reuse the existing application's location, including legacy localized bundle names. Use `--output /Applications/StarPort.app` to choose a location explicitly. The installer compiles the app, applies the Azure icon and writes local configuration. It backs up an existing application under `.data/source-backups/macos-app-<timestamp>/` before replacement. Never commit that bundle, local configuration, chat database or credentials.

The app records this checkout and the Node executable. Reinstall the entry point after moving either. `npm run launch` opens a matching app for the checkout, port and data directory; `--no-open` starts only the service and avoids reopening the app recursively. Windows and Linux entry points are unaffected.

Projects or startup checks in Documents may require macOS Documents permission. The application is locally ad-hoc signed, so rebuilding can trigger another permission prompt. Denied or timed-out startup checks are not skipped; grant permission, quit the window application and reopen it.

## Multiple windows

A normal Dock click starts the app or restores its most recently used window, including a minimized one. Use `⌘N` or **File → New Window** for another window. There is no added in-page New Window button, and Shift-clicking the Dock is not the entry point.

The Window menu lists open windows. `⌘W` closes the current one; `⌘Q` exits the window application. The Node service and started tasks continue. After every window is closed, another Dock click opens a window again.

Each window can show a different conversation, but groups, history, logins and data are shared. This is not account or data-directory isolation. Drafts retain the application's per-conversation behavior. Windows share persistent WebKit storage for theme, language and supported sign-ins; existing browser storage is not copied into WKWebView.

File pickers, downloads and confirmation dialogs use native system dialogs. External documentation opens in the default browser. Local workspace pages remain in the app.

Opening a group from **Group chat & mobile** creates a separate app window for that group service, including public HTTPS services. `⌘N` follows the current window type. Group navigation stays within the selected service's origin; external links open in a browser. Safari logins are not copied into native windows. Mobile and ordinary browser access remain available.

## Optional proxy check and group URL

A computer with an existing proxy setup can install a read-only preflight script:

```sh
npm run install:macos -- --proxy-audit /absolute/path/claude-proxy-audit.py
```

The script runs before a new workspace window loads. A nonzero exit prevents loading and asks for a proxy check. Reinstallation preserves the configured script unless you explicitly change it. It does not change native CLI configuration, proxy nodes or firewall rules.

Local bundle configuration is `Contents/Resources/starport-config.json`. Installation accepts `--node`, `--python` and `--port`; `--collaboration-url https://groups.example.com` selects an existing shared group service instead of starting separate local group servers.

References: [WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate), [application reopen](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldhandlereopen(_:hasvisiblewindows:)), [WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate).
