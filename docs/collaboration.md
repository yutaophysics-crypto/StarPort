# Group conversations, phones and connected computers

English | [简体中文](zh-CN/collaboration.md)

> **In development:** group conversations, the phone interface and the self-hosted server are not finished. Expect bugs, and expect behavior and stored data to change.

StarPort has a separate multi-user account and group service. Phones use an installable PWA; desktops keep the local workspace and CLI adapters. The group and phone pages are currently available in Chinese only, so their labels below give the on-screen Chinese in parentheses.

## Start locally

1. In StarPort, open **Groups & mobile**. In the sign-in window, enter a server address and an account and password on that server. You can create an account on the chosen server if its administrator allows registration. With a saved login, the account's last viewed group opens directly.
2. The group owner creates a group and shares the server address and its rotating invitation code. Participants sign in to an account on that server, choose **Join** (加入) on the group page and paste the code. Accounts from other servers cannot join directly, and same-named accounts on different servers are never merged.
3. In **My computer → Set up this computer's agents** (我的电脑 → 设置这台电脑的 Agent), choose the working folders and execution permission to expose for this server account. Model logins, CLI credentials and personal workspace records stay on the computer. On a phone, sign in to the same server account, choose your computer, model and folder, then call an agent.
4. **Another account window** (另一个账号窗口) opens a blank sign-in, so you can connect to another server or another account on the same server at the same time. In a macOS group window, `⌘N` opens another window for the current account; on Windows, group pages open in separate Edge app windows. Signing out in one window leaves the others alone. **Connections & data → Group connection settings → Forget connection** removes that server account's saved login and disconnects its local agent.
5. Click **ⓘ** next to the account at the bottom left to see the current account and the server address used to sign in; the address can be copied. Sign-out is in this panel, and viewing it does not sign you out.
6. In the message editor, `Enter` sends and `Shift+Enter` or `Ctrl+Enter` inserts a new line. Choosing characters in an input method does not send the message.

To run your own server, configure a port and public address in **Settings → Connections & data → Local server**, then start it. Accounts, group messages and administration live on that server's computer, and the source code contains no preset server address. Registration, account creation, disabling accounts and password resets are all in that panel. Access from other networks needs a reachable HTTPS entry point; see [servers and accounts](account-center.md).

## Each caller's models and quota

| Phone entry | How it runs | Where credentials live |
| --- | --- | --- |
| ChatGPT / Codex | Existing Codex App Server adapter, including the tool's ChatGPT login | Codex login on the caller's bound computer |
| Claude Code | Official Agent SDK driving the caller's CLI | Claude login or native configuration on the caller's computer |
| Antigravity | The caller's AGY CLI with streaming JSON | AGY login on the caller's computer |
| DeepSeek Harness | Native SDK / JSON-RPC | Harness model configuration on the caller's computer |

Each caller installs and signs in to the tools they need on their own computer, or configures their own API key in the native tool. Phones and group servers never receive model keys, and nobody borrows the group owner's or another member's computer, login or quota. The group server stores only accounts, members, messages, device capabilities and task state. Never send model keys as group messages.

The caller's account must match the StarPort account registered on the target computer. A phone cannot pick arbitrary computers, file paths, executables or permission parameters; it can choose only from the folders and tools published by the caller's own connected computer. Model lists come from that computer's native tool, and any model identifier the native tool accepts can also be entered by hand.

## Permissions and approvals

The connected computer chooses a remote execution mode:

- **Read-only analysis**: Codex uses its native read-only mode; Claude uses plan mode; AGY uses plan mode with its native permissions and terminal sandbox. The current DeepSeek adapter has no verifiable read-only mode, so DeepSeek is not offered in this mode.
- **Allow execution and edits**: Codex works inside the working folder and requests extra permissions; Claude uses acceptEdits and sends operations that need approval to the phone; AGY uses accept-edits, auto-approves tools and runs in its terminal sandbox; DeepSeek keeps its native capabilities and configuration.

