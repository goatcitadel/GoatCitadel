# Upstream

- Source: addyosmani/agent-skills, `skills/security-and-hardening/SKILL.md`, `references/security-checklist.md` (https://github.com/addyosmani/agent-skills)
- Upstream commit: `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`
- Licence: MIT, Copyright (c) 2025 Addy Osmani. See `LICENSE`.

## GoatCitadel changes

- Renamed `secure-coding` so it does not collide with the `harden` command of the bundled impeccable design skill.
- Rewritten as one self-contained SKILL.md for the GoatCitadel runtime, which injects only that file; the hardening controls are condensed to one line each and the security checklist to ten items.
- The three-tier "always / ask first / never" boundary system is replaced by the operator-decides section and GoatCitadel's own approval gates.
- Removed: the CI and GitHub Actions material, install-command tables, framework snippets, the rationalization and red-flag tables, and harness-specific tool names.
- Tool names are GoatCitadel tool ids (`fs.read`, `shell.exec`).
