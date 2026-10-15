# DESIGN.md

Design context for coding agents working on GoatCitadel's operator-facing surfaces. Read it before changing anything an operator sees. It describes the Mission Control **cockpit** (`apps/mission-control-next/src/cockpit`), the only shell that receives new design work; the Classic shell (`features/native-routes`, `features/threaded-surface`) is retiring and is out of scope. This file is repository guidance only: the runtime never injects it, and a workspace's own `DESIGN.md` (Settings › Workspaces › Design context) is a separate, operator-owned document.

Sources of truth, in order: `apps/mission-control-next/src/cockpit/styles/cockpit-tokens.css`, `apps/mission-control-next/src/styles/mission-control-next-tokens.css`, `docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md` (section 10, visual language), `docs/superpowers/specs/2026-09-22-goatcitadel-mark-and-icons-design.md`, and the North Star and UI/UX Direction sections of `AGENTS.md`. When this file and a token file disagree, the token file wins.

## Brand

```brand
name: GoatCitadel
colors: #006f85, #5ce9ff, #142536, #f0f8ff, #0e1a27, #cfe0ee
fonts: Geist Variable, Hanken Grotesk Variable
logo: apps/mission-control-next/public/brand/source/goatcitadel-mark.svg
```

- `#006f85` is the light-theme accent and `#5ce9ff` the dark-theme accent (`--cockpit-accent`). Cyan is the only accent: focus, primary actions, and live work. Green, amber, and red mean status and nothing else.
- `#142536` is light-theme text and `#f0f8ff` the light-theme canvas. `#0e1a27` (navy) and `#cfe0ee` (ice) come from the mark: the navy tile and the horns and tower.
- The mark is the flat vector "horned citadel" (`goatcitadel-mark.svg`, with `goatcitadel-mark-tray.svg` for sizes at or below 24px). Icons derive from those two SVGs through `pnpm brand:derive`; never hand-edit derived icons. The raster lockup stays for README and splash use only.

## Feel

Mission control, observability dashboard, high-trust control center. Bright, clean, breathable; teal and cool neon accents over a light canvas, never muddy dark-on-dark. Dense but scannable: purposeful panels, clear status hierarchy, one 48px header row per view, no global top bar, no footer status strip. Cyberpunk is allowed in sharpness and light, never at the cost of readability, hierarchy, spacing, accessibility, or responsiveness.

## Tokens and surfaces

Cockpit styles declare raw colors in exactly one place, `cockpit-tokens.css`; every other stylesheet and every Tailwind utility uses token names (`bg-canvas`, `bg-raised`, `bg-sunken`, `text-fg`, `text-fg-secondary`, `text-fg-muted`, `border-line`, `border-line-subtle`, `border-line-strong`, `bg-accent`, `text-accent-ink`, `text-status-*`). The design-quality gate (`pnpm verify:design:quality`) counts raw color literals outside the token files and fails above budget.

| Group | Tokens | Light | Dark |
| --- | --- | --- | --- |
| Surfaces | canvas, raised, sunken, overlay, document-surface | `#f0f8ff`, `#ffffff`, `#deeffa`, `#ffffff` | `#122235`, `#1a3045`, `#0f1d2d`, `#244057` |
| Text | text, text-secondary, text-muted | `#142536`, `#334a5a`, `#506574` | `#f4fbff`, `#d3e3ed`, `#b0c8d5` |
| Borders | subtle, default, strong | `rgba(18, 69, 93, .15/.24/.38)` | `rgba(178, 224, 245, .14/.24/.38)` |
| Accent | accent, accent-ink | `#006f85`, `#f6fbff` | `#5ce9ff`, `#0c2530` |
| Status | running, waiting, done, failed, neutral | `#006f85`, `#855500`, `#08734e`, `#a72e48`, `#506574` | `#5ce9ff`, `#ffd166`, `#59e6aa`, `#ff8292`, `#b0c8d5` |

Both themes are first-class. Contrast: body and placeholder text at least 4.5:1, large text at least 3:1; on colored surfaces tint secondary text from the hue, never plain gray.

## Type

- Geist Variable for interface text; Hanken Grotesk Variable (`font-display`) for page titles and the section headings that settings pages already use it for, never for body copy; the system monospace for code, IDs, hashes, and receipts, never as a costume for "technical".
- Seven sizes: `xs` 12/16 metadata, `sm` 13/18 dense UI, `base` 14/20 default UI, `md` 16/24 chat prose, `lg` 20/28 section titles, `xl` 24/32 page titles, `2xl` 32/40 empty-state heroes. Use the `--text-*` tokens; no hard-coded sizes.
- Sentence case everywhere. No all-caps labels. Headings carry their own weight: no kicker or eyebrow label above a heading, anywhere in the cockpit.

## Space, shape, depth, motion

