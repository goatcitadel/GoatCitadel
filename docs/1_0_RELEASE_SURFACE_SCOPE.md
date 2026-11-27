# GoatCitadel 1.0 Release Surface Scope

Last updated: 2026-11-20

Cockpit is the default Mission Control Next shell. These tables describe its launch destinations and the routes retained in Classic for explicit rollback. Route status describes the release target. Current test coverage and release-candidate acceptance are recorded separately. [Release evidence](./1_0_RELEASE_EVIDENCE.md)

Status meanings

- `ship`: release-bearing route with a real operator action path.
- `needs_release_polish`: visible route that remains in verification but blocks final `1.0` readiness until the listed polish is resolved.
- `experimental`: visible or reachable route with an explicit label or availability limit. Release-ready claims exclude these routes.
- `hide`: route must not appear in visible navigation or release-surface verification.

## Cockpit release surface

The Cockpit router owns path resolution. The launch registry anchors these statuses and identifies the subset with deterministic behavior and visual scenarios. The developer gallery is outside release scope. [Cockpit routes](../apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts) · [Release surface manifest](../scripts/verification/lib/release-surface-manifest.mjs)

| Route | Status | Required action path or release truth |
|---|---|---|
| `/chat` | `ship` | Send a turn and inspect its model, work, tools, decisions and evidence. |
| `/chat/projects` | `ship` | Pick a project and open its conversations and work. |
| `/chat/messaging/add` | `ship` | Choose a channel and follow its guided setup or explicit blocked state. |
| `/chat/messaging/advanced` | `ship` | Inspect channel connections and the full setup controls. |
| `/inbox` | `ship` | Review pending decisions, questions and alerts, and open the saved record where it is managed. |
| `/work` | `ship` | Review operational tasks and open their run records. |
| `/work/history` | `ship` | Inspect recent work and run evidence. |
| `/work/schedules` | `ship` | Inspect schedules and create or manage governed recurring work. |
| `/work/archive` | `ship` | Inspect archived tasks and restore them where available. |
| `/work/automation` | `ship` | Draft, preview and export a reviewable automation recipe. |
| `/work/kanban` | `experimental` | Inspect the older multi-agent board with its Experimental label. |
| `/capabilities/skills` | `ship` | Inspect Installed or Discover and use governed review, install and activation paths. |
| `/capabilities/plugins` | `ship` | Inspect plugin provenance or open the governed install review. Claude Code import has a limited experimental scope. |
| `/capabilities/connectors` | `ship` | Review connector availability and open its setup path or blocked explanation. |
| `/capabilities/connectors/advanced` | `ship` | Open the supported MCP, integration and web search editors. |
| `/capabilities/tools` | `ship` | Search the tool catalog and inspect or change tool groups through Gateway policy. |
| `/library` | `ship` | Inspect capability candidates, provenance and mesh availability. |
| `/library/memory` | `ship` | Inspect and manage workspace memory through its saved records. |
| `/library/notes` | `ship` | Browse and edit workspace notes. |
| `/library/files` | `ship` | Browse files in the active workspace. |
| `/library/artifacts` | `ship` | Reopen artifacts and follow source evidence. |
| `/library/agents` | `ship` | Inspect reusable agent profiles. |
| `/library/knowledge` | `ship` | Inspect knowledge sources and review proposed imports. |
| `/library/communications` | `ship` | Inspect connected mail, agenda and contacts under Gateway policy. |
| `/library/prompt-packs` | `ship` | Author, test and review prompt packs. |
| `/library/journey` | `experimental` | Inspect captured lifecycle evidence and its producer coverage limits. |
| `/library/curator` | `experimental` | Inspect advisory skill-health proposals. |
| `/library/citadel` | `ship` | Draft a Citadel through guided setup and review its Blueprint. |
| `/library/citadel-overview` | `ship` | Inspect Citadel identity, governance and current state. |
| `/library/citadel-blueprint` | `ship` | Export a secret-free Blueprint or review an import. |
| `/library/citadel-wards` | `ship` | Author and test deny-wins rules. Replay-dependent integration and outbound A2A actions remain blocked when approval is required. |
| `/library/citadel-council` | `ship` | Inspect Council seats and review changes to agent membership. |
| `/library/citadel-vault` | `experimental` | Storing and revealing secrets are disabled while the production Vault key is held. Metadata and removal of existing records remain governed. |
| `/scripts` | `ship` | Review workspace-scoped recorded files and artifacts, open read-only previews or the original record, and manage inert retention labels. |
| `/system` | `ship` | Inspect health and follow checks to their details. |
| `/system/runtime` | `ship` | Inspect services, runtime settings and backups. |
| `/system/runtime/workers` | `experimental` | Inspect the explicit live-data hold for remote workers. |
| `/system/spend` | `ship` | Inspect spend and supporting evidence. |
| `/system/spend/details` | `ship` | Change the time window and inspect spend entries. |
| `/system/quality` | `ship` | Inspect evaluations and quality evidence. |
| `/system/diagnostics` | `ship` | Inspect runtime diagnostics and release readiness. |
| `/system/activity` | `ship` | Browse retained events and their references. |
| `/system/sessions` | `ship` | Open saved session evidence. |
| `/system/dashboards` | `ship` | Manage saved layouts whose widgets read canonical data. |
| `/system/browser-sessions` | `ship` | Inspect browser sessions and their granted access. |
| `/system/improvement` | `experimental` | Inspect improvement proposals and their evidence. |
| `/system/repairs` | `experimental` | See stuck work the detect-only repair sweep noticed; it watches and changes nothing. |
| `/settings/general` | `ship` | Configure general and appearance defaults. |
| `/settings/models` | `ship` | Configure providers, test connections and inspect model or local runtime options. |
| `/settings/safety` | `ship` | Review approvals, trust policy and permission settings. |
| `/settings/citadel` | `ship` | Manage Citadel and workspace settings with the same Vault hold as Library. |
| `/settings/access` | `ship` | Inspect access and authentication settings. |
| `/settings/advanced` | `ship` | Inspect and configure advanced runtime and lifecycle settings. |
| `/settings/first-run` | `ship` | Step through first-run setup and open Chat for the first completed turn. |

