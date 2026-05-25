# Memory + Projects + Prompt Packs — fresh review

**Date:** 2026-05-24
**Reviewer:** subagent walk
**Files:** MemoryRoutePage.tsx (986 lines, brief said 973), ProjectsRoutePage.tsx (832 lines, brief said 798), PromptPacksWorkbenchPage.tsx (2605 lines, brief said 2506)

> Note: all three source files are larger than the brief's stated sizes; counts above are the actual `wc -l` numbers. Findings still hold.

## Verdict

**Memory** — **Ship with known debt.** The mockup's two best ideas (namespace pills as primary filter, maintenance verbs in a dedicated footer strip) are absent; the page leans on a one-line search and buries Run-maintenance two viewports down. But the core job (read/search/edit a memory) works, lifecycle truth is honest, and the recent `StatusChip` adoption (`MemoryRoutePage.tsx:188-247`) tames the worst of the chip jungle. Ship-blocker: **zero ARIA on a 986-line page**, including the selectable list (`mc-next-approvals-list-item`) and the edit form. Add `aria-current`/`role="tablist"`/`htmlFor` then ship.

**Projects** — **Ship-blocker present.** The mockup contract is "containers with mode-mix at a glance, recent threads across all projects, pin/archive filtering" and the live page delivers cards-with-ModeBar (good) plus a dense project-control panel (over-eager). It is **missing the entire Pinned tab + Pinned/Archived counts** the mockup leads with (`projects.html:253-256`), missing the **cross-project Recents row** (`projects.html:389-419`), missing the **filter-by-tag affordance**, missing pin/unpin UI on the cards, and the New Chat / New Cowork / New Code triple-action header buttons render but without the area-color swatches that make them legible as one button group. The card-grid IS responsive; the right-rail "Project controls" is the wrong shape — three stacked control-panel sections instead of inline pin/archive on the card itself. Action: add pin filter + Recents row + per-card pin button before ship.

**Prompt Packs** — **Ship-with-known-debt and a code-health debt seam.** The 2605-line workbench file ships, but it ships a 5-tab detail surface that does the job (Prompt/Output/Assessment/Review/Insights), keyboard-OK filter chips, an `AssessmentThresholdBar` that closes the mockup's "prove the pack is below threshold" promise, and a sane "Run next / Run all / Auto-score" hero row. The mockup's biggest visual idea — **inline variable chips inside the prompt editor with syntax highlighting** (`prompt-packs.html:496-523`) — is unrealized (live shows `<pre>{selectedTest.prompt}</pre>`, flat mono text). The 2605-line file is the file-organization risk; cut lines below. Ship after `EmptyState` adoption and a small ARIA pass.

---

## Memory

### Top issues (ranked)

1. **Zero ARIA on 986 lines** (HIGH — a11y blocker). Memory has *no* `aria-*` or `role=` attributes anywhere (`Grep aria-label|role=|aria-selected|aria-pressed|aria-controls|aria-live` returns 0 matches). The selectable list of memory items (`MemoryRoutePage.tsx:223-253`) is `<button>` elements without `aria-pressed`/`aria-current` so screen readers can't tell the user which item they're editing; the form below (`:284-326`) has `<label>`/`<input>` pairs without `htmlFor`/`id` and the editing-disabled state (`disabled={!memoryCanMutate}`) is communicated only by greyed-out controls.
2. **Namespace pills missing — the mockup's primary IA cue** (HIGH — mockup-vs-live gap). Mockup `memory.html:337-343` leads the rail with `all 37 / knowledge 22 / routing 14 / files 2 / scratch 9` pills as the primary filter. Live (`MemoryRoutePage.tsx:177-186`) has a single full-text search box and zero namespace UI; the user can search "scratch" to filter but the cardinality (and the existence of namespaces as a concept) is invisible.
3. **Maintenance verbs buried two viewports down, and only one verb instead of three** (HIGH — mockup-vs-live gap). Mockup `memory.html:430-449` puts Flush / Optimize / Verify in a 3-button strip at the bottom of the rail — visible at all times. Live (`MemoryRoutePage.tsx:660-682`) hides "Run maintenance now" inside the Maintenance posture card in the *third* NativeGrid section, and renders no Flush/Verify equivalents anywhere. The mockup's data-critique callout ("Maintenance is *not* a primary verb") is the opposite of what live ships.
4. **Editor area is two NativeCards stacked instead of a unified editor stage** (MEDIUM — visual hierarchy). Mockup `memory.html:497-606` puts the item editor + subspaces sidebar + audit log in one `editor-body` with a unifying `editor-head`. Live nests editor and "Evidence and write gate" as peer NativeCards in NativeGrid (`MemoryRoutePage.tsx:166-433`), losing the editor-as-stage hierarchy.
5. **`EmptyState` primitive exists but Memory uses six different ad-hoc empties** (MEDIUM — consistency). `MemoryRoutePage.tsx:214-220, 370, 414-416, 487, 519, 558, 700-707, 825, 865-866, 887-888` all use `<p className="mc-next-directory-empty">` with bespoke copy. The new `EmptyState` primitive (`EmptyState.tsx`) supports icon + title + description + actions and is unused here.

### Findings by lens

#### First impression

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Page opens as a four-card vertical stack (items / detail / evidence) with no rail or namespace cue | HIGH | `MemoryRoutePage.tsx:167-433` `<NativeGrid className="mc-next-memory-shell">` wraps a 3-card row. Mockup `memory.html:328` uses `display:grid; grid-template-columns: 320px minmax(0,1fr)` with a stable 320px rail. | The user lands on a wall of equal-weight cards. The mockup's rail-vs-stage hierarchy is gone. |
| Eyebrow / title / description live in NativePageFrame; no breadcrumb crumbs | MEDIUM | `MemoryRoutePage.tsx:146-158` (NativePageFrame). Mockup `memory.html:455-460` shows `knowledge / routing / haiku-fallback heuristic` crumbs that update as the user picks an item. | Reviewers lose the "where am I in the namespace tree" affordance that's the only spatial sense Memory has. |
| Two notice banners at top (`memory.notice` + `sectionErrors.settings`) before any content | LOW | `MemoryRoutePage.tsx:159-166`. | Acceptable but pushes content down on first paint. |

#### Usability

