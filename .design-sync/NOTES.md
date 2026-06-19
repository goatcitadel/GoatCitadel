# design-sync notes — GoatCitadel Mission Control UI

Target project: `dfae9843-d05c-46bd-a566-a1b70ae8b139` ("GoatCitadel Mission Control UI"). Shape: `package`.

## CRITICAL: two component layers, only one is styled in the live app

`mission-control-next` is styled with **bespoke CSS, NOT Tailwind**. There is **zero `@import "tailwindcss"` in any source CSS** across the whole repo (the only compiled Tailwind is in the *retired* legacy `apps/mission-control/dist/` build artifact). Consequence:

- **`@goatcitadel/mission-control-shared` → `components/ui/` lowercase shadcn primitives** (`button`, `card`, `badge`, `alert`, `input`, `select`, `switch`, `table`, `tabs`, `dialog`, `drawer`, `popover`, `tooltip`, …): pure **Tailwind-utility CVA** classes. **Render UNSTYLED in mission-control-next** (no Tailwind compile). Confirmed by the JSDoc in `apps/mission-control-next/src/features/native-routes/primitives/NativeButton.tsx` ("the Tailwind-utility CVA `<Button>` renders unstyled here"). These were the original sync scope — but they are NOT product-truth today.
- **`GC*` components in `components/ui/`** (`GCAlert`, `GCCombobox`, `GCEmptyState`, `GCModal`, `GCSelect`, `GCSegmentedControl`, `GCSwitch`): bespoke `mc-gc-*` class names, **styled by `mission-control-next.css`** → these ARE styled in the live app.
- **The native kit** — `apps/mission-control-next/src/features/native-routes/primitives/` (`NativeButton`, `StatusChip`, `EmptyState`, `ErrorState`, `FilterPill`, `FilterPillGroup`, `ModeBar`, `StageHeader`, `ThreePartChip`, `ContextStrip`, `NativeMetricGrid`, `NativeSelectableList`, `KbdHint`; barrel `index.ts`, `primitives.css`) — bespoke CSS, **the product's real styled primitives.**

## Styling architecture (import order from `apps/mission-control-next/src/main.tsx`)

1. `@awesome.me/webawesome/dist/styles/webawesome.css` (WebAwesome base)
2. `mission-control-next-tokens.css` — canonical tokens at `:root` (`--area-*`, `--risk-*`, `--brand`, `--font-sans`="Geist Variable", `--r-*` radii, text scale; plus `--bg-*`/`--fg-*`/`--border-*` further down)
3. `mission-control-next-foundation.css` — base/reset + also declares shadcn semantic vars (`--primary` etc.) at some scope
4. `mission-control-next-theme-bridge.css` — re-declares shadcn semantic vars (`--background`, `--foreground`, `--card`, `--muted`, `--border`, `--primary`, `--input`, surfaces/panels/text families) on the bare `.theme-signal-noir` / `.theme-citadel-light` classes (for body-portaled content)
5. `mission-control-next.css` — `.mc-next-*` / `.mc-gc-*` component CSS; the higher-specificity `.mc-next-shell.theme-*[data-area]` blocks add per-area accent tinting
6. `native-routes/primitives/primitives.css` — the native-kit component CSS

Themes: `theme-signal-noir` (dark) and `theme-citadel-light` (light), set on `<html>`/`<body>`. The shell wrapper is `.mc-next-shell` with `data-area="chat|cowork|code|projects|library|ops|settings"`. **Previews of styled components must be wrapped in `.theme-citadel-light` (or signal-noir) and likely `.mc-next-shell[data-area=...]`** for vars to resolve → use `cfg.provider` with a small wrapper component.

Font: **Geist Variable** (`@fontsource-variable/geist`), mono = system mono. May need `cfg.extraFonts` for the Geist woff2.

## Scope decision: NATIVE KIT (chosen 2026-06-18)
User chose product-accurate native kit over the Tailwind-inert shadcn layer. Scope = the bespoke-CSS primitives actually styled & used in the live app:
- native-routes/primitives: NativeButton, StatusChip, EmptyState, ErrorState, FilterPill, FilterPillGroup, ModeBar, StageHeader, ThreePartChip, ContextStrip, NativeMetricGrid, NativeSelectableList, KbdHint
- shared GC*: GCModal, GCCombobox, GCSelect, GCSegmentedControl, GCSwitch, GCAlert, GCEmptyState
No Tailwind needed (all bespoke CSS). Lowercase shadcn `components/ui` are OUT (Tailwind-inert).

