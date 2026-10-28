# Capabilities Hub Phase 2 (Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tools tab to the Capabilities area. It shows the built-in tools in 14 plain-named groups, each with a switch, a risk label and a call count, plus a "Most used" row. Switching a group off stops the AI using those tools on every surface.

**Architecture:**
- A group map in `@goatcitadel/contracts` puts every registry tool in exactly one group.
- Switched-off groups are stored in the tool policy config (`tools.disabledGroups`). The policy engine denies them before every other rule, under a reason code of their own, so the change reaches Chat, scheduled turns, durable runs, MCP server mode, remote workers and Code Mode at once.
- GoatCitadel's own deliveries carry a process-local marker that lets them past that one check. Those are channel replies, the operator's own sends, and Library and attachment actions.
- A switch saves through the existing Settings save. The change is a new `tool_group_access` Change Plan operation, so it inherits #572's approval skip and the plan history is its audit record.
- Two new Gateway routes serve the tab, and the cockpit renders them and never joins sources:
  - the group list, with each tool's current block reason probed through the engine
  - 365-day call counts read from `chat_tool_runs`, cached for 10 minutes

**Tech Stack:** TypeScript, React 19, TanStack Query, Tailwind (cockpit tokens), Fastify, zod, Vitest, SQLite and Postgres storage.

**Spec:** `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md` (sections "Tools tab", "Constraints", "Existing pages", "Left to the builder", "Claude's calls"). Phase 1's plan, `2026-10-25-capabilities-hub-phase-1.md`, built the area this plan extends.

**Measured facts:** `.superpowers/sdd/2026-10-27-capabilities-hub-phase-2/phase2-facts.md` (gitignored, in the planning worktree). It has file:line evidence for every claim below, measured on `main` at `2bf5044aa`.

## Decided by the operator (2026-10-27)

The operator answered both questions with the recommended option: "Q1: A — off stops the AI only; channel replies, my own sends and Library actions keep working. Q2: follow #572 for switching back on, as recommended." The tasks below implement those answers. The alternatives are kept for the record.

**Q1. When a group is off, do GoatCitadel's own deliveries still work?** Decided: A.

Some features call tools by name through the same policy engine:
- replies in connected chat apps go through `channel.send`
- Library's knowledge buttons and Chat attachments go through `docs.ingest` and `embeddings.*`
- the operator's own sends from GoatCitadel go through the comms tools

A plain engine deny would switch those off too. For example, turning off Messaging would stop the Telegram bot replying.

- **Recommended (A):** Off stops the AI only. Those own deliveries carry a server-minted marker that lets them past the group switch and nothing else (Task 3).
- **Alternative (B):** Off blocks the tools everywhere. In that case, drop Task 3 and have the panel warn under Messaging, Documents, Memory and Email and calendar.

**Q2. Does turning a group back on ask for approval?** Decided: follow #572 (the recommended option).

The spec's Tools section says "no approval request". Its Constraints section says switching follows #572 and `remote_hardened` always asks. Lifting a deny in Settings › Safety today is a caution or danger Change Plan.

- **Recommended:** Off is a safe plan and never asks. On is a caution plan:
  - It goes straight through when the operator's "skip approval for my own changes" setting is on.
  - It waits in Inbox when that setting is off.
  - It always asks under `remote_hardened`.
- **Alternative:** both directions are safe plans, so On never asks, even under `remote_hardened`. This is a one-row change in Task 5's risk table plus its test row.

## PR boundaries

Each PR is cut from a freshly fetched `origin/main` in its own worktree (superpowers:using-git-worktrees) and merged before the next one starts.

| PR | Tasks | Ships |
|---|---|---|
| 2a | 1–7 | Gateway and policy: the group map, group-off in the engine, own deliveries, what the model is told, the switch save, call counts and the group list route. No UI yet; the save is reachable through `PATCH /api/v1/settings`. |
| 2b | 8–13 | The Tools tab: data layer, tab wiring with the last tab remembered and the `/library/tools` redirect, the switch, rows and Most used, the group panel, public truth, and browser proof. |

## Global Constraints

- Build each PR from a freshly fetched `origin/main`. This plan was written against `2bf5044aa`.
- The Gateway owns every read and write. The cockpit renders `GET /api/v1/capabilities/tools` and `GET /api/v1/capabilities/tools/usage`, and saves through `PATCH /api/v1/settings`. It never computes risk, block reasons or Most used itself, and never merges catalogs (`apps/mission-control-next/AGENTS.md`).
- **Deny-wins.** A switched-off group beats `tools.allow`, allow grants and a local operator override. Switching a group on removes only that group's switch. It never lifts a deny from Settings › Safety, a permission profile, a Citadel Ward or a grant.
- **The Core group and `mcp.invoke` can never be switched off.** The settings owner refuses them, and the engine ignores them even in a hand-edited config. MCP tools belong to their connector. Mesh tools are named `mesh:*` and are never matched by a group.
- **Visible copy follows DESIGN.md.** Sentence case and plain words.
  - Never "posture", "Gateway", "revision", "evidence", "owner", "snapshot", "canonical", "durable", "projection" or "replay" (`scripts/check-mission-control-next-cockpit-copy.mjs`).
  - Counts use `plural()`.
  - Tool names such as `fs.write` are IDs. They appear only in monospace technical slots inside the inspector, never on the page rows.
- Risk reads Safe, Caution, Danger or Nuclear, through `RiskBadge` and `presentRiskLevel`. State always pairs a word with the dot.
- **A count is never made up.** When call counts are missing, the row reads "Calls unknown", never "No calls yet" and never 0. When a block reason can't be read, the row says so rather than "On".
- **GatewayService stays at or under 13132 counted lines.** Measure `apps/gateway/src/services/gateway-service.ts` before and after; the limit is `scripts/verification/baselines/architecture-metrics.json`.
  - New Gateway service files take their sources as plain function readers, the way `capability-connectors-composition.ts` does. Measure each with `countDependencyMemberAccesses` (`scripts/verification/lib/architecture-metrics.mjs`).
  - Any count above 0 in a new file, or any rise in an existing owner's count, means stop and ask the operator for a C0 allowance.
  - Never run `architecture:baseline:update`.
