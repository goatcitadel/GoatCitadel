# Mission Control Next — backlog status against r4-ux + companion reviews

**Date:** 2026-05-24
**Source:** Adjudication subagent run during 2026-05-24 ship-readiness review
**Adjudicated:** 2026-05-24
**Inputs:** r4-ux.md, r5-settings.md, r6-orchestration.md, mission-control-claude-design-convergence-audit.md, mission-control-ui-functionality-coverage-review.md

## Verdict counts (preliminary)

- **Fixed:** ~12 (CHAT-001 partially, CHAT-003, CHAT-004, CHAT-007, CHAT-009, CHAT-021, COWORK-006, COWORK-008, CODE-001, CODE-006, CODE-008, CODE-010, CC-008)
- **Partial:** ~12 (CHAT-001 (no Cmd+K), CHAT-002, CHAT-008, CHAT-010, CHAT-015, CHAT-016, COWORK-001, COWORK-002, COWORK-003, CODE-003, CODE-004, CODE-005, CC-002, CC-003)
- **Still-broken:** ~26 (most remaining items)
- **Superseded:** ~1-2 (COWORK-008 partly)
- **Cannot-verify:** ~3-5 (CHAT-005, CODE-007, CC-005, CC-014, CC-016)

## Summary

- CHAT lane has the strongest forward motion: 6 fully fixed (keyboard shortcuts, citation lists, model-picker metadata, autosize textarea, smooth-scroll, native confirm replacement), plus several partials. Remaining ship-blockers in CHAT are CSS hygiene gaps (CHAT-013, CHAT-014) and accessibility gaps (CHAT-016 focus rings, CHAT-020 combobox aria).
- COWORK has restructured significantly (CommandCenter hoisted, run-map status classes, checkpoint timeline arrows) but still carries multiple HIGH/MEDIUM accessibility gaps (COWORK-004 approval autofocus, COWORK-013 tab aria) and trust-eroding state-only honesty work.
- CODE lane has the most-improved tooling surface (Monaco shortcuts, diff toggle, validation history, toolbar overflow) but still ships several MEDIUM gaps (CODE-002 minimap/breadcrumb, CODE-009 source-chooser aria, CODE-012 Monaco theme not subscribed, CODE-013 empty state polish).
- CROSS-CUTTING items are dominated by the still-broken list — notifications without auto-dismiss (CC-001), sparse aria-live regions outside chat (CC-003), missing skeleton loaders (CC-004), dead compact-layout CSS (CC-007), mobile rail hardcoded offset (CC-006).
- Top ship-blockers (HIGH severity, still-broken): CHAT-013, CHAT-014, COWORK-004, COWORK-013, CC-001.

## Still-broken — ship-blockers

### CHAT-013 — orphan chat CSS (chat-stream-status-bar, chat-v11-queue-bar, surface-reconnect-banner) [HIGH]
grep of `apps/mission-control-next` returns no CSS for any of these class names. Only the legacy `apps/mission-control` styles them.

### CHAT-014 — status-chip tones [HIGH]
`apps/mission-control-next/src/styles/mission-control-next.css:1677` only defines generic `.status-chip`; no `-success`, `-warning`, `-critical`, `-muted`, `-live`, `-default` selectors. Tone classes are written by `StatusChip.tsx:12` (`status-chip-${tone}`) but have no CSS in the next-app.

### COWORK-004 — approval gate autofocus / scroll [HIGH]
`packages/mission-control-shared/src/components/InlineApprovalPrompt.tsx:116-123` has no autoFocus on Allow once, no aggressive scrollIntoView, no top-banner alternative. ThreadedTimeline still renders the approval inline at thread bottom.

### COWORK-013 — tab row aria-tablist [HIGH]
`CoworkPanel.tsx:103-120` buttons with no `role="tab"`, `aria-selected`, or `role="tablist"`.

### CC-001 — notifications no auto-dismiss / animation [HIGH]
`NotificationStack.tsx` has no setTimeout auto-dismiss, no CSS transitions.

## Still-broken — ship-acceptable but trust-eroding

