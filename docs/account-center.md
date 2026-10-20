# Servers and accounts

English | [Chinese](zh-CN/account-center.md)

## Start a server from StarPort

Open **Settings → Connections & data → This computer's server**. Choose a local port (3218 by default), configure a stable public HTTPS address if other networks need access, then start the server. Account and group services start together; account endpoints use `/account` on the same public address.

Each server owns its accounts, password verification data, group members, messages and invitations. Administrators can create accounts, control self-registration, disable or re-enable accounts and reset passwords. Passwords use salted scrypt hashes and are not displayed. Disabling an account or resetting its password revokes that account's existing logins and agent connections; other accounts and saved group messages remain intact.

Once accounts exist, changing the issuer address requires backup and an explicit issuer migration. A same-named account at a different issuer must not acquire an old member's permissions. Closing registration does not prevent existing logins or administrator-created accounts. A server with queued, claimed or running agent jobs cannot be stopped from this panel. Stopping retains its databases.

New local deployments store settings in `server-hosting.json` inside the workspace data directory. Hosted databases live under `hosted-server/accounts` and `hosted-server/groups`. Saved client connections use `server-accounts/<profileId>`; local window credentials use `group-windows.json`. These are private runtime files, not source or public backup material. Closing the desktop window does not stop the Node service. Opening StarPort after a reboot restores enabled local services.

## Public HTTPS access

The service binds to loopback by default. Put Caddy, your reverse proxy or an HTTPS tunnel in front of the group port, using the public address configured in StarPort. Forward both group and `/account` routes. Do not publish the personal workspace on port 3210 or expose internal account ports unnecessarily.

The server computer must remain awake, connected and running. Temporary Quick Tunnels are suitable for testing; their URLs can change and should not become the permanent issuer for established accounts. StarPort does not purchase domains or create third-party tunnels automatically.

## Sign-in and separate windows

Enter the server address, username and password in the group window. The desktop validates that server and sends credentials only to its `/account` endpoint, without following a redirect or silently accepting a different account center suggested by the server. Navigating to another server does not carry the password there.

Desktop connections are separated by server and account. Each local group window has its own random credential and its own remote cookies. Remote account tokens and session cookies are not stored in browser storage. Signing out of one window leaves other connections alone; forgetting a saved connection revokes that account's local session and agent binding. The personal workspace and native tool logins remain independent.

Identity uses the server issuer and a stable UUID, not a username alone. The server remembers the last viewed group for that account, so it can be restored on another computer. Drafts are isolated by server, account and group.

Model credentials, personal conversations, memory and working folders remain on the participant's own computer. Only calls from the bound account can invoke that computer. CLI permissions and approvals still apply.

Invitation codes rotate every 24 hours by default. Group owners can choose a period from 1 to 8760 hours or a permanent code, replace the code or disable invitations. Changing the period, rotating a code or re-enabling invitations invalidates the old code without removing existing members.

## Existing macOS background deployments

Deployments whose `.data/local-services.json` enables both `server` and `accountServer` retain their existing databases, identity and LaunchAgents. The panel manages those original services; they start at macOS login and remain available after the desktop window closes.

Background code and data live in `~/Library/Application Support/StarPort/services/`. Before updating, make an online database backup and ensure there are no active jobs. Run `node scripts/install-macos-services.mjs` with Node 24 to update the program snapshot. The installer preserves account IDs, owners, members, messages, devices and bindings, and rejects identity conflicts. Older program versions and deployment backups are retained.

Do not commit account databases, signing keys, saved logins or device tokens. Data directories are private to the current system user. The older external account-center protocol remains available for existing deployments; new desktop sign-ins use accounts on the chosen server itself.
