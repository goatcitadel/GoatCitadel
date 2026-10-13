# Third-Party Notices

GoatCitadel is licensed under the Apache License 2.0 (see `LICENSE`). This file lists third-party content vendored into this repository, with its origin and license. Package dependencies carry their own licenses in `node_modules` and are not listed here.

## impeccable

- Repository: https://github.com/pbakaus/impeccable
- License: Apache License 2.0
- Vendored at commit: `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`
- Vendored path: `skills/bundled/impeccable/` (SKILL.md and `reference/*.md` prose only; no launcher, binaries, hooks, or live-mode code)
- Modifications: listed per file in `skills/bundled/impeccable/UPSTREAM.md`; the attribution and modification statement is `skills/bundled/impeccable/NOTICE`.
- Refresh: `node scripts/sync-impeccable.mjs --source <local upstream checkout> --sha <commit>` (never downloads or executes upstream code).
- Detector: `packages/skills/src/design-detector/rules.ts` holds GoatCitadel-authored regex heuristics that approximate a few craft-floor rules by their `rule:` ids; they are not impeccable's rule engine and claim no parity with it.
