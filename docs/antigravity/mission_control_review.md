# GoatCitadel Mission Control — Full-Spectrum Frontend & Design Review

> **Historical note (2026-05-18)**: This Antigravity review describes the legacy `apps/mission-control` compatibility shell and an older Operate/Observe/Configure IA snapshot. The canonical `1.0` Mission Control shell is now `apps/mission-control-next`; use [docs/1_0_CONTRACT.md](../1_0_CONTRACT.md), [docs/1_0_RELEASE_EVIDENCE.md](../1_0_RELEASE_EVIDENCE.md), and [apps/mission-control-next/src/app/route-model.ts](../../apps/mission-control-next/src/app/route-model.ts) for current product truth.

> **Reviewer posture**: Principal product designer / creative director / staff frontend engineer / design-systems architect.  
> **Inspection scope**: 22 CSS files (460KB+), 15 page-level components, App.tsx (1364 lines), page-registry routing, two theme implementations (signal-noir + citadel-light), ui-preferences system, surfaces.css, and 26 screenshots across all major surfaces.

---

## A. Executive Verdict

GoatCitadel Mission Control is a **legitimately ambitious product with real architectural thinking behind it**. The Operate/Observe/Configure IA is defensible, the signal-noir theme has genuine atmosphere, the chat surface is functionally deep, and the trust/approval system is unusually well-considered for a product at this stage. But the frontend has accumulated **3-4 generations of styling logic** that are now actively working against each other. The legacy-base.css alone is 5,860 lines and still sets global `button`, `table`, `th`, and `td` styles that every theme file fights to override. The signal-noir theme is 1,021 lines of class-scoped overrides on top of shell.css overrides on top of legacy-base globals. Citadel-light is 2,831 lines, many of which are surgical undoings of dark-theme defaults. The token layer (tokens.css, 40 lines) is aspirational — it defines spacing and typography tokens but the actual color system lives almost entirely in inline `rgba()` values scattered across three theme files. The result is a product that *almost* feels like one thing but drifts on nearly every page. Chat feels lovingly built. Settings feels like an admin panel from a different product. Activity shows raw JSON. Cowork and Code are functionally identical to Chat with a different header label. The shell creates a strong first impression, but the promise fades as you move deeper.

**Grade: B-/C+**  
Strong thesis, genuine engineering depth, real product ambition — held back by frontend archaeology, surface-differentiation debt, and a color/token system that has never been truly consolidated.

### The 15 Most Important Truths

1. **legacy-base.css (115KB, 5,860 lines) is the root cause of most visual inconsistency.** It sets global button, table, card, input, and typography styles that make every other file an override layer.
2. **There is no real token-driven color system.** `tokens.css` is 40 lines of spacing and font-stack tokens. All color is expressed as inline `rgba()` in theme files, making palette changes require grep-and-replace across 150KB+ of CSS.
3. **The signal-noir theme has genuine atmosphere and is the strongest visual asset.** The cyan/ember gradient language, grid overlay, and `clip-path` panels are distinctive and cohesive when they appear.
4. **Chat, Cowork, and Code are structurally the same component with a mode prop.** The visual differentiation is limited to minor grid-column changes and a different header subtitle. They do not feel like genuinely distinct surfaces.
5. **The shell header (shell-bar) consumes ~130px of vertical space before you see any content.** Combined with the status strip (~120px) and secondary nav (~45px), almost 300px is overhead on every Operate page.
6. **The status strip is powerful but always visible**, even when you're in chat and need the space for conversation. It should be contextual.
7. **Settings pages feel like a completely different product.** The vertical tab + content grid layout with generic form elements lacks the panel vocabulary used elsewhere.
8. **The Observe > Activity live feed dumps raw JSON.** This is the single weakest UX surface in the product — a realtime observability stream that requires you to read serialized prefs objects.
9. **Three layers of nav compete for attention**: space nav (Operate/Observe/Configure), secondary nav (Chat/Cowork/Code/Tasks/Approvals), and page-level tabs (Live feed/Scheduler/Improvement). Each uses a slightly different pill button style.
10. **The citadel-light theme (2,831 lines) is mostly surgical overrides undoing signal-noir defaults.** It is not a first-class design — it is a correction layer.
11. **The page-header kicker/eyebrow pattern ("OPERATE", "OBSERVE", "CONFIGURE") repeats what the shell already tells you.** It wastes vertical space and adds no information.
12. **obsidian-legacy.css (94KB) still exists in the styles directory** alongside legacy-base.css — there are two legacy layers still present.
13. **The border-radius language drifts between 7px, 8px, 10px, 12px, 14px, 16px, 18px, 20px, 22px, and 24px** across surfaces, with no clear hierarchy.
14. **Trust signals (model, provider, workspace, approvals, stream state) are split between the shell-bar, status strip, and deep within the chat composer.** There is no unified trust zone.
15. **The product is very close to a threshold where consolidation would unlock significantly more velocity than adding features.** One good frontend pass would change the trajectory.

