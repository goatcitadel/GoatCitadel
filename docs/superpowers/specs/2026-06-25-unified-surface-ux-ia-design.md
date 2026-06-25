# Unified "Chat" Surface — UX / IA Layer Design

- **Date:** 2026-06-25
- **Status:** Approved (design); pending implementation plan
- **Drives:** [goatcitadel/GoatCitadel#136](https://github.com/goatcitadel/GoatCitadel/issues/136) — "Promote Citadel further"
- **Umbrella spec (inherits locked decisions D1–D6):** [`2026-06-24-unified-surface-auto-router-design.md`](./2026-06-24-unified-surface-auto-router-design.md)
- **Builds on (merged):** [#146](https://github.com/goatcitadel/GoatCitadel/pull/146) Phase 1A gateway auto-router · [#147](https://github.com/goatcitadel/GoatCitadel/pull/147) Phase 2 LLM-judge + override learning · [#148](https://github.com/goatcitadel/GoatCitadel/pull/148) Phase 1B core (chat surface auto-routes)
- **Sibling spec (the other half of #136, separate thread):** [`2026-06-25-workspace-citadel-capability-scoping-design.md`](./2026-06-25-workspace-citadel-capability-scoping-design.md) — workspace/citadel *ownership* of skills/plugins/MCP. Complementary, **zero file overlap** with this design.
- **Author:** design session (brainstorming)

> File/line anchors below come from a read-only exploration of the codebase and are **approximate** — verify at implementation time.

---

## 1. Problem & goal

The auto-router *plumbing* is merged (#146/#147/#148): the gateway classifies a new thread into chat/cowork/code when the client sends `autoRoute: true` with no explicit `mode`, persists the resolved mode to `chat_session_prefs`, records overrides as learning signals, and the **"Chat" surface is already unlocked** (`lockSurface={false}`) so it auto-routes new threads and lists all-mode threads.

What is missing is the **UX / IA layer** that was deferred from Phase 1B because it needs design + visual iteration. Today chat/cowork/code are still **three separate top-level nav areas**; cowork/code are still locked; the conversation header shows a static mode label plus "Open in Code / Continue in Cowork" buttons that jump between those locked areas; and there is no in-surface way to see or override the resolved mode, and no pre-send signal of where a new thread will route.

**Goal:** collapse chat/cowork/code into **one auto-routing conversation surface** (kept under the existing Citadel → Workspace hierarchy) that (a) presents as a single nav entry with a **mode-adaptive rail**, (b) shows the resolved mode in an **in-surface chip with 1-click override**, and (c) gives a **pre-send "→ mode" preview** plus a guard on the expensive code path — all by wiring the already-merged engine, with one small new read-only gateway endpoint.

### Key insight that shapes this design

The unlocked "Chat" surface on `main` is already ~80% the unified surface. Most "aux tooling" already has a home: the code workbench's preview/diff/terminal/files/plan are **in-surface utility panels** (`ThreadedPanelSwitcher`), and artifacts/memory/files/runtime/approvals/prompt-packs are **cross-links** to Library/Ops. The only genuinely mode-specific *routes* that need a new home are Cowork's **Task Board** (`/cowork/tasks`) and **Agent Board** (`/cowork/board`). And the code+unbound bind prompt **already exists post-route** (`codeModeNeedsProjectBinding` → workbench "Unbound" chip + reprioritized binding panel, `useMissionControlSurfaceState.ts:127`), so only the *pre-send* version is net-new. This makes the work a thin shell layer + one endpoint, not a rebuild.

---

## 2. Decisions (locked this session)

These extend the umbrella spec's D1–D6 (sticky-per-thread mode, hybrid classifier, citadel-scoped learning, route-code-and-prompt-to-bind, mode-chip override, reuse-heavy) — none of those are re-litigated here.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| U1 | Single nav entry name | **"Chat"** (keep) | Least relearning; matches how ChatGPT/Claude use "Chat" as the umbrella even when it codes. Auto-route + chip carry the cowork/code nuance. Avoids "Workspace" (taken by the hierarchy term + the sibling capability-scoping screens). |
| U2 | Rail strategy | **Mode-adaptive rail** (Approach A) | The rail adapts to the active thread's resolved mode — clean and contextual, the faithful read of #136. Rejected: one static all-tools rail (cluttered), minimal-rail-push-to-Ops (buries familiar tools, bigger disruption). |
| U3 | Orphan routes (Task/Agent Board) | **Preserve-and-redirect** | Keep `/cowork/tasks` + `/cowork/board` routes; surface them via the cowork-mode rail. `/cowork` + `/code` roots redirect to `/chat?mode=…`. No native page moves. |
| U4 | Mode→shell bridge | **`mode` as a route field** | A new `AppRoute.mode` field bridges the surface's resolved mode up to the shell so the rail + deep-links stay in sync; satisfies the umbrella spec's "mode becomes a deep-linkable field." |
| U5 | Pre-flight scope | **Code-path + live preview** | New read-only `classify` endpoint powers (a) a live "→ mode" chip preview for all modes and (b) a confirm/connect-project guard before a **code** turn (where a wrong guess is expensive: separate execution backend, unbound = dead end). **Skip** a chat↔cowork low-confidence modal — those correct cheaply via the chip. |
| U6 | Type union | **Keep `cowork`/`code` in `PrimaryArea`** | They still host the Task/Agent Board sub-routes and power redirect parsing. Removing the union members touches too much code for no user-visible benefit. |

---

## 3. Scope

### In scope
- Collapse `chat | cowork | code` from three nav **areas** into one **"Chat"** surface entry; `mode` becomes a route **field**.
- `mode`-adaptive left rail keyed on the active thread's resolved mode.
- Deep-link redirect migration: `/cowork`, `/code` (+ legacy query state) → `/chat?mode=…`; `/cowork/tasks`, `/cowork/board` preserved.
- In-surface **mode chip** (header + composer): shows resolved mode, 1-click override; override sends an explicit `mode` on the next turn (engine already records it).
- New read-only gateway **`classify`** endpoint + client live "→ mode" preview.
- Code-path pre-send guard: predicted `code` + unbound → connect-project nudge; predicted `code` + low confidence → inline confirm.

### Out of scope (deliberately)
- Workspace/citadel **ownership** of skills/plugins/MCP — the sibling spec / other thread.
- Any change to the merged auto-router engine, the LLM-judge, the learning loop, or the persisted-mode mechanism (consumed as-is).
- A chat↔cowork low-confidence modal (U5).
- Per-turn fluid routing (rejected in umbrella D1).
- Removing `cowork`/`code` from the `PrimaryArea` type (U6).

### Reuse boundary (consume, do not modify)
`shouldAutoRouteSend` + `autoRoute` send path (`useChatOutboundExecution.ts:52,376,732`), the `surfaceMode = lockSurface && surface ? surface : undefined` mechanism (`MissionThreadedControllerHost.tsx:912`), `codeModeNeedsProjectBinding` + binding flow, `SurfaceRouterService` heuristic path (#146), runtime-decision traces, improvement signals (#147).

---

## 4. Architecture overview

```
TOPBAR  [Chat]  Projects  Library  Ops  Settings        (one entry replaces chat/cowork/code)
   |
   |  AppRoute.mode (new field) ── bridges resolved mode ⇄ shell
   v
LEFT RAIL  buildModeRail(route.mode)                     mode-adaptive (chat | cowork | code)
   |
   v
THREADED SURFACE (already unlocked, surface="chat", lockSurface={false})
   |                         ^                         ^
   | new thread, no mode     | resolved mode (post-turn prefs)   | user picks chip → explicit mode
   v                         |                         |
useChatOutboundExecution ──► gateway in-turn auto-router (MERGED: trace + persist + learn)
   |
   |  (pre-send, debounced)
   └─► POST /api/v1/surface/classify  ──► SurfaceRouterService.classify() [READ-ONLY: no trace, no persist]
            └─ { mode, confidence, source, rationale } → chip live preview + code-path guard
```

Downstream mode-keyed machinery (orchestration router, workflow template, mode doctrine, tool filter, code sandbox) is **untouched** — it still receives a resolved `mode` exactly as today.

---

## 5. Components

### 5.1 Route model (`apps/mission-control-next/src/app/route-model.ts`)
- **`AppRoute.mode?: ChatMode`** — new optional field (the surface↔shell bridge).
- **`PRIMARY_NAV`** (in `MissionControlNextApp.tsx:100`) drops `cowork` + `code`; one `chat` entry.
- **`parseAppRoute` / `normalizeAppRoute`** — `/cowork`(root/workspace) → `{area:"chat", mode:"cowork"}`; `/code` → `{area:"chat", mode:"code"}`; preserve `sessionId`/`turnId`/`artifactId`. `/cowork/tasks`, `/cowork/board` keep their `{area:"cowork", section}` shape.
- **`buildAppHref`** — `area:"chat"` with `mode` ≠ `chat`/undefined → `/chat?mode=<mode>` (canonical); `mode` serialized as a query param.
- **`buildModeRail(mode)`** — replaces the static `RAIL_ITEMS.chat` for the unified area: chat→`Artifacts`,`Memory`; cowork→`Task Board`(→`/cowork/tasks`),`Agent Board`(→`/cowork/board`); code→`Files`,`Runtime`,`Prompt Packs`; `Approvals` always. Each item keeps the existing `RailItem` cross-link shape (`buildNavigationTarget`).

### 5.2 Shell wiring (`apps/mission-control-next/src/app/MissionControlNextApp.tsx`)
- Topbar nav renders only the collapsed entry set.
- The rail uses `buildModeRail(route.mode)` for the chat area (other areas unchanged); `routeKicker`/breadcrumb derive from the resolved mode.
- **Bridge:** `renderRouteContent` passes an `onModeResolved(mode)` callback to the threaded surface that does `navigate({ ...route, mode }, { replace: true })`; the existing per-surface jump callbacks (`onOpenCowork`/`onOpenCode`/`onNavigateSurface`) collapse into chip overrides (set client mode) rather than area jumps.
- **Mount redirect:** `resolveRouteFromLocation` already runs `parseAppRoute`, so old `/cowork|/code` URLs normalize on load; no extra redirect handler needed beyond the parse rules.

### 5.3 Mode chip (`ThreadedSurfacePage.tsx` header + `ThreadedComposer.tsx` kicker)
- Replace the static `MODE_META[surface].label` (`ThreadedSurfacePage.tsx:705`) and the "Open in Code/Cowork/Back to Chat" action list (`:665-678`) with an interactive **mode chip** (dropdown: Chat / Cowork / Code), mirrored compactly in the composer kicker (`ThreadedComposer.tsx:679`, `getSurfaceLabel`).
- Resolved-thread chip → shows current mode; pick another → sets client `surfaceMode` override → next turn sends explicit `mode` (autoRoute off) → engine records the override → prefs/rail refresh.
- New-thread chip → shows **Auto** + live "→ mode" preview from §5.5.

### 5.4 Surface controller (`packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`)
- Expose the resolved `currentSessionMode` (`:952-957`) upward via `onModeResolved`.
- Add a client-side **mode override** state that, when set, feeds the explicit `mode` on the next send and is cleared when the thread re-pins. (The override→explicit-send mechanism already exists for locked surfaces; here it becomes user-driven.)
- Wire the §5.5 classify hook for new threads.

### 5.5 `classify` endpoint (gateway, new — read-only)
- **`POST /api/v1/surface/classify`** → `SurfaceRouterService.classify({ text, citadelId, workspaceId, hasBoundProject })` → `{ mode, confidence, source, rationale }`. Reuses the **heuristic path** from #146; **no** `routing_choice` trace, **no** persistence (this is a preview; the in-turn path remains the system of record).
- Contract: `ClassifySurfaceRequest` / `ClassifySurfaceResponse` in `packages/contracts`.
- Client hook (`threaded-surface-core`): debounced call as the user types in a new thread (no persisted mode); drives the chip preview, the send-button label, and the code-path guard. **Fail-open:** any error/timeout → no preview, normal in-turn auto-route; never blocks typing or send.

---

## 6. Data flow

### New thread (auto-route + live preview)
1. User types in the unified surface (no mode yet). Debounced `classify` → chip shows "→ Code" (etc.) + send label adapts.
2. Send: `shouldAutoRouteSend` true → request carries `autoRoute:true`, omits `mode` (unchanged engine path).
3. Gateway classifies in-turn, records the `routing_choice` trace, persists `chat_session_prefs.mode`.
4. Post-turn prefs refetch → `currentSessionMode` resolves → `onModeResolved` sets `route.mode` → rail + chip reflect it.

### Override
1. User opens the chip, picks a different mode → client `surfaceMode` override set; `route.mode` updates (rail switches immediately).
2. Next turn sends explicit `mode` (autoRoute off) → gateway re-pins prefs + records the override signal (existing #147 path).

### Code-path guard (pre-send)
1. `classify` predicts `code`. If no bound project → "Connect a project" nudge before send (reuse `codeModeNeedsProjectBinding` + binding flow); decline → send as chat for that turn.
2. If predicted `code` with confidence < threshold → inline "Run as Code?" confirm before send. Chat/cowork predictions → send straight through.

### Deep-link / redirect
1. `/code?sessionId=…` → `parseAppRoute` → `{area:"chat", mode:"code", sessionId:…}`; the surface opens that thread with `route.mode=code`, so the rail + chip resolve to code. `/cowork/tasks` opens the Task Board route (unchanged).

---

## 7. Data model & persistence

**No new tables, no migrations.** New surface only:
- `AppRoute.mode?: ChatMode` (client route state; serialized as `?mode=` query param).
- `ClassifySurfaceRequest`/`Response` contracts (read-only DTO; no storage).
- A confidence-threshold constant for the code-path confirm (client + endpoint agree).

The sticky mode stays in `chat_session_prefs.mode`, written by the existing in-turn path. The chip override reuses the existing explicit-`mode` send + the #147 override-signal recording. **Note:** `chat_session_prefs.mode` defaults to `"chat"` (no "unset" sentinel) — auto-route remains gated by the `autoRoute` flag + omitted `mode`, never by a null mode.

---

## 8. Error handling & edge cases

| Case | Behavior |
|------|----------|
| `classify` fails/times out | No preview, no guard; normal in-turn auto-route. Never blocks typing/send. |
| Override on an in-flight thread | Last-write-wins on thread mode; takes effect on the next send (sticky-per-thread, umbrella D1). |
| Code predicted, project already bound | No nudge; send straight through (umbrella D4). |
| Code predicted + unbound, user declines | Send as chat for that turn (umbrella D4 / §6). |
| Deep-link to `/cowork/tasks` | Opens Task Board route unchanged (preserve-and-redirect, U3). |
| Rail mode with no active thread | Defaults to the chat-mode rail (the New-thread state). |
| Stale `route.mode` vs resolved mode | `onModeResolved` reconciles after each turn (resolved mode is source of truth). |

---

## 9. Testing strategy

- **Unit (route-model):** `mode` field round-trips through `parseAppRoute`/`buildAppHref`; `/cowork`→`mode:cowork`, `/code`→`mode:code` redirects (with preserved session state); `/cowork/tasks` unchanged; `buildModeRail(mode)` returns the right items per mode.
- **Unit (surface):** chip override → next send carries explicit `mode` + autoRoute off; `onModeResolved` updates `route.mode`; classify hook debounce + fail-open; code-path guard (predicted code + unbound → nudge; + low-conf → confirm).
- **Integration (gateway):** `classify` endpoint table-driven (repo path → code, "research/compare" → cowork, greeting → chat); read-only (asserts no trace/persistence side effects).
- **Visual verification (required — UI shell change):** run the app and confirm the three rail states, chip override flow, live "→ mode" preview, and the code bind-nudge via the preview tooling / screenshots — not just unit tests.
- Follow existing TDD conventions + per-package setup (mc-next + threaded-surface-core vitest; gateway vitest). Fresh worktree needs `pnpm install` + `build:deps` before shell tests resolve shared `dist`.

---

## 10. Phasing / build order (each independently shippable)

- **P1 — collapse (pure UI):** `AppRoute.mode`, collapsed `PRIMARY_NAV`, redirect parsing, `buildModeRail`, the surface↔shell bridge, and the mode chip override (no endpoint). Ships the #136 headline "one surface" win and exercises the merged auto-router end-to-end.
- **P2 — pre-flight (endpoint + smart guards):** `classify` endpoint + contracts, client live preview, code-path confirm/connect-project guard.

---

## 11. Open questions / risks

- **Confidence threshold for the code confirm** — pick an initial constant shared by endpoint + client; tune from real `routing_choice` traces. (Implementation detail.)
- **`classify` heuristic reuse** — confirm exactly which `SurfaceRouterService` internals are cleanly callable read-only vs. need a small extracted helper (the in-turn path also writes a trace; the preview path must not).
- **Rail churn UX** — switching between threads of different modes shifts rail contents; verify it reads as contextual, not jarring, during visual review.
- **Breadcrumb/release-scope metadata** — `ROUTE_RELEASE_SCOPE` + `routeKicker` assume area/section; confirm the `mode` field threads through kicker derivation without breaking release-surface tests.

---

## 12. Related work

- **#136** — parent ("Promote Citadel further").
- **Umbrella spec** `2026-06-24-unified-surface-auto-router-design.md` — the overall effort + locked D1–D6.
- **#146 / #147 / #148** — merged auto-router engine this layer consumes.
- **Sibling spec** `2026-06-25-workspace-citadel-capability-scoping-design.md` — workspace/citadel ownership (the other half of #136), independent thread.