| Finding | Severity | Location | Recommendation |
|---|---|---|---|
| Editing a memory item with no namespace UI: user can read namespace but can't move an item between namespaces | MEDIUM | `MemoryRoutePage.tsx:284-326` — the form exposes Title, TTL override, Pinned, Content; no namespace input. Mockup `memory.html:509-511` includes a namespace field. | Add a namespace input or namespace selector (with autocomplete from known namespaces) to the form. |
| Save / Forget actions side-by-side with identical primary button styling, only `gc-button danger` differentiates | MEDIUM | `MemoryRoutePage.tsx:329-353`. The danger class lives in legacy `gc-button` styling rather than the next-app's button system. | Use `mc-next-button-danger` consistently. (Already a ship-bar HIGH category — destructive distinction.) |
| `Save item` requires user to manually re-press after edit; no auto-save, no dirty indicator | HIGH | `MemoryRoutePage.tsx:329-345`. Local `draft` state is held in a `useState` (`:43-48`); never compared back to `memory.selectedItem` for a "Dirty" pill. F-204 says "no data loss on tab switch" — this passes that bar narrowly because `useEffect (:59-76)` resets the draft on item change, but a user editing item A and clicking item B silently loses A's edits. | Add a "Unsaved changes" pill and a confirm-before-switch guard. Same pattern flagged in the Settings fresh review. |
| Edits to a memory require `memoryCanMutate` (true only when `memoryAdminState === "enabled"`); when disabled, inputs are silently disabled with no tooltip explaining why | MEDIUM | `:96-97, 290, 311, 323`. | When `disabled={!memoryCanMutate}`, render an inline `SectionTruthNotice` next to the form saying "Memory admin is `disabled`/`unknown` — enable in Settings to edit." |
| Item History list shows only the last 10 entries with no "show all" or pagination | LOW | `MemoryRoutePage.tsx:355-372`. | Acceptable; add a "show more" affordance when length > 10. |
| Forgetting an item: no confirm dialog, no undo | HIGH | `MemoryRoutePage.tsx:347-353` — `onClick={() => void memory.forgetSelectedItem()}` fires immediately. | This is a destructive action; mandate inline `Confirm` or two-step "press again within 3s". |
| Provenance panel renders 13 rows even when most are "not attached" | MEDIUM | `MemoryRoutePage.tsx:945-957`. Most metadata strings default to "not attached" so the panel becomes a "mostly empty" wall. | Collapse the not-attached rows by default; show a `Show all 13 attributes` toggle. |
| Decision journal `<DecisionJournalFacts>` renders all 7 facts regardless of value (`outcome: "not reviewed yet"`, `assumptions: rationale fallback`) | LOW | `:907-933`. | Skip rows whose value equals the literal "not recorded"/"not attached" defaults, or visually demote them. |

#### Visual hierarchy

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Six NativeCards in three NativeGrids — flat hierarchy | HIGH | `MemoryRoutePage.tsx:167-902` — Grid 1 (items/detail/evidence), Grid 2 (provenance/entities/relations/decisions), Grid 3 (maintenance/runs/qmd/files/quickjump). Mockup uses one editor stage + a sidebar. | The page reads as "all topics equally important". Visiting a memory item shouldn't put QMD stats in the same visual weight as the item itself. |
| Detail card title falls back to "Memory detail" when nothing selected, and the empty state is just "Select a memory item to inspect it." | LOW | `:257, 374-375`. | Use `EmptyState` with an icon, a title ("No memory selected"), and a description directing the user to the items list on the left. |
| `mc-next-runtime-metric-grid` reused for memory metrics (Lifecycle / Expires / Item ID) | LOW | `:266-282`. | Acceptable — at least it's a shared primitive; just nit-pick that the strip lives inside the detail card, not at the top as a summary strip per the mockup `memory.html:474-495`. |
| Audit log structured as `<li><strong>{decision}</strong> · timestamp · hash</li>` flat list | MEDIUM | `:399-411`. Mockup `memory.html:597-602` shows a 2-column `ts / msg` grid with `kind` color-coded. | The mockup's layout is much more scannable for a log; the flat list with ` · ` separators is hard to parse on a long page. |

#### Consistency

| Element | Status | Notes |
|---|---|---|
| `StatusChip` adoption | **Migrated** — `MemoryRoutePage.tsx:188-247, 387-396` use `StatusChip` with tones `success`/`warning`/`muted`/`default`. The Active/Expired/Forgotten/Admin chip row at `:187-202` is the canonical use case from the brief. | Good. |
| `EmptyState` adoption | **Not migrated** — 10+ ad-hoc `<p className="mc-next-directory-empty">{label}</p>` callsites. | Migrate. |
| `ModeBar` | N/A here. | — |
| `ThreePartChip` | Not used. Memory has no live-aging signals (e.g. "last verified 13:42 · 18m ago" from the mockup, `memory.html:432-433`) where the 3-part chip would shine. | Acceptable but a missed opportunity for the maintenance footer. |
| `StageHeader` | Wrapped by `NativePageFrame` (`NativeRoutePageLayout.tsx`) which delegates. Acceptable. | — |
| Buttons | Mixes `gc-button`, `gc-button danger`, `gc-button subtle`, `mc-next-button*` family. | The `gc-button` class is legacy (mission-control-shared) and should not be used in this page — it's pulling in styles from a different design system. |
| Tokens vs hardcoded values | All metric/empty styling goes through `mc-next-*` classes; spot-check shows no hardcoded hex. | Token-clean. |

#### Accessibility

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Zero `aria-*` or `role=` in 986 lines | HIGH | All of `MemoryRoutePage.tsx`. | Screen-reader users can't tell what's selectable, what's selected, what's editable, what's loading. |
| Selectable item list (`mc-next-approvals-list-item`) lacks `aria-pressed` / `aria-current` | HIGH | `MemoryRoutePage.tsx:224-228`. | Selecting an item changes the right-pane form silently; no SR announcement. |
| Form labels associate visually (`<label className="mc-next-settings-field">…<span>Title</span><input/>`) but inputs have no explicit `id` + `htmlFor` | MEDIUM | `:284-326`. | VoiceOver may read placeholder instead of label. Same finding as Settings review. |
| No `aria-live` on `memory.notice` banner or `SectionTruthNotice` | MEDIUM | `:159-163, 976-985`. The banner appears on data-fetch errors and write outcomes. | Errors and recoveries are silent to screen readers. |
| `RefreshCw` and `ShieldCheck` icons inside buttons have no decorative `aria-hidden` | LOW | `:429, 679`. | The lucide icons render `<svg>` without `aria-hidden`, so SR users hear the SVG name. |
| Edit-disabled state communicated only by `disabled` attribute | MEDIUM | `:290, 299, 311, 323`. | `disabled` does set a11y state correctly, but the *why* (memory admin disabled) is not announced. Add `aria-describedby` pointing at the section truth notice. |

### Mockup-vs-live gap