---

## B. What Is Already Strong

1. **The Operate/Observe/Configure mental model** is a genuine insight. It maps to operator roles (doing / watching / tuning) rather than implementation buckets. This should be preserved.
2. **Signal-noir's visual identity** — the cyan-to-ember gradient bar on panels, the grid-mesh overlay, the dark glass panels, the `clip-path` notch on topbar and page-header — is distinctive and evocative. This is the product's visual fingerprint.
3. **The status strip as a concept** — showing approvals, agents, spend, and tasks at a glance — is exactly what a mission-control product should have in the operator flow.
4. **The command palette (`Ctrl+K`)** is well-built and navigable. The command-item coverage is broad (surfaces, density, effects mode, technical details).
5. **Approval cards with risk gradation** — safe/caution/danger/nuclear as distinct visual treatments — is strong trust UX.
6. **The workspace picker in the shell-bar** provides persistent context about where you are operating. This belongs at the shell level.
7. **The density system works.** `--density-scale` applied to spacing tokens is a clean solution that produces real layout changes across three modes.
8. **The session sidebar in chat** (projects, mission vs external sessions, search, archive/active toggle) is well-organized for a multi-session workspace.
9. **The `ChatPage.tsx` orchestration layer** (1,257 lines with hooks like `useChatSurfaceOrchestration`, `useChatSessionData`, `useChatOutboundExecution`) shows serious composition. The behavior complexity is well-factored even if the file is long.
10. **Progressive disclosure (simple/advanced mode, showTechnicalDetails)** is wired at the shell level and propagated through CSS classes. The mechanism is sound.

---

## C. What Is Weak (Ordered by Severity)

### Critical

1. **No color token system.** Every color is a raw `rgba()` value. There are hundreds of unique, near-neighbor blues, teals, and darks across three theme files that cannot be changed without regex across 150KB+ of CSS. This is the single largest frontend architecture debt.

2. **Legacy-base.css (115KB) sets global element styles that every theme must override.** Lines 147-177 set global `button` appearance; lines 343-367 set global table styles; lines 370-379 set global `.card` styles. These defaults fight every themed component.

3. **Chat/Cowork/Code are not different surfaces — they are the same component wearing different subtitles.** The screenshots confirm this: identical sidebar, identical thread view, identical composer, identical status strip. Only the header copy and minor grid proportions change. This undermines the product's core promise of "one engine, multiple modes."

### Severe

4. **The Observe > Activity live feed shows raw JSON payloads.** For a product whose thesis is "transparent about what the AI is doing and why," dumping unformatted JSON is the opposite of transparency — it's data exposure without comprehension.

5. **The vertical space budget on Operate pages is brutal.** Shell bar (~130px) + secondary nav (~45px) + status strip (~120px) = 295px consumed before content begins. On a 1080p display, this leaves barely 50% of the viewport for actual work.

6. **The Settings page looks like a different product.** The vertical tab rail + flat content area pattern doesn't use the panel/card vocabulary. The "Calm Goat 🐐" status chips are charming but the layout around them is sparse and listlike.

### Significant

7. **Three nav bands with three different pill-button styles.** Space nav, secondary page nav, and page-level tabs (e.g., Live feed/Scheduler/Improvement) all use pill buttons but with subtly different sizing, border-radius, and active-state treatment.

8. **Page headers repeat space context ("OBSERVE / Activity")** that the shell already communicates. This is redundant vertical overhead.

9. **The citadel-light theme is a 2,831-line correction layer**, not a designed-from-tokens light theme. It rewrites nearly every dark-theme assumption. Many selectors reach 4-5 levels of specificity nesting.

10. **The border-radius vocabulary is unbounded.** I count at least 10 distinct values used structurally: 7, 8, 10, 12, 14, 16, 18, 20, 22, 24px. There is no clear hierarchy (e.g., small/medium/large/page).

---

## D. Color + Visual System Audit

### What Is Strong

- **Signal-noir's core palette is evocative and distinctive.** The `#54ddff` cyan, `#ff9a45` ember, `#6ef5a5` success, and `#ff5678` crimson form a legible four-color system against the dark blue-black backgrounds.
- **The cyan-to-ember gradient bar** (`linear-gradient(90deg, rgba(84, 221, 255, 0.92), rgba(255, 154, 69, 0.54), transparent)`) used on panel `::before` pseudo-elements is the strongest brand-level visual.
- **Semantic status colors are well-chosen.** Live=cyan, success=green, warning=ember, critical=crimson. These read clearly.

### What Drifts

