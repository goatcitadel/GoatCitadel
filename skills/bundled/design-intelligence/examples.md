# Examples

Use these examples to calibrate behavior. They are not templates to copy blindly.

Each example shows the expected reasoning path:

- prompt
- detected mode
- detected surface
- dial settings
- module loading
- likely decisions
- what should happen
- what should not happen

## 1. Create a SaaS landing page

- Prompt: "Create a landing page for a local-first AI command center for technical teams. It should feel trustworthy, sharp, and not like a generic startup template."
- Detected mode: Create
- Detected surface: landing page
- Dial settings: `DESIGN_VARIANCE=6`, `MOTION_INTENSITY=3`, `VISUAL_DENSITY=4`
- Module loading: `enforcement`, `layout`, `taste`, `assets`, `audit`, `calibration`
- Likely decisions:
- use a focused hero with early proof
- avoid three equal feature cards as the whole story
- use one clear CTA and one supporting path
- keep motion restrained and story-supporting
- What should happen:
- value proposition becomes clear in the first viewport
- proof appears early
- typography and spacing feel intentional without over-stylizing the product
- What should not happen:
- purple-blue startup wallpaper by reflex
- fake metrics and hype copy
- dashboard-style card spam replacing a narrative page

## 2. Create a dense operations dashboard

- Prompt: "Build a dense operations dashboard for incident, queue, and deployment visibility. It should scan fast and stay usable on laptop screens."
- Detected mode: Create
- Detected surface: dashboard/app shell plus data display
- Dial settings: `DESIGN_VARIANCE=3`, `MOTION_INTENSITY=2`, `VISUAL_DENSITY=8`
- Module loading: `enforcement`, `layout`, `components`, `assets`, `audit`, `calibration`
- Likely decisions:
- use a persistent shell with summary row, filters, and table or split-pane core
- prefer tables and grouped panels over decorative cards
- keep iconography consistent and minimal
- What should happen:
- high-priority status is immediately visible
- repeated data remains comparable
- motion is subtle and informative
- What should not happen:
- oversized hero-like headers
- decorative gradients that reduce scan clarity
- cards for every metric and row

## 3. Adopt mode: add a settings page to an existing app

- Prompt: "Add a notifications settings page to our existing app. Follow the current design system."
- Detected mode: Adopt
- Detected surface: settings/admin
- Dial settings: inherit from existing system, default to conservative
- Module loading: `enforcement`, `components`, `layout`, `audit`
- Likely decisions:
- inspect existing settings rows, field wrappers, buttons, and icon family
- use switches only for immediate binary settings
- isolate destructive or privacy-sensitive actions
- What should happen:
- new page looks native to the app
- typography, spacing, and icon usage match existing settings pages
- minimal diff approach stays intact
- What should not happen:
- new font stack
- new icon family
- re-theme or dashboard-ify the settings surface

## 4. Repair mode: audit and improve an existing form

- Prompt: "Review this account invite form and improve it. Users keep failing to submit correctly."
- Detected mode: Repair
- Detected surface: form flow
- Dial settings: `DESIGN_VARIANCE=2`, `MOTION_INTENSITY=1`, `VISUAL_DENSITY=5`
- Module loading: `enforcement`, `components`, `layout`, `audit`
- Likely decisions:
- inspect labels, error placement, helper text, disabled and loading states
- verify submit button type and validation timing
- tighten section grouping and action placement
- What should happen:
- field-level errors appear where users can act on them
- required states exist
- the form becomes easier to complete without a visual rewrite
- What should not happen:
- replacing the form with a brand-new theme
- using toast-only validation
- adding decorative motion to "improve" the experience

## 5. Repair mode: fix motion performance issues

- Prompt: "This dashboard feels janky. Fix the motion and interaction performance without redesigning it."
- Detected mode: Repair
- Detected surface: dashboard/app shell
- Dial settings: keep current design variance, reduce effective motion intensity if needed
- Module loading: `enforcement`, `assets`, `audit`, `layout`
- Likely decisions:
- replace layout-heavy animation with transform or opacity
- remove decorative stagger from dense data surfaces
- pause offscreen effects and test reduced-motion behavior
- What should happen:
- motion stays functional and lighter
- perceived responsiveness improves
- structure and theme remain mostly unchanged
- What should not happen:
- full visual redesign
- introducing a heavy new animation dependency casually
- keeping blur-heavy animated overlays just because they look premium

## 6. Adopt mode: add a table view within an existing admin app

- Prompt: "Add a table view for API keys in the existing admin app. Match the current shell and patterns."
- Detected mode: Adopt
- Detected surface: table-centered admin surface
- Dial settings: inherited, likely `VISUAL_DENSITY=7`
- Module loading: `enforcement`, `components`, `layout`, `assets`, `audit`
- Likely decisions:
- reuse current table primitives and toolbar patterns
- keep row actions in the established action menu pattern
- use an empty state that matches the existing admin tone
- What should happen:
- columns prioritize identifier, owner, status, and last-used info
- mobile or narrow screens get an explicit degradation strategy
- What should not happen:
- replacing the table with cards because cards feel more designed
- introducing a new popover or menu library without need
- using a whimsical empty state that clashes with admin tone

## 7. Create mode: mobile-first onboarding flow

- Prompt: "Create a mobile-first onboarding flow for a productivity app. It should feel clear and encouraging."
- Detected mode: Create
- Detected surface: auth/onboarding plus form flow
- Dial settings: `DESIGN_VARIANCE=5`, `MOTION_INTENSITY=3`, `VISUAL_DENSITY=4`
- Module loading: `enforcement`, `layout`, `components`, `taste`, `assets`, `audit`
- Likely decisions:
- single-column flow
- progress clarity without overbuilt steppers
- supportive illustration only if it does not compete with the form
- What should happen:
- primary action remains obvious
- copy is reassuring and concrete
- tap targets are large and spacing is mobile-appropriate
- What should not happen:
- desktop-first two-column layout forced onto phones
- animation-as-delay between steps
- giant marketing art displacing the task

## 8. Audit-only: review a component file for correctness and distinctiveness

- Prompt: "Audit this React component for accessibility, correctness, and whether it feels like lazy AI output."
- Detected mode: Repair
- Detected surface: embedded component
- Dial settings: inherit from surrounding surface if known
- Module loading: `enforcement`, `components`, `audit`, `taste`
- Likely decisions:
- inspect primitive choice and required states first
- evaluate naming, focus, semantics, and state completeness
- then evaluate whether the styling is generic in a harmful way
- What should happen:
- findings are severity-based and routed to the right module
- taste concerns remain taste concerns unless they harm fit or clarity
- What should not happen:
- collapsing everything into a single "make it more premium" note
- calling generic style a blocker when semantics are actually correct
- ignoring existing system constraints in the name of distinctiveness


