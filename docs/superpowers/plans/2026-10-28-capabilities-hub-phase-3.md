# Capabilities Hub Phase 3 (Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Skills tab to the Capabilities area. It has Installed and Discover views with category buttons, a switch and a use count per skill, a skill panel, and one-step install from Discover or a Git address. Every change still goes through GoatCitadel's existing skill approvals, which now follow the operator's "skip approvals for my own changes" setting.

**Architecture:**
- A category map in `@goatcitadel/contracts` gives every skill one of 11 plain categories: a fixed entry for each of the 18 shipped skills, and a tag rule for every other skill. Nothing changes in any `SKILL.md`, so the bundled skills lock stays as it is.
- New Gateway routes under `/api/v1/capabilities/skills` serve the tab, and the cockpit renders them without joining sources:
  - the installed list, workspace-aware, with hidden-in-workspace and waiting-approval facts
  - use counts over 365 days, counted from the chat turn records that list the skills each turn loaded, cached for 10 minutes
  - one skill's details, including its `SKILL.md` text
  - in PR 3c: the Discover list, a source check, and the install steps
- Operator actions go through new Capabilities routes that call the existing owners, so the same `skill.lifecycle` or `skill_hub.lifecycle` approval is created as today. When the operator's skip applies, the route resolves that approval at once as the operator, with a recorded reason. The existing approval effect then applies the change, so HX-402's "the approval effect is the only executor" rule and its Journey records stay unchanged. The old `/api/v1/skills/*` routes, Chat commands and the AI's tools never skip.
- When a change does ask, the approval opens in the skill's panel and approves in one click (the #625 dialog), with "Open in Inbox" beside it.

**Tech Stack:** TypeScript, React 19, TanStack Query, Tailwind (cockpit tokens), Fastify, zod, Vitest, node:test (storage), SQLite and Postgres storage.

**Spec:** `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md` (sections "Skills tab", "Constraints", "Existing pages", "Borrowed from Hermes", "Claude's calls"). Phases 1 and 2 (`2026-10-25-capabilities-hub-phase-1.md`, `2026-10-27-capabilities-hub-phase-2.md`) built the area this plan extends.

**Measured facts:** `.superpowers/sdd/2026-10-28-capabilities-hub-phase-3/phase3-facts.md` (gitignored, in the planning worktree), with file:line evidence for every claim below, measured on `main` at `7f1caaf70`.

## Questions the operator answered

On 2026-10-28 the operator approved the plan with the recommended answer to all three questions: Q1 A, Q2 "Candidates and mesh", Q3 not in Phase 3. The tasks below implement those answers.

**Q1. With your skip setting off, does switching a skill off or pausing it still ask?**
Today every skill state change is a danger approval in Inbox, in both directions.
- **Recommended (A):** Off and Pause go straight through, like switching a tool group off, because they only take power away. The same approval record is still written and marked approved by you with the reason, so the history doesn't change. `remote_hardened` still asks. Switching on and installing keep asking.
- **Alternative (B):** Off and Pause ask in Inbox, as today. Drop the tightening row in Task 5's table and its test.

**Q2. What should Library call what's left?**
After this phase, Library's catalog keeps only candidate skills, proposals and mesh entries. Skills and tools live in Capabilities.
- **Recommended:** rename the "Skills and tools" section to "Candidates and mesh".
- **Alternative:** another name. That is a copy change in Task 7.

**Q3. Should the Skills tab remove skills?**
- **Recommended:** not in Phase 3. The switch turns a skill off. Skill Hub's `revoke` leaves the files in place, so an honest "Remove" needs its own design, including how Discover shows a removed skill. It becomes a follow-up.
- **Alternative:** add "Remove" for skills installed from Discover or Git, as the Hub `revoke` operation with the same skip rules. That is one more task in PR 3c.

## Decided without asking (check these)

- **Approvals open in the panel.** You asked on 2026-10-28 for approvals to pop up where you are and take one click. Skill changes that ask open the #625 approval dialog in the skill's panel, with "Open in Inbox" beside it. Connectors and Tools still link to Inbox; bringing them in line is a follow-up.
- **Use counts come from chats.** The spec names the skill's `usageCount`, but that field only moves on one rarely used route, never in a chat. Counting from chat turns is the honest number.
- **Installing with the skip setting off asks twice:** once to install, once to switch it on. The spec keeps each Skill Hub operation's own approval. Both approvals open in the panel.
- **Discover goes online only when you search.** Opening it shows GoatCitadel's own skill packs and the curated list. Typing a search also asks AgentSkill and SkillsMP, and each search is cached for 10 minutes.
- **The candidates link counts candidate skills,** not proposals, because one Library link can show only one kind.
- **The category table** is in Task 1. PR 3a lists it for you to check.

## PR boundaries

Each PR is cut from a freshly fetched `origin/main` in its own worktree (superpowers:using-git-worktrees) and merged before the next one starts.

| PR | Tasks | Ships |
|---|---|---|
| 3a | 1–5 | Gateway: categories, use counts, the installed list and details, and the skill switch with the operator skip. No UI yet. |
| 3b | 6–11 | The Skills tab's Installed view: data layer, tab wiring, redirects and command palette, a slimmer Library, the switch, rows, the skill panel, public truth and browser proof. |
| 3c | 12–16 | Discover and one-step install: the source check and install routes, the Discover list, the Discover view, the install panel with Import from Git, and proof. |

## Global Constraints

- Build each PR from a freshly fetched `origin/main`. This plan was written against `7f1caaf70`.
- **The Gateway owns every read and write.** The cockpit renders the `/api/v1/capabilities/skills*` routes and acts through them. It never computes:
  - category or origin
  - whether a skill can be used
  - whether a source can be installed, or is already installed
  - an install's next step

  It never merges catalogs (`apps/mission-control-next/AGENTS.md` lines 24 and 27).
- **HX-402 holds.** Every skill state change and every Skill Hub operation still creates its approval, and only the recovered approval effect applies it.
  - The skip resolves that approval as the operator. It never writes skill state or Hub records itself.
  - Only `capability-skill-actions-service.ts` may resolve an approval on the operator's behalf (guard test, Task 5).
  - `remote_hardened` always asks. `/api/v1/skills/*`, Chat's `/skill` commands, `change.request` and tool calls never skip.
- **A skill is never callable before `activate` settles.** No Skill Hub check, blocker or scan finding can be overridden from the tab.
- **Visible copy follows DESIGN.md.** Sentence case and plain words.
  - The copy guard bans "posture", "Gateway", "revision", "evidence", "owner", "snapshot", "canonical", "durable", "projection", "replay", "admission" and "readback" (`scripts/check-mission-control-next-cockpit-copy.mjs`). Run it in every cockpit task.
  - Say "GoatCitadel's checks", never "Skill Hub".
  - Skill ids, URLs, commit hashes, paths and raw codes appear only inside `TechnicalDetails`.
  - Counts use `plural()`.
- **A count is never made up.** When use counts can't be read, rows say "Uses unknown", never "Not used yet" and never 0. When the candidate count can't be read, the link is absent rather than showing 0.
- **A row never shows plain "On" when the AI can't use the skill:** hidden in this workspace, not reviewed yet, or waiting on an approval.
- **No `SKILL.md` byte changes.** If a task must change a bundled one, run `pnpm update:skills:lock` in the same commit.
- **Skill text renders as safe markdown,** with no raw HTML (the Chat renderer).
- **GatewayService stays at or under 13132 counted lines.** It is 13129 on `7f1caaf70`.
  - New Gateway files take plain function readers, the way `capability-tools-composition.ts` does. Measure each with `countDependencyMemberAccesses` (`scripts/verification/lib/architecture-metrics.mjs`).
  - A count above 0 in a new file, or a rise in an existing owner's count, means stop and ask the operator for a C0 allowance. Expect to ask for one in PR 3a and one in PR 3c.
  - Never run `architecture:baseline:update`.
- No new dependencies.
- After changing `packages/contracts`, `packages/storage` or `packages/mission-control-shared`, rebuild that package before running dependents' tests; they resolve these from `dist`. mc-next vitest reads shared from source and contracts from `dist`.
- Run tests at low priority with `--maxWorkers=2`, one heavy job at a time. Storage tests use `TempSqliteFiles`.
- Never `prettier --write` a directory glob, never `git stash`, no personal paths in tracked files.
- Commands:
  - Contracts: `pnpm --filter @goatcitadel/contracts exec vitest run <path> --maxWorkers=2`
  - Storage: node:test through `tsx --test`, as Phase 2's `chat-tool-run-counts.test.ts` does. The Postgres twin is a `*.postgres.test.ts` listed in `test:postgres`.
  - Gateway: `pnpm --filter @goatcitadel/gateway exec vitest run <path relative to apps/gateway> --maxWorkers=2`. Run it from `apps/gateway` if a config ENOENT appears.
  - Shared: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run <path> --maxWorkers=2`
  - Cockpit: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path relative to the app> --maxWorkers=2`

## Review Focus

