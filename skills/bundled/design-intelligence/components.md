# Components

This file is the component intelligence layer.

It does not try to fake completeness with a giant shallow catalog. It fully documents the highest-value components first and gives decision rules for choosing existing components, primitives, or custom work.

## Component Selection Decision Guide

Choose in this order:

1. existing app component that already matches the need
2. existing primitive wrapper in the repo
3. trusted primitive library component
4. custom component only when the pattern is simple or the existing options cannot satisfy the requirement

Use custom implementation cautiously for:

- buttons
- cards
- alerts
- empty states
- simple inputs

Avoid custom reimplementation unless absolutely necessary for:

- dialog
- dropdown menu
- popover
- tooltip
- tabs
- radio group
- switch
- complex select or combobox behavior

## User Language To Component Mapping

Map vague requests to likely components before coding:

| User language | Likely component |
| --- | --- |
| primary action, CTA, save, submit | Button |
| icon trigger, close, favorite, kebab | Icon Button |
| text field, email, search box | Input |
| notes, description, message body | Textarea |
| choose one from list, pick an option | Select |
| opt in, remember me, multi-select boolean | Checkbox |
| choose one mode, one plan, one answer | Radio Group |
| enable or disable setting | Switch |
| modal, confirm, sheet-like blocking layer | Dialog |
| menu, kebab actions, row actions | Dropdown Menu |
| anchored panel, filter popout, date picker shell | Popover |
| hover hint, label help | Tooltip |
| section switcher, sibling views | Tabs |
| records grid, admin list, comparison rows | Table |
| grouped summary block, preview box | Card |
| warning message, inline status notice | Alert |
| temporary feedback message | Toast |
| app nav rail, workspace navigation | Sidebar Navigation |
| path trail, parent hierarchy | Breadcrumb |
| nothing here yet, no results, no access | Empty State |

## Existing Component vs Primitive vs Custom Rules

### Use existing component

Use when:

- the repo already has a matching abstraction
- the component already fits the existing surface grammar
- changing it locally is cheaper than introducing a second version

Avoid replacing it unless:

- it causes a Class A failure
- it blocks the required behavior
- the user explicitly asked for a redesign

### Use primitive directly

Use when:

- the repo exposes primitives but not the exact wrapper
- the interaction model is complex and the primitive already solves accessibility and focus
- you need a new visual treatment without new behavior semantics

### Build custom

Use when:

- the pattern is visually simple and behaviorally trivial
- the repo has no suitable abstraction and the primitive would be more overhead than value
- you can still satisfy the accessibility contract with native semantics

## Component Catalog

### 1. Button

- Name: Button
- Aliases: action button, CTA, submit button, primary button
- Purpose: trigger a clear action with visible affordance and explicit hierarchy
- Use when: the user must initiate an action, submit a form, confirm a choice, or open a related flow
- Do not use when: navigation should be a link, the control is toggle-like, or the action is icon-only
- Inputs / props conceptually: label, variant, size, disabled state, loading state, icon placement, destructive intent, submit behavior
- Outputs / events conceptually: click, submit, pointer activation, keyboard activation
- Required states: default, hover, focus-visible, active, disabled
- Optional states: loading, success, destructive, subtle, full-width
- Accessibility contract: visible label or accessible name; disabled state must be programmatic; loading state should not remove context
- Keyboard behavior: reachable by tab; activates with Enter and Space when rendered as a button
- Focus behavior: focus ring remains visible across variants and disabled-to-enabled transitions
- Semantic element expectations: use `button`; use `a` only for actual navigation
- Primitive preference order: existing Button wrapper -> native `button` with local styles -> custom only for trivial cases
- Responsive behavior: full-width is acceptable in narrow flows; avoid accidental wrap that breaks label readability
- Mobile behavior: generous tap target, avoid tiny text-only buttons in sticky footers
- Common failure modes: multiple competing primary buttons, hidden loading label, anchor styled as button for mutation
- Typical anti-patterns: ghost button as primary CTA, icon crowding, over-rounding without hierarchy change
- Example implementation notes: use `type=\"submit\"` inside forms when that is the actual intent
- Interaction with layout: primary button placement defines completion rhythm and local hierarchy
- Interaction with audit: missing accessible name, bad disabled contrast, and ambiguous hierarchy are common findings

