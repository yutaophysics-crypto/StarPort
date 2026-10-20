# Deep Space

English | [Chinese](zh-CN/deep-space-theme.md)

Deep Space is the third independent theme. Select it in the theme switcher; the choice is stored in the current browser and survives reloads. Azure remains the default for a browser with no saved theme.

The main view looks through an orbital dock's observation window: a silver-white spacecraft, graphite surfaces and warm amber guide lights. The welcome view reveals the artwork; conversation views dim it. Clear dark panels separate chat, task activity, settings and folder selection.

## Implementation

- Styles: `public/deep-space.css`, scoped to `html[data-theme=deep-space]`. Compact mobile theme-switch rules are shared.
- Registration: `public/theme.js`, including theme color, favicon and button state.
- Artwork: `public/assets/deep-space.webp`, 1672 × 941, loaded locally.
- Icon: `public/assets/deep-space-icon.svg`.
- Generated with the built-in image generator and converted to WebP without cropping. Full prompt: [deep-space-prompt.txt](deep-space-prompt.txt).
- Supports both interface languages, narrow windows and reduced-motion preferences.

The original theme validation used an isolated database and simulated adapters, with desktop and mobile widths. It covered welcome and conversation views, task activity, formulas, code, settings, menus, folder selection, persistence and horizontal overflow. Those historical checks do not replace running current tests after a change.

For a local visual fixture, use `tests/deep-space-ui-fixture.mjs`. Runtime screenshots and validation output belong in ignored `.data`, not the public source tree.
