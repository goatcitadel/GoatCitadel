# Upstream

- Source: mattpocock/skills, `skills/productivity/grilling/SKILL.md`, `skills/engineering/domain-modeling/SKILL.md` (https://github.com/mattpocock/skills)
- Upstream commit: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Licence: MIT, Copyright (c) 2026 Matt Pocock. See `LICENSE`.

## GoatCitadel changes

- Merged: the design-tree interview from `grilling` and the language-sharpening, scenario, and code cross-reference habits from `domain-modeling`.
- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file.
- Facts are looked up with `fs.read` and `memory.read` in the same turn instead of a sub-agent dispatch.
- The upstream GLOSSARY.md, GLOSSARY-MAP.md, and `docs/adr/` layout is not assumed: saving agreed terms or a decision record happens only in a file the operator names.
- Removed: the emoji round format (a plain numbered format replaces it), GLOSSARY-FORMAT.md and ADR-FORMAT.md, and harness-specific tool names.