| Mockup promise | Mockup ref | Live state |
|---|---|---|
| Namespace pills as primary filter (all / knowledge / routing / files / scratch) | `memory.html:337-343` | Absent — search input only |
| Maintenance footer strip with Flush / Optimize / Verify | `memory.html:430-449` | One "Run maintenance now" button buried in third grid section |
| Editor stage with breadcrumb + summary-strip + editor body + side cards | `memory.html:452-606` | Six equal NativeCards in three grids |
| Toggle controls (Pinned / Citable in answers / Auto-approve writes) inline on item | `memory.html:520-531` | Only Pinned (as `<select>`); no Citable, no Auto-approve toggles |
| Audit log as 2-column `ts/msg` grid with color-coded `kind` | `memory.html:594-603` | Flat `<li>` list of write envelopes only |
| Subspaces side card showing namespace + items + size + dot status | `memory.html:542-589` | Absent — closest is `summarizeMemorySubspaces` used for `fileAreas` in the bottom QMD section |
| Status strip at footer (memory enabled / 37 items / 512 KB / last verified) | `memory.html:611-617` | Absent |
| Search placeholder copy "Search title, ns, content…" with full search semantics | `memory.html:335` | Live placeholder is "Namespace, title, or content" (close); filter logic at `:78-90` matches. |
| Item rows showing pin glyph + 2-line preview + 3 meta tokens (ns / ttl / size) | `memory.html:349-373` | Live shows title + updatedAt + lifecycle/pinned chips + namespace. Missing: preview snippet, TTL countdown, byte size. |

**Live features not in mockup that should arguably stay:**
- Decision journal with retrospective workflow (`:524-561, 907-933`).
- Provenance coverage grid (`:436-460`) — the closest mockup analog is "Subspaces" which is structurally different.
- QMD context posture card (`:832-867`) — useful operator data the mockup didn't anticipate.
- Memory entities + relations cards (`:461-522`) — load-bearing for the typed-memory contract.

**Gap summary:** medium-large. The mockup's structural promise (320px rail with namespace pills + maintenance footer, plus a unified editor stage on the right) is not delivered; live ships a 6-card grid that's information-rich but rhythmically flat. The structural change is large but mechanical — refactor `MemoryRoutePage` to render a `<MemoryRail>` + `<MemoryEditorStage>` layout.

### Primitive adoption

| Primitive | Used? | Where |
|---|---|---|
| `StatusChip` | **Yes** | `MemoryRoutePage.tsx:188-247, 387-396` — chip rows for lifecycle, pinned, evidence signature status |
| `EmptyState` | **No** | 10+ ad-hoc `mc-next-directory-empty` usages |
| `ThreePartChip` | No | Not used; maintenance footer (mockup) is the natural use |
| `ContextStrip` | No | N/A |
| `ModeBar` | No | N/A |
| `StageHeader` | Indirect (via `NativePageFrame`) | Acceptable |

### What works well

1. **Lifecycle truth is honest** — chip row at `:187-202` shows Active/Expired/Forgotten counts with consistent tones; admin state surfaces as a fourth chip. The `memoryAdminTruthUnknown` branch (`:96-97`) properly degrades the UI when settings truth is unavailable.
2. **Recent `StatusChip` migration is clean** — 30 chip usages across the file all funnel through the primitive, no rogue inline chip CSS.
3. **`SectionTruthNotice` partial-failure pattern** — local helper at `:976-985` lets every card declare its own failure surface independently. When `sectionErrors?.memoryEntities` is set, only the entities card warns; the rest of the page stays usable. Excellent partial-fail discipline.
4. **Decision journal with reversibility + assumptions + outcome** — `DecisionJournalFacts` at `:907-933` ships a real decision-record concept (chosen path, options, assumptions, confidence, reversibility, follow-up, outcome) — this is structurally ambitious and well past what Notion's linked-DBs offer.
5. **Provenance coverage as a typed grid** — `:436-460` renders 4–5 provenance types (entities/relations/decisions/items/evidence) with record counts and detail. Closer to Obsidian's graph-view-as-metadata than a flat tag cloud.

---

## Projects

### Top issues (ranked)

1. **No pin/unpin UI, no Pinned filter, no Archived filter** (HIGH — mockup-vs-live gap, functionality). Mockup `projects.html:253-256` leads with `All 6 / Pinned 2 / Active 4 / Archived 11` tabs and shows pin SVG glyphs on every card header. Live (`ProjectsRoutePage.tsx:380-409`) renders project cards with no pin glyph, no pin action button, and no filter tabs at all. `Grep "Pinned"` returns zero matches. Pin/Archive are first-class concepts in the mockup; live treats them as if they don't exist (archive lives only as a button in the Project controls right-rail at `:570-578`).
2. **No cross-project "Recent sessions" row** (HIGH — mockup-vs-live gap). Mockup `projects.html:389-419` shows a "Pick up where you left off" row of 4 cards spanning all projects — explicitly designed to cross project boundaries. Live shows a per-project `Recent work` section (`:683-701`) inside the selected-project's NativeCard. The brand point (recent activity matters more than which project it belongs to) is lost.
3. **Project Controls right-rail is the wrong shape** (HIGH — visual hierarchy). Live (`:477-582`) places a third NativeCard with "Create / Edit / Archive" stacked forms occupying ~30% of the page. Mockup integrates these as: pin glyph on card, archive in card menu (implicit), new-project as a top-bar action. The live design conflates "the registry of projects" with "the CRUD editor for the active project" and the editor wins the layout.
4. **Triple-action header buttons render without area-color swatches** (MEDIUM — brand-spec gap). Mockup `projects.html:229-242` styles `New chat / New cowork / New code` with chat-blue / cowork-magenta / code-teal background washes that read as one button group. Live renders `NewSessionButton` (`:776-800`) with `data-mode={mode}` and a `mc-next-new-session-button-swatch` span, but no inspection of the CSS confirms whether the swatches actually get the area tints. The header reads "Project containers" with three plain buttons.
5. **Stage hero text card from mockup is absent** (MEDIUM — first impression). Mockup `projects.html:222-244` has a featured `stage-head-card` with eyebrow + "Six projects. Twenty-two live sessions." + sub-paragraph + triple-action cluster. Live's NativePageFrame title is the plain "Project containers" with description `Cross-surface project threads for ${activeWorkspaceName}.` The brand-positioning hero is missing.

### Findings by lens

#### First impression

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Page opens as 3 NativeCards (Projects / Project detail / Project controls) with no hero | HIGH | `ProjectsRoutePage.tsx:359-583` `<NativeGrid className="mc-next-native-projects-grid">`. Mockup leads with a `stage-head-card` then a 6-card grid then a recents row. | First glance reads as admin / settings, not "projects". |
| Project list is a vertical `mc-next-settings-selectable-list` with 280px max width feel | HIGH | `:376-409` uses `is-compact is-scrollable` with `maxHeight: min(62vh, 38rem)`. Mockup `projects.html:262-386` uses `project-grid: repeat(auto-fill, minmax(280px, 1fr))` — a responsive card grid. | The mockup's "Six projects" reads as a peer set; live's vertical list with ModeBar reads as a leaderboard. |
| `ModeBar` does render per-project (good) but no totals row above | LOW | `:397, 398-402`. | Mockup also shows aggregate "14 chat · 5 cowork · 3 code" in the status strip; live shows nothing equivalent. |

