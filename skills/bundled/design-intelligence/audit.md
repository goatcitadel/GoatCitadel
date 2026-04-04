# Audit

This file defines how to review UI output in a way that is actionable, repeatable, and severity-aware.

Audit is not a vibe check. It is a structured pass that maps issues back to the module that should own the fix.

## Audit Modes

### Quick audit

Use when:

- the task is small
- the user wants a fast review
- the output is a single component or a narrow page change

Quick audit should still check all eight dimensions, but with shorter notes and only the highest-signal findings.

### Full audit

Use when:

- the user asks for ship-readiness
- the surface is complex or multi-step
- multiple components and layout systems changed at once
- motion, responsiveness, and distinctiveness all matter

Full audit should produce:

- dimension coverage
- explicit severities
- smallest fix recommendation
- routing to the owning module

## Audit Dimensions

Audit every output across these eight dimensions.

### 1. Correctness

Check:

- component behavior matches intent
- primitives are appropriate
- state transitions make sense
- actions do what the UI implies

### 2. Accessibility

Check:

- labels and names
- keyboard behavior
- focus visibility and order
- semantic structure
- reduced-motion handling where relevant

### 3. Responsiveness

Check:

- collapse strategy
- overflow handling
- mobile prioritization
- touch targets
- sticky region safety

### 4. Performance

Check:

- layout-thrashing risk
- media sizing and loading
- heavy motion or blur
- unnecessary dependency weight

### 5. State Completeness

Check:

- loading
- empty
- error
- disabled
- success or confirmation
- no-access or permission states where needed

### 6. Visual Coherence

Check:

- one surface feels like one system
- spacing rhythm is consistent
- type and color roles are clear
- component families do not clash

### 7. Distinctiveness

Check:

- whether the output feels intentional for the product and surface
- whether it avoids lazy defaults
- whether creativity helps or harms clarity

### 8. Maintainability

Check:

- reuse of existing components or primitives
- reasonable abstraction boundaries
- limited scope expansion
- avoidable dependency churn

## Severity Levels

### P0 blocker

- unsafe to ship
- breaks accessibility, core correctness, or essential interaction
- no reasonable "ship now, fix soon" interpretation

### P1 serious

- not a total blocker in all contexts, but likely to cause user failure, confusion, or major quality regression
- should be fixed before shipping normal production work

### P2 medium

- meaningful weakness that harms clarity, responsiveness, coherence, or maintainability
- can ship temporarily if risk is understood

### P3 polish

- small quality improvement
- not misleading, unsafe, or materially harmful

## Audit Output Schema

For every issue include:

- `dimension`
- `severity`
- `what is wrong`
- `why it matters`
- `smallest reasonable fix`
- `owning module`
- `blocks shipping`

Recommended plain-text format:

```text
- Dimension: Accessibility
  Severity: P0 blocker
  What is wrong: The dialog close control is icon-only and unlabeled.
  Why it matters: Screen-reader users cannot identify the control.
  Smallest reasonable fix: Add an accessible label and keep the visible icon.
  Owning module: enforcement
  Blocks shipping: yes
```

## Routing Table

Every issue should route to the module that owns the fix logic.

| Issue type | Owning module |
| --- | --- |
| semantic failure, missing focus, missing required state, fake completeness | `enforcement` |
| wrong component choice, missing keyboard contract, primitive misuse | `components` |
| broken hierarchy, collapse strategy, density mismatch, poor action placement | `layout` |
| generic typography, undisciplined color, derivative style choices | `taste` |
| icon inconsistency, bad media handling, motion implementation risk | `assets` |

If an issue spans multiple areas, route to the module that should lead the fix and mention secondary modules if useful.

## Distinctiveness Scoring

Distinctiveness is not a purity test and not a demand for novelty.

Evaluate these questions:

1. does the output fit the product and surface
2. does it avoid lazy defaults where they weaken the work
3. is there evidence of intention in hierarchy, typography, spacing, and component choice
4. does it feel derivative in a harmful way
5. does any creativity hurt clarity or trust

### Healthy distinctiveness

- the output feels deliberate
- defaults are adapted instead of copied blindly
- the page could plausibly belong to the stated product