- **Background darks are a sea of near-neighbors.** I count 15+ unique dark background values in signal-noir alone:
  - `#06080d`, `#090d14`, `#0a1017` (named custom props)
  - `rgba(8, 11, 18, 0.95)`, `rgba(10, 16, 24, 0.96)`, `rgba(13, 19, 28, 0.92)`, `rgba(13, 20, 30, 0.98)`, `rgba(14, 20, 30, 0.98)`, `rgba(12, 18, 28, 0.94)`, `rgba(15, 22, 34, 0.96)`, `rgba(7, 11, 18, 0.88)`, `rgba(11, 18, 28, 0.98)`, etc.
  - These are *functionally identical* but defined independently in hundreds of places.

- **Border opacity drift.** Cyan borders appear at opacities of 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.28, 0.34, 0.38, 0.40, 0.48, 0.54 across just two files. There is no stepped system.

- **Text color drift in citadel-light.** Things that should be `--gc-text-secondary` are instead hard-coded as `rgba(34, 67, 77, 0.76)`, `rgba(36, 74, 86, 0.78)`, `rgba(33, 67, 77, 0.74)`, `rgba(24, 54, 63, 0.82)`, etc. These are all targeting the same conceptual "secondary text on teal background" but with unique values.

### What Clashes

- **Legacy-base.css defines `--accent: #58dcff`** while tokens.css references `--gc-accent` and signal-noir defines `--snr-cyan: #54ddff`**. Three different "accent" values coexist.
- **Legacy-base.css defines `--bg: #0f1724`** — a blue-leaning dark — while signal-noir uses `--snr-bg-core: #06080d` — a near-black. Core background color changes depending on which CSS loads last.

### What Should Become Canonical Tokens

```
/* Surface scale (5 levels) */
--gc-surface-app
--gc-surface-1         /* primary panels */
--gc-surface-2         /* secondary/muted panels */
--gc-surface-elevated  /* popovers, modals, raised panels */
--gc-surface-inset     /* inputs, code blocks, recessed areas */

/* Border scale (3 levels) */
--gc-border-subtle
--gc-border-default
--gc-border-strong

/* Text scale (4 levels) */
--gc-text-primary
--gc-text-secondary
--gc-text-muted
--gc-text-disabled

/* Accent system (4 semantic + brand) */
--gc-accent           /* primary interactive */
--gc-accent-success
--gc-accent-warning
--gc-accent-danger
--gc-accent-brand     /* the cyan-ember gradient source, not a single color */
```

### Verdict

This needs a **consolidation pass**, not a reset. The palette itself is strong. The problem is that every color is specified as a raw value rather than through tokens. A single pass converting inline `rgba()` values to semantic tokens would reduce the CSS by ~30% and make theme changes possible without archaeology.

---

## E. IA + Navigation Audit

### Operate / Observe / Configure

**Verdict: The right model, but the labels could be sharper.**

**What works:**
- Reflects operator roles, not subsystems
- "Operate" = what needs doing now → correct
- "Observe" = what the system is doing → correct
- "Configure" = how the system is set up → correct

**What's awkward:**
- "Observe" contains Quality (prompt packs, benchmarks). Quality is an action — you *run* tests, you *evaluate* results. It belongs more in Operate or as a standalone engineering surface.
- "Observe" puts Sessions, Activity, Artifacts, Costs, System, and Quality all at the same level. That's 6 pages. Sessions and Activity overlap conceptually (both are "what happened"). 
- Costs and System are both "health" pages but live next to Activity and Sessions which are "history" pages.

