# GoatCitadel Manual QA Test Plan

Last updated: 2026-04-19
Status: draft baseline, grounded in current repo-visible `1.0` surface and runtime seams

## Purpose

This plan is the manual QA checklist for GoatCitadel after a meaningful change set, with special emphasis on:

- visible `1.0` Mission Control surfaces
- runtime truthfulness across Chat, Cowork, Code, Tasks, and Approvals
- approvals, durable runs, live-feed degradation, and recovery behavior
- prompt-pack and quality workflows
- install, auth, backup, restore, and operator safety posture

It is intentionally broader than a smoke test and narrower than "test literally everything in the repo."

## Source anchors

This plan is based on the current codebase and release contract, especially:

- [README.md](../README.md)
- [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md)
- [docs/1_0_RELEASE_EVIDENCE.md](./1_0_RELEASE_EVIDENCE.md)
- [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./CANONICAL_RUNTIME_STATE_MODEL.md)
- [docs/INSTALL_SETUP_TESTING.md](./INSTALL_SETUP_TESTING.md)
- [scripts/verification/lib/release-surface-manifest.mjs](../scripts/verification/lib/release-surface-manifest.mjs)
- [apps/mission-control-next/src/app/MissionControlNextApp.tsx](../apps/mission-control-next/src/app/MissionControlNextApp.tsx)
- [apps/mission-control-next/src/features/native-routes](../apps/mission-control-next/src/features/native-routes)
- [apps/mission-control-next/src/features/threaded-surface](../apps/mission-control-next/src/features/threaded-surface)
- [packages/mission-control-shared](../packages/mission-control-shared)
- [packages/threaded-surface-core](../packages/threaded-surface-core)
- [apps/gateway/src/app.ts](../apps/gateway/src/app.ts)
- [apps/gateway/src/routes/approvals.ts](../apps/gateway/src/routes/approvals.ts)
- [apps/gateway/src/routes/durable.ts](../apps/gateway/src/routes/durable.ts)
- [apps/gateway/src/routes/prompt-packs.ts](../apps/gateway/src/routes/prompt-packs.ts)
- [apps/gateway/src/routes/admin.test.ts](../apps/gateway/src/routes/admin.test.ts)

Compatibility-only legacy Mission Control anchors remain useful for rollback/parity checks, but they are not the canonical 1.0 shell:

- [apps/mission-control/src/content/page-registry.ts](../apps/mission-control/src/content/page-registry.ts)
- [apps/mission-control/src/pages/ApprovalsPage.test.tsx](../apps/mission-control/src/pages/ApprovalsPage.test.tsx)

## How To Use This Plan

Run this in three lanes depending on change size.

### Lane A: Sanity

Use for small UI, docs-backed runtime, or prompt-pack wording changes.

- `SM-*`
- `MC-W-*`
- `MC-O-*`
- `MC-T-*`
- `QL-*`

### Lane B: Regression

Use for gateway, orchestration, approvals, memory, integrations, or route work.

- everything in Lane A
- `AP-*`
- `DR-*`
- `EV-*`
- `INT-*`
- `MEM-*`
- `SEC-*`
- `BK-*`

### Lane C: Release / High-Risk

Use for packaging, auth, durable/recovery, backup, surface-shell, or public-test prep.

- everything in Lane B
- `INST-*`
- `AUTH-*`
- `CLI-*`
- `PKG-*`

## Recommended Test Environments

Run the plan across the smallest environment set that still matches the risk.

1. Local dev stack, loopback, token auth or default local posture
2. Local dev stack with a real provider configured
3. SQLite-backed runtime
4. Postgres-backed runtime or Docker stack when touching backup, cutover, or deployment behavior
5. One mobile-width browser session and one desktop-width browser session for visible surface checks

Optional but useful:

- one degraded or interrupted live-feed session
- one approval-heavy scenario
- one durable recovery scenario

## Evidence To Capture For Every Failure

- exact page or command used
- workspace and surface
- gateway health state
- browser URL including `space`, `page`, `surface`, and `tab` params when relevant
- screenshot or screen recording
- gateway log excerpt
- whether live feed was healthy, degraded, or unavailable
- whether the failure was canonical data, projected UI, or missing evidence

## Entry Checklist

