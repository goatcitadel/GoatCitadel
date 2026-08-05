---
name: design-intelligence
description: Build, extend, repair, or audit UI through a modular design decision system. Use when Codex needs to create new interfaces, adopt an existing design system, repair broken UI, choose layout and components, apply style intentionally, resolve assets and motion, or run structured UI audits with severity and fix routing.
---

# Design Intelligence

## Mission

Use this skill to make repeatable UI decisions under real constraints.

This skill is for:

- creating a new interface with deliberate structure instead of default AI patterns
- adopting an existing app, design system, or codebase without bulldozing it
- repairing existing UI for correctness, accessibility, clarity, performance, and completeness
- auditing UI output with explicit severity and routing

This skill is not for:

- forcing a signature aesthetic onto every surface
- treating taste preferences as hard law
- re-theming existing work unless the user asks for that
- replacing product thinking with visual novelty

Assume React, TypeScript, and Tailwind examples when useful. Keep the reasoning framework portable to other stacks.

## Design Quality V1

This skill is also GoatCitadel's native design-quality layer. It may borrow
portable concepts from outside design tools, but it must not install, invoke, or
claim external design runtimes by default.

Use this model for GoatCitadel work:

- `surface intent`: what the user is trying to do and which register the UI
  belongs to
- `design system/tokens`: the existing Mission Control tokens, primitives,
  spacing, typography, icon family, and route patterns
- `craft rules`: universal quality rules for hierarchy, state coverage,
  accessibility, motion, specificity, and anti-slop behavior

These three axes keep design work grounded. A tasteful idea that ignores
surface intent is noise. A strong craft rule that fights the product tokens
needs calibration. A token-faithful surface that ships missing states is still
not good enough.

### Lifecycle Vocabulary

Use this lifecycle when explaining design work:

- `Start`: lock the product brief, audience, surface register, and constraints
  before designing. Maps mostly to `Create`.
- `Iterate`: improve something visible in place using the existing code and
  design system. Maps mostly to `Adopt`.
- `Polish`: run the pre-ship pass for hierarchy, states, copy specificity,
  responsiveness, accessibility, and visual coherence. Maps mostly to `Repair`
  plus `shipping` profile.
- `Maintain`: pay down design debt, token drift, inconsistent components, and
  recurring AI-output tells before they harden. Maps to `Repair` in conservative
  mode.

### GoatCitadel Registers

Always identify the register before recommending visual changes:

- `product UI`: Chat, Cowork, Code, Projects, Library, Settings, and most app
  workflows. Optimize for trust, scanability, state visibility, and repeated use.
- `ops dashboard`: Runtime, Quality, diagnostics, cost, backups, approvals, and
  release proof. Dense is acceptable when hierarchy is clear; dark technical
  chrome and teal/cool accents are valid when token-backed.
- `brand/marketing`: public pages, launch narratives, decks, and screenshots.
  Stronger variance is allowed, but claims and imagery must remain truthful.
- `docs/evidence`: reference, reports, runbooks, quality evidence, and release
  notes. Optimize for reading order, provenance, and durable anchors.
- `mobile`: not a shrunken desktop. Reprioritize navigation, touch targets,
  safe areas, loading/error states, and long content.

### Calibrated Anti-Slop

Treat these as high-signal problems:

- inaccessible controls, missing keyboard/focus behavior, unsafe motion
- fake completeness, placeholder copy, invented metrics, or vague hype
- missing loading/empty/error/disabled/success/no-access states
- generic purple/blue gradients, decorative glass, emoji-as-icons, or card
  patterns that do not serve the product
- flat type hierarchy, weak content specificity, and layout that collapses on
  mobile or long strings

Do not over-apply outside advice. GoatCitadel may use dark operational chrome,
cool neon/teal accents, compact panels, rails, and data-heavy layouts when they
come from the Mission Control system and improve operator comprehension.

### Pre-Ship Loop

For non-trivial UI work, run this loop before final reporting:

1. Read the existing tokens, components, route context, and proof lanes.
2. Lock the brief: audience, surface register, success criteria, and constraints.
3. Plan the smallest visible change that fits the current system.
4. Implement or recommend using existing primitives first.
5. Check the required state set and accessibility contracts.
6. Run a five-dimension critique: intent fit, hierarchy, execution, specificity,
   and restraint.
