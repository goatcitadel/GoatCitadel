# Mission Control Next — cross-cutting audit (Track C)

**Date:** 2026-05-24
**Reviewer:** main agent (not a subagent walk)
**Source:** Track C of the approved ship-readiness plan
**Scope:** System-level issues that per-surface walks (Tracks B-Settings/Ops/Library) won't catch.

This doc is the cross-cutting lane of the ship-readiness review. It accumulates findings from the initial 30-minute scan, the wave-1 dispatched work, and the post-commit deep-dives. Findings here feed W1 (design system), W2.1 (a11y), W2.3 (dead UI), and W4 (code health) of the approved plan.

---

## Token system — Phase A landed; Phase B blocked on design decision

### Status
- **Three token systems coexist:** `mission-control-next-tokens.css` (canonical), `mission-control-next-foundation.css` (`:root` shadcn-style + `--mc-radius-*`/`--mc-shadow-*`), `mission-control-next.css` (`--gc-*` area/risk + `--mc-*` surface/border/shell-bg/scrollbar).
- **Phase A alias indirection shipped in commit `3ab0b283`:** `--gc-area-*` and `--gc-risk-*` now resolve via `var(--area-*)` / `var(--risk-*)` to the canonical names. `--mc-area-color` setters updated to drop the `--gc-` middle hop.
- **Guard script wired:** `scripts/check-mission-control-next-token-drift.mjs` is in `pnpm tokens:check` and the `perf:check` chain. 5 grandfathered files allowlisted for Phase B.

### Phase B blocker — Citadel Light surface/border value divergence
`mission-control-next.css` and `mission-control-next-tokens.css` declare the SAME tokens with DIFFERENT values in Citadel Light:

| Token | next.css (Citadel Light) | tokens.css (Citadel Light) |
|---|---|---|
| `--mc-surface-1` / `--bg-surface-1` | `rgba(255,255,255,0.96)` | `#ffffff` |
| `--mc-surface-2` / `--bg-surface-2` | `rgba(248,250,253,0.98)` cool blue | `#eeeae0` warm cream |
| `--mc-surface-3` / `--bg-surface-3` | `rgba(236,241,248,0.98)` cool blue | `#e3ddd0` warm cream |
| `--mc-border-subtle` / `--border-subtle` | `rgba(30,41,59,0.12)` | `rgba(20,24,30,0.14)` |
| `--mc-shell-bg` / `--bg-app` | gradient + radial overlay | `#f5f3ec` solid |

**Decision needed before Phase B sweep:** which palette is the intended Citadel Light look — the cool-blue rgba (current rendered) or the warm-cream (canonical tokens declaration)? `brand-spec.md` describes "warm paper-white" and `--brand: #f4ead6` (cream-gold), suggesting tokens.css is closer to the brand intent.

