# Mission Control Next — Full Front-End Visual Review (2026-07-27)

Full-matrix visual/UX review of every release surface ahead of 1.0, with fixes applied on
`review/mc-next-frontend-visual-2026-07-27`.

## Methodology

- Isolated stack: built gateway (sqlite, token auth + loopback bypass, dev diagnostics) + Vite dev UI,
  seeded with the verification fixture recipe (workspace, 8 sessions, pending approval + user-input
  scenarios, agents, citadel charter/chambers/wards/council, ops board, memory, files, prompt pack)
  plus a project fixture.
- Captured **456 route screenshots** (57 routes x 8 variants: 1440/1280/1179/390 x dark/light,
  including the hidden `/ops/workers`, `/settings/*-capabilities` routes and a bogus-section fallback)
  and **46 overlay/interaction states** (command palette incl. query/empty, shortcuts overlay,
  route-details drawer, mobile nav, session-rail drawer, notifications/approvals popovers, chat
  utility-dock tabs, work record, chat empty state, unsaved-changes modal, gateway access gate in
  needs-auth/unreachable states, both themes).
- Six parallel review agents (chat, library assets, citadel+projects, ops, settings, shell/overlays)
  produced 64 candidate findings; every bug candidate was adversarially re-verified against the live
  app (computed styles, `getBoundingClientRect`, cascade inspection) before any fix.