7. Report proof: files touched, evidence checked, validation run, and remaining
   uncertainty.

## Operating Modes

### Create

Use when the task is greenfield or the user explicitly wants a new surface, component, or page.

Default behavior:

- derive structure from task, surface, and hierarchy first
- establish component choices before styling details
- use strong defaults aggressively
- run audit on complex or ship-intended work

### Adopt

Use when the task happens inside an existing app, design system, or codebase with visible patterns.

Default behavior:

- inspect existing components, tokens, spacing, typography, icon family, and motion level first
- preserve system rhythm unless the user asked for a redesign
- prefer minimal diffs and local changes
- escalate only when the existing system is actively causing a Class A failure

### Repair

Use when the task is to fix, critique, harden, refactor, or improve existing UI.

Default behavior:

- identify the failure class before changing aesthetics
- fix correctness, accessibility, state completeness, and performance before style refinements
- keep scope narrow
- audit before and after if the task is high risk

## Execution Profiles

Profiles modify behavior inside the chosen mode. They do not replace the mode.

### conservative

- reduce design variance
- prefer existing or highly conventional patterns
- minimize new dependencies and new motion
- good for Adopt, admin surfaces, and late-cycle fixes

### expressive

- allow more layout emphasis, stronger visual hierarchy, and more distinctive style
- still obey Class A and Class B rules
- good for marketing, landing pages, launches, and explicit brand work

### fast

- choose simpler structures and fewer custom patterns
- keep modules loaded to the minimum needed to ship a safe answer quickly
- avoid speculative exploration

### shipping

- bias toward completeness checks, state coverage, and audit discipline
- force stronger validation on responsiveness, accessibility, and missing states
- treat polish as secondary to correctness and clarity

## Surface Types

Surface type changes layout, density, hierarchy, motion, and acceptable variation.

- `marketing page`: narrative persuasion, proof, features, conversion
- `landing page`: campaign-specific conversion page with one dominant ask
- `dashboard/app shell`: persistent navigation, live status, overview, work orchestration
- `settings/admin`: configuration, permissions, operational clarity, safe actions
- `form flow`: multi-step or focused input completion
- `content/docs`: reading, reference, scanning, information retention
- `data display`: tables, charts, lists, metrics, filters, evidence-heavy surfaces
- `mobile-first interface`: constrained viewport, touch-first priorities, single-path flows
- `embedded component`: a bounded element inserted into an existing surface
- `workspace/split-pane`: parallel context, inspectors, panels, high task continuity
- `list-detail`: collections plus focused record view
- `auth/onboarding`: trust-building, low-friction start, recovery, progressive disclosure

## Dials

Dials are modifiers, not laws.

- `DESIGN_VARIANCE`: how far the layout and styling can depart from plain defaults
- `MOTION_INTENSITY`: how much movement is allowed for feedback, transition, and emphasis
- `VISUAL_DENSITY`: how compact the interface should feel

Use [calibration.md](./calibration.md) for anchor behavior.

## Detection Logic

### Detect Mode

Use this order:

1. If the user explicitly says audit, critique, fix, harden, debug, improve, or refactor existing UI, choose `Repair`.
2. If the user explicitly says add to an existing app, follow the current system, or work inside an existing codebase, choose `Adopt`.
3. If the user asks for a new page, flow, component, or concept without an established local system, choose `Create`.
4. If the repo already contains the target surface and the task is additive, prefer `Adopt` over `Create`.
5. If the target already exists and the user wants behavior or quality improvements, prefer `Repair` over `Adopt`.

When uncertain inside an existing codebase, choose `Adopt`.

### Detect Surface

Use prompt language, target file location, and page intent:

- hero, pricing, CTA, testimonials, launch, waitlist, campaign -> `landing page` or `marketing page`
- sidebar, workspace, shell, panels, command center -> `dashboard/app shell` or `workspace/split-pane`
- preferences, roles, billing, feature flags, permissions -> `settings/admin`
- wizard, signup, checkout, application, stepper -> `form flow` or `auth/onboarding`
- docs, help center, changelog, article, knowledge base -> `content/docs`
- table, records, analytics, metrics, filters, chart -> `data display`
- mobile app, handset, bottom nav, thumb reach -> `mobile-first interface`
- embed, widget, card component, panel section -> `embedded component`
- inbox + detail, list + inspector, master-detail -> `list-detail`

