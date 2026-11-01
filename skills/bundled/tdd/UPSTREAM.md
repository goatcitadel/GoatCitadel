# Upstream

- Source: mattpocock/skills, `skills/engineering/tdd/SKILL.md`, `tests.md`, `mocking.md` (https://github.com/mattpocock/skills)
- Upstream commit: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Licence: MIT, Copyright (c) 2026 Matt Pocock. See `LICENSE`.

## GoatCitadel changes

- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file; `tests.md` and `mocking.md` are condensed into the "Good tests" and "Signs a test is wrong" sections.
- The loop is written as numbered steps with an output recipe; refactoring is a separate step on green rather than a separate review skill.
- "Confirm the seams with the user" applies when the scope is wider than one function.
- Removed: references to GLOSSARY.md, ADRs, the Skill tool, and the `code-review` and `codebase-design` skill invocations (the bundled `codebase-design` skill is named as related instead).
- Tool names are GoatCitadel tool ids (`fs.read`, `fs.write`, `shell.exec`).
