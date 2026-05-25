# Approvals + Runtime — fresh review

**Date:** 2026-05-24
**Reviewer:** subagent walk
**Files:** `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx` (843 lines — note: brief said 817), `apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx` (1375 lines — note: brief said 1333), `apps/mission-control-next/mockups/approvals.html` (463 lines), `apps/mission-control-next/mockups/runtime.html` (467 lines)

## Verdict

**Approvals:** Ship-with-known-debt. The structural backbone (Pending/History/Recovery tabs, queue-list + inspector split, risk-strip counts, decision actions, bulk-reject in head, replay/durable/trace cards) is honest to mockup intent and uses `StatusChip` consistently. But the page does not deliver on the mockup's two highest-leverage promises: the **decision-context strip** that grounds each verdict (scope / actor / reversibility / prior verdicts) is absent from the inspector, and **per-item urgency** is communicated as a localized timestamp instead of the mockup's countdown-with-expiry. Approve / Reject decisions require 2 clicks (open queue item → action) which clears the ship-bar's "≤2 clicks" rule, but no keyboard shortcut accelerator is wired, and `Reject all pending` is duplicated in two places. The `ThreePartChip` is used in exactly **one** spot ("awaiting approval") even though the brand-spec explicitly calls it out as the canonical primitive for this surface.

**Runtime:** Ship-with-known-debt. Eight sections live behind one `section` switch — Activity, Sessions, Schedules, Improvement, Costs, Runtime, Diagnostics, Notifications — and each renders a distinct grid of cards. The Activity feed adopts `ThreePartChip` correctly (`state / mid / age`), and `OpsNeedsAttentionCard` carries genuine triage value. But the mockup's most evocative promises are missing: there is **no spend chart** (the Costs section ships a `<NativeList>` of line items instead of a stacked column with anomaly callout), the activity feed has **no per-event severity icon column** (only the tone of the chip itself), and the cost-anomaly story collapses to "QMD posture: Stable". Most importantly, **the underlying `useOpsRuntimeSnapshot` hook does not poll** — `RuntimeRoutePage.tsx:103-129` shows the hook loads once on mount and only reloads on operator action. A surface marketed as "Daemon up 4h 12m. Spend on pace." is in fact reading a frozen snapshot. This is the single biggest ship-blocker for Runtime.

---

## Approvals

### Top issues (ranked)

1. **`useOpsRuntimeSnapshot` is single-load; Approvals polls every 15s but neither announces new items** (HIGH, state communication) — `useApprovalQueue.ts:140-141` polls `15000` via `useRefreshSubscription`, so the queue refreshes, but `ApprovalsRoutePage.tsx:159-215` lists items inside a non-`aria-live` `<div>`. A new pending approval appears silently — no SR announcement, no visual pulse on the row, no toast. Ship-bar F-202 promises "Live updates without page refresh"; the data layer delivers, the presentation doesn't make it observable.
2. **No decision-context strip in the inspector** (HIGH, state communication) — Mockup `approvals.html:309-326` gives each approval a 4-row decision shell (Scope / Actor / Reversible? / Prior verdicts) as the operator's primary grounding. Live `ApprovalsRoutePage.tsx:469-498` ships a one-line kicker + title only (`decisionCopy`). The operator approves without seeing reversibility or prior verdict frequency — exactly the data that makes the verdict defensible.
3. **`ThreePartChip` used once on the whole surface** (HIGH, consistency vs brand-spec) — brand-spec.md line 75 calls out the 3-part chip (dot + state + age) as the wayfinding primitive "for live monitoring surfaces (runtime, approvals)". Approvals invokes it exactly once at `ApprovalsRoutePage.tsx:477` (`<ThreePartChip tone="caution" state="awaiting approval" mid={...} age="—" />`) and the `age` is a literal em-dash. Every chip in the queue list (`:178-208`) is `StatusChip` instead; per-item age (how long this request has been pending) is missing.
4. **`Reject all pending` is duplicated** (MEDIUM, hierarchy) — rendered at both `:97-103` (page header `actions` prop) and `:135-143` (inside the toolbar, only when `view === "pending"`). Two destructive buttons with identical labels and identical handlers; clicking either opens the same `ConfirmModal`. The mockup keeps it in the toolbar only (`approvals.html:251-256`).
5. **No countdown / urgency communication** (HIGH, state communication) — `ApprovalsRoutePage.tsx:174-177` shows `formatDateTime(approval.createdAt)` (an absolute timestamp) where the mockup ships `⏳ 4m 12s` (`approvals.html:286`). The mockup's whole opening line "2 pending decisions. 4-minute window on the oldest" depends on per-approval expiry countdown; the live surface doesn't even show the expiry, only an "expired" tone. Approval TTL is in the data model (the page already calls `isExpiredApproval()` at `:164`), so this is a render gap not a data gap.

### Findings by lens

#### First impression

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `ApprovalsRoutePage.tsx:78-92` | Stage head emits 4 generic metrics (`Pending / History / Recovery / Replay trails`) with no urgency framing. Mockup opens with `"2 pending decisions. 4-minute window on the oldest."` (`approvals.html:247`) — a sentence, not a stat strip | The mockup leads with the urgent narrative; the live page leads with a counts table. Operators scanning the inbox in 2s need to know "how long does the oldest one have left", not "how many trails in replay history" | Promote the oldest-pending countdown into the description string (computed from `approvals.pendingItems[0].expiresAt`); keep counts as the metrics row |
| MEDIUM | `ApprovalsRoutePage.tsx:107-115` | First card is "Approval queue" with 3 stats (Pending / Workspace / Replay trails) duplicating the page-head metrics | The mockup compresses these into a single 3-tab toolbar (`approvals.html:262-266`). Live readers see "Pending" three times in the upper viewport (head metric, card stat, tab label) | Drop the per-card `stats` for this card; tabs already carry the counts |
| MEDIUM | `ApprovalsRoutePage.tsx:145-158` | Risk strip prints all 4 risk levels (Safe / Caution / Danger / Nuclear) at all times, with muted tone when count is 0 | The mockup omits zero-state risk pills (`approvals.html:268-270`); they're scope/actor filters, not risk strip — risk is implicit in each card's badge | Hide the risk pill when count is 0 (or fold them into a single "Risk: 2 caution · 1 nuclear" line) |
| LOW | `ApprovalsRoutePage.tsx:218-234` | Right-card title is the bare approval kind (e.g. "code_mode.run") when an item is selected | Mockup uses scope-style title (`approvals.html:280-285`): `memory.write · knowledge/routing · TTL ∞ · pin apr_24bc12` — the artifact under decision, not the kind | Build a `formatApprovalSubject(approval)` helper that includes scope, resource path, TTL, and short id |

