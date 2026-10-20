# Starport theme

English | [Chinese](zh-CN/spaceport-theme.md)

This theme depicts an interstellar spacecraft port rather than a maritime harbor. It coexists with Azure and Deep Space. The selection uses `localStorage['starport-theme']`; a new browser defaults to Azure and retains later choices.

## Files

| File | Responsibility |
| --- | --- |
| `public/theme.js` | Applies the saved theme before first paint; updates theme color, icon and button state |
| `public/spaceport.css` | Theme rules scoped to `html[data-theme=port]` |
| `public/assets/spaceport.svg` | Hand-written welcome artwork: orbital dock, approaching shuttle and planetary horizon |
| `public/assets/spaceport-icon.svg` | Octagonal hatch, orbital ring, star and amber beacon |

Azure's styling and artwork remain separate.

## Visual language

- Deep blue-black and graphite surfaces: `#05070c`, `#080c12`.
- Cyan `#5fd8ff` for selection and availability; amber `#ffb347` for running activity; green `#6ff0b0` for online or completed states.
- Fine HUD corner marks on inputs, tool panels, dialogs and menus, with stronger focus/hover treatment.
- Clipped corners on primary actions while retaining visible keyboard focus.
- Cascadia Mono for small branding, group labels, tool names and timestamps.
- A dimmed conversation background with a subtle 56px grid.
- Reduced-motion preferences disable beacon animation.

## Add a theme

1. Register colors and an icon in `public/theme.js`.
2. Scope a new stylesheet to `html[data-theme=<name>]`.
3. Add the theme choice in `public/index.html` and its translation in `public/i18n.js`.

Use isolated UI fixtures and temporary data for screenshots. Check desktop and narrow layouts, settings, menus, folder selection, saved choices, focus states and both languages. Do not use private conversations for public screenshots or depend on unpublished `.data` scripts as installation steps.