### 2. Icon Button

- Name: Icon Button
- Aliases: close button, kebab button, toolbar icon, action icon
- Purpose: provide a compact trigger where the action is frequent, local, and recognizable
- Use when: the surface is dense, the action is secondary, or the pattern is already well known
- Do not use when: the action is primary, ambiguous, destructive without text, or the icon meaning is not obvious
- Inputs / props conceptually: icon, accessible label, size, variant, pressed state, disabled state
- Outputs / events conceptually: click, toggle, menu open
- Required states: default, hover, focus-visible, active, disabled
- Optional states: selected, loading, destructive
- Accessibility contract: always expose an accessible name; decorative icon alone is not enough
- Keyboard behavior: same as Button; if toggle-like, expose `aria-pressed` when appropriate
- Focus behavior: ring should surround the actual hit target, not just the glyph
- Semantic element expectations: use `button`
- Primitive preference order: existing IconButton wrapper -> Button with icon-only treatment -> native `button`
- Responsive behavior: maintain minimum hit area even if the icon glyph stays small
- Mobile behavior: increase hit slop; avoid clustering many icon buttons without spacing
- Common failure modes: missing label, too many unexplained icons, destructive icon without confirmation
- Typical anti-patterns: using only color to signal state, tiny 24px touch targets, unlabeled toolbar clusters
- Example implementation notes: pair with tooltip only as enhancement, not as the only label
- Interaction with layout: best in toolbars, row actions, and local chrome; weak as a primary completion action
- Interaction with audit: unlabeled controls are an automatic Class A finding

### 3. Input

- Name: Input
- Aliases: text field, search field, email field, single-line field
- Purpose: collect short textual or formatted input
- Use when: the user enters a single line of text, number, code, email, or search query
- Do not use when: content is long-form, one-of-many choice is better, or a mask hides essential clarity
- Inputs / props conceptually: label, value, placeholder, type, description, error, prefix or suffix, disabled, required
- Outputs / events conceptually: change, blur, focus, submit, validation
- Required states: default, focus, disabled, invalid
- Optional states: loading, read-only, success, with clear button
- Accessibility contract: associated label, programmatic invalid state, error and description linkage
- Keyboard behavior: standard text input behavior; Enter should match form intent
- Focus behavior: focus ring plus caret visibility; error state should not remove ring
- Semantic element expectations: use `input` with correct type
- Primitive preference order: existing Field/Input wrapper -> native `input` with field shell -> custom wrapper only
- Responsive behavior: avoid fixed widths that break long labels or helper text
- Mobile behavior: choose proper input mode and autocomplete hints when available
- Common failure modes: placeholder used as label, unclear required state, masked input that blocks correction
- Typical anti-patterns: floating labels that collide with autofill, excess inline validation noise
- Example implementation notes: reserve placeholder for example content, not identification
- Interaction with layout: field grouping, label alignment, and error placement strongly affect completion speed
- Interaction with audit: missing labels, broken error placement, and poor mobile input types are common findings

### 4. Textarea

- Name: Textarea
- Aliases: long text field, notes field, description box
- Purpose: collect multi-line user input
- Use when: the user writes explanations, notes, comments, prompts, or descriptions
- Do not use when: structured data needs fields, rich text is required, or expected length is tiny
- Inputs / props conceptually: label, value, placeholder, rows, resize behavior, max length, description, error
- Outputs / events conceptually: change, blur, focus, submit
- Required states: default, focus, disabled, invalid
- Optional states: character count, auto-resize, read-only
- Accessibility contract: same as Input, plus any character counter must be understandable
- Keyboard behavior: Enter inserts line breaks; form submission must not hijack expected multi-line input without a clear shortcut
- Focus behavior: clear ring around the full field boundary
- Semantic element expectations: use `textarea`
- Primitive preference order: existing Textarea wrapper -> native `textarea`
- Responsive behavior: width should follow the form column; avoid over-expansion that harms readability
- Mobile behavior: keep enough visible rows to prevent cramped editing
- Common failure modes: tiny height, placeholder as instructions, no max-length feedback when limits matter
- Typical anti-patterns: auto-grow that causes layout jumps without limits
- Example implementation notes: for prompt editors or support forms, combine brief helper text with optional counter
- Interaction with layout: usually benefits from full-row placement
- Interaction with audit: check resize behavior, error copy, and keyboard assumptions