#### Usability

| Finding | Severity | Location | Recommendation |
|---|---|---|---|
| Can't pin a project from anywhere in the UI | HIGH | `ProjectsRoutePage.tsx` — no `pin`/`unpin` action or visual. | Add a pin icon button on each card header; persist as `ChatProjectRecord.pinned` (if not in contract, add). |
| Can't filter to pinned or archived | HIGH | No filter tabs. | Add `tabs` row matching mockup `projects.html:251-256`. |
| Selecting a project navigates via `navigate(…)` (URL change) — good — but the "select" target is the whole list item, no preview / no peek | MEDIUM | `:384-404`. | Acceptable; mockup also requires whole-card click but adds quick "+ Chat / + Cowork / + Code" affordances per card (`projects.html:278-282`). Live has only the heavy `Project controls` rail. |
| `handleNewSession` creates a session with title `${labelForMode(mode)} - ${selectedProject.name}` | LOW | `:194-224`. | Acceptable; the mockup doesn't show how titling works. |
| `handleArchiveProject` removes from list AND navigates away — no undo | HIGH | `:308-329`. | Add an undo toast (5s "Project archived. Undo" pattern). Same issue flagged in Settings review for `window.confirm()`. |
| `handleCreateProject` requires Name + Workspace path; workspace path validation is "non-empty trim" only | MEDIUM | `:243-273`. | Validate the path exists on disk (gateway call) or warn that the path will be created. |
| Continuation flow: `Continue Chat/Cowork/Code` buttons branch to existing session or create new based on `latestByMode[mode]` | MEDIUM | `ProjectHomeBasePanel:634-641, 226-241`. | Good UX, but the button labels switch between "Continue Chat" / "Start Chat" without explanation. Add a subtitle showing the last session timestamp when "Continue". |
| Project home metrics (Active threads / Artifacts / Approvals / Last activity) live in a 4-card metric strip | LOW | `:611-632`. | Acceptable; mockup's stage-head-card doesn't have this. |
| `Recent work` shows only project's own threads, with `formatDateTime + artifact count` | MEDIUM | `:683-701`. | Add a parallel cross-project "Recent sessions" lane per mockup. |
| Project controls right-rail Create form Submit button labelled "Creating..." mid-flight | LOW | `:518-525`. | Add a `<LoaderCircle>` spinner; otherwise the label change is hard to see. |

#### Visual hierarchy

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Three columns of NativeCards visually balanced — no hierarchy between list / detail / controls | HIGH | `:359-583`. Mockup pushes controls into the cards themselves and elevates the hero. | The page is "wide and flat"; the user can't tell which card is the action. |
| `ProjectHomeBasePanel` is well-structured (overview / metrics / continue / latest continuation / readiness / recent / open-memory-and-artifacts) but lives inside the project detail card | MEDIUM | `:588-712`. | Beautiful internal hierarchy. Just trapped inside a card; could be the page's hero. |
| `mc-next-project-readiness-list` uses `is-${item.status}` tones (`ready` / non-ready) with CheckCircle/CircleAlert icons | NIT (positive) | `:671-681`. | Excellent — semantic tone + icon + readable copy. |
| Per-project session lanes (Chat / Cowork / Code) render as three `mc-next-directory-lane` sections | MEDIUM | `:463-474, 725-774`. | Good structure, but with the project-detail card already heavy, this stacks below the fold. Consider tabs. |
| Project counts row `Chat 7 · Cowork 3 · Code 2` rendered as text below the ModeBar | LOW | `:398-402`. | Mockup uses count *inside* each `seg` of the ModeBar (`projects.html:274-276`); live has both — redundant. |

#### Consistency

| Element | Status | Notes |
|---|---|---|
| `StatusChip` adoption | **No** — Projects has no chip rows. The mockup uses `chip warning` ("investigating") and `chip muted` ("draft") on cards. | Adopt for project state markers like archived / paused / draft when project lifecycle status exists. |
| `EmptyState` adoption | **No** — `<p className="mc-next-directory-empty">` at `:407, 699, 770`. | Migrate. |
| `ModeBar` adoption | **Yes** — `:397`. | Good. |
| `ThreePartChip` | Not used. | N/A here. |
| Buttons | `mc-next-button` (primary), `mc-next-settings-filter` (secondary), `mc-next-new-session-button` (data-mode swatches). | Coherent. The `mc-next-settings-filter` reuse is a code smell — these are Project controls, not settings filters. |
| Tokens vs hardcoded | All routes via class names; no hex spotted. | Token-clean. |
| Loading state | `loading` handled by NativePageFrame; per-action `projectActionBusy` string. | OK. |

#### Accessibility

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Only 2 `aria-label` attrs in 832 lines | HIGH | `:602, 648`. | Project list selectable items have no `aria-pressed` / `aria-current="page"`; continue buttons have no `aria-describedby` for the timestamp. |
| `mc-next-settings-selectable` buttons in project list don't announce selected state | HIGH | `:386-403`. | Same pattern as Settings: button class flips between base and `.active` visually but a11y is silent. |
| `mc-next-directory-empty` paragraphs not in `role="status"` | MEDIUM | `:407, 699, 770`. | Migrate to `EmptyState` (which sets `role="status"`). |
| Continue button label changes between "Continue Chat" / "Start Chat" with no `aria-live` to announce the change | MEDIUM | `:634-641`. | Add `aria-live="polite"` to the button row or use `aria-label` that includes the action. |
| Form inputs (`Create project Name/Path/Description`) lack explicit `id`/`htmlFor` pairing | MEDIUM | `:490-516`. | Same pattern as Settings — label-wraps-input works visually but is fragile. |
| `NewSessionButton` (`:776-800`) has aria-hidden swatch but no `aria-label` describing "Create new {mode} session in {selectedProject.name}" | MEDIUM | Buttons read as "MessageSquarePlus New chat" with no project context. | Add `aria-label`. |

### Mockup-vs-live gap