### CHAT-006 — empty state suggested prompts [MEDIUM]
`ThreadedSurfacePage.tsx:1306-1342` ThreadEmptyState still shows mode-verb buttons ("Start chat", "Attach files", "Open Cowork", "Open Code"). No suggested prompts, no recent thread shortcuts.

### CHAT-011 — drop overlay full overlay [MEDIUM]
`rail.css:91-105` still uses `position:absolute inset:0` with `backdrop-filter blur(8px)`.

### CHAT-012 — attachment preview dead-end [MEDIUM]
`ThreadedComposer.tsx:320-342` still has the same fallback-loading text dead-end with no Open-in-new-tab / retry button when blob fetch fails.

### CHAT-020 — combobox listbox aria [MEDIUM]
`ThreadedComposer.tsx:748` has `role="listbox"` but no `role="combobox"` wrapper on the textarea, no `aria-controls`, no `aria-activedescendant`, items not `role="option"`.

### COWORK-005 — progress indicators [MEDIUM]
`ThreadedTimeline.tsx:433-...` ThreadDelegationSummary still shows text counts ("Completed N · Running N · Failed N · Skipped N") with no progress bar, no animated indicator on running steps.

### COWORK-007 — flat subagent bullet list [MEDIUM]
`CoworkPanel.tsx:619-627` uses PanelList for `runtime.treeNodes` — flat list of items with status string and meta string. No tree view, no nesting visual, no live update animation.

### COWORK-010 — blocker severity color [MEDIUM]
`CoworkPanel.tsx:156-172` renders blockers as plain articles with no severity tone, no resolve/dismiss/escalate buttons (just "Details").

### COWORK-011 — no keyboard shortcuts for approval [MEDIUM]
`InlineApprovalPrompt.tsx` has no key bindings, no `kbd` hint.

### CODE-002 — Minimap / breadcrumb [MEDIUM]
`WorkbenchMonacoEditor.tsx:68` still `minimap: { enabled: false }`. No breadcrumb, no outline.

### CODE-009 — source chooser tabs aria [MEDIUM]
`CodeWorkbenchPanel.tsx:113-128` buttons-as-tabs with no `role="tab"`.

### CODE-012 — Monaco theme not subscribed [MEDIUM]
`WorkbenchMonacoEditor.tsx:22-27` still reads class once; the useEffect at line 50 only re-runs on `[resolvedLanguage]`. Theme change requires editor remount.

### CODE-013 — empty state when unbound [MEDIUM]
`CodeWorkbenchPanel.tsx:1039-1046,1294-1296` sidebar still shows CodeSourceChooser; main pane still shows "Pick a file in the tree to start editing it."

### CC-004 — no skeleton loaders [MEDIUM]
`ThreadedTimeline.tsx:703` still "Loading thread…" text.

### CC-006 — mobile rail Esc + hardcoded 5.2rem top [MEDIUM]
`mobile.css:90` still `top: 5.2rem`. No keydown handler for Escape on the rail.

### CC-007 — compactLayout (≤1180px) dead CSS [MEDIUM]
`mc-next-threaded-conversation.compact` className still set (`ThreadedSurfacePage.tsx:701`) with zero CSS rules targeting it.

### CC-012 — no client-side file validation [MEDIUM]
Only `accept="audio/*"` on the audio input (`ThreadedComposer.tsx:905`). Main file input still accepts anything.

### CC-015 — notification count doesn't re-announce [MEDIUM]
`NotificationStack.tsx:73` just renders `x{count}` chip.

### CC-018 — single button class no semantic variants [MEDIUM]
Only `.primary` and `.danger` modifiers exist; no `ghost`/`subtle`/`link`.

### CC-019 — composer send no loading spinner [MEDIUM]
`ThreadedComposer.tsx` still uses label change only (no Loader2 icon).

## Still-broken — polish

### CHAT-017 — `:has()` blocking dim selector [LOW]
`apps/mission-control-next/src/features/threaded-surface/styles/timeline-frame.css:48` still uses `.mc-next-threaded-thread-card:has(.mc-next-thread-blocking-prompt) + ...`. The component now sets `data-blocker-kind` but the CSS doesn't react to it.

