# Layout

This file is the structure engine.

Use it after mode and surface detection, and before deep style work.

## Layout Decision Flow

Follow this sequence. Do not start from aesthetics alone.

### 1. Identify the primary user goal

Ask:

- what is the user trying to accomplish on this surface
- what must they notice first
- what action, decision, or understanding should the layout accelerate

Examples:

- landing page: understand value and convert
- dashboard: scan status and enter work
- settings page: locate a category and change a configuration safely
- form flow: finish required inputs with low friction

### 2. Define the top-level content hierarchy

List the content in order of importance:

- primary task or message
- supporting evidence or controls
- secondary context
- tertiary metadata

If everything seems equally important, the hierarchy is not solved yet.

### 3. Choose the navigation model

Pick the smallest navigation structure that matches the surface:

- no persistent nav for short landing pages or single-purpose forms
- top nav for broad but shallow destinations
- sidebar nav for deep workspace or admin structures
- tabs for sibling views under one object or section
- split-pane for list-detail or inspector-heavy workflows

### 4. Choose the content container model

Choose based on how many simultaneous regions the user needs:

- single column for reading or focused completion
- two-column or asymmetric split for content plus support context
- app shell for persistent navigation plus main work area
- panel stack for dense workflows with inspectors, filters, and tools

### 5. Translate density

Set space, grouping, and visible metadata using `VISUAL_DENSITY`.

High density is not "less design." It is a different organization strategy.

### 6. Translate variance

Set rhythm, emphasis, and section contrast using `DESIGN_VARIANCE`.

Variance modifies how predictable or emphatic the layout feels. It does not excuse broken hierarchy.

### 7. Plan responsive collapse

Decide before implementation:

- what stays visible
- what collapses
- what becomes a drawer or sheet
- what becomes tabs, accordions, or progressive disclosure
- what should disappear entirely on small screens

### 8. Place primary and destructive actions

Actions should follow risk and task frequency:

- primary actions near the completion point
- repeated utility actions near local context
- destructive actions separated and clearly signaled

### 9. Reserve space for states

Every surface needs deliberate space for:

- loading
- empty
- error
- success or confirmation
- no-access or restricted states

### 10. Check scan order

Before implementation, trace the order a first-time user will read:

- headings
- summary stats or key value prop
- filters or controls
- main content
- support metadata

If the order is unclear, the layout is not ready.

## Layout Archetypes

Use these as starting patterns. Adapt them; do not cargo-cult them.

### Marketing hero + proof + features + CTA

Purpose:

- explain value fast, build trust, then convert

Best use cases:

- product marketing
- campaign pages
- launch pages

Anti-use cases:

- dense admin tools
- configuration-heavy flows

Hierarchy behavior:

- hero establishes value and primary CTA
- proof follows early
- feature explanation comes after relevance is established

Navigation placement:

- light top nav or no nav

Responsive collapse strategy:

- stack hero content
- convert side-by-side proof to vertical sequence
- keep CTA visible early

Common mistakes:

- oversized hero with no proof
- equal-weight sections that flatten urgency
- three feature cards with no differentiated story

### Dashboard shell

Purpose:

- give persistent orientation and fast entry into active work

Best use cases:

- operational overview
- mission control
- analytics entry point

Anti-use cases:

- short single-task forms

Hierarchy behavior:

- navigation and identity stay stable
- key metrics or alerts appear above secondary panels
- active queues and recent work come before long-tail metadata

Navigation placement:

- sidebar or rail on desktop
- drawer or bottom nav on mobile

Responsive collapse strategy:

- collapse secondary panels before core metrics
- turn fixed sidebars into drawers

Common mistakes:

- too many equal cards with no action hierarchy
- filters and controls scattered across the header without grouping

### Settings/admin panel

Purpose:

- change configuration safely and predictably

Best use cases:

- account settings
- permissions
- billing and operational controls

Anti-use cases:

- high-emotion storytelling pages

Hierarchy behavior:

- categories first
- explanations brief and local
- dangerous actions isolated

Navigation placement:

- left nav, tabs, or section index depending on depth

Responsive collapse strategy:

- sections stack
- local descriptions remain near controls
- destructive areas move lower and stay visually separated

Common mistakes:

- treating settings like a marketing page
- hiding critical consequences in helper text

### Form flow

Purpose:

- move the user through input completion with low confusion

Best use cases:

- checkout
- applications
- multi-step onboarding

Anti-use cases:

- data exploration surfaces

Hierarchy behavior:

- current step and task stay clear
- only essential supporting content remains visible

Navigation placement:

- stepper, progress bar, or lightweight breadcrumb

Responsive collapse strategy:

- single-column on mobile
- inline validation and sticky next actions where appropriate

Common mistakes:

- too many side explanations
- unclear step count or progress
- actions placed far from the field cluster

### Docs/content page

Purpose:

- support reading, scanning, and wayfinding

Best use cases:

- knowledge base
- product docs
- help center

Anti-use cases:

- high-frequency operational dashboards

Hierarchy behavior:

- title, summary, and local navigation lead
- content sections follow strong heading rhythm

Navigation placement:

- sidebar or in-page table of contents depending on depth

Responsive collapse strategy:

- sidebar collapses to drawer or top section menu
- code blocks and tables need overflow strategy

Common mistakes:

- line lengths that are too wide
- headings with weak contrast from body copy

### List-detail

Purpose:

- let users browse a collection while keeping one record in focus

Best use cases:

- inboxes
- tickets
- file browsers
- CRM records

Anti-use cases:

- short one-off forms

Hierarchy behavior:

- list supports triage
- detail view supports action and context

Navigation placement:

- left list, right detail on desktop
- stacked list then detail on mobile

Responsive collapse strategy:

- move detail to route, sheet, or full-screen panel

Common mistakes:

- overloading the list with detail-only metadata
- losing clear selected state

### Data-heavy workspace

Purpose:

- support active analysis, filtering, and comparison

Best use cases:

- analytics tooling
- observability
- operations consoles

Anti-use cases:

- simple consumer landing pages

Hierarchy behavior:

- filters and summary frame the work
- dense tables or charts take center stage

Navigation placement:

- app shell plus local toolbars

Responsive collapse strategy:

- prioritize filter access and primary dataset
- move nonessential inspectors into drawers

Common mistakes:

- card-ifying every metric and record even when tables would be clearer
- wasting vertical space with oversized headers

### Split-pane workspace

Purpose:

- keep two or more active contexts visible at once

Best use cases:

- editors with preview
- command center plus inspector
- chat plus artifacts

Anti-use cases:

- simple read-only pages

Hierarchy behavior:

- one pane is primary
- other panes support inspection, editing, or monitoring

Navigation placement:

- persistent shell outside panes when needed

Responsive collapse strategy:

- one pane becomes a sheet, tab, or stacked section

Common mistakes:

- making all panes equal even when one is clearly primary
- ignoring minimum usable widths

### Auth/onboarding

Purpose:

- establish trust and move users into the product

Best use cases:

- signup, login, password reset, invite acceptance, initial setup

Anti-use cases:

- large exploratory dashboards

Hierarchy behavior:

- primary task dominates
- supportive explanation remains short and reassuring

Navigation placement:

- minimal global navigation

Responsive collapse strategy:

- single-column by default
- secondary illustration or proof can drop below the form

Common mistakes:

- burying the form under branding theatrics
- over-animating trust-critical flows

### Landing page

Purpose:

- convert a focused audience for a focused offer

Best use cases:

- campaign pages
- product launch pages
- lead capture

Anti-use cases:

- deep documentation

Hierarchy behavior:

- one offer, one message, one dominant action

Navigation placement:

- minimal; avoid escape hatches unless needed

Responsive collapse strategy:

- compress sections aggressively
- keep proof and CTA visible

Common mistakes:

- multiple competing CTAs
- proof too late

### Feed/timeline

Purpose:

- support repeated scanning of chronological or ranked items

Best use cases:

- activity feeds
- changelogs
- update streams

Anti-use cases:

- settings management

Hierarchy behavior:

- item structure must repeat consistently
- metadata is compact and scannable

Navigation placement:

- filters or source selectors above the feed

Responsive collapse strategy:

- metadata condenses
- secondary actions move to menus

Common mistakes:

- inconsistent item heights without reason
- too much inline chrome around each entry

### Table-centered admin surface

Purpose:

- manage records efficiently with filters, sorting, and batch action potential

Best use cases:

- user admin
- billing records
- inventory
- support queues

Anti-use cases:

- heavily narrative marketing work

Hierarchy behavior:

- filters and summary frame the table
- row actions remain local and predictable

Navigation placement:

- toolbar above table, detail in drawer or route

Responsive collapse strategy:

- hide lower-priority columns
- convert row detail into expandable sections or detail routes

Common mistakes:

- squeezing too many columns without prioritization
- replacing tables with card stacks when comparison is the real job

