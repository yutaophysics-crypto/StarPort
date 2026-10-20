# Starport desktop icon

Design: deep navy rounded tile, silver navigation star, cyan docking orbit and one warm champagne beacon. Generated with the built-in imagegen tool; the PNG artwork is preserved without retouching. Windows ICO packaging supplies transparent 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 pixel frames.

Assets: `public/assets/starport-desktop.png` (source), `public/assets/starport-desktop-v1.ico` (Windows), `public/assets/starport-desktop-preview.png` (256px preview).

`scripts/set-desktop-icon.ps1` updates only the existing StarPort shortcut's IconLocation, including legacy localized shortcuts. It first backs up the shortcut under `.data/source-backups/desktop-icon-20261007`, verifies launcher properties remain identical, notifies the Windows Shell and exports the icon resolved by the Shell for inspection. It does not start or restart the server. Use `-VerifyOnly` to check the current shortcut without changing it. Restore the saved shortcut to undo the change.

Official Windows API references: [SHChangeNotify](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify), [SHGetFileInfoW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow).

## Generation prompt

```text
Use case: logo-brand. Asset type: a single premium Windows desktop app icon for Starport, a local AI workspace themed around deep space, starships and a harbor among the stars. Generate ONE finished icon, square composition, no presentation board, no text, no lettering, no mockup. A softly rounded square tile nearly fills the canvas, with fully transparent corners outside its silhouette. The tile is deep midnight navy with a subtle luminous depth and a restrained satin-metal rim, not a heavy frame. In the center, a bold pearl-white four-point navigation star, slightly taller than wide, forms the unmistakable dominant silhouette; crisp sculptural shape and small cyan reflected highlights. A clean tilted elliptical docking orbit wraps around the star's lower half, like an elegant spacecraft harbor ring: silver-white on its front arc, desaturated cyan on its back arc, one tiny warm champagne beacon at the left. The symbol is simple and confident, large enough to read at 32 and 48 pixels; generous clear negative space, minimal deliberate forms, professional Mac/Windows app icon craft with subtle 3D materials and precise edges. Colors: midnight navy, icy cyan, pearl silver, extremely restrained warm gold. Soft controlled lighting, no noisy star field, no tiny HUD marks, no planets, no galaxy scene, no spaceship illustration, no overbloom, no rainbow gradients, no typography, no extra decorative elements. The actual icon fills roughly 90 percent of the image. True transparent alpha outside the rounded tile, no background plane and no cast shadow outside the tile.
```