### CHAT-018 — 160px image preview min-height [LOW]
`composer.css:1005-1008` still `min-height: 160px`.

### CHAT-019 — chip row clutter [LOW]
`ThreadedComposer.tsx:666-698` still renders all chips at all times.

### COWORK-009 — gate decision tone fallback [LOW]
`CoworkPanel.tsx:378-380` still: `tone={gate.decision === "continue" ? "success" : gate.decision === "checkpoint" ? "warning" : "critical"}`. Unknown decisions default to critical.

### COWORK-012 — countdown visual [LOW]
`InlineApprovalPrompt.tsx:127` still small span. No pulse, no progress ring.

### COWORK-014 — area color polluting risk chips [LOW]
Various spots still use `var(--mc-area-color)` for borders, mixed into risk tints.

### CODE-011 — file tree height clamp [LOW]
`WorkbenchFileTree.tsx:89` still has the same `Math.max(320, Math.min(680, …))` clamp.

### CC-009 — header chip rows wrap unpredictably [LOW]
`ThreadedSurfacePage.tsx:631-648` still two chip rows.

### CC-010 — theme transition flash [LOW]
No `transition: background-color` rules in `apps/mission-control-next/src/styles/`.

### CC-013 — disabled buttons cursor: pointer [LOW]
No `:disabled` or `[disabled]` rule across the threaded-surface CSS.

### CC-016 — Mermaid render no spinner [LOW]
Need to check GeneratedArtifactViewer; mark as cannot-verify if not yet read.

### CC-020 — code copy button 1.55rem tiny [LOW]
Need to grep current AssistantMessageRenderer copy button size.

### CC-021 — composer card no horizontal padding [LOW]
Need to verify current padding rule.

### CC-022 — compact mode no primary action [LOW]
`ThreadedSurfacePage.tsx:651-696` still has same flat action row.

### CC-011 — 840px sheet breakpoint mismatch [NIT]
`ThreadedSurfacePage.tsx:596` still `useMediaQuery("(max-width: 840px)")`.

## Partial

### CHAT-001 — keyboard shortcuts
`packages/threaded-surface-core/src/chat/useChatComposerInteractions.ts:116,141,146` now has Escape, ArrowUp-recall, Cmd/Ctrl+Enter, plus existing planning-toggle and command suggestion arrows. Cmd+K command palette still absent.

### CHAT-002 — streaming aria-live
`apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:695` adds a `role="status" aria-live="polite"` live region announcing status transitions; assistant bubble at line 314 has `aria-busy`. But the bubble itself is not wrapped in `aria-live` — the chunks aren't announced, only the "streaming"/"queued"/"connecting" status label. SR users still get a single status update, not the actual streaming text.

### CHAT-008 — send button touch target
`composer.css:493-499` is now `min-height: 1.78rem` (was 1.55rem). Still well under 44px WCAG threshold. Partially improved.

### CHAT-010 — 58dvh thread cap
`timeline.css:7` is now `min(68dvh, 52rem)` (was 58dvh, 44rem). Slightly larger but still capped.

### CHAT-015 — hover micro-interactions
9 `:hover` rules across `styles/` (was 1). Still sparse: no hover-reveal action buttons on messages, no hover on chips, etc.

### CHAT-016 — focus-visible rings
`composer.css:948` still uses `outline: none` on textarea even in `:focus-visible`. `timeline.css:303-306` still has `outline: none` on `.mc-next-thread-turn-surface`. Some focus-visible rings added (panel menu items, resize handle, summary tags), but the primary composer textarea and turn surface still have no replacement ring.

### COWORK-001 — 9+ vertical sections
`CoworkPanel.tsx` now has tab-row at `mc-next-panel-tab-row` (line 103) with plan/run-map/timeline/actions; a new `CoworkCommandCenter` hoists Current Objective + Next Operator Action + State at top (lines 70, 187-267); intervention panel groups Blockers/Approvals/Checkpoints (line 85). Significant restructuring, but agentic runtime panel still stacks below all of it.

