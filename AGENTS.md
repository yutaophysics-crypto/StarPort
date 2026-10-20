# StarPort project instructions

- Use Node.js 24 or later. Install dependencies with `npm ci` and run `npm test`.
- Keep changes focused and preserve the existing adapter behavior and permission boundaries.
- Use fictional conversations, profiles, file names and example domains in tests.
- Never commit local conversations, memories, credentials, exports or runtime state.
- Do not read native account history in fixtures; construct isolated test data instead.
- Preserve third-party license notices. StarPort's own source is licensed under MIT.
- Submit changes to this public repository through a pull request; external changes require the repository owner's review before merging into `main`.
- Do not push directly to `main`, bypass its review rules, or copy private repository history into this repository.
- Publishing, pushing, changing repository visibility and rewriting history require the maintainer's instruction.
