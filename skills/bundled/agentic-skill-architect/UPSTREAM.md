# Upstream

The "Writing a GoatCitadel Skill" section of this GoatCitadel skill is adapted from upstream; the rest is GoatCitadel-authored.

- Source: mattpocock/skills, `skills/productivity/writing-for-agents/SKILL.md`, `SKILL-MECHANICS.md` (https://github.com/mattpocock/skills)
- Upstream commit: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Licence: MIT, Copyright (c) 2026 Matt Pocock. See `LICENSE`.
- Source: addyosmani/agent-skills, `skills/context-engineering/SKILL.md` (https://github.com/addyosmani/agent-skills)
- Upstream commit: `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`
- Licence: MIT, Copyright (c) 2025 Addy Osmani. See `LICENSE`.

## GoatCitadel changes

- Condensed into an eight-point review checklist for GoatCitadel `SKILL.md` files: trigger-only descriptions, self-contained files under the catalog budget, substring keyword matching and explicit-only skills, recipes over prohibitions, one example, ordering by stability, promptware-scanner-safe text, and declared tools.
- The GoatCitadel-specific facts (single-file injection, substring activation, the scanner, explicit-only routing) come from this repository, not from upstream.
- Not carried over: progressive disclosure into reference files (GoatCitadel injects only `SKILL.md`), router skills, the rules-file and context-packing templates, and the MCP section.
