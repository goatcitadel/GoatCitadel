# Third-Party Notices

GoatCitadel is licensed under the Apache License 2.0 (see `LICENSE`). This file lists third-party content vendored into this repository, with its origin and license. Package dependencies carry their own licenses in `node_modules` and are not listed here.

## impeccable

- Repository: https://github.com/pbakaus/impeccable
- License: Apache License 2.0
- Vendored at commit: `4f956490f0056ae1ff5ea80372cf56e83c001d3c`
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

## Hermes Agent MCP catalog (optional-mcps)

- Repository: https://github.com/nousresearch/hermes-agent
- License: MIT, Copyright (c) 2025 Nous Research
- Reviewed at commit: `07ee800dc7`
- Used in: `apps/gateway/src/services/mcp-vendor-server-templates.ts` (server names, descriptions, vendor endpoint URLs and documentation links from `optional-mcps/*/manifest.yaml`; no code)