- No new dependencies.
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`). After changing `packages/policy-engine` or `packages/mission-control-shared`, rebuild that package before running dependents' tests; they resolve these from `dist`.
- Run tests at low priority with `--maxWorkers=2`, one heavy job at a time. Storage tests use `TempSqliteFiles`.
- Never `prettier --write` a directory glob, never `git stash`, no personal paths in tracked files.
- Commands:
  - Contracts: `pnpm --filter @goatcitadel/contracts exec vitest run <path> --maxWorkers=2`
  - Policy engine: `pnpm --filter @goatcitadel/policy-engine exec vitest run <path> --maxWorkers=2`
  - Storage: the same pattern with `@goatcitadel/storage`, plus its real-Postgres test pattern (skipped when no Postgres is configured)
  - Gateway: `pnpm --filter @goatcitadel/gateway exec vitest run <path relative to apps/gateway> --maxWorkers=2`. Run it from `apps/gateway` if a config ENOENT appears.
  - Shared: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run <path> --maxWorkers=2`
  - Cockpit: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path relative to the app> --maxWorkers=2`

## Review Focus

1. **Messaging is off and a message arrives on the operator's Telegram bot.** The reply is still delivered. A `telegram.send` the AI calls itself in that same chat is blocked, and the AI is told the group is switched off. *(Task 3)*
2. **The #572 setting is off and the operator switches a group back on.** The row shows "Waiting on you in Inbox" with a link, and the switch stays Off. The tools stay blocked until the approval lands, then the row turns On. A declined approval says so and leaves it Off. *(Tasks 5 and 10)*
3. **A hand-edited config lists `"core"`, `"nope"` or a group under one agent.** Core tools and `mcp.invoke` still run, unknown ids are ignored, and an agent-level list is ignored. The settings save refuses `core` and unknown ids with a plain message. *(Tasks 2 and 5)*
4. **Call history can't be read.** The list still renders. Counts read "Calls unknown". The four-card row shows the essentials under the heading "Essentials", never "Most used", and a Retry is offered. *(Tasks 6 and 11)*
5. **A chat is mid-turn when its group goes off.** The next call to that tool is blocked with the switched-off guidance, not "remove it from tools.deny". An approval granted earlier for that tool does not run it either. *(Tasks 2 and 4)*

---

# PR 2a: Groups, policy, saving and data

### Task 1: Tool group map

**Files:**
- Create: `packages/contracts/src/tool-groups.ts`
- Modify: `packages/contracts/src/index.ts` (export it next to `./tool-catalog.js`)
- Test: `packages/contracts/src/tool-groups.test.ts`
- Test: `packages/policy-engine/src/tool-groups-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export type ToolGroupId =
  | "core" | "files" | "shell_and_code" | "git" | "web_search" | "web_requests" | "browser"
  | "memory" | "documents" | "email_and_calendar" | "messaging" | "webhooks" | "schedules" | "subagents";