### 5. Select

- Name: Select
- Aliases: dropdown field, picker, option selector
- Purpose: choose one option from a bounded list
- Use when: the option set is known, moderate in size, and does not require long comparison
- Do not use when: search is essential, options need rich descriptions, or the set is very small and radios are clearer
- Inputs / props conceptually: label, options, value, placeholder, description, error, disabled, grouped options
- Outputs / events conceptually: open, select, change, blur
- Required states: default, open, selected, disabled, invalid
- Optional states: loading options, grouped categories, clearable state
- Accessibility contract: label, announced selected state, keyboard navigation, correct listbox semantics
- Keyboard behavior: open, arrow navigation, selection, escape dismissal, tab exit
- Focus behavior: focus remains predictable between trigger and option list
- Semantic element expectations: native `select` is acceptable for simple cases; custom listbox/select needs a proper primitive
- Primitive preference order: existing Select wrapper -> trusted select primitive -> native `select`
- Responsive behavior: keep trigger width stable; long labels may truncate but selected value must remain understandable
- Mobile behavior: native picker can be preferable for reliability
- Common failure modes: custom select without keyboard support, using select for five complex plan cards, hidden error messaging
- Typical anti-patterns: overly decorative triggers, no placeholder semantics, too many hidden options
- Example implementation notes: prefer radios when users benefit from seeing all options at once
- Interaction with layout: form column width and helper text spacing matter more than ornament
- Interaction with audit: wrong primitive choice and inaccessible custom menu are common findings

### 6. Checkbox

- Name: Checkbox
- Aliases: tick box, multi-select boolean, consent box
- Purpose: let the user opt into a boolean or select multiple independent options
- Use when: choices are independent and non-exclusive
- Do not use when: only one option may be chosen or the action is immediate enable/disable behavior better served by Switch
- Inputs / props conceptually: label, checked state, description, disabled, indeterminate
- Outputs / events conceptually: toggle, change
- Required states: unchecked, checked, focus-visible, disabled
- Optional states: indeterminate, invalid
- Accessibility contract: associated label, announced checked state, large click target
- Keyboard behavior: Space toggles
- Focus behavior: visible ring around the checkbox or label group
- Semantic element expectations: use native checkbox input or a primitive that preserves it
- Primitive preference order: existing Checkbox wrapper -> native checkbox with styled proxy -> primitive
- Responsive behavior: keep label wrapping readable
- Mobile behavior: make the whole row tappable when possible
- Common failure modes: tiny hit target, label not clickable, using checkbox as immediate settings toggle with no context
- Typical anti-patterns: list of checkboxes without grouping label, using checkboxes for mutually exclusive plans
- Example implementation notes: use fieldset and legend when multiple related checkboxes form one question
- Interaction with layout: checkbox rows need enough vertical rhythm to keep scan order intact
- Interaction with audit: unlabeled groups and broken hit areas are common findings

### 7. Radio Group

