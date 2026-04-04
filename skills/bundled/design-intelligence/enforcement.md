# Enforcement

This file is the law layer.

Only two rule classes live here:

- `Class A - Hard Fail`: violations that break correctness, accessibility, semantics, performance sanity, or output integrity
- `Class B - Strong Default`: defaults that should be followed unless explicit user intent or existing system constraints justify another choice

Two additional classes exist in the system but do not belong in this file:

- `Class C - Taste Warning`: patterns that often correlate with generic output but are not inherently wrong
- `Class D - Style Choice`: brand-dependent or preference-dependent decisions

If a rule sounds like taste, it belongs in [taste.md](./taste.md), not here.

## Class A - Hard Fail Rules

### A1. Accessible naming is mandatory

Interactive controls must expose an accessible name through visible text, an associated label, `aria-label`, or `aria-labelledby`.

Block when:

- icon-only buttons have no accessible label
- form fields have no label or programmatic name
- links and buttons use meaningless labels such as "click here" when context does not rescue them

Fix:

- add visible labels where possible
- use programmatic labels only when the UI intentionally hides text

### A2. Keyboard support is mandatory

Every interactive path must work without a mouse.

Block when:

- a dialog, dropdown, tabs set, menu, or popover depends on hover-only behavior
- focus cannot reach a control
- escape, enter, space, or arrow-key behavior is missing for established composite widgets
- custom controls trap keyboard users or skip expected interactions

Fix:

- use established primitives for complex widgets
- ensure tab order, dismissal, and activation behavior exist

### A3. Focus visibility is mandatory

Focused elements must have a visible, non-ambiguous focus indicator.

Block when:

- focus styles are removed without accessible replacement
- color contrast or styling makes focus effectively invisible
- focus disappears when components move between states

Fix:

- restore visible outlines, rings, or equivalent indicators
- keep focus styles consistent across states and themes

### A4. Semantic HTML comes first

Use the correct semantic element before adding ARIA.

Block when:

- `div` or `span` is used as a button, link, heading, list, table, or form label without a compelling reason
- ARIA is used to recreate native semantics unnecessarily
- visual structure hides the document outline or relationship between labels and controls

Fix:

- choose native elements first
- use ARIA to supplement, not replace, semantics

### A5. Composite widgets must use correct primitives

Dialogs, menus, tabs, comboboxes, listboxes, popovers, tooltips, switches, and radio groups require proven interaction primitives.

Block when:

- the implementation hand-rolls a complex pattern without matching keyboard and focus behavior
- a menu behaves like a dialog, or a tooltip behaves like a popover with interactive content
- the pattern chosen does not match the intended interaction model

Fix:

- use an established primitive library or platform pattern
- choose the right primitive for the behavior, not the visual appearance

### A6. Dialog, menu, tab, and popover behavior must be correct

Use these minimum contracts:

- `Dialog`: focus moves inside on open, escape closes unless prevented by a strong reason, initial focus is deliberate, background interaction is controlled
- `Dropdown Menu`: opens from a trigger, supports arrow keys, escape closes, focus returns predictably
- `Tabs`: tab list and panels are associated correctly, keyboard navigation works, selected state is programmatic
- `Popover`: content is anchored to a trigger, dismissal is predictable, interactive content remains focusable

Block when the behavior only looks right but is interaction-wrong.

### A7. Dangerous actions need explicit confirmation patterns

Destructive or high-impact actions need an appropriate confirmation strategy.

Block when:

- delete, revoke, remove access, reset, or irreversible operations are a single accidental click
- destructive actions are visually grouped with primary safe actions in a way that encourages mistakes
- the confirmation pattern is weaker than the action risk

Fix:

- use confirm dialog, typed confirmation, secondary step, or undo model based on severity

### A8. Viewport safety beats `h-screen` convenience

Do not assume `100vh` is safe on mobile or inside complex shells.

Block when:

- the layout clips content behind mobile browser chrome
- sticky regions or fixed panels become unreachable
- a full-height surface ignores safe area insets or parent shell constraints

Fix:

- prefer `min-h-[100dvh]`, container-aware sizing, or explicit shell calculations
- test tall forms, dialogs, and drawers on small viewports

### A9. Motion must not create hazards

Motion cannot harm usability or accessibility.

Block when:

- essential information is only conveyed through motion
- flashing, excessive parallax, or auto-playing effects create distraction or discomfort
- reduced motion is ignored for meaningful transitions
- entering or leaving states cause users to lose orientation or control

Fix:

- support reduced-motion alternatives
- reduce transform distance, duration, or automatic movement

### A10. Avoid layout-thrashing animation and unstable measurement loops

Animation or resize logic cannot continuously force layout recalculation without reason.

Block when:

- transitions animate layout-heavy properties on large surfaces without necessity
- measuring and setting layout in a loop causes jank
- scroll-linked or resize-linked effects update too often without throttling or simplification

Fix:

- prefer `transform` and `opacity`
- limit live measurement
- move heavy effects off hot interaction paths

### A11. Required states must exist

