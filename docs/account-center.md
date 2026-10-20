# Servers and accounts

English | [简体中文](zh-CN/account-center.md)

## Start a server from StarPort

Open **Settings → Connections & data → Local server**. Choose a local port (3218 by default). If people on other networks need access, fill in a stable public HTTPS address first, then start the server. Account and group services start together, and account endpoints live at `/account` on the same address. No separate StarPort server software is needed.

Each server keeps its own accounts, password verification data, group members, messages and invitation codes. In this panel, administrators can view accounts, create accounts, turn self-registration on or off, disable or re-enable accounts and reset passwords. Passwords are stored as salted scrypt hashes and are never displayed. Disabling an account or resetting its password signs that account out everywhere and revokes its agent connections; other accounts are not affected, and group members and messages are kept.

Once a server has accounts, its identity address cannot be changed directly. Changing it requires a backup and an explicit issuer migration, so that a same-named account is never mistaken for an old member. Closing registration does not affect existing logins, and administrators can still create accounts. A server with queued, claimed or running agent jobs refuses to stop. Stopping keeps the databases, and the server picks up where it left off when restarted.

New installations save server settings in `server-hosting.json` inside the workspace data directory. Account and group databases live under `hosted-server/accounts` and `hosted-server/groups`. Saved client connections are in `server-accounts/<profileId>` and window credentials in `group-windows.json`. These are private runtime files and must not go into source control or public backups. Closing the desktop window does not stop the local Node service. After a reboot, opening StarPort restores the servers that were enabled.

## Public HTTPS access

The server listens only on the loopback address by default. Point Caddy, your own reverse proxy or an HTTPS tunnel at the group port, using the same public address configured in StarPort. Do not expose the personal workspace on port 3210 to the internet. The HTTPS entry forwards both group routes and `/account`, so internal account ports need not be published.

A public server must stay powered on, online and awake. Temporary Quick Tunnels are fine for testing, but their address can change when they exit, so they cannot provide a stable issuer address for long-lived accounts. A production server with accounts should use a fixed domain and a persistent entry point. StarPort does not buy domains or create third-party tunnels automatically.

## Sign-in and separate windows

In the group window, enter the server address, username and password. The desktop first checks the service at that address, then sends the login request only to that server's `/account` endpoint. It does not follow redirects or accept a different account center suggested by the server. Opening a server's group page directly in a browser also uses that server's own accounts; entering another address navigates there first and does not carry the password along.

The desktop keeps a separate login and agent bridge for each server-and-account pair. Group pages run in their own local windows, and the backend proxies only the group endpoints that are explicitly allowed. Remote account tokens and session cookies are not kept in browser storage. Each window has its own random credential, so even two accounts on the same server do not overwrite each other's cookies. Signing out of a window ends only that window's login; forgetting a saved connection revokes that account's local session and agent binding. The personal workspace and native tool logins stay independent.

Identity uses the server issuer plus a stable UUID. A same-named account never inherits an old member's group or computer permissions. The server records the last group each account viewed, so signing in on another computer restores it. Drafts are kept separate per server, account and group.

Model credentials, personal conversations, personal memory and agent working folders stay on each participant's own computer. Only group tasks started by the account owner can call that owner's bound computer. Read-only and execution permissions still follow each CLI's limits and approvals.

Invitation codes rotate every 24 hours by default. Group owners can choose a period from 1 to 8760 hours or a permanent code, and can replace the code or disable invitations at any time. Changing the period, replacing the code, or disabling and re-enabling invitations invalidates the old code; existing members stay.

## Existing macOS background deployments

A deployment whose `.data/local-services.json` enables both `server` and `accountServer` is recognized as an existing server. It keeps its original databases and LaunchAgents, and account identities are neither copied nor replaced. The panel manages those two background services; LaunchAgents start them at macOS login, and they keep running after the desktop app quits.

Background programs and databases live in `~/Library/Application Support/StarPort/services/`. Before updating, make an online database backup and confirm there are no active jobs, then run `node scripts/install-macos-services.mjs` with Node 24 to update the program snapshot. The script keeps existing account IDs, owners, members, messages, devices and bindings, and rejects identity conflicts. Older program versions and pre-deployment backups are kept.

Do not commit account databases, signing keys, client logins or device tokens to Git. Data directories are accessible only to the current system user, and databases, keys and login files use private file permissions. The older external account-center login protocol remains available for existing deployments; the new desktop sign-in (address, username, password) uses accounts on the chosen server itself.
