# Group conversations, phones and connected computers

English | [Chinese](zh-CN/collaboration.md)

StarPort has a separate multi-user account and group service. Phones use a responsive, installable PWA; desktop users keep the local workspace and native adapters.

## Start locally

1. Open **Group chat & mobile**. Enter a server address and an account on that server. Account creation depends on that server's registration policy. A saved connection reopens the account's last viewed group.
2. The group owner creates a group and shares its server address and invitation code. Participants sign in on that same server and choose **Join**. Same-named accounts on different servers remain separate identities.
3. In **My computer → Set up this computer's agents**, choose the working folders and execution permissions to expose for that account. CLI credentials, model logins and personal workspace records remain local.
4. Sign in to the same account on a phone. Choose your connected computer, model and working folder, then invoke an agent.
5. **Another account window** opens a separate connection. A sign-out in one window leaves other windows alone; forgetting a saved connection removes that account's saved local login and agent binding.
6. The account information button shows the current account and server address and provides sign-out. Viewing it does not sign out. In the composer, Enter sends; Shift+Enter and Ctrl+Enter insert a newline. IME composition does not send prematurely.

You can start your own server from **Settings → Connections & data → This computer's server**. Configure its port and public HTTPS address before enabling it. Source code contains no preset personal server address. See [servers and accounts](account-center.md).

## Each caller's models and quota

| Entry point | Execution | Credentials |
| --- | --- | --- |
| Codex | Existing local App Server adapter | Caller computer's Codex / ChatGPT login |
| Claude Code | Official Agent SDK with local CLI | Caller computer's Claude login or native configuration |
| Antigravity | Local AGY CLI with streaming JSON | Caller computer's AGY login |
| DeepSeek Harness | Native SDK / JSON-RPC | Caller computer's Harness configuration |

Each caller installs and authenticates the tools on their own computer, or configures their own API key in the native tool. Phones and group servers do not receive model keys and do not borrow the group owner's subscription. The server stores group identities, membership, messages, device capabilities and task state. Never send model secrets as group messages.

A caller can select only their own connected device's published directories and tools, not arbitrary devices, executable paths or permission parameters. Model lists come from that computer's native tool; manual identifiers remain available where supported.

## Permissions and approvals

The connected computer chooses a remote execution policy:

- **Read-only analysis**: native Codex read-only, Claude plan mode, or AGY plan mode with its native permissions and terminal sandbox. The current DeepSeek adapter has no verifiable read-only mode and is not offered for these calls.
- **Allow execution and edits**: Codex works within its workspace policy and requests extra permissions; Claude uses acceptEdits and sends approvals to the caller; AGY uses accept-edits, tool approval and its terminal sandbox; DeepSeek retains its native capabilities and configuration.

These are CLI policies. Choosing a working directory does not guarantee operating-system isolation for every tool. Existing Claude `--restricted` configuration and local sandboxes still apply.

Only the caller can see and answer their approvals/questions or stop their task. Other group members see shared replies and brief progress, not approval command parameters or device directory settings.

The execution bridge connects outward to the group service. Do not expose the local personal-workspace port 3210. The computer must remain awake with StarPort running. Putting a phone in the background does not stop a started job; pending approvals wait for the caller.

## Offline and recovery

- Calls to an offline computer wait in the server queue.
- A disconnected phone retains the app shell and local draft, without caching account responses or automatically resending messages in the background.
- Idempotency identifiers prevent retries of the same request from creating another job.
- A lost execution lease, restarted bridge or revoked device marks an already started job interrupted and preserves published output. Uncertain commands are not replayed automatically.
- Ordered event sequence numbers prevent late data from replacing a terminal state. Unpublished results are also retained in the computer's execution data directory.

## Phones and installation

Use the group's reachable **HTTPS address**. `127.0.0.1` on a phone refers to the phone, not the host computer. Everyone in the same group uses the owner's shared service address; separate local servers are separate services. Existing deployments with a central account service must share its trusted issuer to use the same identities.