Final UI output must cover the states implied by the component or surface.

Block when:

- loading, empty, error, disabled, success, validation, or no-permission states are omitted where they are required
- async surfaces show only a happy path
- forms lack error and recovery states

Fix:

- add the minimum required state set before polishing visuals

### A12. Form errors must be placed where users can act on them

Validation and submission errors must be visible and connected to the relevant input or form section.

Block when:

- errors are shown only in a toast
- the user must hunt for which field failed
- fields are marked invalid without an explanation

Fix:

- place field errors near the field
- add a form-level summary when multiple issues exist
- link messaging to invalid fields programmatically where appropriate

### A13. Dependencies and primitives must be real

Do not invent library APIs, icon names, components, or framework features.

Block when:

- code references non-existent primitives or props
- implementation assumes a package that is not present and not requested
- the answer names icons or assets as if verified when they were not

Fix:

- inspect the codebase or dependency list first
- if unverified, state the assumption and choose a safer fallback

### A14. No fake completeness

Final output cannot pretend to be finished while omitting required pieces.

Block when:

- code says "for brevity" in final deliverables
- important sections are replaced with TODOs or comments that imply implementation exists
- the answer claims support for components or states that were not actually handled
- placeholders are presented as production-ready without disclosure

Fix:

- either provide the missing pieces
- or state exactly what remains incomplete and why

### A15. No silent placeholder omissions

Do not omit required content, assets, or text and act as if the output is ready.

Block when:

- the surface needs copy, labels, legends, alt text, empty-state messaging, or loading copy and these are silently missing
- image or media slots appear without fallback behavior

Fix:

- supply realistic placeholder content
- or explicitly mark what the user still needs to provide

## Class B - Strong Defaults

These are the defaults to follow unless explicit instruction or local system constraints justify a different choice.

### B1. Prefer existing components first

In `Adopt` and `Repair`, inspect the existing component library before creating a new one.

### B2. Prefer established primitives for complex widgets

For dialogs, menus, popovers, tabs, comboboxes, radios, switches, and toasts, prefer trusted primitives over custom accessibility work.

### B3. Prefer grid over flex math for real multi-column layouts

Use grid when the layout is truly two-dimensional, alignment-sensitive, or multi-column across breakpoints.

### B4. Prefer transform and opacity for motion

Use animation-friendly properties unless the motion goal genuinely requires layout change.

### B5. Prefer one primitive family per surface

Avoid mixing several incompatible component primitives inside the same surface without reason.

### B6. Prefer one icon family per surface

Use a single icon family unless the existing system already mixes them deliberately.

### B7. Prefer minimal diffs in Adopt and Repair

Change only what the task requires. Do not turn a fix into a redesign.

### B8. Prefer semantic structure over `div` soup

Choose sections, headings, lists, forms, tables, and buttons deliberately.

### B9. Prefer stable image and media handling

Use known image components, explicit dimensions, predictable loading strategies, and verified asset paths.

### B10. Prefer realistic placeholder content

Use plausible labels, names, dates, counts, and empty-state copy. Avoid "Acme," "Lorem ipsum," or obviously fake enterprise filler unless the user asked for generic placeholders.

## Adopt-Mode Protections

In `Adopt`, these rules apply unless the user explicitly asks otherwise:

- do not re-theme the app
- do not swap fonts
- do not switch icon families
- do not migrate frameworks
- do not replace existing components without a concrete reason
- do not introduce new libraries casually
- do not widen the task scope
- do not "clean up" unrelated code because it looks adjacent

Escalate only if the current system itself causes a Class A failure or prevents the requested feature from working.

## Output Completion Protocol

Before calling the output done, cross-check the deliverable against the request.

Minimum check:

1. list the requested deliverables
2. verify each one exists in the output
3. verify required states exist for each interactive surface
4. verify no "for brevity," "stub," or hidden TODO language remains
5. verify claims of completeness match the actual files or code provided

If continuation is genuinely required, say:

- what is complete
- what remains
- what blocks completion

Do not collapse those into a vague "rest omitted."

## Validation Behavior

### For Class A

- block shipping
- block final claims of completion
- fix immediately or surface the block explicitly

### For Class B

- warn and explain the tradeoff
- allow override when the user explicitly wants another direction or the existing system already differs

### Override Behavior

If the user explicitly asks for something unusual that does not violate Class A:

- follow the request
- note the tradeoff once
- continue

## Examples

### Hard fail caught

Issue:

- an icon-only close button in a dialog has no label

Why it is Class A:

- screen-reader users cannot identify the control

Smallest fix:

- add `aria-label="Close dialog"` and keep the visible icon

### Strong default warning

Issue:

- a new settings page introduces a different icon family than the rest of the app

Why it is Class B:

- the page may still function correctly, but coherence and maintenance suffer

Smallest fix:

- switch to the app's existing icon family unless the user is intentionally rebranding the whole surface

### Override acknowledged

Issue:

- the user explicitly wants a large animated marketing hero

Response:

- comply
- note that reduced-motion support and readable fallback states still need to be preserved


