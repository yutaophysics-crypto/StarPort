# Project external development tools

Click **External tools** beside the workspace folder below the message box. This opens the current project's tool permissions directly. Add the tool's installation folder; an executable path is optional and must stay inside that folder. **Verify access** reads the directory and executable metadata in the same Windows sandbox used by Claude; it does not start a build.

**Common tools** remembers tool names, installation folders and executable paths added on this computer. Each installation folder has one entry with its latest successfully added details. Existing grants populate the list automatically; removing project access keeps the remembered choice. **Add to this project** creates a separate grant for the current project after rechecking paths and project boundaries. Missing or changed paths need manual reauthorization. The catalog stays on this computer and does not grant access to other projects or devices.

This integration supports Claude Code on native Windows with the Codex Windows MXC runtime. It uses an existing workspace-terminal runtime or the registered native `codex.exe`. Other providers keep their native permissions. Grants do not enable networking or interactive editor automation.

The exact working folder is the scope; subfolders are separate projects. Installations are readable and runnable, never writable. The project and `.starport-claude-runtime` are writable. Temporary, home, npm cache, AppData and LocalAppData folders are redirected into that project cache. An engine needing another location fails with its real error; no unrestricted retry occurs. Personal editor preferences and login files outside the grant are not exposed automatically.

Grants live in the machine-local `.data/external-tools.json`, outside project files and shared memory. Do not transfer this as a portable permission grant. Moving a project requires adding its tools again. Physical targets are checked at grant time and before launches/commands; retargeted junctions require reauthorization. Broad drive, home, Starport and private-configuration roots are rejected.

Claude gets extra directories and Edit-deny rules. Its built-in command tools are disabled for these launches; commands use the sandboxed MCP terminal. Private per-run settings retain owner proxy and browser/explicit MCP configuration, and are removed when the turn ends. Grant changes invalidate the native session fingerprint: the next turn receives the saved Starport conversation in a fresh native session. Chat history is retained.

Project grants cannot change or be verified during active conversation/workflow tasks. Load updates only when the server is idle; existing turns keep their original policy.

## Cocos Creator

Add a version folder such as `C:\DevTools\Cocos\Creator\3.8.8` and its `CocosCreator.exe`. Ask Claude to read engine files or build via `mcp__starport_workspace__run_command`. Wait for Windows GUI executables with `Start-Process -Wait -PassThru -WindowStyle Hidden` or Node `child_process.spawnSync`; direct PowerShell invocation can return early.

Creator 3.8 uses `--project <project path> --build "platform=web-desktop;debug=true"`. Keep outputs/logs in the project. Cocos reports successful builds with exit code **36**. The game must already be a valid Cocos project; granting access does not convert it. See [Cocos command-line publishing](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-in-command-line.html).