- **iPhone / iPad**: open the site in Safari and use Add to Home Screen; enable opening as a web app where offered. [Apple instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27).
- **Android**: use Install app or Add to Home Screen in a supported browser. The project includes a manifest, 192/512 icons and a service worker. [Installation criteria](https://web.dev/articles/install-criteria).
- **HarmonyOS**: use the responsive website and the browser's installation/shortcut option if available. PWA support depends on browser and system version; this is not a native HAP package. [Huawei browser instructions](https://consumer.huawei.com/cn/support/content/zh-cn00448896/).

The repository includes responsive layouts, touch controls, installation guidance, an offline shell and draft retention. Real-device acceptance and app-store distribution require the corresponding devices and accounts; no native IPA, APK or HAP is supplied.

## Self-hosting

The group service and desktop execution bridges are separate. A public group server does not need model CLIs or provider logins.

### Docker and HTTPS

Install Docker Compose, configure DNS for a domain and open ports 80/443. Copy `deploy/.env.example` to `deploy/.env`, set `STARPORT_DOMAIN` and the account-service URL, then run:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build
```

Caddy manages HTTPS and the backend stays on the internal Docker network. The database uses the `group_data` volume. Never copy a personal `.data` folder, model runtimes, CLI credentials or memory into the image. `.dockerignore` excludes private runtime material.

External-account deployments set `STARPORT_ACCOUNT_URL=https://accounts.example.com/account`; the account service owns registration. Group admission still requires an invitation. A desktop can use `STARPORT_COLLAB_URL=https://groups.example.com` to select that shared group service.

### Run Node directly

Requirements: Node.js 24 or later.

```sh
npm ci
STARPORT_ACCOUNT_URL=https://accounts.example.com/account STARPORT_PUBLIC_URL=https://groups.example.com STARPORT_COLLAB_HOST=127.0.0.1 npm run start:collaboration
```

Forward your HTTPS reverse proxy to `127.0.0.1:3218`. In PowerShell, assign environment variables using syntax such as `$env:STARPORT_PUBLIC_URL='https://groups.example.com'`. Non-loopback service addresses without TLS are rejected by the desktop connector.

Other settings include `STARPORT_COLLAB_PORT` (3218), `STARPORT_COLLAB_DATA` (`.data/collaboration`), `STARPORT_COLLAB_HOST` and `STARPORT_ALLOW_REGISTRATION`.

### Temporary cross-network tests

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) can provide a temporary HTTPS endpoint:

```sh
cloudflared tunnel --url http://127.0.0.1:3218
```

Use the generated HTTPS address as the group's `STARPORT_PUBLIC_URL`. Preserve the request Host and forward only the group service, not the personal workspace. The HTTPS proxy or tunnel must be started separately.

A local, ignored `local-services.json` can configure the normal launcher:

```json
{
  "collaborationUrl": "https://groups.example.com",
  "server": true,
  "events": "poll"
}
```

`server: true` makes that computer also run the local group backend. Other computers omit it and connect to the shared service. Apply with the normal launcher; an already running backend needs an idle restart. Quick Tunnel does not support SSE, so use `events: "poll"` for five-second refreshes; the direct-service equivalent is `STARPORT_COLLAB_EVENTS=poll`. The default `sse` mode retains live push.

Members must register and sign in on the shared account service. Accounts and device grants from a different server do not migrate automatically. After changing a server's public address, existing groups remain, but invitation links using a loopback address must be replaced.

Temporary URLs expire with the tunnel process and can change on the next launch. Update the public URL, client connections and invitations accordingly. A long-lived deployment should use a stable domain and persistent HTTPS entry point. The host must remain awake with its services running.

## Data locations and validation

- Personal workspace: `.data/hub.sqlite`; not automatically shared.
- Group service: `.data/collaboration/collaboration.sqlite`, or the deployment's `/data`.
- Legacy desktop link: `.data/collaboration-link.json`; protected device authorization, not a model key or saved account password.
- Desktop execution records: `.data/collaboration-workers/<partition>/worker.sqlite`; separate from private chats and shared memory.
- Current account/window storage is described in [servers and accounts](account-center.md).

The test suite covers membership and device isolation, callers across all four adapters, idempotency, leases/restarts, mobile approvals/stops and local-workspace regressions. `node tests/collaboration-ui-fixture.mjs` starts a temporary UI fixture with simulated tools and test accounts, not real model calls.

Recent-group records are keyed by account UUID and contain only the server address, group ID and update time. A limited authorization tied to the account, server and login session updates them; it cannot sign in, read account data or change account settings, and expires with the original session. Reopening still verifies current membership.
