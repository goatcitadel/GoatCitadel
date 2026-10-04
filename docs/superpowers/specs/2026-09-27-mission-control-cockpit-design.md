# Mission Control cockpit — design

- **Date:** 2026-09-27
- **Status:** Approved direction (operator review in chat, 2026-09-27); pending spec review
- **Surface:** `apps/mission-control-next`, `packages/mission-control-shared`, `packages/threaded-surface-core`, plus one new Gateway read model (Inbox)
- **Evidence:** live review of 29 routes on 2026-09-27 (desktop dark and light, laptop, phone) with code tracing; earlier reviews on 2026-09-23 and 2026-07-27
- **Implementation:** [roadmap](../plans/2026-09-27-mission-control-cockpit-roadmap.md) and the phase plans it links

> File and line anchors come from `origin/main` on 2026-09-27 and are approximate. Verify them at implementation time.

## 1. Problem

Mission Control works, but it fights the operator. The conversation is starved of space, the app talks constantly without saying anything, information is spread across 44 destinations, and the details people need are hidden while noise stays visible.

| Finding | Evidence |
| --- | --- |
| Chat gets 28% of a 1440×900 screen | `.mc-next-thread-scroll` is 249px; composer 298px; thread header 70px; pinned change-plan card 55px; status lane 62px; footer strip about 40px |
| Chat on a 390×844 phone shows no conversation | Header, change-plan card, failure card, composer, and toasts fill the screen |
| One failure is shown three times | Status-lane card "I couldn't complete that step", timeline Activity chip "failed", composer banner "Failed" |
| Toast flood on every page load | `packages/mission-control-shared/src/state/realtime-derived.ts:334-373` turns every event with a task or session link into an info toast, with substring fallbacks; `apps/mission-control-next/src/app/use-shell-notifications.ts:108` delivers all of them with a sound |
| Raw errors reach the screen | "Sending is unavailable: Network error POST /api/v1/chat/sessions/…/route-preflight: Failed to fetch" (`packages/mission-control-shared/src/api/client-core.ts:291`, `ThreadedComposer.tsx:1778`) |
| 44 navigation destinations | Settings 22, Library 10, Ops 10, plus Chat and Projects; Approvals sits below the fold in the Ops rail |
| Lists carry almost no information | Rows show a name and a grey status word; compact density hides the row body (`07-settings-library.css:1396`); nothing is selected by default, so detail panes are empty |
| Trust and policy renders 269 rows at once | `TrustPolicySection.tsx:251` passes `maxHeight=""`; rows read "Capability · Ready · Ready" and their blockers are hidden |
| Useful information hidden, noise visible | "Page details" and "Details" disclosures on every page; Projects repeats the same two stats in the page header and the section header |
| First-run setup contradicts itself | "Connection: Not verified" beside "First response: Verified"; step 3 ticked while step 1 is stale; the example command uses `--alias gemma-4-local` while another model is selected |
| Raw event names | Ops Activity rows read `task_updated / tasks` |
| Sidebar stops 72px short | `mission-control-next.css:1549` `max-height: calc(100dvh - 4.5rem)` |
| Styling sprawl | 28,101 CSS lines in 60 files; 31 distinct breakpoints; font sizes already go through `--text-*` tokens (enforced by `scripts/check-mission-control-next-typography.mjs`), but 8 one-off `clamp()` headings and inconsistent `var()` fallbacks remain; `MissionThreadedControllerHost.tsx` is 6.2k lines and `RuntimeRoutePage.tsx` 4.2k |

## 2. Goals and non-goals

Goals:

- The conversation owns the screen: at least 60% of the viewport height for messages at 1440×900 and at least 55% at 390×844, with the composer idle.
- One home for human judgment: every approval, question, proposal, and problem appears in one Inbox.
- Five areas instead of 44 destinations, and Settings in seven pages.
- One visual language: one status vocabulary, one token set, 4 breakpoints, 7 type sizes.
- Calm by default: the app interrupts only for decisions and problems.
- Every AI action leaves a one-line receipt that opens its full trace.
- Every finding from the 2026-09-27 review is fixed in today's UI now, with logic placed in shared modules the new shell reuses.
- Automated guardrails stop the regressions from coming back.

Non-goals:

