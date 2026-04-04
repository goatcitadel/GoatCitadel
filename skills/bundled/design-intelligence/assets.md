# Assets

This file governs icons, imagery, media, and motion implementation.

Use it after structural decisions are made. Asset decisions should reinforce hierarchy, performance, and consistency.

## Icon Policy

### Prefer existing icon systems first

In `Adopt` and `Repair`:

- inspect the repo for current icon family and wrapper
- keep the same family unless the user explicitly requests a change
- reuse current size and stroke conventions

### If choosing a new icon family

Use one family per surface.

Keep consistent:

- stroke weight
- optical size
- corner style
- filled vs outlined logic

### Avoid hallucinated icon names

If the project uses icon retrieval tooling:

- query the actual library when possible
- do not invent icon names or assume a package exposes a glyph because it sounds plausible

If icon tooling is unavailable:

- use verified common names from the installed package
- fall back to text labels or simpler icons instead of guessing

### Icon-only accessibility

- icon-only controls require an accessible name
- decorative icons should be hidden from assistive technology
- informative icons should not be the only carrier of meaning when text is feasible

### Decorative vs informative icons

- decorative: purely visual reinforcement; hide from screen readers
- informative: carries status or meaning; pair with text or clear programmatic context

## Image Policy

### Decorative vs informative imagery

- decorative imagery can be omitted or hidden from assistive technology
- informative imagery needs alt text that conveys the useful information, not the literal pixels

### Alt text rules

- describe purpose, not just appearance
- skip "image of" unless needed for clarity
- if the surrounding copy already conveys the same information, keep alt concise

### Placeholder rules

- use stable placeholders, not broken boxes
- prefer domain-appropriate neutral placeholders over generic stock-y filler
- in admin and dense workflow surfaces, an icon or simple illustration is usually enough

### Responsive image strategy

- declare dimensions or aspect ratio
- avoid unexpected layout shifts
- crop intentionally for the surface rather than relying on arbitrary object-fit defaults

### Local, CDN, and service tradeoffs

- local assets improve determinism
- CDN can improve delivery but adds external dependency
- service-based images need failure and loading behavior

Choose the simplest option that matches the product needs and deployment model.

### Loading behavior

- lazy load below-the-fold images
- prioritize above-the-fold hero or product imagery when it affects LCP
- blur placeholders are useful when image transitions matter and the stack supports them

## Motion Implementation

Motion is an implementation concern, not just a style decision.

### Allowed properties

Prefer:

- `transform`
- `opacity`
- modest filter changes only when performance budget allows

Use caution with:

- width
- height
- top, left, right, bottom
- box-shadow on large surfaces
- backdrop blur on large or animated surfaces

### Interaction motion

Use for:

- button press feedback
- hover confirmation
- switch toggles
- menu and popover opening

Keep it short, local, and clearly tied to user action.

### Transition motion

Use for:

- panel changes
- tab swaps
- view transitions
- list reordering where orientation benefits

Do not animate every surface change just because the library supports it.

### Entrance motion

Use when:

- new content needs orientation help
- marketing sections benefit from staged reveal

Avoid when:

- the user is in a dense task flow
- content appears frequently
- performance is tight

### Stagger motion

Use sparingly:

- marketing sections
- small collections
- onboarding moments

Avoid for:

- tables
- long lists
- operational dashboards

### Continuous motion

Use only when it communicates state, activity, or ambient brand language without distraction.

Avoid:

- looping decorative motion near forms
- floating ornaments that compete with data
- idle movement in dense admin surfaces

### Reduced motion

- honor reduced-motion preferences
- replace movement with opacity, instant state change, or no animation
- keep the UI understandable without motion

### Offscreen pausing

- pause heavy or continuous motion when offscreen
- do not keep observers and intervals alive on hidden decorative elements without reason

### Layout transition cautions

- avoid animating between radically different heights in dense flows unless it truly helps orientation
- clamp expansion motion for accordions and stacked editors

### Scroll-linked motion cautions

- use only when it materially supports narrative surfaces
- avoid on settings, dashboards, and dense workspaces
- test performance on lower-end devices

### When to avoid motion entirely

- safety-critical confirmations
- permission or billing settings
- dense table administration
- high-frequency state changes

## Media Performance

### Image sizing and formats

- raster for photography and rich screenshots
- SVG for logos, simple illustrations, and icons
- modern formats are preferred when the toolchain supports them

### SVG vs raster

- SVG is excellent for crisp scalable vector assets
- raster is safer for detailed imagery or when vector complexity becomes heavy

### Video

- autoplay only when muted and genuinely useful
- looping background video must not obscure content or tank performance
- always provide a still fallback where appropriate

### Animation library caution

- use the smallest motion tool that fits the job
- do not pull a heavy library for a tiny hover effect
- in Adopt mode, follow the stack already in use

### Blur and backdrop caution

- blur can be expensive, especially in large overlays or animated layers
- test on low-end hardware before treating blur as baseline chrome

### LCP considerations

- hero media, large dashboard graphs, and above-the-fold illustrations affect perceived speed
- prioritize stable sizing and fast decode for first-view media

## Asset Consistency

Keep asset language coherent within a surface:

- one icon family
- one illustration posture
- one avatar placeholder strategy
- one chart styling family

Consistency does not require sameness. It requires that the user can tell the assets belong to one product.

## Examples

### Dashboard icons

- reuse the app's icon family
- use stroke-consistent icons in nav and row actions
- keep status meaning in text and color, not icon alone

### Landing page media

- prioritize one strong hero asset or product visual
- support it with smaller proof visuals only if they add clarity

### Form illustrations

- keep them secondary
- remove or demote them on small screens if they compete with completion

### Table-heavy app surface

- keep imagery rare
- use avatars, status dots, or small previews only when they help row scanning

### Empty state asset usage

- use simple icons or lightweight illustrations
- avoid giant whimsical art in serious admin surfaces


