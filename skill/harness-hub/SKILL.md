---
name: harness-hub
description: Open Starport (星港), the user's local workspace with shared conversation groups and Codex, Claude Code, Antigravity, or DeepSeek Harness backends. Use when asked to open Starport, 星港, or the former 同一处 / Harness Hub workspace. Does not replace ordinary coding, research, or account recovery tasks.
---

# Open Starport / 星港

Run `python scripts/open_hub.py` from this skill directory. The helper reads `app-location.json`, reuses an existing service when available, and opens the fixed local interface. If a browser cannot be opened, report the returned local URL.

The app owns its conversation groups and history. Do not generate a new frontend, create a new database, import private harness history, or change provider credentials just to open it.

The top-right 中 / EN switch changes the interface language and remembers the choice in that browser. The existing harness-hub invocation and application directory remain compatible.

Provider-specific options are displayed inside the app. Native Codex goals require the App Server capability; do not emulate that switch by inserting a goal instruction into a different harness. Missing authentication or an unavailable account should remain an explicit connection status while local history stays accessible.

If the saved application location is missing, ask for the new directory or run the application's skill installer from its new location. Preserve existing data and do not silently install a second copy.
