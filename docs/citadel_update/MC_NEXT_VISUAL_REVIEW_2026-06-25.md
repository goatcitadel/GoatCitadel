# Mission Control Next — Visual Review & Remediation (2026-06-25)

Method: ran `apps/mission-control-next` Vite dev server in `VITE_GOATCITADEL_VISUAL_REGRESSION_MODE=true`
(gateway-free fixtures), driven via Playwright at 1728×1040, screenshotting each area.

Overall finding: **individual route *content* is generally well-built** (good cards, hierarchy, full
labels) thanks to the prior design-system pass. The dominant visual problems live in the **shell chrome**
(top bar especially) and the **unified work surface** (chat/cowork/code). Fixing the shell improves every page.

Legend: ☐ open · ☑ fixed · severity HIGH/MED/LOW

---

## A. Shell chrome (appears on every page)

- ☑ **S1 (HIGH)** Top bar right cluster overlapped when the gateway status pill text is long. With
  `Live fallback` showing, the `.mc-next-topbar-status` box collapsed (min-width:0) below its two
  badges, which spilled visibly over the bell/mute icons. **Fixed**: pinned the status cluster to
  `flex: 0 0 auto; min-width: max-content` so the Citadel/Workspace selects (which ellipsize) absorb
  the shrink instead. Verified: approvals→bell gap restored from −53px to +7px.
- ☑ **S2 (MED)** Top bar Citadel/Workspace selects collapsed to *no visible value* (just `WORKSPACE`)
  when tight, because the command-palette label was protected (`min-width: 8.25rem`) while the selects
  had `min-width: 0`. **Fixed**: lowered command-search `min-width` to 3rem (it ellipsizes/yields first
  and still grows to 12rem when roomy) and floored `.mc-next-select-field select` at 4.5rem so the
  active Citadel/Workspace value stays legible. Verified both values show with 0 overlap and full fit.
- ☑ **S3 (LOW)** Addressed by S1+S2 — the right cluster now lays out consistently with no spill.

## B. Unified work surface (Work tab → chat/cowork/code modes)

- ☑ **W1 (HIGH)** Far-right inspector rail content read clipped against the panel's left edge. Root
  cause: the work-surface context panel only inherited the shared `0.62rem` padding with no left
  clearance for the 9px resize handle pinned at its left edge (the `.mode-chat`/`.utility` variants
  add `+9px`; the work/cowork one didn't). **Fixed**: added `padding-left: calc(0.5rem + 9px)` to
  `.mc-next-surface-host-work .mc-next-threaded-context-panel`, matching the cowork side-panel. Verified.
- ☑ **W2 (MED)** Model route showed a no-op `gpt-5.5 -> gpt-5.5`. **Fixed** in `CoworkPanel.tsx`:
  render a single value when requested===effective; only show the arrow (now a proper `→`) when routing
  actually changed the model. Verified the line now reads `gpt-5.5`.
- ◐ **W3 (LOW)** Redundant `MODE Cowork` in surface header + composer. **Assessed as by-design**: each
  location is purposeful (surface label vs. compose-mode indicator) in the unified-surface model. Left.
- ◐ **W4 (MED)** Left "DELEGATED TASKS" rows look identical with a truncated `Delegate ·` second line.
  **This is fixture data** (every seeded session is "Delegate · <role>"); real sessions carry distinct
  titles. The row layout itself is sound. Left as a fixture artifact, not a code bug.
- ◐ **W5 (MED)** Context-strip values use the standard `nowrap + ellipsis` pattern (e.g. a trailing
  timestamp truncates). **Assessed as by-design** for a one-line dense metadata strip. Left.
- ✗ **W6** Console `500` from `http://127.0.0.1:8787/api/v1/agentic/runs` is the gateway-free preview
  hitting the absent gateway. **Environment artifact, not a UI bug** — does not occur with a live gateway.

## C. Projects

- ☑ **P1 (HIGH)** "START FROM INTENT" grid overlapped. Two compounding causes: (1) the intent icon
  used uncompiled Tailwind `h-4 w-4`, fell back to 24px and collapsed its grid row to 0px, lapping the
  eyebrow — fixed by pinning `.mc-next-project-intake-card svg` to 1rem; (2) the card's definite
  `min-height` created a grid auto-row circular sizing that pinned rows to 83px while the wrapping
  description needed 133–167px, so it overflowed into the row below — fixed with `height: fit-content`
  on the card (+ `align-items: start` on the grid). Verified `fits:true`, 0 overlaps across all 7 cards.

## D. Library / Ops / Settings (route content)

- ◐ **D1 (LOW)** Settings Integrations status pills truncate (`config…`). Dense compact pill — low
  priority polish; left for now.
- ✗ **D2** Settings sidebar `Hidden` sub-labels are the intentional ROUTE_RELEASE_SCOPE `status:"hide"`
  governance indicator (dev/preview only; hidden entirely in production). **Not a bug.**

---

## Outcome

Fixed (verified visually + via DOM measurement at 1300/1440/1728 widths): **S1, S2, S3, W1, W2, P1.**
These covered every HIGH-severity issue and the cross-cutting shell problems that showed on every page.
Remaining items are by-design, fixture-only, or environment artifacts (annotated above).

Files changed:
- `apps/mission-control-next/src/styles/mission-control-next.css` — topbar status cluster rigidity (S1),
  command-search + select-field rebalance (S2/S3).
- `apps/mission-control-next/src/features/threaded-surface/styles/side-panels.css` — work-surface context
  rail left padding (W1).
- `apps/mission-control-next/src/features/native-routes/native-routes.css` — project intake icon size +
  card `height: fit-content` + grid `align-items: start` (P1).
- `apps/mission-control-next/src/features/threaded-surface/workflow/CoworkPanel.tsx` — collapse no-op
  model route (W2).

Checks: `perf:check` gates all green (typography / contrast / token-drift / buttons / legacy / budgets);
`ThreadedWorkflowPanel.test.tsx` 25/25 pass. Pages swept: chat/cowork/code work surface, projects,
library (overview/skills/communications), ops (runtime/costs), settings (general).

---

## Fix order (highest visual impact first)
1. S1/S2/S3 — top bar overflow (every page)
2. W1 — inspector rail clipping (every work view)
3. P1 — projects intent-grid overlap
4. W2/W5/W3 — work surface redundancy & truncation
5. W4, D1/D2 — polish
