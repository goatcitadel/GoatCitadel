# GoatCitadel 1.0 Release Surface Scope

Last updated: 2026-05-26

This table freezes the visible Mission Control Next `1.0` route surface after the final release-readiness promotion. The canonical route list is [apps/mission-control-next/src/app/route-model.ts](../apps/mission-control-next/src/app/route-model.ts); surface and visual verification consume [scripts/verification/lib/release-surface-manifest.mjs](../scripts/verification/lib/release-surface-manifest.mjs).

Status meanings:

- `ship`: release-bearing route with a real operator action path.
- `needs_release_polish`: visible route that remains in verification but blocks final `1.0` readiness until the listed polish is resolved.
- `experimental`: visible route that must be labeled in the shell and must not be cited as release-ready.
- `hide`: route must not appear in visible navigation or release-surface verification.

| Route | Status | Required action path or release truth |
|---|---|---|
| `/chat` | `ship` | Send a Chat turn and inspect model/tool/runtime context when present. |
| `/cowork` | `ship` | Start/resume durable Cowork work; inspect next action, blockers, approvals, and evidence truth. |
| `/cowork/tasks` | `ship` | Review tasks/deliverables, continuation state, and blocker hierarchy. |
| `/cowork/board` | `ship` | Inspect agent posture without implying autonomous live-control parity. |
| `/code` | `ship` | Bind source, edit, validate, inspect diffs, and preserve Code Mode proof truth, including execution backend posture. |
| `/projects` | `ship` | Continue Chat/Cowork/Code work from a project home base. |
| `/library/agents` | `ship` | Inspect reusable agent profiles and catalog controls. |
| `/library/skills` | `ship` | Review skill activation posture and lifecycle evidence. |
| `/library/capabilities` | `ship` | Inspect capability availability, degraded posture, and callable/inspectable truth. |
| `/library/memory` | `ship` | Route memory lifecycle through `MemoryLifecycleService` with operator provenance. |
| `/library/knowledge` | `ship` | Inspect knowledge sources with source visibility and provenance links. |
| `/library/files` | `ship` | Browse uploaded and workspace files. |
| `/library/artifacts` | `ship` | Reopen artifacts and expose linked run/source/decision provenance. |
| `/library/prompt-packs` | `ship` | Author, export, benchmark, and review prompt packs. |
| `/library/curator` | `experimental` | Skill-health proposals only; not release automation. |
| `/ops/activity` | `ship` | Inspect retained events and Ops attention signals. |
| `/ops/sessions` | `ship` | Inspect session timelines, summaries, and operator evidence. |
| `/ops/schedules` | `ship` | Review scheduler posture and primary governed-work actions. |
| `/ops/improvement` | `experimental` | Improvement loops are experimental replay/self-improvement support. |
| `/ops/notifications` | `ship` | Review runtime issues, self-repair proposals, and follow-up signals. |
| `/ops/approvals` | `ship` | Review pending decisions, replay effects, and approval history. |
| `/ops/costs` | `ship` | Inspect spend visibility and cost evidence. |
| `/ops/runtime` | `ship` | Inspect gateway health, daemon posture, host vitals, and backups. |
| `/ops/diagnostics` | `ship` | Inspect durable, daemon, admin, docs, and readiness diagnostics. |
| `/ops/kanban` | `experimental` | Multi-agent board is experimental; bulk controls are not final release control. |
| `/settings/general` | `ship` | Configure base defaults. |
| `/settings/providers` | `ship` | Configure credentials and run provider/model smoke evidence with plain failures. |
| `/settings/personalities` | `experimental` | Personality presets are experimental Chat-default polish. |
| `/settings/access` | `ship` | Inspect auth posture, secret storage truth, and access boundaries. |
| `/settings/permissions` | `ship` | Configure permission profiles and local operator override evidence. |
| `/settings/budget` | `ship` | Set budget mode and review cost evidence. |
| `/settings/onboarding` | `ship` | Complete Start Here: provider/local path, first Chat/Cowork/Code task, retained evidence, and Run Detail inspection. |
| `/settings/runtime` | `ship` | Configure runtime posture while experimental sidecars stay labeled. |
| `/settings/workspaces` | `ship` | Configure workspace context, guidance, and extension posture. |
| `/settings/addons` | `experimental` | Add-on posture only; no full marketplace/install lifecycle claim. |
| `/settings/integrations` | `ship` | Each visible connector has a setup/action path or explicit blocked/incomplete copy. |
| `/settings/channels` | `ship` | Each visible channel has guided setup with live-auth/send diagnostics or blocked copy. |
| `/settings/mcp` | `ship` | Local stdio and Approval Inbox paths are visible; remote http/sse preview is read-only and remains blocked/experimental for generic invocation. |
| `/settings/tools` | `ship` | Inspect tool catalog and scoped allow/deny grants. |