- A 4px spacing grid; tight groups, generous separation, more space above a heading than below it.
- Radius 6, 8, 12, or full (`--r-sm`, `--r-md`, `--r-lg`, `--r-pill`).
- Flat surfaces with hairline borders. No boxes inside boxes, no nested cards. Shadows only on overlays, and a shadow carries an offset and a soft blur; a zero-offset colored halo is decoration.
- Motion: the token durations are `--motion-fast` 120ms, `--motion-base` 160ms, `--motion-slow` 220ms with `--motion-ease` (the cockpit declares no durations of its own); one authored moment per view, a pulse marks live runs, and `prefers-reduced-motion` is honored.
- Breakpoints (min-width): `sm` 640, `md` 1024, `lg` 1280, `xl` 1600. Below 640px the sidebar is a drawer, the inspector a bottom sheet, and navigation moves to bottom tabs. Density is Comfortable or Compact via `data-density`; it never hides content.

## Status and trust vocabulary

One shared module maps domain states to label, tone, and icon; no raw status string, enum value, ID, URL, API path, or stack trace reaches the screen (IDs appear only in monospace technical slots inside the inspector). Labels operators see: Queued, Running, Waiting on you, Waiting, Paused, Done, Failed, Cancelled, Failed · needs recovery, Needs your input, Needs confirmation, Applying, Verifying, Monitoring, Needs a manual step, Rolling back, Rolled back, Draft, Approved, Approved with edits, Denied, Expired, Withdrawn, Blocked by policy, Couldn't deliver, Outcome unknown. Risk reads Safe, Caution, Danger, Nuclear. Trust reads Built-in, Verified, Reviewed, Not reviewed, Quarantined. Status is never conveyed by color alone.

## Decisions and danger

Red (`variant="danger"`) means one thing: this action deletes, forgets, revokes, removes, discards unsaved work, or rejects in bulk, and the cockpit cannot take it back. Everything reversible uses primary or secondary styling, including archive, restore, close or mark done, test, send for approval, retry, cancel a run, deny a single request, and reject a single proposal.

- Approvals scale with risk. A safe or caution approval is a primary "Approve once". A danger or nuclear approval is a red, risk-labelled review button with a shield icon, and nuclear risk adds a typed confirmation. Deny is always a neutral secondary button, because denying is the safe choice.
- Proposals (memory, documents, improvements) apply or promote with a primary button and reject with a secondary one.
- Typed confirmations use the shared `TypedConfirmation` (case- and space-insensitive, phrase shown in monospace). Unsaved-changes prompts use the shared `UnsavedChangesDialog`: Save and continue (primary), Keep draft and close, Discard changes (danger), then Cancel last.
- A destructive confirmation states its scope and consequence before the button: how many items, in which workspaces, and whether it can be undone here.

`scripts/check-mission-control-next-danger-actions.mjs` enforces the parts that can be checked statically.

## Copy

Sentence case; buttons are verbs that name their action. The product speaks to "you"; the assistant says "I" only inside chat messages. Errors say what happened and what to do, with no "Error:" prefix. Plain names first, Citadel names second ("Rules · Wards"). Truth beats theater: experimental, compatibility-only, advisory, or manually governed things say so; missing evidence is shown as missing, never as zero, clean, or healthy.

## Components to reuse

Start from the cockpit primitives in `apps/mission-control-next/src/cockpit/ui` (`Button`, `Field`, `EmptyState`, and their siblings) and the shared components in `packages/mission-control-shared/src/components` before writing a new one. Server state goes through TanStack Query and the shared API clients; realtime events invalidate queries. Keep loading, error, empty, stale, partial, reconnecting, blocked, and unavailable states distinct, and keep dangerous actions explicit with their scope and consequence.

## Craft floor

The cockpit follows the impeccable craft floor (`skills/bundled/impeccable/reference/craft-floor.md`). In addition to the rules above, refuse by default: identical icon-heading-text card grids as page structure, the hero-metric template, numbered section markers, modals for tasks that need no interruption, gradient text, decorative glass and blur, colored side-stripe borders above 1px, zero-blur block shadows, sparklines and progress rings standing in for content, emoji or Unicode glyphs standing in for icons (icons come from one library at one stroke weight), invented metrics, and placeholder copy. Every control has hover, disabled, loading, error, and empty states, visible keyboard focus, and an accessible name. Verify on the built result at desktop and phone widths, in both themes.

## Decks, documents, and HTML artifacts

Generated decks and documents are rendered by the policy engine's templates, which never see CSS; the design skill shapes their content, structure, and the `design` arguments (mode, preset, audience, brand). A workspace's `DESIGN.md` brand block (see Settings › Workspaces › Design context) supplies `design.brand` when the model gives none; the first color is the accent. HTML artifacts preview inside a sandboxed iframe under the gateway's baseline content security policy: images and fonts may be inline `data:` URIs (`img-src` and `font-src` both admit `data:`), scripts never run, and no cross-origin fetch is allowed; same-origin shell assets (`'self'`) can still load in the preview. The offline PNG renders inject the same policy but run with no origin and no network, so a same-origin asset that shows in the preview is absent from the render evidence; write artifacts self-contained.
