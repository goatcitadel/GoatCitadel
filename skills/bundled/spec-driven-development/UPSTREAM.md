# Upstream

- Source: addyosmani/agent-skills, `skills/spec-driven-development/SKILL.md` (https://github.com/addyosmani/agent-skills)
- Upstream commit: `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`
- Licence: MIT, Copyright (c) 2025 Addy Osmani. See `LICENSE`.

## GoatCitadel changes

- Ships explicit-only: the skill declares no keywords and its routing hints carry no phrases, so it loads only when the operator names it (`use spec-driven-development`, `@skill spec-driven-development`).
- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file; the gated phases become a numbered workflow, and the spec template becomes seven parts (objective, users, scope, non-goals, acceptance criteria, constraints, open questions).
- The spec stays in Chat unless the operator names a file; no `.claude/` or `docs/` location is assumed.
- Removed: the `/spec`, `/plan`, `/build`, `/test`, and `/ship` commands, the capability-map phase, the tech-stack, commands, structure, and code-style template sections, the rationalization and red-flag tables, and harness-specific tool names.
