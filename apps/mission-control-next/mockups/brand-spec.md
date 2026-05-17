# GoatCitadel Brand Spec — extended for the design review

Mockup/reference artifact only. This file documents the design-review target and nearby live-token references; it is not release evidence for shipped Mission Control behavior.

Extracted from `src/styles/mission-control-next-foundation.css` and `mission-control-next.css`. The "Signal Noir" dark theme is the current implementation default; "Citadel Light" is supported and inherits the same area-accent system.

## Color — Signal Noir (dark, default)

```css
--bg-app:        #14181d;     /* shell */
--bg-surface-1:  #181d24;     /* cards, rail */
--bg-surface-2:  #10141a;     /* sidebar, well */
--bg-surface-3:  #222833;     /* elevated */
--fg-primary:    #f4f1ea;     /* cream paper-white */
--fg-muted:      #898f99;     /* labels, eyebrows */
--border-subtle: rgba(255,255,255,0.08);
--border-default:rgba(255,255,255,0.12);
--border-strong: rgba(244,234,214,0.22);

--brand:         #f4ead6;     /* cream-gold — primary action */
--brand-deep:    #948b78;     /* gold lockup gradient end */
```

## Area accents (per route family)

```css
--area-chat:     oklch(0.72 0.12 240);   /* cobalt    */
--area-cowork:   oklch(0.73 0.13 315);   /* magenta   */
--area-code:     oklch(0.74 0.12 175);   /* teal      */
--area-projects: oklch(0.76 0.13 205);   /* cyan      */
--area-library:  oklch(0.72 0.10 255);   /* indigo    */
--area-ops:      oklch(0.71 0.08 220);   /* slate-blue*/
--area-settings: oklch(0.78 0.10 85);    /* amber     */
```

Mix rule: tint borders and ambient washes at 12–18% accent into `--bg-surface-3`. Never flood a panel; the accent reads as a *family marker*, not a brand color.

## Risk semantics

```css
--risk-safe:    oklch(0.76 0.15 160);
--risk-caution: oklch(0.84 0.15 85);
--risk-danger:  oklch(0.70 0.18 28);
--risk-nuclear: oklch(0.68 0.22 345);
```

## Typography

- **Body / display**: `"Geist Variable", sans-serif` — single family across weights 400/500/600/700. Letter-spacing `-0.02em` at display sizes, `0` for body, `0.08em uppercase` for eyebrows.
- **Mono**: `ui-monospace, "SFMono-Regular", Consolas, Menlo, monospace` — used for IDs, hashes, token counts, cron, log timestamps.

## Density

The current implementation uses **12px base** with most controls at 0.66–0.72rem. The review mockups keep that density honest but bump the *type scale* up one step (13px base, headings 1.1–1.5rem) so reviewers can read at desktop scale without zooming. The control sizes (rails, buttons, chips) remain the same physical pixel ranges as the live app.

## Radii + posture

```
--r-xs: 0.32rem;   /* buttons, chips */
--r-sm: 0.5rem;    /* inputs */
--r-md: 0.9rem;    /* cards */
--r-lg: 1.25rem;   /* hero panels */
--r-pill: 999px;   /* status, badges */
```

- No drop shadows in dark mode. Borders + `color-mix` washes do the elevation work.
- Sticky topbar `36px`, status strip `22px`, primary rail `196–220px`.
- Hairline 1px borders, never 2px.

## What I'm changing (in the mockups)

1. **Type scale** — current scale is ~12px everywhere; reviewers, mockups, and accessibility benefit from a 13/15/18/22/28/40 scale with the same control heights.
2. **Hierarchy on stage headers** — current `.mc-next-stage-header` is a generic chip-row; mockups separate eyebrow / title / metric strip with real vertical rhythm.
3. **Area color as wayfinding** — currently the accent only tints the active rail link; mockups extend it into a 1px top stripe on the stage and a tinted micro-badge near the route title.
4. **Status density** — current StatusChip is a single pill; mockups introduce a 3-part chip (dot + state + age) for live monitoring surfaces (runtime, approvals).
5. **Settings IA consolidation** — 13 sections collapse into 4 groups (Foundations / Identity / Surfaces / Operations) so the rail fits one screen on a laptop.
6. **Threaded composer** — current composer is a flat textarea; mockup adds a persistent "context attached" strip showing model, mode, attached files, and live token/cost without taking vertical space from the message area.