Before running the manual plan:

- confirm the stack starts
- confirm gateway health is `ok`
- confirm Mission Control loads
- note which provider and model are configured
- note whether Code Mode or memory-maintenance feature flags are enabled
- note whether testing is on SQLite or Postgres
- note whether you are running from installer, raw clone, or Docker

## Core Manual Test Cases

### Install And Startup

#### INST-01 Installer or raw-clone startup

- Precondition: clean shell, valid install path or repo clone
- Steps:
  1. Start GoatCitadel using the repo-appropriate command
  2. Open Mission Control
  3. hit gateway health endpoint
- Expected:
  - launcher or dev command starts without path confusion
  - Mission Control becomes reachable
  - `/health` returns `{"status":"ok"}`

#### INST-02 Doctor and onboarding readiness

- Steps:
  1. Run doctor
  2. Open onboarding
  3. complete or advance through onboarding flow
- Expected:
  - doctor surfaces actionable guidance, not silent failure
  - onboarding does not get stuck waiting on unrelated background refreshes
  - onboarding completion returns you to a valid shell route

#### INST-03 Split-stack startup

- Steps:
  1. Start gateway and UI separately
  2. refresh UI while gateway is up
  3. restart gateway and confirm UI recovers
- Expected:
  - shell correctly shows gateway checking, ready, or degraded states
  - no false "healthy" state while gateway is unavailable

### Shell And Navigation

#### SM-01 Release-bearing routes load

- Cover every manifest route:
  - Chat, Cowork, Code, Projects
  - Library: agents, memory, files, prompt packs, artifacts
  - Ops: activity, approvals, runtime, diagnostics, sessions, schedules, improvement, costs
  - Settings: general, providers, workspaces, access, runtime, add-ons, integrations, channels, MCP, tools
- Expected:
  - each route loads via direct URL
  - page label matches the selected route
  - no route falls back to the wrong page silently

#### SM-02 Top-level shell state stays coherent

- Steps:
  1. move across Chat, Cowork, Code, Projects, Library, Ops, and Settings
  2. watch status chips, workspace selector, freshness indicators
  3. open and close command palette
- Expected:
  - shell chrome persists
  - page switch does not reset unrelated state unexpectedly
  - status chips do not imply health or freshness they do not have

#### SM-03 Desktop and mobile shell scanability

- Steps:
  1. run the shell at desktop width
  2. run again at mobile width
  3. switch pages in both
- Expected:
  - compact page picker works on mobile
  - no clipped labels, broken nav, or hidden primary actions
  - no page becomes unusable because secondary nav overflows

### Chat, Cowork, And Code Surfaces

#### MC-W-01 Chat basic thread flow

- Steps:
  1. create a fresh chat session
  2. send a simple message
  3. refresh the page
  4. return to the same session
- Expected:
  - thread persists
  - message history stays attached to the right session
  - session label is stable and readable

#### MC-W-02 Chat slash-command path

- Steps:
  1. in Chat, run a local slash command such as `/help`
  2. run it before setting a cloud provider if possible
- Expected:
  - command path executes without requiring unnecessary provider validation
  - result is shown as a stable thread update, not a broken assistant send

#### MC-W-03 Surface distinction: Chat vs Cowork vs Code

- Steps:
  1. open the same workspace in Chat, Cowork, and Code
  2. compare visible controls, framing, and result behavior
- Expected:
  - Cowork and Code are visibly distinct from Chat
  - the shell and route remain truthful about the active surface
  - surface switch does not silently drop provider/model state

#### MC-W-03A Requested vs effective routing visibility

- Steps:
  1. use a seeded or real fallback scenario where the requested provider/model differs from the effective provider/model
  2. inspect the collapsed thread summary in Chat
  3. open the trace/details view for the same turn
- Expected:
  - requested and effective routing are both visible without relying on tribal knowledge
  - fallback reason is visible when present
  - the effective provider/model is not hidden behind stale requested-model labels

#### MC-W-03B Cowork execution board refresh during active orchestration

- Steps:
  1. open an active Cowork session with orchestration state and at least one checkpoint
  2. let the run advance, or trigger a seeded refresh-worthy update
  3. watch the board without manually reloading the page
