# Mission Control Next — ship punchlist

**Date:** 2026-05-24
**Rubric:** [`mission-control-next-ship-bar.md`](mission-control-next-ship-bar.md)
**Source reviews:**
- [`mission-control-next-backlog-status.md`](mission-control-next-backlog-status.md) (Track A — r4-ux adjudication: 52 findings)
- [`mission-control-next-fresh-settings.md`](mission-control-next-fresh-settings.md) (Track B-Settings)
- [`mission-control-next-fresh-ops.md`](mission-control-next-fresh-ops.md) (Track B-Ops)
- [`mission-control-next-fresh-library.md`](mission-control-next-fresh-library.md) (Track B-Library)
- [`mission-control-next-cross-cutting.md`](mission-control-next-cross-cutting.md) (Track C)
- [`legacy-mission-control-retirement-plan.md`](legacy-mission-control-retirement-plan.md) (Track D — independent of ship)

---

## Status snapshot

| Tier | Count | Action |
|---|---|---|
| **CRITICAL ship-blockers** | 1 | Fix before merge |
| **HIGH ship-blockers** (a11y / data integrity / dead UI / state comms) | 13 | Fix before merge |
| **HIGH waivable** (wayfinding / scan-ability — defeats marketed promise but not data-integrity) | 7 | Owner sign-off w/ post-ship date, else fix |
| **MEDIUM** (notable, not blocking) | ~12 | Phase 3 / post-ship |
| **LOW + NIT** | ~15 | Backlog |
| **Closed in this review cycle** (commit `3ab0b283`) | 7 | — |
| **Pre-existing closed** (per Track A adjudication) | ~12 | — |

---

## CRITICAL ship-blockers

### C-1 — Runtime page is showing frozen data, not live
**Source:** B-Ops fresh review (RT-1)
**Location:** `packages/mission-control-shared/src/hooks/useOpsRuntimeSnapshot.ts:103-129`
**Observed:** Single-fire `useEffect` with no interval. The page consumed by `RuntimeRoutePage.tsx` is marketed as live runtime status but never re-fetches after mount.
**Why ship-blocker:** Direct fail of `F-203` must-work flow ("see live status of every component. Stale data communicated."). Operators looking at "live" telemetry are looking at stale data with no warning.
**Fix:** Add polling interval (15s mirrors `useApprovalQueue`) + visibility-aware pause when tab is hidden + last-update timestamp surfaced in UI.
**Task:** #20

---

## HIGH ship-blockers (a11y / data integrity / dead UI / state comms)

### H-1 — `.gc-button` is unstyled across 25 shared components
**Source:** Track C cross-cutting (TC-1)
**Location:** 25 components in `packages/mission-control-shared/src/components/` (ChatComposerPlusMenu, InlineApprovalPrompt, CodeWorkbenchPanel, ChatThreadView, ChatTraceCard, EventCard, SurfaceReconnectBanner, ChatQueueBar, ChatSessionRail, StatusStrip, SmartPathInput, SelectOrCustom, RemoteApprovalActionModal, PageErrorBoundary, NotificationStack, HelpHint, GatewayAccessGate, DevDiagnosticsPanel, DeviceAccessApprovalModal, CommandPalette, ConfigFormBuilder, ChatPendingUserInputPanel, PixelOfficeCanvas, CoworkCanvasPanel, ChatToolArtifactInspector)
**Observed:** `className="gc-button"` emitted by all 25, but ZERO CSS rule defines `.gc-button` anywhere in `apps/mission-control-next/src/` or `packages/mission-control-shared/src/`. Every button renders as a default browser button (gray, beveled, system font).
**Why ship-blocker:** Dead UI — single most visible degradation across the app. Every modal, banner, panel, palette currently ships with unstyled action buttons.
**Fix:** Add canonical `.gc-button` baseline (variants for primary/secondary/danger) in `apps/mission-control-next/src/styles/` using tokens. **Single CSS rule fixes 25 components at once.**
**Task:** #18