If a surface combines two patterns, choose the dominant one and load the secondary module guidance as needed.

### Decide Module Load

Always load:

- [enforcement.md](./enforcement.md)
- the mode logic in this file

Then load selectively:

- [presentation.md](./presentation.md) as the compact runtime entrypoint for slide-deck and PowerPoint artifact work
- [components.md](./components.md) when choosing, creating, or repairing components
- [layout.md](./layout.md) when page structure, hierarchy, density, or responsiveness matter
- [taste.md](./taste.md) when visual strategy, typography, color, or distinctiveness matter
- [assets.md](./assets.md) when icons, imagery, video, motion implementation, or media performance matter
- [audit.md](./audit.md) when reviewing output, shipping UI, or fixing non-trivial regressions
- [examples.md](./examples.md) when the task is ambiguous and a worked pattern will help
- [calibration.md](./calibration.md) when dial values are provided or need translation

### When To Run Audit

Run at least a quick audit when:

- the user asked for a review or critique
- the output includes interactive UI beyond simple text and links
- the surface contains forms, tables, dialogs, menus, tabs, drawers, toasts, or navigation
- the change is intended for shipping
- the user asks for "better," "more polished," or "more distinct" and the risk of vague advice is high

Run a full audit when:

- you touched multiple dimensions at once
- the work is a landing page, dashboard, settings surface, or multi-step form
- the first pass introduced custom layout, motion, or component logic
- the user asked for severity, routing, or ship-readiness

### When To Stay Conservative

Stay conservative when any of these are true:

- existing system patterns are strong and consistent
- the user asked for minimal diff
- the surface is settings/admin, dense workflow, or operational UI
- brand direction is unknown
- time is limited and the safest path is clear
- the UI carries safety, permissions, billing, destructive actions, or mission-critical workflow

## Pipeline

Use this sequence unless the user explicitly narrows scope:

1. detect mode and surface
2. load [enforcement.md](./enforcement.md)
3. derive information architecture and content structure
4. choose components from [components.md](./components.md)
5. synthesize layout using [layout.md](./layout.md)
6. synthesize style and visual strategy using [taste.md](./taste.md)
7. resolve icons, images, media, and motion implementation with [assets.md](./assets.md)
8. generate or revise the output
9. audit with [audit.md](./audit.md) if the task or risk level justifies it
10. iterate based on the audit findings, starting with the highest-severity issue

## Precedence Hierarchy

Use this order whenever guidance conflicts:

1. explicit user instruction
2. existing system constraints
3. hard fails
4. strong defaults
5. taste warnings
6. style choices

Never let a style preference overrule an accessibility, semantics, or correctness requirement.

## Override Protocol

If the user explicitly wants something that this system would normally discourage:

1. comply if it does not create a Class A failure
2. acknowledge the tradeoff briefly
3. stop arguing after the acknowledgement

Example:

- user asks for a centered hero inside a campaign page
- comply if the surface supports it
- note only that conversion clarity and proof placement still matter

Do not keep trying to "save" the user from a deliberate style choice.

## Module Loading Matrix

| Task | Highest-priority modules |
| --- | --- |
| Dashboard | `enforcement`, `layout`, `components`, `assets`, `audit` |
| Landing page | `enforcement`, `layout`, `taste`, `assets`, `audit` |
| Settings page | `enforcement`, `components`, `layout`, `audit` |
| Form flow | `enforcement`, `components`, `layout`, `audit`, `assets` |
| Audit only | `enforcement`, `audit`, then whichever module owns the finding |
| Component creation | `enforcement`, `components`, `audit` |
| Redesign in existing system | `enforcement`, `layout`, `components`, `taste`, `audit`, with `Adopt` protections active |
| Presentation or slide deck | `presentation` only; it contains the compact hard rules needed by the governed Chat runtime |

## Anti-Bloat Rule

Do not restate whole support modules inside this file.

Use `SKILL.md` to:

- route
- detect mode and surface
- decide module load
- set precedence
- define pipeline

Use support files for the detailed rules, schemas, and examples.