export interface ToolGroupDefinition {
  readonly id: ToolGroupId;
  readonly label: string;
  readonly description: string;
  readonly switchable: boolean; // false only for "core"
  readonly toolNames: readonly string[];
}
export const TOOL_GROUPS: readonly ToolGroupDefinition[]; // in the table's order
export const SWITCHABLE_TOOL_GROUP_IDS: readonly [ToolGroupId, ...ToolGroupId[]]; // a tuple, so z.enum accepts it
export const ESSENTIAL_TOOL_GROUP_IDS: readonly ToolGroupId[]; // ["files", "web_search", "memory", "browser"]
export function isSwitchableToolGroupId(value: unknown): value is ToolGroupId;
export function toolGroupForTool(toolName: string): ToolGroupDefinition | undefined;
/** Tool name → its group, for the switchable groups in `disabled`. Core and unknown ids are ignored. */
export function toolNamesSwitchedOff(disabled: readonly string[] | undefined): ReadonlyMap<string, ToolGroupId>;
```

**The map** (105 tools as planned; 101 after #620 retired the four Signal and iMessage tools; exact copy):

| id | label | description | tools |
|---|---|---|---|
| core | Core | GoatCitadel needs these to run chats and connectors, so they stay on. | capabilities.search, skills.read, tool_artifact.read, change.request, runtime.configure, session.status, session.search, session.history, user_input.request, submit_work_result, time.now, context.list, context.grep, context.query, context.read_range, mcp.invoke |
| files | Files | Read, search, write, move and delete files in your folders. | fs.read, fs.list, fs.stat, fs.write, fs.patch, fs.copy, fs.move, fs.delete, file.read_range, file.find, code.search, code.search_files |
| shell_and_code | Shell and code | Run shell commands and your project's test, lint and build scripts. | shell.exec, shell.exec_background, tests.run, lint.run, build.run |
| git | Git | See changes, commit, and manage branches and worktrees. | git.status, git.diff, git.add, git.commit, git.branch.create, git.branch.switch, git.worktree.create, git.worktree.remove |
| web_search | Web search | Search the web, research local businesses and build citations. | browser.search, local_business.research, citations.build |
| web_requests | Web requests | Fetch web pages and send data to web addresses directly. | http.get, http.post |
| browser | Browser | Open and read pages, take screenshots, click, and manage cookies and storage. | browser.navigate, browser.extract, browser.screenshot, browser.interact, browser.cookies.get, browser.cookies.set, browser.cookies.clear, browser.storage.get, browser.storage.set, browser.storage.clear, browser.context.configure |
| memory | Memory | Read, search and save what the AI remembers. | memory.read, memory.search, memory.write, memory.upsert |
| documents | Documents | Index and search your documents, and create documents, slides and artifacts. | docs.ingest, docs.search, embeddings.index, embeddings.query, artifacts.create, documents.create, presentations.create, document.propose_patch |
| email_and_calendar | Email and calendar | Read and send email, and read and add calendar events. | gmail.read, gmail.send, smtp.send, calendar.list, calendar.create_event |
| messaging | Messaging | Send, react to and remove messages in your chat apps, and ask for your attention. | notify.request, channel.send, channel.react, channel.unsend, discord.send, discord.react, discord.unsend, line.send, mattermost.send, mattermost.react, mattermost.unsend, nextcloud-talk.send, nextcloud-talk.react, telegram.send, telegram.react, telegram.unsend, whatsapp.send, whatsapp.react, slack.send, slack.react, slack.unsend, google-chat.send, teams.send, zalo.send |
| webhooks | Webhooks | Send data to your webhooks. | webhook.send |
| schedules | Schedules | Set up and cancel the AI's own scheduled work. | schedule.manage |
| subagents | Subagents | Hand parts of a task to up to three subagents. | agent.fanout |

The constants `CHANGE_REQUEST_TOOL_NAME`, `RUNTIME_CONFIGURE_TOOL_NAME`, `SUBMIT_WORK_RESULT_TOOL_NAME` and `SUBAGENT_FANOUT_TOOL_NAME` resolve to `change.request`, `runtime.configure`, `submit_work_result` and `agent.fanout`. The contracts file uses the literal strings.

- [ ] **Step 1: Write the failing contracts tests:**
  - `it("lists 14 groups with unique ids, and only Core can't be switched off")`.
  - `it("puts no tool in two groups")`.
  - `it("keeps mcp.invoke and the session tools in Core")`.
  - `it("ignores Core and unknown ids when switching off")`: `toolNamesSwitchedOff(["core", "files", "nope"])` has `fs.read → "files"`, lacks `session.status` and `mcp.invoke`, and its size equals the Files tool count.
- [ ] **Step 2: Write the failing registry test** `tool-groups-registry.test.ts`:
  - `it("puts every registry tool in exactly one group")` over `createDefaultToolRegistry().list()`.
  - `it("names no tool the registry lacks")`.
- [ ] **Step 3: Run both and confirm they fail** (module not found).
- [ ] **Step 4: Implement the file, then rebuild contracts.** Run both tests (PASS).
- [ ] **Step 5: Commit:** `feat(contracts): add the tool group map`.

### Task 2: Switched-off groups in the policy engine

**Files:**
- Modify: `packages/contracts/src/policy.ts`
  - Add `disabledGroups?: string[]` to `ToolPolicyConfig.tools`. It is install-wide; the resolver ignores it under `agents[*]`.
  - Add `switchedOffTools?: ReadonlyMap<string, ToolGroupId>` to `EffectiveToolPolicy`.
- Modify: `packages/contracts/src/config-schemas.ts`: the tool policy schema accepts `disabledGroups: z.array(z.string().max(64)).max(32).optional()`. Unknown ids load and are ignored, so a hand edit can't stop the install from starting.
- Modify: `packages/policy-engine/src/policy-resolver.ts`
  - `resolveEffectivePolicy` fills `switchedOffTools` from `config.tools.disabledGroups` only, through `toolNamesSwitchedOff`.
  - `isToolAllowed` returns false for a switched-off tool.
- Modify: `packages/policy-engine/src/engine.ts`
  - In `evaluateAccessInternal`, before the `denySet` gate (~:1217): if any name in `toolNames` is in `policy.switchedOffTools`, return `deny(riskLevel, "tool_group_off", \`tool ${request.toolName} is in a tool group switched off by the operator (${groupId})\`)`.
  - The phrase "tool group switched off" is what Task 4 matches on.
  - Add `public listSwitchedOffToolNames(): ReadonlySet<string>`, read from the live `this.config`.
- Test: `packages/policy-engine/src/tool-group-policy.test.ts`

- [ ] **Step 1: Write the failing tests** (engine on an in-memory storage fixture, as `engine.test.ts` builds it):
  - `it("denies a tool in a switched-off group with tool_group_off")`.
  - `it("still denies it under a local operator override, an allow grant and tools.allow")`.
  - `it("ignores Core and unknown ids")`: with `disabledGroups: ["core", "nope"]`, `session.status` and `mcp.invoke` are allowed.
  - `it("ignores disabledGroups set for one agent")`.
  - `it("keeps policy_deny for a tools.deny entry while the group is on")`.
  - `it("takes effect on the next call when the live config changes")`: the test mutates `config.tools.disabledGroups` in place and evaluates twice.
  - `it("never matches a native MCP tool or a mesh tool")`: every switchable group is off, and an MCP-bound call (reuse the binding helper in `mcp-named-policy.test.ts`) does not get `tool_group_off`.
  - `it("blocks an approved action whose group was switched off after approval")`, through `executeApprovedAction`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it, then rebuild contracts and policy-engine.**
- [ ] **Step 4: Run the new file plus** `src/engine.test.ts` **and** `src/mcp-named-policy.test.ts` **(PASS).**
- [ ] **Step 5: Commit:** `feat(policy): switch off tool groups in the policy engine`.

### Task 3: GoatCitadel's own deliveries keep working (Q1: A, decided)

**Files:**
- Create: `packages/policy-engine/src/own-delivery.ts`. Export it from the package index.
- Modify: `packages/policy-engine/src/engine.ts`: add `ownDelivery?: OwnDeliveryMarker` to `ToolPolicyEvaluateOptions`. A genuine marker skips **only** Task 2's check.
- Modify: `apps/gateway/src/services/tool-invocation-coordinator-service.ts`
  - Add `ownDelivery?: OwnDeliveryMarker` to `ToolInvocationRuntimeOptions`.
  - Forward it into both the `policyEngine.invoke` options (~:1444-1451) and the access evaluation in the same call (~:927).
- Modify: the `invokeAndUnwrap(request, realtimeType)` host method used by `comms-service.ts` (`invokeCommsTool`, :136) and `memory-facade-service.ts`
  - Add a third parameter, `options?: { ownDelivery?: OwnDeliveryMarker }`.
  - Thread it through GatewayService's implementation into `invokeTool`.
- Modify: `apps/gateway/src/services/comms-service.ts`
  - Add `ownDelivery?: true` to the send, Gmail-send and calendar-create inputs.
  - When it is true, `invokeCommsTool` passes `createOwnDeliveryMarker("channel_reply")` for channel sends and `createOwnDeliveryMarker("operator_action")` for the rest.
- Modify: `apps/gateway/src/services/memory-facade-service.ts`: every facade call passes `createOwnDeliveryMarker("operator_action")`. The facade serves only the Library knowledge routes and Chat attachments. The AI's own `docs.ingest` and `memory.*` calls go through the coordinator, never the facade.
- Modify the callers that set `ownDelivery: true`, server-side only:
  - the inbound reply in `gateway-service.ts` (~:5063-5082, the `deliveryInput` object)
  - the compose path in `chat-turn-dispatch-service.ts` (~:1104)
  - `routes/comms.ts` at :210, the Gmail send (~:328) and the calendar create (~:344), set after the strict body parse
  - **Not** the approved-action delivery in `connector-delivery.ts`. That send was the AI's, so it stays subject to the switch.
- Create: `apps/gateway/src/services/own-delivery-mint-guard.test.ts`, mirroring `mcp-approval-relief-mint-guard.test.ts`. `createOwnDeliveryMarker(` may appear only in `comms-service.ts`, `memory-facade-service.ts` and `packages/policy-engine/src/own-delivery.ts`, plus tests.
- Test: `packages/policy-engine/src/own-delivery.test.ts`, plus Gateway tests next to the existing inbound channel reply tests (find them with `git grep -l "system-integration-reply" -- apps/gateway/src`).

**Interfaces:**
- Produces:

```ts
export type OwnDeliveryReason = "channel_reply" | "operator_action";
export interface OwnDeliveryMarker { readonly kind: "own_delivery"; readonly reason: OwnDeliveryReason }
/** A frozen marker registered in a module-private WeakSet; only registered objects count. */
export function createOwnDeliveryMarker(reason: OwnDeliveryReason): OwnDeliveryMarker;
export function isOwnDeliveryMarker(value: unknown): value is OwnDeliveryMarker;
```

**GatewayService line budget.** If setting `ownDelivery: true` on the reply's `deliveryInput` pushes `gateway-service.ts` over 13132 counted lines, move that object's construction into a pure helper, `buildChannelReplyDeliveryInput(...)` in a new `apps/gateway/src/services/channel-reply-delivery-input.ts`, which takes primitives and returns the object. Measure the new file (expected 0 dependency reads).

- [ ] **Step 1: Write the failing tests:**
  - Engine: `it("lets a minted own-delivery marker past a switched-off group and nothing else")`. A minted marker is allowed. A look-alike `{ kind: "own_delivery", reason: "channel_reply" }` still gets `tool_group_off`. A minted marker plus a `tools.deny` entry still gets `policy_deny`.
  - Gateway: `it("delivers an inbound channel reply while Messaging is off")`.
  - Gateway: `it("blocks the AI's own telegram.send while Messaging is off")`.
  - Gateway: `it("blocks an approved AI channel send after Messaging is switched off")`.
  - Gateway: `it("runs Library knowledge actions while Documents is off")`.
  - Route: `it("rejects ownDelivery in a comms request body")` (400).
  - The mint guard.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild policy-engine, measure GatewayService lines, and run `countDependencyMemberAccesses` on any new file.
- [ ] **Step 4: Run the tests (PASS), plus** `pnpm verify:gateway:async-boundary` **(PASS).**
- [ ] **Step 5: Commit:** `feat(policy): keep GoatCitadel's own replies and Library actions working when a group is off`.

### Task 4: What the model and outside clients are told

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-agent-runner/tool-failure-messaging.ts`
  - In `buildGovernanceBlockGuidance`, before the "tool denied by policy" branch, match an error that includes "tool group switched off".
  - The guidance reads: `${tool} is switched off: the operator turned off its tool group in Capabilities › Tools. ${OPERATOR_BOUNDARY_NEXT_STEP} Only the operator can switch that group back on; tell them which tool you needed.`
- Modify: `apps/gateway/src/services/base-prompt-capability-catalog.ts` (`filterBasePromptToolsetByPolicy`): record tools whose probe has `reasonCodes` containing `"tool_group_off"` as `switchedOffToolNames`, alongside `policyDeniedToolNames`.
- Modify: `apps/gateway/src/services/base-agent-system-prompt.ts`
  - Add `switchedOffToolNames?: readonly string[]` to `BaseAgentPromptToolset`.
  - In `buildWriteAndRunPolicySection`, when `fs.write` is switched off rather than denied, replace the "set fs.write to Available" line with "To allow file writes, the operator switches the Files tools back on in Capabilities › Tools."
  - When `shell.exec` is switched off, the line reads "To allow shell commands, the operator switches the Shell and code tools back on in Capabilities › Tools."
- Modify: the MCP server-mode manifest (`routes/mcp.ts` ~:208-213 and `services/mcp-server-mode.ts` ~:15): leave out tools in `policyEngine.listSwitchedOffToolNames()`.
- Modify: the Code Mode wrapper list in `capability-system-service.ts` (~:3955-3970) the same way.
- Test: `tool-failure-messaging.test.ts`, `base-agent-system-prompt.test.ts`, `base-prompt-capability-catalog.test.ts`, the server-mode route test, `capability-system-service` Code Mode wrapper tests

- [ ] **Step 1: Write the failing tests:**
  - `it("tells the model a switched-off group is the operator's switch, not tools.deny")`.
  - `it("reports switched-off tools apart from denied ones")`.
  - `it("points at Capabilities › Tools when Files is switched off")`, with the Settings line absent.
  - `it("leaves switched-off tools out of the server-mode tool list")`.
  - `it("leaves switched-off tools out of Code Mode wrappers")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Re-measure the dependency counts of `capability-system-service.ts` and the server-mode owner. If either rose, stop and ask (Global Constraints).
- [ ] **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Commit:** `feat(chat): explain switched-off tool groups and keep them out of outside tool lists`.

### Task 5: Saving a group switch

**Files:**
- Modify: `packages/contracts/src/tool-groups.ts`: add `export interface ToolGroupChange { readonly groupId: ToolGroupId; readonly enabled: boolean }` and `isToolGroupChange(value)`. It accepts exactly those two keys and switchable ids only.
- Modify: `packages/contracts/src/operator-write-access.ts`: add `| ({ readonly operation: "tool_group_access" } & ToolGroupChange)` to `RuntimeWriteAccessOperation` (:50) and to `isRuntimeWriteAccessOperation` (:78). `change-plan.ts`'s default branch (~:837) then accepts it.
- Modify: `apps/gateway/src/routes/operator-write-access-schemas.ts`: add `toolGroupChangeFields = { groupId: z.enum(SWITCHABLE_TOOL_GROUP_IDS), enabled: z.boolean() }` and `toolGroupChangeSchema`, strict.
- Modify: `apps/gateway/src/routes/dashboard.ts` (:129): add `toolGroupChange: toolGroupChangeSchema.optional()`.
- Modify: `apps/gateway/src/routes/dashboard-settings-change-plan.ts`: map `toolGroupChange` to `{ operation: "tool_group_access", ...change }`, mirroring `globalToolAccessChange` (:21, :108-112).
- Modify: `apps/gateway/src/routes/change-plans.ts` (:261): add the strict `tool_group_access` option.
- Modify: `apps/gateway/src/services/settings-operator-write-access.ts`
  - `applyToolGroupChange(toolPolicy: ToolPolicyConfig, change: ToolGroupChange): void`. It throws `ValidationError` for a non-switchable id, and writes `tools.disabledGroups` as a unique list in `TOOL_GROUPS` order.
  - `projectSwitchedOffToolGroups(toolPolicy): ToolGroupId[]`, returning switchable known ids only.
- Modify: `apps/gateway/src/services/settings-auth-service.ts`
  - Add the input field (:310).
  - Apply it with the other write-access changes (:551-555).
  - Project it (:218).
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts` (:29): add `switchedOffToolGroups: readonly ToolGroupId[]`.
- Modify: `packages/mission-control-shared/src/api/types.ts` (:439): add `switchedOffToolGroups?`.
- Modify: `packages/mission-control-shared/src/api/settings-operations.ts` (`patchSettings`, :61): add `toolGroupChange?: ToolGroupChange`.
- Modify: `apps/gateway/src/services/runtime-write-access-change.ts`: add `describeToolGroupChange(change, settings)` and `matchesToolGroupChange(change, settings)`.
- Modify: `apps/gateway/src/services/runtime-configuration-change-plan-adapter.ts`
  - the owner validation list (:324)
  - `settingsPatch` (:407)
  - `matches` (:461)
  - `targetResourceId` (:478), which gives `tool_group_access:<groupId>`
  - `describe` (:626)
- Test: `settings-operator-write-access.test.ts`, `runtime-configuration-change-plan-adapter.test.ts`, the dashboard settings route test, the contracts `tool-groups.test.ts`

**Risk and copy.** These titles show in Inbox, so they are visible copy:

| Change | Risk | Title | Completed summary |
|---|---|---|---|
| Off | safe | Switch off the {label} tools | The AI can't use the {label} tools in any chat. |
| On (Q2, decided) | caution | Switch the {label} tools back on | The {label} tools are back on. Other safety rules still apply. |

**Audit.** With Change Plans on (the default, `evolutionControlPlaneV1Enabled ?? true`), the plan's history is the operator audit record, as for every Settings › Safety change:
- `apply_started`
- `verification_completed`
- `operator_approval_skipped`, when the skip applied

With Change Plans off, the save takes the direct settings path, exactly like `globalToolAccessChange` does today. No new audit stream is added.

- [ ] **Step 1: Write the failing tests:**
  - `it("switches a group off and back on without touching tools.deny or tools.allow")`.
  - `it("refuses Core and unknown groups")`.
  - `it("treats switching off as safe and switching on as caution")`.
  - `it("applies switching off without an approval")`.
  - `it("waits in Inbox to switch on when the approval skip is off")`.
  - `it("switches on straight away when the approval skip is on")`.
  - `it("always asks to switch on under remote_hardened")`.
  - `it("saves directly when Change Plans are off")`.
  - `it("reports switched-off groups in the settings response")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts and shared.
- [ ] **Step 4: Run the tests (PASS), plus the existing** `tool_global_access` **adapter and route tests (PASS).**
- [ ] **Step 5: Commit:** `feat(settings): save tool group switches as governed Settings changes`.

### Task 6: Call counts

**Files:**
- Modify: `packages/storage/src/chat-tool-run-repo.ts`
  - Add `countCallsByToolSince(sinceIso: string): ChatToolCallCount[]` as a statement prepared in the constructor, like `cost-ledger-repo.ts:206-272`.
  - Export `interface ChatToolCallCount { toolName: string; calls: number; lastCalledAt: string }`.
- Create: `packages/contracts/src/capability-tools.ts` (usage types below). Export it from the contracts index next to `capability-connectors`.
- Create: `apps/gateway/src/services/capability-tool-usage-service.ts`
- Create: `apps/gateway/src/routes/capability-tools.ts` (the usage route; Task 7 adds the list route)
- Create: `apps/gateway/src/services/capability-tools-composition.ts`
- Modify:
  - `apps/gateway/src/services/gateway-route-services.ts`: add `capabilityToolUsage` (Task 7 adds `capabilityTools`)
  - the route composition file that composes `capabilityConnectors` (find it with `git grep composeCapabilityConnectors`)
  - `apps/gateway/src/app.ts`: register next to `capabilityConnectorsRoutes`
  - `apps/gateway/src/coverage-exercise.ts`
- Test: `packages/storage/src/chat-tool-run-counts.test.ts` (SQLite) and the real-Postgres twin; `capability-tool-usage-service.test.ts`; `routes/capability-tools.test.ts`

**Interfaces:**
- Produces:

```ts
// contracts/capability-tools.ts
export const TOOL_USAGE_WINDOW_DAYS = 365;
export interface CapabilityToolUsageEntry { toolName: string; calls: number; lastCalledAt: string }
export interface CapabilityToolGroupUsage { groupId: ToolGroupId; calls: number; lastCalledAt?: string }
export interface CapabilityToolUsageResponse {
  since: string;            // now − 365 days, ISO
  generatedAt: string;      // when the counts were read (the cache time on a cached answer)
  tools: CapabilityToolUsageEntry[];
  groups: CapabilityToolGroupUsage[];      // all 14 groups, 0 when none
  mostUsed: { kind: "most_used" | "essentials"; groupIds: ToolGroupId[] };
}
// gateway
export const TOOL_USAGE_CACHE_MS = 600_000;
export class CapabilityToolUsageService {
  constructor(readCounts: (sinceIso: string) => Promise<readonly ChatToolCallCount[]>, now?: () => Date);
  read(options: { refresh: boolean }): Promise<CapabilityToolUsageResponse>;
}
// GET /api/v1/capabilities/tools/usage?refresh=true|false → 200 CapabilityToolUsageResponse | 503
```

**Rules:**
- **A call** is a `chat_tool_runs` row that:
  - has `started_at >= since`
  - is not reused (use the same form the repository uses when it writes `reused`)
  - has `status` of `executed` or `failed`

  Blocked, waiting and still-running rows are not calls. No new index and no migration: the read is cached and scans two columns.
- **Group sums** add the group's own tools only. Native MCP names (`mcp.<server>.<tool>`) belong to connectors and are left out of every group. `mcp.invoke` counts in Core.
- **`mostUsed`:**
  - `most_used`: the 4 switchable groups with the most calls, once 4 or more have any calls. Ties fall back to `TOOL_GROUPS` order.
  - `essentials`: otherwise, `ESSENTIAL_TOOL_GROUP_IDS`.
  - Core is never in it.
- **Cache:**
  - Concurrent reads share one in-flight query.
  - A failed read is not cached.
  - `refresh: true` reads afresh and replaces the cache.
- **Route:**
  - Query: `z.object({ refresh: z.enum(["true", "false"]).optional() }).strict()`.
  - Options: `{ config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }`.
  - `markNoStore`.
  - A failed read gives 503: `ServiceUnavailableError("Tool call counts can't be read right now.")`.

- [ ] **Step 1: Write the failing storage tests:**
  - `it("counts executed and failed calls per tool with the latest start")`.
  - `it("leaves out blocked, waiting, running and reused rows")`.
  - `it("includes a call exactly at the window start and leaves out older ones")`.
  - The Postgres twin of the first test.
- [ ] **Step 2: Write the failing service and route tests:**
  - `it("sums each group's own tools and leaves connector tools out")`.
  - `it("picks the top 4 once 4 groups have calls, else the essentials")`.
  - `it("serves the cached counts for 10 minutes and reads again on refresh")`.
  - `it("shares one read between concurrent requests")`.
  - `it("doesn't cache a failed read")`.
  - Route: `it("answers 503 when the counts can't be read")`.
  - Route: `it("rejects unknown query fields")`.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement it.** Rebuild contracts and storage, and measure the new Gateway files.
- [ ] **Step 5: Run the tests (PASS), plus** `src/routes/get-routes-publish-sweep.test.ts` **(PASS).**
- [ ] **Step 6: Commit:** `feat(gateway): count tool calls from chats over the last year`.

### Task 7: Group list route

**Files:**
- Modify: `packages/contracts/src/capability-tools.ts` (list types below)
- Create: `apps/gateway/src/services/capability-tools-service.ts`
- Modify: `apps/gateway/src/services/capability-tools-composition.ts`, `apps/gateway/src/routes/capability-tools.ts`, `gateway-route-services.ts` (add `capabilityTools`) and `coverage-exercise.ts`
- Test: `capability-tools-service.test.ts`, `routes/capability-tools.test.ts`

**Interfaces:**
- Consumes:
  - `TOOL_GROUPS` (Task 1)
  - `switchedOffToolGroups` (Task 5)
  - `GatewayService.listToolCatalog`, `inspectToolAccess` (non-recording, :9636) and `resolveToolPolicyContext` (the source of `/api/v1/tools/permission-profiles/effective`)
  - `buildToolAccessProbeArgs` (`chat-turn-agent-runner.ts:10131`)
- Produces:

```ts
export type CapabilityToolGroupState = "on" | "off" | "always_on";
export type CapabilityToolBlock = "safety_rules" | "permission_profile" | "citadel_ward" | "grant";
export type CapabilityToolAsks = "asks_first" | "runs_freely" | "unknown";
export interface CapabilityToolItem {
  toolName: string; description: string; risk: ToolRiskLevel; asks: CapabilityToolAsks; blockedBy?: CapabilityToolBlock;
}
export interface CapabilityToolGroupItem {
  groupId: ToolGroupId; label: string; description: string; state: CapabilityToolGroupState;
  risk: ToolRiskLevel;            // the riskiest tool's
  tools: CapabilityToolItem[];    // registry order
  blockedToolCount: number;
}
export interface CapabilityToolsResponse {
  workspaceId: string; groups: CapabilityToolGroupItem[]; settingsRevision: number; issues: string[]; generatedAt: string;
}
export class CapabilityToolsService { list(workspaceId: string): Promise<CapabilityToolsResponse> }
// GET /api/v1/capabilities/tools?workspaceId=<id> → 200 CapabilityToolsResponse
```

**Rules:**
- **State.** Core is `always_on`. A group in `switchedOffToolGroups` is `off`. Everything else is `on`.
- **Off groups are not probed.** Their tools get `asks: "unknown"` and no `blockedBy`.
- **Every tool in an on group (and Core) is probed once.** Run probes 8 at a time, with this request:
  - `toolName`, `agentId: "assistant"`, `sessionId: "capabilities-tools"`, `workspaceId`, `surface: "chat"`
  - `args: buildToolAccessProbeArgs(toolName)`
  - `policyContext` and `permissionProfileId` from `resolveToolPolicyContext({ workspaceId, surface: "chat" })`

  The answer maps as follows:
  - allowed → `asks` is `asks_first` if `requiresApproval`, else `runs_freely`
  - `policy_deny` or `policy_disallow` → `blockedBy: "safety_rules"`
  - `permission_profile_upper_bound` → `"permission_profile"`
  - `citadel_ward_deny` → `"citadel_ward"`
  - `grant_deny` → `"grant"`
  - any other reason, or a probe that throws → `asks: "unknown"` with no `blockedBy`. A throw also adds one issue, once per response: "Some tools' rules couldn't be checked right now."
- **Route:**
  - Query: `z.object({ workspaceId: z.string().min(1).max(200) }).strict()`.
  - Rate limit: `{ max: 60, timeWindow: "1 minute" }`.
  - `markNoStore`, with errors through `sendRouteError`.
  - It publishes no realtime events and never records an access decision.

- [ ] **Step 1: Write the failing tests:**
  - `it("marks Core always on, a switched-off group off, and the rest on")`.
  - `it("takes each group's risk from its riskiest tool")`.
  - `it.each(<reason → blockedBy rows>)("maps %s to %s")`.
  - `it("doesn't probe a switched-off group")`.
  - `it("says some rules couldn't be checked when a probe throws, once")`.
  - `it("uses the workspace's permission profile for the probes")`.
  - Route: `it("returns the groups for a workspace with no-store")`.
  - Route: `it("rejects unknown query fields")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts, and measure the new files.
- [ ] **Step 4: Run the tests and the publish sweep (PASS).**
- [ ] **Step 5: Run the PR 2a checks:**
  - typecheck for contracts, policy-engine, storage, gateway and shared
  - the gateway tests from Tasks 2–7
  - `pnpm verify:gateway:async-boundary`
  - `pnpm verify:architecture:metrics`: no new regression, and GatewayService at or under 13132
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 6: Commit:** `feat(gateway): serve the Capabilities tool groups`. Then open PR 2a, quoting the operator's Q1 and Q2 answers and listing the group table for the operator to check.

---

# PR 2b: The Tools tab

### Task 8: Shared client and cockpit data

**Files:**
- Create: `packages/mission-control-shared/src/api/capability-tools.ts`
- Create: `apps/mission-control-next/src/cockpit/data/capability-tools-query.ts`
- Modify: `apps/mission-control-next/src/cockpit/data/query-keys.ts`
  - `capabilityTools: (workspaceId: string) => ["tools", "capability-tools", workspaceId]`
  - `capabilityToolUsage: () => ["tools", "capability-tool-usage"]`
- Modify: `apps/mission-control-next/src/cockpit/data/event-map.ts`: add the `["tools", "capability-tools"]` prefix to `TOOL_KEYS` (:59-65) and to the `runtime_settings*` Change Plan branch (:48-51, :126-133). Usage is not refreshed by events.
- Test: `capability-tools.test.ts` (shared), `event-map.test.ts`

**Interfaces:**
- Produces:

```ts
export function fetchCapabilityTools(workspaceId: string, options?: { signal?: AbortSignal }): Promise<CapabilityToolsResponse>;
export function fetchCapabilityToolUsage(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CapabilityToolUsageResponse>;
// cockpit
export function toolListQuery(workspaceId: string): UseQueryOptions<CapabilityToolsResponse>;   // every observer uses it
export function toolUsageQuery(): UseQueryOptions<CapabilityToolUsageResponse>;                // staleTime 60_000
```

The switch saves with the existing `patchSettings({ expectedRevision, toolGroupChange })` (Task 5).

- [ ] **Step 1: Write the failing tests:**
  - `it("requests the tool groups for the encoded workspace")`: the URL is `/api/v1/capabilities/tools?workspaceId=a%2Fb`, with `cache: "no-store"`.
  - `it("asks for fresh counts only on refresh")`.
  - `it("refreshes the tool list after a Settings change plan settles")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it, then rebuild shared.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the tool groups client and query`.

### Task 9: Tab wiring, last tab and the Library redirect

**Files:**
- Modify: `cockpit/areas/capabilities/capabilities-tabs.ts`
  - `CapabilitiesTabId = "connectors" | "tools"`.
  - Add `{ id: "tools", label: "Tools", href: "/capabilities/tools" }` after Connectors.
- Create: `cockpit/areas/capabilities/last-tab-preference.ts`
  - `readLastCapabilitiesTab(): CapabilitiesTabId | undefined` and `writeLastCapabilitiesTab(tab): void`.
  - Key `goatcitadel.cockpit.capabilities.last-tab.v1`, as `areas/inbox/inbox-shortcuts-preference.ts` does it.
  - Every storage access sits in try/catch, and an unknown stored value is ignored.
- Modify: `cockpit/areas/capabilities/CapabilitiesArea.tsx`
  - Bare `/capabilities` replaces the address with the remembered tab's href, or Connectors on a first visit.
  - Opening a tab writes it.
  - It renders `ToolsTab` for "tools". Task 11 fills it in; until then it is a stub.
- Modify: `cockpit/app/cockpit-compatibility.ts`
  - Add "tools" to `capabilitiesViews` (:27).
  - `/library/tools` resolves `{ kind: "native", href: "/capabilities/tools" }`, dropping its search and hash. `CockpitNavigationProvider` then replaces the address.
  - `/library/skills` and `/library/capabilities` are unchanged.
- Modify: `cockpit/app/CommandPalette.tsx`: add "Capabilities › Connectors" and "Capabilities › Tools" to `TAB_DESTINATIONS`. If `LIBRARY_SECTION_LABELS` gives a Library tools destination, drop it.
- Test (update): `cockpit-compatibility.test.ts` (:80-85, :245), `CapabilitiesArea.test.tsx` (:70, :78), `CommandPalette.test.tsx`
- Test: `last-tab-preference.test.ts`

- [ ] **Step 1: Update and write the tests:**
  - `/capabilities/tools` is native, and `/capabilities/skills` is still missing.
  - `it("sends /library/tools to /capabilities/tools")`.
  - `it("opens Connectors on the first visit and the last tab after that")`.
  - `it("falls back to Connectors when storage throws")`.
  - The tab labels are `["Connectors", "Tools"]`.
  - The palette lists "Capabilities › Tools".
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and the mc-next typecheck (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the Tools tab and send Library tools there`.

### Task 10: Group switch hook

**Files:**
- Create: `cockpit/areas/capabilities/tools/use-tool-group-switch.ts`
- Test: `cockpit/areas/capabilities/tools/use-tool-group-switch.test.tsx`

**Interfaces:**
- Consumes:
  - `patchSettings`, `toolListQuery` (Task 8)
  - `fetchChangePlan`, with the polling pattern from `features/native-routes/settings/use-settings-change.tsx`
  - `describeApiError`
- Produces:

```ts
export interface ToolGroupSwitch {
  checked: boolean;               // what the switch shows
  pending: boolean;
  waitingApprovalId?: string;     // switching on waits in Inbox
  failure?: { message: string; conflict: boolean };
  setEnabled(next: boolean): void;
  reload(): void;
}
export function useToolGroupSwitch(group: CapabilityToolGroupItem, settingsRevision: number): ToolGroupSwitch;
```

**Behaviour** (borrowed from Phase 1's R27 rule):
- **Off** is optimistic. It sets that group's cached `state` to `"off"`, saves, and on failure rolls back only that group.
- **On** never writes to the cache before the save lands. The switch shows pending.
  - A receipt that has completed (or no receipt, when Change Plans are off) refetches the list.
  - A receipt waiting on an approval sets `waitingApprovalId`, keeps the switch Off, and polls the plan until it settles. Completed refetches. Rejected or expired clears the wait and sets the failure "Not switched on. The change was declined in Inbox."
- **A 409** gives the failure "Changed elsewhere. Reload to see the latest.", with `conflict: true`. `reload()` refetches.
- **Any other failure** gives a plain message from `describeApiError`.
- **A second toggle** while one is in flight is ignored, through a busy ref.

- [ ] **Step 1: Write the failing tests:**
  - `it("turns off at once and rolls back only that group on failure")`.
  - `it("doesn't show On before the save lands")`.
  - `it("waits in Inbox and turns on when the approval lands")`.
  - `it("says it was declined and stays off")`.
  - `it("explains a conflict and reloads")`.
  - `it("ignores a second click while saving")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): switch tool groups on and off`.

### Task 11: Tools tab: rows, Most used and counts

**Files:**
- Create: `cockpit/areas/capabilities/tools/tool-view.ts`
- Create: `cockpit/areas/capabilities/tools/ToolsTab.tsx`
- Create: `cockpit/areas/capabilities/tools/ToolGroupRow.tsx`
- Create: `cockpit/areas/capabilities/tools/MostUsedRow.tsx`
- Modify: `cockpit/areas/capabilities/LetterIcon.tsx`: move `letterIconTone` out of `connectors/connector-view.ts` into `LetterIcon.tsx` (or a sibling `letter-icon-tone.ts`) so both tabs share it. Keep a re-export where connectors imports it.
- Test: `tool-view.test.ts`, `ToolsTab.test.tsx`

**Interfaces:**
- Consumes: `toolListQuery` and `toolUsageQuery` (Task 8), `useToolGroupSwitch` (Task 10), `CapabilitySearch` (Phase 1), `Switch`, `RiskBadge`, `StatusBadge`, `plural()`.
- Produces:

```ts
export function filterToolGroups(groups: readonly CapabilityToolGroupItem[], query: string): CapabilityToolGroupItem[];
export function presentGroupCalls(usage: CapabilityToolGroupUsage | undefined, status: "ready" | "unknown"): string;
export function presentGroupBlock(group: CapabilityToolGroupItem): string | undefined;
export function presentMostUsed(groups: readonly CapabilityToolGroupItem[], usage: CapabilityToolUsageResponse | undefined): { heading: "Most used" | "Essentials"; groups: CapabilityToolGroupItem[] };
export function toolSearchSuggestion(mostUsed: readonly CapabilityToolGroupItem[]): string; // `Try "${first label lower-cased}"`
```

**Copy:**
- **Calls:**
  - `No calls yet` when calls is 0
  - `${plural(n, "call")} in the last year` otherwise
  - `Calls unknown` when usage is missing or failed
- **Blocked:**
  - every tool blocked: `Blocked by other rules`
  - some blocked: `${plural(n, "tool")} blocked by other rules`
- **Core line:** its description, plus an "Always on" status badge in place of a switch.
- **Under the switch:**
  - on: `Takes effect in new chats.`
  - off: `The AI can't use these in any chat.`
  - waiting: `Waiting on you in Inbox` with "Open in Inbox" linking to `/inbox?approvalId=<id>`
- **Most used:** the heading is `Most used` for `kind: "most_used"`. It is `Essentials` for `kind: "essentials"`, and also when usage is missing, then using `ESSENTIAL_TOOL_GROUP_IDS`.
- **Count trouble:** when usage fails, show one line, "Call counts can't be read right now.", and a "Try again" button. A "Refresh counts" button calls `fetchCapabilityToolUsage({ refresh: true })` and writes the answer into the usage cache.

**Layout:**
- The search box carries the tab badge "Tools" and no category filter. With 14 groups, search is enough.
- Then the four-card row: `grid grid-cols-2 gap-2 sm:grid-cols-4`, each card showing the group, its calls and its switch.
- Then `Section` "All tools" as `ul grid grid-cols-1 gap-2 sm:grid-cols-2`, in `TOOL_GROUPS` order.
- A row card has a letter icon, the label, `plural(count, "tool")`, `RiskBadge`, the calls line, the block line if any, and the switch (`Switch` with `label` set to the group label). Pressing the row opens the panel (Task 12).
- States:
  - loading: `CHECKING_FOR_CHANGES`
  - list error with no cache: a plain message and Retry
  - cached list plus an error: keep the list, with one warning line
  - `issues`: one plain line each
  - no search matches: `EmptyState` with "Clear search"

- [ ] **Step 1: Write the failing tests:**
  - `tool-view.test.ts`: `it.each` over the calls copy; the block copy; `presentMostUsed` for most_used, essentials and missing usage; the search over label, description and tool descriptions.
  - `ToolsTab.test.tsx` (mock the client):
    - `it("shows Most used with counts once 4 groups have calls")`.
    - `it("shows Essentials and Calls unknown when counts fail, and keeps the list")`.
    - `it("never shows No calls yet while counts are loading or failed")`.
    - `it("shows Core always on with no switch")`.
    - `it("shows Waiting on you in Inbox with a link")`.
    - `it("offers Clear search when nothing matches")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): list tool groups with risk, calls and Most used`.

### Task 12: Group panel

**Files:**
- Create: `cockpit/areas/capabilities/tools/ToolGroupPanel.tsx`
- Create: `cockpit/areas/capabilities/tools/use-tool-group-panel.tsx`
- Create: `cockpit/areas/capabilities/tools/tool-links.ts`
- Test: `ToolGroupPanel.test.tsx`

**Interfaces:**
- Produces:

```ts
export const TOOLS_HREF = "/capabilities/tools";
export const TOOL_PANEL_SOURCE_PREFIX = "capabilities-tools:"; // never the connectors "capabilities:" prefix
export function toolGroupItemHref(groupId: ToolGroupId): string;   // `${TOOLS_HREF}?item=group%3A<id>`
export function toolGroupIdFromSearch(search: string): ToolGroupId | undefined;
export function toolBlockHref(block: CapabilityToolBlock): string;
// safety_rules, permission_profile → "/settings/safety#permission-profile"
// grant → "/settings/safety#approval-mode"
// citadel_ward → "/settings/citadel#citadel-wards"
```

**Panel content, top to bottom:**
1. The label, `RiskBadge`, and the state line.
2. The description.
3. The switch (`useToolGroupSwitch`) with the line under it as in Task 11. Core shows "Always on" and its description.
4. "Tools in this group". Each tool shows:
   - the first sentence of its description
   - `RiskBadge`
   - one asks line: "Asks first", "Runs freely", "Can't tell right now", or for a blocked tool "Blocked by your safety rules", "Blocked by a permission profile", "Blocked by a Citadel Ward" or "Blocked by a grant", with a "See the rule" link to `toolBlockHref`
   - last use: "Last used {relative}" from usage, "Not used yet", or "Last use unknown"
   - the tool name in the inspector's monospace technical slot
5. "Detailed rules are in Settings › Safety", linking to `/settings/safety#permission-profile`.
6. `TechnicalDetails` with the group id and the tool names.

**Opening and focus.** Opening the panel sets `?item=group:<id>`, and loading that URL opens it once the list arrives. An unknown id is ignored. Closing replaces the address with `TOOLS_HREF` and returns focus to the row, the way `use-connector-panel.tsx` does it.

- [ ] **Step 1: Write the failing tests:**
  - `it("lists each tool with its risk, asks line and last use")`.
  - `it("links a blocked tool to the rule that blocks it")`, checking each `toolBlockHref` against the Settings hash allowlist (`SettingsArea.tsx` :231-241).
  - `it("opens from ?item= once the list loads and ignores unknown ids")`.
  - `it("keeps the Connectors panel and the Tools panel apart")`: a `capabilities:` source never opens a Tools panel, and the reverse.
  - `it("shows Core without a switch")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): tool group panel with each tool's rules and last use`.

### Task 13: Public truth, Settings note, checks and proof

**Files:**
- Modify: `cockpit/areas/settings/FilesystemToolAccessPanel.tsx` (with `filesystem-write-access.ts` if the logic lives there). When `settings.switchedOffToolGroups` includes `"files"`, show one line: "The Files tools are switched off in Capabilities › Tools, so these settings have no effect until they're back on." Link it to `/capabilities/tools?item=group%3Afiles`.
- Modify the public claims that list what Capabilities holds or how tools are switched off. Find each with `git grep -n "Connectors tab\|Capabilities" -- README.md docs/1_0_CONTRACT.md apps/mission-control-next/AGENTS.md`.
- Modify anything in Library that links to `/library/tools`, so it points to `/capabilities/tools`.
- Test: the `FilesystemToolAccessPanel` test

- [ ] **Step 1: Write the failing test** `it("says the Files tools are switched off in Capabilities")`. **Step 2: Run it and confirm it fails.** **Step 3: Implement it and the doc edits.** **Step 4: Run it (PASS).**
- [ ] **Step 5: Run the PR 2b checks:**
  - the mc-next typecheck
  - `pnpm --filter @goatcitadel/mission-control-next perf:check`. Raise `LIVE_REGION_BUDGET` by exactly the number of `role="status"` or `role="alert"` regions added, each with a comment.
  - the cockpit tests for `areas/capabilities/`, `app/` and `data/`
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 6: Get browser proof** against a sandbox gateway with the testbench recipe (`pnpm testbench` with `VITE_GATEWAY_URL`). The controller does this with the in-app browser, per Phase 1's R26. Show:
  - Switching Files off completes at once.
  - Switching it on with the approval skip off waits in Inbox, and approving it turns it on.
  - Essentials on a fresh install, and Most used after seeding calls.
  - The panel opens from `?item=`.
  - `/library/tools` lands on `/capabilities/tools`.
  - `/capabilities` reopens the last tab.
  - Screenshots at desktop and phone width, in light and dark themes.
- [ ] **Step 7: Commit:** `docs: describe the Tools tab and note switched-off Files tools in Settings`. Then open PR 2b.

---

## Spec coverage for Phase 2

| Spec requirement | Task |
|---|---|
| About 14 plain-named groups, every registry tool in exactly one, enforced by a test | 1 |
| Group map in `@goatcitadel/contracts` beside `ToolCategory` and `ToolPack`; MCP tools not listed | 1, 7 |
| Core shown without a switch, with a one-line reason; `mcp.invoke` not switchable | 1, 2, 11, 12 |
| Off is Gateway-owned, deny-wins, audited, enforced in the policy engine for every surface | 2, 3, 4, 5 |
| On removes only that group's deny; tools blocked elsewhere say so and link to the rule | 2, 5, 7, 11, 12 |
| Row: name, tools, risk from the riskiest tool, call count, switch | 7, 11 |
| Counts over 365 days from `chat_tool_runs`; "No calls yet"; unknown never 0; 10-minute cache with refresh | 6, 11 |
| Most used: top 4 once 4 groups have calls, else Files, Web search, Memory, Browser | 6, 11 |
| Group panel: each tool's risk, whether it asks first, last use; link to Settings › Safety | 7, 12 |
| `/library/tools` redirects when the Tools tab ships; `/library/capabilities` stays | 9 |
| Tabs appear as they ship; open on the last tab used, Connectors on the first visit | 9 |
| Optimistic switch with per-row rollback; "Takes effect in new chats"; conflict reload | 10, 11 |
| #572 approval skip and `remote_hardened` | 5, 10 (Q2 decided) |
| Command palette opens Capabilities | 9 |

**Deliberate limits, and why:**
- **Counts cover calls from chats.** That means Chat, scheduled and autonomous turns, and remote-worker turns. Direct tool calls, MCP server mode and Code Mode don't write `chat_tool_runs`. A filtered union with `tool_invocations` can come later if needed.
- **No index on `chat_tool_runs`.** The 10-minute cache bounds the scan, and a new index would bring the PG dual-lineage migration work. Revisit if a large install shows a slow first read.
- **Rows show a tool count, not tool names.** Tool names are IDs, and DESIGN.md keeps IDs inside the inspector. The panel lists the tools.
- **Switches are install-wide,** like the rest of the tool policy. They are not per workspace. The block reasons shown are those for new chats in the active workspace.
- **Built-in tools published by a mesh node are mesh tools** and stay under mesh controls in Library.
- **Remote-worker admission still fails** if a selected tool's group goes off between placement and admission. This is fail-closed and unchanged.
- **With Change Plans switched off,** a group switch saves like any other Settings change, which records no plan history.