### H-2 — Streaming assistant text is not announced to SR (partial)
**Source:** r4-ux CHAT-002, Track A adjudication says PARTIAL
**Location:** `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx`
**Observed:** A live region exists but the streaming content doesn't go through it; only the static status bar is announced.
**Why ship-blocker:** a11y blocker. SR users hear "Streaming…" once then silence.
**Fix:** Route streaming chunks through the live region or add `aria-live="polite" aria-busy={running}` to the assistant bubble until completion.

### H-3 — `:focus-visible` is nullified on textarea + turn surface
**Source:** r4-ux CHAT-016, Track A says still-broken
**Location:** composer textarea + turn surface CSS
**Observed:** `outline: none` overrides defeat the canonical focus ring.
**Why ship-blocker:** a11y. Keyboard-only users can't see where focus is.
**Fix:** Remove `outline: none` overrides; restore `:focus-visible` ring tinted with `--brand` or `--area-color`.

### H-4 — Tab `role`/`aria-selected` missing
**Source:** r4-ux COWORK-013 + CODE-009, Track A still-broken
**Location:** tab UIs in Cowork + Code workbench
**Fix:** Add `role="tab" / role="tablist" / role="tabpanel"` + `aria-selected`.

### H-5 — Combobox listbox aria missing
**Source:** r4-ux CHAT-020, Track A still-broken
**Location:** command suggestion popovers
**Fix:** Wire `role="combobox" / role="listbox" / aria-expanded / aria-activedescendant`.

### H-6 — Approval has no autofocus / scroll-into-view
**Source:** r4-ux COWORK-004, Track A still-broken
**Location:** approval surfacing in Cowork
**Fix:** When a new approval appears, scroll into view + move focus to primary action.