1. **The skip setting is off (the default) and the operator switches a skill on.**
   - The approval opens in the panel, and the row says "Waiting on you in Inbox" with a link. The switch stays Off.
   - Approving in one click turns it On once the change applies. Declining says so and leaves it Off. After 15 minutes it says the request expired.
   - A reload while waiting still shows the wait, because the Gateway reports the pending approval.
   - *(Tasks 4, 8, 10)*
2. **The skip setting is on, and something other than the Skills tab asks for a skill change.** That means the old Library state route, Chat's `/skill install`, or the old `/api/v1/skills/hub/operations` route. Each still waits in Inbox. Only the Capabilities skill routes skip. The old-route tests prove it, and the guard test keeps every other caller from resolving an approval this way. *(Tasks 5 and 12)*
3. **A shipped `extra` skill is switched on but not reviewed.** Its lifecycle is a candidate, so it can't be called. Its row never says plain "On"; it says "Not usable yet" with the reason. *(Tasks 4 and 9)*
4. **An install with the skip setting off is interrupted between its two approvals** (the tab is closed after the install step lands).
   - Reopening Discover shows "Installed, not switched on" with a "Switch on" action, read from the Gateway.
   - The skill is never shown as Installed early, and never callable before `activate` settles.
   - *(Tasks 12 and 15)*
5. **AgentSkill and SkillsMP are down or slow during a search.** Discover still shows GoatCitadel's packs and the curated list, with one plain line per site that couldn't be searched. It never shows "No skills found" for a failed search. *(Tasks 13 and 14)*

---

# PR 3a: Categories, use counts, the installed list and the switch

### Task 1: Skill categories and origins

**Files:**
- Create: `packages/contracts/src/skill-categories.ts`
- Modify: `packages/contracts/src/index.ts` (export it next to `./skill-packs.js`)
- Test: `packages/contracts/src/skill-categories.test.ts`

**Interfaces:**
- Produces:

```ts
export type SkillCategoryId =
  | "coding" | "writing" | "research" | "planning" | "design" | "automation"
  | "email" | "operations" | "personal" | "local_ai" | "other";
export interface SkillCategoryDefinition {
  readonly id: SkillCategoryId;
  readonly label: string;
  readonly matchTerms: readonly string[]; // lower-case; "other" has none
}
export const SKILL_CATEGORIES: readonly SkillCategoryDefinition[]; // table order, "other" last
export const SHIPPED_SKILL_CATEGORIES: Readonly<Record<string, SkillCategoryId>>; // 18 entries, keyed by skill id
/** Shipped map first; else the first category (table order) with a term equal to a lower-cased tag or keyword; else "other". */
export function skillCategoryFor(input: { skillId: string; tags?: readonly string[]; keywords?: readonly string[] }): SkillCategoryId;
export type SkillOrigin = "built_in" | "imported" | "self_authored" | "workspace";
export const SKILL_ORIGIN_LABELS: Readonly<Record<SkillOrigin, string>>;
// built_in "Built in", imported "Imported", self_authored "Self-authored", workspace "Workspace"
```

**The categories** (exact copy):

| id | label | matchTerms | shipped skills |
|---|---|---|---|
| coding | Coding | code, coding, programming, git, github, testing, qa, debugging, refactoring | bundled:coding, bundled:opencode, bundled:qa, extra:github-cli |
| writing | Writing and docs | docs, documentation, writing, readme, runbook, content | bundled:documentation |
| research | Research | research, web, search, citations | bundled:research |
| planning | Planning | planning, plan, product, roadmap, architecture | bundled:planning, bundled:agentic-skill-architect |
| design | Design | design, ui, ux, frontend, css | bundled:impeccable |
| automation | Automation | automation, workflow, n8n, integration | bundled:n8n-workflow-architect |
| email | Email and messages | email, mail, imap, smtp, messaging | bundled:sendclaw, extra:himalaya |
| operations | Operations | operations, ops, devops, infrastructure, incident, monitoring | bundled:operations, bundled:mcp-vetter, bundled:goatcitadel-native-safe-self-improvement, extra:citadel-mason |
| personal | Personal | personal, productivity, reminders, notes | bundled:personal-assistant |
| local_ai | Local AI | inference, llm, npu, local-ai | extra:genie-npu-ir20 |
| other | Other | (none) | (none) |

- [ ] **Step 1: Write the failing tests:**
  - `it("lists 11 categories with unique ids and Other last")`.
  - `it("maps every skill in skills/catalog-coverage.json and nothing else")`. Read the JSON with `fs` (resolve it from `import.meta.url`), then compare its `skillId` set with `Object.keys(SHIPPED_SKILL_CATEGORIES)`. A new shipped skill then fails this test until it gets a category.
  - `it("uses the shipped map before tags")`: `skillCategoryFor({ skillId: "bundled:qa", tags: ["email"] })` is `"coding"`.
  - `it.each` over tag rules: `["Email"]` → email (case-insensitive); `["unknown"]` → other; `["design", "code"]` → coding (table order wins); a keyword alone matches.
- [ ] **Step 2: Run them and confirm they fail** (module not found).
- [ ] **Step 3: Implement it, then rebuild contracts.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(contracts): give every skill a plain category`.

### Task 2: Skill uses in chat turns (storage)

**Files:**
- Modify: `packages/storage/src/chat-turn-capability-profile-repo.ts`
  - Add `countSkillUsesSince(sinceIso: string): SkillUseCount[]`, prepared in the constructor the way `chat-tool-run-repo.ts:96` prepares `countCallsByToolSince`.
  - Export `interface SkillUseCount { skillId: string; uses: number; lastUsedAt: string }`.
- Modify: the Postgres side of the same repo, mirroring how `countCallsByToolSince` reached Postgres in Phase 2.
- Modify: `packages/storage/package.json` (`test:postgres` lists the new twin)
- Test: `packages/storage/src/chat-turn-skill-uses.test.ts` and `packages/storage/src/chat-turn-skill-uses.postgres.test.ts`

**Rules:**
- **A use** is one `chat_turn_capability_profiles` row with `created_at >= since` whose stored profile lists the skill under `selection.activatedSkills[].skillId`. Confirm the JSON path against the repo's write path before coding.
- A turn that lists the same skill twice counts once. `lastUsedAt` is the latest `created_at`.
- **SQLite:** `json_each(profile_json, '$.selection.activatedSkills')`, with `instr(profile_json, '"activatedSkills"') > 0` first so turns without skills skip the JSON parse.
- **Postgres:** `jsonb_array_elements((profile_json::jsonb) -> 'selection' -> 'activatedSkills')`, with the matching `position(...)` prefilter. Apply `Number()` to the aggregates.
- No index and no migration. The read is cached (Task 3); see the deliberate limits.

- [ ] **Step 1: Write the failing tests:**
  - `it("counts turns per skill with the latest use")`.
  - `it("counts a skill once per turn")`.
  - `it("includes a turn exactly at the window start and leaves out older ones")`.
  - `it("ignores turns that loaded no skills")`.
  - The Postgres twin of the first test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it, then rebuild storage.** **Step 4: Run them (PASS).** Run the Postgres twin against a local Postgres if one is available; otherwise the PR body says it is unproven locally (P2-R22).
- [ ] **Step 5: Commit:** `feat(storage): count the skills each chat turn loaded`.

### Task 3: Use counts route

**Files:**
- Create: `packages/contracts/src/capability-skills.ts` (the usage types below; Tasks 4, 5, 12 and 13 add to it). Export it from the contracts index next to `capability-tools`.
- Create: `apps/gateway/src/services/capability-usage-cache.ts`. Move the cache mechanics out of `capability-tool-usage-service.ts`, which keeps its public behaviour and tests.
- Create: `apps/gateway/src/services/capability-skill-usage-service.ts`
- Create: `apps/gateway/src/services/capability-skills-composition.ts`
- Create: `apps/gateway/src/routes/capability-skills.ts`
- Modify: `apps/gateway/src/services/gateway-route-services.ts` (add `capabilitySkills`)
- Modify: `apps/gateway/src/services/gateway-service.ts`
  - Register `capabilitySkills: composeCapabilitySkills({...})` once, next to `capabilityTools`, with every owner Phase 3 needs: `this`, `composed.skills` and `composed.capabilityScope`. Later tasks grow only the composition file.
- Modify: `apps/gateway/src/app.ts` (register next to `capabilityToolsRoutes`) and `apps/gateway/src/coverage-exercise.ts`
- Test: `capability-usage-cache.test.ts`, `capability-skill-usage-service.test.ts`, `routes/capability-skills.test.ts`

**GatewayService line budget.** Free lines first:
1. Move the inline skip rule (`gateway-service.ts:3553-3555`) into a new pure `apps/gateway/src/services/operator-approval-skip.ts`: `export function allowsOperatorApprovalSkip(deploymentProfile: DeploymentProfile, skipSettingOn: boolean): boolean`. GatewayService and Task 5 both call it, so the rule lives in one place.
2. If the file is still over 13132, move one more inline block into a pure helper, as P2-R1 did. Measure before and after.

**Interfaces:**
- Produces:

```ts
// contracts/capability-skills.ts
export const SKILL_USAGE_WINDOW_DAYS = 365;
export interface CapabilitySkillUsageEntry { skillId: string; uses: number; lastUsedAt: string }
export interface CapabilitySkillUsageResponse {
  since: string;       // now − 365 days, ISO
  generatedAt: string; // the read time (the cache time on a cached answer)
  skills: CapabilitySkillUsageEntry[];
}
// gateway
export interface UsageCache<T> { read(options: { refresh: boolean }): Promise<T> }
export function createUsageCache<T>(read: () => Promise<T>, options: { cacheMs: number; now?: () => Date }): UsageCache<T>;
export class CapabilitySkillUsageService {
  constructor(readUses: (sinceIso: string) => Promise<readonly SkillUseCount[]>, now?: () => Date);
  read(options: { refresh: boolean }): Promise<CapabilitySkillUsageResponse>;
}
// GET /api/v1/capabilities/skills/usage?refresh=true|false → 200 | 503
```

**Rules** (the same as Phase 2's tool counts):
- Cache for 10 minutes (`TOOL_USAGE_CACHE_MS`).
- Concurrent reads share one query, a failed read isn't cached, and `refresh: true` reads afresh and replaces the cache.
- **Route:**
  - Query: `z.object({ refresh: z.enum(["true", "false"]).optional() }).strict()`.
  - Rate limit: `{ max: 30, timeWindow: "1 minute" }`.
  - `markNoStore`.
  - A failed read gives 503 `ServiceUnavailableError("Skill use counts can't be read right now.")`.

- [ ] **Step 1: Write the failing tests:**
  - `it("serves the cached answer for 10 minutes and reads again on refresh")`.
  - `it("shares one read between concurrent requests")`.
  - `it("doesn't cache a failed read")`.
  - The tool usage service's existing tests still pass unchanged.
  - Route: `it("answers 503 when uses can't be read")`.
  - Route: `it("rejects unknown query fields")`.
  - Route: `it("sets the 30 a minute limit")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure GatewayService lines and the new files' dependency counts.