- Console health: **zero console errors, warnings, or page errors across all 456 route loads** (after
  repairing local dependency drift: `@fontsource-variable/hanken-grotesk` is declared and imported in
  the repo but was absent from this machine's `node_modules` until `pnpm install`).
- Gates after fixes: `perf:check` (legacy/token-drift/typography/buttons/icons/contrast/budgets) green,
  `tsc -b` green, eslint green (three packages), vitest green: mission-control-next 885,
  mission-control-shared 825, threaded-surface-core 425.

## Headline finding

**A same-element CSS custom-property cycle silently deleted the border token family shell-wide, in
both themes.** In `mission-control-next.css`, the theme alias blocks declared
`--mc-border-subtle: var(--border-subtle)` and, later in the same rule,
`--border-subtle: var(--mc-border-subtle)`. Per the CSS custom-properties spec both become
guaranteed-invalid, and everything referencing them — `--border`, `--border-default`, `--line`, and
every `color-mix(... var(--border) ...)` — became invalid at computed-value time. Any declaration
using them was dropped wholesale (a `border:` shorthand referencing them computes to `none`).

Most surfaces survived on background contrast alone, which is why it went unnoticed: the visible
damage was "mysteriously" invisible form fields (Citadel Wards/Vault/Blueprint, Projects controls,
Ops Schedules, Settings Access), an empty-state falling back to a heavy stale 2px border, and a
subtle hairline loss across the entire app. One-line fix per theme block; borders everywhere now
render as designed.

## Fixed in this branch

| # | Surface | Defect | Fix |
|---|---------|--------|-----|
| 1 | Shell (both themes) | Custom-property cycle emptied `--border`/`--border-subtle`/`--border-default`/`--line` shell-wide; dependent declarations dropped (invisible inputs, stale fallback borders) | Removed the cyclic `--border-subtle: var(--mc-border-subtle)` re-declaration from both theme alias blocks (`mission-control-next.css`) |
| 2 | Toasts | Grouped event bursts re-inserted toast DOM nodes, restarting the enter keyframe from opacity 0 — the whole stack flickered translucent during bursts | Enter animation now applies only on first mount (`NotificationStack.tsx` seen-ids ref + `.notification-item-enter` class); unit-tested |
| 3 | Toasts | Fixed stack overlapped the status strip's Details/Approvals controls; dismiss button rendered as a full-height slab | Stack offset above the strip; dismiss pinned to a compact top-aligned icon (two-class selector so the `.gc-button` base can't re-stretch it) |
| 4 | Chat (≤1360 compact) | Sticky blocked-composer background faded transparent over its top 28% (~160px on the tall blocked state) — timeline text showed through, glyph-clipped, with a "Wa" fragment strip | Fixed-height 14px fade instead of percentage (`timeline-frame.css` + `conversation-workspace.css`) |
| 5 | Chat utility dock | Status chips (`min-width: auto`) in a nowrap row painted up to 34px past the 256px column ("0 citations" clipped at viewport); container side-scrollable by focus | Chip row wraps + chips shrink; container `overflow-x: clip` (`side-panels.css`) |
| 6 | Chat composer | Send rendered as a fully saturated CTA while genuinely disabled during blocking prompts | `:disabled` treatment for `.mc-next-composer-primary` |
| 7 | Chat background-tasks tab | Raw `API error 404: {json}` painted into the panel when a run has no durable rail | 404 mapped to the normal empty state (`useDurableBackgroundTaskRail.ts`) |
| 8 | Chat empty state | "1 decisions" | Pluralized (`MissionThreadedControllerHost.tsx`) |
| 9 | Dark theme overlays | `--bg-scrim` (32% near-black) imperceptible on the near-black app — drawers read un-layered, underlying text sliced mid-word at full contrast | Dark-theme `--bg-scrim: rgba(0,0,0,0.58)` override (tokens) |
| 10 | Shell topbar | Theme toggle icon derived from the raw preference and the control was inert while `?theme=` was pinned in the URL | Toggle flips from the effective theme and un-pins the URL param; chrome receives the effective theme (`MissionControlNextApp.tsx`) |
| 11 | Shell topbar | Workspace switcher clipped names mid-word with no recovery | `title` attribute on the select |
| 12 | Status strip (mobile) | Compact build chip read "Src/ver…" — the informative part was the part ellipsized away | Verification status now leads the compact value (`unverified/Dev/v1.0.0/…`) |
| 13 | Section index (all consumers) | Dead selector `.mc-next-native-grid` (grid emits `mc-next-directory-grid-native`) — "ON THIS PAGE" squeezed into one ~280px track, links clipped mid-word/hidden, hoist order never applied | Corrected both selectors (`11-shared-route-grammar.css`, `04-ops-approvals-runtime.css`) |
| 14 | Stat tiles (Library Artifacts, Ops Browser Sessions) | Workspace ids overflowed their tile and composited over the neighboring tile ("ws_…54All4e57…") — a chat-alignment reset removed their wrap escape | Removed `.mc-next-directory-stats strong` from the word-break reset (`13-chat-alignment.css`) |
| 15 | Head metrics (Settings Providers) | Active-workspace id overflowed the tile and painted over the adjacent panel heading | `overflow-wrap: anywhere` on `.mc-next-directory-head-metric-value` |
| 16 | Settings form grids | `auto-fit minmax(11rem)` + `span-2` siblings pinned phantom tracks — MCP Label/Personalities Style/Workspaces Name clipped their own values beside dead space | Track floor raised to 16rem (resolves 2 tracks in panels, collapses to 1 when narrow) |
| 17 | Form fields (resting state) | 54%-of-token border mix left fields undiscoverable on card surfaces even after the cycle fix | Restored the base 84% mix (`12-shared-production-pass.css`) |
| 18 | Citadel Council | Raw UA `<select>`/`<button>`; disabled-reason jammed against Remove at `--text-2xs`; `.mc-next-settings-actions` had no CSS anywhere | DS select class + `NativeButton`s; actions row defined as wrapping flex; reason raised to `--text-xs` |
| 19 | Citadel Overview | Spanning "Default Citadels" card pinned auto-fit at 4 tracks → permanent empty 4th column beside the 3 posture cards | Promoted card moved out of the posture grid |
| 20 | Citadel Overview | Raw enums (`hybrid_guarded`, `approval_required`) operator-facing | Shared `humanizeEnumToken()` helper; applied here and in Settings (onboarding status/path state, MCP auth readiness, General mesh readiness, Add-ons runtime/web entry/trust tier, Integrations kind) |
| 21 | Citadel Blueprint | JSON preview clipped charter prose mid-word with no scroll affordance | `pre-wrap` + `overflow-wrap: anywhere` (read-only prose preview) |
| 22 | Projects | Lead-card buttons stretched into ~65px slabs (missing `align-content: start`); "Last activity None"; `Citadel > Workspace > Project` kicker broke the shell grammar | Anchored card content; "No activity yet" copy; `Projects · Containers` kicker |
| 23 | Ops Approvals | Decision chip crushed to "awaiti… / shell.e" sharing the auto-fit button grid | Chip spans the full actions row |
| 24 | Ops Workers (hidden) | Bare "Observe" kicker outside the shell grammar | `routeKicker(route)` |
| 25 | Library Memory | "0 RECORDS" badges clipped mid-glyph in narrow auto-fit cells (`white-space: nowrap`) | Badges wrap under the kind label |
| 26 | Library Skills | Unbroken absolute paths in metric meta blew the card past the viewport | `min-width: 0` + `overflow-wrap: anywhere` on settings metrics |
| 27 | Library Files / Skills / Local AI / Add-ons | Case-sensitive paths, commands, and URLs displayed UPPERCASED by meta styling | Uppercase transform removed from verbatim meta slots (`action-copy span`, `library-action-card em`) |
| 28 | Gateway access gate | Collapsed "Technical details" had no disclosure affordance; primary CTA identical to secondary; light-theme switch off-track invisible | Chevron per the repo disclosure idiom; `.active` emphasis on Connect/Retry; surface-3 switch track |
| 29 | Settings Access | Token placeholder guidance truncated mid-word in every variant | Shortened to "New token (only when rotating)" |

