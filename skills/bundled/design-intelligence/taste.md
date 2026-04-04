# Taste

This file is the style strategy layer.

It contains:

- `Class C - Taste Warning`: patterns that often correlate with generic or lazy output
- `Class D - Style Choice`: brand-, product-, and audience-dependent decisions

Taste guidance should improve intention without pretending every product needs the same visual personality.

## Style Intent Taxonomy

Pick a style intent that fits the product, surface, and task. Do not default to "premium" or "creative."

### restrained

- quiet hierarchy
- low ornament
- neutral palette discipline
- good for settings, docs, and serious product surfaces

### technical

- crisp spacing
- visible data structure
- code- and system-friendly typography
- good for dashboards, observability, devtools, admin

### editorial

- stronger type hierarchy
- purposeful whitespace
- more reading rhythm and section pacing
- good for docs, narrative marketing, thought-leadership pages

### warm

- softer color temperature
- friendlier tone
- moderate rounding and gentler contrast
- good for onboarding, consumer flows, support surfaces

### premium restrained

- refined contrast
- deliberate typography
- low noise, high finish
- good for high-trust product marketing without theatrics

### dense utilitarian

- compact spacing
- minimal decoration
- obvious grouping and status cues
- good for internal tools and data-heavy work

### playful

- stronger accents
- friendlier motion
- more elasticity in illustration and layout
- good for youth-oriented or light consumer experiences

### polished product

- balanced hierarchy
- clean tokens
- moderate motion and contrast
- good default for mainstream SaaS

### calm enterprise

- stable structure
- conservative motion
- muted but not dull color roles
- good for B2B settings, dashboards, account management

### expressive marketing

- stronger section contrast
- more assertive display typography
- selective emphasis and richer visuals
- good for campaigns and launches

## Typography Strategy

Typography is not a purity test.

### Neutral vs characterful fonts

- neutral fonts are correct when clarity, continuity, or system fit matter more than personality
- characterful fonts help when the product needs a clearer point of view, especially in marketing or editorial work
- in Adopt mode, keep the existing font stack unless the user explicitly asked to change it

### Role-based typography

Use distinct roles:

- display: hero moments, campaign emphasis, occasional section anchors
- heading: section structure and page hierarchy
- body: reading and explanation
- data: metrics, tables, IDs, numbers, timestamps

Do not use one oversized display style to solve weak content hierarchy.

### When system-like typography is correct

Use system-like or neutral product typography when:

- the app is utilitarian
- density is high
- the audience expects tool-like reliability
- the existing system already uses it

### When more character helps

Use stronger type personality when:

- the surface is marketing or editorial
- the product needs faster distinction
- the brand already leans expressive

Avoid becoming weird for its own sake. Distinctiveness is not the same as eccentricity.

### Heading rhythm

- headings need clear size and weight progression
- spacing above a heading often matters more than adding another border
- very heavy headings in small utility surfaces often feel blunt and generic

### Line length and density

- narrower reading widths improve comprehension in docs and marketing copy
- dense enterprise surfaces can tolerate longer lines in labels and tables, but explanation copy should still stay readable

### Number typography

- use tabular or stable-width numerals when values update in place or align in columns
- data-heavy surfaces should treat numeric rhythm as part of visual quality

### Monospace usage

Use monospace for:

- code
- IDs and tokens
- terminals or system output
- data where alignment matters

Do not force monospace into general product copy to look technical.

### Avoiding generic typography without overcorrecting

- pair a neutral body face with a more intentional display or heading treatment
- vary size, weight, letterspacing, and rhythm before reaching for novelty fonts
- avoid giant all-caps token labels everywhere unless the product language supports it

## Color Strategy

Use role-based color logic, not palette dumping.

### Role-based palette logic

Every surface needs:

- background layers
- text hierarchy
- border or separation color
- accent or interaction color
- semantic roles for destructive, warning, success, and informational states

### Accent discipline

- one primary accent is usually enough per surface
- secondary accents should have a reason such as charts or campaign emphasis
- too many accents flatten hierarchy and make everything feel template-built

### Neutral family selection

- warm neutrals can soften onboarding and editorial work
- cool neutrals fit technical or enterprise surfaces
- the neutral family should match the product posture more than a trend

### Contrast expectations

- text must meet accessibility requirements
- low-contrast muted text is acceptable only for genuinely secondary metadata
- if a surface depends on subtle dividers, compensate with spacing and hierarchy, not just lighter borders

### Dark mode behavior

- do not invert blindly
- reduce saturation in large dark surfaces
- keep semantic colors distinguishable without glowing
- test focus rings and disabled states separately in dark mode

### Border vs shadow vs fill

- borders help dense, utilitarian surfaces
- soft fills can group content without card spam
- shadows are strongest when used sparingly for elevation, not as constant decoration

### Saturation by surface

- marketing can handle stronger saturation and contrast shifts
- settings and dense admin work should stay more restrained
- dashboards may use accent color for status, but not every metric card needs a hero accent

### Data color caution

- chart palettes need role clarity and accessibility
- do not use semantic red/green without considering color-blind readability
- do not apply marketing accent logic directly to data visualization

## Motion Personality

Match motion to context.

### settings/admin

- restrained and functional
- emphasize state change, reveal, and confirmation
- avoid spectacle

### dashboard

- subtle and informative
- motion should help track updates, not dramatize them

### marketing

- can be more expressive if it reinforces story and does not obstruct reading

### auth/onboarding