- Name: Radio Group
- Aliases: single choice group, option set, plan selector
- Purpose: choose one option from a small visible set
- Use when: the user benefits from seeing all options and only one may be selected
- Do not use when: the list is long, searchable, or highly descriptive in a way that needs a larger card chooser pattern
- Inputs / props conceptually: group label, options, selected value, descriptions, disabled states
- Outputs / events conceptually: change, selection
- Required states: selected, unselected, focus-visible, disabled
- Optional states: invalid, card-style radio
- Accessibility contract: group label, one selectable value, arrow-key behavior, announced selected state
- Keyboard behavior: Tab enters group, arrow keys move selection, Space confirms current option in many primitives
- Focus behavior: focus should remain understandable whether it lands on the selected control or active option
- Semantic element expectations: native radio inputs within a fieldset or trusted primitive
- Primitive preference order: existing RadioGroup wrapper -> primitive -> native radios
- Responsive behavior: stack vertically unless horizontal options remain legible
- Mobile behavior: large rows or cards outperform tiny inline radios
- Common failure modes: custom card radios without keyboard support, no group label, select used when visibility would help more
- Typical anti-patterns: equal card weight for options with clearly unequal importance
- Example implementation notes: plan or mode selection often works well with radio-card hybrids
- Interaction with layout: benefits from clear section framing and nearby confirmation or follow-up controls
- Interaction with audit: missing fieldset or keyboard support is high severity

### 8. Switch

- Name: Switch
- Aliases: toggle, enable setting, on-off control
- Purpose: toggle an immediate binary setting
- Use when: the label can read naturally as on or off and the effect is conceptually immediate
- Do not use when: the choice needs confirmation, submit gating, or multi-option context
- Inputs / props conceptually: label, checked state, description, disabled, loading
- Outputs / events conceptually: toggle, change
- Required states: on, off, focus-visible, disabled
- Optional states: loading, pending confirmation
- Accessibility contract: role and state must be exposed correctly; label explains what changes, not just the state word
- Keyboard behavior: Space toggles; Enter may also toggle depending on primitive
- Focus behavior: focus ring around the whole switch control or row
- Semantic element expectations: native checkbox with switch semantics or trusted switch primitive
- Primitive preference order: existing Switch wrapper -> trusted primitive -> checkbox-based implementation
- Responsive behavior: use full-row patterns in settings when descriptions matter
- Mobile behavior: generous horizontal tap target; avoid tiny isolated toggles
- Common failure modes: ambiguous labels such as "Enabled," delayed save with no feedback, using switch for one-time submit options
- Typical anti-patterns: placing many switches without explanatory grouping
- Example implementation notes: if a save step exists, consider Checkbox instead
- Interaction with layout: commonly appears in settings rows with local description
- Interaction with audit: ambiguous semantics and inaccessible custom toggles are common findings

### 9. Dialog

- Name: Dialog
- Aliases: modal, confirmation modal, blocking overlay, sheet when modal in behavior
- Purpose: interrupt the current flow for a contained task, confirmation, or focused subflow
- Use when: the user must address a bounded task without losing the current page context
- Do not use when: the task is long, navigational, or better served by a route or non-blocking panel
- Inputs / props conceptually: open state, title, description, content, action slots, size, dismissal rules
- Outputs / events conceptually: open, close, confirm, cancel, submit
- Required states: closed, open, focus-contained, dismissible or intentionally non-dismissible
- Optional states: loading, destructive confirm, stacked steps, side sheet variant
- Accessibility contract: title, optional description, focus management, background interaction rules, escape behavior, return focus to trigger
- Keyboard behavior: Tab cycle, Shift+Tab reverse, Escape close when allowed, Enter follows local form intent
- Focus behavior: initial focus is intentional; return focus after close
- Semantic element expectations: use a real dialog primitive; do not fake with absolute-positioned divs
- Primitive preference order: existing Dialog wrapper -> trusted dialog primitive
- Responsive behavior: width, height, and scroll areas must remain usable; avoid over-tall dialogs
- Mobile behavior: full-screen sheet or bottom sheet may be better than a centered modal
- Common failure modes: missing title, trapped background scroll, unreachable footer actions, close button without label
- Typical anti-patterns: stuffing full settings pages into dialogs, nested modals
- Example implementation notes: destructive confirm dialog should make the risky action unmistakable
- Interaction with layout: dialog content needs its own local hierarchy; footer actions should not float without context
- Interaction with audit: dialog correctness is one of the highest-risk audit areas

### 10. Dropdown Menu

