# Runtime Repair Sweep

Last updated: 2026-11-27

Status: **design draft; Phase 0 (detect-only) in progress.** The detect-only sweep described under [Phase 0 as Built](#phase-0-as-built) is implemented on a branch but not merged or proven in a live install. Nothing else in this document is shipped behavior. It must not be cited as a product claim until the phases below land with their named proof.

## Purpose

GoatCitadel already recovers from many failures on its own, but each recovery lives inside one owner and runs only when that owner happens to look. Nothing watches *across* owners for work that has fallen between them: a run waiting on an approval that no longer exists, an approval that was answered but whose run never woke, a dead-lettered run whose cause was a five-minute provider outage, or a Gateway that has stopped answering at all.

The Runtime Repair Sweep is a Gateway background job that finds those stuck states, fixes the ones that have a known, safe, pre-written fix, and turns everything else into a visible proposal or report. A small watchdog outside the Gateway restarts the Gateway itself when it dies.

## Relationship to Existing Repair Work

This design extends, and must not compete with, [Governed Self-Configuration and Self-Repair](./GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md).

| | Governed self-configuration | Runtime Repair Sweep |
|---|---|---|
| Trigger | A typed blocker on a Chat turn, or an operator request | A periodic sweep that finds stuck runtime state nobody is looking at |
| Typical problem | Missing credential, invalid config, missing managed dependency | Orphaned waits, unresumed runs, transient dead letters, invisible approvals |
| Mutation owner | `GovernedRemediationCoordinator` with allowlisted recipes | The existing owner's own API (durable runs, approvals, channel delivery); anything beyond that is handed to the coordinator |

The sweep **detects and routes**. It never becomes a second repair engine. Any fix that changes configuration, a service, a dependency, or a credential is created as a remediation through the coordinator and its Change Plan, never applied by the sweep directly.

The existing `doctor` (`apps/gateway/src/doctor/`) is an operator-run CLI/TUI install check. The sweep is a different thing and should not reuse the name in operator copy.

## What Already Exists

| Mechanism | Owner | What it covers |
|---|---|---|
| Answer recovery ladder | `chat-agent-answer-recovery.ts` | Empty, reasoning-only, or limit-hit turns re-ask the model for a visible answer |
| Tool-call repair | `chat-agent-tool-call-repair.ts` | Malformed or misnamed tool calls |
| Global circuit breaker | `chat-tool-loop.ts`, `chat-agent-budget.ts` | Stops a turn after repeated tool failures |
| Lease reclaim | `durable-run-service.ts` | Runs whose worker died are reclaimed; after `DURABLE_LEASE_RECLAIM_LIMIT` (8) reclaims they are finalized instead of requeued |
| Recovery state projection | `deriveDurableRunOperationalState` | Labels runs `reclaimable`, `reclaiming`, `retry_budget_exhausted`, `dead_lettered`, `incomplete_worker_exit` |
| Operator recovery routes | `routes/durable.ts` | `POST /api/v1/durable/runs/:runId/resume`, `POST /api/v1/durable/dead-letters/:entryId/recover` (operator-only, manual) |
| Approval expiry | `approval-lifecycle-service.ts`, `approval-resolution-effects-service.ts` | Pending approvals past expiry are reconciled about every second by `system:approval-expiry` |
| Channel delivery approval parking | `channel-delivery-approval-recovery.ts` | Deliveries pause for an approval and resume through the part/attempt fence |
| Background scheduler | `background-scheduler.ts` | Non-overlapping, failure-isolated, shutdown-aware recurring jobs |
| Docker restart | `docker-compose.yaml` | `restart: unless-stopped` on the Gateway and Postgres services |

What is missing:

- nothing correlates state across owners (approvals ↔ durable waits ↔ sessions ↔ channel deliveries);
- dead letters and exhausted runs are only recovered when an operator finds them and calls the route by hand;
- recovery activity has no single operator-visible record ("what did GoatCitadel fix for itself this week?");
- the native Windows host launches the Gateway but does not appear to restart it after a crash (confirm in `LauncherService.cs` / `RuntimeStatusService.cs` before building).

## Three Tiers

1. **In-turn recovery** (exists). Fixes inside a single Chat turn. Unchanged by this design.
2. **Runtime Repair Sweep** (new, inside the Gateway). Finds and fixes stuck state across owners while the Gateway is healthy.
3. **Outside watchdog** (new for native Windows; Docker already has it). Restarts the Gateway when it is down or not answering. A process cannot restart itself once it is dead, so this is the only part that must live outside the Gateway.

## Sweep Model

The sweep runs as one more `startBackgroundInterval` job in `GatewayService`, inside `tryRunWithSharedHostWork` so it respects shared-host admission. Each tick runs a fixed list of **detectors**. A detector reads owner state and emits **findings**. A finding is matched to at most one **recipe**.

### Finding

A durable, secret-free record:

- `findingId`, `detectorId`, `detectorVersion`;
- `subject`: typed references only (`runId`, `approvalId`, `sessionId`, `deliveryId`, `workspaceId`), never payloads;
- `fingerprint`: detector ID plus subject IDs, so the same problem seen on every tick is one finding, not many;
- `firstSeenAt`, `lastSeenAt`, `seenCount`;
- `state`: `observed | repairing | repaired | proposed | manual_required | suppressed | cleared`;
- `recipeId`, `recipeVersion`, attempt count, and the last sanitized outcome.

A finding clears on its own when a later tick no longer sees the condition, whether or not the sweep fixed it.

### Recipe

Each recipe is code written ahead of time, never model-authored:

1. **Precondition**: re-read the owner's live state at apply time and stop if anything changed since detection (status, revision, lease owner, approval resolution).
2. **Action**: one call to the owner's existing API. The sweep holds no write path of its own into storage.
3. **Verify**: re-read owner state and confirm the intended transition happened.
4. **Budget**: maximum attempts per subject, cool-down between attempts, and what to do when the budget runs out (always: stop and report).

If a recipe cannot state all four, the finding is `manual_required`.

## Action Tiers

| Tier | When | Examples | Operator involvement |
|---|---|---|---|
| **A: Automatic** | Idempotent plumbing through an existing owner API that grants no new authority and repeats nothing the operator did not already ask for | Wake a waiting run whose approval is already resolved; resume a dead-lettered run once when its recorded cause is classified transient (rate limit, timeout, provider 5xx) | None. Recorded in the repair log. |
| **B: Proposed** | Anything that changes config, restarts a service, re-sends an external side effect, or retries a run that already used its automatic attempt | Restart an owned service; recover a dead letter whose cause is not transient; re-deliver a channel message | One-click approval in place, details on demand; created as a remediation through `GovernedRemediationCoordinator` |
| **C: Report** | No safe fix exists, or the fix is a human decision | An approval nobody can see; a run finalized after 8 reclaims; a crash loop | Shown in the repair log with the next safe action |

Tier A must never cover an action with an external side effect that could happen twice. Re-entering durable execution is allowed only where durable replay already guarantees that settled effects are not repeated.

## Candidate Detectors

Phase 0 runs these in detect-only mode. Which ones get recipes depends on what Phase 0 actually finds; none is known to be a live bug today.

| Detector | Condition | Proposed tier |
|---|---|---|
| `approval.resolved-wait-not-woken` | Approval is resolved, but its `approval.wait` durable run is still `waiting` after a grace period | A: wake the wait run through the durable owner |
| `approval.wait-orphaned` | An `approval.wait` run references an approval that no longer exists | A: settle the wait run as failed with a clear reason so its parent sees it |
| `approval.invisible` | A pending approval is linked without a workspace and is not install-wide, so it shows in no Inbox | C at first; later B (surface it install-wide) once the Inbox owner supports it |
| `approval.expiry-lagging` | A pending approval is well past expiry and the 1-second reconcile has not settled it | C: this means the expiry owner is unhealthy; report, do not resolve |
| `durable.dead-letter-transient` | Dead-lettered run whose recorded cause is classified transient | A once per run, then B |
| `durable.reclaim-exhausted` | Run finalized after reaching the reclaim limit | C: crash loop; attach the last errors |
| `durable.waiting-too-long` | Run `waiting` on an event key far past its `timeoutMs` | C, then a recipe per workflow key if a pattern appears |
| `channel.delivery-parked-too-long` | Delivery parked for approval past its window, with the approval already settled | A: resume through the part/attempt fence; B if it would re-send a part |

## Hard Rules

These are not tunable:

- The sweep **never resolves an approval**: not approve, deny, edit, or expire. Expiry stays with `system:approval-expiry`. The sweep may only wake work after a human or the existing expiry owner has resolved it, or report.
- The sweep never changes deny-wins policy, approval requirements, auth, path jails, network allowlists, tool grants, or capability activation.
- The sweep never kills a process it cannot prove it owns.
- The sweep never edits source, installed binaries, or runtime files directly. Source repair stays with governed Code Mode plus review; binary repair stays with the signed updater.
- A model never chooses, writes, or reports the result of a recipe.

## Guardrails

- **Feature flag**: `runtimeRepairSweepV1Enabled`, registered with the other settings flags (`packages/contracts/src/config-schemas.ts`, `change-plan.ts`). Detect-only can run without it; Tier A actions require it.
- **Budgets**: per-subject attempts (default 1 for Tier A), a per-recipe hourly cap, and a global hourly action cap. Reaching a cap stops all automatic actions for the rest of the window and records a single finding saying so.
- **Flap detection**: a subject repaired and then broken again more than twice becomes `manual_required` and is never auto-repaired again.
- **Audit**: every action is recorded with actor `system:repair-sweep`, detector, recipe, subject references, preconditions checked, and the verify result. Nothing secret-bearing.
- **Kill switch**: turning the flag off stops actions on the next tick and lets in-flight recipe calls finish; the next tick takes no new action.
- **Deployment profile**: Tier A enabled for `local_dev` and `trusted_local`; `remote_hardened` is detect-only until reviewed.
- **Tick cost**: bounded queries with limits; a tick that would scan more than its limit records a finding instead of scanning everything.

## Outside Watchdog (Native Windows)

The Windows host is the natural supervisor because it already launches the Gateway and polls runtime status.

- Restart the Gateway when authenticated readiness fails N times in a row (for example 3 checks, 10 seconds apart), using the same launcher path the host uses at startup.
- Back off between restarts (for example 5 s, 30 s, 2 min). After 3 restarts within 10 minutes, stop, show a tray notification with the last startup error, and leave the Gateway down. Never loop.
- Restart only a Gateway the host can prove it owns (process identity and lease), matching the "GoatCitadel-owned service" class in the governed self-configuration doc.
- Record each restart where the Gateway can read it after boot, so the sweep's repair log shows "restarted by the desktop host at 14:02 after 3 failed health checks."

Docker already restarts the container (`restart: unless-stopped`). Under Docker, the remaining work is only to make restarts visible in the repair log.

## What Cannot Repair Itself

Self-repair changes runtime state, configuration, and data. It never changes shipped code. In a packaged install that includes the Gateway's JavaScript as well as the native host, so every code defect needs a rebuilt release and an update. That ranks the code by how costly its bugs are:

1. **The update path** (`DesktopUpdateService` and its handoff, verifier, and store). Every other shipped defect is fixed through it, so it must keep working even when the Gateway cannot start. It gets the strictest review, the widest test coverage, and no dependency on Gateway health.
2. **Code that runs when nothing else does**: the native Windows host, the launcher, and the watchdog. A defect here can leave the operator with nothing that can recover.
3. **The Gateway and everything else**: still shipped code, but the sweep, the coordinator, and the watchdog can contain its failures until an update lands.

Design consequences:

- The watchdog stays small and simple: health check, bounded restart, give up, notify. It makes no repair decisions. Anything smarter belongs in the Gateway sweep.
- Watchdog thresholds (check count, interval, backoff, give-up window) are read from a settings file with safe built-in defaults, so they can be tuned without a rebuild. An invalid file falls back to the defaults; it never disables the watchdog or makes it more aggressive.
- Recipe behavior that is likely to need tuning, such as budgets, grace periods, and which dead-letter causes count as transient, lives in configuration validated by schema, not in constants.
- New logic in the native host needs a reason it cannot live in the Gateway.

## Operator Surface

Following progressive disclosure:

- **Ops › Repairs** (new section): a short list of what was fixed, proposed, or needs a person, newest first, with plain-language subjects ("A chat reply was stuck waiting for an approval you already gave. It was resumed."). Details on demand.
- **Inbox**: only Tier B proposals, as one-click approvals in place.
- **Chat**: when a finding involves the current session, a small inline status on the affected turn. No new chat messages.
- No raw JSON as the primary view.

## Out of Scope for v1

- **Fixing code when an error appears.** That requires a coding agent working on source. A later phase may turn a recurring Gateway error signature into a proposed governed Code Mode run or a draft issue, always reviewed. Never automatic.
- Delegated child-to-parent repair, which stays blocked on the same follow-on as the governed self-configuration doc.
- Repairs needing secrets; those go through the coordinator's secure-input path.

## Rollout

| Phase | Scope | Exit proof |
|---|---|---|
| 0 | Detect-only sweep, findings in the `runtime_repairs` audit stream, read-only route, Ops › Repairs read-only list | Focused gateway tests per detector and a real-SQLite test; a live check on SQLite and PostgreSQL installs; a week of real findings reviewed by the owner |
| 1 | Tier A recipes for the detectors Phase 0 showed are real, with budgets, flap detection, audit, and the flag | Per-recipe tests including precondition drift and double-tick races; `verify:durable:recovery`; `verify:runtime:truth` |
| 2 | Windows host watchdog plus restart records | `verify:desktop`; a packaged-install kill test showing restart, backoff, and give-up |
| 3 | Tier B proposals through `GovernedRemediationCoordinator` and Change Plans | Coordinator tests; rendered Inbox check of the one-click approval |

## Phase 0 as Built

Phase 0 differs from the general model above in these deliberate ways:

- **Storage.** Findings are not a new table. Each transition (`finding_observed`, `finding_cleared`) is one record in a new `runtime_repairs` audit stream, which works unchanged on SQLite (a JSONL file) and PostgreSQL (`audit_events`, which has no stream-name constraint). Open findings and their `seenCount` live in memory and are rebuilt from the newest 1,000 stream records on the first tick after a restart. A dedicated table with revisioned state arrives in Phase 1, when recipes need compare-and-swap.
- **States.** Only `observed` and `cleared` exist. A finding is cleared only when its check read its whole source and no longer reports it. If the source could not be read, or the read hit its limit, the finding stays open: a newest-first slice can push a still-stuck item out of view.
- **Detectors.** Six ship: `approval.resolved-wait-not-woken`, `approval.wait-orphaned`, `approval.no-inbox`, `approval.expiry-lagging`, `durable.dead-letter` (transient or not), and `durable.reclaim-exhausted`. `durable.waiting-too-long` and `channel.delivery-parked-too-long` are deferred: neither has a cheap bounded read today, and an approval wait legitimately lasts until its approval expires.
- **Reads.** Every source is a bounded owner query (500 waiting runs, 200 approval waits, 200 pending approvals, 100 expired-pending approvals, 200 dead letters, 200 most recent runs). A detector whose source hit its limit reports `truncated`.
- **Cadence and lifecycle.** The Gateway maintenance tick (every 60 seconds) calls the sweep, which runs at most every 5 minutes, starting 60 seconds after boot, inside shared-host `cron` admission. The maintenance scheduler already owns start, stop, and shutdown, so the sweep adds two lines to `GatewayService`.
- **No flag.** Phase 0 only reads and records, so it runs without `runtimeRepairSweepV1Enabled`. The flag arrives with the first Tier A recipe.
- **Route.** `GET /api/v1/ops/runtime-repairs` (operator-only, `no-store`) returns the in-memory snapshot of the Gateway process that answers. It has no mutating methods.
- **Page.** System › Repairs lives at `/system/repairs` (release status `experimental`). Like System › Improvement it has no tab yet: adding a tab changes the tab row in every System visual baseline, so the tab waits for a deliberate rebaseline. The page only reads; each finding links to its run (`/work/runs/…`) or approval (`/inbox?approvalId=…`). A run with no recorded workspace, which includes many approval waits, opens Work's "Run workspace unknown" notice rather than the run.
- **Thresholds** are constants in Phase 0 (`RUNTIME_REPAIR_THRESHOLDS`). Moving them into validated configuration is part of Phase 1.

## Open Questions

1. Should Tier A default on once Phase 1 proof passes, or stay opt-in until the owner has watched the repair log for a while?
2. Which dead-letter causes count as transient? A starting list: HTTP 429, provider 5xx, network timeout, connection reset.
3. Grace period before `approval.resolved-wait-not-woken` fires (proposed: 2 minutes).
4. Should the repair log notify the phone (mobile push) for Tier C findings, or only show in Ops?
5. Is the Windows host allowed to restart the Gateway while a Chat turn is streaming, or should it wait for drain when the Gateway is still answering liveness but failing readiness?