The Cockpit router sends older connector and channel links to Capabilities and Chat Messaging, dashboard links to System, and project links to Chat Projects. These addresses still resolve in Classic when explicitly selected. [Cockpit route adapter](../apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts)

## Classic release surface

The Classic route model and release registry own the compatibility table. [Classic route model](../apps/mission-control-next/src/app/route-model.ts) · [Classic route release scope](../apps/mission-control-next/src/app/route-release-scope.ts)

| Route | Status | Required action path or release truth |
|---|---|---|
| `/chat` | `ship` | Send a Chat turn and inspect model/tool/runtime context, approvals, artifacts, planning, delegation, and code-capability context when present. |
| `/projects` | `ship` | Continue Chat work from a project home base. |
| `/library/agents` | `ship` | Inspect reusable agent profiles and catalog controls. |
| `/library/skills` | `ship` | Review skill activation posture and lifecycle evidence. |
| `/library/capabilities` | `ship` | Inspect capability availability, degraded posture, and callable/inspectable truth. |
| `/library/memory` | `ship` | Route memory lifecycle through `MemoryLifecycleService` with operator provenance. |
| `/library/journey` | `experimental` | Inspect the currently captured read-only skill-learning and candidate-governance timeline; incomplete producer coverage is labeled and no mutation or promotion is available. |
| `/library/knowledge` | `ship` | Inspect knowledge sources with source visibility and provenance links. |
| `/library/notes` | `ship` | Capture workspace-scoped notes, checklists, reminders, and follow-up state outside learned-memory promotion. |
| `/library/communications` | `ship` | Inspect mail, agenda, contacts, and approval-gated drafts without storing raw credentials or sending without approval. |
| `/library/files` | `ship` | Browse uploaded and workspace files. |
| `/library/artifacts` | `ship` | Reopen artifacts and expose linked run/source/decision provenance. |
| `/library/prompt-packs` | `ship` | Author, export, benchmark, review prompt packs, and inspect model-comparison judgments. |
| `/library/curator` | `experimental` | Skill-health proposals only; not release automation. |
| `/library/citadel` | `ship` | Stage a Citadel with the Mason and review the drafted Blueprint before connecting accounts or opening Gates. |
| `/library/citadel-overview` | `ship` | Inspect how the active workspace is governed as a Citadel — Charter, Chambers, and Gatehouse posture. |
| `/library/citadel-wards` | `ship` | List, add, and test Gatehouse Wards (deny-wins) for the active Citadel. |
| `/library/citadel-council` | `ship` | Inspect the agents seated in the Citadel by reference to the agents catalog. |
| `/library/citadel-blueprint` | `ship` | Export the active Citadel as a secret-free Blueprint, or validate and import one. |
| `/library/citadel-vault` | `experimental` | Storing and revealing secrets are disabled while the production Vault key is held. Metadata and removal of existing records remain governed. |
| `/ops/boards` | `ship` | Create, select, edit, archive, and restore trusted layouts composed from five compiled Ops summaries; each widget reloads its canonical source and the saved layout is never runtime authority. |
| `/ops/activity` | `ship` | Inspect retained events and Ops attention signals. |
| `/ops/sessions` | `ship` | Inspect session timelines, summaries, and operator evidence. |
| `/ops/schedules` | `ship` | Review scheduler posture and primary governed-work actions. |
| `/ops/improvement` | `experimental` | Improvement loops are experimental replay/self-improvement support. |
| `/ops/notifications` | `ship` | Review runtime issues, self-repair proposals, and follow-up signals. |
| `/ops/approvals` | `ship` | Review pending decisions, replay effects, and approval history. |
| `/ops/costs` | `ship` | Inspect spend visibility and cost evidence. |
| `/ops/quality` | `ship` | Inspect eval proof, prompt-pack gate posture, and read-only trace/report export paths. |
| `/ops/runtime` | `ship` | Inspect gateway health, daemon posture, host vitals, and backups. |
| `/ops/diagnostics` | `ship` | Inspect durable, daemon, admin, docs, and readiness diagnostics. |
| `/ops/kanban` | `experimental` | Multi-agent board is experimental; bulk controls are not final release control. |
| `/settings/general` | `ship` | Configure base defaults. |
| `/settings/providers` | `ship` | Configure credentials and run provider/model smoke evidence with plain failures. |
| `/settings/personalities` | `experimental` | Personality presets are experimental Chat-default polish. |
| `/settings/access` | `ship` | Inspect auth posture, secret storage truth, and access boundaries. |
| `/settings/permissions` | `ship` | Configure permission profiles and local operator override evidence. |
| `/settings/trust-policy` | `ship` | Inspect the unified Trust & Policy matrix, then jump to Permissions, Tools, MCP, Skills, Capabilities, or Approvals for edits. |
| `/settings/budget` | `ship` | Set budget mode and review cost evidence. |
| `/settings/onboarding` | `ship` | Complete Start Here: provider/local path, first Chat task, retained evidence, and Run Detail inspection. |
| `/settings/runtime` | `ship` | Configure runtime posture while experimental sidecars stay labeled. |
| `/settings/local-ai` | `ship` | Inspect local hardware readiness, model-fit recommendations, and approval-gated local model jobs without claiming autonomous installs or mature local inference. |
| `/settings/workspaces` | `ship` | Configure workspace context, guidance, and extension posture. |
| `/settings/integrations` | `ship` | Each visible connector has a setup/action path or explicit blocked/incomplete copy. |
| `/settings/channels` | `ship` | Each visible channel has guided setup with live-auth/send diagnostics or blocked copy. |
| `/settings/mcp` | `ship` | Local stdio, Approval Inbox, and governed remote http/sse no-auth, token-env, and OAuth2 paths are visible; OAuth records show connect/reconnect readiness and fail closed as `needs_auth` when token refs are missing or expired. |
| `/settings/web-search` | `ship` | Firecrawl (hosted or self-hosted), connection test, native search engine order, and Firecrawl, Brave, and Parallel keys save through the governed settings path; keys are live-checked and stored only in the OS keychain, with environment variables as the fallback. |
| `/settings/tools` | `ship` | Inspect tool catalog and scoped allow/deny grants. |
| `/settings/hooks` | `ship` | Create signed metadata-only HTTPS lifecycle hooks, safely test delivery, and inspect durable delivery history without exposing signing secrets or conversation payloads. |

## Held visibility surface — remote-worker Ops and one-Chat activity (HX-507)

HX-507 projection routes, worker inspection, and Chat activity have seeded storage coverage. Live worker data depends on HX-501 admission and listener authority plus HX-502/HX-504 assignment and event composition. Cockpit shows the hold at its experimental worker destination. Classic excludes the held route from the rollback inventory.

- `/ops/workers` (Ops Health page, Remote workers tab) renders the read-only remote-worker registry, detail, assignment, event, reconciliation, and control projections. It never projects `$0`, healthy, clean, completed, or operator-owned from absent evidence; usage/cost (HX-503), resource-cell/cleanup (HX-505), and artifact/effect (HX-506) sections stay explicitly `unavailable`.
- The existing one-Chat `DurableBackgroundTaskRail` gains session/turn-bound remote-worker activity — no second conversation surface, scheduler, listener, state machine, event stream, cost ledger, or approval system. It is read-only; rotation, quarantine, revoke, recovery, cleanup, and reconciliation management remain in Ops.
- Realtime reuses the existing `/api/v1/events` stream with content-free `remote_worker_changed` / `remote_worker_assignment_changed` invalidations; no second SSE channel and no migration are introduced.