- Name: Dropdown Menu
- Aliases: action menu, kebab menu, context menu, row action menu
- Purpose: expose a short list of local actions without occupying permanent space
- Use when: actions are secondary, local to an object, and small in number
- Do not use when: the options are navigational tabs, filter controls with complex content, or the actions are primary
- Inputs / props conceptually: trigger, menu items, separators, item icons, disabled items, shortcuts
- Outputs / events conceptually: open, close, item select
- Required states: closed, open, highlighted item, disabled item
- Optional states: submenu, destructive item
- Accessibility contract: menu semantics, arrow navigation, focus return, item labels, correct role selection
- Keyboard behavior: Enter or Space on trigger, arrow key navigation, Escape close, typeahead if supported
- Focus behavior: focus moves into menu and returns to trigger predictably
- Semantic element expectations: use a menu primitive, not a popover full of random buttons when a menu is intended
- Primitive preference order: existing DropdownMenu wrapper -> trusted primitive
- Responsive behavior: menu position must avoid viewport clipping
- Mobile behavior: action sheet or full-screen list can beat a tiny anchored menu
- Common failure modes: putting form controls inside menus, no keyboard support, invisible destructive item styling
- Typical anti-patterns: hiding primary actions in a menu to reduce visual noise
- Example implementation notes: row actions often pair well with a final destructive item separated from safe actions
- Interaction with layout: best as a local action cluster relief valve, not the center of a workflow
- Interaction with audit: wrong primitive choice and missing keyboard behavior are common findings

### 11. Popover

- Name: Popover
- Aliases: anchored panel, flyout, filter panel, helper panel
- Purpose: show non-blocking contextual content anchored to a trigger
- Use when: content is contextual, related to a nearby trigger, and should not block the page
- Do not use when: the content is only a hint, which is a Tooltip, or when the content is blocking, which is a Dialog
- Inputs / props conceptually: trigger, open state, content, alignment, offset, dismiss behavior
- Outputs / events conceptually: open, close, apply, cancel
- Required states: closed, open, anchored, dismissible
- Optional states: interactive form content, inline filters, date picker shell
- Accessibility contract: focus and dismissal must be clear; if interactive, content must be reachable and dismissible
- Keyboard behavior: trigger activation, escape dismissal, tab through interactive content when present
- Focus behavior: if interactive, focus should move into content; if non-interactive, avoid confusing focus traps
- Semantic element expectations: anchored panel primitive; not a tooltip with buttons
- Primitive preference order: existing Popover wrapper -> trusted primitive
- Responsive behavior: flip and collision logic matter; small screens may need sheet fallback
- Mobile behavior: many popovers should become drawers or sheets
- Common failure modes: interactive content in tooltip primitive, clipping offscreen, dismissal on accidental pointer leave
- Typical anti-patterns: oversized popover used as pseudo-page
- Example implementation notes: filter panels are a classic popover use case if the filter set is short
- Interaction with layout: popover reduces permanent clutter but should not hide core task logic
- Interaction with audit: wrong primitive and mobile fallback issues are common

### 12. Tooltip

- Name: Tooltip
- Aliases: hint, hover label, helper tooltip
- Purpose: provide short supplementary explanation for a control or datum
- Use when: the control is already labeled and a short extra hint helps
- Do not use when: the tooltip is the only label, contains interactive content, or holds critical information
- Inputs / props conceptually: trigger, content, placement, delay
- Outputs / events conceptually: show, hide
- Required states: hidden, visible
- Optional states: delayed open, touch fallback suppression
- Accessibility contract: tooltip cannot replace labeling; keyboard and screen-reader behavior must still leave the control understandable
- Keyboard behavior: often shows on focus as well as hover
- Focus behavior: tooltip should not steal focus
- Semantic element expectations: use a tooltip primitive, not a popover disguised as one
- Primitive preference order: existing Tooltip wrapper -> trusted tooltip primitive
- Responsive behavior: avoid dependence on hover on touch devices
- Mobile behavior: usually omit or convert to inline help
- Common failure modes: critical instructions only in tooltip, hover-only information, long paragraph content
- Typical anti-patterns: tooltips everywhere to patch weak labels
- Example implementation notes: use for icon buttons, abbreviations, or dense metric labels
- Interaction with layout: tooltip is supplemental; if it becomes essential, the layout needs improvement
- Interaction with audit: unlabeled icon plus tooltip still fails accessibility

