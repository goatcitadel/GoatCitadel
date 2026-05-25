# Mission Control Next — ship bar

**Date:** 2026-05-24
**Purpose:** Define what "shippable" means for `apps/mission-control-next` so the review can rank findings against a fixed bar instead of subjective taste.

This is Phase 0 of the ship-readiness review. Tracks A/B/C/D file findings; this doc decides which findings block ship.

---

## Shipping definition

`mission-control-next` ships when:

1. **Every must-work flow** (below) completes without UI-visible errors on a clean profile, on the two reference viewports (1440×900, 1280×800), on Signal Noir + Citadel Light themes.
2. **Zero CRITICAL findings remain open** across r4-ux + this review.
3. **Zero HIGH findings remain open** in the categories `a11y blocker`, `data integrity`, `dead UI` (component references styles that don't exist), and `state communication` (user can't tell what's happening).
4. **HIGH findings outside those categories** are accepted as known debt only with an owner-signed waiver in the punchlist (Phase 5).
5. **Mockup-vs-live gap closed** for the wayfinding primitives that brand-spec.md treats as system-level: area accents, 3-part risk chip, stage header rhythm, area-tinted top stripe.
6. **No regressions** vs the current baseline screenshots (Phase 0 capture, see below) on the must-work flows.

Polish, motion, and density refinements are *post-ship*. They don't block; they get scheduled in increments after ship.

---

## Severity rubric (matches r4-ux precedent)

| Severity | Definition | Ship behavior |
|---|---|---|
| **CRITICAL** | Blocks a must-work flow OR breaks an a11y promise OR data-integrity bug visible in UI | **Blocks ship.** Fix before merge. |
| **HIGH** | Erodes user trust, defeats a marketed promise ("snappy as Claude", "best response regardless of model"), or hides a state the user needs | **Blocks ship** in the four categories listed above (a11y, data integrity, dead UI, state comms). **Waivable** otherwise. |
| **MEDIUM** | Notable hierarchy / consistency / scan-ability issue. Reasonable users notice. | **Does not block.** Scheduled in 1-week increments after ship. |
| **LOW** | Polish, microcopy, density tweaks | **Does not block.** Backlog. |
| **NIT** | Subjective; opinion-only | Not actioned unless owner explicitly endorses. |

**Confidence** is reported separately. A HIGH-low-confidence is not actionable until verified.

---

## Must-work flows

For each, the user can complete the flow without a console error, an unrecoverable state, an unannounced delay >2s, or a visible style fallback (e.g. unstyled blue link).

### Cross-surface
- **F-001** App boots from a clean profile (no localStorage). Lands on a sensible default route. No console errors on first paint.
- **F-002** Switch route via rail. Active state updates. Area accent updates. URL updates.
- **F-003** Open command palette (if exists), search, select an action. Falls back gracefully if no palette.
- **F-004** Theme switch Signal Noir ⇄ Citadel Light. No FOUC, no token leakage (e.g. dark colors on light bg), no broken contrast on text.
- **F-005** Keyboard-only navigation through rail → main → composer → action buttons. Focus visible at every stop. No focus traps.
- **F-006** Screen reader (NVDA on Win, VoiceOver on Mac) names every interactive element and announces route changes.
- **F-007** Resize from 1440 → 1024. No horizontal scroll. No truncated CTAs. Compact layout (if claimed) actually responds.
- **F-008** Offline / gateway-down recovery. Banner appears, user can retry, reconnection restores prior state.

### Threaded surface (Chat / Cowork / Code)
- **F-101** Send a chat turn. Streaming visible. Stop button works. Streamed text is SR-announced.
- **F-102** Switch model. New model badge visible in composer. Model picker shows context-window + cost + capability data (per r4-ux CHAT-004).
- **F-103** Click a citation. See the source. No dead-end "12 citations" labels.
- **F-104** Use Cmd/Ctrl+Enter, Esc, ArrowUp-recall, Cmd/Ctrl+K — all canonical shortcuts.
- **F-105** Open Cowork side. Identify the primary live signal in <2s. Approvals row is visually the heaviest element.
- **F-106** Open Code side. Open a file, edit, save. Rename / create flows work. Pane sizes persist.

### Native routes
- **F-201** Settings: find a setting in <10s without scrolling the rail off-screen. Save state communicated. Dangerous actions distinguished.
- **F-202** Approvals: identify pending approvals at a glance. Approve / deny in 2 clicks max. Live updates without page refresh.
- **F-203** Runtime: see live status of every component. Stale data communicated. 3-part chip (dot/state/age) per brand-spec.
- **F-204** Memory: read, search, edit a memory. No data loss on tab switch.
- **F-205** Projects: list, open, navigate to project surfaces.
- **F-206** Prompt Packs: list, open, run, see output.

---

## Reference standards per surface

To eliminate "is this good enough?" arguments. Findings are graded against the reference, not perfection.

| Surface | Reference |
|---|---|
| Chat | Claude.ai web (composer ergonomics, citations, model picker) |
| Cowork | Linear's run/status panels (hierarchy, density, live signals) |
| Code | Cursor / VS Code (Monaco baseline; keyboard, file ops, pane persistence) |
| Settings | Notion settings (search, IA depth, save semantics) |
| Approvals | Linear inbox (triage rhythm, batch actions) |
| Runtime | Vercel deployments / GitHub Actions runs (status density, live state) |
| Memory | Obsidian + Notion linked DB hybrid |
| Projects | Linear projects |
| Prompt Packs | (no good reference — judge against brand-spec mockup only) |

---

## Baseline capture

Two reference screenshots already at repo root:
- `cowork-panel-phase2.png` — current Cowork pane state
- `low-chrome-chat-current.png` — current chat with reduced chrome

**TODO before Phase 5:** capture clean baselines for every must-work flow at 1440×900 + 1280×800 + 1024×768, both themes. Use Playwright (already in `.playwright-cli/`). Store in `docs/review/baselines/2026-05-24/`.

This is deferred because the cross-cutting fixes will move pixels — better to baseline the *post-fix* state than to baseline now and chase diffs.

---

## How this doc is used

- **Track A** (backlog adjudication) applies this rubric to existing r4-ux findings.
- **Track B** (per-surface fresh walks) applies this rubric to new findings.
- **Track C** (cross-cutting) applies this rubric to system-level findings.
- **Track D** (legacy retirement) does not file UX findings; it produces a kill plan.
- **Phase 5** (merge) groups every finding from A+B+C by ship-blocker / waivable-with-signoff / post-ship.

Anything not blocking by this rubric is by definition *not blocking*. The bar is fixed before findings are filed so we can't move the goalposts mid-review.