## Density Translation

Translate `VISUAL_DENSITY` into layout behavior.

### Low density

- larger spacing between groups
- more negative space
- fewer simultaneous controls
- short supporting metadata
- tables may give way to cards or simplified rows

### Medium density

- moderate spacing
- visible but controlled metadata
- grouped controls with clear section rhythm
- tables stay readable without becoming cramped

### High density

- tighter spacing
- more persistent metadata visible
- stronger use of tabs, segmented controls, inline toolbars, and structured tables
- less card use when cards waste comparison space
- more deliberate truncation and overflow handling

## Variance Translation

Translate `DESIGN_VARIANCE` into structural behavior.

### Low variance

- predictable symmetry
- restrained section alternation
- standard headline-plus-body rhythm
- modest emphasis shifts

### Medium variance

- some asymmetry
- varied section emphasis
- more active use of negative space
- selective contrast between sections

### High variance

- stronger rhythm shifts
- selective overlap, contrast, or asymmetric emphasis
- more editorial or campaign-like pacing

High variance is usually wrong for settings/admin and dense operational surfaces.

## Responsive Rules

Apply these regardless of style intent.

### Breakpoint collapse

- collapse supporting columns before primary work
- keep the main task visible longest
- avoid three-column desktop structures that become unusable stacks without reprioritization

### Sidebars to drawers

- desktop sidebar can become mobile drawer, top sheet, or bottom nav depending on destination count and task frequency

### Tables

- degrade by priority, not by blind horizontal squish
- hide low-priority columns first
- move row detail into expandable rows, drawers, or detail routes
- keep key identifiers and row actions accessible

### Filters

- inline on large screens when used constantly
- in sheets or drawers on small screens when numerous
- keep active filter chips or summary visible after collapse

### Overflow

- use explicit horizontal overflow handling for tables and code blocks
- do not let important actions disappear offscreen without affordance

### Mobile-first prioritization

- lead with the user's current job
- defer supporting analytics, long descriptions, and tertiary metadata
- expand tap targets and spacing around critical controls

### Sticky regions and safe areas

- sticky headers and footers must not cover content
- respect safe areas for bottom actions and edge-pinned controls

## Hierarchy Rules

### Primary action placement

- place it near the decision or completion point
- avoid forcing a long scroll back to the top for the action that finishes the task

### Reading and scanning order

- heading
- short orienting context
- primary controls or value
- main body
- secondary context

### Information chunking

- group by task, not by arbitrary visual similarity
- section titles must earn their keep by clarifying the group

### Callouts

- reserve callouts for exceptions, warnings, or key insights
- too many callouts flatten urgency

### Support metadata

- keep it near the thing it explains
- demote it visually without hiding it when it matters operationally

### Destructive actions

- separate from primary actions
- label plainly
- avoid adjacency that invites accidental taps

### Empty, loading, and error states

- give them enough prominence to explain the situation
- do not bury them under decorative framing

## Layout Anti-Patterns

These are common lazy defaults, not universal bans.

### The generic centered hero

Often lazy because:

- it hides hierarchy problems behind symmetry

Fine when:

- the page truly has one message and one primary action

Diversify by:

- introducing earlier proof, asymmetry, or stronger supporting structure

### Three equal feature cards

Often lazy because:

- it implies all benefits are equally important

Fine when:

- features are truly peer-level and brief

Diversify by:

- leading with one flagship benefit and demoting supporting features

### Card-per-everything dashboards

Often lazy because:

- it wastes space and weakens comparison

Fine when:

- metrics are sparse and independent

Diversify by:

- use tables, grouped panels, or mixed-density sections

### Bento for its own sake

Often lazy because:

- it substitutes collage for information architecture

Fine when:

- the story is exploratory and the content blocks genuinely differ

Diversify by:

- use it selectively instead of as the entire page grammar

## Short Examples

### Settings page, Adopt mode, density 6

Expected layout:

- category nav
- narrow explanatory copy
- form-like control groups
- destructive section at the bottom

Avoid:

- dramatic hero section
- new font or icon family

### Landing page, Create mode, variance 7

Expected layout:

- stronger section contrast
- early proof
- one dominant CTA
- asymmetry allowed where it improves emphasis

Avoid:

- hiding conversion under theatrical art direction

### Data-heavy workspace, Repair mode, density 8

Expected layout:

- summary row
- filter toolbar
- table or split-pane core
- compact metadata and clear overflow plan

Avoid:

- turning the core dataset into tall cards