- [ ] **Step 4: Run the tests plus** `src/get-routes-publish-sweep.test.ts` **(PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): count skill uses from chat turns over the last year`.

### Task 4: Installed list and skill details

**Files:**
- Modify: `packages/contracts/src/capability-skills.ts` (list and detail types below)
- Create: `apps/gateway/src/services/capability-skills-projection.ts` (pure)
- Create: `apps/gateway/src/services/capability-skills-service.ts`
- Modify: `apps/gateway/src/services/capability-skills-composition.ts`, `routes/capability-skills.ts` and `coverage-exercise.ts`
- Modify: `apps/gateway/src/services/gateway-service.ts`: `listSkills(workspaceId?: string)` passes the workspace to `capabilitySystemService.listSkills` (read its signature). This adds no lines; the existing no-argument callers are unchanged.
- Test: `capability-skills-projection.test.ts`, `capability-skills-service.test.ts`, `routes/capability-skills.test.ts`

**Interfaces:**
- Consumes:
  - `skillCategoryFor`, `SkillOrigin` (Task 1)
  - `GatewayService.listSkills(workspaceId)`
  - `capabilityScope.getView("workspace", workspaceId, "skill")`
  - the inspectable catalog (`listCatalog("inspectable", "ALL", workspaceId)` or the owner the catalog route uses)
  - the pending approvals of kind `skill.lifecycle`, through the owner the Inbox list uses
  - `allowsOperatorApprovalSkip` (Task 3)
- Produces:

```ts
export type CapabilitySkillState = "on" | "paused" | "off"; // enabled | sleep | disabled
export interface CapabilitySkillItem {
  skillId: string; name: string; description: string;
  category: SkillCategoryId; origin: SkillOrigin;
  state: CapabilitySkillState;
  callable: boolean;
  revision: number;            // sent back as expectedRevision
  pinned: boolean;
  lifecycleState?: SkillLifecycleState;
  tags: string[];
  hiddenInWorkspace: boolean;
  pendingApprovalId?: string;  // a skill.lifecycle approval for this skill still waiting
}
export interface CapabilitySkillsResponse {
  workspaceId: string;
  items: CapabilitySkillItem[];
  candidatesWaiting?: number;      // absent when it couldn't be read
  operatorApprovalSkip: boolean;   // the operator's own clicks here apply without asking
  issues: string[];
  generatedAt: string;
}
export interface CapabilitySkillDetail {
  skillId: string;
  instructionBody: string;
  keywords: string[]; declaredTools: string[]; requires: string[];
  provenance?: { source: string; sourceRef?: string; sourceProvider?: string; commitSha?: string; treeSha256?: string };
  trustLabel?: string; reviewWarning?: string; note?: string; stateUpdatedAt?: string;
  catalogEntry?: CapabilityCatalogEntry; // the inspectable catalog's skill:<id> entry, for the moved inspectors
}
export class CapabilitySkillsService {
  list(workspaceId: string): Promise<CapabilitySkillsResponse>;
  detail(workspaceId: string, skillId: string): Promise<CapabilitySkillDetail>; // NotFoundError when unknown
}
// GET /api/v1/capabilities/skills?workspaceId=<id>                       → 200 CapabilitySkillsResponse
// GET /api/v1/capabilities/skills/detail?workspaceId=<id>&skillId=<id>   → 200 CapabilitySkillDetail | 404
```

**Rules:**
- **Items** are every loaded skill for the workspace, including its approved self-authored skills. Mesh entries are not included.
- **Origin:**
  - `source: "bundled"`, or a skill id in `SHIPPED_SKILL_CATEGORIES` → `built_in`
  - `capabilityCategory: "self_generated"` → `self_authored`
  - `source: "workspace"` → `workspace`
  - anything else → `imported`

  Find what writes `.assistant/skills` (`managed`); it stays `imported` unless that shows it is shipped.
- **State** maps `enabled` → on, `sleep` → paused and `disabled` → off.
- **`callable`** comes from the item as it is, never recomputed.
- **Hidden in this workspace** follows Phase 1's rule. A known skill id missing from the selection's `effectiveRefs` is hidden. An unreadable selection hides nothing and adds the issue "Workspace skill choices couldn't be read right now."
- **`candidatesWaiting`** counts the catalog's `candidate_skill` entries whose `lifecycleState` is `candidate`, counted once per candidate id (entries are per version: `candidate:<candidateId>:<versionId>`). An unreadable catalog leaves it absent.
- **`pendingApprovalId`** is set from pending `skill.lifecycle` approvals whose subject is the skill. An unreadable approval list leaves it unset and adds the issue "Waiting approvals couldn't be read right now."
- **Sort** by name with a locale-independent compare (not `localeCompare`).
- **Each source read** runs in its own try/catch, as Phase 1's connector list does. The response is still 200 with `issues`.
- **Routes:**
  - Queries: `z.object({ workspaceId: z.string().min(1).max(200) }).strict()`. The detail query adds `skillId: z.string().min(1).max(300)`.
  - Rate limit: `{ max: 60, timeWindow: "1 minute" }`.
  - `markNoStore`, with errors through `sendRouteError`. They publish no events.

- [ ] **Step 1: Write the failing tests:**
  - `it.each` over the origin rules.
  - `it("maps enabled, sleep and disabled to on, paused and off")`.
  - `it("keeps callable false for an enabled skill that isn't reviewed")`.
  - `it("hides a skill the workspace left out, and hides nothing when the choices can't be read")`.
  - `it("counts each waiting candidate once across its versions")`.
  - `it("leaves candidatesWaiting out when the catalog can't be read")`.
  - `it("reports a waiting approval for its skill")`.
  - `it("includes the workspace's approved self-authored skills")`. This is a real-Gateway test that fails on today's `listSkills()`.
  - `it("reports the operator skip, and false under remote_hardened")`.
  - Route: `it("returns the list with no-store")`.
  - Route: `it("returns 404 for an unknown skill's details")`.
  - Route: `it("rejects unknown query fields")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts and measure the new files.
- [ ] **Step 4: Run them and the publish sweep (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): serve the Capabilities skill list and skill details`.

### Task 5: The skill switch, with the operator skip

**Files:**
- Modify: `packages/contracts/src/capability-skills.ts` (action types below)
- Create: `apps/gateway/src/services/capability-skill-actions-service.ts`
- Modify: `capability-skills-composition.ts` and `routes/capability-skills.ts`
- Modify: `packages/contracts` copy for the skip flag (its label, description and `SKIP_FACTS`), `SettingsApprovalSkipControl.tsx` and its test, plus `docs/EVOLUTION_CONTROL_PLANE.md` and `docs/CANONICAL_RUNTIME_STATE_MODEL.md`. All of them now say the setting also covers skill switches and installs from Capabilities.
- Create: `apps/gateway/src/services/capability-skill-skip-guard.test.ts`, mirroring `own-delivery-mint-guard.test.ts`
- Test: `capability-skill-actions-service.test.ts`, `routes/capability-skills.test.ts`, and a real-Gateway test `capability-skill-actions.integration.test.ts`

**Interfaces:**
- Consumes:
  - `GatewayService.setSkillState(skillId, state, note, { expectedRevision, requesterId })`
  - `GatewayService.resolveApproval(approvalId, { decision: "approve", resolvedBy, resolutionNote })`
  - the approvals audit stream (`storage.audit.append("approvals", ...)`, as the Change Plan skip does)
  - `allowsOperatorApprovalSkip` (Task 3)
- Produces:

```ts
export type CapabilitySkillActionOutcome =
  | { status: "approved"; approvalId: string }   // resolved by the skip; the change applies in a moment
  | { status: "waiting"; approvalId: string }    // waiting on the operator
  | { status: "unchanged" };                     // already in that state