- No change to runtime authority, policy, approval semantics, durable execution, or Gateway truth. Mission Control stays an API client.
- No new public claims (for example, hostile-code sandboxing).
- No feature removal without parity. The classic shell stays until cutover plus one release.
- No Tailwind in the classic shell.

## 3. Locked decisions

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Direction | Conversation cockpit: Chat is home, one Inbox holds decisions, one inspector shows whatever is selected, and everything else is one keystroke away |
| D2 | Areas | Chat, Inbox, Work, Library, System, plus Settings in seven pages |
| D3 | Styling for the new shell | Tailwind v4 (already a dependency, currently unused) with GoatCitadel tokens as the theme; components own their styles; classic CSS is deleted at cutover |
| D4 | Server state for the new shell | TanStack Query; realtime events invalidate queries |
| D5 | Today's UI | Fix every review finding in the classic shell as well (Phase 0), shared logic first |
| D6 | Migration | The new shell ("cockpit") ships behind a local preference, one area at a time; old URLs redirect |
| D7 | Inbox truth | A Gateway-owned, read-only projection plus an `inbox.changed` signal; canonical owners are unchanged |
| D8 | Names | Plain names first, Citadel names second ("Rules · Wards", "Secrets · Vault"); the Communications mail list becomes "Mail" so there is only one Inbox |

## 4. Relationship to earlier specs

- `2026-07-04-mission-control-conversation-workspace-design.md`: keeps D1 (conversation workspace), D2 (Citadel first, now a scope switcher), D4 (one conversation surface), D5 (the chat display layer stays central), D7 (adaptive composer controls), D9 (the personality chip stays in the thread header), and D10 (plain product words). Supersedes D3 (integrated top nav becomes a left sidebar with no global top bar, which returns vertical space to the conversation), D6 (the Working Context rail becomes the inspector's Context tab, opened on demand), and D8 (the Work Record drawer becomes the inspector's Run and Turn tabs plus the Work area).
- `2026-06-25-unified-surface-ux-ia-design.md`: its runtime routing decisions are unchanged; where its presentation conflicts with this spec, this spec wins.
- Naming: the 1.0 contract calls the Chat surface "Work". In the cockpit, "Chat" is the conversation area and "Work" is runs and tasks. `docs/1_0_CONTRACT.md` and `docs/1_0_RELEASE_SURFACE_SCOPE.md` change at cutover (Phase 9), not before.

## 5. Information architecture

### 5.1 Areas

| Area | Purpose | Absorbs today | Cockpit routes |
| --- | --- | --- | --- |
| Chat | Talk, plan, research, and code. Projects are folders in the chat sidebar | Chat, Projects | `/chat`, `/chat/:sessionId`, `/projects/:projectId` |
| Inbox | Everything waiting on the operator's judgment | Ops Approvals, blocked Chat states, change plans, memory proposals, document edit proposals, skill candidates (Curator), self-repair proposals, Ops Notifications, "Needs attention" cards | `/inbox`, `/inbox/:itemId` |
| Work | Runs and tasks in flight, history, schedules | Kanban, Sessions, Activity (history), Schedules | `/work`, `/work/runs/:runId`, `/work/history`, `/work/schedules` |
| Library | What the agent can use, knows, and has made | Agents, Skills, Capabilities, Tools catalog, Prompt packs, Memory, Knowledge, Notes, Files, Artifacts, Communications, Curator, Journey | `/library?type=…`, `/library/:type/:id` |
| System | Health and cost | Runtime, Diagnostics, Costs, Quality, Improvement, Saved boards, remote workers, backups, the raw activity feed | `/system`, `/system/spend`, `/system/quality`, `/system/diagnostics`, `/system/activity`, `/system/dashboards` |

### 5.2 Settings: 22 pages become 7

A page is a group of existing section routes shown as tabs, so every current URL keeps working unchanged. The release manifest, scope doc, route counts, and screenshot baselines are all keyed to section slugs, and `scripts/validate-governance-docs.mjs` fails when a slug is renamed or removed. Grouping without renaming keeps those gates green. Both shells use the same grouping, defined once in `apps/mission-control-next/src/app/route-model.ts` (`RAIL_GROUPS`).

