# Mission Control Stream (+ Deploy Domain + Gateway Orchestration) — Design

- **Date:** 2026-07-01
- **Status:** Approved (design); pending implementation plan
- **Drives:** Open Design "Code import" project (project id `dbc9a60e-4a9f-4051-a56c-cba0c14d53dc`, linked to `F:\code\personal-ai`) — specifically the `verge-remix.html` exploration, which restructured Mission Control's IA around one unified cross-agent activity timeline instead of the session-scoped 3-pane work surface. The `verge-reskin.html` (app-wide visual reskin) direction is explicitly deferred, not part of this spec.
- **Author:** design session (brainstorming)

> File/line anchors below come from a mix of direct reads and read-only exploration (background research agents). Anchors from direct reads (route-model.ts, chat-page-pure-helpers.ts) are exact at time of writing. Anchors sourced from agent research are **approximate** — verify at implementation time.

---

## 1. Problem & goal

Mission Control's current "Work" area (`apps/mission-control-next`) is session-scoped: an operator picks one delegated task and works it in a 3-pane surface (rail / conversation / inspector). A design exploration in Open Design (`verge-remix.html`) proposed a different lens: a single chronological feed of activity across *all* agents and sessions at once, with a "live agents" sidebar and a composer that can direct any agent directly — closer to "what is everything doing right now" than "let me focus on this one thing."

The goal of this spec is to bring that IA idea into real code as a new, additive surface (not a replacement for the existing Work surface), while being honest about what already exists to build on versus what's genuinely new. That honesty exercise surfaced two more independent problems along the way:

1. The mockup's "Deploys" activity category doesn't correspond to anything in the codebase — there is no deploy domain at all today.
2. Building a real deploy action exposed that the only existing "apply" primitive is a whole-process gateway restart with no supervision, which is a blast-radius and reliability problem worth solving properly rather than gluing around.

This spec therefore covers three layered pieces: **the Stream** (UI + unified event feed), **the Deploy domain** (an approval-gated way to apply a validated Code Mode change), and **gateway orchestration** (a blue-green cutover mechanism the Deploy domain relies on). They're specified together because the Deploy domain only makes sense in terms of the orchestration primitive, and the Stream is the thing that surfaces both — but §4's architecture diagram shows them as three distinct boxes with a single hand-off seam each, so the implementation plan can still sequence or phase them independently if that turns out to be the right call.

---

## 2. Decisions (locked)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Stream placement | New top-level nav area (`PrimaryArea: "stream"`) | Keeps the existing session-scoped Work surface untouched; the Stream is purely additive, not a redesign of `ops/activity` or `cowork/board`. |
| D2 | Visual language | Verge treatment (mint-green accent, condensed display type) scoped to only the new `stream` area | The app-wide reskin is explicitly deferred; this one area is a deliberate, contained exception to Signal Noir. |
| D3 | Release posture | Ships `experimental` in `ROUTE_RELEASE_SCOPE` — fully built and reachable via direct URL/command palette, hidden from the primary nav rail | Matches this codebase's existing convention for de-risking new surfaces (`ops/kanban`, `library/curator`, `settings/personalities` all launched this way). |
| D4 | Approval UX | Inline Approve/Deny directly on Stream timeline cards | Avoids the queue-mediated pattern in the mockup, which would have been a real workflow regression for an "operator cockpit" tool. |
| D5 | Data layer | Full `UnifiedActivityEvent` contract + new gateway aggregation endpoint | Chosen over a thinner client-side-merge-of-existing-calls approach; gives every consumer one typed event shape instead of ad-hoc per-surface merging. |
| D6 | Deploy events | Modeled as `approval` events carrying a new `infrastructure_action` approval kind — **not** a separate top-level `deploy` event kind | No independent deploy domain existed anywhere in the codebase (verified by grep); this reuses the approval system's existing "follow-up effect" pattern instead of inventing a new taxonomy. |
| D7 | Deploy granularity | Full gateway-instance blue-green cutover, not a whole-daemon kill-and-restart | A bare restart affects every active session with no warning; cutover contains the blast radius to a bounded handoff window. |
| D8 | Continuity during cutover | Durable runs resume via the *existing* lease/checkpoint recovery system; non-durable in-flight streams get a brief "reconnecting…" state, not zero-interruption | True zero-interruption would require live-connection migration — an open problem well beyond what today's durable-run system was built for. |

