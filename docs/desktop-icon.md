# Starport desktop icon

Starport's external identity is the Azure star-and-ocean mark from the unmodified `public/icon.svg`. The desktop shortcut, mobile PWA install icon and GitHub project branding use this identity. Within the app, the sidebar and page favicon follow the selected Azure, Starport or Deep Space theme. See [Brand identity](branding.md).

The vector is rendered separately at 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256px, packaged with transparent PNG frames into `public/assets/starport-desktop-azure.ico`. Preview: `public/assets/starport-desktop-azure-preview.png`. The 180/192/512px mobile icons come from the same SVG.

`scripts/build-brand-icons.mjs` uses Sharp to render and package the assets. It accepts an optional first argument pointing to a Sharp module when using a bundled runtime. Previous generated variants and their full prompts are retained in [desktop-icon-v1.md](desktop-icon-v1.md) and [desktop-icon-v2.md](desktop-icon-v2.md).

`scripts/set-desktop-icon.ps1` updates the existing `Starport · 星港.lnk` IconLocation, backs up the shortcut under `.data/source-backups/desktop-icon-azure-20261012`, verifies launcher properties, notifies Windows Shell and exports the resolved icon to `.data/desktop-icon-azure-shell.png`. Use `-VerifyOnly` to inspect the shortcut. Restore the saved shortcut to undo the change.

Windows API references: [SHChangeNotify](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify), [SHGetFileInfoW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow).
