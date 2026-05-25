# Settings — fresh review

**Reviewer:** subagent walk
**Date:** 2026-05-24
**Files reviewed:** SettingsNativePage.tsx (8842 lines, _not_ the 8545 in the brief — the file has grown), `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (rail/grouping owner), `apps/mission-control-next/src/app/route-model.ts` (14 leaf definitions), `apps/mission-control-next/src/features/native-routes/native-routes.css`, `apps/mission-control-next/src/styles/mission-control-next.css` (rail), `apps/mission-control-next/mockups/settings.html`, `apps/mission-control-next/mockups/brand-spec.md`, `apps/mission-control-next/mockups/_shared.css`.

## Verdict

Ship-with-known-debt. The brand-spec's structural promises are mostly kept — the 4-group consolidation (Foundations / Identity / Surfaces / Operations) is implemented in `MissionControlNextApp.tsx:1100-1141`, token discipline is honest (~253 token references vs ~5 hardcoded fallbacks in native-routes.css), and most r5 copy regressions (per-option Tool Profile / Budget Mode / Provider API Style help, the "Key on file" disclosure) have already been addressed. But three things are blocking polish-grade ship-quality: (1) the page-header icon and rail-item descriptions are silently CSS-hidden, so the rail loses the wayfinding cues authored into the data; (2) there is **zero unsaved-state plumbing** in 8842 lines of editable forms; (3) destructive actions look identical to ordinary secondary buttons — only 6 uses of `mc-next-button-danger` cover the 8 `window.confirm()` destructive sites. Top-of-rail still surfaces 14 leaves (the brand spec's "12 leaves / 4 groups" target keeps Onboarding, Permissions, and Budget surfaced as separate leaves rather than absorbing them), so the "fits one laptop screen" claim is borderline.

## Top issues (ranked)

1. **Rail descriptions and page icons are CSS-hidden** (HIGH) — `native-routes.css:100` (`.mc-next-directory-icon { display: none }`) and `mission-control-next.css:818` (`.mc-next-rail-link span { display: none }`) silently suppress the wayfinding copy the routes file paid to author. The mockup's icon+sublabel rhythm collapses to label-only.
2. **No unsaved-state communication anywhere** (HIGH) — zero matches for `unsaved|dirty|hasChanges|isDirty|beforeunload` in SettingsNativePage.tsx; every form lets you edit silently and navigate away. r5 didn't flag this but it's the single biggest first-time-user trap.
3. **Destructive actions visually identical to secondary buttons** (HIGH) — `SettingsNativePage.tsx:3094-3101` ("Delete secret"), `:1568` ("Remove custom"), `:6161-6168` ("Archive profile") all use `mc-next-button-secondary` with a Trash2 icon. Only 6 of ≥8 destructive sites use `mc-next-button-danger`.
4. **14 leaves still in the rail, not 12** (MEDIUM) — `route-model.ts:374-473` ships Onboarding, Permissions, and Budget as separate leaves; the mockup's Operations group holds 2, live holds 4 (Runtime, Add-ons, Budget, Onboarding) and Identity holds 4 (Access, Permissions, Personalities, Providers). The rail still spills below a 13" laptop fold.
5. **No "Find a setting…" command palette** (MEDIUM) — the mockup promises a `⌘K Find a setting…` button in the topbar. Live's matching control (`MissionControlNextApp.tsx:682-685`) opens the Context Inspector, not a setting search. There is no search of any kind across the 14 sections.

## 5-lens findings

### First impression

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Stage-header icon disc never renders | HIGH | `native-routes.css:100-109` declares `.mc-next-directory-icon { display: none }`, but `SettingsNativePage.tsx:7295-7305` still emits the `<div class="mc-next-directory-icon"><Icon/></div>`. So the icon is computed (`iconForSettingsSection`), wrapped in 0×0 markup, and discarded. The mockup (`settings.html:340-357`) uses an amber accent dot + eyebrow, not an icon disc — but live ships neither, so the page header is reduced to kicker + h1 + sub-text with no visual anchor and no area-accent reinforcement at the title. The 2px area-color stripe at `:66-76` exists, but with no icon and no chip strip it lands like a generic admin page. | Wayfinding fails before the user reads a word. |
| 4-group consolidation IS rendered, but icons are still missing for individual rail items | HIGH | `MissionControlNextApp.tsx:820-846` only renders `item.label` + (hidden) `item.description` + release badge + backlog count. No `item.icon` is ever displayed inside the rail, even though every other route page (Chat/Cowork/Code/Projects) lives with the same constraint. The mockup (`settings.html:264-333`) anchors each rail link with a 14×14 SVG icon. | The brand-spec's "rail fits one screen" goal is undermined when each link is pure text — users need an O(1) glance from icon shape, not O(N) label reading. |
| 14 leaves under 4 groups, vs mockup's promised 12 leaves under 4 groups | MEDIUM | `route-model.ts:374-473` defines: General, Start Here, Providers & Models, Personalities, Access, Permissions, Runtime, Workspaces, Integrations, Channels, MCP, Tools, Add-ons, Budget. `MissionControlNextApp.tsx:1100-1141` then assigns them: Foundations(2), Identity(4 — Access/Permissions/Personalities/Providers), Surfaces(4 — Channels/Integrations/MCP/Tools), Operations(4 — Runtime/Add-ons/Budget/Onboarding). Mockup pushes 2/3/4/2 = 11 and lifts Start Here out of the rail into a checklist strip. | Brand spec line 76: "rail fits one screen on a laptop." With 14 entries + 4 group separators + the signal card, a 720px-tall viewport scrolls. |
| Active posture panel mirrors the mockup well | NIT (positive) | `SettingsNativePage.tsx:7362-7449` (`SettingsPosturePanel`) renders 4 cards (Providers / MCP / Integrations / Identity & access) with ThreePartChip rows and "Open" buttons — structurally identical to mockup `settings.html:384-535`. | One of the genuinely well-translated structures. |

### Usability

| Finding | Severity | Location | Recommendation |
|---|---|---|---|
| Zero unsaved-state tracking; edits lost on navigate | HIGH | Every section: form state held in local `useState` (e.g. `AccessSection.form`, `SettingsNativePage.tsx:3275-3281`; `OnboardingSection.defaultsDraft`, `:573-594`; MCP `createForm`+`editForm`, `:5352-5365`). No comparison to the last-loaded server value, no "Unsaved changes" pill, no `beforeunload` guard. | Add a shared `useDirtyForm()` hook that flags drift vs the loaded snapshot, surface a sticky "Unsaved changes — Save / Discard" footer per panel, and wire a `beforeunload` listener when any panel is dirty. |
| No "Find a setting…" / command palette | MEDIUM | `MissionControlNextApp.tsx:682-685` — the only "search" affordance is `mc-next-command-search`, which opens the Context Inspector. Mockup `settings.html:237-241` promises `<button class="command-search">Find a setting… ⌘K</button>`. | Wire a Mission Control-wide command palette indexed against `RAIL_ITEMS[area]` and the field labels in each section. r5's CC-3 + CC-12 also implicitly need this. |
| Dangerous actions distinguishable only by Trash2 icon | HIGH | `SettingsNativePage.tsx:3094-3101` ("Delete secret" → `mc-next-button-secondary`), `:1565-1570` ("Remove custom" personality → same), `:6161-6168` ("Archive profile" → same). Only `:4309` (archive workspace), `:4732` (delete connection), `:5945` (referenced delete) use `mc-next-button-danger`. | Mandate `mc-next-button-danger` for every callsite that opens `window.confirm()`. Inline lint test: any onClick that pairs with `window.confirm(...)` must come from a button whose className includes `danger`. |
| `window.confirm()` is the only confirmation primitive (8 sites) | MEDIUM | Lines 1375, 2309, 3335, 4146, 4495, 5705, 5950, 7074 all gate destructive flows on the OS `confirm()` dialog. | Replace with an inline ConfirmDialog component that supports a typed-confirmation pattern for irreversible actions ("type DELETE to confirm"), matches the dark-theme aesthetic, and is keyboard-trappable. |
| Rail items hide their description text | HIGH | `mission-control-next.css:818` — `.mc-next-rail-link span { display: none }`. Routes in `route-model.ts:378, 385, 392, etc.` author descriptions like "Base defaults every other surface inherits", "Auth posture, secrets, and access boundaries" that the user never sees. | Either show on hover/focus (CSS `:hover/:focus-visible` rule) or move into `title` attribute so screen readers + tooltips surface them. |
| Onboarding "Start Here" is both a rail leaf AND a topbar button AND a panel in `GeneralSection` | MEDIUM | Topbar: `MissionControlNextApp.tsx:686-694`. Rail: `route-model.ts:383-388`. In-page: `SettingsNativePage.tsx:404-408` and `:380-389`. The mockup explicitly demotes "Start here" to a 5-checkpoint inline strip in the rail (`settings.html:252-262`). | Pick one home for Start Here. The mockup's "strip + checklist" is the strongest: drop the rail leaf and the General-page reentry, keep only the topbar button + an inline checkpoint strip in the rail. |
| `GeneralSection` includes a `Quick routes` panel that re-enumerates every section as a redundant directory | MEDIUM | `SettingsNativePage.tsx:399-467` — 12 list items duplicating the rail with longer descriptions. With the rail visible at all times, this panel is a pure repeat. | Delete the panel; the rail and the Active posture cards already cover discovery and the action-on-status path. r5's CC-8/CC-9 first-run guidance lives better in the posture panel CTAs. |
| Network allowlist is a comma-string instead of a tag input | MEDIUM | `:765-774` — `<input value={defaultsDraft.networkAllowlist}>` with placeholder `"example.com, api.example.com"`. No validation, no parsing feedback. The user types one bad entry and the whole list silently rejects on save. | Replace with a chip/tag input (one entry per token), validate on add, and show parse errors inline. |
| `GeneralSection` displays "Auth: unknown" string verbatim when settings fetch fails | LOW | `:343` — `{ label: "Auth", value: data.settings?.auth.mode ?? "unknown" }`. If the gateway returns null, the user sees a literal "unknown" with no recovery CTA. | Render an inline retry CTA when `data.settings === null`. The `SettingsLoadWarnings` component exists at `:7258-7280` but is mounted as a top-of-panel banner, not slotted into the stat strip. |

### Visual hierarchy

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Icons in the page header are dead markup | HIGH | `native-routes.css:100` (`display: none`) blocks the `<div class="mc-next-directory-icon">` emitted at `SettingsNativePage.tsx:7297-7299`. There is no `display:none` override for area=settings or elsewhere. | The brand-spec's wayfinding (area accent + icon disc) is half-built. The 2px area-color stripe at `native-routes.css:67-75` is the only remaining cue. |
| Rail group separators are visually quiet | MEDIUM | `mission-control-next.css:709-730` — separators are a 0.58rem uppercase span + 1px line at 16% area-accent. With 4 groups stacked on a tall rail, the user reading top-to-bottom may skim past the group break. Mockup `settings.html:27-37` uses the same construction but at 700-weight 10px + 14% accent on the line. | Bump the separator line opacity (e.g. 22-28%) and add a 2-4px vertical gap above to make group breaks pre-attentive. |
| Stage h1 caps at `clamp(1.05rem, 1.45vw, 1.4rem)` ≈ 16-22px; mockup uses 24px | MEDIUM | `native-routes.css:158-162` vs `settings.html:112-116`. | The mockup's 24/650 lockup with -0.025em tracking sets a clear stage-vs-rail hierarchy; live's 16-22/700 reads more like a section subtitle. |
| `mc-next-rail-link strong` body size is 0.72rem (≈ 11.5px) | MEDIUM | `mission-control-next.css:796-802`. Mockup `settings.html:38-48` is 12.5px. Combined with the missing icon, this makes the rail feel pinched. | Lift to 12-13px to match the mockup's reviewer-friendly type scale (brand spec change #1). |
| Posture card uses `<ThreePartChip>` (good) but the `state` column collapses to a single string | MEDIUM | `SettingsNativePage.tsx:7479-7484` and `:7388-7398`. State strings are "active"/"configured"/"enabled"/"disabled" plain text. Mockup `settings.html:154-162` shows badge + name + meta + chip-with-dot, a richer scan pattern. | The component supports `age` and `tone` already (`primitives.tsx`); use them. |
| Stage layout grid `is-three-column` at `minmax(220px, 0.72fr) minmax(260px, 0.9fr) minmax(0, 1.15fr)` | LOW | `native-routes.css:1290-1292` — when General renders three panels, the narrowest column is 220px and the widest 1.15fr. On a 1440px desktop the third column dominates. | Consider `is-balanced` (`:1282-1284`) for posture-first pages and reserve three-column for true detail-spec layouts. |

### Consistency

| Element | Issue | Recommendation |
|---|---|---|
| Settings inputs | 72 of 94 `<input>/<select>/<textarea>` use `mc-next-settings-input`; the remaining ~22 are nested in `ConfigFormBuilder`, `LlmTransportFields`, or `PermissionProfileDraftFields` and reach for their own styling. (Search: `grep -c "<input\|<select\|<textarea" SettingsNativePage.tsx` → 94; `grep -c "mc-next-settings-input"` → 72.) | Force every form primitive through `mc-next-settings-input`; expose `ConfigFormBuilder` slots so external editors don't fork the style. |
| Buttons | Primary (`mc-next-button`), secondary (`mc-next-button-secondary`), ghost (`mc-next-button-ghost`), danger (`mc-next-button-danger`) exist — but danger is used only 6× while `window.confirm()` is called 8×. (`grep -c "mc-next-button-danger"` → 6; `grep -c "window\.confirm("` → 8.) | Audit every confirm-gated trigger; promote to `mc-next-button-danger`. |
| Toggles | `<input type="checkbox">` wrapped in `mc-next-settings-toggle` (`SettingsNativePage.tsx:3384-3393`) AND `<input type="checkbox">` wrapped in `mc-next-settings-check` (`:480-486`) coexist with no docs on when to use which. | Decide: `mc-next-settings-toggle` for boolean settings, `mc-next-settings-check` for in-form checkboxes. Or unify. |
| Notice tones | `Notice.tone` is `"success"|"warning"|"error"|"info"` (`SettingsNativePage.tsx:198-201`). But `data.settings.auth.plan?.warnings` (`:3362-3369`) maps every warning to tone `"warning"` regardless of severity. | Type the plan-warning severity at the contract level and pass it through. |
| Headers | `SettingsPanel` always renders `<h2>` + `<p>` (`:7513-7517`), but mockup uses `<h3>` for panels (panel-head h3 at `settings.html:138`). Mockup hierarchy is `h1` (stage) > `h3` (panels). Live is `h1` > `h2`. | Either is defensible; just pick one and document. Note: a11y outline currently has `h1` followed by repeating `h2`s, which is fine. |
| Stat strips | Some panels pass `stats={[{label, value}]}` (`GeneralSection` `:340-345`); others pass nothing (`Quick routes` `:399-401`) and rely on the body for context. | Codify: every top-level panel SHOULD pass `stats` when the value count is ≤5 (rule of thumb from mockup). |
| Workspace filter bar appears once | `SettingsFilterBar` used in `WorkspacesSection` (`:4224-4232`) but the same control would help Personalities, MCP, Tools, Add-ons, Integrations where the lists routinely exceed 10 entries. | Promote `SettingsFilterBar` to a default decoration of `SettingsSelectableList` when item count crosses a threshold. |
| Inline style: `style={{ maxHeight: bodyMaxHeight }}` used 3 times | `:7532`, `:7628`, `:7675`. Otherwise zero inline hex/rgb in the page (good). | Acceptable — `bodyMaxHeight` is a dynamic prop. Just leave it. |

### Accessibility

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Only 2 `aria-*`/`role=` attributes in 8842 lines | HIGH | `SettingsNativePage.tsx:7479` (`aria-label` on posture rows) and `:7573` (`aria-label` on source legend). Everything else relies on implicit roles. | Selectable lists (`SettingsSelectableList`) need `aria-pressed`/`aria-current` to communicate selected state; `SettingsFilterBar` needs `role="tablist"` + `aria-selected`; status chips need `aria-label` so screen readers don't read just the color. |
| Form labels don't programmatically associate with inputs | HIGH | `SettingsField` (`:7544-7551`) wraps children inside a `<label>` — good. But many inputs (`:3373-3382`, `:692-714`, `:3402-3409`) live inside the wrapper without an `id`/`htmlFor` pair, and the `<select>`/`<input>` siblings to the `<span>` label rely on the label-wraps-control association. Plain `<input>` inside a `<label>` works for visible labels but breaks if the label gets repositioned or if VoiceOver chooses to read the field by its `placeholder`. | Add explicit `id` + `htmlFor` to every Field component. |
| Loopback bypass help text is its own `<SettingsNotice tone="warning">` rather than `aria-describedby` | MEDIUM | `:3394-3400`. | Bind to the input via `aria-describedby` so screen readers tie the warning to the toggle, not just to nearby DOM. |
| No focus-trap on the inline confirm flows | MEDIUM | All 8 `window.confirm()` sites delegate to the OS dialog (which IS focus-managed). But the post-confirm `SettingsNotice` (`:7735-7737`) isn't an `aria-live` region. | Make `.mc-next-settings-notice` `aria-live="polite"`. |
| Focus-visible style exists on rail links but not on `SettingsSelectableList` items | MEDIUM | `mission-control-next.css:785-789` (rail) vs `SettingsNativePage.tsx:7631-7642` (selectable list — uses `<button>` but the `.active` and base styles don't show focus-visible distinctly). | Add `:focus-visible` outline to `.mc-next-settings-selectable`. |
| Color-only signal for "active" vs "configured" posture cards | MEDIUM | `:7479-7484` — `ThreePartChip` shows a tone-tinted state badge; the only differentiation between "active" and "configured" is tone (safe vs muted). | Add a glyph or pattern alongside tone (already supported via `ThreePartChip` `age` slot — repurpose). |
| Window.confirm() is keyboard-reachable but breaks screen-reader context | LOW | Native dialog inherits OS a11y, but the surrounding setting panel is left mid-edit with no announcement. | See above — replace with in-app ConfirmDialog. |
| Rail labels read as buttons but `mc-next-rail-link` does not set `aria-current="page"` | MEDIUM | `MissionControlNextApp.tsx:821-825`. | Set `aria-current={isRailItemActive(route, item) ? "page" : undefined}`. |

## Mockup-vs-live gap

**Mockup promises live doesn't deliver:**

| Promise | Mockup ref | Live state |
|---|---|---|
| `Find a setting… ⌘K` command palette in topbar | `settings.html:237-241` | `MissionControlNextApp.tsx:682-685` is a Context Inspector trigger labeled "Open context inspector". No search exists. |
| Per-section health pill in the rail (e.g. `Channels · 1 down`, `MCP servers · 4 ✓`, `Workspaces · 3`) | `settings.html:266-332` | Live shows only release-status badge + backlog count for `tasks`/`approvals`. Settings rail has no live-health signal per leaf. |
| Inline 5-step Start-here checklist strip at the top of the rail | `settings.html:252-262` | Lives as a dedicated section ("Start Here" leaf) + topbar button + General-page panel — 3 entry points, no inline checklist strip in the rail. |
| Icons on every rail link (14×14 svg) | `settings.html:266-332` | Rail links are label-only (`MissionControlNextApp.tsx:828-840`). |
| 12 leaves under 4 groups (rail fits one screen) | `settings.html:567-583` | 14 leaves under 4 groups, rail spills below 720px viewport fold. |
| `IA comparison` card showing the consolidation rationale | `settings.html:538-583` | Not present anywhere in the live app — this was a mockup-only didactic aid (acceptable). |
| Stage h1 of "Workspace at a glance." with summary metric strip + Refresh posture + Export workspace buttons | `settings.html:340-381` | Live `GeneralSection` renders `"General"` h1 + posture panel + metric grid — close, but no "Refresh posture" or "Export workspace" CTAs; live uses `Mission Control posture` panel + `Setup path` + `Quick routes`. |
| Section eyebrow with area-color dot and breadcrumb (`Settings · Foundations · General`) | `settings.html:343` | Live shows kicker `Settings · General` only (no group name) at `SettingsNativePage.tsx:259`. |
| Visible page-header icon disc | All mockup pages | `display: none` in `native-routes.css:100`. |

**Live features not in mockup that should arguably stay:**

- `Onboarding` as a discoverable destination with 5+ panels (`SettingsNativePage.tsx:638-805`) — the mockup distills this to a 5-checkpoint strip, but the live multi-panel onboarding is a load-bearing first-run path.
- `Permissions` as a dedicated section (vs absorbed into Access) — the live model has Permission Profile editor + Local Operator Override evidence that doesn't fit Access.
- `Budget` as a standalone section — small but separate; could absorb into Runtime per mockup IA.
- `Notifications and sounds` panel inside General (`:468-555`) — mockup doesn't show this, but it's a sensible General-page resident.
- `SettingsLoadWarnings` (`:7258-7280`) banner for partial-load issues — pragmatic addition the mockup didn't anticipate.

**Total mockup-vs-live gap: medium-large** — structural IA consolidation lands, but the visual cues (icons, descriptions, health pills, command palette) and the rail-leaf count are off enough that a brand-spec audit would mark this as in-progress.

## Code-health seams (for future Phase-4 refactor)

The 14 sections collapse cleanly into 4 group-files plus shared primitives. Natural cut lines mapped to the brand spec:

| Group | Section components | Cut line (line range in current file) | Suggested module |
|---|---|---|---|
| **Foundations** | `GeneralSection`, `WorkspacesSection` | `:303-560` (General), `:4056-4323` (Workspaces) | `settings/foundations/GeneralPanel.tsx`, `settings/foundations/WorkspacesPanel.tsx` |
| **Identity** | `ProvidersSection`, `PersonalitiesSection`, `AccessSection`, `PermissionsSection` | `:1980-3260` (Providers, ~1280 lines), `:1282-1596` (Personalities), `:3261-3497` (Access), `:5782-6442` (Permissions) | `settings/identity/{Providers,Personalities,Access,Permissions}Panel.tsx` |
| **Surfaces** | `IntegrationsSection`, `ChannelsSection`, `McpSection`, `ToolsSection` | `:4325-4892` (Integrations), `:4894-5336` (Channels), `:5337-5735` (MCP), `:6443-6791` (Tools) | `settings/surfaces/{Integrations,Channels,Mcp,Tools}Panel.tsx` |
| **Operations** | `RuntimeSection`, `AddonsSection`, `BudgetSection`, `OnboardingSection` (Start Here) | `:3498-4055` (Runtime, ~558 lines), `:6792-7201` (Add-ons, ~410 lines), `:1104-1244` (Budget), `:562-810` (Onboarding) | `settings/operations/{Runtime,Addons,Budget,Onboarding}Panel.tsx` |
| **Shared** | `SettingsPageFrame`, `SettingsSectionShell`, `SettingsGrid`, `SettingsPanel`, `SettingsPosturePanel`, `SettingsPostureCard`, `SettingsFieldGrid`, `SettingsField`, `SettingsButtonRow`, `SettingsMetricGrid`, `SettingsConfigSourceLegend`, `SettingsWizardSteps`, `SettingsSelectableList`, `SettingsActionList`, `SettingsFilterBar`, `SettingsCodeBlock`, `SettingsEmptyState`, `SettingsNotice`, `DiagnosticsPanel`, `SettingsLoadWarnings`, `useAsyncLoad`, `nativeLoad`/`nativeLoadIssues` | `:7202-7755` (primitives + hooks) | `settings/shared/primitives.tsx` (or split per primitive) |
| **Onboarding sub-panels** | `DemoStartPanel`, `FirstOutcomePathPanel`, `ProviderSmokeEvidencePanel`, `SetupCenterPanel`, `EcosystemProofLanePanel` | `:811-1103` | `settings/operations/onboarding/{Demo,FirstOutcomePath,ProviderSmokeEvidence,SetupCenter,EcosystemProofLane}Panel.tsx` |
| **Provider helpers** | `createEmptyProviderEditorDraft`, `buildProviderEditorDraft`, `buildChatGptOAuthProviderDraft`, the codex OAuth flow helpers, `formatProviderProbeStateLabel`, `deriveProviderSmokeEvidenceItems`, etc. | `:1597-1979` (exported helpers) | `settings/identity/providers/{drafts,oauth,probe-format,smoke-evidence}.ts` |
| **Section-label helpers** | `labelForSettingsSection`, `descriptionForSettingsSection`, `iconForSettingsSection`, `formatSecretStatusMeta`, `formatSecretStorageNotice` | `:8516-8842` | `settings/shared/section-meta.ts` |

The natural cut lines are honest — each `function XxxSection(...)` boundary cleanly bounds a section, and the shared primitives (`:7202-7755`) are import-only dependencies with no entanglement. The `:7755`-onward `collectDefinitionFieldHints` and tail helpers can move into `settings/surfaces/channels/`.

Sizes at the cut lines: Providers (~1280 lines), Permissions (~660), Runtime (~560), Addons (~410), MCP (~400), Personalities (~315), Workspaces (~270), Access (~240), Integrations (~570), Channels (~440), Tools (~350), Onboarding (~250 + 5 sub-panels = ~700), General (~260), Budget (~140). After splitting, no single file should exceed 1500 lines, and most land at 200-400 — well within the user's "200-400 typical, 800 max" rule.

## What works well

1. **4-group consolidation IS implemented at the data layer** — `MissionControlNextApp.tsx:1100-1141` cleanly assigns the 14 leaves into Foundations/Identity/Surfaces/Operations via a single `buildRailSections()` function. The brand-spec's structural claim is honored; only the leaf-count and visual cues need tightening to fully match the mockup.

2. **Token discipline is real, not aspirational** — `native-routes.css` has 253 token references vs ~5 hardcoded color fallbacks (and those are `var(--mc-surface-1, #f5f5f5)` defaults, not raw hex). `color-mix(in oklab, ...)` is used 142 times, the `oklch` color space lands in the area-accent system, and the area color cascades via `--mc-area-color` on the directory header.

3. **Per-option help addresses every r5 HIGH** — `OnboardingSection` (`:705-763`) renders `describeToolProfileLabel`, `describeToolProfile`, `describeToolApprovalMode`, `describeToolApprovalModeHelp`, `labelForBudgetMode`, `describeBudgetMode` per dropdown option, with secondary help text below. r5's RT-1, RT-2, MD-1 are materially closed.

4. **"Key on file" disclosure is present** — `SettingsNativePage.tsx:3074` includes the long-form copy "Key on file status comes from the gateway only. Saved key values do not roundtrip back to the browser…" and `formatSecretStatusMeta` (`:8516-8529`) maps `keychain`/`env`/`inline`/`none` to human labels. r5's CC-2 CRITICAL is closed.

5. **Skeleton/loading state is real** — `SettingsSectionShell` (`:7311-7336`) uses `BlocksShuffleLoader` instead of a `<p>Loading…</p>`. r5's CC-8 is closed.

6. **`SettingsPosturePanel`** — the General-page status cards (Providers / MCP / Integrations / Identity & access) with one-click "Open" handoff mirrors the mockup's "active posture" intent and gives the user the first 80% of "what's wired up" without scrolling.

7. **Section-level reload is granular** — every section owns its own `useAsyncLoad` hook (`:7202-7252`), so a partial-failure in one section's data doesn't cascade. `SettingsLoadWarnings` surfaces issue lists with retry.

8. **`SettingsWizardSteps`** — the onboarding checklist (`:7582-7602`, rendered at `:657-663`) gives first-run users a real state machine instead of a hidden detail-flow.
