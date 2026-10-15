# AGENTS.md

Instructions for coding agents working on @nemanjan00/compactor.

Always use the /implement-js skill when writing code here.

- `src/` holds the harness-neutral core. It never imports a harness. It works on plain history items and returns plain edits, notes and tool results (see README.md, "How it fits a harness").
- `src/adapters/<harness>/` maps one harness onto the core. The pi adapter is `src/adapters/pi`.
- The repository is public and every commit is pushed: no secrets, and no real people, messages or company names in code, tests, docs or commit messages. Use made-up examples.
- `yarn test` (jest) and `yarn lint` (eslint) must pass before a commit; the pre-commit hook runs both.