#### Usability

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `ApprovalsRoutePage.tsx:475-498` | To Approve, operator must (1) click the queue item, (2) click "Approve now"; the second click opens a `ConfirmModal` with a third click. That's 3 clicks for low-risk approvals | Ship-bar F-202: "Approve / deny in 2 clicks max". For low-risk items the confirm modal is overkill; the mockup ships the verdict inline (`approvals.html:327-339`) with no second-confirm | Skip `ConfirmModal` when `risk === "safe"` or `risk === "caution"`. Keep it for danger/nuclear. Render verdict buttons inline in the queue card for low-risk |
| HIGH | `ApprovalsRoutePage.tsx:475-498` | No keyboard shortcuts. To approve via keyboard: Tab to item → Enter → Tab through 4+ buttons → Enter → Tab → Enter on confirm | r4-ux's COWORK-011 noted no keyboard for inline approval gates; same bug here. Linear inbox triage rhythm (the reference standard) is `j/k` navigate, `e` archive, `Y` close — single-key actions | Wire `A` for approve, `R` for reject, `J/K` for next/prev item. The page already has all the verdict handlers; just attach a keydown listener |
| HIGH | `ApprovalsRoutePage.tsx:97-103, 137-143` | `Reject all pending` button duplicated in page-head actions AND toolbar | Either presentation is defensible; both is noisy and confuses scope (does the head button reject the whole pending queue across all tabs? does the toolbar button reject only the visible tab?). Same handler, same confirm copy — they ARE the same action | Remove the page-head duplicate (`:97-103`); keep the toolbar variant where the mockup puts it |
| MEDIUM | `ApprovalsRoutePage.tsx:160-215` | Queue list items are full-width buttons; clicking opens the right-side inspector | The mockup shows the decision context inline (one per item) rather than a master-detail split. For a queue typically containing 2-5 items, inline is faster — no second click needed before reading the evidence | Consider switching to inline-evidence layout for ≤5 pending items; fall back to master-detail when queue is ≥6 |
| MEDIUM | `ApprovalsRoutePage.tsx:159-161` | Empty state for queue is a bare `<p className="mc-next-directory-empty">` | The `EmptyState` primitive exists at `primitives/EmptyState.tsx` and supports `icon / title / description / primaryAction / secondaryActions`. Approvals doesn't use it (and isn't even exported from `primitives/index.ts`) | Adopt `<EmptyState size="compact" title="No approvals in this view" description="..." secondaryActions={<button onClick={() => approvals.setView('history')}>View history</button>} />` |
| MEDIUM | `ApprovalsRoutePage.tsx:115-133` | View switch uses bespoke `ApprovalViewButton` with `role="tab"` + `aria-selected` but no `role="tablist"` on the parent (`:117` has `role="tablist"`, so it's actually present — my mistake on first read). Verified: this is correctly tablist-shaped | n/a | n/a |
| MEDIUM | `ApprovalsRoutePage.tsx:786-795` | `formatDateTime` falls back to `toLocaleString()` — produces a string that varies per-locale, making screenshot diffs and keyboard scanning unpredictable | Operator scan rhythm benefits from fixed-format (`14:08:42` like the mockup `approvals.html:408-441`). The Runtime page's `formatDateTime` (`RuntimeRoutePage.tsx:1303-1326`) uses `Intl.DateTimeFormat` — closer but still locale-sensitive | Share a single `formatOpsTime(value)` helper that returns `HH:mm:ss` for today, `MMM d HH:mm` for older. Drop `toLocaleString()` |

#### Visual hierarchy

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `ApprovalsRoutePage.tsx:160-215` queue items | All queue items render identically regardless of risk — only the `StatusChip tone` differentiates. No border-color cue, no icon, no severity-tinted background. Nuclear and Safe items look the same except for one pill colour | Mockup `approvals.html:274-307` (critical) vs `:346-385` (warning) uses **different border-top stripe**, **risk-tinted countdown**, and a **risk-icon glyph in the head**. Triage at a glance fails when nuclear items don't visually punch | Wire `data-risk={approval.riskLevel}` on `.mc-next-approvals-list-item` and tint the border-top per risk level. Bonus: a left 3px border stripe is the cheapest "this is a critical item" cue |
| HIGH | `ApprovalsRoutePage.tsx:469-498` | The decision shell renders chip row → title → action buttons in a flat 1-column flow on mobile; on desktop `mc-next-approvals-decision-shell` (CSS `:571-580`) is a 1.5fr / 1fr split between copy and actions | Mockup's 4-row decision context table is the *primary anchor* of the page — it's what makes the decision defensible. Live treats the action buttons as the right column; mockup treats the **decision context** as the right column | Reuse `MetricGrid` from RuntimeRoutePage (`:957-969`) to render `[Scope, Actor, Reversible?, Prior verdicts]` as the right column; demote action buttons to a row below the context strip |
| MEDIUM | `ApprovalsRoutePage.tsx:217-285` | Right card title is the approval kind only ("code_mode.run") — no scope-style breadcrumb | Already noted under First Impression. Worth restating because the right card is the largest object on screen and currently has the smallest title relative to its real estate | Build `formatApprovalSubject` (see First Impression notes) |
| MEDIUM | `ApprovalsRoutePage.tsx:621-635` (tracePreview), `:637-678` (lifecycle), `:680-698` (effects) | Three supporting cards stack vertically below the inspector; each is the same width with no visual ranking | Visual rank should follow operator decision flow: evidence (top) → decision context (right) → recovery (bottom) → trace (collapsed by default). Currently all are equal | Move `Trace detail`, `Runtime linkage`, `Approval effects` into a collapsed `<details>` block by default. Surface only when expired/failed |
| LOW | `ApprovalsRoutePage.tsx:719-727` | "Raw request and preview payload" is the last `<details>` on the page | Acceptable — power-user escape hatch. Mockup omits this entirely | Keep, but consider rendering only when `?dev=1` flag |

#### Consistency

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `ApprovalsRoutePage.tsx` (whole file) | Uses `StatusChip` in 8 locations (`:146-156, 179-208, 429-466`) but `ThreePartChip` only once (`:477`) | brand-spec.md:75 makes the 3-part chip the *canonical* primitive for live monitoring surfaces. Approvals IS a live monitoring surface. The fact that the same file imports both (`:5`) and chooses single-pill for queue items is the consistency miss | Migrate queue-row chips (`:178-208`) to `ThreePartChip` with `state=risk / mid=kind / age=time-since-created`. Keep `StatusChip` for the risk-strip counts at `:145-158` (those are aggregate filters, not per-item state) |
| HIGH | `ApprovalsRoutePage.tsx:289-302` | `ConfirmModal` is imported from `@goatcitadel/mission-control-shared/components/ConfirmModal` (a shared component) but Settings (per fresh-settings.md) still uses `window.confirm()` for 8 destructive sites | Cross-surface consistency: Approvals uses the in-app modal (correct); Settings doesn't | Not an Approvals bug; cross-cutting finding. Approvals is the model implementation |
| MEDIUM | `ApprovalsRoutePage.tsx:489-491` | "Load replay trail" button uses `gc-button subtle`; "Open live session" is rendered as an `<a>` with `className="mc-next-approvals-link-button"` (CSS `:712-734`) | Buttons and links in the same action row use different className systems. Visual treatment converges by design but the divergent classnames mean a future theme change touches two CSS rules | Pick one. Either wrap the `<a>` in a `gc-button` variant (preserving link semantics) or unify under `mc-next-approvals-link-button` for both |
| MEDIUM | `ApprovalsRoutePage.tsx:62` and `:289` (handler vs modal) | `confirmPendingAction` uses `void Promise.resolve(action).finally(...)`. The `action` value could be `void` (sync) or `Promise<void>` (async). `Promise.resolve()` coerces both; works but is awkward | Type safety / readability | Type-narrow first; if `typeof action?.then === "function"` await it, else just close the modal |
| LOW | `ApprovalsRoutePage.tsx:431-432` | Risk badge tone mapping uses inline ternaries: `tone={approval.riskLevel === "nuclear" ? "critical" : approval.riskLevel === "danger" ? "warning" : "muted"}` — repeated at `:179-187` and `:430-432` | DRY | Extract `approvalRiskToTone(riskLevel)` helper |

#### Accessibility

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `ApprovalsRoutePage.tsx:159-215` | Queue list has no `aria-live` region. Approvals polls every 15s (`useApprovalQueue.ts:141`) and a new approval can appear silently while the operator is reading another | SR users have no way to know a new approval arrived. Visual users likewise — there's no animation, no count flash, no toast | Wrap `.mc-next-approvals-list` in `role="log" aria-live="polite" aria-relevant="additions"`; or surface a small visual pulse on the `Pending (N)` tab when N increments while the page is visible |
| HIGH | `ApprovalsRoutePage.tsx:289-302` | `ConfirmModal` is opened on every verdict click. No `autoFocus` on the safer-default button is documented in this file (lives in the shared component) | Per ship-bar F-202: focus management for the modal must be correct. Verify in `ConfirmModal.tsx` that the modal traps focus and restores it on close | Not actionable from this file; flag for cross-cutting review of `ConfirmModal` |
| MEDIUM | `ApprovalsRoutePage.tsx:467` | The chip-row at the top of the inspector renders 4 status chips in a `<div>` with no `role="group"` or `aria-label` | SR users hear "risk nuclear critical pending warning queued caution" with no grouping context | Add `<div role="group" aria-label="Approval status">` wrapper |
| MEDIUM | `ApprovalsRoutePage.tsx:701-717` | `<details>` element for "Replay trail and pending action" — `<summary>` has icon + text but no `aria-expanded` state announcement beyond the browser default | Browser default works for SR but the summary doesn't expose "Replay trail and pending action, 8 events" — just the label | Add `aria-label` to summary with item count when expanded |
| MEDIUM | `ApprovalsRoutePage.tsx:117-133` | Tab buttons have `role="tab"` + `aria-selected`. Parent has `role="tablist"` at `:117`. But no `aria-controls` linking tab → panel; no `role="tabpanel"` on the queue list | WAI-ARIA tab pattern incomplete — keyboard users tabbing past the tablist don't land in the panel via arrow keys (would normally jump tab→panel→panel-content) | Add `aria-controls={tabId}` on each tab, and `role="tabpanel" id={tabId}` on the panel below |

### Mockup-vs-live gap

**Mockup promises Approvals doesn't deliver:**

| Promise | Mockup ref | Live state |
|---|---|---|
| Stage h1 with urgent narrative: "2 pending decisions. 4-minute window on the oldest." | `approvals.html:247-248` | `ApprovalsRoutePage.tsx:83-84` ships generic "Approvals" + "Pending decisions, history, replay, and durable recovery in one operator view" — a feature list, not a status |
| Per-approval expiry countdown pill (`⏳ 4m 12s`, risk-tinted) | `approvals.html:286, 356` | `ApprovalsRoutePage.tsx:176` renders `formatDateTime(approval.createdAt)` only. `isExpiredApproval()` exists at `:164` but is only used to flip tone, not to show time-remaining |
| 4-row decision context strip (Scope / Actor / Reversible? / Prior verdicts) | `approvals.html:309-326` | Absent. `ApprovalsRoutePage.tsx:469-498` ships kicker + h3 + actions only |
| Risk badge with leading icon glyph (alert-triangle for critical, info-circle for warning) | `approvals.html:276-279, 348-351` | `StatusChip` supports an `icon` prop (`StatusChip.tsx:9`) but `ApprovalsRoutePage.tsx:179-208` never passes one |
| Inline diff preview of the artifact under decision (memory write payload, slack message preview) | `approvals.html:289-307, 360-368` | `evidence` block at `ApprovalsRoutePage.tsx:525-558` renders targets/commands/changes as plain text + `<pre>` blocks; no syntax-highlighted diff, no add/remove gutters |
| Trace mini-timeline alongside the decision (`14:02:01 ● turn.start ...`) | `approvals.html:301-307` | Trace preview lives in a separate card `:621-635` and is only loaded on operator click (`onLoadTracePreview`). Not adjacent to the decision; not auto-loaded |
| Compact dense History row anatomy with `When / Verdict / Scope · actor / Decided by` columns | `approvals.html:387-443` | History tab reuses the same queue-card layout as Pending. There is no dense table view — auditing a week of decisions requires scrolling tall cards |
| Status strip footer (`● 2 pending · 4m on oldest`) | `approvals.html:448-454` | Absent. There is no persistent status strip across Mission Control Next |
| Export CSV action on history | `approvals.html:391` | Absent |
| Filter chips on toolbar (`scope: any`, `actor: any`, `+ Filter`) | `approvals.html:268-270` | Absent. No scope/actor filter at all |

**Live features not in mockup that should stay:**

- `Recovery` view tab and durable-checkpoint card (`ApprovalsRoutePage.tsx:560-593`) — real operator capability tied to `useApprovalQueue`'s `resumeFromCheckpoint`. Mockup didn't model this; live needs it.
- `Approval explanation` summary + error states (`:447-466, 500-508`) — the gateway sometimes can't generate the optional plain-English summary; the live page handles that gracefully. Mockup never showed an error state.
- `Approval effects` and `Runtime linkage` cards (`:637-698`) — these are the operator-facing reflection of approval-driven follow-up work. Mockup ignored them; production needs them.
- `Open live session` link routing to chat/cowork/code by `originSurface` (`:764-784`) — concrete cross-route operator value.

### Primitive adoption

| Primitive | Used? | Where | Should use more? |
|---|---|---|---|
| `StatusChip` | YES (8×) | `:146-156` (risk strip), `:179-208` (queue items), `:429-466` (inspector chip row) | Good. Match mockup by passing `icon` prop when tone is `critical` or `warning` |
| `ThreePartChip` | YES (1×) | `:477` only | **Major gap.** brand-spec calls this out as the canonical primitive for approvals. Should be used on every queue row (`age` = time since created), every approval-effect row, every history row |
| `StageHeader` | NO | Uses `NativePageFrame` from `NativeRoutePageLayout.tsx:14-124` instead | `NativePageFrame` covers similar ground (kicker / title / description / metrics / actions). `StageHeader` exists but isn't wired in. Should be unified — pick one |
| `EmptyState` | NO | `:161, 281, 591` all use bare `<p className="mc-next-directory-empty">` | Adopt `EmptyState` (which supports primary/secondary action slots). The empty queue should offer "View history" CTA |
| `ContextStrip` | NO | n/a | Not a fit for Approvals (designed for composer context) |
| `ModeBar` | NO | n/a | Not a fit |
| `ConfirmModal` (shared) | YES | `:289-302` | Good. Sets precedent for Settings to follow |

### What works well

1. **Bulk-reject lives in the toolbar with explicit ConfirmModal copy** (`ApprovalsRoutePage.tsx:135-143, 313-320`) — matches mockup intent that destructive sweeps live where destructive actions go. Copy is specific ("This keeps GoatCitadel paused at every pending checkpoint in the current queue.") rather than generic "Are you sure?".
2. **Decision-copy adapts to status** (`:732-758` `buildApprovalDecisionCopy`) — pending vs expired vs approved vs rejected each get a distinct kicker + title. The "kicker → title" rhythm is correctly applied.
3. **Live-lane routing per origin surface** (`:764-784` `buildLiveLaneRoute`) — `code_mode.run` linkage routes to code, otherwise the originSurface determines the area. Operator can jump from approval evidence to the live conversation in one click.
4. **Replay/durable/trace are all separate cards instead of one mega-payload** (`:525-678`) — preserves operator focus on what's relevant. Trace loads on demand to avoid noise.
5. **`approvals.pendingLaneFailed` graceful fallback** (`:41-45`) — when the queue API errors, the dashboard's pending-count is still surfaced via the topbar count rather than zeroing out. Honest data behaviour.

---

## Runtime

### Top issues (ranked)

1. **`useOpsRuntimeSnapshot` does not poll** (CRITICAL, data integrity / state communication) — `useOpsRuntimeSnapshot.ts:103-129` shows a single `useEffect` that runs `load()` once on mount. There is no `useRefreshSubscription`, no `setInterval`, no SSE. The only refresh mechanism is `reload()` triggered manually (`RuntimeRoutePage.tsx:154, 624-634, 644-647`) or by `runDaemonAction`. A page titled "Runtime" with metrics like "Daemon: running / uptime 4h 12m" reads as live; in fact uptime never advances on screen. **Ship-bar F-203 explicitly demands live status of every component** — this is a hard fail.
2. **Activity feed is not aria-live** (HIGH, accessibility / state communication) — `RuntimeRoutePage.tsx:825-846` renders the feed inside a `<ul>` with `aria-label="Activity feed"` but no `aria-live`. New events (when polling is fixed) will appear silently. Mockup ships a pause button (`runtime.html:329-331`) implying a streaming feed; live feed is static.
3. **No spend chart** (HIGH, mockup-vs-live gap) — Mockup `runtime.html:219-314` ships a stacked-bar 7-day spend chart with anomaly callout ("May 12 spike · library route +$2.18 (haiku fallback after reshard)"). Live `RuntimeRoutePage.tsx:480-544` renders the Costs section as `<NativeList>` of provider rows + a 3-metric grid. The chart is the cost story; the list is a leaderboard.
4. **8 sections of dense forms with no section-switching cues** (HIGH, hierarchy) — Runtime is one route with `section` in (`activity / sessions / schedules / improvement / costs / runtime / diagnostics / notifications`). Each section renders a totally different grid. The page title and description switch (`labelForOpsSection / descriptionForOpsSection` at `:1018-1037, 1251-1270`), but visual continuity is weak — operators tabbing through rail items see grids dissolve and reform, with no visual through-line to anchor identity.
5. **Daemon "controllable" pill is `default` tone** (HIGH, semantics) — `RuntimeRoutePage.tsx:589-595`: `<StatusChip tone={data.daemon?.controllable ? "default" : "muted"}>` shows "Controllable" in neutral grey and "Read only" in muted grey. Both look like absence of state. A controllable daemon should read `success`/`live`; a read-only one should read `warning` (the operator's read-only state is itself notable). Currently the chip is a tautology.

### Findings by lens

#### First impression

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `RuntimeRoutePage.tsx:546-689` (runtime section) | Section opens with title "Runtime posture" + 2-stat row + 3-chip row + 3-metric grid + 4-button cluster + 2 lists (Backup posture / Integration runtime). Vertical density is high but no single anchor element | The mockup leads with a giant "Daemon up 4h 12m. Spend on pace." h1 (`runtime.html:179`) — the operator's primary question answered in one phrase. Live answers it in a fragment of a metric grid you have to scan to find | Lift the daemon up-status + uptime into the page-frame description. Demote the metric grid below the action cluster |
| HIGH | `RuntimeRoutePage.tsx:546-689` (runtime) vs `:787-874` (activity) | Activity (default section) and Runtime (the explicitly-named section) ship totally different layouts | Operators landing on `?section=runtime` get a granular control surface; operators landing on `?section=activity` (the default) get a live feed. There's no visual indication that they're the same `Ops · Runtime` route family | Add a sub-tab strip at the top of the content area (similar to Approvals' Pending/History/Recovery) to make section-switching visible without rail navigation |
| MEDIUM | `RuntimeRoutePage.tsx:895-900` page-head metrics | Each section gets its own metric set (built at `:1184-1248`). Some sections show 3 metrics, some 4 — no consistent count | Operator scan: column alignment matters. Mockup health strip is always 4 cells (`runtime.html:195-216`) | Force 4-metric minimum per section. Pad with neutral fallbacks if data missing |
| LOW | `RuntimeRoutePage.tsx:557-560` | `runtime.notice` renders as a `mc-next-runtime-notice` div inside the Runtime card body | Mockup doesn't show a notice; this is live-app reality. Acceptable | Keep; ensure the notice is `aria-live` (it isn't — `:557` has no role) |

#### Usability

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| CRITICAL | `useOpsRuntimeSnapshot.ts:103-129` | Single-fire `useEffect` with no polling. `RuntimeRoutePage.tsx:644-647` exposes a manual Refresh button | Ship-bar F-203 promises "see live status of every component. Stale data communicated". Without polling, the page is a snapshot. The fact that the manual Refresh exists implies the developers know it's needed | Wire `useRefreshSubscription("ops-runtime", reload, { pollIntervalMs: 5000, staleMs: 5000 })`. Surface staleness via a `last updated 12s ago` strip when poll lapses |
| HIGH | `RuntimeRoutePage.tsx:619-648` daemon control row | Start / Restart / Stop / Refresh buttons sit in a 4-button row. Stop is `gc-button danger`; the other three use `gc-button` (Start/Restart) or `gc-button subtle` (Refresh) | Start and Restart are both "this changes runtime state" — should both visually distinguish from Refresh. Mockup `runtime.html:188-192` ships only a single Restart button in the page head (one canonical control) | Group Start/Restart/Stop as a segmented control; promote Refresh to the page-head row |
| HIGH | `RuntimeRoutePage.tsx:803-820` activity filter | 4-button filter (All / Errors / Approvals / Runtime) uses `role="radiogroup"` and per-button `role="radio"` + `aria-checked` | Filter semantics correct for radio. But operators expect "tab" semantics for category filters (one selected at a time → tablist). Linear / Vercel deployments / GitHub Actions all use tablist | Either is defensible. Mockup uses `.tabs[data-tabs]` (`runtime.html:323-328`) → tablist. Match the mockup |
| HIGH | `RuntimeRoutePage.tsx:824-846` activity rows | Each row is a `<li>` with `<ThreePartChip>` + a separately-rendered `mc-next-activity-feed-source` span | The chip swallows the event type and class; the source is appended as plain text outside the chip. Visual rhythm is `[chip] [source]` where the chip itself is long-form | Move the source INTO the chip's `age` slot, or replace `age` with `source`. The chip becomes `state=eventType / mid=eventClass / age=source` — matches the mockup's `actor` column (`runtime.html:337-338`) |
| MEDIUM | `RuntimeRoutePage.tsx:79-104` `handleCreateSchedule` | Cron form has Name / Schedule / Action only. No live preview of what cron means in natural language | Mockup `runtime.html:402-438` ships a live cron preview ("Runs Mondays at 09:00 UTC, executing the Routing · model fallback pack..."). Operators editing cron strings without a preview is the classic "0 9 1 * MON" bug that ships things on the 1st AND every Monday | Add a `cronstrue`-style human translation below the cron input |
| MEDIUM | `RuntimeRoutePage.tsx:336-411` Automation Designer | Form has 5 fields (taskDescription / trigger / frequency / successCriteria / constraints) with no inline help on what each field means | "successCriteria" as a comma-separated list is a power-user UX; operators don't know what to type | Add a `placeholder` + inline hint per field; or add a "View example recipe" CTA |
| MEDIUM | `RuntimeRoutePage.tsx:723-727` Diagnostics QuickJumpCard | Routes link to Runtime, Prompt packs, Approvals | "Prompt packs" is in library, not ops. Routing operators to library from a diagnostics view is an IA jump | Replace with another ops surface (e.g. "Notifications", "Sessions") |
| LOW | `RuntimeRoutePage.tsx:691-739` Diagnostics section | Diagnostics card shows hostname, system uptime, heap, daemon logs (last 8). No filter or search | For incidents lasting >8 lines, operator needs a "show more" or filter. Mockup doesn't model diagnostics directly | Acceptable for ship; add "Show all logs" CTA later |

#### Visual hierarchy

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `RuntimeRoutePage.tsx:562-596` daemon chip row | 3 status chips in a row: daemon state, backup state, controllable state. All `StatusChip` (single pill) | Mockup `runtime.html:183-187` ships a *three-part* chip showing `state / host / uptime`. That's exactly the brand-spec 3-part chip use case. Live ships three separate pills | Replace the 3-chip row with one `<ThreePartChip tone={daemonTone} state={daemonRunning ? "healthy" : "stopped"} mid={daemonHost} age={`up ${daemonUptime}`} />` — collapses 3 chips into 1, matches mockup intent, uses the canonical primitive |
| HIGH | `RuntimeRoutePage.tsx:480-544` Costs section | Spend = a list + a metric grid. No chart. No anomaly callout | The mockup's `Spend — last 7 days` chart (`runtime.html:219-314`) is the most evocative single element in the whole Runtime mockup, and it's the answer to "is spend on pace?". Live answers with a 3-line metric grid | Embed a small stacked-area chart (Recharts/Visx) showing the last 7 days by area accent. Even an HTML/SVG bar chart matching the mockup's geometry would close most of the gap |
| MEDIUM | `RuntimeRoutePage.tsx:917-955` Needs Attention card | Items use `ThreePartChip` with `age=""` (empty) | The chip's `age` slot was designed for "now/2m/4h ago" recency. Setting it to empty string still renders the slot (with no content) due to the `age !== undefined` check at `ThreePartChip.tsx:21`. Visually fine but semantically wrong | Pass `age={undefined}` (omit the prop) instead of `""` |
| MEDIUM | `RuntimeRoutePage.tsx:621-648` daemon action row | Start / Restart / Stop / Refresh — 4 buttons of varying tone, all roughly equal size | The mockup hierarchy is implicit: Restart is the typical action, Stop is rare, Start is rarer. Live treats all 3 as peer | Render only Restart at top-level; Start/Stop in an overflow menu |
| LOW | `RuntimeRoutePage.tsx:932` empty state | "No operator attention items right now." | Slightly awkward phrasing; mockup's status-strip equivalent is `● 2 pending · 4m on oldest` (always shown). When empty, the live page hides Needs Attention entirely (`:931-933` `items.length === 0`) | Either keep the empty state (it's friendly) or hide the whole card when empty |

#### Consistency

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `RuntimeRoutePage.tsx` (whole file) | Uses `StatusChip` in 3 locations (`:562-595`), `ThreePartChip` in 2 (`:836-841` activity feed, `:938` needs-attention) | Better adoption than Approvals, but the runtime card's status row should be 3-part chip (see Visual hierarchy above) | Migrate `:562-595` to `ThreePartChip` for daemon (single chip with state/host/uptime); keep `StatusChip` for backup + controllable |
| MEDIUM | `RuntimeRoutePage.tsx:589-595` | `tone={data.daemon?.controllable ? "default" : "muted"}` — both tones are visually quiet | The contract should be: `controllable === true` is the happy path → tone `success` or `live`; `controllable === false` is operator-visible → tone `warning`. Right now both look like noise | Re-map tone: controllable → success; not-controllable → warning |
| MEDIUM | `RuntimeRoutePage.tsx:557-560` `mc-next-runtime-notice` | Notice tones: `success`/`warning`/`error` (from CSS `:858-868`) | Uses 3rd tone name `error` while `StatusChip` uses `critical`. Two systems for the same red | Pick one. `critical` is canonical per StatusChip; rename to match |
| MEDIUM | `RuntimeRoutePage.tsx:622-647` daemon buttons | `gc-button` / `gc-button danger` / `gc-button subtle` className system | Same as Approvals — consistent within Ops. Cross-cutting issue: `gc-button` lives in legacy mission-control css, not native-routes css. Tracks with r4-ux CC-018 (no semantic variants) | Move `gc-button` family into mission-control-next; create `mc-next-button-{primary,secondary,danger,subtle}` variants per CC-018 |
| LOW | `RuntimeRoutePage.tsx:1019-1037` `labelForOpsSection` and `:1251-1270` `descriptionForOpsSection` | Hand-rolled section→label and section→description switches | These belong on the rail config (`RAIL_ITEMS`) so the section name and description don't drift from the rail label | Hoist into route-model.ts as `ROUTE_LABELS[area][section]` |

#### Accessibility

| Severity | Location | Observed | Why | Suggested direction |
|---|---|---|---|---|
| HIGH | `RuntimeRoutePage.tsx:825-846` activity feed | `<ul aria-label="Activity feed">` — no `aria-live`, no `role="log"`, no `role="feed"` | New events should be SR-announced when they arrive. Currently they appear silently (and they don't even arrive because polling is broken) | Add `role="log" aria-live="polite" aria-relevant="additions"` |
| HIGH | `RuntimeRoutePage.tsx:803-820` activity filter | `role="radiogroup"` correctly set. Each button: `role="radio" aria-checked={...}`. Good | n/a | Verify keyboard navigation: arrow keys should move between radios per WAI-ARIA. Test this |
| HIGH | `RuntimeRoutePage.tsx:557-560` `runtime.notice` | Notice div has no role, no aria-live | When `runDaemonAction` sets a notice (`:150-154`), SR users don't hear it | Add `role="status" aria-live="polite"` to the notice container |
| MEDIUM | `RuntimeRoutePage.tsx:286-322` (schedules form), `:347-411` (automation designer) | Form fields use `<label>` wrappers with `<span>` titles — no explicit `htmlFor`/`id` | Same pattern as Settings. SR will read the field by its placeholder if the label association is fragile | Add explicit `htmlFor`/`id` |
| MEDIUM | `RuntimeRoutePage.tsx:934-953` `OpsNeedsAttentionCard` | `<li>` items render `ThreePartChip` + `<p>` body + 2 buttons. The list has `aria-label="Needs attention"` (good) | But each `<li>` doesn't expose its tone semantically. The `tone-{tone}` className tints visually but SR users don't hear the severity | Add `aria-label={`${item.title} (${item.tone === "danger" ? "critical" : item.tone})`}` to each `<li>` |
| LOW | `RuntimeRoutePage.tsx:822-823` empty state for activity | `<p className="mc-next-directory-empty">No recent events.</p>` | Same as Approvals — should use `EmptyState` primitive | Adopt `EmptyState` with `size="compact"` |

### Mockup-vs-live gap

**Mockup promises Runtime doesn't deliver:**

| Promise | Mockup ref | Live state |
|---|---|---|
| Stage h1: "Daemon up 4h 12m. Spend on pace." (live signal in the title) | `runtime.html:179` | `RuntimeRoutePage.tsx:905-906` ships hardcoded section name as h1; description is a feature description not a status |
| Three-part health chip (state / host / uptime) in the page head | `runtime.html:183-187` | Live ships 3 separate `StatusChip` pills inside the Runtime section card, not the page head |
| 4-cell health strip: Daemon uptime · Spend today · Active sessions · Last backup | `runtime.html:195-216` | Live's `headMetrics` (`:1227-1232`) for runtime section ships Daemon/MCP/Backups/Pending approvals — overlaps but never shows "Spend today" or "Last backup" at the page-head level |
| Stacked-bar 7-day spend chart with anomaly callout (May 12 spike · library route +$2.18 ...) | `runtime.html:219-314` | Absent. Costs section is a list |
| Activity feed with severity-tinted badge column (small icon in colored box) | `runtime.html:332-393` | Live uses `ThreePartChip` for the whole row; no separate icon column. Mockup ships an inline `<svg>` badge with severity tint |
| Pause button on the realtime feed (`runtime.html:329-331`) | n/a | Absent |
| Schedule creator with live cron preview | `runtime.html:402-438` | Absent — schedule form has 3 fields + a button, no preview |
| "Test once" action on the schedule creator | `runtime.html:443` | Absent |
| Status strip footer (`● daemon up 04:12:48 · ws-mac-01`) | `runtime.html:452-458` | Absent — no global status strip in MC Next |
| Filter chips on activity (`All 142 · Errors 3 · Approvals 11 · Runtime 42`) showing counts | `runtime.html:323-328` | Live ships filter labels only — no counts (filter buttons at `:805-820` don't pass count) |

**Live features not in mockup that should stay:**

- 8 sub-sections under one route (Activity / Sessions / Schedules / Improvement / Costs / Runtime / Diagnostics / Notifications) — production reality.
- `OpsNeedsAttentionCard` (`:917-955`) — the "exception inbox" pattern is genuinely useful and bridges Activity → action.
- `Automation Designer` (`:336-411`) — drafts a reviewable recipe without auto-creating cron. Honest advisory mode.
- Source-availability metadata (`sourceFailed(data, "daemon")`) propagating into chip tones (`:563-595`) — when the API errors, the UI tells the truth instead of showing stale-but-confident values.
- Per-section head metrics that adapt to context (`buildOpsHeadMetrics` `:1184-1248`).

### Primitive adoption

| Primitive | Used? | Where | Should use more? |
|---|---|---|---|
| `StatusChip` | YES (3×) | `:563`, `:570`, `:589` | Good. Should re-tone the "Controllable / Read only" pair (see Consistency) |
| `ThreePartChip` | YES (2×) | `:836-841` (activity row), `:938` (needs-attention) | Daemon chip row at `:562-596` should be ONE 3-part chip (state/host/uptime), not 3 separate `StatusChip`s |
| `StageHeader` | NO | Uses `NativePageFrame` instead | Same finding as Approvals — `NativePageFrame` and `StageHeader` both exist; pick one |
| `EmptyState` | NO | `:617, 823, 932` all use `mc-next-directory-empty` | Adopt `EmptyState` with primary CTA (e.g. "Refresh activity") |
| `ContextStrip` | NO | n/a | Not a fit |
| `ModeBar` | NO | n/a | Not a fit |
| `MetricGrid` (local) | YES | `:957-969` | Local component used 4× in this file. Could be hoisted to a shared primitive — same shape as Approvals' decision-context strip |

### What works well

1. **`OpsNeedsAttentionCard` is a genuine triage primitive** (`:917-955`). The card surfaces pending approvals + daemon issues + backup posture + scheduler queue + spend coverage + failed events in one ranked list with primary + inspect actions per item. This is the closest thing to a Linear inbox in the codebase.
2. **Source-failure honesty propagates to chip tone** (`:563-595`). When `sourceFailed(data, "daemon") && sourceFailed(data, "health")` both error, the daemon chip says "Daemon unavailable" with critical tone. When only one source errors, the chip reads the other. This is exactly the "stale data communicated" promise from ship-bar F-203, partly delivered.
3. **Activity filter is `role="radiogroup"` with `aria-checked`** (`:803-820`). Not many filter strips in the codebase get this right.
4. **`OpsNeedsAttentionCard` items have BOTH a primary and inspect route** (`:941-948`). One click goes to the canonical surface; one click goes to a related diagnostic. Operators don't have to guess which route is correct.
5. **`runtime.notice` is rendered with a tone class** (`:558-560`) — `tone-success / tone-warning / tone-error`. The CSS at `native-routes.css:858-868` wires border colors per tone. Not perfect (notice has no role), but the pattern is right.
6. **Schedules has BOTH a manual create form AND an advisory automation designer** (`:280-411`) — explicit acknowledgment that drafting cron from intent is different from creating one. The Automation Designer is `Mode: Advisory · Cron created: No` (`:341-344`), preventing accidental schedule mutation.

---

## Cross-surface observations

### Polling asymmetry

- **Approvals**: polls every 15s via `useRefreshSubscription("approvals", load, { pollIntervalMs: 15000 })` (`useApprovalQueue.ts:132-143`).
- **Runtime**: does not poll. `useOpsRuntimeSnapshot.ts:103-129` runs `load()` once, only re-runs on action.

This is the single biggest cross-surface bug. The "Ops" area's two named live-monitoring surfaces have inconsistent staleness models. **Runtime should match Approvals' polling pattern, and ideally both should drop to ~5s for an ops feed.** A 15s lag on approval visibility is bordering on too slow given the brand-spec's "4-minute window on the oldest" urgency framing.

### `ThreePartChip` adoption

Brand-spec.md:75 names the 3-part chip the canonical primitive for "live monitoring surfaces (runtime, approvals)". Adoption count across both files:

- Approvals: 1 usage (queue items still use `StatusChip`)
- Runtime: 2 usages (daemon row still uses 3 separate `StatusChip`s)

The pattern WAS migrated — primitive exists, both files import it — but the migration is incomplete. The brand-spec promise that these surfaces would visually distinguish themselves from the rest of Mission Control via the 3-part chip is partly broken. Both files need a pass to convert risk/status/time triples into 3-part chips.

### `StageHeader` vs `NativePageFrame` duplication

Both Approvals and Runtime use `NativePageFrame` (`NativeRoutePageLayout.tsx:14-124`), which renders kicker + title + description + metrics + actions. The `StageHeader` primitive (`primitives/StageHeader.tsx`) does the same thing with a slightly different CSS class (`mc-next-stage-head` vs `mc-next-directory-header`). The brand-spec's stage-header rhythm and area-tinted top stripe live in BOTH classes (CSS at `primitives.css:9-53` and `native-routes.css:49-98`). Duplicate code, duplicate styling rules. Pick one.

### `EmptyState` primitive completely unused on these surfaces

Both files reach for `<p className="mc-next-directory-empty">` 5+ times. The `EmptyState` primitive exists, has theme + tone + size + action slots, and is even tested (`EmptyState.tsx`). But it's not exported from `primitives/index.ts` (line 1-15: only StageHeader / ThreePartChip / ContextStrip / ModeBar / StatusChip). That's a one-line fix. Then adopt across both files.

### Button system fragmentation

Both files use `gc-button` family from legacy mission-control css (`apps/mission-control/`). Variants in active use:
- `gc-button` (primary)
- `gc-button danger`
- `gc-button subtle`

There's no `mc-next-button` system documented in native-routes.css. Per r4-ux's CC-018, this is a known gap. Cross-cutting issue, not specific to Approvals/Runtime — but both pages depend on legacy classnames.

### Live feed semantics

Neither file wires `role="log" aria-live="polite"` on its primary live container:
- Approvals queue list (`ApprovalsRoutePage.tsx:159-215`)
- Activity feed (`RuntimeRoutePage.tsx:825-846`)

Mockup design intent (Runtime's pause button at `runtime.html:329-331`) implies a streaming feed pattern. The ARIA pattern for that is `role="log"` + `aria-live="polite"` + `aria-relevant="additions"`. Neither file uses any of those attributes. F-006 ship-bar accessibility promise broken for these two surfaces.

### Reference standard comparison

**Approvals vs Linear inbox triage rhythm:**

| Capability | Linear inbox | Live Approvals |
|---|---|---|
| Single-key actions (e.g. `e` archive, `Y` close) | YES | NO (no keyboard shortcuts beyond Tab) |
| Master-detail with arrow-key navigation | YES (`j/k`) | NO (mouse-only item selection) |
| Bulk-select with `x` per row | YES | Partial (Reject all only) |
| Real-time updates with visual cue on new items | YES (count badge animates) | NO (count updates without animation; new items appear silently) |
| Filter pills with live counts | YES | Tab labels carry counts but no chip-based filters |
| Quick-actions on hover (Snooze / Archive / Mark unread) | YES | NO (only inline open/replay) |
| Inbox zero state with affirmation copy | YES ("You're all caught up!") | "No approvals in this view." (utilitarian) |

**Runtime vs Vercel deployments / GitHub Actions runs:**

| Capability | Vercel / GH Actions | Live Runtime |
|---|---|---|
| Status pill with live pulse animation | YES (Vercel "Building..." pulses) | Partial — `StatusChip` has a `live` tone with pulse keyframes (`primitives.css:555-580`), but Runtime never uses it |
| Per-deployment timing details (build time, region, environment) | YES | Partial — host + PID + uptime in metric grid |
| Stacked timeline view of recent runs | YES | NO (activity feed is flat list, not timeline) |
| Filter by status / branch / actor | YES | Filter by event class (all/errors/approvals/runtime) — coarser |
| Per-run logs with collapsible groups | YES | Diagnostics shows last 8 daemon log lines, no grouping |
| Re-run / cancel from the list | YES | NO (Daemon Start/Restart/Stop is global, not per-event) |
| Cost / quota indicators near deployment list | YES (Vercel shows function invocations) | Costs lives in a separate section |
| Live polling with last-updated badge | YES (Vercel updates every ~5s; shows "Updated 3s ago") | **NO** — RuntimeRoutePage doesn't poll at all |
