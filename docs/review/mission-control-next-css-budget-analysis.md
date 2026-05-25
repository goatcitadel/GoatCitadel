# CSS budget analysis (task #16)

**Date:** 2026-05-25
**Current:** 198316 bytes
**Budget:** 184320 bytes
**Over by:** 13996 bytes (7.6%)

## What the budget measures

`scripts/check-mission-control-next-budgets.mjs` (line 75–84) sums the **on-disk byte size of every `<link rel="stylesheet">` referenced from `apps/mission-control-next/dist/index.html`** and compares against `budgets.initialCssBytes = 180 * 1024 = 184320` bytes (line 11). Files are measured raw (post-Vite-minification, pre-gzip/brotli) — `fs.statSync(assetPath).size`.

In the current `dist/index.html` the initial shell pulls exactly two stylesheets:

| Asset (path under `dist/assets/`)         | Bytes   |
|-------------------------------------------|---------|
| `index-i_hgAR1c.css`                      |  54,889 |
| `vendor-webawesome-BtzZGIms.css`          | 143,427 |
| **Total**                                 | **198,316** |

That matches the failure message exactly (`198316`). The lazy route chunks (`NativeRoutePages-*.css`, `ThreadedSurfaceRoute-*.css`, `PromptPacksWorkbenchPage-*.css`) do **not** count against this budget.

## Contribution breakdown

### `vendor-webawesome-BtzZGIms.css` — 143,427 bytes

Parsed by splitting on the `@layer wa-native,wa-utilities,...,wa-theme-overrides;` order header (which the bundler re-emits each time the layer order is declared). The file has three segments:

| Segment | Bytes  | Source                                                                                                                                                                                                                                                              |
|---------|-------:|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 (header)        | 105    | First `@layer wa-native,wa-utilities,...` order declaration                                                                                                                                                                                                          |
| 2 (webawesome)    | 92,277 | Contents of `webawesome.css` → `layers.css` + `native.css` (~30,852 B in `wa-native`) + `utilities/*.css` (≈8,800 B in `wa-utilities`) + `themes/default.css` (which itself pulls `color/palettes/default.css` → `color/palettes/base.css` → `color/variants.css` and the 5 variant files) — the *first* full default-theme bundle |
| 3 (duplicate)     | 51,092 | A **second** copy of `themes/default.css` (which re-pulls `palettes/default.css` → `base.css` → `variants.css` + the 5 variants + the default theme block) — pulled in by the explicit `import "@awesome.me/webawesome/dist/styles/themes/default.css"` in `main.tsx`   |

Block-by-block accounting of segment 3:

| Layer                    | Bytes  | Notes                                       |
|--------------------------|-------:|---------------------------------------------|
| `wa-color-variant` (brand-blue, neutral-gray, success-green, warning-yellow, danger-red) | 33,345 | Re-duplicates the 5 variants from segment 2 |
| `wa-color-palette` (default) | 4,005 | Re-duplicates the default palette           |
| `wa-theme` (default)     | 13,618 | Re-duplicates the default theme tokens      |
| Layer-order declaration  | 105    | Layer-order header repeat                   |
| **Segment 3 total**      | **51,073** |                                              |

> The duplication is observable directly: `awk -v RS='@layer wa-native,wa-utilities' '{print NR-1, length($0)}' vendor-webawesome-*.css` produces three segments of sizes `0`, `92277`, `51092`, confirming the bundler emitted the default-theme content twice.

### `index-i_hgAR1c.css` — 54,889 bytes

Single-line, minified concatenation of the eager imports in `src/main.tsx` lines 3, 9–12. Approximate breakdown:

| Source                                                                  | Source size | Bundle est. | Notes                                                                                |
|-------------------------------------------------------------------------|-----:|-----:|--------------------------------------------------------------------------------------|
| `react-reflex/styles.css`                                               | 3,552 | ~2,929 | Imports for `<ReflexContainer/Element/Splitter>` — **not referenced anywhere in `apps/mission-control-next/src` or any package consumed by it** (see "Notes" below) |
| `@next/styles/mission-control-next-tokens.css`                          | 3,048 | ~2,300 | Design tokens — actively used                                                        |
| `@next/styles/mission-control-next-foundation.css`                      | 1,634 | ~1,200 | Foundation resets — actively used                                                     |
| `@next/styles/mission-control-next.css`                                 | 48,777 | ~21,000 | App shell styles (themes, layouts, panels) — actively used                            |
| `@next/features/native-routes/primitives/primitives.css`                | 26,647 | ~27,500 | Primitives (StageHeader, ThreePartChip, ContextStrip, ModeBar, …) — actively used (selector `.mc-next-stage-head` first appears at byte 23,069 in the bundle) |

**Notes on react-reflex:**
- `apps/mission-control-next/src` has zero references to `ReflexContainer`/`ReflexElement`/`ReflexSplitter`/`ResizablePaneLayout` and zero references to the `reflex-*` class names.
- `packages/mission-control-shared/src/components/ResizablePaneLayout.tsx` exists and DOES depend on react-reflex, but it is consumed only by `apps/mission-control` (legacy). The next app's source never imports it.
- `apps/mission-control-next/package.json` line 49 lists `"react-reflex": "^5.0.5"` but the JS chunk graph doesn't pull the component either — only the CSS is force-imported via `main.tsx` line 3.

