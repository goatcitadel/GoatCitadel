# Upstream

- Source: OpenClaw, `skills/github/SKILL.md` (https://github.com/openclaw/openclaw)
- Upstream commit: `7559fb21a57`
- Licence: MIT, Copyright (c) 2026 OpenClaw Foundation. See `LICENSE`.

## GoatCitadel changes

- Rewritten for Gateway-governed `shell.exec`: one program per call, and multi-line bodies piped
  through a single explicit `sh -c` or `pwsh -Command` call instead of heredocs or temporary files.
- Every command goes through shell policy, which requires approval by default; the skill also asks the operator before any send, write, share or delete.
- Setup and sign-in happen in the operator's terminal. The skill never asks for or handles credentials in Chat.
- Upstream OpenClaw-only metadata and workflow (install manifests, session footers, merge tooling) removed.
- Ships as an imported (`extra`) skill: inspectable in the Library and not callable until the operator activates it.
