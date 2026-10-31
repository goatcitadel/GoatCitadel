# Upstream

- Source: addyosmani/agent-skills, `skills/source-driven-development/SKILL.md` (https://github.com/addyosmani/agent-skills)
- Upstream commit: `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`
- Licence: MIT, Copyright (c) 2025 Addy Osmani. See `LICENSE`.

## GoatCitadel changes

- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file.
- The detect, fetch, implement, and cite steps are kept; documentation is fetched with GoatCitadel's browser and HTTP tools and cited with `citations.build`.
- The guard on fetched pages is restated in plain words: the upstream example phrases of injected instructions are not quoted, so the shipped file passes the GoatCitadel promptware scanner.
- Removed: MCP and tool tables, the rationalization and red-flag tables, and harness-specific tool names.