Also: repaired local dependency drift for `@fontsource-variable/hanken-grotesk` — the package is
correctly declared in `package.json` and imported by the foundation stylesheet (no repository or
build defect); it was merely absent from this machine's pre-existing `node_modules` until
`pnpm install`. Fresh checkouts are unaffected.

## Verified non-issues

- **Unsaved-changes guard works**: editing a Workspaces field and navigating away is blocked by the
  ConfirmModal with correct copy (the earlier capture gap was a probe that picked a page with no text
  inputs, not a product bug).
- Console health is clean across the entire matrix; the visual-regression lane's browser-health
  assertions match what we observed.
- Streaming hot path, artifact iframe backgrounds, lightbox scrim, release-scope "Hidden" sublabels —
  all previously-cleared items were not re-flagged.

## Deferred findings (recommend before/shortly after 1.0)

**Bugs (small, none release-blocking):**
- Ops Activity feed rows crush their event label at every desktop width (the full timestamp is
  `flex-shrink: 0` and the source span reserves 30%). Recommend relative ages ("6m") in feed rows and
  a readable floor for the chip state segment.
- Ops Schedules: needs-attention card truncates chips/titles in the 4-across grid (fine at 3-across on
  Notifications) — give it a wider minimum track or a 2-column span.
- Hidden capability routes (`/settings/workspace-capabilities`, `/settings/citadel-capabilities`):
  double "Unknown" fallback header above the real header, `Skills — Skills` duplicated titles, and a
  nested SettingsGrid squeezing the first panel until item names ellipsize to single letters.
- Run Detail without a `runId` renders a load-warning with a Retry that can never succeed, plus a wall
  of mixed-case "unknown/Unknown" chips — deserves an intentional "No run selected" empty state.
- Library Skills first paint blocks on the slowest of four gateway calls (captured stuck on the shell
  loader in 5 of 8 variants) — render the skills list as soon as its own fetch resolves.
- Settings Providers CAPABILITIES read-only input clips its list mid-token; render as wrapping chips.
- Mobile "ON THIS PAGE" rows and the command palette list scroll with no affordance (overlay
  scrollbars) — add an edge fade or wrap.
- FilterPillGroup shows "Swipe for more filters" even when nothing overflows — gate on measured
  overflow.

**UX suggestions (product-level):**
- **Chat blocked state repeats itself up to five times** in one viewport (timeline heading, evidence
  strip, notice, the approval card, and two near-identical composer strips). Merging the two composer
  strips alone frees ~120px and calms the highest-stakes moment in the product.
- **Identifier discipline**: bare UUIDs render as body text in the approval/user-input cards, Council
  seat rows, Journey/Artifacts metric tiles, and Trust-policy prose. A shared "id chip" (mono,
  middle-ellipsis, copy affordance, optional label) would fix a dozen surfaces at once.
- **Projects page redundancy**: the same project appears four times (hero, list, detail, edit panel),
  and `/projects/:projectId` is pixel-identical to `/projects`. Hide the hero when it duplicates the
  selection; make the detail route visibly distinct.
- Library agents-catalog route is pixel-identical to `/library/agents` — focus/scroll the catalog card
  or drop the separate slug.
- Ops board "Usage & cost" widget asserts `$0.00` while the Costs route correctly reports Unknown /
  lower-bound — propagate the evidence flag into the widget.
- Reminders "Due at" expects a hand-typed millisecond ISO timestamp — use `datetime-local`.
- Onboarding stage captions (`PROVIDER-READY`, `FIRST-TASK-PENDING`) and Mason's `FAIL-CLOSED STAGING`
  kicker read as internal spec keys; the surrounding copy already explains them in plain language.
- Curator is reachable only by URL/palette with no nav highlight (intentional for experimental scope,
  but it also drops the humanized-timestamp and column-alignment conventions).
- Diagnostics directory renders one ~286px column and leaves two-thirds of the viewport empty.
- Working-context tab strip wraps 3+1 ("Session" orphaned) at every desktop width — size the four tabs
  to one row or commit to a 2x2 grid.
- Model-fit list repeats the same model per backend (4 of 6 visible rows are duplicates) — group by
  model with backend chips.
- Security quality cards on Ops Quality repeat the same disclaimer sentence verbatim side by side.

## Release-readiness verdict

The front end is in strong shape for 1.0: consistent shell grammar, disciplined typography and
contrast (AA-clean in both themes per the token annotations and `contrast:check`), correct empty/error
states on nearly every surface, and flawless console health across 456 seeded page loads. The defects
found were overwhelmingly of one family — layout-primitive edge cases (auto-fit phantom tracks,
min-content overflow, nowrap in narrow tracks) plus one systemic token-cycle regression — and the
fixes here close all of the high-severity items. The deferred list is polish, not blockers.

**Follow-up required:** the border-cycle fix restores hairlines app-wide, so the visual-regression
baselines must be refreshed (Linux renderer via `visual-rebaseline.yml`) for all routes/variants on
this branch before the visual lane will pass.