---

## 3. Scope

### In scope
- `UnifiedActivityEvent` contract (`packages/contracts`) — five kinds: `session`, `tool_call`, `approval`, `memory_write`, plus the `infrastructure_action` approval kind (not a 5th top-level kind — see D6).
- New gateway aggregation endpoint merging existing timeline/session/approval sources plus a new `MemoryLifecycleService` feed query.
- `useUnifiedActivityStream()` frontend hook (polling, ~15s cadence — matching today's `ops/activity`).
- New `stream` area: route-model wiring, `experimental` release scope, timeline UI, live-agents sidebar (reusing Cowork's operator-posture query), filter pills, "direct an agent" composer (reusing existing send-message plumbing), Verge-scoped visual tokens.
- `infrastructure_action` approval kind in `packages/contracts/src/approvals.ts`.
- `code-mode-apply-service.ts` (new) — applies a validated Code Mode diff to the working tree.
- Launcher (`bin/goatcitadel.mjs`) supervisor extension: spawn second instance, health-check, cutover via status-JSON flip, drain, terminate.
- Frontend "reconnecting…" UX for interrupted non-durable streams.

### Out of scope (deliberately)
- Real-time push transport (WebSocket/SSE) for the Stream feed — v1 polls.
- The Verge visual reskin for the rest of the app (`verge-reskin.html` direction).
- Any change to the existing session-scoped Work/Cowork/Code surface.
- Cross-workspace/cross-citadel event aggregation.
- Zero-interruption live-stream migration during cutover (D8).
- Per-service/per-module hot-reload inside a single process — superseded by full-instance cutover (D7); in-process module hot-reload in Node (especially ESM) is a known-fragile pattern most production systems deliberately avoid.
- A general-purpose multi-target deployment platform. Exactly one target exists (the gateway daemon); this is not designed for hypothetical future targets.

### Non-breaking guarantee
The `stream` area is unreachable from primary navigation until promoted out of `experimental`. The Deploy domain and orchestration cutover are net-new code paths gated behind a net-new approval kind — no existing approval, tool-call, or session code path changes behavior. If the aggregation endpoint or cutover routine is never invoked, the app behaves exactly as it does today.

---

## 4. Architecture overview

```
 Code Mode (existing)                         Approval system (existing)
 validated diff + test artifacts    ──►        new kind: infrastructure_action
 (code-mode-aider-*.ts artifacts)               (packages/contracts/src/approvals.ts)
                                                          │  operator Approves
                                                          ▼
                                          code-mode-apply-service.ts  (NEW)
                                          applies diff to the working tree
                                                          │
                                                          ▼
                                          launcher cutover routine  (NEW)
                                          bin/goatcitadel.mjs supervisor extension:
                                           1. spawn 2nd gateway instance, alt port
                                           2. health-check before touching anything live
                                           3. flip published status JSON's gatewayUrl
                                           4. drain + terminate old instance
                                                          │
                        ┌─────────────────────────────────┴──────────────────────────┐
                        ▼                                                            ▼
        durable-run-service.ts (existing)                        non-durable in-flight streams
        lease/checkpoint recovery — reused as-is                  interrupted; "reconnecting…" shown
        runs resume on the new instance                            (frontend UX addition)

                                                          │  (all of the above emit)
                                                          ▼
                        UnifiedActivityEvent   (NEW — packages/contracts)
                        kinds: session | tool_call | approval | memory_write
                                                          │
                                                          ▼
                        gateway aggregation endpoint  (NEW)
                        merges: timeline events, approvals (incl. infrastructure_action),
                                sessions/operators, MemoryLifecycleService writes
                                                          │  polled ~15s
                                                          ▼
                        useUnifiedActivityStream()   (NEW hook, mission-control-shared)
                                                          │
                                                          ▼
                        Stream UI  (NEW — apps/mission-control-next, area "stream", experimental)
                          - timeline cards, inline Approve/Deny (reuses ops/approvals handlers)
                          - live-agents sidebar (reuses CoworkNativePage operator-posture query)
                          - filter pills: All / Sessions / Tools / Approvals / Memory
                            ("Deploys" = Approvals filtered to infrastructure_action, not its own data path)
                          - "direct an agent" composer (reuses existing send-message plumbing)
                          - Verge-scoped visual tokens (mint accent), isolated to this area only
```

The frontend already resolves the gateway's address dynamically from the launcher's published status JSON rather than a hardcoded build-time URL (confirmed via `DesktopRuntimeStatus.GatewayUrl` / `RuntimeStatusService` on the Windows host) — this is what makes the cutover in step 3 possible with zero frontend changes.

---

## 5. Part 1 — Data contracts

### 5.1 `UnifiedActivityEvent` (new — `packages/contracts`)

A discriminated union, base fields shared by every variant:

```ts
interface UnifiedActivityEventBase {
  eventId: string;
  timestamp: string; // ISO 8601
  workspaceId: string;
  citadelId?: string;
  agentId?: string;
  sessionId?: string;
}

type UnifiedActivityEvent =
  | (UnifiedActivityEventBase & { kind: "session"; sessionEvent: "started" | "ended" | "delegated"; label: string })
  | (UnifiedActivityEventBase & { kind: "tool_call"; toolName: string; summary: string; filePath?: string })
  | (UnifiedActivityEventBase & {
      kind: "approval";
      approvalId: string;
      // Reuses the full existing approval-kind enum from packages/contracts/src/approvals.ts
      // (tool_invoke and friends) plus the one new value this spec adds: infrastructure_action.
      // Pull the exhaustive existing list at implementation time rather than re-deriving it here.
      approvalKind: "infrastructure_action" | ExistingApprovalKind;
      status: "created" | "approved" | "denied" | "applying" | "succeeded" | "failed";
      riskLevel: "safe" | "caution" | "danger" | "nuclear";
      description: string;
      // present only when approvalKind === "infrastructure_action":
      infrastructureAction?: { targetService: "gateway"; action: "apply_and_restart"; sourceDiffRef: string; blastRadius: string };
    })
  | (UnifiedActivityEventBase & { kind: "memory_write"; memoryKind: string; entityId: string; summary: string });
```

Design note: this reuses the existing `riskLevel` enum (`packages/contracts/src/approvals.ts`, confirmed present) verbatim rather than inventing a parallel severity scale.

### 5.2 New approval kind: `infrastructure_action`

Added alongside the existing approval kinds in `packages/contracts/src/approvals.ts`. Carries `targetService`, `action`, a `sourceDiffRef` linking back to the originating Code Mode session/diff, and a required plain-language `blastRadius` string (e.g. *"Restarts the gateway daemon; affects all N active sessions."*) — this field is mandatory precisely so the UI can never under-state impact the way the original mockup's copy did ("Affects 3 call sites" for what is actually a full-daemon restart).

Approvals already track a follow-up `effectKind`/status pair for post-approval actions (confirmed in prior research). `infrastructure_action`'s `apply_and_restart` effect slots into that existing mechanism rather than adding a parallel one.

---

## 6. Part 2 — Deploy domain

### 6.1 Flow

1. Operator marks a Code Mode session's validated diff + passing test artifacts as ready to deploy.
2. This creates an approval: `approvalKind: "infrastructure_action"`, `action: "apply_and_restart"`, risk level defaulted to `danger` (escalating to `nuclear` per existing policy rules for whatever the policy engine already treats as maximum-risk).
3. On **Approve**, the approval-lifecycle service's effect execution (existing mechanism) invokes the new `code-mode-apply-service.ts`.
4. On **Deny**, nothing happens beyond the standard approval-denied event — the diff remains an inspectable artifact, unchanged from today.

### 6.2 `code-mode-apply-service.ts` (new)

Follows the existing `code-mode-*` service pattern (`apps/gateway/src/services/code-mode-*`). Responsibilities:
- Reads the validated diff artifact from the originating Code Mode sandbox run.
- Applies it to the live working tree (the one genuinely new "apply" primitive in this whole spec — today, an operator does this by hand).
- On success, hands off to the launcher cutover routine (§7) rather than issuing any process-kill itself.
- On failure (patch doesn't apply cleanly, e.g. tree has diverged since validation), emits `status: "failed"` and leaves the working tree untouched — no partial-apply state.

### 6.3 Approval → orchestration handoff

The Deploy domain never restarts anything directly. It calls into the launcher's cutover routine (§7) as a black box and reports whatever that routine reports. This keeps "how do we apply a diff" and "how do we safely swap a running process" as independently testable concerns.

---

## 7. Part 3 — Gateway orchestration

### 7.1 Current state (why this is needed)

Confirmed via research: the gateway runs today as a single **unsupervised** detached process, spawned by the launcher (`bin/goatcitadel.mjs`) with a PID file for tracking. There is no auto-restart on crash. The Windows desktop host polls health every ~10s but does not restart a failed process. Binding is a single hardcoded loopback address (`127.0.0.1:8787` by default, `apps/gateway/src/env.ts`), with no reverse proxy or load balancer anywhere.

Two facts make a minimal-new-infrastructure cutover feasible rather than requiring a full rewrite:
- **Durable state already persists and recovers.** `DurableRunService` / `DurableExecutionService` checkpoint workflow state to SQLite/Postgres with a lease-based recovery model (confirmed: 120s lease TTL, up to 50 checkpoints per run). This is already designed to resume a run after the process that was running it dies — cutover just triggers that path deliberately instead of by accident.
- **The frontend doesn't hardcode the gateway's address.** It reads `gatewayUrl` from the launcher's published status JSON at runtime. Flipping that value is enough to redirect clients to a new instance — no frontend deploy required.

What's genuinely missing: any supervisor logic at all, and a way to apply a diff (§6).

### 7.2 Cutover sequence

1. Spawn a second gateway instance on an alternate port (reuse the existing `spawnDetachedProcess` helper, override `GATEWAY_PORT`).
2. Poll the new instance's health endpoint (the same one `ops/runtime` already reads) until it reports ready. **Never proceed past this step on a failed or timed-out health check.**
3. Flip the launcher's published status JSON so `gatewayUrl` points at the new instance. Existing clients pick this up on their next status poll (bounded by the existing ~10s interval).
4. Stop routing new work to the old instance (it naturally stops receiving new requests once status flips) and let its durable-run leases lapse on their existing TTL rather than force-killing anything with in-flight state.
5. Terminate the old process and clean up its PID file once its leases have lapsed.

### 7.3 Continuity

- **Durable runs** (delegated agent work, orchestration phases, approval-wait-resume): resume on the new instance through the *existing, unmodified* lease/checkpoint recovery path.
- **Non-durable in-flight streams** (an agent actively streaming a reply): interrupted. The frontend shows a brief "reconnecting…" state and re-establishes against the new instance, rather than the connection silently dying. This is a deliberate, disclosed limitation (D8), not an oversight.

### 7.4 Failure handling

- If the new instance never passes its health check, the cutover aborts and the old instance keeps serving — the routine must never tear down a known-good instance on the strength of an unverified replacement.
- If the process orchestrating the cutover itself dies mid-sequence, the launcher must detect a stale status pointer (pointing at an instance that isn't actually healthy) on its next read and re-verify before trusting it, rather than leaving clients pointed at a dead address indefinitely.

---

## 8. Part 4 — Stream UI

### 8.1 Route & IA wiring (`apps/mission-control-next/src/app/route-model.ts`)

- New `PrimaryArea` value: `"stream"`, added to the existing union (today: `chat | cowork | code | projects | library | ops | settings`, `route-model.ts:4`).
- `AREA_META.stream` entry (label, kicker, description), following the existing pattern at `route-model.ts:101-144`.
- `RAIL_ITEMS.stream`: minimal — the Stream is primarily a single view, not a multi-section area like Library or Settings.
- `ROUTE_RELEASE_SCOPE` entry: `{ area: "stream", section: "root", status: "experimental", ... }`, following the existing table shape at `route-model.ts:808-1231`. This is what keeps it out of the primary nav rail per `isExperimentalRoute` (`route-model.ts:1426-1428`) while remaining fully reachable.

### 8.2 Aggregation hook

`useUnifiedActivityStream()` (new, `packages/mission-control-shared`) polls the new gateway aggregation endpoint on the same cadence class as today's `useOpsRuntimeSnapshot()`, returns a sorted `UnifiedActivityEvent[]`, and exposes the same `{data, loading, error}` shape already established for that hook.

### 8.3 Timeline component

Chronological feed of event cards, one rendering per `kind`. `approval`-kind cards render inline Approve/Deny wired to the **same** action handlers `ops/approvals` already calls — no new approval-action logic anywhere in the frontend. Filter pills: All / Sessions / Tools / Approvals / Memory. There is no separate "Deploys" data path — filtering to `infrastructure_action` is just a predicate over the same `approval` events.

### 8.4 Live-agents sidebar

Reuses the existing operator-posture query from `CoworkNativePage` (Agent Board), restyled to match the Stream's visual language. No new data source.

### 8.5 "Direct an agent" composer

Reuses existing send-message plumbing (the same path the session-scoped composer uses), targeting whichever agent/session is inferred or explicitly selected. Not a new dispatch mechanism.

### 8.6 Visual language scoping

Verge-derived tokens (mint accent, condensed display type) are scoped under a `stream`-area-specific class boundary so they cannot leak into Signal Noir tokens used everywhere else. This is the one place in the app where the visual language deliberately diverges, per D2.

---

## 9. Error handling

- Aggregation endpoint unreachable → Stream shows a visible degraded state, not a silently empty feed. Matches this codebase's existing fail-closed conventions (e.g. Trust & Policy's dashboard failing closed when its snapshot API is unavailable).
- `infrastructure_action` approvals: policy evaluation failure fails **closed** (deny), consistent with every other risk-gated action in this system.
- Cutover: see §7.4. Health-check-before-cutover and stale-pointer detection are the two load-bearing safety properties; neither is optional.
- `code-mode-apply-service`: a diff that fails to apply cleanly leaves the working tree untouched and reports failure — never a partial apply.

---

## 10. Testing strategy

- Unit tests: `UnifiedActivityEvent` adapter/merge logic, `infrastructure_action` policy gating, `code-mode-apply-service` (including the diverged-tree failure path).
- Component tests: Stream timeline rendering per event kind, inline Approve/Deny wiring, filter pills — following this repo's existing per-surface test convention.
- Cutover routine: unit-testable with a mocked spawn/health-check, but **also** needs an explicit manual verification pass (kill a live instance mid-session, confirm durable-run recovery and frontend reconnect) before this ships even as `experimental` — CI cannot safely simulate real process spawning/killing for this.
- Release-scope verification: a new `verify:stream:regression` entry alongside the `experimental` `ROUTE_RELEASE_SCOPE` row, matching the convention every other route already follows.

---

## 11. Open questions / risks (carried into planning)

- Exact policy-engine wiring for `infrastructure_action` risk-level defaults (danger vs. nuclear, and whether it's ever eligible for auto-approval under any trust profile) needs to be pinned against `packages/policy-engine/src/engine.ts` at plan time — this spec assumes it is **never** auto-approved, but that assumption should be verified against the real policy schema, not just asserted here.
- The manual cutover-verification step (§10) has no owner or environment specified yet (does it run against a real packaged build, or the dev daemon?) — needs to be resolved in the implementation plan.
- `MemoryLifecycleService`'s existing data does not yet have a feed-shaped query (recent writes over time); §5/§8 assume one gets added, but the service's actual query surface should be re-checked at plan time rather than assumed.

---

## 12. Related work / references

- Open Design project "Code import" (`dbc9a60e-4a9f-4051-a56c-cba0c14d53dc`), files `index.html` (Signal Noir baseline), `verge-reskin.html` (deferred), `verge-remix.html` (source of the Stream IA), `mission-control-snapshot.md`.
- `apps/mission-control-next/src/app/route-model.ts` — full route/IA registry this spec extends.
- `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.ts:203-239` (`groupDelegatedSessionsForRail`) — existing session-grouping logic; not reused directly by the Stream (which groups by time, not delegation hierarchy) but the closest existing precedent.
- Memory note: `open_design_mc_next_verge_exploration_2026_06_30.md` (this session's earlier finding that the in-flight declutter-pass code changes are unrelated to this design).
