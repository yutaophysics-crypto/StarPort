# macOS desktop windows

English | [简体中文](zh-CN/macos-desktop.md)

The macOS entry point is a WKWebView inside a native AppKit window. Pages, the backend and CLIs are still StarPort's own, and all app windows share one set of local data. Pages have no browser tab strip or address bar.

## Install and update

Requirements: macOS 14 or later, Node.js 24 or later and Apple Command Line Tools. If the build tools are missing, run `xcode-select --install` and follow the system prompts. Then run this in the project folder:

```sh
npm ci
npm run install:macos
```

New installations default to `~/Applications/StarPort.app`; later updates reuse the location of the app already installed for this project, including apps with the earlier Chinese name. Use `--output /Applications/StarPort.app` to choose a location. The installer compiles the app, applies the Azure brand icon and writes local configuration; before replacing an app, it saves the old one under `.data/source-backups/macos-app-<timestamp>/`. Local paths, the app bundle, chat databases and credentials are never committed to the repository.

The app records the project path and the Node executable path, so reinstall the entry point after moving the project or Node. `npm run launch` prefers to open the app that matches this project, port and data directory; `--no-open` still starts only the service, so the native app does not reopen itself when it starts the service. Windows and Linux launch methods are unchanged.

If the project or the startup check script is in Documents, macOS may ask for Documents access on first launch; StarPort can read the project and local data only after you allow it. The app is ad-hoc signed locally, so the system may ask again after a rebuild. A timed-out or denied check never skips the proxy check; grant permission, then quit and reopen the app.

## Multiple windows

The first Dock click starts the app and its page; later normal clicks switch back to an existing window and restore the last used window if it is minimized. Use `⌘N` or **File → New Window** in the menu bar to open another window. There is no in-page New Window button, and Shift-clicking the Dock does not open a new window. The Window menu lists open windows. `⌘W` closes the current window and `⌘Q` quits the window app; the background StarPort service and tasks already started keep running. After every window is closed, clicking the Dock opens a window again.

Each window keeps its own page state and can stay on a different conversation. The database, groups, conversation records and tool logins are shared; these are multiple windows, not isolated instances with different accounts or data directories. Drafts follow StarPort's existing per-conversation rules. Windows share WebKit's persistent website storage, so settings such as theme and language carry over; the browser's existing website storage is not copied into the native app.

File pickers, attachment and backup downloads, and page confirmation dialogs use native system dialogs. External documentation links open in the default browser, and local StarPort pages stay in the app.

Choosing **Open groups** under **Groups & mobile** in the desktop workspace opens groups as separate windows of the same StarPort app; public HTTPS services work too. The personal workspace and groups share the Dock icon and Window menu. `⌘N` opens a new workspace or group window depending on the current window type, and a normal Dock click still restores the current window. Each group window navigates only within the chosen group service's origin; external pages open in the browser.

Group windows open with the server account you signed in to in StarPort, so you do not sign in again in each window. Safari logins are not copied into StarPort's native windows. Phones and direct browser access to groups remain available.

## Optional proxy check and group address

A computer with an existing proxy setup can specify its own read-only check script:

```sh
npm run install:macos -- --proxy-audit /absolute/path/claude-proxy-audit.py
```

The app runs the script before each new workspace window loads. A nonzero exit stops the workspace from opening and asks you to check the proxy. Reinstalling keeps the configured script unless you explicitly change the path. The script does not change CLI settings, proxy nodes or firewall rules.

The app's local configuration is in `Contents/Resources/starport-config.json`. During installation, `--node`, `--python` and `--port` set the runtime, and `--collaboration-url https://groups.example.com` makes a shared group service the default group address.

References: [Apple WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate), [Dock reopen event](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldhandlereopen(_:hasvisiblewindows:)), [WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate).
