# Skill Adoption Matrix

Review matrix for the requested external skills. This document is the operator-readable companion to GoatCitadel's repo-native import validation and overlap policy.

Last updated: 2026-03-22

## Decision Rules

- Repo-managed installs belong under `skills/extra`.
- Marketplace listing URLs are reference-only. Resolve and validate the upstream repository or bundle before import.
- Overlapping families should keep a single primary repo-managed install.
- Bundled GoatCitadel-native capabilities win over external overlaps.

## Requested Skills

| Skill | Listing | Decision | Family | Notes |
| --- | --- | --- | --- | --- |
| Cloudflare API | `https://clawhub.ai/lucassynnott/cloudflare-api` | Install candidate | `cloudflare_dns` | Choose one primary Cloudflare or DNS skill. |
| Cloudflare Manager | `https://clawhub.ai/1999AZZAR/cloudflare-manager` | Install candidate | `cloudflare_dns` | Choose one primary Cloudflare or DNS skill. |
| Domain DNS Ops | `https://clawhub.ai/steipete/domain-dns-ops` | Reference first | `cloudflare_dns` | Keep as reference unless it adds a unique workflow beyond the primary Cloudflare path. |
| FlareSolverr | `https://clawhub.ai/Dolverin/flaresolverr` | Conditional | `flaresolverr_runtime` | Only import after confirming a working FlareSolverr service already exists. |
| GoG | `https://clawhub.ai/steipete/gog` | Conditional | `google_cli_oauth` | Only import when Google CLI or OAuth workflows are an active requirement. |
| Agent Browser | `https://clawhub.ai/TheSethRose/agent-browser` | Overlap reference | `browser_automation` | Overlaps existing broader-environment browser automation capability. |
| Proactive Agent | `https://clawhub.ai/halthelobster/proactive-agent` | Reference first | `proactive_automation` | Mine ideas before any repo-managed install. |
| Skill Vetter | `https://clawhub.ai/spclaudehome/skill-vetter` | Overlap reference | `skill_vetting` | GoatCitadel already has native import validation and bundled vetting support. |
| Self Improving | `https://clawhub.ai/ivangdavila/self-improving` | Reject as overlap | `safe_self_improvement` | GoatCitadel already ships a native safe self-improvement bundle. |
| Free Ride | `https://clawhub.ai/Shaivpidadi/free-ride` | Conditional | `openclaw_experiment` | Only consider after confirming a concrete GoatCitadel use case and runtime compatibility. |
| Auto Updater | `https://clawhub.ai/maximeprades/auto-updater` | Reference first | `auto_updates` | Reimplement update review natively in GoatCitadel instead of importing this directly. |
| Open Persona | `https://clawhub.ai/NeilJo-GY/open-persona` | Hold | `persona_runtime` | Optional future capability, not part of the first install batch. |
| AI Swarm | `https://clawhub.ai/linkbag/ai-swarm` | Quarantine | `multi_agent_swarm` | High-impact repo mutation and automation behavior; keep out of the first install batch. |

## Current Primary Recommendation

- Pick one of `Cloudflare API` or `Cloudflare Manager` as the first repo-managed Cloudflare skill.
- Keep `FlareSolverr` and `GoG` out until their runtime prerequisites are real.
- Use the remaining items as design or workflow references unless GoatCitadel later grows a concrete need that justifies a second review.