Group execution follows each CLI's own permission semantics. Choosing a working folder does not give operating-system file isolation for every CLI. Existing Claude `--restricted` configuration and local sandboxes still apply, and you do not need to change your Claude restrictions.

Only the caller can see and answer their approvals and questions, or stop their task. Other group members see shared replies and brief progress, never approval command parameters or the computer's folder settings.

The computer connects outward to the group service, so the local personal-workspace port `3210` never needs to be opened to the internet. The computer must stay on with StarPort running. Putting a phone in the background does not stop a task that has started; tasks waiting for approval wait for the caller to come back.

## Offline, recovery and duplicate requests

- While a computer is offline, new tasks wait in the server queue until it comes back online.
- A phone without a connection keeps the app shell and its local draft. It does not cache conversations or account responses, and does not resend messages in the background.
- Sends and calls carry idempotency identifiers, so retrying the same request does not create another task.
- If a started task loses its execution lease, the bridge restarts or the device is revoked, the task is marked interrupted and replies already published are kept. Commands with uncertain results are never replayed automatically; the caller starts them again after checking.
- Results use consecutive event numbers, so late data cannot overwrite a finished task. Results that could not be published are also saved in the computer's execution data folder.

## Using and installing on a phone

A phone needs the group service's **HTTPS address**; `127.0.0.1` on a phone refers to the phone itself, not another computer. Finish one of the deployments below first, then sign in to the same StarPort account on the phone and choose the executing computer under **My computer** (我的电脑).

Accounts belong to the server you sign in to; groups, members and invitation codes belong to that group server. Two computers that each open `127.0.0.1:3218` are two different servers. Everyone joining the same group must use the same HTTPS group address provided by the owner. Deployments that use a separate account service must trust the same account service to share identities.