### GC* investigation (2026-06-18) — mostly NOT product-accurate either
Authored + verified the 13 native primitives (all graded good, uploaded). Then investigated the GC* set and found they fail the SAME fidelity test as the shadcn layer:
- **GCAlert, GCSelect, GCSegmentedControl, GCEmptyState**: reference `mc-gc-*` / `gc-*` classes (`gc-empty-state`, `mc-gc-alert`, `mc-gc-select-shell`, `mc-gc-segmented-control`) that are defined in **ZERO repo CSS files** → render unstyled (they wrap the inert shadcn Alert/Button). Same category as the excluded lowercase shadcn primitives.
- **GCSwitch**: base `mc-gc-switch` styled, but the checked-thumb position is scoped to `.gateway-access-row` (gateway-gate context only); the thumb's "on" translate is an inert Tailwind class (`translate-x-[18px]`).
- **GCModal, GCCombobox**: DO have `mc-gc-modal`/`mc-gc-combobox` styles in mission-control-next.css, BUT they are Radix portal overlays → content renders on `document.body` (outside the ThemeWrapper div, so theme-bridge vars wouldn't resolve) and need `open` state. The theme-bridge.css puts vars on `.theme-*` on `<html>/<body>` precisely for this — a preview would need the theme class on the preview body + open=true.
Conclusion: GC* is NOT a clean product-accurate set. Per the fidelity-first principle, recommend shipping the 13 native primitives as the deliverable and excluding GC*.

### Overlay attempt (GCModal + GCCombobox) — rendered but LOW fidelity
User asked to attempt the 2 overlays. Wired up: ds-provider.tsx now also adds `.theme-citadel-light` to `<html>` (so Radix-portaled content inherits theme vars — this part WORKED); `.design-sync/gc-overlays.tsx` re-exports just GCModal+GCCombobox into the global; config got componentSrcMap + extraEntries + overrides(GCModal cardMode single) + docsMap(category Overlays — note: the category did NOT override the dir-derived group "mission-control-shared"). Result:
- **GCModal**: dialog title/description themed (Geist), BUT the footer buttons render UNSTYLED (shadcn Button = inert Tailwind; destructive not red), modal panel chrome/backdrop only partial. ~40% styled.
- **GCCombobox**: trigger renders as a plain bordered box (inert shadcn Button base); the styled dropdown is interaction-gated (open is internal state, no prop) so a static capture can't show it.
Root cause = the inert shadcn Button/Dialog base; can't be fixed without the Tailwind layer. Graded needs-work; NOT improvable here. If GC* are ever wanted at fidelity, the repo needs a compiled Tailwind/shadcn pipeline first. To FULLY revert the overlay attempt: drop GCModal/GCCombobox from componentSrcMap, remove gc-overlays.tsx from extraEntries, remove overrides.GCModal + docsMap, delete previews/GCModal.tsx + previews/GCCombobox.tsx + docs/. (The html-class addition in ds-provider.tsx is harmless — keep it.)

## Build recipe (CONFIRMED WORKING — native primitives, 2026-06-18)
Discovery gotcha: with `--entry`, the converter sets PKG_DIR = the app (mission-control-next) but reads component names from that package's *declared exports* — an app declares none. So the kit is enumerated EXPLICITLY via `cfg.componentSrcMap` (13 native primitives → group "primitives"). `--entry` points at the native barrel only to feed the esbuild bundle.

1. Regenerate the combined stylesheet (cfg.cssEntry; it's GITIGNORED + generated):
   `S=apps/mission-control-next/src/styles; P=apps/mission-control-next/src/features/native-routes/primitives`
   `N=apps/mission-control-next/src/features/native-routes/native-routes.css`
   `{ cat $S/mission-control-next-tokens.css; grep -v 'fontsource-variable/geist' $S/mission-control-next-foundation.css; cat $S/mission-control-next-theme-bridge.css $S/mission-control-next.css $N $P/primitives.css; } > apps/mission-control-next/.ds-sync-styles.css`
   IMPORTANT: `native-routes.css` (4345 lines) is REQUIRED — it defines `mc-next-settings-metric*` (NativeMetricGrid) and `mc-next-settings-selectable*` (NativeSelectableList) with top-level selectors. Without it those two render unstyled/smushed. Order: after mission-control-next.css, before primitives.css.
   (the geist `@import` is stripped — Geist is wired via cfg.extraFonts, which copies the woff2 + emits fonts/fonts.css)
2. Build:  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules apps/mission-control-next/node_modules --entry apps/mission-control-next/src/features/native-routes/primitives/index.ts --out ./ds-bundle`
3. Validate: `node .ds-sync/package-validate.mjs ./ds-bundle`

Provider: `.design-sync/ds-provider.tsx` exports `ThemeWrapper` → wraps each card in `.theme-citadel-light` (Citadel Light / warm-cream) so the theme-bridge vars resolve. Deliberately NOT `.mc-next-shell` (forces 100dvh). Confirmed: components render styled.
Playwright: repo ships playwright 1.58.2 (pnpm) pinning chromium-1208, present in the ms-playwright cache → validate's render check resolves it via upward node resolution; no browser install needed.

## Re-sync risks
- `.ds-sync-styles.css` (cfg.cssEntry) is GITIGNORED + generated — a re-sync MUST regenerate it (step 1) before the build, or cssEntry is stale/missing.
- Entry is scope-scoped (the native barrel), NOT the package default `dist/index.js` (which exports the whole library). Always pass `--entry` and keep `cfg.componentSrcMap` as the authoritative kit list.
- Theme is pinned to citadel-light in the provider; if the brand default flips to signal-noir (dark), update `ds-provider.tsx`.
- GC* components (GCModal/GCCombobox/GCSelect/GCSegmentedControl/GCSwitch/GCAlert/GCEmptyState) are a DEFERRED second wave — not in this build's scope yet.