### H-7 — Shell-level keyboard model absent
**Source:** Track C initial scan
**Location:** `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (1278 lines, zero `keydown` handlers)
**Observed:** No Cmd+K, no Esc dismiss, no route-jump shortcuts. Composer-level shortcuts (CHAT-001) shipped, but the shell is keyboard-dead.
**Why ship-blocker:** a11y + ship-bar F-005 (keyboard-only navigation).
**Fix:** Build shell keyboard manager (Cmd/Ctrl+K palette, Esc dismiss, g+letter route jump). Surface affordances via new `KbdHint` primitive.

### H-8 — MemoryRoutePage has zero ARIA across 986 lines
**Source:** B-Library
**Location:** `apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx`
**Observed:** No `aria-pressed`/`aria-current` on selectable list; form inputs lack `htmlFor`/`id` linking.
**Why ship-blocker:** a11y. Whole surface is invisible to SR.
**Task:** #22

### H-9 — Settings: zero unsaved-state plumbing
**Source:** B-Settings
**Location:** `SettingsNativePage.tsx` (8842 lines, no `dirty` / `hasChanges` / `beforeunload`)
**Observed:** Edit a form, navigate away, lose changes silently.
**Why ship-blocker:** Data integrity. Direct fail of F-201 must-work flow.
**Fix:** `useFormDirty` hook per section + section-header "unsaved" indicator + nav guard.

### H-10 — Approvals: no live-update communication
**Source:** B-Ops AP-1
**Location:** `useApprovalQueue.ts:141` polls (15s), but `ApprovalsRoutePage.tsx:159-215` has no `aria-live` / animation / count flash
**Why ship-blocker:** State comms. Operators don't know a new approval landed.
**Fix:** `aria-live="polite"` on the queue + new-item flash animation + tab badge.

### H-11 — Approvals: no decision-context strip in inspector
**Source:** B-Ops AP-2
**Location:** Mockup `approvals.html:309-326` ships Scope / Actor / Reversible? / Prior verdicts table; live ships kicker + title only at `ApprovalsRoutePage.tsx:469-498`
**Why ship-blocker:** Operators triage blind. Reversibility is the most important decision input.
**Fix:** Render the 4-row decision-context table in the inspector.

### H-12 — Activity feed (Runtime) not `aria-live`
**Source:** B-Ops RT-2
**Location:** `RuntimeRoutePage.tsx:825-846`
**Fix:** Add `role="log"` + `aria-live="polite"` + `aria-relevant="additions"`.

### H-13 — Settings: rail leaf count is 14 not 12 (residual IA work)
**Source:** B-Settings
**Location:** `route-model.ts:374-473`
**Observed:** Onboarding, Permissions, Budget remain separate leaves; rail still spills below a 13" laptop fold. Target IA: Foundations(2)/Identity(3)/Surfaces(4)/Operations(3).
**Fix:** Merge per plan W3.2.

---

## HIGH waivable (defeats marketed promise; not data-integrity)

These can ship with owner sign-off + post-ship date per ship-bar rubric.

| ID | Item | Source | Recommended action |
|---|---|---|---|
| W-1 | Memory: namespace pills missing (primary IA cue per mockup — `all 37 / knowledge 22 / routing 14 / files 2 / scratch 9`) | B-Library | Backfill in W3.5 Phase 2 |
| W-2 | Projects: no pin/archive UI, no Pinned/Archived filters | B-Library | Backfill in W3.5 |
| W-3 | Projects: no cross-project "Recent sessions" row (mockup's "pick up where you left off") | B-Library | Backfill in W3.5 |
| W-4 | Projects: right-rail wrong shape (3 stacked CRUD forms vs card-level glyphs) | B-Library | Restructure in W3.5 |
| W-5 | Runtime: no spend chart (mockup ships 7-day stacked-bar w/ anomaly callout) | B-Ops | Build in W3.4 |
| W-6 | Approvals: `ThreePartChip` used once total; `StatusChip` everywhere instead | B-Ops | Adopt the brand-spec primitive in W3.3 |
| W-7 | Prompt Packs: editor is flat `<pre>`; mockup promises variable chips + syntax highlight | B-Library | Build in W3.5 (workbench showcase) |

---

## MEDIUM (post-ship, Phase 3)

- Settings "Find a setting" command palette missing (B-Settings) — needs shell Cmd+K manager (H-7 dependency)
- Memory: maintenance verbs (Flush/Optimize/Verify) buried two viewports down (B-Library)
- Prompt Packs: filter chip bloat (8 vs 4) + pass-rate buried as 3rd of 5 summary cards (B-Library)
- CSS budget overrun: 198316 vs 184320 bytes (Track C, task #16) — root-cause + trim
- W4.5 trim `mission-control-next.css` (1657 lines)
- Pre-existing `font-size: \d+px` violations (16 occurrences, Track C TC-3) — bump to `--text-xs` or codify `--text-2xs`
- W1.1 Phase B token sweep grandfathered files (task #15) — blocked on Citadel Light palette decision (task #19)
- W3.5 surface polish completion for Memory + Projects + Prompt Packs (waivables above are the heaviest)
- `useAutoGrowTextarea.ts` verification (Track C TC-7)
- 14 hex + 41 rgba hardcoded outside tokens (Track C)
- Cowork hierarchy: nine panels stacked without primary anchor (per r4-ux + screenshot evidence)
- CC-001 notifications missing auto-dismiss/animation (r4-ux/Track A still-broken)

---

## LOW + NIT (backlog)

- CC-013 disabled cursor (`cursor: not-allowed`)
- Various MEDIUM/LOW from r4-ux Track A still-broken bucket (not blocking ship)
- Code-health decomposition for NativeRoutePages (3369 lines, W4.2), CodeWorkbenchPanel (1774, W4.3), MissionControlNextApp shell (1278, W4.4) — quality bar, not ship bar

---

## Already landed (this review cycle, commit `3ab0b283`)

| ID | What | Workstream |
|---|---|---|
| L-1 | Settings rail icons + descriptions restored (CSS-hidden) | W2.5 |
| L-2 | Settings 2 destructive actions tinted danger | W2.5 |
| L-3 | `compactLayout` dead breakpoint removed | W2.3 |
| L-4 | Orphan baselines added: chat-stream-status-bar, surface-reconnect-banner, chat-approval-card | W2.3 |
| L-5 | `StatusChip` primitive shipped; 9 consumers migrated from shared | W1.2 + W2.3 (CHAT-014) |
| L-6 | `EmptyState` primitive shipped (adoption pending — task #21) | W1.2 |
| L-7 | Token unification Phase A: `--gc-*` and `--gc-risk-*` alias to canonical; guard script wired into `perf:check` | W1.1 |

---

## Pre-existing closed (per Track A adjudication)

Already fixed prior to this review cycle. Listed for confidence — these were r4-ux ship-blockers; no further work needed:

- CHAT-001 keyboard shortcuts ✓
- CHAT-003 citations as clickable list ✓
- CHAT-004 model picker rich metadata ✓
- CHAT-007 autosize textarea ✓
- CHAT-009 auto-scroll ✓
- CHAT-021 native confirm dialogs ✓
- COWORK-006 checkpoint timeline ✓
- CODE-001 Monaco shortcuts ✓
- CODE-006 unified diff toggle ✓
- CODE-008 validation history ✓
- CODE-010 grouped Code toolbar ✓
- CC-008 turn surface aria ✓

---

## Recommended ship sequence

Sized for execution clarity, not strict timeline.

### Sprint 1 — Stop the bleeding (highest-impact ship-blockers)
1. **C-1** Runtime polling (task #20) — single biggest lie in the UI
2. **H-1** `.gc-button` baseline (task #18) — single biggest visual fix
3. **H-9** Settings unsaved-state (data integrity)
4. **H-10** Approvals live-update aria + flash
5. **H-12** Runtime activity feed aria-live
6. **H-2** Streaming aria-live content (CHAT-002)
7. **H-3** Focus-visible restore (CHAT-016)

### Sprint 2 — Close the rest of the HIGH a11y + state comms
8. **H-4** Tab role aria (COWORK-013, CODE-009)
9. **H-5** Combobox aria (CHAT-020)
10. **H-6** Approval autofocus/scroll
11. **H-7** Shell keyboard model + Cmd+K palette
12. **H-8** Memory ARIA pass (task #22)
13. **H-11** Approvals decision-context strip
14. **H-13** Settings IA 14→12 merge

### Sprint 3 — EmptyState adoption + waivables decision point
15. Adopt `EmptyState` everywhere (task #21) — 30+ ad-hoc duplicates
16. Owner reviews W-1…W-7 waivables, signs off or schedules
17. CSS budget root-cause (#16)

### Post-ship rolling
- W4 decomposition (Settings → 12 files, PromptPacks → 14 files per B-Library map, shell extraction)
- W3.5 surface polish for waivables
- W5 legacy retirement Phase 0…4 (task #15 et al.)
- Cowork hierarchy redesign (mockup work or owner decision)

---

## Gate check before ship

- [ ] All CRITICAL closed
- [ ] All HIGH ship-blocker (a11y / data integrity / dead UI / state comms) closed or explicitly waived with rationale
- [ ] All must-work flows (F-001…F-206) green on Signal Noir + Citadel Light
- [ ] `pnpm --filter @goatcitadel/mission-control-next perf:check` green (or budget bump justified)
- [ ] Visual regression baselines captured for post-fix state
- [ ] Manual a11y pass (NVDA + VoiceOver + keyboard-only) on the 7 reference surfaces

Phase 4 (Track D legacy retirement) can land in parallel with Sprint 1–3 since the desktop is Path A (no-op) and unadjudicated legacy surfaces are decided "drop."