| Mockup promise | Mockup ref | Live state |
|---|---|---|
| Stage-head-card hero ("Six projects. Twenty-two live sessions.") + sub-paragraph + triple-action cluster | `projects.html:222-244` | NativePageFrame default header only; triple-action exists but visually plain |
| Tabs: All / Pinned / Active / Archived with counts | `projects.html:251-256` | Absent |
| Search input with placeholder "Filter by project name, owner, or tag…" | `projects.html:246-250` | Absent — no search/filter |
| Sort: activity ▾ control | `projects.html:258` | Absent |
| Pin glyph on each card | `projects.html:268-269, 289` | Absent |
| Chip warning/muted on cards for state ("investigating", "draft") | `projects.html:310, 370` | Absent |
| Per-card mode-bar with chat/cowork/code segments and label inside | `projects.html:273-277` | Present (live ModeBar does this) ✓ |
| Per-card footer: 3 buttons "+ Chat / + Cowork / + Code" with area swatches | `projects.html:278-282` | Absent — live puts these in the project-detail panel (`:449-462`) instead of on the card |
| Recent sessions row "Pick up where you left off — across all projects" | `projects.html:389-419` | Per-project recent only |
| Recent card: mode-pill + title + meta line | `projects.html:398-417` | Per-project version exists (`:687-700`) but doesn't cross projects |
| Status strip at footer (6 projects · 22 sessions · 14 chat · 2 pinned) | `projects.html:424-429` | Absent |

**Live features not in mockup that should arguably stay:**
- `ProjectHomeBasePanel` (`:588-712`) — the readiness list and "Latest continuation" lanes are richer than the mockup. Keep and elevate.
- `Project controls` create/edit/archive form (`:477-582`) — the mockup's pin-and-archive-via-glyph approach doesn't cover Create-new-project; the live form is needed but should move to a modal/sheet triggered by a top-bar `+ New project` button.

**Gap summary:** medium-large. The list-card layout is *invisible* in live (vertical list-with-ModeBar instead of card grid); pinned/archived filtering is *unimplemented*; the cross-project Recents row is *absent*. The Project controls panel is over-eager. The live page has a genuinely good `ProjectHomeBasePanel` trapped inside a card. Refactor: project grid + filter tabs + cross-project Recents + hero card; absorb create/edit/archive into card-level glyphs and a top-bar button.

### Primitive adoption

| Primitive | Used? | Where |
|---|---|---|
| `StatusChip` | **No** | Should chip project state (active/archived/draft/investigating) |
| `EmptyState` | **No** | 3+ ad-hoc empties (`:407, 699, 770`) |
| `ThreePartChip` | No | N/A here |
| `ContextStrip` | No | N/A here |
| `ModeBar` | **Yes** | `:397` |
| `StageHeader` | Indirect via NativePageFrame | OK |

### What works well

1. **`ProjectHomeBasePanel` is genuinely good** — the metric strip + continue row + latest-continuation lanes + readiness list + recent work + open-memory/artifacts shortcuts (`:588-712`) is more thoughtful than Linear's project home. Just trapped in a card.
2. **`ModeBar` per-card** — `:397` correctly shows chat/cowork/code mix at a glance. The visual maps to the brand's "three postures" thesis.
3. **Cross-mode continuation logic** — `handleContinueSession` (`:226-241`) automatically picks the latest session per mode or starts a new one. Good UX, no separate "New" vs "Continue" cognitive load.
4. **Readiness list with semantic tone + icon** — `mc-next-project-readiness-item is-${item.status}` (`:671-681`) with CheckCircle/CircleAlert. Clean.
5. **Diagnostic recording on actions** — `recordRouteAction(...)` on every project lifecycle event (`:210-214, 264-266, 298-300, 320-322`). Operator-truthful.

---

## Prompt Packs

### Top issues (ranked)

1. **Prompt editor is flat `<pre>{selectedTest.prompt}</pre>`; mockup promises inline variable chips + syntax highlight** (HIGH — mockup-vs-live gap, the showcase visual). Mockup `prompt-packs.html:505-523` shows variables (`{{primary_model}}`, `{{outage_seconds}}`) rendered as inline `<span class="var">` chips with accent tints, keyword highlighting (`Given`, `decide`, `Constraints`), and string highlighting. Live `PromptPacksWorkbenchPage.tsx:1730` renders `<pre>{selectedTest.prompt}</pre>` — raw monospace text. The mockup's biggest "this is a workbench" signal is unrealized.
2. **2605-line component file with one default export** (HIGH — code health). Per `wc -l`. Single `PromptPacksWorkbenchPage` body spans `:85-2276` (≈2191 lines for the component alone). The brief flags W4.3 decomposition; cut lines below.
3. **`EmptyState` primitive unused** (MEDIUM — consistency). The mockup's tone is "select a thing to see the next thing"; live has 3 `<div className="mc-pp-empty">` ad-hoc empties (`:1595-1599, 1807-1810, 1988-1992`) plus a `<div className="mc-pp-empty large">` (`:2266-2271`). Migrate.
4. **Filter chips for test result categories: 8 chips wrap to two lines on 1280px** (MEDIUM — visual hierarchy). `FILTER_OPTIONS` at `:2468-2492` defines: All / Paused / Run failed / Score failed / Review / Needs score / Not run / Passing. Mockup `prompt-packs.html:394-399` shows only 4: All / Pass / Fail / Review. Live is more honest (covers more states) but visually noisier.
5. **The hero has 4 action buttons + a refresh; the mockup has 1 primary + 1 metric** (MEDIUM — visual hierarchy). Live `:975-1013` shows Run next / Run all / Auto-score / Refresh. Mockup `prompt-packs.html:351-365` shows a Pass-rate metric + Export + Re-run failures. Different verbs, different posture. Live's verbosity hides the "this pack is below threshold" headline that the mockup makes the page's main fact.

### Findings by lens

#### First impression

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| Hero is action-dense; pass-rate is in summary cards (3rd card of 5) | HIGH | `:1014-1023, 904-945`. Mockup foregrounds pass-rate as a hero metric, not buried among 5 summary cards. | The user lands on "what can I do?" instead of "how is this pack doing?". |
| Loading state is bare `mc-pp-loading-shell` skeleton | LOW | `:952-964`. | Acceptable. |
| Hero kicker switches between "Prompt Packs" (library) and "Quality" (ops variant) | NIT | `:971`. | OK. |
| `AssessmentThresholdBar` renders right under summary row — good | NIT (positive) | `:1025`. | The threshold bar (`:2581-2604`) is a real "is the pack above the line" visual; one of the few unambiguous mockup-promise-kept moments. |

#### Usability