- reassuring, low-friction, and legible
- avoid motion that feels like delay

### dense workflow

- minimal distraction
- fast feedback beats elaborate transitions

### mobile

- tactile and responsive
- short distance, short duration, obvious touch linkage

## Taste Warning Catalog

Each warning is a signal, not an automatic defect.

### Overused neutral product font pairing

Why it often feels generic:

- the surface makes no typographic choices beyond defaults

Acceptable when:

- the product is intentionally tool-like or the existing system already uses it well

Diversify without gimmicks:

- improve heading rhythm, number styling, and spacing before swapping the whole font stack

### Generic centered hero

Why it often feels generic:

- symmetry is doing all the design work

Acceptable when:

- the page really has one message and one action

Diversify without gimmicks:

- add earlier proof, asymmetry, or stronger support structure

### Three equal feature cards

Why it often feels generic:

- it avoids prioritization

Acceptable when:

- the features are truly peer-level and brief

Diversify without gimmicks:

- lead with one flagship feature and demote the rest

### Purple-blue gradient cliche

Why it often feels generic:

- it imitates startup wallpaper rather than product meaning

Acceptable when:

- the brand already owns that territory and the contrast remains disciplined

Diversify without gimmicks:

- tune hue temperature, reduce spread, or use accent gradients more selectively

### Filler startup names

Why it often feels generic:

- placeholder branding undermines trust and distinctiveness

Acceptable when:

- the user explicitly wants generic demo branding

Diversify without gimmicks:

- use realistic but neutral placeholders tied to the product domain

### Vague hype copy

Why it often feels generic:

- "revolutionary," "seamless," and "next-gen" avoid real value communication

Acceptable when:

- almost never, unless parody is the goal

Diversify without gimmicks:

- write concrete claims, user outcomes, and proof

### Unrealistic round numbers

Why it often feels generic:

- fake metrics signal template content

Acceptable when:

- clearly marked as sample data in an internal prototype

Diversify without gimmicks:

- use plausible ranges, realistic counts, or labeled placeholders

### Glassmorphism overuse

Why it often feels generic:

- translucent surfaces become decoration instead of hierarchy

Acceptable when:

- the brand language and performance budget support it, and it is used sparingly

Diversify without gimmicks:

- mix solid surfaces, subtle fills, and stronger typography instead of more blur

### Default card spam

Why it often feels generic:

- every section gets the same container whether it needs one or not

Acceptable when:

- the product genuinely needs repeated modular grouping

Diversify without gimmicks:

- vary grouping methods with whitespace, dividers, and table/list structures

### Over-rounded everything

Why it often feels generic:

- rounding becomes a substitute for character

Acceptable when:

- the brand is soft and consumer-friendly

Diversify without gimmicks:

- reserve stronger rounding for touch-heavy or high-emphasis elements

### Excessive drop shadows

Why it often feels generic:

- elevation loses meaning when everything floats

Acceptable when:

- the UI uses depth as a real layer model

Diversify without gimmicks:

- use borders and contrast shifts for separation first

### Mindless bento grids

Why it often feels generic:

- collage replaces content hierarchy

Acceptable when:

- the surface is exploratory marketing and the content blocks genuinely differ

Diversify without gimmicks:

- use selective asymmetry rather than a page-wide mosaic

## Style Presets

### Preset: Calm Enterprise

- Typography posture: neutral body, restrained headings, stable numeric styling
- Spacing posture: moderate, with strong grouping discipline
- Density posture: medium to medium-high
- Motion posture: low and functional
- Accent behavior: one controlled accent, semantic colors stay disciplined
- Visual restraint level: high

### Preset: Polished Product

- Typography posture: neutral with sharper heading rhythm
- Spacing posture: moderate and consistent
- Density posture: medium
- Motion posture: subtle, confident, non-showy
- Accent behavior: clear primary accent, selective secondary use
- Visual restraint level: medium-high

### Preset: Technical Console

- Typography posture: compact headings, strong data treatment, optional monospace accents
- Spacing posture: tighter
- Density posture: high
- Motion posture: minimal and informative
- Accent behavior: status-led, limited flourish
- Visual restraint level: high

### Preset: Premium Restrained

- Typography posture: more deliberate display and heading contrast
- Spacing posture: generous but not wasteful
- Density posture: low to medium
- Motion posture: smooth, low-frequency, highly controlled
- Accent behavior: elegant, sparse, often one highlight color
- Visual restraint level: high, but refined rather than plain

### Preset: Expressive Marketing

- Typography posture: strong display moments with simpler body support
- Spacing posture: varied section rhythm
- Density posture: low to medium
- Motion posture: medium, story-supporting
- Accent behavior: bolder contrast and stronger section changes
- Visual restraint level: medium

## Copy Tone Guardrails

Avoid generic product-copy sludge without turning every line into theater.

- use concrete nouns and verbs
- say what the product does, for whom, and why it matters
- favor evidence over slogan stacking
- keep feature labels specific
- use warmth only where it helps comprehension or trust
- do not write every heading like a manifesto

## Examples

### Calm Enterprise + settings page + Adopt mode

- keep the existing typography if it is already neutral and clear
- use low motion
- use local description copy and minimal ornament

### Expressive Marketing + landing page + Create mode

- allow stronger display type and section contrast
- keep the CTA path obvious
- use taste warnings as guardrails, not handcuffs

### Technical Console + dashboard + Repair mode

- reduce decorative flourish
- improve data hierarchy and spacing first
- treat motion and accent as status tools, not brand theater