### 13. Tabs

- Name: Tabs
- Aliases: tabbed navigation, section switcher, view switcher
- Purpose: switch among sibling views while staying within one parent context
- Use when: content is peer-level and users benefit from quick local switching
- Do not use when: the sections are linear steps, separate routes with different page meaning, or there are too many items to fit sanely
- Inputs / props conceptually: tab list, selected value, panels, orientation, disabled tabs
- Outputs / events conceptually: change, focus change
- Required states: selected, unselected, focus-visible, associated panel visibility
- Optional states: vertical tabs, badge counts, lazy-loaded panels
- Accessibility contract: proper tablist, tab, and tabpanel relationships; arrow-key navigation
- Keyboard behavior: arrow keys move between tabs; Enter or Space may activate depending on manual vs automatic activation mode
- Focus behavior: focus indication on tabs plus clear panel change
- Semantic element expectations: use a tabs primitive or standards-compliant implementation
- Primitive preference order: existing Tabs wrapper -> trusted tabs primitive
- Responsive behavior: overflow strategy matters; scrollable tabs or alternative navigation may be required
- Mobile behavior: too many tabs should collapse to segmented control, select, or route-level navigation
- Common failure modes: tabs used for route-level nav, overflowing labels, panels with weak heading context
- Typical anti-patterns: hiding essential status behind a tab row users miss
- Example implementation notes: keep tab count modest and labels concrete
- Interaction with layout: tabs are local navigation, not page structure replacement
- Interaction with audit: missing relationships and broken keyboard behavior are common

### 14. Table

- Name: Table
- Aliases: data grid, records table, admin table
- Purpose: support comparison across rows and columns
- Use when: users need to scan repeated structured data and compare attributes
- Do not use when: each row needs a unique rich layout or when mobile-only card stacks are truly the primary experience
- Inputs / props conceptually: columns, rows, sort state, selection state, row actions, empty state, loading, pagination
- Outputs / events conceptually: sort, select row, open detail, filter, paginate
- Required states: loading, populated, empty, error when remote, no-results after filtering
- Optional states: selectable rows, expandable rows, pinned columns, sticky header
- Accessibility contract: semantic table where possible; headers associated with cells; row and action labels remain understandable
- Keyboard behavior: focusable controls inside rows must remain reachable in order
- Focus behavior: row hover styling must not hide focused interactive elements
- Semantic element expectations: use native table markup unless a true grid interaction model is required
- Primitive preference order: existing Table/DataTable wrapper -> semantic table -> advanced grid only when needed
- Responsive behavior: column prioritization, overflow, and detail fallback must be explicit
- Mobile behavior: hide low-priority columns, use row expansion, or route to detail view
- Common failure modes: turning comparison data into cards, unsafely squeezing columns, row actions hidden on hover only
- Typical anti-patterns: every cell as a custom card, summary metrics above table duplicated as first row
- Example implementation notes: lead with identifying columns, not decorative ones
- Interaction with layout: table-centered surfaces need toolbar, summary, and overflow planning
- Interaction with audit: responsiveness and state completeness are the most common table issues

### 15. Card