- Expected:
  - run/checkpoint state refreshes while Cowork is active
  - visible step state tracks the latest orchestration truth
  - the operator does not need to leave and re-enter Cowork to see progress

#### MC-W-04 Streaming and refresh integrity

- Steps:
  1. trigger a response that streams
  2. switch away and back
  3. refresh after completion
  4. when possible, run a seeded partial-stream failure scenario
- Expected:
  - finalized streamed content is not replaced by stale fetched content
  - sidebar/session rail refreshes when titles change
  - no fabricated "done" event appears after an error path
  - a partial-stream failure does not concatenate a second retry/fallback stream into the same assistant turn

#### MC-W-05 Tasks page

- Steps:
  1. open Tasks from shell nav
  2. navigate from a work surface into Tasks and back
- Expected:
  - task list loads
  - linked sessions and blockers are reachable or visibly absent
  - task counts in the status strip roughly agree with page content

#### MC-W-06 Approvals page baseline

- Steps:
  1. open Approvals with no pending items
  2. open again with at least one pending item
- Expected:
  - empty state is clean and non-broken
  - bulk actions remain visible when relevant
  - pending and history tabs/counts are believable

### Approval And Decision Flows

#### AP-01 Risky action produces visible pending approval

- Steps:
  1. trigger one intentionally risky action
  2. confirm a pending approval appears
  3. inspect details
- Expected:
  - approval appears in the queue and shell indicators
  - preview and payload are inspectable
  - risk level and kind are readable

#### AP-02 Approve path

- Steps:
  1. approve a pending item
  2. watch the queue, detail panel, and any linked surface
- Expected:
  - approval moves out of pending
  - approval history is preserved
  - linked follow-on work is visible as confirmed, pending, or unknown, not guessed

#### AP-02A Approval resolve failure keeps context visible

- Steps:
  1. open a pending approval
  2. trigger or simulate a resolve failure during approve/reject
  3. inspect the modal, row state, and visible error handling
- Expected:
  - the resolve modal stays open on failure
  - the pending row remains visible instead of disappearing optimistically
  - the failure is shown inline with a clear retry path

#### AP-03 Reject path

- Steps:
  1. reject a pending item
  2. inspect history and linked surface
- Expected:
  - rejection is durable
  - no hidden successful follow-on action occurs
  - operator replay still works

#### AP-04 Bulk resolve

- Steps:
  1. create multiple pending approvals
  2. bulk approve or reject
- Expected:
  - bulk action only affects intended rows
  - queue and history update correctly
  - no stale count remains in shell chips after refresh

#### AP-05 Remote approval token flow

- Steps:
  1. generate remote action token for an approval
  2. resolve through remote flow
- Expected:
  - token issuance is explicit
  - remote resolution updates the same canonical approval
  - audit trail or replay remains inspectable

#### AP-06 Expired approvals

- Steps:
  1. use a seeded or expired approval case
  2. inspect pending and history views
- Expected:
  - expired items leave pending queue
  - they remain visible in history with an explicit expired state
  - no approve action is still offered

#### AP-07 Approval replay

- Steps:
  1. open replay for a resolved approval
  2. inspect linkage and history
- Expected:
  - replay is available
  - canonical linkage is preferred over payload scraping when both exist
  - if linkage is missing, UI says so instead of fabricating it

### Durable Runs And Recovery

#### DR-01 Durable diagnostics and run list

- Steps:
  1. open durable diagnostics or an equivalent operator path
  2. inspect run list and one run detail
- Expected:
  - runs list loads
  - run status is readable
  - timeline or checkpoints are available when expected

#### DR-02 Pause and manual resume

- Steps:
  1. create a durable run that can be paused
  2. pause it
  3. resume it manually
- Expected:
  - paused state is explicit
  - resume requires an operator action
  - state does not silently jump from paused to running due to unrelated events

#### DR-03 Paused vs waiting truthfulness

- Steps:
  1. exercise one paused case and one waiting-for-event/approval case
  2. inspect operator wording in both
- Expected:
  - paused and waiting are distinguished
  - waiting may auto-wake only when that is true
  - paused never implies automatic continuation

#### DR-04 Approval resolves while run is paused

- Steps:
  1. create or seed a paused run linked to an approval
  2. resolve the approval
  3. inspect run and approvals views