export interface CapabilitySkillStateRequest {
  workspaceId: string; skillId: string; state: SkillRuntimeState; expectedRevision: number;
}
export class CapabilitySkillActionsService {
  setState(input: CapabilitySkillStateRequest & { actorId: string }): Promise<CapabilitySkillActionOutcome>;
}
// POST /api/v1/capabilities/skills/state → 202 { waiting | approved } | 200 { unchanged }
```

**When the skip applies** (read once per request):

| Deployment profile | Setting | Target state | Outcome |
|---|---|---|---|
| remote_hardened | any | any | waiting |
| other | on | any | approved, reason `setting` |
| other | off | `disabled` or `sleep` (Q1: A) | approved, reason `tightening` |
| other | off | `enabled` | waiting |

**Rules:**
- The service always asks the existing owner first, with the operator as requester. `noMutationRequired` gives `unchanged`.
- **When the skip applies,** it resolves the new approval with `decision: "approve"`, `resolvedBy` set to the operator, and one of two `resolutionNote`s, exported for the guard:
  - `setting`: "Applied without asking: your setting to skip approvals for your own changes is on."
  - `tightening`: "Applied without asking: switching a skill off or pausing it only takes power away."

  It then appends the audit event `operator_approval_skipped` with `{ approvalId, kind: "skill.lifecycle", reason, actorId }`.
- **If resolving throws,** the outcome is `waiting` and the error goes to the redacted server log. The approval is still in Inbox.
- **Pinned skills** and stale revisions pass the owner's own `ConflictError` through as 409. The route's message for a pinned skill is "This skill is pinned. Change it through a proposal in Library."
- **Route:**
  - Body: `z.object({ workspaceId, skillId, state: z.enum(["enabled", "sleep", "disabled"]), expectedRevision: z.number().int().positive() }).strict()`.
  - Access: `withRouteAccess(fastify, "operator")`. The actor id comes the way `routes/skills.ts` derives it.
  - Rate limit: `{ max: 30, timeWindow: "1 minute" }`.
  - A body field can never choose to skip: there is no such field, and an extra key is a 400.
- **Guard:** only `capability-skill-actions-service.ts` may pass either note, or call `resolveApproval` from code that also requests the approval (tests excepted).

- [ ] **Step 1: Write the failing tests:**
  - `it.each(<table rows>)("%s with the setting %s, switching to %s, is %s")`.
  - `it("passes a pinned skill's refusal through as 409 and creates no approval")`.
  - `it("returns unchanged when the skill is already in that state")`.
  - `it("keeps waiting when resolving fails")`.
  - `it("records operator_approval_skipped with the reason")`.
  - Real Gateway: `it("switches a skill on at once when the setting is on")`. The state reads `enabled` once the effect settles, and the approval reads approved by the operator with the note.
  - Real Gateway: `it("leaves the old Library route asking even with the setting on")`. `PATCH /api/v1/skills/by-id/state` still answers 202 with a pending approval.
  - Real Gateway: `it("always asks under remote_hardened, even to switch off")`.
  - Route: `it("rejects a body that tries to choose the skip")` (400).
  - The guard test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it, plus the copy and doc edits.** Rebuild contracts, then measure the new file and the composition file. If `resolveApproval` refuses a resolver who is also the requester, stop and report.
- [ ] **Step 4: Run the tests (PASS), plus** `pnpm verify:journey:producers` **(PASS, unchanged).**
- [ ] **Step 5: Run the PR 3a checks:**
  - typecheck for contracts, storage, gateway and shared
  - the gateway tests from Tasks 3–5
  - `pnpm verify:gateway:async-boundary`
  - `pnpm verify:architecture:metrics`: no new regression, and GatewayService at or under 13132
  - `pnpm verify:skills:catalog`
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 6: Commit:** `feat(gateway): switch skills from Capabilities, following the operator's approval setting`. Then open PR 3a. The body includes the operator's Q1 answer, the category table, and the deliberate limits below.

---

# PR 3b: The Installed view

### Task 6: Shared client and cockpit data

**Files:**
- Create: `packages/mission-control-shared/src/api/capability-skills.ts`
- Create: `apps/mission-control-next/src/cockpit/data/capability-skills-query.ts`
- Modify: `cockpit/data/query-keys.ts`
  - `capabilitySkills: (ws) => ["skills", "capability-skills", ws]`
  - `capabilitySkillUsage: () => ["skills", "capability-skill-usage"]`
  - `capabilitySkillDetail: (ws, skillId) => ["skills", "capability-skill-detail", ws, skillId]`
- Modify: `cockpit/data/event-map.ts`. Add the list and detail prefixes to:
  - the `"skills"` source branch (:138)
  - `CAPABILITY_KEYS` (:89)
  - the source that carries `skill_mutation_approval_requested`, `skill_state_mutation_applied` and approval resolution (find it in the map; add a branch if none exists)
  - `SETTINGS_READER_KEYS` (the skip setting changes `operatorApprovalSkip`)

  Usage is not refreshed by events.
- Test: `capability-skills.test.ts` (shared), `event-map.test.ts`

**Interfaces:**
- Produces:

```ts
export function fetchCapabilitySkills(workspaceId: string, options?: { signal?: AbortSignal }): Promise<CapabilitySkillsResponse>;
export function fetchCapabilitySkillUsage(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CapabilitySkillUsageResponse>;
export function fetchCapabilitySkillDetail(workspaceId: string, skillId: string, options?: { signal?: AbortSignal }): Promise<CapabilitySkillDetail>;
export function setCapabilitySkillState(input: CapabilitySkillStateRequest): Promise<CapabilitySkillActionOutcome>;
// cockpit: queryOptions factories, used by every observer
export function skillListQuery(workspaceId: string);
export function skillUsageQuery();                                  // staleTime 60_000
export function skillDetailQuery(workspaceId: string, skillId: string);
```

- [ ] **Step 1: Write the failing tests:**
  - `it("requests the skill list for the encoded workspace")`: `/api/v1/capabilities/skills?workspaceId=a%2Fb`, `cache: "no-store"`.
  - `it("asks for fresh use counts only on refresh")`.
  - `it("encodes the skill id in the details request")`.
  - `it("refreshes the skill list when a skill change applies")`.
  - `it("refreshes the skill list when the skip setting changes")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it, then rebuild shared.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the Capabilities skills client and queries`.

### Task 7: Tab wiring, redirects, command palette and a slimmer Library

**Files:**
- Modify: `cockpit/areas/capabilities/capabilities-tabs.ts`
  - `CapabilitiesTabId = "skills" | "connectors" | "tools"`.
  - Skills comes first, in the spec's order. `DEFAULT_TAB` stays `connectors` (first visit).
- Modify: `cockpit/areas/capabilities/CapabilitiesArea.tsx`: render `SkillsTab` for "skills". It is a stub until Task 9; mock it in `CapabilitiesArea.test.tsx`.
- Modify: `cockpit/app/cockpit-compatibility.ts`
  - Add "skills" to `capabilitiesViews`.
  - Redirect, with the same parameter rules as `/library/tools` (drop q, type, status, trust and the hash; keep workspaceId, shell and shellScope; `?shell=classic` stays Classic):
    - `/library/skills` → `/capabilities/skills`
    - `/library/capabilities` → `/capabilities/skills`
    - `/library?type=skill` → `/capabilities/skills`
    - `/library?type=tool` → `/capabilities/tools`
  - Record links:
    - `/library/skill/<capabilityId>` → `/capabilities/skills?item=skill%3A<skillId>`. Read the id form in `capability-catalog-route.ts`.
    - `/library/tool/<id>` → `/capabilities/tools?item=group%3A<groupId>` through `toolGroupForTool`, or `/capabilities/tools` when the tool is in no group.
  - Remove `capabilities` from `libraryViews`.
- Modify: `cockpit/areas/library/library-sections.ts` and `LibraryArea.tsx`
  - The default section's label becomes "Candidates and mesh" (Q2).
  - `CapabilityCatalog` lists only the kinds `candidate_skill`, `proposal`, `code_mode`, `mesh_tool`, `mesh_mcp_server` and `mesh_skill`, a presentation filter over the Gateway's list. The kind filter offers only those.
  - The empty state says skills and tools are in Capabilities, with links.
- Modify the links into Library skills:
  - `InboxCapabilityProposalDetail.tsx:140-145` → `/library?type=candidate_skill`, with "Candidates are promoted from Library › Candidates and mesh".
  - `FirstRunVerification.tsx:44` (`canvas-a2ui`) → `/capabilities/skills`.
  - `SafetyCatalogSummary.tsx` → "Open skills in Capabilities", `/capabilities/skills`.
  - `TrustPolicySettings.tsx:35` → "Capabilities › Skills", `/capabilities/skills`.