| Page | Tabs, in order (existing section routes) |
| --- | --- |
| General | General `/settings/general`, Personalities `/settings/personalities` |
| Models | Get started `/settings/onboarding`, Providers `/settings/providers`, Local AI `/settings/local-ai` |
| Connections | Channels `/settings/channels`, Integrations `/settings/integrations`, MCP servers `/settings/mcp` |
| Safety | Permissions `/settings/permissions`, Tools `/settings/tools`, Trust `/settings/trust-policy`, Hooks `/settings/hooks`, Budgets `/settings/budget` |
| Citadel | Overview `/library/citadel-overview`, Workspaces `/settings/workspaces`, Setup `/library/citadel`, Rules · Wards `/library/citadel-wards`, Agents · Council `/library/citadel-council`, Secrets · Vault `/library/citadel-vault`, Blueprint `/library/citadel-blueprint` |
| Access | Access and devices `/settings/access` |
| Advanced | Runtime configuration `/settings/runtime` |

The rail shows one entry per page, active when the current section belongs to it, and each page renders a tab strip of its sections. A Settings search box finds any setting by label (Phase 7).

### 5.3 Classic shell sub-navigation after Phase 0

The classic shell keeps its five top-level areas until cutover. The same grouping pattern applies, so no area shows more than six rail entries:

- Library: Agents; Skills and tools (tabs: Skills, Capabilities, Prompt packs, Curator, Learning); Knowledge (tabs: Knowledge, Memory, Notes); Files (tabs: Files, Artifacts); Mail (Communications).
- Ops: Approvals (first; its count badge hides at zero, and the top bar keeps its existing "N pending" button); Activity (tabs: Activity, Sessions, Notifications); Work board (tabs: Kanban, Saved boards, Schedules); Costs; Health (tabs: Runtime, Diagnostics, Remote workers); Quality (tabs: Quality, Improvement).

### 5.4 Redirects

Phase 0 changes no URLs. Cockpit-only routes (spec 5.1) get redirects from classic paths in Phase 9, added to `apps/mission-control-next/src/app/legacy-route-adapter.ts`, the existing owner of legacy URL translation.

## 6. Cockpit shell

- **Sidebar:** 248px, collapsible to a 56px rail (Ctrl+B). Top to bottom:
  - scope switcher (Citadel › Workspace)
  - Search (Ctrl+K)
  - area links: Chat; Inbox with its open count; Work with a running indicator; Library; System
  - a contextual section: project folders and recent threads in Chat, type filters in Library, saved views in Work, sections in System and Settings
  - a footer with a health dot, Settings, and the account and theme menu
- **No global top bar.** Each view renders one 48px header row.
- **No footer status strip.** Health lives in the sidebar footer; detail lives in System.
- **Inspector:** a right-hand panel, 360–480px and resizable. It opens on selection or Ctrl+I and closes with Esc. One component hosts typed sheets for: run, turn, source, file, skill, tool, approval, memory item, and provider.
- **Command palette (Ctrl+K):** jump to any area or object, run commands (new chat, switch model, open an inbox item, toggle theme or density), and search threads and the Library. Inside Chat, the composer palette opens with `/`, `@`, and `$`. The 1.0 contract currently also routes Ctrl+K to the composer palette in Chat (`unifiedComposerPaletteV1Enabled`), so the cockpit's global Ctrl+K in Chat ships together with that contract update at cutover (Phase 9).
- **Keyboard:**
  - Ctrl+1 to Ctrl+5 switch areas
  - Ctrl+K, Ctrl+B, and Ctrl+I as above; Esc closes the top layer
  - J/K to move and A/E/D to approve, edit, or deny in lists
- **Phone (below 640px):** bottom tabs (Chat, Inbox, Work, Library, More). The inspector becomes a bottom sheet (`vaul`) and the sidebar becomes a drawer.
- **Tablet (640–1023px):** the sidebar starts as the rail and the inspector overlays the content.

## 7. Chat

### 7.1 Layout budget

At 1440×900 with the composer idle, the message scroller is at least 60% of the viewport height; at 390×844 it is at least 55%. The header is 48px and the idle composer at most 120px.

### 7.2 Header

The header row contains:

- title (rename in place)
- project chip
- personality chip
- model chip (provider, model, local or cloud)
- active-run pill
- inspector toggle
- overflow menu (fork, export, archive)

### 7.3 Timeline elements