- Expected:
  - approval may become resolved
  - run remains paused unless explicitly resumed
  - operator wording states that downstream effect is unresolved or skipped, not "all done"

#### DR-05 Wake failure or partial follow-on visibility

- Steps:
  1. simulate or seed an approval-resolved / follow-on-unconfirmed state
  2. inspect run timeline, approvals page, and live feed
- Expected:
  - canonical approval state remains truthful
  - downstream effect status is separate
  - no page collapses the whole chain into success

#### DR-06 Dead-letter and recovery path

- Steps:
  1. use seeded dead-letter durable scenario if available
  2. inspect dead-letter entry
  3. recover it
- Expected:
  - dead-letter visibility is explicit
  - recovery action is operator-visible
  - result becomes resumed, retried, or remains blocked with a clear reason

#### DR-07 Recovery after restart

- Steps:
  1. start a resumable flow
  2. restart the gateway
  3. inspect post-restart state
- Expected:
  - durable state survives restart
  - Mission Control reflects recovery truth
  - no orphaned "running" fiction remains if the run is really waiting, paused, or failed

### Realtime Events, Timeline, And Staleness

#### EV-01 Timeline page

- Steps:
  1. open Ops -> Activity
  2. inspect activity, scheduler, and sessions variants if available
- Expected:
  - event summaries are human-readable
  - raw payload is secondary, not the main UI
  - timeline does not require tribal knowledge to interpret

#### EV-02 Live-feed degradation banner

- Steps:
  1. interrupt SSE or use a degraded stream scenario
  2. watch shell and timeline status
- Expected:
  - UI shows degraded live updates
  - fallback guidance is explicit
  - counts and actions do not overstate freshness

#### EV-03 Canonical vs projected truth

- Steps:
  1. inspect a case where live-feed hints and canonical linkage differ
  2. compare Approvals, Timeline, and any linked live lane
- Expected:
  - canonical truth is labeled as such
  - projected or inferred relationships are not shown as facts
  - missing linkage is admitted plainly

### Ops And Library Pages

#### MC-O-01 Health page

- Steps:
  1. open Ops -> Runtime
  2. inspect runtime, spend, and backup summaries
- Expected:
  - runtime and spend summaries load
  - backup state is visible when supported
  - no summary claims spend certainty if only token usage exists

#### MC-O-02 Artifacts page

- Steps:
  1. open Artifacts -> Memory
  2. switch to Files
- Expected:
  - both memory and file views load from the same shell area
  - switching tabs does not reset the route incorrectly
  - files and memory each have their own empty state when applicable

#### MC-O-03 Quality page baseline

- Steps:
  1. open Quality
  2. inspect prompt-pack list/report/benchmark entrypoints
- Expected:
  - Quality page is centered on Prompt Lab
  - the page can reach runs, reports, and trend-like outputs
  - no obviously dead controls remain visible

### Prompt Lab And Prompt-Pack QA

#### QL-01 Import and source labeling

- Steps:
  1. import a prompt pack
  2. inspect pack name and source label
- Expected:
  - imported pack is visible
  - source label is readable
  - pack identity is stable across reload

#### QL-02 Single test run

- Steps:
  1. run one prompt-pack test manually
  2. inspect status and output
- Expected:
  - run starts and completes or fails explicitly
  - result does not disappear on refresh
  - failure is not misreported as pass

#### QL-03 Human review and scoring

- Steps:
  1. review one run
  2. apply manual score or verdict
  3. reload
- Expected:
  - review persists
  - score and notes are visible in report surfaces
  - override behavior is explicit

#### QL-04 Auto-score path

- Steps:
  1. auto-score one test or a small batch
  2. inspect report and trends
- Expected:
  - auto-score result is attributed to auto-score, not mistaken for human review
  - report and trends update without duplication

#### QL-05 Benchmark matrix

- Steps:
  1. run a small benchmark across multiple providers/models
  2. inspect status and final output
- Expected:
  - benchmark status is queryable
  - matrix output stays attached to the correct run id
  - incomplete model/provider legs do not get silently smoothed into success

#### QL-06 Replay regression

- Steps:
  1. run replay regression on a pack
  2. inspect status and output
