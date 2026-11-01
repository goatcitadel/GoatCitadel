# Upstream

- Source: obra/superpowers, `skills/systematic-debugging/SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md` (https://github.com/obra/superpowers)
- Upstream commit: `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`
- Licence: MIT, Copyright (c) 2025 Jesse Vincent. See `LICENSE`.
- Source: mattpocock/skills, `skills/engineering/diagnosing-bugs/SKILL.md` (https://github.com/mattpocock/skills)
- Upstream commit: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Licence: MIT, Copyright (c) 2026 Matt Pocock. See `LICENSE`.

## GoatCitadel changes

- The two upstream skills are merged into one: the feedback-loop-first discipline and redaction rule come from diagnosing-bugs, the phase order, backward tracing, condition-based waiting, layered validation, and the three-failed-fixes stop come from systematic-debugging.
- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file; the supporting technique files are condensed into a few lines each.
- Pressure framing ("Iron Law", rationalization tables, red-flag lists) is replaced by a workflow and an output recipe; "your human partner" becomes "the operator".
- Removed: `find-polluter.sh`, the HITL loop script, the TypeScript example, `CREATION-LOG.md`, the `test-*.md` pressure scenarios, references to GLOSSARY.md and ADRs, and every harness-specific tool name.
- Tool names are GoatCitadel tool ids (`fs.read`, `shell.exec`).