**Notes on `wa-*` usage in the app:**
- `apps/mission-control-next/src` contains exactly **one** file referencing webawesome (`app/MissionControlNextApp.tsx`).
- The references are: `wa-theme-default`, `wa-palette-default`, `wa-brand-blue` (added/removed on `<html>` via `useEffect` to drive the theme), and `mc-next-wa-button` (which is a *custom* class — no rule defines `.mc-next-wa-button` anywhere in the repo; the matching style is `mc-next-button mc-next-button-secondary` from the same `className` string).
- **No `<wa-*>` web components are rendered** in `apps/mission-control-next` and **no `--wa-color-*` tokens are referenced** in `apps/mission-control-next/src/**` or in the resulting `index-i_hgAR1c.css`.
- The app effectively only needs the default-theme token tree to feed the three classes above. Native resets from `native.css` may be load-bearing (form/typography defaults), but variant aliases for `danger`/`success`/`warning`/`neutral` are NOT used by any app selector.

## Top trim candidates

### 1. Option A — remove the duplicate `themes/default.css` import (lowest risk)

**Estimated saving: ~51,073 bytes** (initial CSS would drop from 198,316 → ~147,243 bytes, ~37 KB headroom under the 184,320-byte budget).

`apps/mission-control-next/src/main.tsx` lines 4–5:
```ts
import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";  // ← delete this line
```

`webawesome.css` is literally:
```css
@import url('layers.css');
@import url('native.css');
@import url('utilities.css');
@import url('themes/default.css');   // already brings in the default theme
```

The second explicit import causes Vite/PostCSS to emit the default-theme + default-palette + 5 color variants twice. Removing line 5 of `main.tsx` produces identical runtime CSS (last-wins cascade is unchanged because both copies are byte-identical) but saves ~51 KB on disk.

**Risk: very low.** Pure deduplication — no rules change. The only concern would be if some race condition relied on the second copy overriding something — there is no such pattern in this codebase, and even if there were, the duplicated rules are byte-identical.

**Validation:** rebuild + `pnpm --filter @goatcitadel/mission-control-next perf:check`. Both stylesheet sizes should drop, and the bundle should contain only one `@layer wa-color-palette{:where(:root),.wa-palette-default{...}` block (currently two).

### 2. Option B — also drop `react-reflex/styles.css` (low risk)

**Additional estimated saving: ~2,900 bytes** on top of Option A → total ~53,973 bytes saved.

`apps/mission-control-next/src/main.tsx` line 3:
```ts
import "react-reflex/styles.css";  // ← also delete
```

Nothing in `apps/mission-control-next/src/**` or the packages it consumes uses `ReflexContainer/Element/Splitter` or the `.reflex-*` selectors. Vite/Rollup do not tree-shake CSS, so the rules ship in `index-i_hgAR1c.css` for nothing.

**Risk: low.** Verify in CI that no route lazily imports the legacy shared `ResizablePaneLayout` (a content-search confirmed none does, but the verification belongs in the follow-up trim PR). If the dependency itself is unused, also remove `"react-reflex": "^5.0.5"` from `apps/mission-control-next/package.json` to prevent future re-introduction.

Combined Option A + B initial CSS ≈ 144,343 bytes (~40 KB headroom).

### 3. Option C — raise the budget to 200 KB (justification-only)

**No bytes saved.**

Change `scripts/check-mission-control-next-budgets.mjs` line 11 from `180 * 1024` to `200 * 1024` (= 204,800) — gives ~6.5 KB of headroom over today's 198,316 bytes.

**Justification would have to be:** "the `@awesome.me/webawesome` theme bundle is intentionally shipped eagerly to avoid a flash of unstyled tokens during the first paint of `<MissionControlNextApp>`'s top-level theme classes." This argument does **not** hold today because:
- Option A makes the budget pass without changing visible behavior at all.
- Option B makes the budget pass with even more headroom by removing genuinely unused CSS.
- The duplication observed (segment 3 = 51 KB) is a literal bug — the import on `main.tsx` line 5 is redundant with line 4.

Bumping the budget would lock the duplicated CSS into production for every user, every page load, for no benefit. Recommend rejecting Option C unless A and B both fail validation.

## Recommended path

Take **Option A** as the single-line, zero-risk fix: delete `apps/mission-control-next/src/main.tsx` line 5 (`import "@awesome.me/webawesome/dist/styles/themes/default.css";`). That alone cuts ~51 KB and ends the budget breach with ~37 KB of headroom — more than enough to absorb foreseeable additions to `mission-control-next.css` and `primitives.css` over the next few sprints. Pair with Option B (drop the unused `react-reflex/styles.css` import + the dependency from `package.json`) in the same trim PR for an extra ~3 KB of headroom and to remove a stale dependency from the dependency graph. Reject Option C: the duplication is a fix, not a budget that needs revisiting.