- Expected:
  - replay run is visible as replay, not a normal single run
  - status surfaces remain truthful about baseline and new result

#### QL-07 Export and reset

- Steps:
  1. export a pack
  2. reset with safe flags
  3. confirm outcome
- Expected:
  - export path works
  - reset honors flags and does not silently wipe more than requested
  - no-op reset returns a no-op result

#### QL-08 Post-rerun review pass

- Use this after your next prompt-pack rerun.
- Review every new or changed failing result and confirm:
  - failure text is specific
  - the prompt output contract was followed
  - false passes and false fails are called out
  - result interpretation in Quality matches the raw run evidence

### Settings Pages

#### MC-T-01 General settings

- Steps:
  1. open Settings -> General
  2. inspect provider, access, budget, and onboarding tabs if visible
- Expected:
  - tab routing is stable
  - changing tabs does not lose in-progress state unnecessarily
  - settings controls are understandable

#### MC-T-02 Runtime page

- Steps:
  1. open Settings -> Runtime
  2. inspect runtime-specific controls and health
- Expected:
  - runtime status loads
  - local/runtime controls do not show broken placeholders

#### MC-T-03 Workspaces

- Steps:
  1. switch workspaces from shell selector
  2. open Settings -> Workspaces
  3. inspect workspace-specific state
- Expected:
  - workspace switch is reflected in page content
  - workspace-specific settings do not leak across workspaces silently

#### MC-T-04 Integrations overview

- Steps:
  1. open Settings -> Integrations
  2. inspect visible entries
- Expected:
  - guided vs manual-only setup truth is visible
  - blocked entries appear blocked, not runnable
  - runnable beta entries expose real actions

#### MC-T-05 MCP page

- Steps:
  1. open MCP tab
  2. inspect configured transports or servers
- Expected:
  - MCP gets a dedicated page, not a broken shared fallback
  - connection state is visible

#### MC-T-06 Tools page

- Steps:
  1. open Settings -> Tools
  2. inspect grants, permissions, and policy posture
- Expected:
  - tool access state is readable
  - dangerous or gated behavior is explicit

#### MC-T-07 Agents page

- Steps:
  1. open Library -> Agents
  2. inspect herd live, herd lab, and skills if visible
- Expected:
  - agent roster/office surfaces load
  - skills surface is distinct and reachable
  - no active/runtime counters in shell disagree wildly with Agents page without a stale warning

### Auth, Access, And Security Posture

#### AUTH-01 Token-auth startup

- Steps:
  1. run with token auth enabled
  2. open Mission Control without token/bootstrap
  3. then authenticate correctly
- Expected:
  - unauthenticated access is blocked cleanly
  - authenticated path succeeds
  - shell does not enter a half-ready state

#### AUTH-02 Browser mutation intent protection

- Steps:
  1. trigger a browser-origin mutating request through the app
  2. attempt equivalent request without required browser intent header if possible
- Expected:
  - valid app path succeeds
  - invalid browser-origin mutation path is rejected

#### AUTH-03 Remote approval create restrictions

- Steps:
  1. attempt non-loopback approval creation without override flag
  2. repeat with explicit break-glass flag if relevant
- Expected:
  - non-loopback create is blocked by default
  - override behavior is explicit, not silent

#### SEC-01 Tool risk posture

- Steps:
  1. invoke a safe tool path
  2. invoke a risky tool path
  3. inspect approval behavior
- Expected:
  - risky path is gated
  - safe path is not over-gated
  - tools page and approval pages agree on what happened

#### SEC-02 Path-jail and backup path safety

- Steps:
  1. try a traversal-like backup verify or restore file path
  2. inspect response
- Expected:
  - traversal is rejected before dangerous work starts
  - error is explicit and operator-readable

### Backup, Restore, And Recovery

#### BK-01 Backup create and list

- Steps:
  1. create a backup
  2. list backups
- Expected:
  - backup creation succeeds
  - list shows the new archive
  - operator can identify backup path and id

#### BK-02 Backup verify

- Steps:
  1. verify a good backup
  2. inspect verify result
- Expected:
  - result includes integrity truth
  - result includes `contractVerified`-style minimum-set truth when applicable

#### BK-03 Live restore is blocked