### COWORK-002 — flat run-map nodes
`CoworkPanel.tsx:403-417` renders `.mc-next-cowork-run-map-graph` with status classes (`is-complete`, `is-active`, `is-blocked`, `is-pending`) on each node via `coworkStatusClass(node.status)`. The links between nodes still use 1px `mc-next-cowork-run-map-link`. Status colors now present but no SVG-based arrows / minimap.

### COWORK-003 — state-only pause/kill labels
`CoworkPanel.tsx:649-657` uses `describeAgenticControlCopy` to produce honest copy; ConfirmModal explicitly warns the operator (`CoworkPanel.tsx:60-66`). Honesty preserved; the underlying live-pause capability is the same (state-only).

### CODE-003 — file rename/create/delete
`WorkbenchFileTree.tsx` still has no `onCreateFile` etc. handlers. BUT `CodeWorkbenchPanel.tsx:1051-1119` surfaces a sidebar "Action / Path / Target" form invoking `onFileOperation` with `create_file/create_folder/rename/delete/duplicate/move`. Not in the tree itself but available in the sidebar.

### CODE-004 — terminal is read-only monaco
`CodeWorkbenchPanel.tsx:1357-1398` "Run log" pane has Rendered/Raw toggle, Copy, Clear buttons. Still not a true interactive terminal (no xterm.js, no shell prompt).

### CODE-005 — no resize handles
`CodeWorkbenchPanel.tsx:1019-1027` has a "Files pane" range slider that persists `filePanePercent` to localStorage (`CODE_WORKBENCH_LAYOUT_STORAGE_KEY:43`). `ThreadedSurfacePage.tsx:159-176` also adds `useHorizontalPaneResize` for rail/workbench/context panes with PaneResizeHandle. So pane resize exists between higher-level panels and between file pane and editor. Not between editor and terminal.

### CC-002 — only 2 transitions in threaded-surface.css
4 transitions across all split CSS (timeline/composer/rail/etc). Still very sparse vs modern UI baseline.

### CC-003 — sparse aria-live
Now has aria-live live-region for stream status (`ThreadedTimeline.tsx:695`), composer banners (`ThreadedComposer.tsx:356,597`), but cowork "Now"/run-map/workbench validation still lack aria-live.

## Fixed

### CHAT-003 — citations clickable list
`apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:158-204` renders `ThreadCitationList` with anchor tags + snippets + show-more, replacing the bare integer.

### CHAT-004 — model picker context window / cost / capabilities
`packages/mission-control-shared/src/components/ChatModelPicker.tsx:79-107,156-198` builds a metadata `<dl>` with Runtime, Endpoint, Model, Context (tokens), Cost (input/output per million), Capabilities, Catalog probe — plus a context badge.

### CHAT-007 — autosize textarea
`apps/mission-control-next/src/features/threaded-surface/useAutoGrowTextarea.ts:43-90` grows between minLines/maxLines; `ThreadedComposer.tsx:468` wires it to draft.

### CHAT-009 — smooth-scroll on every chunk
`ThreadedTimeline.tsx:633,648` use `behavior: "auto"` and only scroll when `props.followOutput`. `timeline.css:11` confirms `scroll-behavior: auto`.

### CHAT-021 — native window.confirm
No `window.confirm` left in `apps/mission-control-next/src/features/threaded-surface/`. Uses `ConfirmModal` (`ThreadedSurfacePage.tsx:555-566`).

### COWORK-006 — checkpoint timeline as arrows
`CoworkPanel.tsx:448-489` renders `CheckpointTimelinePanel` as an `<ol>` with `<details>`/`<summary>` rows including timestamp, title, meta, summary. Each row is click-to-expand.

### CODE-001 — Monaco shortcuts
`WorkbenchMonacoEditor.tsx:84-88` adds Ctrl+S, Ctrl+P, Ctrl+Shift+P commands.

### CODE-006 — diff side-by-side only
`CodeWorkbenchPanel.tsx:390 + 1304-1320` toggle between side-by-side and unified.