### Harmful derivative behavior

- generic startup gradients with generic copy and generic cards
- trendy visual devices doing all the work while hierarchy remains shallow
- copied aesthetics that conflict with the product's actual task

### Harmful overcorrection

- forced uniqueness that damages readability
- expressive motion in a settings page
- characterful typography that makes a data console harder to scan

## Dimension Checklists

### Correctness checklist

- are the chosen primitives correct for the interaction model
- do labels, actions, and outcomes line up
- are destructive actions clearly scoped
- are local actions placed where the user expects them

### Accessibility checklist

- does every control have a usable name
- can the flow be completed with a keyboard
- is focus visible everywhere it should be
- are dialogs, menus, tabs, and popovers using correct behavior
- is motion safe and reducible

### Responsiveness checklist

- what happens at narrow widths
- what happens to tables
- what happens to sidebars
- are tap targets large enough
- does any sticky region hide content

### Performance checklist

- any unnecessary heavy library
- any large media without size discipline
- any blur, shadow, or animation overuse
- any layout-thrashing measurement or transition patterns

### State completeness checklist

- loading
- empty
- no results
- error
- disabled
- success or saved state
- no-permission if relevant

### Visual coherence checklist

- one icon family
- one spacing rhythm
- one surface grammar
- type scale and color roles feel related

### Distinctiveness checklist

- is this merely default template output
- if yes, does that actually hurt the product
- what is one concrete way to increase intention without increasing gimmick

### Maintainability checklist

- did the change reuse existing pieces where possible
- did it avoid unnecessary new dependencies
- is the abstraction level reasonable
- did it avoid unrelated cleanup and scope spread

## Sample Audit Output

Surface under review:

- existing admin users page with a new table view, filter popover, and row action menu

Mode:

- Adopt

Profile:

- shipping

Findings:

- Dimension: Accessibility
  Severity: P0 blocker
  What is wrong: The row action trigger is an unlabeled icon button.
  Why it matters: Screen-reader users cannot identify the control, and this is the only path to row-level actions.
  Smallest reasonable fix: Add a stable accessible label such as "Open actions for [user name]" or a generic menu label when row context is already announced nearby.
  Owning module: enforcement
  Blocks shipping: yes

- Dimension: Responsiveness
  Severity: P1 serious
  What is wrong: The table collapses by horizontal squeezing only, causing five columns to become unreadable on small screens.
  Why it matters: Mobile and narrow-window users cannot scan or act on rows reliably.
  Smallest reasonable fix: Hide low-priority columns, preserve identifier and status columns, and move the rest into row expansion or detail view.
  Owning module: layout
  Blocks shipping: yes

- Dimension: Correctness
  Severity: P1 serious
  What is wrong: The filter panel is implemented as a tooltip with interactive checkbox content.
  Why it matters: The primitive does not match the interaction model and keyboard behavior will be unreliable.
  Smallest reasonable fix: Replace the tooltip with a popover primitive designed for interactive content.
  Owning module: components
  Blocks shipping: yes

- Dimension: Visual Coherence
  Severity: P2 medium
  What is wrong: The new view introduces a different icon family from the rest of the admin shell.
  Why it matters: The page feels locally pasted in and increases maintenance inconsistency.
  Smallest reasonable fix: Reuse the existing icon family already used in the shell and toolbar.
  Owning module: assets
  Blocks shipping: no

- Dimension: Distinctiveness
  Severity: P3 polish
  What is wrong: The header summary cards use the same generic equal-card treatment seen in many default SaaS dashboards.
  Why it matters: The surface works, but the hierarchy misses a chance to reflect what matters most operationally.
  Smallest reasonable fix: Promote the primary operational metric and collapse the least useful summary into inline metadata or the toolbar.
  Owning module: taste
  Blocks shipping: no

## Audit Discipline

Do not emit vague advice such as:

- "improve hierarchy"
- "make it more modern"
- "clean up spacing"

Instead say:

- what is wrong
- where it is wrong
- why it matters
- the smallest fix that would materially improve it

If an issue is subjective:

- keep the severity low unless it clearly harms product fit or clarity
- state the tradeoff rather than overstating certainty


