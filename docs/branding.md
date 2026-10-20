# Brand identity and theme order

English | [Chinese](zh-CN/branding.md)

StarPort's external identity is the Azure star-and-ocean mark in `public/icon.svg`. Use it for desktop shortcuts, PWA installation icons, repository branding and other material outside the application.

Within the application, the sidebar and favicon follow the selected theme: Azure uses `public/icon.svg`, Starport uses `public/assets/spaceport-icon.svg`, and Deep Space uses `public/assets/deep-space-icon.svg`. Installed application icons retain the Azure identity.

The theme order is **Azure → Starport → Deep Space**. Azure is the default when there is no saved preference; an existing choice is preserved. The sequence expresses a progression from Earth and its oceans to interstellar ports and deeper space.

`scripts/build-brand-icons.mjs` generates Windows ICO and mobile installation icons from the Azure SVG. Reuse that asset for new external entry points; retain each theme's independent in-app artwork and decoration.