| Element | Behavior |
| --- | --- |
| User message | Subtle card |
| Assistant message | Unboxed prose followed by a receipt line: model · tools · sources · memories · duration · cost. The receipt opens the Turn sheet |
| Run card | Goal, live step checklist, elapsed time, controls (pause, stop, continue in background); opens the Run sheet |
| Approval card | Appears at the step that is waiting. Same component and item as the Inbox; risk chip; actions |
| User-input form | Typed inputs for a durable wait that needs an answer |
| Failure message | Plain cause plus actions: retry the step, continue with partial results, open the run. It is the only place a failure is shown |
| System line | Change-plan receipts, model changes, and timers, with Undo or Details. Never pinned above the timeline |
| Existing rich content | Document and diff previews, OpenCode result cards, citations, Mermaid, and code keep working |

### 7.4 Composer

- A one-line textarea that grows to 40% of the viewport height.
- A footer row with: attach (+), mention (@), model picker, effort, tool toggles, context meter, and Send or Stop.
- Attached-context chips appear above the textarea only when present.
- The `/`, `@`, and `$` palette and typed run-variable forms keep working.
- A blocked state replaces Send with the fix (for example "Connect a model"), never with a raw error.

### 7.5 Inspector tabs in Chat

- Run
- Turn
- Sources
- Context (memory, knowledge, files in context, token budget)
- Files (artifacts produced, with diffs)
- Thread (model, personality, permission profile, tools)

### 7.6 Thread sidebar

Project folders (expandable) first, then recent threads. Threads carry status dots for running, waiting on you, and failed. Search, plus an archived filter.

### 7.7 Parity gate

The cockpit Chat becomes the default only when all of these work:

- **Messages and threads:**
  - streaming, and resume after reload
  - retry and fork
  - archived threads and project scoping
  - Markdown, Mermaid, and code rendering; copy and export
- **Composer and context:**
  - attachments and uploads
  - the composer palette (`/`, `@`, `$`, Ctrl+K) and typed run-variable forms
  - model, effort, and personality selection
  - the document drawer (note and artifact editing, patch proposals)
  - citations and sources
- **Runs, approvals, and changes:**
  - change plans confirmed and applied from Chat
  - inline approvals and user-input waits
  - background tasks (continue in background, reattach)
  - delegation visibility
  - OpenCode result cards and Code Mode approvals and artifacts
- **Commands:** `/timer`, `/schedule`, and `/status`

## 8. Inbox

### 8.1 Groups and kinds

| Group | Kinds |
| --- | --- |
| Needs decision | Approval (risk safe, caution, danger, or nuclear); user-input request; change plan awaiting input, confirmation, or approval |
| Proposals | Memory proposal; document edit proposal; skill or capability candidate; improvement or self-repair proposal |
| Needs attention | Failed or dead-lettered run; change plan in manual_required, failed, or rollback_failed; stale proof (backup verification); runtime degraded. Spend coverage was dropped from the Inbox on 2026-10-01: it never cleared and had no action; System → Spend keeps the lower-bound note. |
| Updates | Background run completed; deliverable added to a task. Archived automatically after being viewed. ("Handoff ready" today is a UI-only toast guessed from event names; the Inbox uses the canonical `deliverable_added` task event instead) |

### 8.2 Item anatomy

- icon for the kind
- title phrased as a verb ("Delete dist/ and rebuild goat-api")
- source (thread, run, agent, project), age, and expiry countdown
- risk chip
- exact preview (command, diff, email, config change)
- reason (the policy rule that required it)
- context (the last message in the source thread)
- actions

### 8.3 Actions

| Action | Rules |
| --- | --- |
| Approve once | Available on every approval |
| Edit and approve | Uses approval status `edited` |
| Deny | Available on every approval |
| Always allow in this project | Creates a scoped grant through the existing grant owner. Never offered for danger or nuclear |
| Risk explanation | Shows the existing `ApprovalExplanation` when the Gateway has generated one. There is no request endpoint; explanations are scheduled automatically by the approval explainer. The item shows "Explanation pending" while `explanationStatus` is `pending` |
| Open in conversation | Jumps to the source thread |
| Keep or discard | For proposals |
| Retry or recover | Retry for failed runs; recover for dead-lettered runs (the only resolution the Gateway offers) |

- **Danger** needs a confirmation click.
- **Nuclear** needs press-and-hold, about one second, on every device.

### 8.4 Truth

- **List endpoint:** `GET /api/v1/inbox` (workspace-scoped) returns a derived view. Each item carries canonical ids and owner links. Actions call the existing owner endpoints; the projection never mutates anything.
- **Change signal:** an idempotent `inbox.changed` realtime event triggers a refetch.
- **Counts:** the sidebar, the phone tab bar, and toasts all read their counts from this endpoint.
- **Chat approval cards:** these are the same component bound to the same item.