| Finding | Severity | Location | Recommendation |
|---|---|---|---|
| Selecting a test row uses a `role="button"` `tabIndex={0}` outer `<div>` instead of a real `<button>` | HIGH | `:1528-1544`. | The outer is a `<div role="button">` that handles click + keydown; nested `<button>` for "Run". Nesting `<button>` inside `role="button" tabIndex` is invalid. Use a `<button>` for selection and move "Run" to a sibling (already siblings, just split structurally). |
| `Run next` / `Run all` / `Auto-score` / `Refresh` all show LoaderCircle spinning when busy but no announcement | MEDIUM | `:976-1013`. | Wrap status messages in `aria-live="polite"` so SR users know what's running. |
| 5 detail tabs (Prompt / Output / Assessment / Review / Insights) with no keyboard navigation help | MEDIUM | `:1705-1718`. | Tabs implement `role="tab"` + `aria-selected` correctly. Add arrow-key nav between tabs (currently click-only). |
| Reset Pack flow has 2-step confirm (good) but lives inside `details` > `Advanced quality ops` (less good) | MEDIUM | `:1410-1444`. | The destructive action is correctly two-step and labelled danger; the discoverability is poor. Acceptable for now. |
| Auto-score behaviour: clicking "Auto-score" auto-scores *only unscored* runs; not obvious from the label | LOW | `:720-737, 996-1002`. | Label could be "Auto-score unscored (N)" with a count. |
| `Run selected` and the row-level "Run" both fire `runOne(test, "single")` with no busy-state isolation between them | LOW | `:1582-1592, 1625-1637`. | Acceptable; `activeRun.testId` does isolate the spinner. |
| Manual Review (`Review` tab) score buttons are `--/0/1/2/3/4` with `--` meaning "unset" | LOW | `:2037-2059`. | The `--` glyph is ambiguous; use a clear "Clear" affordance with a Trash icon. |
| Notification banners (`mc-pp-alert danger` / `mc-pp-alert success`) appear at the top of the page with no dismiss | MEDIUM | `:1027-1038`. | Auto-dismiss success after N seconds (per r4-ux CC-001 — same ship-blocker). |
| Placeholder values UI requires manual entry for `{{primary_model}}` etc. — no defaults | MEDIUM | `:1764-1790`. | Add defaults from the test record or last-run; user shouldn't re-type "claude-opus-4-7" every benchmark. |
| `Open run thread` and `Copy run link` actions appear/disappear based on `selectedRunLink` | LOW | `:1640-1656`. | Acceptable. |

#### Visual hierarchy

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| 5 summary cards in a strip (Pack / Coverage / Pass rate / Model lane / Execution style) | MEDIUM | `:904-945, 1015-1023`. Mockup uses 4 cards (Tests / Avg latency / Cost per run / Last benchmark) — different metrics. | Live optimises for "what is this pack and what's its config" over "what does it cost and how fast is it". Both defensible; mockup's framing better matches "I'm benchmarking" task. |
| Sidebar has Pack library, Run settings, Advanced quality ops (collapsible), Import (collapsible) — long tall column | MEDIUM | `:1075-1486`. | The collapsibles work, but the entire sidebar is a tall scroll on a 720px viewport. |
| The selected test detail surface has Header + (actions) + Detail summary cards (5) + Tab list + Tab panel | MEDIUM | `:1606-2273`. | Five summary cards above five tabs above tab content — too many layers above the actual evidence. Mockup `prompt-packs.html:529-596` shows Header + Output + Assessment side-by-side, 2 panels. |
| `mc-pp-empty large` empty-state for "select a test" uses an `<h4>` + `<p>` only | LOW | `:2266-2271`. | Migrate to `EmptyState` for icon + tone consistency. |
| Threshold bar's `data-passing` attribute tints the bar — good | NIT (positive) | `:2581-2604`. | Clear, semantic. |
| Insights tab has 4 metric cards + trend chips + 2 collapsible details (benchmark + regression) — dense | MEDIUM | `:2148-2262`. | Insights tab is fine but is now a kitchen sink for everything not covered by the first 4 tabs. |

#### Consistency

| Element | Status | Notes |
|---|---|---|
| `StatusChip` adoption | **No** — Prompt Packs uses bespoke `mc-pp-chip` system with ad-hoc tone classes (`statusChipClass()` at `:2494-2508`, `resultCategoryClass()` at `:2510-2530`). | The bespoke system encodes pack-specific states (`run-paused`, `result-needs-score`, `score-ready`, etc.) that don't map cleanly to `StatusChipTone`. Migration would require extending `StatusChip` or accepting a wrapper. Acceptable today; document as "pack-specific chip family". |
| `EmptyState` adoption | **No** — `<div className="mc-pp-empty">` 3+ times. | Migrate. |
| `ThreePartChip` | Not used. | Could be used for benchmark/regression status (state + run id + timestamp). |
| Buttons | `mc-next-button` family used consistently (primary / secondary / ghost / danger). | Good cross-app consistency. |
| Filter chips (`mc-pp-filter-chip`) | Custom — not the same as Settings' `mc-next-settings-filter`. | Acceptable specialization. |
| Tokens | All `mc-pp-*` classes; spot-check shows no hex. | Token-clean. |
| `mc-pp-spin` for loader rotation | Local utility. | OK. |
| `<details>` for "Advanced quality ops" and "Import" sections | Native HTML `<details>`, no custom expand/collapse. | Solid choice — accessible by default. |
| `details.mc-pp-evidence-details` open by default | `:1958, 2199, 2233`. | OK. |

#### Accessibility

| Finding | Severity | Location | Why it matters |
|---|---|---|---|
| `mc-pp-test-select` is `<div role="button" tabIndex={0}>` containing a nested `<button>` ("Run") | HIGH | `:1528-1591`. Nested interactive elements; SR users hear "button, button". Also the outer `<div>` doesn't honour `aria-pressed` (uses `aria-pressed={selected}` ✓ at `:1531` — good catch) but the nesting still violates HTML semantics. | Restructure as `<button>` for selection + sibling `<button>` for run. |
| 20 `aria-*`/`role=` references in 2605 lines — moderate coverage | MEDIUM | Spot-checked: `role="radiogroup"` on execution style (`:1172`), `role="tablist"` on filter chips (`:1498`), `role="tab"`/`aria-selected` on detail tabs (`:1711`), `aria-label` on test list (`:1515`) and `aria-pressed` on test rows (`:1531`). | Better than Memory or Projects. Still missing: `aria-live` on the alert banners and status row; `aria-describedby` on disabled controls; rotation/spinner accessible name. |
| `LoaderCircle` icons inside buttons have no `aria-label` | LOW | `:982, 991, 1000, 1009, 1330, 1340, 1358, 1378, 1430, 1480, 1586, 1631, 2123, 2132`. | The spinning loader is visual only; SR users see only the button label, which doesn't change. Wrap busy buttons with `aria-busy="true"`. |
| Alert banners (`mc-pp-alert danger`/`success`) use `role="alert"` ✓ and `role="status"` ✓ | NIT (positive) | `:1028, 1034`. | Correct. |
| Tab panels not wrapped in `role="tabpanel"` with `aria-labelledby` | MEDIUM | `:1720-2264`. | The tabs are `role="tab"` but the panel itself is plain `<div className="mc-pp-tab-panel">`. |
| Score buttons in Manual Review are 7 `<button>`s per dimension in a row, no `role="radiogroup"` | MEDIUM | `:2037-2059`. | Should be `role="radiogroup"` with `role="radio"` + `aria-checked` per button (mirrors the execution-style implementation at `:1172`). |
| The 2-step Confirm Reset flow swaps button content without `aria-live` | MEDIUM | `:1410-1444`. | Wrap in `aria-live="polite"`. |