### CODE-008 — validation history last 5
`CodeWorkbenchPanel.tsx:1399-1422` renders all visibleRunItems (no `slice(0,5)`) with status info and Inspect button. Code Mode ledger sidebar at line 1750-1764 shows first 5 with ellipsis logic.

### CODE-010 — workbench toolbar overflow
`CodeWorkbenchPanel.tsx:879-1028` splits into `mc-next-workbench-action-cluster` for draft/repo/destructive groups separated by dividers; "More ▾" overflow menu for revert actions.

### CC-008 — turn cards button + nested interactive
`ThreadedTimeline.tsx:305` turn surface now `aria-current` only, no `role="button"`/`tabIndex`/`onClick` at the wrapper level.

## Superseded

### COWORK-008 — 8 fact mission-brief grid
The old 8-fact `<dl>` is replaced by the structured `CoworkCommandCenter` (Current objective + State + Next action). Facts still appear (`mc-next-cowork-facts` at `CoworkPanel.tsx:217-225`) but only when present, and Next operator action is hoisted to its own panel.

## Cannot-verify

### CHAT-005 — per-model system-prompt
Original finding noted UX-adjacent; still appears absent in composer UI surface. No new prompts/Personality picker in the composer.

### CODE-007 — collapse below 1360px
Need to grep media query in current CSS.

### CC-005 — hardcoded rgba shadows
Need to grep current CSS.

### CC-014 — visual-regression mode undocumented
Low value; would need to grep main.tsx for comment.

### CC-016 — Mermaid render no spinner
Need to check GeneratedArtifactViewer; mark as cannot-verify if not yet read.

### CC-017 — iframe sandbox=""
Out-of-charter per the original.

## Cross-document adjudication strategy

### r5-settings.md
Most r5 items target the legacy `apps/mission-control` shell. The header note at line 3-5 explicitly says: "this review preserves an older settings snapshot. `apps/mission-control-next` is the canonical Mission Control shell now". Mark r5 items broadly as **superseded** unless they specifically reference Mission Control Next's `SettingsNativePage.tsx`. The only r5 items that touch mc-next are CC-1 (historical default mismatch, already resolved), the secrets UI mention at CC-2, the OAuth verification url at line 417. Most others are `out-of-scope-for-mc-next`.

### r6-orchestration.md
r6 is overwhelmingly backend/engine — out of charter for UX adjudication. The only UX-relevant finding is **M7** ("MAX_VISIBLE_TIMELINE_ITEMS = 3 hides most checkpoint history") which intersects with COWORK-006. Since the new CheckpointTimelinePanel shows all rows (`CoworkPanel.tsx:469-488`), M7 is **fixed** (probably).

### Convergence + coverage docs
Both are historical, marking implementation status. Cross-reference any UI items already addressed in r4-ux. Mark them as "historical-context, see r4-ux verdict".

## Note

This adjudication doc was drafted in plan mode and never advanced through full execution. The verdicts above reflect a thorough pre-survey of 52 r4-ux findings against current source (file:line evidence captured throughout) but the following execution-time verification steps were not completed:

1. **CODE-007** — verify current threaded-surface CSS for `max-width: 1360px` media query
2. **CC-005** — grep for `rgba(0, 0, 0` and `rgba(15, 23, 42` in current styles
3. **CC-016** — read GeneratedArtifactViewer.tsx 14-60 for spinner
4. **CC-020** — re-grep AssistantMessageRenderer copy button width
5. **CC-021** — re-grep composer card padding
6. **CHAT-005** — confirm no per-model prompt UI is added
7. **CC-014** — confirm no documentation comment near visual-regression hooks

Line numbers cited above were captured during the pre-survey walk; they should be re-verified at execution time as the codebase may have drifted. Verdict counts are preliminary tallies, not a final certified count. The top 5 ship-blockers identified from the preliminary scan are: **CHAT-013, CHAT-014, CHAT-016, COWORK-013, CC-001** (with COWORK-004 a close runner-up).
