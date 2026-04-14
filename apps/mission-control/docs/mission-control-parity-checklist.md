# Mission Control Parity Checklist

This checklist tracks the UI/platform rewrite while preserving Mission Control behavior, route compatibility, and backend contracts.

Last updated: 2026-04-13

## Platform migration

- [x] Move Mission Control to React 19 / React DOM 19.
- [x] Install Tailwind CSS v4 and wire it through Vite.
- [x] Add `components.json` and app-local shadcn ownership under `src/components/ui`.
- [x] Keep the rewrite isolated to `apps/mission-control`.
- [x] Preserve clean backend and gateway contracts.

## Theme and preference continuity

- [x] Preserve `signal-noir` and `citadel-light`.
- [x] Preserve UI density preference wiring.
- [x] Preserve reduced-motion behavior and effects mode wiring.
- [x] Preserve nav rail mode and detail panel preference persistence.
- [x] Preserve active workspace persistence.

## Route graph parity

### Work

- [x] `/operate/surface?surface=chat`
- [x] `/operate/surface?surface=cowork`
- [x] `/operate/surface?surface=code`
- [x] `/operate/tasks`
- [x] `/operate/approvals`

### Observe

- [x] `/observe/activity?tab=activity`
- [x] `/observe/activity?tab=scheduler`
- [x] `/observe/activity?tab=improvement`
- [x] `/observe/sessions`
- [x] `/observe/artifacts?tab=memory`
- [x] `/observe/artifacts?tab=files`
- [x] `/observe/costs`
- [x] `/observe/system`
- [x] `/observe/quality`

### Tune

- [x] `/configure/settings?tab=general`
- [x] `/configure/settings?tab=providers`
- [x] `/configure/settings?tab=access`
- [x] `/configure/settings?tab=budget`
- [x] `/configure/settings?tab=runtime`
- [x] `/configure/settings?tab=workspaces`
- [x] `/configure/settings?tab=addons`
- [x] `/configure/settings?tab=onboarding`
- [x] `/configure/integrations?tab=overview`
- [x] `/configure/integrations?tab=channels`
- [x] `/configure/integrations?tab=mcp`
- [x] `/configure/tools`
- [x] `/configure/agents?tab=overview`
- [x] `/configure/agents?tab=herd-live`
- [x] `/configure/agents?tab=herd-lab`
- [x] `/configure/agents?tab=skills`

## Legacy redirect parity

- [x] `dashboard` -> work chat
- [x] `chat` -> work chat
- [x] `assembly` -> cowork
- [x] `tasks` -> tasks
- [x] `approvals` -> approvals
- [x] `activity` -> observe activity
- [x] `cron` -> observe scheduler
- [x] `improvement` -> observe improvement
- [x] `sessions` -> observe sessions
- [x] `memory` -> artifacts memory
- [x] `files` -> artifacts files
- [x] `costs` -> observe costs
- [x] `system` -> observe system
- [x] `promptLab` -> quality
- [x] `settings` -> tune general
- [x] `workspaces` -> tune workspaces
- [x] `addons` -> tune addons
- [x] `onboarding` -> tune onboarding
- [x] `mesh` / `npu` -> tune runtime
- [x] `integrations` / `channels` / `mcp` -> integrations tabs
- [x] `agents` / `skills` / `office` / `officeLab` -> agents tabs

## Shared workflow parity

- [x] Workspace switching remains shell-level and persisted.
- [x] Approval counts and approval route jump stay available from the shell.
- [x] Gateway access gating stays in front of the shell when access is not ready.
- [x] Notifications remain visible in the main workspace region.
- [x] Detail panel availability, open state, and pinning remain intact.
- [x] Existing lazy page loading and error boundaries remain intact.

## Work surface parity

- [x] Chat, Cowork, and Code still share the same Mission Control route entry.
- [x] Existing session, turn, queue, retry, edit, and approval orchestration remains in GoatCitadel hooks/controllers.
- [x] Transcript rendering is now backed by assistant-ui primitives while preserving Mission Control actions.
- [x] Pending approval interruption, run details, and branch switching remain attached to turns.

## Operator surface parity

- [x] Panels, tabs, empty states, selects, switches, dialogs, and segmented controls now route through the GoatCitadel wrapper layer.
- [x] Observe and Tune hubs remain distinct instead of being collapsed into a single dashboard.
- [x] Runtime, integrations, tools, agents, memory, files, quality, and health remain first-class destinations.

## Validation gates

- [x] `pnpm --filter @goatcitadel/mission-control typecheck`
- [ ] `pnpm --filter @goatcitadel/mission-control test`
- [ ] `pnpm --filter @goatcitadel/mission-control build`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm -r build`

## Manual verification targets

- [ ] Shell navigation and surface switching
- [ ] Session selection, send, stream, stop, retry, and edit flows
- [ ] Inline approvals and modal approvals
- [ ] Runtime, integrations, tools, and agent specialist panels
- [ ] Theme switching and reduced-motion parity