- Name: Card
- Aliases: panel, summary card, preview card
- Purpose: group related information into a bounded region
- Use when: a set of content belongs together and benefits from local separation
- Do not use when: the surface needs direct comparison that tables or list rows would handle better, or when cards become default filler containers
- Inputs / props conceptually: heading, body, media, actions, status accent, padding level
- Outputs / events conceptually: optional click-through, local actions
- Required states: default
- Optional states: interactive, selected, loading, disabled, warning
- Accessibility contract: if clickable, semantics must match the action; nested controls need clear focus order
- Keyboard behavior: clickable cards should behave like a single clear action, not a mystery zone
- Focus behavior: interactive card focus must remain visible without lighting up unrelated internal controls
- Semantic element expectations: `article`, `section`, `li`, or `div` depending on context; avoid button-card hybrids unless truly single-action
- Primitive preference order: existing Card wrapper -> semantic container with local styles
- Responsive behavior: card count and width must adapt; avoid equal-height forcing that harms content
- Mobile behavior: stacked cards are fine when each card is meaningfully self-contained
- Common failure modes: card spam, too many nested borders and shadows, entire dashboard reduced to cards without hierarchy
- Typical anti-patterns: making every panel look identical even when their importance differs
- Example implementation notes: card chrome should support grouping, not become the main event
- Interaction with layout: cards are grouping tools, not layout strategy by themselves
- Interaction with audit: overuse may surface as visual coherence or distinctiveness issues rather than correctness failures

### 16. Alert

- Name: Alert
- Aliases: inline notice, warning banner, status message
- Purpose: show important inline status, warning, error, or success information that should persist long enough to act on
- Use when: the message matters to the current task and should remain visible in context
- Do not use when: the message is fleeting feedback, which is a Toast, or when the content belongs as normal body copy
- Inputs / props conceptually: severity, title, body, icon, action, dismissibility
- Outputs / events conceptually: dismiss, follow action
- Required states: visible
- Optional states: dismissible, inline action, compact variant
- Accessibility contract: severity conveyed by more than color; important errors should be announced appropriately
- Keyboard behavior: dismiss button or action control must be reachable
- Focus behavior: do not steal focus unless the situation truly requires immediate attention
- Semantic element expectations: use alert or status semantics when appropriate
- Primitive preference order: existing Alert wrapper -> semantic status region
- Responsive behavior: allow wrap without collapsing into unreadable rows
- Mobile behavior: keep alerts concise; stack actions below body if needed
- Common failure modes: using alerts for ordinary helper text, relying on color alone, placing critical field errors only in a page-top banner
- Typical anti-patterns: every section starts with an alert
- Example implementation notes: warning and error alerts should explain consequence and next step
- Interaction with layout: alert placement changes perceived severity; local placement beats page-top dumping for contextual issues
- Interaction with audit: severity mismatch and vague remediation copy are common findings

### 17. Toast

- Name: Toast
- Aliases: snack bar, ephemeral notification
- Purpose: show temporary feedback for an action that already completed or failed without blocking the current flow
- Use when: the message is transient and the page still makes sense without reading it
- Do not use when: the message contains critical form errors, permissions failures, or information users must revisit
- Inputs / props conceptually: title, body, severity, action, duration, dismissibility
- Outputs / events conceptually: dismiss, undo, follow action
- Required states: visible, dismissed
- Optional states: stacked, paused on hover, action-present
- Accessibility contract: announce at the right urgency; avoid overwhelming screen readers with frequent nonessential updates
- Keyboard behavior: dismiss and action controls must be reachable if focused
- Focus behavior: normally do not steal focus
- Semantic element expectations: live region plus visible notification shell
- Primitive preference order: existing Toast system -> trusted toast primitive
- Responsive behavior: avoid covering critical controls; placement should respect viewport edges
- Mobile behavior: bottom placement may conflict with nav or keyboard; test carefully
- Common failure modes: toasts used as the only error reporting, too many concurrent toasts, disappearing before the user can act
- Typical anti-patterns: success toast after every trivial autosave
- Example implementation notes: "Undo" is often a better toast action than "OK"
- Interaction with layout: toast should not become required page content
- Interaction with audit: using toast for field validation is a common Class A or P1 issue depending on context

### 18. Sidebar Navigation