### Mockup-vs-live gap

| Mockup promise | Mockup ref | Live state |
|---|---|---|
| Prompt editor with inline variable chips + keyword/string highlighting + comment styling | `prompt-packs.html:496-523` | Flat `<pre>{prompt}</pre>` (`:1730`) |
| Output panel with diff highlighting (`diff-add`/`diff-rm` spans inside `<pre>`) | `prompt-packs.html:540-543` | Plain text `<pre>{selectedRun.responseText}</pre>` (`:1804-1810`) |
| Assessment as structured criteria rows (Route correctness / JSON shape / Reason cogency / Latency budget) with score chip per row | `prompt-packs.html:561-595` | Live shows aggregate "Auto score / Effective verdict / Protocol / Attribution" cards (`:1883-1929`) and a per-dimension evidence table (`:1956-1986`) — close in spirit but lacks the row-by-row "what was the test checking and how did it score" linearity |
| Threshold bar with `marker` at threshold + `fill` width = score | `prompt-packs.html:587-589` | `AssessmentThresholdBar` at `:2581-2604` — implemented, matches mockup ✓ |
| 7-column test grid (checkbox / id / name / expected / score / latency / open) | `prompt-packs.html:418-489` | Live test list is `<article>` per row with custom layout (`:1515-1594`) — different but functionally complete |
| "Re-run failures" hero button | `prompt-packs.html:361-364` | Absent — closest is "Auto-score" + per-row Run |
| Pack rail items with `pass`/`fail` count chips inline | `prompt-packs.html:312-339` | Live rail shows just pack name + test count (`:1089-1104`) — pass/fail data is in `report` but not surfaced in rail |
| Detail panel head with `chip-3 danger` (lh dot + mid expected/got + rh run id) | `prompt-packs.html:531-536` | Bespoke detail head (`:1606-1637`) with chip `statusChipClass()` — different visual |
| 3-tab detail panel head (Prompt / Output / Diff) | `prompt-packs.html:499-504` | 5 tabs (Prompt / Output / Assessment / Review / Insights) — superset, intentional |
| Status strip at footer (benchmark health / pack version / selection / auto-score model / timestamp) | `prompt-packs.html:603-609` | Not in this page — global status strip handles it |

**Live features not in mockup that should stay:**
- Replay regression flow (`runRegression`, `:796-820`) — load-bearing for "did the new model degrade?"
- Manual Review tab with 5-dimension scoring + override verdict + notes (`:1997-2146`) — the human-in-the-loop layer the mockup hand-waved
- Placeholder values UI (`:1756-1791`) — the mockup hardcodes `primary_model = "claude-opus-4-7"`; live exposes the parameter as a form
- Execution style toggle (Harness / Agentic) (`:1170-1192`) — surface-vs-harness distinction matters for the project
- Provider/Model lane selection + reuse-last toggle (`:1118-1167`) — the mockup punts; live owns it
- Pack reset two-step confirm (`:1391-1444`) — destructive guard the mockup ignored
- `useRefreshSubscription` with benchmark/regression auto-polling (`:250-270`) — live operator surface

**Gap summary:** medium. The biggest single gap is the prompt editor's flat-text rendering vs the mockup's syntax-highlighted variable-chip showcase. Otherwise, live ships *more* than the mockup (regression, manual review, placeholder values, execution-style, reset). The mockup's structural lessons (foregrounded pass-rate metric, fewer hero buttons) are worth adopting; the mockup's *coverage* is narrower than live and not always preferable.

### Primitive adoption

| Primitive | Used? | Where |
|---|---|---|
| `StatusChip` | **No** — uses bespoke `mc-pp-chip` family | Acceptable specialization; document boundary |
| `EmptyState` | **No** — 3+ ad-hoc `mc-pp-empty` | Migrate |
| `ThreePartChip` | No | Benchmark/regression status (state + run id + age) is a natural fit |
| `ContextStrip` | No | N/A |
| `ModeBar` | No | N/A |
| `StageHeader` | No — uses bespoke `mc-pp-hero` | Could adopt but would lose ops/library variant flexibility |

### What works well

1. **5-tab detail surface (Prompt / Output / Assessment / Review / Insights)** — each tab has a coherent purpose; tabs use real `role="tab"`/`aria-selected`. The 5-tab structure is a useful generalization of the mockup's 3-tab proposal.
2. **`AssessmentThresholdBar` is a real "are we above the line" visual** — `:2581-2604`. The marker + fill + `data-passing` attribute is clean. Honors the mockup's "gold line is the threshold" idea (`prompt-packs.html:587-589`).
3. **`Run next` heuristic** — `chooseNextPromptPackTest` (`:2360-2373`) picks not-run > failed > unscored-completed > first test. A small piece of authored intelligence that makes the page feel smart.
4. **Snapshot export after every run + reset 2-step confirm** — `savePromptPackSnapshot` (`:454-458`), confirm-reset (`:1410-1444`). Operator-truthful: nothing is silently destroyed.
5. **`useRefreshSubscription` integration** — `:250-270` polls more aggressively (2.5s) when a benchmark/regression is running and falls back to 15s otherwise. Live ops without being chatty.
6. **Placeholder values UI surfaces missing values inline** — `:1756-1791` with "All placeholders are set for this test." / "Missing values: …" feedback. Tight loop between prompt-author intent and runtime intent.
7. **Diagnostic chip groups for Capability targets / Expected runtime signals / Likely failure classes** — `DiagnosticChipGroup` at `:2382-2400` rendered in the Prompt tab. Surfaces the test's authorship intent next to its prompt.

### Code-health seams (for W4.3 decomposition)

The 2605-line file decomposes along natural lines:

| Seam | Current line range | Suggested module | Why it cuts cleanly |
|---|---|---|---|
| **Hero + summary cards + threshold bar** | `:967-1038` + `:2581-2604` | `prompt-packs/PromptPacksHero.tsx` | Renders pack/coverage/pass-rate/model-lane/execution-style summary + 4 hero actions + threshold bar. Pure presentation, takes `summaryCards`, `passThreshold`, `actions` props. |
| **Status row** | `:1040-1072` | `prompt-packs/PromptPacksStatusRow.tsx` | Active run + benchmark + regression + fallback-refreshing pills. Takes `activeRun`, `benchmarkStatus`, `regressionStatus`, `isFallbackRefreshing`. |
| **Sidebar — Pack library** | `:1075-1106` | `prompt-packs/sidebar/PromptPackLibraryPanel.tsx` | Pack list selectable. Takes `packs`, `selectedPackId`, `onSelectPack`. |
| **Sidebar — Run settings (and ops variant Execution lane)** | `:1108-1296` | `prompt-packs/sidebar/RunSettingsPanel.tsx` | Provider/model picker + reuse-last + auto-score-on-run + execution style. Variant switch lives inside. |
| **Sidebar — Advanced quality ops** | `:1298-1453` | `prompt-packs/sidebar/AdvancedQualityOpsPanel.tsx` | Benchmark + regression + export + reset. Self-contained ops surface; would benefit from being collapsible like today. |
| **Sidebar — Import pack** | `:1455-1485` | `prompt-packs/sidebar/ImportPackPanel.tsx` | Library-only; props: `importText`, `onImport`. |
| **Tests column (filter chips + test list)** | `:1488-1601` | `prompt-packs/PromptPackTestsColumn.tsx` | Filter chips + per-test row with run button. Stable contract: takes `tests`, `selectedTestId`, `latestRunByTest`, `latestAssessmentByTest`, `onSelect`, `onRun`. Big win: ARIA fix (nested-button) localized to this module. |
| **Detail surface header + summary cards** | `:1606-1703` | `prompt-packs/detail/PromptPackDetailHeader.tsx` | Test code chip row + h4 + actions + 5-card detail summary. |
| **Detail tab — Prompt** | `:1720-1793` (within tab switch) | `prompt-packs/detail/PromptTab.tsx` | Prompt source + diagnostics + placeholder values. **Biggest win:** isolating this tab opens the door to migrating the `<pre>` to a real syntax-highlighter (mockup gap #1). |
| **Detail tab — Output** | `:1795-1872` | `prompt-packs/detail/OutputTab.tsx` | Assistant output + run evidence. Isolating exposes the diff-highlight gap. |
| **Detail tab — Assessment** | `:1874-1995` | `prompt-packs/detail/AssessmentTab.tsx` | Auto score + verdict + protocol + attribution + score-evidence table. |
| **Detail tab — Review** | `:1997-2146` | `prompt-packs/detail/ReviewTab.tsx` | Manual review draft + dimension scoring + override + notes. ~149 lines — needs to be a single file. |
| **Detail tab — Insights** | `:2148-2263` | `prompt-packs/detail/InsightsTab.tsx` | Pack insights metrics + trends + benchmark table + regression table. |
| **Helpers + DTOs** | `:2278-2604` | `prompt-packs/PromptPacksWorkbenchPage.helpers.ts` (already exists for some helpers; merge) | All pure functions: `buildLatestPromptPackRunByTest`, `summarizePromptPackTestOutcomes`, `filterPromptPackTestsByResult`, `chooseNextPromptPackTest`, `formatPromptPackExecutionStyle`, `getPromptPackScoreDimensionLabels`, etc. plus constants `DETAIL_TABS`, `DIMENSION_ROWS`, `FILTER_OPTIONS`. |
| **`AssessmentThresholdBar`** | `:2581-2604` | `prompt-packs/AssessmentThresholdBar.tsx` | Already a self-contained component; extract trivially. |

After decomposition, `PromptPacksWorkbenchPage.tsx` should be the orchestrator only (state, callbacks, layout shell) at roughly 400-600 lines. The 5 detail tabs become a `Record<DetailTab, ComponentType<…>>` lookup, opening the door for lazy loading of expensive tabs (Insights with its tables, Review with its draft state).

The cut is **safe** — every seam is data-flow-clean (props in, callbacks out), no shared local state crosses tabs except `scoreDraft` (which lives in the parent already).

---

## Cross-surface observations

1. **`EmptyState` primitive exists and zero pages outside the primitives folder use it.** Memory, Projects, Prompt Packs, NativeRoutePages (15+ uses of `LibraryEmptyState`), SettingsNativePage (15+ uses of `SettingsEmptyState`) all use ad-hoc empties. Adoption is a Phase-1 cross-cutting fix.
2. **Memory and Projects share a "zero ARIA" disease.** Memory: 0 attrs. Projects: 2 attrs. Prompt Packs: 20 attrs. The pattern is clear — the older the page, the worse the ARIA. The post-Settings-review push for `aria-current`/`aria-pressed` on selectable lists, `htmlFor`/`id` on form inputs, and `aria-live` on notice banners applies across all three.
3. **`gc-button` (legacy) leakage into MemoryRoutePage.** `:331, 348, 421-422, 546, 663, 671, 678, 730, 737` use `gc-button`/`gc-button danger`/`gc-button subtle` — these are mission-control-shared legacy classes pulled into a "next" page. Projects and Prompt Packs use `mc-next-button` family consistently.
4. **The mockup's footer "status strip" is absent on all three pages.** Memory mockup has it (`memory.html:611-617`), Projects mockup has it (`projects.html:424-429`), Prompt Packs mockup has it (`prompt-packs.html:603-609`). Live relies on a global status strip in the shell. Decide: do per-page strips add value (mockup's claim) or is the global strip sufficient (live's bet)?
5. **Pin/unpin is a cross-surface concept but only Memory implements it on a per-item basis.** Memory pins memory items (`:246-248`). Projects does not pin projects (mockup says it should). Prompt Packs does not pin packs (the rail doesn't sort by recency or pin state). Cross-surface affordance worth aligning.
6. **Filter affordance is inconsistent.** Memory: free-text search only. Projects: nothing (mockup says tabs + search + sort). Prompt Packs: filter chip row (good) + sidebar search (good). The shared pattern from Prompt Packs could be lifted into a `PageFilterBar` primitive.
7. **Recent/recency surfacing is inconsistent.** Memory: groups items by "Pinned · 2 / Recent · today / Scratch · 3" in mockup, flat list with `updatedAt` per item in live. Projects: per-project "Recent work" lane, mockup wants cross-project "Pick up where you left off". Prompt Packs: no recency view of recent test runs at all. Recents-as-first-class is a missing IA layer for all three.
8. **All three surfaces are "ship-with-known-debt" by the ship-bar rubric.** None are blocking. Memory's ARIA gap is the only HIGH-in-blocking-category (a11y blocker) finding; everything else is HIGH-out-of-blocking-category (waivable) or MEDIUM/LOW. A focused 1-2 day pass on (a) `EmptyState` adoption, (b) ARIA for Memory and Projects, (c) Projects pin/archive filter + Recents row, (d) Memory namespace pills + maintenance footer would close the visible mockup-vs-live gap.
