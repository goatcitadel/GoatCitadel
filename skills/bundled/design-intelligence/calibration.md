# Calibration

This file makes the dials operational.

Do not treat the numeric values as fake precision. Use them as anchor ranges that translate into concrete design behavior.

## DESIGN_VARIANCE

Higher variance means more willingness to depart from plain defaults in rhythm, emphasis, and asymmetry.

### Anchor: 2

- Layout implications: highly predictable structure; symmetry and standard section ordering dominate
- Spacing implications: consistent and restrained; few dramatic jumps
- Motion implications: motion should stay quiet because the layout itself is stable
- Component implications: mostly familiar patterns with minimal visual experimentation
- Fits well: settings, admin, dense dashboards, repair work, conservative adopt mode
- Becomes inappropriate when: the surface needs stronger storytelling or brand differentiation and the current output feels interchangeable

### Anchor: 5

- Layout implications: moderate asymmetry, clearer section contrast, stronger emphasis opportunities
- Spacing implications: rhythm can widen or tighten by section purpose
- Motion implications: small staged reveals or emphasis shifts become acceptable where they help orientation
- Component implications: still use standard patterns, but visual treatment can be more distinct
- Fits well: product marketing, onboarding, polished product surfaces, mixed-use dashboards
- Becomes inappropriate when: the surface is high-risk operational UI that depends on extreme predictability

### Anchor: 8

- Layout implications: stronger contrast, section alternation, editorial pacing, selective asymmetry
- Spacing implications: larger swings in negative space and emphasis
- Motion implications: expressive transitions become more plausible if the surface allows them
- Component implications: standard primitives remain, but wrappers and presentation can be much more opinionated
- Fits well: launch pages, expressive marketing, narrative editorial surfaces
- Becomes inappropriate when: the work is settings/admin, dense data tooling, or an adopt-mode addition to a mature existing app

## MOTION_INTENSITY

Higher motion intensity means more visible movement, not less discipline.

### Anchor: 1

- Layout implications: static-first UI; little or no entrance motion
- Spacing implications: layout must carry hierarchy without motion help
- Motion implications: instant or near-instant feedback, reduced animation distance
- Component implications: buttons, menus, and toggles still need state feedback, but it stays minimal
- Fits well: settings, dense workflow, enterprise tables, repair work
- Becomes inappropriate when: the page needs gentle orientation cues or the brand genuinely benefits from motion-supported storytelling

### Anchor: 4

- Layout implications: local transitions and lightweight reveals can support hierarchy
- Spacing implications: sections can use subtle reveal or continuity cues without feeling busy
- Motion implications: short entrance motion, panel transitions, and tactile interaction feedback are acceptable
- Component implications: menus, dialogs, popovers, tabs, and toasts can animate clearly without spectacle
- Fits well: polished product, onboarding, moderate marketing, many consumer apps
- Becomes inappropriate when: updates are frequent enough that motion starts to distract

### Anchor: 7

- Layout implications: motion becomes part of the storytelling or mood
- Spacing implications: sequencing and reveal pacing matter more
- Motion implications: layered entrance motion, selective stagger, stronger panel transitions
- Component implications: wrappers may include more expressive transitions, but primitives still need to stay legible
- Fits well: marketing launches, expressive product showcases, selected onboarding moments
- Becomes inappropriate when: the surface is operational, admin-heavy, dense, or likely to be used repeatedly through the day

## VISUAL_DENSITY

Higher density means more information and controls are visible at once.

### Anchor: 3

- Layout implications: fewer simultaneous regions, more breathing room, simpler grouping
- Spacing implications: larger gaps between groups and controls
- Motion implications: motion reads more clearly because the surface is less crowded
- Component implications: cards, larger buttons, bigger headings, and simplified metadata are more acceptable
- Fits well: onboarding, marketing, simple consumer settings, empty or first-use states
- Becomes inappropriate when: users need to compare records, monitor status, or manage many controls efficiently

### Anchor: 6

- Layout implications: balanced grouping with moderate complexity
- Spacing implications: controlled whitespace, efficient but readable toolbars and form sections
- Motion implications: motion should remain moderate because content density is meaningful but not extreme
- Component implications: tables, tabs, cards, and forms can coexist if hierarchy is clear
- Fits well: mainstream SaaS, product settings, dashboards with moderate complexity
- Becomes inappropriate when: an expert workflow needs much tighter information packing

### Anchor: 9

- Layout implications: highly structured, comparison-friendly, often table- or pane-heavy
- Spacing implications: tight but deliberate; little decorative whitespace
- Motion implications: motion must stay low and functional because crowded surfaces amplify distraction
- Component implications: tables, compact rows, segmented controls, compact summaries, local menus
- Fits well: ops consoles, admin tools, data-heavy internal apps
- Becomes inappropriate when: the page is trying to persuade, reassure, or explain something for the first time

## Surface Modifiers

The same dial value does not mean the same thing everywhere.

### Motion example

- `MOTION_INTENSITY=6` on a marketing page can mean section reveal, selective stagger, and richer hero transitions
- `MOTION_INTENSITY=6` on a settings page is usually too high; on that surface it should resolve down to more restrained feedback and panel transitions

### Density example

- `VISUAL_DENSITY=7` on a dashboard can be correct and efficient
- `VISUAL_DENSITY=7` on onboarding likely feels cramped and rushed

### Variance example

- `DESIGN_VARIANCE=7` on a landing page can support emphasis and memorability
- `DESIGN_VARIANCE=7` inside an existing enterprise admin app usually reads like an uninvited redesign

## Cross-Dial Guidance

Some dial combinations are naturally more stable than others.

### High variance + high motion + low density

- good for expressive marketing
- dangerous for product clarity if copy and proof are weak

### Low variance + low motion + high density

- good for operational and admin surfaces
- can become lifeless only if hierarchy is also weak

### Medium variance + medium motion + medium density

- good general-purpose product default
- useful starting point when the user wants "clean and polished" without heavy brand direction

## Anti-Fake-Precision Rule

Do not argue about whether a surface is exactly a 5 or a 6.

Use the number to translate into:

- layout behavior
- spacing behavior
- motion behavior
- component behavior

If the surface intent or existing system clearly suggests a direction, that matters more than numerical purity.


