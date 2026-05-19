# Mission Control Next Legacy Audit

Updated: 2026-04-22

Historical note: this audit captures the April legacy-shell replacement pass. The current `mission-control-next`
release-surface manifest has since grown to include additional native Library, Ops, and Settings routes; use
`scripts/verification/lib/release-surface-manifest.mjs` and `src/app/route-model.ts` for the live route list.

## Why this exists

`mission-control-next` was still acting mostly as a shell around lazy-loaded pages from `apps/mission-control/src/pages`. That meant the new IA and shell kept inheriting:

- old page chrome
- old density assumptions
- old CSS tokens
- legacy tab and split-pane behaviors

## Legacy dependency map before this pass

| Route family | Previous source |
| --- | --- |
| `chat`, `cowork`, `code` | `ChatPage` |
| `cowork/tasks` | `TasksPage` |
| `cowork/board` | `AgentsBoardPage` |
| `library/agents`, `library/skills` | `AgentsHubPage` |
| `library/memory`, `library/files`, `library/artifacts` | `ArtifactsPage` |
| `library/knowledge` | `MemoryPage` |
| `library/prompt-packs` | native `PromptPacksWorkbenchPage` |
| `ops/activity`, `ops/sessions`, `ops/schedules`, `ops/improvement` | `TimelinePage` |
| `ops/approvals` | `ApprovalsPage` |
| `ops/costs`, `ops/runtime` | `HealthPage` |
| `library/prompt-packs` | native `PromptPacksWorkbenchPage` |
| `settings/general`, `settings/providers`, `settings/access`, `settings/budget`, `settings/onboarding`, `settings/permissions`, `settings/personalities` | `GeneralHubPage` / native settings panels |
| `settings/runtime` | `RuntimeHubPage` |
| `settings/workspaces`, `settings/addons` | `WorkspacesHubPage` |
| `settings/integrations`, `settings/channels`, `settings/mcp` | `IntegrationsHubPage` |
| `settings/tools` | `ToolsPage` |

## Replaced in this pass

These routes now render next-native route pages from `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx`:

- `library/agents`
- `library/skills`
- `library/memory`
- `library/knowledge`
- `library/files`
- `library/artifacts`
- `library/capabilities`
- `library/curator`
- `ops/activity`
- `ops/sessions`
- `ops/schedules`
- `ops/improvement`
- `ops/approvals`
- `ops/costs`
- `ops/runtime`
- `ops/diagnostics`
- `ops/kanban`
- `ops/notifications`
- `settings/general`
- `settings/providers`
- `settings/access`
- `settings/budget`
- `settings/onboarding`
- `settings/permissions`
- `settings/personalities`
- `settings/runtime`
- `settings/workspaces`
- `settings/addons`
- `settings/integrations`
- `settings/channels`
- `settings/mcp`
- `settings/tools`

## Threaded routes after this pass

These surfaces now render next-native route markup through `MissionThreadedControllerHost` in `@goatcitadel/threaded-surface-core`:

- `chat`
- `cowork`
- `code`

`cowork/tasks` and `cowork/board` are already next-native route pages.

## Final shared package boundary

The remaining cross-app reuse now lives behind package entrypoints only:

- `@goatcitadel/threaded-surface-core` owns the renderer-agnostic threaded controller and view-model contract consumed by both Mission Control apps
- `@goatcitadel/mission-control-shared` owns the shared API/runtime/state primitives and the small set of cross-app UI building blocks still shared by both apps
- `mission-control-next` no longer imports `apps/mission-control/src/*` at runtime or build time
- `packages/threaded-surface-core` and `packages/mission-control-shared` no longer import `apps/mission-control/src/*`
- the current app keeps its existing visual wrappers as a rollback path, but now consumes the same package-level controller/runtime layers instead of acting as the source tree for `mission-control-next`

That means the remaining reuse is package-scoped and intentional rather than app-to-app coupling.

## Remaining follow-on work

1. Keep shrinking `@goatcitadel/mission-control-shared` toward only clearly stable cross-app primitives as more Library/Ops/Settings surfaces go fully next-native.
2. Expand unit coverage around the headless threaded controller and shared runtime helpers.
3. Continue replacing shared leaf components with next-native equivalents when that improves product UX rather than package topology.