- Modify the command palette (`cockpit/app/command-palette-search.ts`, `use-command-palette-search.ts`):
  - skill results open `/capabilities/skills?item=skill%3A<skillId>`
  - tool results open the tool's group (as above)
  - other kinds keep their Library link
  - the group label becomes "Capabilities", and a skill's description reads "Skill · Capabilities › Skills"
- Test (update): `cockpit-compatibility.test.ts`, `CapabilitiesArea.test.tsx`, `CommandPalette.test.tsx`, `LibraryArea.test.tsx`, `CapabilityCatalog.navigation.test.tsx`, and the four link owners' tests

- [ ] **Step 1: Update and write the tests:**
  - `/capabilities/skills` is native.
  - `it.each` over the four redirects, including `?workspaceId=w&shell=cockpit` kept and `?shell=classic` staying Classic.
  - `it("sends a Library skill record to its Capabilities panel")`.
  - `it("sends a Library tool record to its group, or to Tools when it has none")`.
  - The tab labels are `["Skills", "Connectors", "Tools"]`. The first visit still opens Connectors.
  - `it("lists only candidates, proposals and mesh entries in Library")`.
  - The palette opens a skill result in Capabilities.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them, the copy guard and the mc-next typecheck (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the Skills tab and move Library's skills and tools to Capabilities`.

### Task 8: Skill switch hook

**Files:**
- Create: `cockpit/areas/capabilities/skills/skill-switch-store.ts`
- Create: `cockpit/areas/capabilities/skills/use-skill-switch.ts`
- Test: `cockpit/areas/capabilities/skills/use-skill-switch.test.tsx`

**Interfaces:**
- Consumes: `setCapabilitySkillState` and `skillListQuery` (Task 6), `fetchApproval` (an approval's own statuses: pending, approved, rejected, expired), `describeApiError`.
- Produces:

```ts
export interface SkillSwitch {
  checked: boolean;            // state !== "off"
  paused: boolean;
  pending: boolean;            // a request or an applying change is in flight
  waiting: boolean;
  waitingApprovalId?: string;  // opens the in-place approval and the Inbox link
  failure?: { message: string; conflict: boolean };
  setOn(next: boolean): void;      // enabled | disabled
  setPaused(next: boolean): void;  // sleep | enabled (panel only)
  reload(): void;
}
export function useSkillSwitch(item: CapabilitySkillItem): SkillSwitch;
```

**Behaviour:**
- **Never optimistic.** Any change may wait for an approval, so the switch shows pending until the route answers.
  - `approved`: stays pending while the list is refetched every 1 s, until the item shows the new state (at most 15 s). After that it says "Still applying. Refresh to check."
  - `waiting`: records `{ approvalId, skillId, target }` in the module store, read through `useSyncExternalStore`, and keeps the old state. The approval is polled every 5 s.
    - approved → refetch until the state shows
    - rejected → "Not changed. The change was declined."
    - expired → "Not changed. The request expired."
  - `unchanged`: refetch.
- **A waiting item survives a reload.** The list's `pendingApprovalId` is the truth: when it is set and the store is empty, the hook shows waiting for it.
- **Errors:**
  - a 409 for a stale revision gives "Changed elsewhere. Reload to see the latest.", with `conflict: true`, and `reload()` refetches
  - a 409 for a pinned skill gives the route's message
  - anything else gives a plain message from `describeApiError`
- **One request per skill at a time;** a second click is ignored. Different skills may change at once.
- **`expectedRevision`** is the cached item's `revision`. After an applied change, the refetched list carries the new one.

- [ ] **Step 1: Write the failing tests:**
  - `it("doesn't show the new state before the change applies")`.
  - `it("turns on at once when the route approves it")`.
  - `it("waits, then turns on when the approval lands")`.
  - `it("says it was declined and stays off")`.
  - `it("says the request expired")`.
  - `it("picks up a wait from the list after a reload")`.
  - `it("explains a conflict and reloads")`.
  - `it("shows the pinned message")`.
  - `it("ignores a second click while saving")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): switch skills on and off, waiting for approval when it asks`.

### Task 9: Installed view: rows, filters and counts

**Files:**
- Create: `cockpit/areas/capabilities/skills/skill-view.ts`
- Create: `cockpit/areas/capabilities/skills/SkillsTab.tsx`
- Create: `cockpit/areas/capabilities/skills/SkillRow.tsx`
- Create: `cockpit/areas/capabilities/skills/use-skill-usage.ts`, modelled on `tools/use-tool-usage.ts`
- Modify: `cockpit/areas/capabilities/CategoryFilter.tsx`: add `label?: string` (default "Categories") for the group's accessible name.
- Test: `skill-view.test.ts`, `SkillsTab.test.tsx`, `CategoryFilter.test.tsx`

**Interfaces:**
- Consumes: Task 6's queries, `useSkillSwitch` (Task 8), `CapabilitySearch`, `CategoryFilter`, `LetterIcon`, `NoticeLine`, `Switch`, `StatusBadge`, `SKILL_CATEGORIES`, `SKILL_ORIGIN_LABELS`, `plural()`.
- Produces:

```ts
export function filterSkills(items: readonly CapabilitySkillItem[], f: { query: string; categories: readonly string[]; origins: readonly string[] }): CapabilitySkillItem[];
export function presentSkillState(item: CapabilitySkillItem, sw: Pick<SkillSwitch, "waiting">): StatusPresentation & { reason: string };
export function presentSkillUses(entry: CapabilitySkillUsageEntry | undefined, status: "ready" | "unknown"): string;
export function skillSearchSuggestion(items: readonly CapabilitySkillItem[]): string; // `Try "<label of the most common category, lower-cased>"`
```

**Copy:**

| Condition (first match) | State word | Reason line |
|---|---|---|
| waiting | Waiting on you in Inbox | "Open in Inbox" link (`inboxApprovalLink`) |
| hiddenInWorkspace | Hidden in this workspace | "Change it in Settings" → `/settings/citadel#workspace-capabilities` |
| off | Off | The AI can't use it |
| paused | Paused | Used only when you name it |
| on, not callable | Not usable yet | It hasn't been reviewed, so the AI can't use it |
| on, callable | On | the uses line |

- **Uses:**
  - `Used ${plural(n, "time")} in the last year`
  - `Not used yet` when n is 0
  - `Uses unknown` when usage is missing or failed
- **Pinned:** the switch is disabled with "Pinned. Change it through a proposal in Library."
- **Candidates:** when `candidatesWaiting > 0`, one `NoticeLine` reads "`${plural(n, "candidate")}` waiting in Library", linking to `/library?type=candidate_skill`.
- **Count trouble:** "Use counts can't be read right now." with "Try again". "Refresh counts" calls `fetchCapabilitySkillUsage({ refresh: true })` and writes the answer into the usage cache (P2 Task 8 note).

**Layout:**
- `CapabilitySearch` with the tab badge "Skills".
- Two `CategoryFilter` groups showing only values present in the list:
  - categories, in `SKILL_CATEGORIES` order
  - "Where it came from", in `SKILL_ORIGIN_LABELS` order
- `Section` "Installed", with its count, as `ul grid grid-cols-1 gap-2 sm:grid-cols-2`.
- **A row card** has a letter icon, the name with the origin label, a one-line description, the state badge and reason, a "View `<name>`" button (P2-R30: the card isn't a click target), and the `Switch` with `label` set to the skill name.
- **States:**
  - loading: `CHECKING_FOR_CHANGES`
  - list error with no cache: a plain message and Retry
  - cached list plus an error: one warning line
  - `issues`: one line each
  - no matches: `EmptyState` with "Clear filters"

- [ ] **Step 1: Write the failing tests:**
  - `skill-view.test.ts`:
    - `it.each` over the state table
    - the uses copy
    - search over name, description, tags and the category label
    - filters by category and origin
  - `SkillsTab.test.tsx` (mock the client):
    - `it("never shows plain On for a skill that isn't reviewed")`.
    - `it("shows Uses unknown and keeps the list when counts fail")`.
    - `it("never shows Not used yet while counts are loading or failed")`.
    - `it("links waiting candidates to Library, and hides the link when the count is missing")`.
    - `it("shows the wait with an Inbox link")`.
    - `it("offers Clear filters when nothing matches")`.
    - `it("names the origin group Where it came from")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): list installed skills with categories, switches and uses`.

### Task 10: Skill panel

**Files:**
- Create: `cockpit/areas/capabilities/skills/SkillPanel.tsx`
- Create: `cockpit/areas/capabilities/skills/use-skill-panel.tsx`
- Create: `cockpit/areas/capabilities/skills/skill-links.ts`
- Create: `cockpit/areas/capabilities/skills/SkillInstructions.tsx`
- Test: `SkillPanel.test.tsx`, `skill-links.test.ts`

**Interfaces:**
- Consumes: `skillDetailQuery` (Task 6), `useSkillSwitch` (Task 8), `SettingsApprovalDialog` (#625; import it, and if an import-boundary rule objects, move it to `areas/inbox/ApprovalInPlaceDialog.tsx` with a re-export), `NativeMessageRenderer`, `CapabilityPolicyEvidence` and `CapabilitySourceEvidence` (Library), `TechnicalDetails`, `usePanelFocus`.
- Produces:

```ts
export const SKILLS_HREF = "/capabilities/skills";
export const SKILL_PANEL_SOURCE_PREFIX = "capabilities-skills:"; // never the connectors "capabilities:" prefix
export function skillItemHref(skillId: string): string;   // `${SKILLS_HREF}?item=skill%3A<encoded id>`
export function skillIdFromSearch(search: string): string | undefined;
```

**Panel content, top to bottom:**
1. The state badge and reason (Task 9's table), the origin label and the category label.
2. The description.
3. The switch (`label` "Turn it on or off: `<name>`"), with:
   - the waiting or failure line under it
   - "Pause" when on, or "Resume" when paused, through `setPaused`
   - "Takes effect in new chats." when on
   - "Paused skills are used only when you name them in Chat." when paused
4. **The approval in place.** When `waitingApprovalId` is set, `SettingsApprovalDialog` opens once for it. "Open in Inbox" stays beside the waiting line.
5. "Uses": the uses line plus "last used `<relative time>`" when known.
6. "Tags": each tag is a button that puts the tag in the tab's search and closes the panel.
7. **"Instructions":** the `SKILL.md` body as safe markdown (`NativeMessageRenderer`, role assistant). Its container carries the class that scopes the markdown styles. It shows the first 12 lines, then "Show all".
8. "Where it came from", in plain words:
   - "Ships with GoatCitadel"
   - "Imported from a Git repository on `<host>`"
   - "Written by GoatCitadel from your chats"
   - "From this workspace's skills folder"

   Then the review state as a word: trusted "Trusted", approved "Reviewed", candidate "Not reviewed yet", deprecated "Retired", revoked "Revoked", draft "Draft".
9. `TechnicalDetails`, collapsed, holding:
   - the skill id, revision, lifecycle state, raw trust label, review warning, note, keywords, declared tools, requires
   - provenance: source ref, provider, commit, tree hash
   - `CapabilityPolicyEvidence` and `CapabilitySourceEvidence` for `detail.catalogEntry`, when present

**Opening and focus.** These work the way Tools' panel does:
- Opening the panel sets `?item=skill:<id>`, and loading that URL opens it once the list arrives. An unknown id is ignored.
- Closing replaces the address with `SKILLS_HREF` and returns focus to the View button that opened it.
- Detail loading shows `CHECKING_FOR_CHANGES`. A failed detail read shows a plain line and Retry, and the switch still works from the list item.

- [ ] **Step 1: Write the failing tests:**
  - `it("renders a script tag in the instructions as text")`.
  - `it("opens the approval in place once, and keeps Open in Inbox")`.
  - `it("pauses and resumes from the panel")`.
  - `it("searches the tab when a tag is pressed")`.
  - `it("keeps ids, URLs and hashes inside Technical details")`.
  - `it("opens from ?item= once the list loads and ignores unknown ids")`.
  - `it("keeps the Skills panel apart from the Connectors and Tools panels")`: a `capabilities:` or `capabilities-tools:` source never opens a Skills panel, and the reverse.
  - `it("returns focus to the View button")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): skill panel with instructions, uses, source and in-place approval`.

### Task 11: Public truth, checks and proof (PR 3b)

**Files:**
- Modify the public claims that list what Capabilities holds or where skills live. Find each with `git grep -n "Library › Skills\|Skills and tools\|Capabilities" -- README.md docs/1_0_CONTRACT.md apps/mission-control-next/AGENTS.md docs/CANONICAL_RUNTIME_STATE_MODEL.md`.
- Modify `docs/MCP_VENDOR_CATALOG_PROGRAM.md:61` only in PR 3c, when the packs panel moves.

- [ ] **Step 1: Make the doc edits.**
- [ ] **Step 2: Run the PR 3b checks:**
  - rebuild contracts and shared, then the mc-next typecheck
  - build mc-next, then `pnpm --filter @goatcitadel/mission-control-next perf:check`. Raise `LIVE_REGION_BUDGET` by exactly the number of `role="status"` or `role="alert"` regions added, each with a comment. `NativeMessageRenderer`'s fallback counts.
  - the cockpit tests for `areas/capabilities/`, `areas/library/`, `app/` and `data/`
  - `node scripts/check-mission-control-next-cockpit-copy.mjs`
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Get browser proof.** The controller does this against a sandbox gateway with the testbench recipe: `pnpm testbench` plus a proxy on 4173 or 5173. Show:
  - with the skip setting off, switching a skill on opens the approval in the panel, and one click turns it On
  - switching it off goes straight through (Q1: A)
  - with the setting on, switching on applies at once
  - a reload while waiting keeps the wait
  - Uses after seeding a chat turn profile, and "Not used yet" on a fresh install
  - the panel opens from `?item=`
  - `/library/skills`, `/library/capabilities` and a Library skill record land in Capabilities
  - Library shows only candidates, proposals and mesh entries
  - screenshots at desktop and phone width, in light and dark themes
- [ ] **Step 4: Commit:** `docs: describe the Skills tab`. Then open PR 3b.

---

# PR 3c: Discover and one-step install

### Task 12: Source check and install routes

**Files:**
- Modify: `packages/contracts/src/skill-hub-lifecycle.ts`: add `SKILL_HUB_BLOCKER_CODES` and `type SkillHubBlockerCode`. Type `standardizedBlockers` in `skill-hub-review-service.ts` with it (no behaviour change).
- Modify: `packages/contracts/src/capability-skills.ts` (types below)
- Modify: `capability-skill-actions-service.ts`, `capability-skills-service.ts`, `capability-skills-composition.ts` and `routes/capability-skills.ts`
- Test: the actions service tests, `routes/capability-skills.test.ts`, the guard test, and a real-Gateway test using the shipped `himalaya` pack in a temp root

**Interfaces:**
- Consumes:
  - `skills.reviewSkillHubSource`, `skills.createSkillHubApproval` and `skills.listSkillHub` (`composed.skills`, gateway-route-composition-memory.ts:114-117)
  - `GatewayService.resolveApproval`
  - `allowsOperatorApprovalSkip`
- Produces:

```ts
export const SKILL_HUB_BLOCKER_CODES = [
  "CONDITIONAL_REVIEW_REQUIRED", "PROMPT_INJECTION_DETECTED", "PROMPTWARE_SCAN_INCOMPLETE",
  "REFERENCE_ONLY_SOURCE", "SUSPICIOUS_SCRIPT_INDICATOR",
] as const;
export type CapabilitySkillSource = { kind: "pack"; packId: string } | { kind: "git"; sourceRef: string };
export type CapabilitySkillInstallStep =
  | "check_passed" | "blocked"
  | "waiting_install" | "installing" | "installed_off"
  | "waiting_switch_on" | "switching_on" | "done" | "failed";
export interface CapabilitySkillInstall {
  snapshotId: string; name: string; description: string;
  source: CapabilitySkillSource & { host?: string; commit?: string };
  step: CapabilitySkillInstallStep;
  approvalId?: string;                 // while waiting_install or waiting_switch_on
  blockers: SkillHubBlockerCode[];
  findingCount: number;
  asksFor: { tools: string[]; networkHosts: string[]; envVars: string[]; readsFiles: string[]; writesFiles: string[]; includesScripts: boolean; dependencies: string[] };
  installedSkillId?: string;           // once switched on
  failure?: string;                    // a blocked or manual-reconciliation settlement, plain
}
export interface CapabilitySkillReviewRequest { workspaceId: string; source: CapabilitySkillSource; idempotencyKey: string }
export interface CapabilitySkillOperationRequest { workspaceId: string; snapshotId: string; operationKind: "install_inactive" | "activate" }
// POST /api/v1/capabilities/skills/reviews     → 201|200 CapabilitySkillInstall
// GET  /api/v1/capabilities/skills/installs?workspaceId= → 200 { installs: CapabilitySkillInstall[] }
// POST /api/v1/capabilities/skills/operations  → 202|200 CapabilitySkillActionOutcome
```

**Rules:**
- **`step`** is derived on the Gateway from the Hub operator item (`runtime`, `approvals`, `actions`, settlements), never in the browser:

| Hub item | step |
|---|---|
| blocker codes present | blocked |
| no inactive candidate, install_inactive allowed, no approval | check_passed |
| pending install_inactive approval | waiting_install |
| approved install_inactive, not settled | installing |
| inactive candidate, not callable, no activate approval | installed_off |
| pending activate approval | waiting_switch_on |
| approved activate, not settled | switching_on |
| callable | done |
| latest settlement blocked or manual_reconciliation | failed |

- **The installs list** holds every Hub item in this workspace whose step is not `done`, `check_passed` or `blocked`, so an interrupted install is found again after a reload.
- **`asksFor`** comes from the snapshot's permission envelope. Tool ids stay ids; the cockpit labels them with Phase 2's `tool-labels.ts`.
- **Review errors** keep the review's own code in the error details (`UNKNOWN_FRONTMATTER_DIMENSION`, `BUNDLE_MANIFEST_INVALID`, an untrusted Git host and the rest), with a 422 and a plain message.
- **Operations** create the Hub approval through the existing owner, with the operator as requester. The skip applies only for the setting (on, not `remote_hardened`); there is no tightening case here. They use the same resolve, note and `operator_approval_skipped` audit (`kind: "skill_hub.lifecycle"`) as Task 5. A guard-blocked operation passes its 409 through with the blocker list.
- **Routes:**
  - Operator access, strict bodies.
  - Reviews: `{ max: 10, timeWindow: "1 minute" }`. Operations: `{ max: 20, timeWindow: "1 minute" }`. Installs: `{ max: 60, timeWindow: "1 minute" }`.
  - `markNoStore` on the read.
- **The guard** from Task 5 also covers the Hub resolve.

- [ ] **Step 1: Write the failing tests:**
  - `it.each(<step table rows>)("reads %s as %s")`.
  - `it("lists an install left between its two steps")`.
  - Real Gateway: `it("installs and switches on a pack at once when the setting is on")`. The skill is callable after `activate` settles and not before.
  - Real Gateway: `it("waits for each step when the setting is off")`.
  - Real Gateway: `it("leaves the old Hub operations route asking even with the setting on")`.
  - `it("always asks under remote_hardened")`.
  - `it("passes a blocked operation's blockers through as 409")`.
  - `it("keeps the review's reason code on a rejected source")`.
  - `it("types every blocker the review can produce")`.
  - The guard test, extended.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts and measure the changed files. Expect an allowance request for the composition or actions file; ask before adding one.
- [ ] **Step 4: Run the tests (PASS), plus** `pnpm verify:journey:producers` **and** `pnpm verify:skill-hub:lifecycle` **(PASS, unchanged).**
- [ ] **Step 5: Commit:** `feat(gateway): check and install skills from Capabilities in one step`.

### Task 13: Discover list

**Files:**
- Modify: `packages/contracts/src/capability-skills.ts` (types below)
- Modify: `apps/gateway/src/services/skill-import-service.ts`: the sources owner takes `{ network: false }`, which returns the curated entries and provider records without fetching the marketplaces. This adds no dependency reads.
- Modify: `capability-skills-service.ts`, `capability-skills-composition.ts` and `routes/capability-skills.ts`
- Test: `capability-skills-discover.test.ts`, `routes/capability-skills.test.ts`, `skill-import-service.test.ts`

**Interfaces:**
- Produces:

```ts
export type CapabilitySkillDiscoverState = "available" | "installed" | "installing" | "view_only";
export interface CapabilitySkillDiscoverItem {
  id: string;                            // "pack:<packId>" | "source:<canonicalKey>"
  name: string; description: string;
  category: SkillCategoryId;
  provider: "goatcitadel" | SkillSourceProvider;
  providerLabel: string;                 // "GoatCitadel", "AgentSkill", ...
  state: CapabilitySkillDiscoverState;
  install?: CapabilitySkillSource;       // absent → view only
  listingUrl?: string;                   // shown only as "See listing" and in Technical details
  installedSkillId?: string;
}
export interface CapabilitySkillDiscoverResponse {
  query?: string; items: CapabilitySkillDiscoverItem[];
  unavailableProviders: string[];        // provider labels that couldn't be searched
  generatedAt: string;
}
// GET /api/v1/capabilities/skills/discover?workspaceId=&q=&refresh= → 200 CapabilitySkillDiscoverResponse
```

**Rules:**
- **No search term:**
  - the shipped packs (`SHIPPED_SKILL_PACKS`), category from `SHIPPED_SKILL_CATEGORIES`
  - the curated entries, read with `network: false`
- **A search term** (2 to 100 characters) adds the marketplace results. Each normalized term (trimmed, lower-cased) gets its own `createUsageCache` with a 10-minute life: shared in-flight, failures not cached, `refresh=true` bypasses. Keep at most the 50 most recently used terms, dropping the oldest.
- **`install`:**
  - a pack gives `{ kind: "pack" }`
  - an item whose `repositoryUrl` (else `sourceUrl`) is `https` on GitHub, GitLab, Bitbucket or Codeberg (the review's trusted forge hosts; import that set rather than copying it) gives `{ kind: "git", sourceRef }`
  - anything else is `view_only`
- **`installed`:** the source matches an installed skill. Match on normalized refs (lower-case host, no `www.`, no `.git`, no trailing slash) against installed skills' `lifecycle.provenance.sourceRef` and the source owner's `alreadyInstalled`. For a pack, find how a pack review records provenance.
- **`installing`:** the source matches an entry in Task 12's installs list.
- **Category:** `skillCategoryFor({ skillId: "", tags })`.
- **Provider statuses** of `degraded` or `unavailable` add their label to `unavailableProviders`. The list is still 200.
- **Route:**
  - Query: `z.object({ workspaceId, q: z.string().min(2).max(100).optional(), refresh: z.enum(["true","false"]).optional() }).strict()`.
  - Rate limit: `{ max: 30, timeWindow: "1 minute" }`.
  - `markNoStore`.

- [ ] **Step 1: Write the failing tests:**
  - `it("makes no network call without a search term")`.
  - `it("offers Install only for packs and trusted Git hosts")`.
  - `it("marks a source installed when an installed skill came from it, ignoring .git and letter case")`.
  - `it("marks a source installing while it is between steps")`.
  - `it("keeps packs and curated entries when a marketplace is down, and names it")`.
  - `it("caches a search for 10 minutes and searches again on refresh")`.
  - Route: `it("rejects a one-character search")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it, rebuild contracts and measure.** **Step 4: Run them and the publish sweep (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): serve the Capabilities Discover list`.

### Task 14: Discover view

**Files:**
- Modify: `packages/mission-control-shared/src/api/capability-skills.ts`. Add:
  - `fetchCapabilitySkillDiscover`
  - `reviewCapabilitySkill`
  - `fetchCapabilitySkillInstalls`
  - `requestCapabilitySkillOperation`
- Modify: `cockpit/data/capability-skills-query.ts` and `query-keys.ts`:
  - `capabilitySkillDiscover: (ws, q) => ["skills", "capability-skill-discover", ws, q]`
  - `capabilitySkillInstalls: (ws) => ["skills", "capability-skill-installs", ws]`

  Add both prefixes to the `"skills"` branch of `event-map.ts`, and to the source that carries Skill Hub approvals and settlements.
- Create: `cockpit/areas/capabilities/skills/DiscoverView.tsx`, `DiscoverRow.tsx`, `discover-view.ts`
- Modify: `SkillsTab.tsx`
  - Add the Installed / Discover segments with `ui/Tabs`. `?view=discover` makes the segment linkable, and Installed is the default.
  - Search and the category filter are shared between the two views. "Where it came from" lists origins in Installed and providers in Discover.
- Test: `DiscoverView.test.tsx`, `discover-view.test.ts`, the shared client tests

**Behaviour:**
- **Search** sends `q` after 400 ms of no typing, once it has 2 or more characters. Filters apply in the browser.
- **A row card** has a letter icon, the name, "From `<providerLabel>`", a one-line description, the state and one action:
  - available: "Install `<name>`", which opens Task 15's panel
  - installed: "View `<name>`", which opens the Installed skill's panel
  - installing: "Continue `<name>`", which opens the install panel at its current step
  - view only: "See listing", an external link to `listingUrl` (`rel="noopener noreferrer"`) with the line "Can't be installed from here"
- **Lines:**
  - `unavailableProviders` give one line: "`<labels>` couldn't be searched right now."
  - An empty search result says "No skills match `<term>`", with "Clear search".
  - A failed search never says "No skills match". It shows the error line and "Try again".
- **The placeholder** reads `Try "<label of the most common category in the list, lower-cased>"`.

- [ ] **Step 1: Write the failing tests:**
  - `it("shows packs and curated skills before any search")`.
  - `it("searches after a pause, from two characters")`.
  - `it("offers See listing for a source it can't install")`.
  - `it("names the sites that couldn't be searched and keeps the rest")`.
  - `it("never says No skills match when the search failed")`.
  - `it("opens the Discover segment from ?view=discover")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): discover skills from GoatCitadel and skill sites`.

### Task 15: Install panel, install flow and Import from Git

**Files:**
- Create: `cockpit/areas/capabilities/skills/use-skill-install.ts` and `skill-install-store.ts`
- Create: `cockpit/areas/capabilities/skills/SkillInstallPanel.tsx`
- Create: `cockpit/areas/capabilities/skills/skill-check-copy.ts`
- Modify: `SkillsTab.tsx`: "Import from Git" goes into `CapabilitySearch` `actions`, and `?item=install:<snapshotId>` reopens an install.
- Modify: `LibraryArea.tsx`: drop `LibrarySkillPacks` from the footer, and delete `LibrarySkillPacks.tsx` and its test. The packs now live in Discover. `MeshCapabilityPublications` stays.
- Modify: `docs/MCP_VENDOR_CATALOG_PROGRAM.md:61`: the packs install from Capabilities › Skills › Discover.
- Test: `use-skill-install.test.tsx`, `SkillInstallPanel.test.tsx`, `skill-check-copy.test.ts`

**Interfaces:**
- Consumes: Task 14's client, `fetchApproval`, `SettingsApprovalDialog`, `tool-labels.ts` (Phase 2), `inboxApprovalLink`.
- Produces:

```ts
export type SkillInstallState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "check_failed"; message: string; code?: string }
  | { phase: "ready"; install: CapabilitySkillInstall }          // check_passed or blocked
  | { phase: "following"; install: CapabilitySkillInstall }      // any later step
  | { phase: "done"; skillId: string }
  | { phase: "failed"; message: string; install?: CapabilitySkillInstall };
export function useSkillInstall(key: string): {
  state: SkillInstallState;
  check(source: CapabilitySkillSource): void;
  confirm(): void;   // requests install_inactive, then activate once the install lands
};
export const SKILL_BLOCKER_COPY: Readonly<Record<SkillHubBlockerCode, string>>;
export function describeCheckFailure(code: string | undefined, fallback: string): string;
```

**Flow:**
1. `check` posts the review with an `idempotencyKey` (`crypto.randomUUID()`, kept for retries).
2. `confirm` requests `install_inactive`.
3. The flow then follows `fetchCapabilitySkillInstalls`:
   - every 1 s while a step is applying
   - every 5 s while one is waiting
4. When the step reads `installed_off` after this confirmation, it requests `activate` without a second confirmation. The one confirmation covers both requests, and each still asks when the setting is off.

The state lives in a module store keyed by snapshot id, so a panel unmount or list refresh doesn't lose it. After a reload, the installs list is the truth. An install found at `installed_off` with no flow running shows "Installed, not switched on" and a "Switch on" button, which requests `activate`.

**Panel content:**
- "What it does": the description.
- "Where it comes from":
  - "A skill pack that ships with GoatCitadel"
  - "A Git repository on `<host>`"
- "What it asks for", with each line shown only when it applies:
  - the tool labels
  - "Reaches `<hosts>`"
  - "Needs settings: `<env var names>`"
  - "Reads `<paths>`" and "Writes `<paths>`"
  - "Includes scripts. GoatCitadel never runs them."
  - "Nothing beyond its instructions", when every list is empty
- "Checks":
  - "Passed GoatCitadel's checks"
  - or one plain line per blocker from `SKILL_BLOCKER_COPY`, plus "Show details", a `TechnicalDetails` with the codes and finding count
- "What happens next":
  - setting on: "Installs and switches on at once, because your setting to skip approvals for your own changes is on."
  - setting off: "Asks you twice: once to install it and once to switch it on."
- **The primary button** reads "Install and switch on". It is enabled only at `check_passed`.
- **Progress** is a step list (Check, Install, Switch on) with the live state.
- **Waiting steps** open `SettingsApprovalDialog` once per approval, with "Waiting on you in Inbox" and "Open in Inbox".
- **`done`** swaps to the Installed skill panel (Task 10). **`failed`** names the step and the plain failure.

**Copy maps** (exact copy):
- **`SKILL_BLOCKER_COPY`:**
  - PROMPT_INJECTION_DETECTED: "Its instructions try to override GoatCitadel's rules."
  - PROMPTWARE_SCAN_INCOMPLETE: "Some of its files couldn't be checked."
  - SUSPICIOUS_SCRIPT_INDICATOR: "It includes scripts that look unsafe."
  - REFERENCE_ONLY_SOURCE: "This source can be read for reference but not installed."
  - CONDITIONAL_REVIEW_REQUIRED: "It needs a closer review before it can be installed."
  - Every blocked panel ends with "So it can't be installed."
- **`describeCheckFailure`:**
  - UNKNOWN_FRONTMATTER_DIMENSION: "Its SKILL.md has settings GoatCitadel doesn't recognise."
  - BUNDLE_MANIFEST_INVALID and UNKNOWN_BUNDLE_DIMENSION: "Its list of files isn't valid."
  - an untrusted host (match the review's code for it): "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg."
  - anything else: `fallback` (the `describeApiError` wording)

**Import from Git** opens the panel with a field:
- the label "Git repository address" and the hint "From GitHub, GitLab, Bitbucket or Codeberg"
- a "Check" button, which calls `check({ kind: "git", sourceRef })`

Only an `https` URL is accepted in the browser (a plain message otherwise). The Gateway's rules decide the rest.

- [ ] **Step 1: Write the failing tests:**
  - `it("requests install, then switch on, from one confirmation when the setting is on")`: the call order is asserted.
  - `it("waits for each step in place when the setting is off")`.
  - `it("picks up an install left between its steps after a reload, and offers Switch on")`.
  - `it("never shows Installed before switch on settles")`.
  - `it("explains each blocker in plain words and offers no Install")`.
  - `it("lists what the skill asks for with tool labels, not ids")`.
  - `it("refuses an address that isn't https before checking")`.
  - `it("explains a Git host it won't install from")`.
  - `skill-check-copy.test.ts`: every `SKILL_HUB_BLOCKER_CODES` value has copy, and none uses a copy-guard word.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them, the Library tests and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): install skills in one step from Discover or a Git address`.

### Task 16: Public truth, checks and proof (PR 3c)

- [ ] **Step 1: Update the public claims** that describe installing skills or skill packs (`git grep -n "skill pack\|install.*skill\|Skill Hub" -- README.md docs/1_0_CONTRACT.md docs/CANONICAL_RUNTIME_STATE_MODEL.md docs/CLAW_HUB_NATIVE_CAPABILITY_GUIDANCE.md`). Keep the Skill Hub rules exactly as stated, and add where the operator does it.
- [ ] **Step 2: Run the PR 3c checks:**
  - typecheck for contracts, gateway and shared, plus mc-next
  - `perf:check`, with the live-region rule from Task 11
  - the gateway tests from Tasks 12–13
  - the cockpit tests for `areas/capabilities/` and `areas/library/`
  - `pnpm verify:journey:producers`
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:architecture:metrics`
  - the copy guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Get browser proof** on the testbench sandbox. Show:
  - Discover before any search, and a search
  - installing the `himalaya` pack with the setting on (two steps, no asks)
  - installing it with the setting off: two approvals in place, then a reload between them, which shows "Installed, not switched on" and resumes
  - Import from Git with a public GitHub skill repository, if the network allows (otherwise a refused host shows its plain line)
  - a blocked source's plain explanation, using a fixture snapshot if no live one is at hand
  - phone and desktop widths, light and dark themes
- [ ] **Step 4: Commit:** `docs: describe installing skills from Capabilities`. Then open PR 3c.

---

## Spec coverage for Phase 3

| Spec requirement | Task |
|---|---|
| Installed and Discover as two segments over the same search and filters | 9, 14 |
| One category per skill, stable buttons; frontmatter or a mapping beside the coverage file | 1 (a contracts map tied to the coverage file by test) |
| Second filter: Built in, Imported, Self-authored, Workspace | 1, 4, 9 |
| Installed: a switch (enabled or disabled) and a usage count per skill | 4, 5, 8, 9 (uses from chat turns, see below) |
| Paused lives in the panel | 8, 10 |
| Discover from the existing skill sources; installed entries marked, not hidden | 13, 14 |
| Import from Git through the existing checks | 12, 15 |
| One-step install: checks, the result in the panel, one confirmation runs install_inactive then activate, each its own operation; never callable before activation | 12, 15 |
| Scan-blocked: plain words, details on demand | 12, 15 |
| Skill panel: SKILL.md body, source and provenance, trust and lifecycle, uses and last use, clickable tags, inspectors in Technical details | 4, 10 |
| Candidates stay in Library; "N candidates waiting in Library" link | 4, 7, 9 |
| `/library/skills` redirects with the Skills tab; `/library/capabilities` once both have shipped | 7 |
| Slimmed Library view for candidates, proposals and mesh entries | 7 |
| Command palette opens the Capabilities item | 7 |
| Hidden in this workspace never shows plain On | 4, 9 |
| #572 skip covers Capabilities actions; setting off keeps today's approvals; `remote_hardened` always asks; AI actions keep every approval | 5, 12 |
| Cached instant paint, "Takes effect in new chats", empty and error states with a next action | 6, 9, 10, 14 |

**Deliberate limits, and why:**
- **Uses count chat turns that loaded the skill.** That covers Chat, scheduled and remote-worker turns. The spec's `usageCount` only moves on the resolve-activation route, so it would read "Not used yet" for skills used daily.
- **No index for the use counts.** The 10-minute cache bounds the scan, and an index would bring the Postgres dual-lineage migration work. Revisit if a large install shows a slow first read.
- **Code Mode has no Library entries today** (the Gateway lists none), so the slimmed Library holds candidates, proposals and mesh entries.
- **Switches are install-wide,** like the skill state they change. Hidden-in-workspace and self-authored skills follow the active workspace.
- **Discover's marketplaces are searched with the existing fetch,** which predates the network allowlist and reaches two fixed sites. Opening Discover doesn't use it.

**Found on the way (follow-ups, not in this plan):**
- `GET /api/v1/skills` drops `workspaceId` in production (`gateway-route-composition-memory.ts:121`), so approved workspace candidate skills never appear there. Task 4's new route doesn't depend on it.
- Skill Hub activation writes `source.json` without a `canonicalKey`, so the old sources route never marks Hub installs as installed. Task 13 matches on provenance instead.
- Connectors and Tools still send approvals to Inbox. Moving them into their panels would match the Skills tab and the 2026-10-28 feedback.
- Removing a skill (Q3), if the operator wants it later.