## 9. Work, Library, and System

- **Work:**
  - a board with columns Running, Waiting on you, Failed, Done, derived from durable run and task status
  - list and history views; history merges today's Sessions and Activity
  - the run sheet, plus a full page at `/work/runs/:runId`: plan, steps, delegation tree, tools, approvals, files, cost, worktree
  - schedules
- **Library:**
  - one catalog; each row shows icon, name, one-line description, status, trust level, and last used
  - filters for type, status, and trust
  - detail sheet tabs: Overview, Policy (effective policy, grants, blockers), Usage, Source (provenance, hashes), Settings (enable, disable, configure)
  - replaces the 269-row trust matrix and the three separate tool lists; the Safety settings summary links into the filtered catalog
- **System:**
  - Health: problems first. Services covered: Gateway, database, model runtimes, channels, integrations, backups, updates, remote workers. Each problem carries a fix action
  - Spend: chart, budget, per-model totals, and the unknown-cost caveat explained once
  - Quality: evals, Prompt Lab, improvement
  - Diagnostics: logs, durable queues and dead letters, support bundle
  - Activity log: raw events, for experts
  - Dashboards: saved boards

## 10. Visual language

### 10.1 Tokens

The token set is defined once for both themes:

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | canvas, raised, sunken, overlay | |
| Text | primary, secondary, muted, inverse | |
| Border | subtle, default, strong | |
| Accent | brand cyan | Existing `--brand`: `#00e5ff` dark, `#0f6070` light |
| Status tones | running, waiting, done, failed, neutral | |
| Focus ring | one | |

Cyan is the only accent: focus, primary actions, and live work. Green, amber, and red mean status and nothing else.

### 10.2 Status vocabulary

One shared module maps domain states to label, tone, and icon. No raw status string reaches the screen.

| Domain state | Label | Tone |
| --- | --- | --- |
| Run `queued` | Queued | neutral |
| Run `running` | Running | running |
| Run `waiting` with an operator blocker | Waiting on you | waiting |
| Run `waiting` without one | Waiting | neutral |
| Run `paused` | Paused | neutral |
| Run `completed` | Done | done |
| Run `failed` | Failed | failed |
| Run `cancelled` | Cancelled | neutral |
| Run `dead_lettered` | Failed · needs recovery | failed |
| Change plan `awaiting_input` | Needs your input | waiting |
| Change plan `awaiting_confirmation` | Needs confirmation | waiting |
| Change plan `awaiting_approval` | Waiting on you | waiting |
| Change plan `staging`, `applying` | Applying | running |
| Change plan `verifying` | Verifying | running |
| Change plan `monitoring` | Monitoring | running |
| Change plan `completed`, `applied` | Done | done |
| Change plan `manual_required` | Needs a manual step | waiting |
| Change plan `failed` | Failed | failed |
| Change plan `rolling_back` | Rolling back | running |
| Change plan `rolled_back` | Rolled back | neutral |
| Change plan `rollback_failed` | Rollback failed | failed |
| Change plan `draft` | Draft | neutral |
| Change plan `cancelled` | Cancelled | neutral |
| Approval `pending` | Waiting on you | waiting |
| Approval `approved` | Approved | done |
| Approval `edited` | Approved with edits | done |
| Approval `rejected` | Denied | neutral |
| Resolution `expired` | Expired | neutral |
| Resolution `withdrawn` | Withdrawn | neutral |
| Resolution `policy_blocked` | Blocked by policy | failed |
| Resolution `delivery_failed` | Couldn't deliver | failed |
| Resolution `unknown` | Outcome unknown | waiting |

Risk: Safe, Caution, Danger, Nuclear. Trust: Built-in, Verified, Reviewed, Not reviewed, Quarantined. The plan maps the existing trust labels onto these five.

### 10.3 Type

Fonts:

- Geist Variable for interface text
- Hanken Grotesk Variable for page titles only
- the system monospace for code, IDs, and receipts

Seven sizes:

| Token | Size / line height | Use |
| --- | --- | --- |
| `xs` | 12/16 | Metadata |
| `sm` | 13/18 | Dense UI |
| `base` | 14/20 | Default UI |
| `md` | 16/24 | Chat prose |
| `lg` | 20/28 | Section titles |
| `xl` | 24/32 | Page titles |
| `2xl` | 32/40 | Empty-state heroes |

Sentence case everywhere, with no all-caps labels.

### 10.4 Space, shape, depth, motion

- A 4px spacing grid.
- Radius: 6, 8, 12, and full.
- Flat surfaces with hairline borders and no boxes inside boxes; shadows only on overlays.
- Motion: 150ms for panels and 200ms for sheets. A pulse marks live runs. `prefers-reduced-motion` is respected.

### 10.5 Breakpoints and density

- Breakpoints (min-width): `sm` 640, `md` 1024, `lg` 1280, `xl` 1600.
- Density is Comfortable (default) or Compact through `data-density`. It replaces a "Simple mode" that hid content. The technical-details preference stays, but only for expert fields such as IDs in traces.

### 10.6 Copy rules

- Sentence case; buttons are verbs.
- The product speaks to "you"; the assistant says "I" only inside chat messages.
- No raw enum values, IDs, URLs, API paths, or stack traces in visible text. IDs appear only in monospace technical slots inside the inspector.
- Errors say what happened and what to do, with no "Error:" prefix.

## 11. Notification policy (both shells)

1. **When to toast:** only for these attention kinds: approval waiting, work blocked on the operator, run failed, runtime degraded, background run completed, deliverable ready, and notices the Gateway authors explicitly (`ui_notification` events with a title or message).
2. **When never to toast:**
   - generic task or session refreshes, run started or resumed, and "changes saved" echoes
   - transport status (connection interrupted or restored, replay gap), which belongs to the stream status indicator
   - events for the Chat session that is visible and focused
   - events replayed on connect or reconnect, meaning frames delivered before the server's `stream-ready` frame
3. **Grouping and dismissal:** identical toasts are grouped and at most three are visible. Info toasts dismiss after 6 seconds; errors stay until dismissed.
4. **Sound:** plays only for decisions and problems.
5. **Desktop notifications:** only when the window is hidden and the item needs a decision.
6. **Placement:** toasts never cover the composer or primary actions. On desktop they sit top-right below the header row; on phones, at the top.
7. **In the cockpit:** a toast is a view of a new Inbox item and links to it.

## 12. Architecture

### 12.1 Two shells, one app

`main.tsx` picks the shell at boot:

- **Choosing:** it reads the local preference `goatcitadel.ui.shell.v1` (`classic` by default, or `cockpit`) and a `?shell=` URL override, which is persisted.
- **Loading:** it dynamically imports `classic-entry.tsx` (today's CSS and app) or `cockpit-entry.tsx` (Tailwind CSS and the cockpit app). The two CSS sets never load together, so switching reloads the page.
- **Shared by both shells:**
  - the gateway access gate
  - the API client and event stream
  - notification policy, status vocabulary, and error descriptions
  - view-model mappers and the page grouping in `route-model.ts`
  - the controller hooks in `@goatcitadel/threaded-surface-core`

### 12.2 Cockpit code layout

`apps/mission-control-next/src/cockpit/`:

- `app/`: shell, routes, providers
- `ui/`: primitives
- `areas/{chat,inbox,work,library,system,settings}/`
- `data/`: query client, query keys, realtime bridge
- `styles/cockpit.css`: Tailwind entry and `@theme` tokens

### 12.3 Styling

- `cockpit.css` is the only file that imports Tailwind. `@theme` maps the tokens from 10.1–10.5.
- Dark mode uses a `data-theme` custom variant; density uses a `data-density` custom variant.
- Cockpit code may not use arbitrary color or size values; a check script enforces this.

### 12.4 Components

Built from dependencies already installed: `radix-ui`, `cmdk`, `react-virtuoso`, `sonner`, `vaul`, `lucide-react`. Any list over 100 rows renders only the visible rows.

### 12.5 Data

- One `QueryClient` with a query-key factory per domain; the default `staleTime` is 30 seconds.
- A realtime bridge maps `deriveRealtimeRefresh` topics to `invalidateQueries`.
- Mutations invalidate their owners' queries.
- Errors pass through `describeApiError` before display.

### 12.6 Size limit

Cockpit files and new shared modules stay at 400 lines or fewer. For cockpit files an ESLint `max-lines` override enforces this; for shared modules it is a review rule.

### 12.7 Inbox Gateway piece

A read-only projection service, route, and event. It respects:

- the architecture-metrics gate (the pinned baseline is never updated; consolidation or an approved allowance is used)
- the async-boundary lane
- the route and service test conventions

Constraints found on 2026-09-27:

- **Template:** follow the route-service port pattern (`apps/gateway/src/services/sessions-list-route-service.ts` plus `gateway-route-services.ts` and `gateway-route-composition-runtime.ts`), not `GatewayService`. A new `*-route-service.ts` raises `routeFacingServiceCount`, which the gate counts as an improvement.
- **GatewayService is already over its limit:** on `origin/main` `gateway-service.ts` is 13,252 lines against a pinned 13,132, so the gate is likely already failing and nothing may be added there.
- **New-file limits:** a new service file starts with a limit of zero host callbacks and zero dependency member accesses. Reading several repositories therefore needs an operator-reviewed entry in `scripts/verification/baselines/architecture-new-service-allowances.json`.
- **Missing sources:** there is no cross-session list of user-input waits and no realtime event for document patch proposals or specialist candidates. The projection reads per-owner sources (see the Phase 3 plan) and polls where no event exists.

## 13. Phase 0: fixes to today's UI

Shared-first rule: logic goes into shared modules the cockpit reuses; only classic layout and CSS work is thrown away at cutover.

| ID | Fix | Home |
| --- | --- | --- |
| F-01 | Notification policy (section 11) | Shared: `realtime-derived.ts`, event stream, shell notifications |
| F-02 | Error descriptions: no raw request errors in visible text | Shared `describeApiError`, used by the composer and pages |
| F-03 | Status vocabulary (10.2); remove raw enums from Chat primitives, tool-effect truth, and Ops Activity | Shared |
| F-04 | Chat space: one header row, change-plan receipts as timeline lines, a single failure presentation, compact composer, no footer strip on Chat | Classic layout plus a shared failure-state selector |
| F-05 | Phone Chat: the conversation is visible | Classic |
| F-06 | Sidebar dead strip | Classic CSS |
| F-07 | Toast placement never covers the composer | Classic CSS |
| F-08 | Page scaffold: description and stats inline, no "Details" disclosures, no duplicated section stats | Classic |
| F-09 | List rows: icon, one-line description, status tone, trust, first item selected, windowed long lists | Shared row mappers plus the classic list primitive |
| F-10 | Providers show per-row connection state | Shared mapper plus classic view |
| F-11 | Trust and policy: windowed, deduplicated labels, blockers visible | Shared mapper plus classic view |
| F-12 | First-run truth: one readiness model, alias follows the selected model, plain copy, correct icon | Shared readiness model plus classic view |
| F-13 | Ops Activity: plain event labels, chips sized to content | Shared vocabulary plus classic CSS |
| F-14 | Navigation: Settings to 7 pages, Library to 5, Ops to 6 (pages group existing section routes as tabs, no URL changes); Approvals first in Ops with its badge hidden at zero | `route-model.ts` groups plus classic nav |
| F-15 | Breakpoints: 31 values become 4, with a check script | Classic CSS |
| F-16 | Type sizes: fold the one-off `clamp()` headings into tokens, make `var()` fallbacks consistent, and tighten the existing typography check so `clamp()` is only allowed inside token definitions | Classic CSS plus the existing check script |
| F-17 | Split oversized files: `MissionThreadedControllerHost` (reused by the cockpit Chat), `RuntimeRoutePage`, `ProvidersSection`, `SettingsNativePage` | Shared and classic |
| F-18 | Earlier-review leftovers, checked on 2026-09-27. Still present, fixed here: result-count pluralization and sub-nav `aria-current`. Already fixed on `origin/main`: spend chart label clipping (commit `20130d2d8`) and composer palette row contrast (commit `2e70af646`). Chat's Ctrl+K behavior is defined by the 1.0 contract (`unifiedComposerPaletteV1Enabled`), so it changes only with the contract at cutover | Classic |
| F-19 | UX budget verification lane | Shared tooling, runs against both shells |

## 14. Quality gates

A new `verify:ux:budgets` lane uses Playwright against an isolated runtime and checks:

- Chat message scroller at least 60% of the height at 1440×900 and at least 55% at 390×844
- zero toasts 5 seconds after a cold load, on every route
- no horizontal document overflow
- visible text free of snake_case enum values, `/api/` paths, and ULID or UUID-like IDs outside monospace technical slots
- zero serious or critical accessibility violations

Static checks join the existing `scripts/check-mission-control-next-*.mjs` family (each with a `node:test` file, wired into `apps/mission-control-next/package.json` `perf:check`):

- `check-mission-control-next-breakpoints.mjs` (new): classic CSS uses only 640, 1024, 1280, and 1600 after F-15
- `check-mission-control-next-typography.mjs` (existing, tightened): font sizes come only from tokens; `clamp()` only inside token definitions
- `check-mission-control-next-cockpit-classes.mjs` (new): no arbitrary Tailwind values in cockpit code

File size for cockpit code uses the existing ESLint `max-lines` rule (`eslint.config.mjs`, blocking through `--max-warnings 0`) with a stricter override of 400 lines for `apps/mission-control-next/src/cockpit/**`. Accessibility checks reuse `axe-core`, already a root devDependency injected by the `accessibility-smoke` lane, so no new dependency is needed.

Visual baselines:

- the existing classic manifest routes
- a cockpit component gallery
- each cockpit area in both themes

Baselines are regenerated through the visual-rebaseline workflow, which is all-or-nothing.

Unit and component tests cover every new shared module and cockpit primitive.

## 15. Phases

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| 0a | Guardrail lane, notification policy, error descriptions, status vocabulary | Lane runs; zero toasts on load; no raw errors or enums on the reviewed routes |
| 0b | Chat and shell fixes | Chat at least 60% (desktop) and 55% (phone); sidebar and toast defects gone |
| 0c | Pages, lists, and setup fixes | Every list row has a description and status tone; trust windowed; setup consistent |
| 0d | Navigation and CSS system | 7 Settings pages; at most 6 sub-pages per area; 4 breakpoints; 7 type sizes; oversized files split; rebaselined |
| 1 | Cockpit foundations: entry split, Tailwind tokens, primitives, query layer, shell skeleton, Ctrl+K, inspector host, phone tab bar, gallery | Switching shells works; the gallery renders in both themes; the lane (including axe) passes on the cockpit skeleton. Cockpit screenshot baselines start in Phase 2 |
| 2 | Cockpit Chat | Parity gate (7.7) met; budget met |
| 3 | Inbox plus Gateway projection | Every kind listed and actionable; counts consistent across surfaces |
| 4 | Library catalog | Trust matrix and duplicate tool lists retired in the cockpit |
| 5 | Work | Board, history, schedules, run page |
| 6 | System | Health, spend, quality, diagnostics, activity, dashboards |
| 7 | Settings | Seven pages built with cockpit primitives, plus search |
| 8 | First run | Fresh install to first answer in under 3 minutes |
| 9 | Cutover | Cockpit is the default; docs, contract, and manifest updated; classic removed one release later together with its CSS |

## 16. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Double maintenance during migration | Shared-first rule; after Phase 0 the classic shell only receives fixes |
| Chat parity gaps | The parity gate blocks the default flip |
| Concurrent sessions and upstream churn | One branch per phase in its own worktree off the latest `origin/main`; re-check `HEAD` before each commit; never `git stash` |
| Visual rebaseline is all-or-nothing | Rebaseline once at the end of each phase through the workflow |
| Tailwind reset leaking into the classic shell | The entry split means the two CSS sets never load together |
| Architecture-metrics gate on the Inbox service | Design for consolidation; never run the baseline update |
| Docs drifting from implementation | Route changes and docs change in the same PR; contract nav wording changes only at cutover |
| Personal paths in tracked docs | Repo hygiene gate; plans use repo-relative paths only |

## 17. Success metrics

| Metric | Today | Target |
| --- | --- | --- |
| Chat message area at 1440×900 | 28% | at least 60% |
| Chat message area at 390×844 | 0% | at least 55% |
| Top-level areas / total destinations | 5 / 44 | 5 / about 20 |
| Toasts after a cold load | 15 (grouped ×12 and ×3) | 0 |
| Clicks to an approval from anywhere | Varies; Approvals is below the fold | 2 (1 in context) |
| Fresh install to first answer | Not measured | under 3 minutes |
| CSS lines | 28,101 | under 10,000 after cutover |
| Distinct breakpoints | 31 | 4 |
| Serious accessibility violations | Not measured | 0 |