**Suggested refinement:**
- Rename: **Work / Observe / Tune** (more active verbs; "Configure" is generic)
- Merge Sessions into Activity (they're both event history)
- Move Quality to Operate (it's an active evaluation workflow, not passive observation)
- Group Costs + System as a single "Health" page under Observe

### Chat / Cowork / Code as Operate sub-surfaces

**Verdict: Conceptually interesting, visually under-delivered.**

The IA is correct — these represent different interaction postures with the same engine. But the current implementation makes them feel like radio buttons that change a subtitle, not genuinely different surfaces with different layouts, density, and tool surfacing.

### Nested tab layers

The deepest nesting is: **Space → Page → Tab** (e.g., Configure → Settings → Runtime). Settings has 8 tabs. This is too many for a vertical rail. It's a list, not a navigation.

---

## F. Component/System Audit

### Canonical (Preserve)

| Component | Notes |
|-----------|-------|
| **StatusChip** | Clean, well-typed, used consistently. 5 tones (live, success, warning, critical, muted). |
| **StatCard** | Good abstraction for KPI display. Used in status strip and agent/artifact overview pages. |
| **StatusStrip** | Strong concept — 4-card KPI bar for the operator view. |
| **CommandPalette** | Well-built, keyboard-navigable, broad action coverage. |
| **NotificationStack** | Position-fixed toast system with tones and auto-dismiss. |
| **PageGuideCard** | Expandable per-page guidance. Useful for progressive disclosure. |
| **Panel** | Basic card wrapper with heading/body slots. Sufficient. |
| **SectionHeader** | Title + actions layout. Used consistently. |
| **GCSelect/GCCombobox** | Radix-based primitives with theme-aware styling. These are foundational. |

### Drifting (Needs Consolidation)

| Component | Issue |
|-----------|-------|
| **PageHeader** | Used inconsistently — sometimes via `ShellPageFrame`, sometimes inline. The eyebrow/title/subtitle pattern varies in spacing and typography. |
| **PageTabs** | Used for settings vertical nav and activity horizontal tabs. Same component, but the visual treatment differs when vertical vs horizontal. |
| **Table** | Generic HTML `<table>` with styles from legacy-base.css. No DataTable component. Each page styles tables slightly differently. |
| **Cards (.card)** | The `.card` class from legacy-base.css conflicts with themed panel treatments. Chat thread uses `.card.chat-v11-thread` which requires `!important` in both themes. |

### Should Be Redesigned

| Component | Why |
|-----------|-----|
| **Shell Header (shell-bar)** | Too tall, too many concerns (brand, space nav, workspace, command palette, approvals status). Should be split into persistent strip + contextual band. |
| **Chat Surface Header** | Currently a PageHeader variant. Should become a compact mode indicator, not a full page header. |
| **Approval Cards** | Functional but raw. The JSON code block display and flat button row need structured layout. |
| **Activity/LiveFeed** | Raw JSON dump is not a component — it's the absence of one. Needs an event-card primitive. |

### Should Be Retired

| Pattern | Replacement |
|---------|-------------|
| `.card` class from legacy-base.css | Use `Panel` component exclusively |
| Global `button` styles (legacy-base L147-177) | Move to theme-scoped `.gc-button` |
| `.advanced-panel`, `.advanced-block` | Replace with `PageGuideCard` or disclosure component |
| `.sidebar-nav button` (legacy 6-column grid layout) | Replaced by shell-bar nav; sidebar no longer exists in command-deck layout |

---

## G. Surface-by-Surface Critique

### Chat

**Does well:** Sidebar session management is functional. Composer with drag-drop, file attach, and command suggestions is well-built. Turn rendering with branch selection shows deep thought about conversation structure.

**Falls short:** The thread view is a single tall scroll column taking ~55% of viewport width after ~45% is consumed by the sidebar and shell overhead. Empty state shows "GoatCitadel / Start with a plain request" — no warmth, no suggested actions, no personality. The model/provider is not visible from the main view — you have to open settings to know what model you're talking to.

**Should become:** A focused conversational surface where the model/provider is always visible, the session rail is collapsible, and the empty state helps new users start fast.

### Cowork

**Does well:** The concept of "guided multi-step execution with visible orchestration" is the right idea.

**Falls short:** It looks identical to Chat. The header says "Cowork" but the layout, sidebar, thread view, and composer are the same. The cowork panel (when it appears) is a small auxiliary card in the inspector lane. The orchestration stages should be the primary visual element, not a sidebar addon.

**Should become:** A split-pane surface where orchestration stages are as prominent as the conversation. Think: left rail for steps/checkpoints, center for active work, right for context/artifacts. The layout itself should signal "this is multi-step structured work, not a conversation."

### Code

**Does well:** The concept of project-bound, review-focused code sessions is sound. The code workbench panel exists.

**Falls short:** Same layout as Chat. The code workbench is a small panel that appears in the inspector lane. There's no integrated diff viewer, file tree, or output pane. It doesn't feel like anything a developer would choose over their editor.

**Should become:** A surface where code is the hero — diff viewer, file tree, terminal output, review annotations. The conversation should be a narrow secondary channel, not the primary content.

### Tasks / Trailboard

**Does well:** The split-pane layout (task queue table + task detail inspector) is a sound pattern. Status chips with lane controls (inbox/assigned/in_progress/testing/review/done/blocked) are well-thought-out.

**Falls short:** The table is raw HTML table with legacy styling. The "Move to Trash" / "Delete Permanently" buttons sit inline in a table cell. The checkpoint resume section at the bottom is powerful but buried.

**Should become:** A kanban-influenced board or structured list with inline actions and a proper slide-out inspector, not an HTML table.

### Approvals

**Does well:** Risk-graded card treatment (safe/caution/danger/nuclear) is excellent trust UX. The decision shell with approve/reject/replay is correct.

**Falls short:** The code block with raw JSON (`{ "summary": "Open Discord developer portal..." }`) needs a structured evidence view. The "Explainer error: approval explainer returned empty content" message is honest but needs a designed empty/error state.

**Should become:** The highest-trust surface in the product. Each approval should be a self-contained decision card with: what is being requested, why it's risky, what the consequences are, structured evidence, and confident approve/reject actions.

### Observe Pages (Activity, Sessions, Artifacts, Costs, System, Quality)

**Generally:** These feel like admin dashboards. They lack the mission-control atmosphere that the shell and chat surface have. Activity dumps JSON. Sessions is a table. System shows host vitals as stat cards (which is fine but sparse). Costs is functional but basic.

**Quality (Prompt Lab)** is the strongest Observe surface — it has actual workflow: packs, tests, runs, scoring, benchmarks. But it's very dense and feels like an internal engineering tool rather than an operator-facing quality console.

### Settings / Integrations / Tools / Agents (Configure space)

**Generally:** These are functional admin views that lack the panel/card vocabulary. The vertical tab rail for Settings (8 tabs) is too many items. The Integrations page with Obsidian configuration is well-structured but verbose.

**Agents hub** is the most interesting Configure surface. The role directory table with lifecycle/runtime/sessions columns and the edit inspector panel show good IA. But the stat cards (Active Roles: 8, Built-ins: 7) are less useful here than in Operate.

---

## H. Conservative Improvement Track

If we wanted maximum improvement with minimum disruption:

### Week 1-2: Token Consolidation
1. Extract all unique `rgba()` color values from signal-noir.css and citadel-light.css
2. Map them to ~20 semantic tokens covering surface, border, text, and accent scales
3. Replace inline values with custom-property references
4. **Impact:** Makes all future styling work 3-5x faster, enables systematic theme changes

### Week 2-3: Kill legacy-base.css globals
1. Move global `button`, `table`, `td`, `th`, `input`, `textarea`, `.card`, `.status-chip` styles into scoped theme selectors
2. Add a `reset.css` that only does box-sizing and margin zeroing
3. **Impact:** Eliminates the largest source of accidental style conflicts

### Week 3-4: Shell vertical budget
1. Make the status strip collapsible (already partially implemented — `compact.collapsed` class exists)
2. Default to collapsed when in Chat/Cowork/Code surfaces
3. Remove the page-header eyebrow on pages where the shell already communicates the space
4. **Impact:** Recovers ~150px of vertical space on Operate pages

### Week 4-5: Activity feed event cards
1. Replace raw JSON dump with structured event cards showing: event type icon, source, timestamp, and a human-readable summary
2. Keep "show raw" as an expandable detail
3. **Impact:** Transforms the weakest surface into a legitimate observability tool

### Week 5-6: Chat empty state
1. Add suggested actions grid: "Start a conversation", "Review pending approvals", "Run a code session", "Open Cowork workflow"
2. Show current model/provider
3. Add workspace project selector
4. **Impact:** Better first impression, faster time-to-value for new users

---

## I. Ambitious Redesign Track

If we wanted Mission Control to become materially better and more distinctive:

### 1. Unified token-driven design system ("Citadel DS")
- 5 surface tokens, 3 border tokens, 4 text tokens, 5 semantic accent tokens
- All components reference tokens exclusively
- Theme switching becomes a 30-line custom-property swap
- Retire legacy-base.css, obsidian-legacy.css entirely
- Retire the shell.css theme-scoped overrides (move to theme files only)

### 2. Redesigned shell model
- **Persistent strip** (48px): GoatCitadel wordmark | Current space/surface indicator | Model/provider badge | Approvals count | Workspace | Command palette trigger
- **Contextual band** (40px, only when useful): Surface descriptions, page tabs. Collapsible.
- Kill the current 130px shell-bar
- Status strip becomes an expandable tray, collapsed by default

### 3. Genuine surface differentiation
- **Chat**: Full-width thread with collapsible sidebar. Clean, fast, minimal chrome.
- **Cowork**: Split pane. Left: orchestration stage list. Center: active step detail + conversation. Right: artifact/context inspector.
- **Code**: Split pane. Left: file tree + project context. Center: diff viewer / editor. Right: conversation rail + output.
- Each surface gets its own subtle color accent: Chat=default cyan, Cowork=ember-warm, Code=neutral steel

### 4. Trust HUD
- A persistent 1-line strip below the shell showing: `🟢 Live | glm-5 via glm | 2 pending approvals | 3 active agents | default workspace`
- Updates in real time from the event stream
- Replaces the scattered trust signals currently spread across shell-bar, status strip, and chat internals

### 5. Retire the three-nav-band model
- Replace with: Persistent strip → single contextual row (pages for current space) → page content
- Two rows maximum between the browser chrome and the work surface

### 6. Component library extraction
- Extract Panel, StatCard, StatusChip, PageGuideCard, DataTable, EventCard, ApprovalCard, CommandPalette into a `@goatcitadel/ui` package
- Define component variants in code, not in CSS class combinations
- Own border-radius, spacing, and color through tokens

---

## J. Your Recommended North Star

GoatCitadel Mission Control should feel like the **control room of a personal AI operating system**.

**What the shell should do**: Provide persistent context about where you are, what model you're using, what needs attention, and how the system is doing — in under 60px of vertical space. The shell should feel like an instrument cluster, not a website header.

**How the product should be organized**: Three modes reflecting three operator postures:
- **Work** (Chat, Cowork, Code, Tasks, Approvals): Everything that requires active human participation
- **Observe** (Activity, Health, Quality): Everything about understanding system behavior  
- **Tune** (Settings, Integrations, Tools, Agents): Everything about configuring the system

**How Chat, Cowork, and Code should differ**:
- **Chat**: Lean. Fast. Full thread column. Minimal chrome. The fastest way to ask and receive.
- **Cowork**: Structured. Multi-pane. Orchestration stages are visible. Progress is trackable. This is for when the task has steps.
- **Code**: Technical. Diff-native. Project-bound. The conversation is secondary to the code. This is for when the output is files, not text.

**How trust and state should show up**: As a persistent, compact status line that's always true. Model, provider, connection state, pending approvals, active agents — visible at a glance, not buried in settings panels or popovers. Trust should be ambient, not interrogative.

**How the visual system should behave**: One token-driven color system. One border-radius vocabulary (4 values max). One shadow vocabulary (3 levels). One typography scale. The atmosphere comes from the gradients, the grid mesh, and the accent bars — not from 300 individual `rgba()` values.

---

## K. New Product Shell Proposal

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 🐐 GoatCitadel   [Work ▾]  Chat  Cowork  Code  Tasks  Approvals      │
│                                                           ⌨ Cmd+K  🔔 3│
├─────────────────────────────────────────────────────────────────────────┤
│ 🟢 Live · glm-5 via glm · default workspace · 2 approvals pending    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                        [PAGE CONTENT]                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Row 1 (48px): Persistent navigation strip**
- Brand mark (compact, not full wordmark)
- Space switcher (dropdown: Work / Observe / Tune)
- Surface/page tabs (inline, flat, change per space)
- Right: Command palette trigger + approvals badge

**Row 2 (28px): Trust HUD strip**
- Connection state (live/reconnecting/offline)
- Active model + provider
- Active workspace
- Pending approvals count
- Active agent count
- This row is the product's "instrument cluster"

**Total shell overhead: ~76px** (vs current ~295px on Operate)

---

## L. Recommended IA Proposal

### Top-Level: Work / Observe / Tune

**Work** (formerly Operate)
- Chat
- Cowork
- Code
- Tasks
- Approvals

**Observe**
- Activity (merge current Activity + Sessions into one timeline view)
- Health (merge current Costs + System into one dashboard)
- Quality (Prompt Lab — keep as-is, it's already strong)

**Tune** (formerly Configure)
- General (merge current Settings > General + Providers + Access + Budget)
- Runtime (Settings > Runtime + Mesh + LlamaCpp + NPU)
- Workspaces
- Integrations (merge current Integrations > Overview + Channels + MCP)
- Tools
- Agents (merge current Agents > Overview + Herd Live + Herd Lab + Skills into tabbed sub-view)

**Why this is better:**
- "Work" / "Observe" / "Tune" are more active and distinct than "Operate" / "Observe" / "Configure"
- Observe drops from 6 pages to 3 by merging related surfaces
- Tune consolidates the Settings mega-tab (8 tabs → 3 groups) and absorbs the sub-tab sprawl in Integrations and Agents
- Fewer total pages: 13 → 11, with significantly less tab nesting

---

## M. Visual Direction Proposal

### Palette Strategy
- Token-driven. Every color consumed through custom properties.
- Signal-noir: Deep blue-black surface scale with cyan/ember/crimson/green accents
- Citadel-light: Desaturated teal-grey surface scale with deep teal/amber/rose/green accents
- Both themes share the same accent hue families, just adapted for contrast context

### Background/Surface Hierarchy (Signal Noir)
```
--gc-surface-app:       #060810     /* deepest background */
--gc-surface-1:         #0c1420     /* primary panels */
--gc-surface-2:         #101c2a     /* secondary/elevated panels */
--gc-surface-inset:     #080c14     /* inputs, code blocks */
--gc-surface-elevated:  #142030     /* popovers, modals */
```

### Border Vocabulary
```
--gc-border-subtle:  rgba(92, 198, 223, 0.10)
--gc-border-default: rgba(92, 198, 223, 0.18)
--gc-border-strong:  rgba(92, 198, 223, 0.36)
```

### Border-Radius Vocabulary
```
--gc-radius-sm:  6px    /* chips, small buttons */
--gc-radius-md:  12px   /* panels, cards, inputs */
--gc-radius-lg:  18px   /* large panels, sheets */
--gc-radius-xl:  24px   /* full-page cards, modals */
--gc-radius-pill: 999px /* pills, status chips */
```

### Typography
- Preserve Rajdhani for display/headings (it's distinctive)
- Use Inter for body text consistently (tokens.css already declares this but legacy-base overrides with Aptos)
- JetBrains Mono for code/mono

### Density
- Keep the current `--density-scale` system but add `data-density` modifiers to more components

### Motion Philosophy
- Preserve the signal-noir sweep animation and pulse dot
- Add: 120ms ease for interactive state changes, 200ms for layout transitions
- Keep `prefers-reduced-motion` respect (already present)

### What to Preserve
- Cyan-ember gradient bar on panels (the brand's visual fingerprint)
- Grid mesh overlay on signal-noir (at current low opacity)
- `clip-path` notch on topbar and page headers
- Dark glass panel aesthetic with `backdrop-filter: blur`

### What to Retire
- legacy-base.css global styles
- obsidian-legacy.css entirely
- shell.css theme-scoped overrides (move into theme files)
- All inline `rgba()` color values → replace with tokens
- The `color-mix()` kicker color → replace with a single `--gc-text-kicker` token

---

## N. Trust UX Proposal

### Trust HUD (Persistent Strip)
Always visible, 28px, below the navigation strip:

```
🟢 Live  ·  glm-5 via glm  ·  default workspace  ·  ⚠ 2 approvals  ·  🤖 3 agents active
```

### Surface-Level Trust Signals

**Chat/Cowork/Code**: Show the active model and provider in the composer area. When streaming, show a live indicator with token count.

**Approvals**: Show risk level prominently. Show the requesting session/task. Show who/what is waiting.

**Tasks**: Show the linked session for each task. Show the status of the last agent action.

### System State Freshness

Replace the current stale/live binary with a three-state indicator:
- 🟢 **Live**: Event stream connected, data fresh
- 🟡 **Delayed**: Event stream connected but data older than 30s
- 🔴 **Offline**: Event stream disconnected

Show this in the Trust HUD and in the status strip (if expanded).

---

## O. Frontend-System Implications

### Token Changes
- Create `tokens/colors.css` (~80 tokens)
- Create `tokens/borders.css` (~6 tokens)
- Create `tokens/radii.css` (~5 tokens)
- Create `tokens/shadows.css` (~3 tokens)
- Current `tokens.css` spacing tokens are fine; keep them

### Component-System Changes
- Extract core components into explicit React components with typed variant props
- Components: `Panel`, `StatCard`, `StatusChip`, `EventCard`, `ApprovalCard`, `DataTable`, `PageHeader`, `SectionHeader`, `TrustHUD`, `ShellStrip`
- Each component owns its own CSS module or uses tokens exclusively

### Theme Architecture Changes
- Theme files become 100-200 line custom-property-only definitions
- No selector-scoped overrides in theme files — only variable assignments
- Move all structural CSS into component CSS or a single `components.css`

### CSS Cleanup
- Delete `obsidian-legacy.css` (94KB)
- Migrate `legacy-base.css` globals into scoped component styles, then delete
- Reduce `shell.css` by moving theme overrides into theme files
- Reduce `surfaces.css` by moving theme overrides into theme files
- Target: Total CSS under 100KB (currently 460KB+)

### Shell/Page Ownership Changes
- Shell owns: navigation strip, trust HUD, notification region
- Pages own: everything below the trust HUD
- Pages no longer repeat space/page context that the shell already shows

### Legacy Styles to Retire
1. `legacy-base.css` (115KB)
2. `obsidian-legacy.css` (94KB)
3. Theme-scoped overrides in `shell.css` (move to theme files)
4. `surfaces.css` theme-scoped overrides (move to `chat-surface.css` per-theme sections)

### Migration Friction Points
- legacy-base.css `button` globals affect every button in the product. Migration requires auditing every button to ensure theme styles cover what the globals currently provide.
- `.card` class from legacy-base conflicts with panel component. Need to audit all `.card` usage.
- `obsidian-legacy.css` may still be imported by the sidebar/old-layout path — need to verify no code paths depend on it.

---

## P. Prioritized Action Plan

### Quick Wins (1-2 days each)

| # | Problem | Change | Why It Matters | Impact | Effort | Risk | Category |
|---|---------|--------|----------------|--------|--------|------|----------|
| 1 | Page headers repeat shell context | Remove "OPERATE" / "OBSERVE" eyebrow from PageHeader when inside shell layout | Recover 30-40px vertical space | Medium | Low | Low | UX |
| 2 | Status strip always visible | Default to collapsed on Chat/Cowork/Code; one-click expand | Recover ~120px on work surfaces | High | Low | Low | UX |
| 3 | Chat empty state is barren | Add suggested actions, current model badge, workspace summary | Better first impression | High | Low | Low | UX |
| 4 | Border-radius inconsistency | Define 4 canonical radius tokens, find-replace across CSS | Visual coherence | Medium | Low | Low | Visual polish |
| 5 | Font-family override conflict | Remove `--font-body` override in legacy-base.css `:root` | Consistent typography | Medium | Low | Low | Visual polish |

### Medium Refactors (3-7 days each)

| # | Problem | Change | Why It Matters | Impact | Effort | Risk | Category |
|---|---------|--------|----------------|--------|--------|------|----------|
| 6 | No color token system | Extract ~20 canonical tokens, replace inline rgba() in signal-noir | Enables systematic theming | Critical | Medium | Medium | Frontend architecture |
| 7 | Activity feed shows raw JSON | Build EventCard component with type/source/timestamp/summary | Trust/transparency UX | High | Medium | Low | Component system |
| 8 | Shell header is 130px tall | Redesign as 48px strip + 28px trust HUD | Vertical space recovery | High | Medium | Medium | UX/IA |
| 9 | Three nav band styles | Unify pill-button styles into single `.gc-nav-pill` component | Visual consistency | Medium | Medium | Low | Component system |
| 10 | Settings looks like different product | Apply panel/card vocabulary to settings forms | Visual cohesion | Medium | Medium | Low | Visual polish |

### Larger Structural Work (2-4 weeks each)

| # | Problem | Change | Why It Matters | Impact | Effort | Risk | Category |
|---|---------|--------|----------------|--------|--------|------|----------|
| 11 | legacy-base.css global styles | Migrate to scoped components, delete legacy-base.css | Root-cause fix for style conflicts | Critical | High | High | Frontend architecture |
| 12 | Cowork/Code not differentiated | Design distinct layouts for each surface mode | Core product promise | Critical | High | Medium | UX/IA |
| 13 | citadel-light is a correction layer | Rebuild as token-driven light theme from scratch | Real light theme support | High | High | Medium | Frontend architecture |
| 14 | obsidian-legacy.css still exists | Audit, confirm no dependencies, delete | 94KB dead weight | Medium | Medium | Medium | Frontend architecture |
| 15 | Token architecture debt | Full Citadel DS token system (colors, borders, radii, shadows, type) | Foundation for all future work | Critical | High | Low | Frontend architecture |

---

## Q. The Minimum Viable Frontend Pass

If we could only afford one meaningful pass before a broader redesign:

### Do exactly these things:

1. **Create `tokens/colors.css`** with ~20 semantic color tokens extracted from signal-noir's most-used values. Do not rename or redesign — just capture what exists into tokens.

2. **Replace the 50 most-used inline `rgba()` values in signal-noir.css** with the new tokens. Don't touch citadel-light yet.

3. **Collapse the status strip by default on Chat/Cowork/Code**. One-click expand. The collapsed summary already exists in CSS.

4. **Remove the page-header eyebrow** ("OPERATE", "OBSERVE", "CONFIGURE") on all pages. The shell already shows this.

5. **Build a basic EventCard component** for the Activity live feed. Show: event type, source, timestamp, one-line summary. Keep "show raw JSON" as an expandable detail.

6. **Add current model/provider badge** to the chat composer area.

7. **Fix the font-family conflict** between legacy-base.css (Aptos) and tokens.css (Inter). Inter should win everywhere.

**Total effort: ~2 weeks for one engineer.**
**Impact: The product feels 40% more polished and 60% more cohesive without any structural changes.**

---

## R. The First Big Swing

**Make Cowork genuinely different from Chat.**

This is the single move that would most change GoatCitadel's trajectory, because Cowork is the product's core differentiator. Every AI product has chat. Very few have "structured multi-step orchestration with visible state, checkpoints, and human-in-the-loop control." But right now, Cowork *looks and feels* exactly like Chat with a different header subtitle.

**The swing:**
Build a split-pane Cowork layout where:
- **Left column**: Orchestration stage list (step 1, step 2, ...) with status indicators and a compact conversation view
- **Center**: Active step detail — what's being done, what tools are being called, what output is being generated
- **Right**: Artifact/context inspector — files produced, memory accessed, delegation status

When a user switches from Chat to Cowork, the layout should physically change. The arrangement of panels should communicate: "this is a different way of working." Not a label change — a mode shift that you can see and feel.

**Why this matters more than anything else:**
Cowork is GoatCitadel's answer to the "stolen spaceship with the manual on fire" problem. If it just looks like another chat window, the product has no way to communicate that it offers something genuinely different. The visual differentiation IS the product strategy made manifest.

**Effort: 3-4 weeks.**
**Impact: Transforms GoatCitadel from "an AI chat with extra pages" to "a multi-mode AI workspace."**