- **iPhone / iPad**: open the group address in Safari and use Add to Home Screen from the share menu; on versions that offer it, turn on Open as Web App. See [Apple's instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27).
- **Android**: choose Install app or Add to Home screen in a supported browser. The project includes a manifest, 192/512 icons and a service worker, which meet the basic installation criteria over HTTPS. See [Chrome's installation criteria](https://web.dev/articles/install-criteria).
- **HarmonyOS**: open the same responsive address in the system browser and use its Add to desktop or Install option if offered. Install prompts and service workers depend on the system and browser version. This is a PWA, not a native HAP package; browsers that cannot install it can still use the site online. See [Huawei's desktop shortcut instructions](https://consumer.huawei.com/cn/support/content/zh-cn00448896/).

The current release includes desktop and phone layouts, touch controls, standalone app display, installation guidance, an offline shell and draft retention. Real-device acceptance on iOS, Android and HarmonyOS and app-store publishing need the corresponding devices and accounts; no native IPA, APK or HAP package is provided.

## Self-hosting

The group service and the computers' execution bridges are separate. A public server runs only the group service and needs no model CLI or model login.

### Docker and HTTPS

On the host, install Docker Compose, point DNS for a domain at it and open ports 80 and 443. Copy `deploy/.env.example` to `deploy/.env`, set `STARPORT_DOMAIN` to your domain, then run:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build
```

Caddy manages HTTPS, and the group backend is reachable only inside Docker. The database lives in the `group_data` volume. Never package an old computer's `.data`, CLI logins, keys, model runtimes or personal memory into the server image; `.dockerignore` already excludes them.

Set `STARPORT_ACCOUNT_URL=https://accounts.example.com/account` in `.env`. The group service never receives account passwords; new registrations are controlled by the account service's `STARPORT_ALLOW_REGISTRATION`. Joining a group still requires an invitation from its owner.

Each computer signs in to the account service under **Groups & mobile**, then enters the HTTPS address and invitation code to join. You can also start the workspace with `STARPORT_COLLAB_URL=https://groups.example.com` to make that shared group service the default address.

### Run Node directly

Requires Node.js 24 or later:

```sh
npm ci
STARPORT_ACCOUNT_URL=https://accounts.example.com/account STARPORT_PUBLIC_URL=https://groups.example.com STARPORT_COLLAB_HOST=127.0.0.1 npm run start:collaboration
```

Forward your own HTTPS reverse proxy to `127.0.0.1:3218`. In Windows PowerShell, set environment variables with syntax such as `$env:STARPORT_PUBLIC_URL='https://groups.example.com'`. The desktop connector rejects non-local service addresses without TLS.

Optional environment variables: `STARPORT_COLLAB_PORT` (default 3218), `STARPORT_COLLAB_DATA` (default `.data/collaboration`), `STARPORT_COLLAB_HOST`, `STARPORT_PUBLIC_URL` and `STARPORT_ALLOW_REGISTRATION`.

### Testing a local group server across networks

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives the local group service a temporary public HTTPS entry point, without a domain or Cloudflare account:

```sh
cloudflared tunnel --url http://127.0.0.1:3218
```

Note the printed `https://<random-name>.trycloudflare.com` address. The group backend's `STARPORT_PUBLIC_URL` must be this address, and the tunnel must keep the request Host and forward to local port 3218. This entry point forwards only the group service, never the personal workspace on 3210. The two ends need not share a LAN, and no self-signed certificates are needed.

The normal launcher reads `local-services.json` from the current data directory (never committed to Git):

```json
{
  "collaborationUrl": "https://groups.example.com",
  "server": true,
  "events": "poll"
}
```

`collaborationUrl` sets the desktop's default group address. `server: true` means this computer also runs the local group backend, using the same HTTPS address as its public address. Other participating computers omit `server` and connect only to the remote service. Apply the configuration with `npm run launch` or the desktop shortcut; a backend that is already running needs a restart while no tasks are running. The tunnel or HTTPS reverse proxy must be started separately; the launcher does not create a public entry point.

Quick Tunnel does not support SSE. With `events: "poll"`, group pages refresh every five seconds, and you can still send messages, follow task progress and answer approvals. The default `events: "sse"` keeps live push. When running the group backend directly, the equivalent environment variable is `STARPORT_COLLAB_EVENTS=poll`.

Every member must register and sign in on the shared service, then join through an invitation generated by that service. Accounts on another computer's local service do not migrate automatically. Existing bindings must have their service address and account confirmed; device grants from another service cannot be copied over. After the same database moves to a new public address, existing groups and invitation codes remain, but old invitation links containing `127.0.0.1` should not be shared; generate new ones instead.

A temporary address stops working when the tunnel process exits, and a new tunnel gets a new address. When that happens, update the service's public address, both ends' connection settings and the invitation links. For long-term use, switch to a Cloudflare Tunnel with a fixed domain or the Docker + HTTPS deployment above. A computer acting as the server must stay on, with its services and tunnel running.

## Data locations and testing

- Existing local records: `.data/hub.sqlite`; not migrated and not shared automatically.
- Group service: `.data/collaboration/collaboration.sqlite`, or the deployment's `/data`.
- Computer link: `.data/collaboration-link.json`. It holds only a protected device authorization, never a StarPort password or a copy of model keys. On Windows it is restricted to the current user and SYSTEM; other systems use mode 0600.
- Group execution records on the computer: `.data/collaboration-workers/<partition>/worker.sqlite`. They never read personal conversations or shared memory.
- Current account and window storage is described in [servers and accounts](account-center.md).

`npm test` covers member and device isolation, two callers across all four adapters, duplicate submissions, leases and restarts, approvals and stops from a phone, and regressions in the original workspace. `node tests/collaboration-ui-fixture.mjs` starts an isolated UI test service with simulated tools and test accounts; it never calls real models.

The account service stores each account's recent groups by account UUID, with only the server address, group ID and update time. The group server updates this record with a limited authorization bound to the account, the server and the original login session. That authorization cannot sign in to the account service, read account data or change account settings, and it ends when the original session signs out or expires. Opening a window still verifies current membership, so a stale record cannot bypass joining.