**Owner action:** approve one palette, then Phase B (task #15) mechanically aliases the rest.

### Other token hygiene
- **14 hex + 41 rgba hardcoded** outside `tokens.css` / `foundation.css` declarations. Sweep is Phase B.
- **16 `font-size: \d+px`** violations of brand-spec's "do not introduce smaller hardcodes; the scale stays in rem" rule. Concentrated in `native-routes.css` (5), `primitives.css` (6), `prompt-packs-workbench.css` (3), `mission-control-next.css` (2). Most are 10px — sub-`--text-xs` (12px) floor. The 10px occurrences match the existing eyebrow/metric-label pattern (StageHeader, ThreePartChip) so they're stylistically intentional but rule-violating. Phase B decision: bump these to `--text-xs` (12px) or codify a `--text-2xs: 0.625rem` token at the floor.

---

## Primitive coverage matrix

### Exists today (`apps/mission-control-next/src/features/native-routes/primitives/`)
| Primitive | Status | Adoption |
|---|---|---|
| `StageHeader` | ✓ landed (50 lines) | Adopted by stage headers |
| `ThreePartChip` | ✓ landed (21 lines) | Adoption in Runtime/Approvals to be confirmed by B-Ops walk |
| `ContextStrip` | ✓ landed (53 lines) | Composer integration unverified |
| `ModeBar` | ✓ landed (46 lines) | Used in rail |
| `StatusChip` | ✓ landed commit `3ab0b283` | Adopted by 9 next-app files post-W2.3 |
| `EmptyState` | ✓ landed commit `3ab0b283` | Not yet consumed; first adoption planned in W2.2 (chat empty state) |

### Missing — needed for ship
| Primitive | Need | Source |
|---|---|---|
| `RiskChip` | Distinct from StatusChip — uses `--risk-*` tokens (safe/caution/danger/nuclear). Today, risk semantics get encoded in StatusChip's "warning"/"critical" tones, which conflates "this is dangerous" with "this is in a bad state". Brand-spec treats them as separate concepts. | brand-spec.md "risk semantics" section |
| `KbdHint` | Display keyboard shortcut affordances (`<kbd>Cmd</kbd>+<kbd>K</kbd>`). Shell-level keyboard model (W2.1) will need this. | W2.1 dependency |
| `AreaBadge` | Tinted micro-badge near route titles per brand-spec item 3 ("Area accent as wayfinding — extend it into a 1px top stripe on the stage and a tinted micro-badge near the route title"). Currently the rail link tints but no badge. | brand-spec.md "What I'm changing" #3 |
| `LoadingState` | Standardize spinner + skeleton across surfaces (one component, not bespoke per page). | W1.2 of plan |
| `ErrorState` | Standardize error UI (icon + title + description + retry action). Today every surface implements its own. | W1.2 of plan |
| `OfflineBanner` | Standardize offline / reconnect UI. `SurfaceReconnectBanner` exists in shared but the next-app reference is one of the orphan classes (now baselined via timeline.css per W2.3). Promote to primitive. | W2.3 partial |
| `MetricCell` | Dense `number + label + delta` cell used in Cowork + Runtime. StageHeader has `mc-next-stage-head-metric` inline; extract as a standalone primitive when Runtime/Cowork polish lands. | W3.4 hint |

### Pre-existing pattern question
StageHeader, ThreePartChip use 10px eyebrow/labels (`primitives.css:59,87,113`). My StatusChip uses `--text-xs` (12px floor per brand-spec). **Inconsistency**: pre-existing primitives violate the floor while new ones honor it. Decision needed: lift the existing primitives to 12px (visual change, may compress dense panels) or introduce `--text-2xs: 0.625rem` token at 10px and codify the floor at "no smaller than --text-2xs."

---

## Dead UI

### Closed (commit `3ab0b283`)
| Class | Status | Where |
|---|---|---|
| `.chat-stream-status-bar` + descendants | ✓ baselined | `timeline.css` |
| `.surface-reconnect-banner` + descendants | ✓ baselined | `timeline.css` |
| `.chat-approval-card` (bare) | ✓ baselined | `timeline.css` (scoped overrides preserved) |
| `.status-chip-*` (success/warning/critical/muted) | ✓ migrated | 9 consumers → `mc-next-status-chip` |
| `compactLayout` breakpoint dead toggle | ✓ removed | `ThreadedSurfacePage.tsx` |

### Still open
| Class | Where | Why deferred | Tracking |
|---|---|---|---|
| `.chat-v11-queue-bar` + descendants | emitted by `packages/mission-control-shared/.../ChatQueueBar.tsx`, rendered in next-app via composer | Adding CSS in next-app triggers legacy-check forbidden selector rule. Needs rename in shared component (3-app coordination). | Task #17 |
| **`.gc-button`** (NEW finding) | emitted by **25 shared components** (ChatComposerPlusMenu, InlineApprovalPrompt, CodeWorkbenchPanel, ChatThreadView, ChatTraceCard, PixelOfficeCanvas, CoworkCanvasPanel, ChatToolArtifactInspector, EventCard, SurfaceReconnectBanner, ChatQueueBar, ChatSessionRail, StatusStrip, SmartPathInput, SelectOrCustom, RemoteApprovalActionModal, PageErrorBoundary, NotificationStack, HelpHint, GatewayAccessGate, DevDiagnosticsPanel, DeviceAccessApprovalModal, CommandPalette, ConfigFormBuilder, ChatPendingUserInputPanel) | Zero CSS definition for `.gc-button` anywhere in mission-control-next or `packages/mission-control-shared`. Every button rendered by these 25 components currently shows as **default browser button** (gray, beveled, system font). This is a system-wide unstyled-buttons problem. | NEW — task to file |
| `.chat-approval-*` descendants (`chat-approval-header/title/tool/actions/countdown/reason/id`, `.is-expired`, `.is-low-time`) | scoped under `.mc-next-*-blocking-prompt` only | Bare instances render unstyled. Not in CHAT-013 scope. | Track as polish |
| `.chat-user-input-card`, `.chat-user-input-options`, `.chat-user-input-option-{row,copy,description}` | emitted by `ChatPendingUserInputPanel` | Scoped only inside blocking-prompt; bare instances unstyled. | Track as polish |
| `.office-status-chip`, `.office-status-{kind}` | emitted by `OfficeCanvas` in shared | No next-app usage today. May become live if Office surface is ported (per Track D decision D2 default: drop). | Drop with Office |

---

## Keyboard model

### Status
- **Composer-level shortcuts shipped** (CHAT-001 closed per Track A). Cmd+Enter, Shift+Tab, Escape, Arrow recall all wired in `useChatComposerInteractions.ts`.
- **Shell-level keyboard handlers: zero.** `apps/mission-control-next/src/app/MissionControlNextApp.tsx` has **no `keydown` / `onKeyDown` handlers anywhere in 1278 lines** (verified). No Cmd+K command palette. No Esc-to-dismiss inspector/drawer. No route-jump shortcuts (`g` then letter, Linear pattern).
- **Settings-level Cmd+K wrong target** (per Track B-Settings): `mc-next-command-search` opens the Context Inspector, not a Settings search picker.

### W2.1 needs
- Add a shell-level keyboard manager that:
  - Listens on `document` for key combos
  - Handles `Cmd/Ctrl+K` → command palette (currently doesn't exist; build alongside)
  - Handles `Escape` → close topmost dismissible (drawer > inspector > sheet > modal)
  - Handles `g` then `letter` → route jump
- Surface affordances via the new `KbdHint` primitive (W1.2 missing list)
- Document the model in `docs/MISSION_CONTROL_KEYBOARD.md` (new file)

---

## State communication primitives

Every surface eventually needs Empty / Loading / Error / Offline states. Current state:

| State | Coverage today | Plan |
|---|---|---|
| Empty | Each page implements bespoke empty markup. `EmptyState` primitive shipped commit `3ab0b283` but not yet consumed. | Migrate per-surface in W3.* |
| Loading | Mixed — spinners, skeletons, "loading…" text. No shared component visible. | `LoadingState` primitive in W1.2 |
| Error | `PageErrorBoundary` exists in shared and is composed at app root (`MissionControlNextApp.tsx:47`). Per-surface error states (e.g., "could not load") are ad-hoc. | `ErrorState` primitive in W1.2 |
| Offline | `SurfaceReconnectBanner` exists in shared, used in ThreadedTimeline. Other surfaces don't have an offline indicator. | Promote to `OfflineBanner` primitive |

**State matrix to compile** (W3 deliverable): per-surface × per-state grid showing which states are handled. Empty cells are gaps.

---

## CSS budget overrun

**Status:** `pnpm --filter @goatcitadel/mission-control-next perf:check` fails on the initial-shell CSS budget:

```
[perf-check:next] Initial shell CSS is 198316 bytes; budget is 184320 bytes.
```

13,996 bytes over. Pre-existing (predates the wave-1 work). My additions (`StatusChip` + `EmptyState` + their CSS) likely contributed ~3KB; subagent #13's orphan baselines added ~3KB more. Roughly 8KB pre-existed.

**Decision needed:** trim or bump.
- **Trim option** (preferred per ship-bar rubric): identify the heaviest sources in `mission-control-next.css` (1657 lines) and per-feature CSS, extract anything not needed in the initial shell. Aligns with W4.5.
- **Bump option**: raise the budget with explicit justification. Defeats the purpose unless paired with a roadmap.

**Tracking:** task #16.

---

## Out-of-scope-but-noted

These are accurate observations from the wave-1 work, scoped out of the immediate fixes but useful for future planning:

- **`packages/mission-control-shared/src/components/StatusChip.tsx` still emits `.status-chip status-chip-*`** — and a duplicate `apps/mission-control/src/components/StatusChip.tsx` exists. The next-app no longer consumes these, but any future import would re-introduce the orphan. Follow-up: either delete the shared component, or rewrite it to delegate to the new `mc-next-status-chip` primitive.
- **`packages/mission-control-shared/src/components/CodeWorkbenchPanel.tsx`** is a duplicate of `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.tsx` (per Track D shared-code disposition). Decide which is canonical post-W5.3.
- **`useAutoGrowTextarea.ts` exists (79 lines) in `features/threaded-surface/`** — likely the autosize implementation that closed CHAT-007 (per Track A). Confirm it's wired; if so, document; if not, it's dead.

---

## Action items spawned from Track C

| ID | Item | Workstream |
|---|---|---|
| TC-1 | `.gc-button` system-wide unstyled-buttons fix — define a canonical `.gc-button` baseline in next-app OR migrate shared components to a primitive button | NEW (highest impact — affects ~25 components × every render) |
| TC-2 | Citadel Light surface palette decision (warm cream vs cool blue) | W1.1 Phase B blocker |
| TC-3 | Bump pre-existing 10px font-sizes to 12px (`--text-xs`) OR codify `--text-2xs` floor | W1 hygiene |
| TC-4 | Delete or wrap legacy shared `StatusChip.tsx` to prevent re-orphan | W5.3 / W6.3 |
| TC-5 | State communication primitives: `LoadingState`, `ErrorState`, `OfflineBanner`, `RiskChip`, `KbdHint`, `AreaBadge`, `MetricCell` | W1.2 continuation |
| TC-6 | Per-surface state matrix (Empty/Loading/Error/Offline coverage) | W3 deliverable |
| TC-7 | Confirm `useAutoGrowTextarea.ts` is wired (CHAT-007 closure verification) | W2.2 verification |

TC-1 (`.gc-button`) is the highest-leverage finding from this audit — fixing it visually corrects every button rendered by 25 components at once.
