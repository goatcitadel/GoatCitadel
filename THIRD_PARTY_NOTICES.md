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

## OpenClaw skills (himalaya, github)

- Repository: https://github.com/openclaw/openclaw
- License: MIT, Copyright (c) 2026 OpenClaw Foundation
- Adapted at commit: `7559fb21a57`
- Vendored path: `skills/import-packs/himalaya/` and `skills/import-packs/github-cli/` (SKILL.md rewritten for GoatCitadel; `himalaya/references/message-composition.md` copied unchanged)
- Modifications: listed in each pack's `UPSTREAM.md`; each pack carries the upstream `LICENSE`.
- These packs are not loaded as skills. An operator brings one in through Skill Hub review, then installs and activates it through approvals.

## superpowers

- Repository: https://github.com/obra/superpowers
- License: MIT, Copyright (c) 2025 Jesse Vincent
- Adapted at commit: `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`
- Vendored path: `skills/bundled/debugging/` (from `systematic-debugging` and its technique files) and `skills/bundled/receiving-code-review/` (from `receiving-code-review`); each SKILL.md rewritten for GoatCitadel, no scripts, hooks, or plugin manifests
- Modifications: listed in each skill's `UPSTREAM.md`; each skill carries the upstream `LICENSE`.

## Matt Pocock skills

- Repository: https://github.com/mattpocock/skills
- License: MIT, Copyright (c) 2026 Matt Pocock
- Adapted at commit: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Vendored path: `skills/bundled/debugging/` (from `diagnosing-bugs`), `skills/bundled/tdd/` (from `tdd`), `skills/bundled/grilling/` (from `grilling` and `domain-modeling`), and `skills/bundled/codebase-design/` (from `codebase-design`); each SKILL.md rewritten for GoatCitadel, no scripts or hooks
- Modifications: listed in each skill's `UPSTREAM.md`; each skill carries the upstream `LICENSE`.

## Addy Osmani agent-skills

- Repository: https://github.com/addyosmani/agent-skills
- License: MIT, Copyright (c) 2025 Addy Osmani
- Adapted at commit: `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`
- Vendored path: `skills/bundled/secure-coding/` (from `security-and-hardening`); each SKILL.md rewritten for GoatCitadel, no hooks, commands, agents, or evals
- Modifications: listed in each skill's `UPSTREAM.md`; each skill carries the upstream `LICENSE`.

## Hermes Agent MCP catalog (optional-mcps)

- Repository: https://github.com/nousresearch/hermes-agent
- License: MIT, Copyright (c) 2025 Nous Research
- Reviewed at commit: `07ee800dc7`
- Used in: `apps/gateway/src/services/mcp-vendor-server-templates.ts` (server names, descriptions, vendor endpoint URLs and documentation links from `optional-mcps/*/manifest.yaml`; no code)
