# Third-party components

- MAGI 2.8.0, Misaka16384, MIT: https://github.com/Misaka16384/magi
  - Pinned commit: `e95f14a4a1601008cee9a00aa2b5e78c49842794`.
  - `src/magi-hosts.json` is generated from MAGI's `src/magi/core/hosts.py`.
  - The UI serves MAGI's vendored marked, KaTeX, and Archivo files unchanged.
  - Original license: `public/vendor/MAGI-LICENSE.txt`.
  - Only the generated host registry and necessary licensed UI assets are distributed; the full MAGI checkout is not required to run StarPort.
- Marked 15.0.12, MarkedJS and Christopher Jeffrey, MIT: https://github.com/markedjs/marked
  - Files: `public/vendor/marked.min.js` and `public/vendor/marked-LICENSE.md`.
- KaTeX, Khan Academy and other contributors, MIT: https://github.com/KaTeX/KaTeX
  - Files: `public/vendor/katex.min.js`, `public/vendor/katex.min.css`, `public/vendor/katex-fonts/`.
  - Original license: `public/vendor/katex-LICENSE.txt`.
- Archivo, Omnibus-Type, SIL Open Font License 1.1: https://github.com/Omnibus-Type/Archivo
  - Files: `public/vendor/fonts/archivo-latin-var.woff2` and `public/vendor/fonts/Archivo-OFL.txt`.
- DOMPurify 3.4.16, Cure53 and contributors, Apache-2.0 OR MPL-2.0: https://github.com/cure53/DOMPurify
  - License files are preserved in `node_modules/dompurify`.

Harness runtimes remain separate programs under their own terms; this app does not redistribute provider credentials.