- Steps:
  1. attempt restore through live admin route
- Expected:
  - route returns offline restore requirement
  - CLI hint is shown
  - no live mutation occurs

#### BK-04 Offline restore runbook

- Steps:
  1. stop active runtime
  2. run offline CLI restore
  3. restart and inspect state
- Expected:
  - restore only happens offline
  - restored runtime starts cleanly

#### BK-05 Database cutover and verify

- Steps:
  1. run cutover dry-run or verify flow
  2. inspect counts and issues
- Expected:
  - cutover/verify outputs are readable
  - source and target counts make sense

### Integrations And Ecosystem

#### INT-01 Channel setup truthfulness

- Steps:
  1. inspect channel setup page or integrations channels tab
  2. compare guided and manual channels
- Expected:
  - guided rollout channels are distinct from manual-only channels
  - unsupported or blocked channels do not look runnable

#### INT-02 Visible integration actions

- Steps:
  1. inspect one visible non-channel integration entry
  2. attempt a real operator action if configured
- Expected:
  - visible actions correspond to real runtime handlers
  - failure mode is operationally readable

#### INT-03 Webhook and connector diagnostics

- Steps:
  1. inspect connector diagnostics/status surfaces
  2. if configured, send a small safe action
- Expected:
  - runtime status is normalized and readable
  - no "diagnostics only" shell remains for a visible runnable integration

### Memory, Artifacts, And Context

#### MEM-01 Memory list and maintenance visibility

- Steps:
  1. open Artifacts -> Memory
  2. inspect list, policy, maintenance, and history if enabled
- Expected:
  - memory content loads
  - maintenance controls obey feature flags
  - learned memory is not shown where there is nothing to review

#### MEM-02 Workspace scope separation

- Steps:
  1. switch workspaces
  2. inspect memory and chat context behavior
- Expected:
  - workspace-scoped memory does not leak silently
  - operator can tell which workspace they are looking at

### CLI, TUI, And Operator Commands

#### CLI-01 TUI launch and live feed

- Steps:
  1. launch TUI
  2. inspect live feed and a few views
- Expected:
  - TUI starts
  - malformed SSE or degraded feed is surfaced, not swallowed
  - mutating actions are blocked in read-only posture when appropriate

#### CLI-02 Admin and tools commands

- Steps:
  1. run a few read paths such as tools catalog and backup list
  2. run one safe admin verification path
- Expected:
  - commands work against the live runtime
  - output is operator-usable

### Packaging And Deployment

#### PKG-01 Docker local stack

- Steps:
  1. start Docker compose stack
  2. confirm UI and health endpoints
  3. inspect auth posture
- Expected:
  - stack starts
  - Mission Control and health endpoints match docs
  - auth and origin warnings are sane

#### PKG-02 Non-loopback warning posture

- Steps:
  1. configure non-loopback bind in a safe test environment
  2. inspect startup warnings and behavior
- Expected:
  - unsafe non-loopback posture is blocked or loudly warned
  - break-glass flags are never implied as normal operation

## Optional / Experimental Checks

These are useful when touching optional subsystems, but they are not part of the core `1.0` release bar.

### OPT-01 Voice runtime

- install/select/remove managed voice models
- start talk or wake only when runtime posture allows it

### OPT-02 NPU sidecar

- only test when touching local inference experiments
- treat as optional infrastructure, not release proof

### OPT-03 Office / visual specialist surfaces

- run only if changes touched office, herd live/lab, or related assets

## Exit Criteria

The manual pass is good enough to sign off when:

- all required lane cases pass
- no visible primary surface is broken, misleading, or half-wired
- approvals, durable status, and live-feed state remain truthful under normal and degraded conditions
- backup and restore posture remains safe
- prompt-pack quality surfaces reflect real run evidence instead of optimistic summaries

## Follow-On After The Next Prompt-Pack Rerun

After you rerun the prompt pack, add a focused appendix or pass/fail table with:

- failing prompt ids
- whether the failure was real, vague, flaky, or mis-scored
- manual product surfaces touched by that failure
- whether the issue was UI wording, API truth, orchestration behavior, or evaluation/reporting logic

That appendix should drive the next targeted manual regression subset instead of rerunning this entire plan blindly.
