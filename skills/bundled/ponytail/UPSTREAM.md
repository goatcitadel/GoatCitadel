# Upstream

- Source: DietrichGebert/ponytail, `skills/ponytail/SKILL.md`, `skills/ponytail-review/SKILL.md` (https://github.com/DietrichGebert/ponytail)
- Upstream commit: `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`
- Licence: MIT, Copyright (c) 2026 DietrichGebert. See `LICENSE`.

## GoatCitadel changes

- Ships explicit-only: the skill declares no keywords and its routing hints carry no phrases, so it loads only when the operator names it (`use ponytail`, `@skill ponytail`, `$bundled:ponytail`).
- The persona ("you are a lazy senior developer") is restated as a way of working, and "active for the whole session until the user says stop" becomes "applies to the turn it is invoked in"; the `/ponytail lite|full|ultra` command becomes one conditional line per level.
- `ponytail-review` is condensed into a "Review mode" section.
- Removed: the `ponytail-debt`, `ponytail-gain`, and `ponytail-help` skills, the benchmark claims, the hooks (mode tracker, statusline, band ledger, webhook), the plugin manifests, and the `argument-hint` and `license` frontmatter keys.
- Tool names are GoatCitadel tool ids (`fs.read`, `fs.write`, `shell.exec`).