- Name: Sidebar Navigation
- Aliases: side nav, nav rail, workspace sidebar
- Purpose: provide persistent navigation for deep apps, admin tools, and workspaces
- Use when: the destination set is stable and users need frequent cross-section movement
- Do not use when: the app is shallow, mobile-first with few sections, or the content is purely marketing
- Inputs / props conceptually: sections, items, icons, active state, collapsed state, badges, footer actions
- Outputs / events conceptually: navigation, expand, collapse
- Required states: active item, hover, focus-visible, collapsed or expanded if collapsible
- Optional states: grouped sections, tenant switcher, pinned recent items
- Accessibility contract: landmarks, current-page indication, keyboard reachability, collapsed labels still announced
- Keyboard behavior: standard link/button navigation; collapsed icon-only items still need names
- Focus behavior: active and focused states must be distinguishable
- Semantic element expectations: `nav` landmark with lists of destinations
- Primitive preference order: existing app shell nav -> semantic nav with local styles
- Responsive behavior: collapsible on desktop, drawer or alternate nav on mobile
- Mobile behavior: drawer or bottom nav is often better than a permanently visible sidebar
- Common failure modes: too many equal-level destinations, hidden labels in collapsed mode, destructive or account actions mixed into primary nav without separation
- Typical anti-patterns: icon-only nav with no tooltips or labels, giant sidebar for a three-page app
- Example implementation notes: group destinations by mental model, not by implementation team
- Interaction with layout: sidebar defines page rhythm and content width budget
- Interaction with audit: current-state clarity and responsive collapse are common findings

### 19. Breadcrumb

- Name: Breadcrumb
- Aliases: path trail, location trail
- Purpose: show hierarchy and give quick upward navigation
- Use when: the information structure is nested and users may need to move up a level
- Do not use when: the hierarchy is flat, route names are already obvious, or mobile space is too constrained for meaningful breadcrumb text
- Inputs / props conceptually: path items, current item, separators, truncation
- Outputs / events conceptually: navigate to ancestor
- Required states: current page item
- Optional states: collapsed middle items, icon root
- Accessibility contract: `nav` with breadcrumb label, current page identified programmatically
- Keyboard behavior: linked ancestors reachable in tab order
- Focus behavior: focus styles on links remain visible even in compressed layouts
- Semantic element expectations: ordered list or standard breadcrumb pattern
- Primitive preference order: existing Breadcrumb wrapper -> semantic nav + list
- Responsive behavior: truncate or collapse middle items instead of wrapping into chaos
- Mobile behavior: often shorten aggressively or replace with back link if hierarchy is shallow
- Common failure modes: using breadcrumb as primary navigation, repeating current page title without utility, path names too cryptic
- Typical anti-patterns: breadcrumb plus giant duplicated section label stack
- Example implementation notes: breadcrumbs complement side nav; they do not replace it
- Interaction with layout: belongs near the top of detail or nested management views, but below global chrome
- Interaction with audit: often becomes a P2 clarity or responsiveness issue rather than a blocker

### 20. Empty State

- Name: Empty State
- Aliases: no-results state, zero state, blank state
- Purpose: explain why nothing is shown and what the user can do next
- Use when: data is absent, filters remove all results, onboarding has not started, or access is limited
- Do not use when: the page is loading, errored, or should show actual skeleton or error treatment instead
- Inputs / props conceptually: title, explanation, primary action, secondary action, illustration or icon, context type
- Outputs / events conceptually: create, clear filters, retry, learn more
- Required states: visible empty explanation
- Optional states: no-results vs first-use variants, illustrative asset, compact table-empty variant
- Accessibility contract: message and action remain readable and reachable; decorative visuals are nonessential
- Keyboard behavior: action controls reachable in normal order
- Focus behavior: if the empty state replaces main content after an action, ensure focus does not get lost
- Semantic element expectations: normal section content with heading and actions
- Primitive preference order: existing EmptyState component -> simple semantic container
- Responsive behavior: center or inline based on surface; avoid giant blank voids in dense admin surfaces
- Mobile behavior: compact copy and obvious action matter more than illustration
- Common failure modes: "Nothing here" with no next step, same empty state for first-use and filtered results, oversized illustration dominating an admin table
- Typical anti-patterns: whimsical zero state inside serious operational failure context
- Example implementation notes: distinguish "no data yet," "no results," and "no permission"
- Interaction with layout: empty states should inherit the surrounding surface rhythm instead of looking like a separate app
- Interaction with audit: state completeness and clarity are the main review angles


