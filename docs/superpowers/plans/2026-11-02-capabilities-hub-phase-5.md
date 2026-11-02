# Capabilities Hub Phase 5 (Claude Code plugin import) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Plugins tab check and install a Claude Code plugin, labelled experimental, by translating it into a GoatCitadel plugin that holds only its skills and the remote connectors that exactly match a connector template GoatCitadel ships. Everything else in the plugin is listed as left out, with a plain reason, and never runs.

**Architecture:**
- **Skill Hub rules come first** (PR 5a). The Skill Hub review learns a Claude Code frontmatter dialect, limited to an explicit key list and applied only to skills of a Claude Code-format plugin. It keeps the exact bytes: nothing rewrites `SKILL.md`. Skills whose `SKILL.md` holds shell lines are refused. A plugin skill named like a bundled GoatCitadel skill is blocked by the Skill Hub's own install guard. Nothing produces a Claude Code skill yet, so the dialect is inert until PR 5b; the bundled-name block applies to every plugin skill at once.
- **Translation is pure and versioned** (PR 5b). `translateClaudeCodePlugin` reads only the snapshot, with bounded reads, and returns generated `goatcitadel-plugin.json` text plus one `ignored` entry per left-out part. The generated text goes through the same `parsePluginManifest`, so every named refusal still applies. A `goatcitadel-plugin.json` always wins over `.claude-plugin/plugin.json`.
- **Inspection gains a format.** It records `sourceFormat`, the translator version, the SHA-256 of `plugin.json`, a coverage count, the filled `ignored` list and per-piece warnings. In PR 5b a Claude Code plugin can be checked but not installed: the install action refuses it with a plain line until the panel can show what is left out.
- **Install re-translates; the record keeps the result** (PR 5c). Apply translates the verified snapshot again and refuses when the generated manifest's hash differs from the inspected one. Once installed, the plugin record keeps the generated manifest text, the left-out list and the coverage, so the detail, the uninstall and the uninstall scope read what was installed even after a later release changes the translator or the connector catalog.
- **The panel leads with coverage** (PR 5c). "Claude Code format · Unverified", an Experimental label, "GoatCitadel can use N of this plugin's M parts", a "What it leaves out" section grouped by kind, and each skill's warnings.

**Tech Stack:** TypeScript, React 19, TanStack Query, Tailwind (cockpit tokens), Fastify, zod 4, Vitest, the `yaml` package already used by `@goatcitadel/skills` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-11-01-claude-code-plugin-import-spike.md` (the spike report; its "Rough task list" is the starting point). The hub design is `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md` ("Claude Code plugin format", "Delivery order" item 5). Phase 4 (`2026-10-30-capabilities-hub-phase-4.md`) built the plugin model this plan extends.

**Measured on:** `origin/main` at `30b58863a` (PR 4e #697 and #698 merged). Every file:line below is from that commit.

## Decided by the operator

1. **Scope:** narrow, labelled experimental. Skills, plus remote connectors whose address exactly matches a shipped template. Nothing else comes across.
2. **Frontmatter:** a Claude Code dialect in the Skill Hub review, limited to an explicit list of allowed keys. The exact bytes are kept; `SKILL.md` is never rewritten, and these skills are not refused for carrying Claude Code's keys.
3. **Git subfolders (`git-subdir`)** are deferred. A Git source works only when the repository is the plugin.
4. **A second skill with the same name stays blocked** (`RUNTIME_ALREADY_EXISTS`, "A skill with this name is already installed.").
5. **A plugin skill that shares a name with a bundled GoatCitadel skill is blocked too**, just like a second skill of the same name. Task 1 implements it. The spike's own example follows: superpowers' `receiving-code-review` shares its name with `bundled:receiving-code-review`, so that skill is blocked, and because one blocked piece makes an inspection not installable (`capability-plugin-inspection-service.ts:291`), the superpowers plugin as a whole can be checked but not installed. Task 12's live proof is shaped around that.

## Decided without asking (check these)

- **A Claude Code plugin needs `.claude-plugin/plugin.json` with a `name`.** The spike would also accept a plugin with no manifest, named after its folder or marketplace entry. That name can't be read again from the snapshot at apply time: every later read is keyed only by the tree hash (`capability-plugins-composition.ts:203`, `plugin-install-change-plan-adapter.ts:359`), and a folder snapshot doesn't keep the folder's name. Without `plugin.json`, the source falls through to `MANIFEST_MISSING`, whose copy now names both files.
- **A missing `version` becomes `content-<first 12 hex of the snapshot's tree hash>`, for Git sources too.** The spike suggests the commit for Git, but the commit isn't derivable from the tree at apply time either. The pin still shows the commit.
- **A `SKILL.md` at the plugin's top level is left out**, with "A skill at the plugin's top level. Import it from the Skills tab instead." A skill piece's `path` must be a folder, and `isPortablePluginPath` refuses `.` (`packages/contracts/src/plugins.ts:385-396`).
- **An MCP entry without `type` is left out** ("It doesn't say how it connects."), never read as `http`. Matching fails closed.
- **A server that matches a template the Capabilities install can't use** (an API-key template, say) is left out with that rule's own message, not a blocked piece. One unusable app doesn't block the plugin's skills.
- **A description that the manifest schema would refuse** (over 500 characters, or holding control characters) is replaced by the fixed placeholder line, with a left-out entry saying so. The import never writes a description from the plugin's content.
- **Piece warnings are written by the plugin inspection, not the Skill Hub.** They are about how a Claude Code skill behaves here (placeholders, unread files, references to left-out parts), which the plugin check knows and the Skill Hub doesn't. The Skill Hub records only which keys it ignored (Task 2).
- **Shell lines are refused anywhere in `SKILL.md`**, inside an ordinary code block too. A false positive costs one skill; a miss would hand the model an instruction to run a command.
- **The bundled-name block lives in the Skill Hub's install guard, for plugin-sourced checks only.** One rule then holds at inspection and again when the skill's own install step applies. A skill imported from Git on the Skills tab keeps today's rules; that is named as a limit below.
- **PR order differs from the spike's sketch.** The Skill Hub rules land first while nothing can reach them, and install stays refused until the panel shows what was left out (spike risk 1).
- **The extensions SDK's `goatcitadel-plugin-preflight` doesn't read the Claude Code format.** The translator needs the connector catalog, which lives in the Gateway.
- **Built-in plugins are never translated.** They ship as GoatCitadel manifests.

## PR boundaries

Each PR is cut from a freshly fetched `origin/main` in its own worktree (superpowers:using-git-worktrees) and merged before the next one starts.

| PR | Tasks | Ships |
|---|---|---|
| 5a | 1–4 | Skill Hub only: the bundled-name block for every plugin skill, the Claude Code frontmatter dialect and the shell-line refusal (inert until 5b), the Skills tab's copy for the new code, docs. |
| 5b | 5–9 | Contracts and Gateway: format detection, the translator, connector matching, inspection with coverage, the left-out list and piece warnings. A Claude Code plugin can be checked; installing it answers a plain 409 until 5c. Cockpit gets only the new refusal copy. |
| 5c | 10–12 | Install, uninstall, list and detail for Claude Code plugins; the panel's format label, Experimental label, coverage, left-out list and warnings; public truth; browser and live proof. |

## Global Constraints

- Build each PR from a freshly fetched `origin/main`. This plan was written against `30b58863a`.
- **PLANNING ONLY until the operator approves.** The plan itself stays uncommitted until then.
- **The Gateway owns every read and write.** The cockpit renders `/api/v1/capabilities/plugins*` answers. It never reads a plugin's files, translates, matches a connector, or decides whether a piece passes (`apps/mission-control-next/AGENTS.md`, "Frontend Authority Boundary").
- **Plugins run no code.** Nothing in a snapshot executes. A stdio MCP server (which runs a program, the plugin's bundled code included), hooks of every kind, commands, agents, output styles, LSP servers, monitors and `bin/` executables are listed as not supported and ignored. No new piece kind is added.
- **The translator only reads.** It never follows a path outside the snapshot, never executes, never fetches, and stays within `PLUGIN_LIMITS` (`plugins.ts:20-26`). Its output goes through `parsePluginManifest`.
- **Exact bytes.** No step rewrites, renames or normalizes a skill's files. The dialect applies only when the review's `pluginSkill.dialect` is `"claude_code"`, which only the plugin inspection sets, and only for a Claude Code-format plugin. Any key outside the explicit lists stays `UNKNOWN_FRONTMATTER_DIMENSION`.
- **Trust is always Unverified** for an imported plugin, Anthropic's marketplace included. Never suggest Anthropic endorses an import.
- **Truth beats theater.** Every limit is named in plain words in the panel, the docs and the PR bodies: "Experimental", the coverage line, the left-out list, "Its instructions mention parts GoatCitadel left out", and so on. Never "Claude Code plugins work in GoatCitadel".
- **Visible copy follows DESIGN.md.** Sentence case, plain words, `plural()` for counts. The copy guard bans "posture", "Gateway", "revision", "evidence", "owner", "snapshot", "canonical", "durable", "projection", "replay", "admission" and "readback" (`scripts/check-mission-control-next-cockpit-copy.mjs`). That applies to every Gateway-written line the panel shows (`reason`, `warnings`, `check.message`). Paths, hashes, ids and raw codes appear only inside `TechnicalDetails`. Run the copy guard and `scripts/check-mission-control-next-raw-values.mjs` in every cockpit task.
- **Architecture metrics:**
  - Never run `architecture:baseline:update`.
  - GatewayService stays at or under 13132 counted lines (`split(/\r?\n/).length`). It is 13069 on `30b58863a`. No task here edits it.
  - Every new Gateway file measures 0/0 on `countHostMemberAccesses` and `countDependencyMemberAccesses` (`scripts/verification/lib/architecture-metrics.mjs`): pure functions over arguments, or plain readers.
  - A touched file's counts must not rise. If one would, extract the work into a new 0/0 file. Don't ask for an allowance: any C0 allowance or baseline change is the operator's call, and this plan needs none.
  - `routeFacingServiceCount` stays 70. No route service is added or removed.
- **No storage migrations.** Every new field rides in the `capability_plugins_v1` JSON row or the Skill Hub snapshot's existing JSON columns, and is optional so older rows still read.
- **Every mutation route stays behind the idempotency plugin.** No route is added.
- **A visual rebaseline happens only after PR 5c merges, as its own PR against `main`.**
- No new dependencies. After changing `packages/contracts` or `packages/skills`, rebuild before running dependents' tests. Never `prettier --write` a directory glob. Never `git stash`. No personal paths in tracked files.
- Run tests at low priority with `--maxWorkers=2`, one heavy job at a time.
- **Commands:**
  - Contracts: `pnpm --filter @goatcitadel/contracts exec vitest run <path> --maxWorkers=2`
  - Gateway: `pnpm --filter @goatcitadel/gateway exec vitest run <path relative to apps/gateway> --maxWorkers=2`, run from `apps/gateway` if a config ENOENT appears.
  - Cockpit: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path relative to the app> --maxWorkers=2`
  - Fixtures: Claude Code plugin trees are written by a test helper (Task 6), never committed as folders.

## Review Focus

1. **A skill's text depends on parts that were left out.** It tells the model to run `/<plugin>:<command>`, call `mcp__plugin_<plugin>_<server>__<tool>`, use a subagent, or run `${CLAUDE_PLUGIN_ROOT}/scripts/…`. The skill still installs, and its piece says "Its instructions mention parts of the plugin GoatCitadel left out (…). It may not work fully without them." *(Task 8: `it("warns when a skill mentions a left-out command, connector tool, subagent or script")`)*
2. **The translation changes after the check.** A release bumps the translator or the connector catalog between inspection and install, or after install. Install refuses with "This plugin changed since it was checked. Check it again." An installed plugin's detail, uninstall labels and uninstall scope still read the manifest it was installed from. *(Task 10: `it("refuses to apply when the translation changed since the check")`, `it("reads an installed plugin's manifest from its record after the translation changes")`)*
3. **`plugin.json` points outside the plugin.** For example `"skills": "../shared"`, an absolute path, `"commands": ["/etc"]`, or a path with `\`. Each is left out with "Points outside the plugin, so GoatCitadel leaves it out.", and nothing outside the snapshot is read. *(Task 7: `it("leaves out paths that point outside the plugin and reads nothing outside it")`)*
4. **A repository carries both formats.** A plugin with `goatcitadel-plugin.json` and `.claude-plugin/plugin.json` is read as GoatCitadel's own: `sourceFormat` "goatcitadel", `ignored` empty, no Claude Code label. *(Task 8: `it("reads a goatcitadel-plugin.json first when both manifests are there")`)*
5. **A native plugin's skill review is unchanged.** Adding the dialect must not change what a GoatCitadel-format plugin skill's review records: no new finding codes, the same provenance. *(Task 2: `it("reviews a native plugin skill exactly as before")`)*

---

# PR 5a: Skill Hub rules

### Task 1: Block a plugin skill named like a bundled skill

**Files:**
- Create: `apps/gateway/src/services/plugin-skill-name-rules.ts`. Test: `plugin-skill-name-rules.test.ts`.
- Modify: `apps/gateway/src/services/skill-hub-operator-service.ts:682-688`. In the `install_inactive` branch, push `BUNDLED_SKILL_NAME_TAKEN` when the check came from a plugin and its skill name is a bundled one.
- Modify: `packages/contracts/src/skill-hub-lifecycle.ts:74-94`: add `"BUNDLED_SKILL_NAME_TAKEN"` to `SKILL_HUB_BLOCKER_CODES`. Extend `skill-hub-lifecycle.test.ts:127-133`, the install guard list.
- Modify: `apps/gateway/src/services/capability-plugin-inspection-service.ts:368-397` (`installableSkill`). A `BUNDLED_SKILL_NAME_TAKEN` blocker maps to its own message, checked before the name-taken and left-over rules.
- Modify: `apps/mission-control-next/src/cockpit/areas/capabilities/skills/skill-check-copy.ts:7-28`. The typed record needs the new code. It is not in `ALREADY_INSTALLED` (`:36-40`): the skill isn't installed, it is refused.
- Test: `skill-hub-operator-service.test.ts`, `capability-plugin-inspection-service.test.ts`, `skill-check-copy.test.ts`

**Interfaces:**
- Produces:

```ts
// plugin-skill-name-rules.ts
/** The names of the skills that ship bundled with GoatCitadel: each `bundled:<name>` in `listBundledSkillLockEntries()`. */
export function bundledSkillNames(): ReadonlySet<string>;
/** Whether a plugin skill's name (the `<name>` of its `extra:<name>` id) is taken by a bundled skill. Exact match. */
export function isBundledSkillName(name: string): boolean;
export const BUNDLED_SKILL_NAME_TAKEN = "BUNDLED_SKILL_NAME_TAKEN" as const;
/** Exact copy, in the style of "A skill with this name is already installed." */
export const BUNDLED_SKILL_NAME_TAKEN_MESSAGE = "GoatCitadel already has a built-in skill with this name.";
```

**Rules:**
- The guard reads the name with the operator service's own `resolveSnapshotSkillId` (`:940-949`) and applies only when `snapshot.sourceProvider === "goatcitadel_plugin"` (`PLUGIN_SOURCE_PROVIDER`, `skill-hub-plugin-skill-source.ts:18`). It covers native and Claude Code-format plugins alike.
- It blocks `install_inactive` only. A plugin skill already installed before this lands keeps working and can still be switched on, off and revoked; a later bundled skill of the same name doesn't revoke it.
- Skills tab copy: `BUNDLED_SKILL_NAME_TAKEN: "GoatCitadel already has a built-in skill with this name."`
- The bundled list is the generated lock. It is static per release, so no reader is added and the operator service's dependency count doesn't move.

- [ ] **Step 1: Write the failing tests:**
  - Name rules: `it("lists every bundled skill name from the lock")`, which asserts that `receiving-code-review` and `documentation` are in it and that every entry's id starts with `bundled:`.
  - Name rules: `it("matches names exactly")`. `receiving-code-review` is taken; `receiving-code-review-2` and `Receiving-Code-Review` are not.
  - Operator: `it("blocks installing a plugin skill named like a bundled skill")`. A `goatcitadel_plugin` check named `receiving-code-review` reads `actions.install_inactive.allowed === false` with `BUNDLED_SKILL_NAME_TAKEN` in its blockers.
  - Operator: `it("leaves a Skills tab import of that name to its existing rules")`. A `git` check named `receiving-code-review` has no `BUNDLED_SKILL_NAME_TAKEN`. This pins the scope.
  - Operator: `it("still switches on and revokes a plugin skill installed before the block")`.
  - Inspection: `it("blocks a plugin skill named like a bundled skill with the built-in line")`. The piece reads `{ status: "blocked", code: "BUNDLED_SKILL_NAME_TAKEN", message: "GoatCitadel already has a built-in skill with this name." }`, and the inspection is not installable.
  - Inspection: `it("passes the built-in Browser checks skill")`, a regression guard.
  - Contracts: the install guard list includes the new code.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure `plugin-skill-name-rules.ts` (0/0), and confirm `skill-hub-operator-service.ts` and `capability-plugin-inspection-service.ts` don't rise.
- [ ] **Step 4: Run them, plus `skill-hub-operator-service.test.ts` in full, `pnpm verify:skill-hub:lifecycle`, the cockpit `areas/capabilities/skills` tests and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(skills): block a plugin skill named like a bundled skill`.

### Task 2: The Claude Code frontmatter dialect in the Skill Hub review

**Files:**
- Create: `apps/gateway/src/services/skill-hub-claude-code-dialect.ts`. Test: `skill-hub-claude-code-dialect.test.ts`.
- Modify: `apps/gateway/src/services/skill-hub-plugin-skill-source.ts`:
  - `SkillHubPluginSkillInput` (`:27-37`) gains `dialect?: "claude_code"`
  - `resolvePluginSkillSource` (`:58-109`) refuses any other value with "The plugin's skill format isn't one GoatCitadel knows."
  - `PluginSkillRecord` (`:40-44`) carries it
- Modify: `apps/gateway/src/services/skill-hub-review-service.ts`:
  - `assertKnownFrontmatterShape` (`:718-735`) takes the dialect and returns `{ declaredVersion?: string; dialect?: ClaudeCodeFrontmatterReading }`
  - `prepareReview` (`:456-508`) passes `source.plugin?.dialect` and records the reading
  - `buildAudit` (`:596-643`) adds the dialect's finding codes
- Test: `skill-hub-review-service.test.ts`, plus `capability-plugin-guards.test.ts`, whose guard must also hold for `dialect:`. Only `capability-plugin-inspection-service.ts` may build a `pluginSkill`.

**Interfaces:**
- Produces:

```ts
// skill-hub-claude-code-dialect.ts
export const CLAUDE_CODE_SKILL_DIALECT = {
  /** Left out, and recorded. Leaving them out never widens what the model may do. */
  ignoredKeys: ["allowed-tools", "argument-hint", "license", "compatibility", "version", "model", "effort", "when_to_use"],
  /** Left out with a warning: `user-invocable: false` widens what the operator can start (never the model). */
  warnedKeys: ["user-invocable"],
  /** Refused: leaving them out would loosen the skill or change where it runs. */
  refusedKeys: ["disable-model-invocation", "disallowed-tools", "paths", "hooks", "context", "agent", "background"],
  /** Under `metadata`, beside GoatCitadel's own version, tags, tools, requires and keywords. */
  ignoredMetadataKeys: ["author", "organization", "date", "abstract"],
} as const;
export const CLAUDE_CODE_SETTING_NOT_KEPT = "CLAUDE_CODE_SETTING_NOT_KEPT" as const;
export interface ClaudeCodeFrontmatterReading {
  /** Sorted; metadata keys as `metadata.<key>`. */
  ignoredKeys: string[];
  /** `user-invocable` when its value is `false`; a `true` value is only ignored. */
  widenedKeys: string[];
}
export type ClaudeCodeFrontmatterCheck =
  | { ok: true; reading: ClaudeCodeFrontmatterReading }
  | { ok: false; code: typeof CLAUDE_CODE_SETTING_NOT_KEPT | "UNKNOWN_FRONTMATTER_DIMENSION"; key: string };
export function checkClaudeCodeFrontmatter(frontmatter: Record<string, unknown>): ClaudeCodeFrontmatterCheck;
```

**Rules:**
- Without a dialect, `assertKnownFrontmatterShape` behaves exactly as today.
- With `"claude_code"`, the order is:
  1. Any refused key: `CLAUDE_CODE_SETTING_NOT_KEPT`. The first in the list's order wins, so the message is stable.
  2. Any other key outside `name`, `description`, `metadata` and the ignored and warned lists: `UNKNOWN_FRONTMATTER_DIMENSION`.
  3. `metadata` that isn't an object, or holds a key outside GoatCitadel's five and `ignoredMetadataKeys`: `UNKNOWN_FRONTMATTER_DIMENSION`.

  Both refusals go through `rejectReview(code, message)`. The message names the key, for the log only; the panel words the code (Task 8).
- `declaredVersion` still comes only from `metadata.version`. A top-level `version` is ignored and recorded.
- **What the review records for a dialect skill:**
  - provenance gains `frontmatterDialect: "claude_code"` and `ignoredFrontmatterKeys`
  - `findingCodes` gains `CLAUDE_CODE_DIALECT_APPLIED`, plus `CLAUDE_CODE_KEYS_IGNORED` when anything was ignored and `CLAUDE_CODE_USER_INVOCABLE_WIDENED` when `widenedKeys` is not empty
  - `REVIEW_POLICY_REVISION` (`:50`) stays 1. Native reviews are byte-identical, and dialect reviews are new records.
- The dialect never adds to `blockerCodes`. It either refuses or passes, so `SKILL_HUB_BLOCKER_CODES` doesn't change here.
- The runtime still needs `name` and `description` (`SkillFrontmatterSchema`, `packages/skills/src/frontmatter.ts:31-37`). A Claude Code skill without them fails as `FRONTMATTER_INVALID`, as any skill does.

- [ ] **Step 1: Write the failing tests:**
  - Dialect: `it.each` over each ignored key, which passes and is recorded in `ignoredKeys`.
  - Dialect: `it.each` over each refused key, which answers `CLAUDE_CODE_SETTING_NOT_KEPT` naming that key.
  - Dialect: `it("refuses a key no list names")`, with `foo: 1` and with `metadata.homepage`, each `UNKNOWN_FRONTMATTER_DIMENSION`.
  - Dialect: `it("names the refused key before an unknown one")`.
  - Dialect: `it("warns only for user-invocable false")`.
  - Review: `it("reviews a Claude Code skill with allowed-tools and argument-hint and keeps its bytes")`. The artifact's tree hash equals the source folder's.
  - Review: `it("records the ignored keys in provenance and the finding codes")`.
  - Review: `it("refuses disable-model-invocation in a Claude Code skill")`.
  - Review: `it("refuses allowed-tools when no dialect is given")`. The native rule is unchanged.
  - Review: `it("reviews a native plugin skill exactly as before")` (Review Focus 5). The finding codes and provenance equal a fixture recorded before the change.
  - Review: `it("refuses a dialect the plugin check didn't name")`, with `dialect: "other"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Measure the new file (0/0) and `skill-hub-review-service.ts` (no rise).
- [ ] **Step 4: Run them, the Skill Hub test files and `pnpm verify:skill-hub:lifecycle` (PASS).**
- [ ] **Step 5: Commit:** `feat(skills): review Claude Code skills with an explicit frontmatter dialect`.

### Task 3: Refuse shell lines in Claude Code skills

**Files:**
- Modify: `apps/gateway/src/services/skill-hub-claude-code-dialect.ts`
- Modify: `skill-hub-review-service.ts`. With the dialect, `prepareReview` checks the exact `SKILL.md` text after the frontmatter check.
- Test: the two test files from Task 2

**Interfaces:**
- Produces:

```ts
export const SKILL_RUNS_SHELL_COMMANDS = "SKILL_RUNS_SHELL_COMMANDS" as const;
/** Whether SKILL.md holds a Claude Code shell line: an inline !`command`, or a fenced block opened with ```!. */
export function hasClaudeCodeShellLines(skillMarkdown: string): boolean;
```

**Rules:**
- Matches, anywhere in the file, code blocks included:
  - `` /(^|\s)!`[^`\n]+`/m ``
  - `` /^\s*```!/m ``
- A match is `rejectReview(SKILL_RUNS_SHELL_COMMANDS, …)`.
- Only `SKILL.md` is checked. It is the only file GoatCitadel puts into the model's context for a plugin skill (`packages/skills/src/skill-module-routes.ts:185-209`).

- [ ] **Step 1: Write the failing tests:**
  - `it.each` over `` !`git status` `` at a line start, after a space, and a ```` ```! ```` fence, each true.
  - `it.each` over `` `!important` ``, `!` in prose, and an image `![alt](x.png)`, each false.
  - Review: `it("refuses a Claude Code skill whose SKILL.md runs shell commands")`.
  - Review: `it("leaves a native skill's shell-looking text to the existing scans")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and the Skill Hub tests (PASS).**
- [ ] **Step 5: Commit:** `feat(skills): refuse Claude Code skills that run shell commands`.

### Task 4: Docs and checks (PR 5a)

- [ ] **Step 1: Docs:**
  - `docs/CANONICAL_RUNTIME_STATE_MODEL.md`:
    - the Skill Hub line at `:263` names `BUNDLED_SKILL_NAME_TAKEN` among the install guard codes, for plugin skills only
    - the Plugins "Reinstall" line at `:324` adds: "A plugin skill named like a bundled GoatCitadel skill is blocked with 'GoatCitadel already has a built-in skill with this name.'"
    - a short paragraph on the Claude Code dialect: the explicit lists, exact bytes kept, and that only a Claude Code-format plugin's skills get it (from PR 5b)
  - `docs/security/findings-triage.md` needs no change. Note in the PR body that `UNKNOWN_FRONTMATTER_DIMENSION` still fails closed outside the lists.
- [ ] **Step 2: Run the PR 5a checks:**
  - typecheck for contracts, gateway and mc-next
  - the Gateway tests from Tasks 1–3, and the Skill Hub tests
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:architecture:metrics`
  - the cockpit skills tests, the copy guard and `perf:check`
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Commit:** `docs: describe the Claude Code skill dialect and the bundled-name block`. Then open PR 5a. The body says that the dialect is unreachable until PR 5b, and that the bundled-name block is live for every plugin skill now.

---

# PR 5b: Translation and inspection

### Task 5: Contracts for format, coverage, left-out parts and warnings

**Files:**
- Modify: `packages/contracts/src/plugins.ts`
- Modify: `packages/contracts/src/capability-plugins.ts`. `ignored` at `:49-50` becomes the typed part below.
- Modify: `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/plugin-check-copy.ts:12-25`. The typed record needs the new codes, and `MANIFEST_MISSING` names both files.
- Test: `packages/contracts/src/plugins.test.ts`, `capability-plugins.test.ts` (create it if absent), and the cockpit `plugin-check-copy.test.ts`

**Interfaces:**
- Produces:

```ts
// plugins.ts
export const CLAUDE_CODE_PLUGIN_MANIFEST_PATH = ".claude-plugin/plugin.json";
export type PluginSourceFormat = "goatcitadel" | "claude_code";
// PLUGIN_MANIFEST_REFUSAL_CODES gains:
//   "CLAUDE_CODE_MANIFEST_INVALID"  plugin.json missing a name, unreadable, over 64 KiB, or a name GoatCitadel can't use
//   "NOTHING_TO_INSTALL"            no skill and no matched connector
//   "TOO_MANY_PIECES"               more than PLUGIN_LIMITS.maxPieces pieces GoatCitadel could take

// capability-plugins.ts
export type CapabilityPluginIgnoredKind =
  | "command" | "agent" | "hook" | "mcp_server" | "output_style" | "lsp_server"
  | "monitor" | "executable" | "settings" | "skill" | "manifest_field";
export interface CapabilityPluginIgnoredPart {
  /** Relative to the plugin, `/` separators; shown only in Technical details. */
  path: string;
  kind: CapabilityPluginIgnoredKind;
  /** A plain name: the file's name without `.md`, the server's or event's name, or the manifest key. */
  label: string;
  /** A plain line written by the Gateway: why it was left out. */
  reason: string;
}
export interface CapabilityPluginClaudeCodeImport {
  translatorVersion: number;
  /** Lowercase hex SHA-256 of `.claude-plugin/plugin.json`'s bytes. */
  pluginJsonSha256: string;
  /** Parts GoatCitadel can use (pieces), of all parts (pieces plus left-out parts that aren't manifest fields). */
  coverage: { usable: number; total: number };
}
// CapabilityPluginPieceView gains:   warnings?: string[]    // plain lines, Gateway-written
// CapabilityPluginInspection: ignored: CapabilityPluginIgnoredPart[];
//                             sourceFormat?: PluginSourceFormat;              // absent reads "goatcitadel"
//                             claudeCode?: CapabilityPluginClaudeCodeImport;  // only for "claude_code"
// CapabilityPluginListItem gains:  sourceFormat?: PluginSourceFormat
// CapabilityPluginDetail gains:    ignored?: CapabilityPluginIgnoredPart[]; claudeCode?: CapabilityPluginClaudeCodeImport
```

**Cockpit copy** (exact):
- `MANIFEST_MISSING`: "There's no goatcitadel-plugin.json or .claude-plugin/plugin.json at its top level."
- `CLAUDE_CODE_MANIFEST_INVALID`: "Its .claude-plugin/plugin.json isn't one GoatCitadel can read."
- `NOTHING_TO_INSTALL`: "GoatCitadel can't use any of its parts."
- `TOO_MANY_PIECES`: "It has more parts GoatCitadel could take than one plugin can hold."

- [ ] **Step 1: Write the failing tests:**
  - `it("parses an inspection saved before Phase 5")`, with no `sourceFormat` and `ignored: []`, through every type guard the store uses.
  - `it("lists the three new refusal codes once each")`.
  - Cockpit: `plugin-check-copy.test.ts` already asserts that every code has copy and that none uses a banned word; it fails until the copy is added.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** Rebuild contracts. **Step 4: Run them, the contracts, Gateway and mc-next typechecks and the copy guard (PASS).**
- [ ] **Step 5: Commit:** `feat(contracts): describe Claude Code plugin imports`.

### Task 6: Match a Claude Code MCP server to a shipped template

**Files:**
- Create: `apps/gateway/src/services/claude-code-mcp-match.ts`. Test: `claude-code-mcp-match.test.ts`.
- Create: `apps/gateway/src/services/claude-code-plugin.test-support.ts`, with `writeClaudeCodePluginFixture`, used here and in Tasks 7, 8 and 10

**Interfaces:**
- Consumes: `findInstallableConnectorTemplate` (`connector-install-change-plan-adapter.ts:271-290`) and `MCP_SERVER_TEMPLATES` (`mcp-server-templates.ts:259`), passed in as an argument.
- Produces:

```ts
export interface ClaudeCodeMcpServerEntry {
  name: string;              // the key in mcpServers
  definedIn: string;         // ".mcp.json" | ".claude-plugin/plugin.json" | the path plugin.json's mcpServers names
  config: unknown;           // the entry as written
}
export type ClaudeCodeMcpMatch =
  | { kind: "matched"; templateId: string; label: string; dropsOwnSignIn: boolean }
  | { kind: "left_out"; reason: string };
/** `https:` only; lower-case host; default port; path without a trailing slash; no user, query or fragment. Else undefined. */
export function normalizeMcpAddress(raw: string): string | undefined;
export function matchClaudeCodeMcpServer(
  entry: ClaudeCodeMcpServerEntry,
  templates: readonly McpServerTemplateRecord[],
): ClaudeCodeMcpMatch;
// test-support
export interface ClaudeCodePluginFixture {
  pluginJson?: Record<string, unknown> | string; // a string is written as is
  skills?: Record<string, string>;               // folder name → SKILL.md text
  files?: Record<string, string>;                // any other relative path → text
  mcpJson?: Record<string, unknown>;
}
export function writeClaudeCodePluginFixture(dir: string, fixture: ClaudeCodePluginFixture): Promise<void>;
```

**Rules, in order** (`reason` copy exact):
1. `config` isn't an object: "It isn't a server GoatCitadel can read."
2. `command` present, or `type` is `"stdio"`: "A local server, which would run a program. Plugins run no code."
3. `type` absent: "It doesn't say how it connects."
4. `type` is neither `"http"` nor `"sse"`: "It isn't a server GoatCitadel can read."
5. `url` holds `${`: "Its address uses a value GoatCitadel can't fill in, so it can't be matched to a connector."
6. `normalizeMcpAddress(url)` is undefined, or no shipped template has the same `transport` and the same normalized `url`: "This app isn't in GoatCitadel's connector list. Add it yourself in Connectors." (spike, exact)
7. The match fails `findInstallableConnectorTemplate`: that function's own `message`.
8. Otherwise `matched`. `dropsOwnSignIn` is true when the entry has `headers`, `headersHelper`, `oauth` or `env`.

A template's own `url` is normalized the same way before comparing. Nothing from `config` is copied anywhere.

- [ ] **Step 1: Write the failing tests:**
  - `it("matches an exact remote address to its template")`, with a vendor template's `url` and `transport`.
  - `it.each` over a trailing slash and an upper-case host, which match; and a query string, a different path, `http:`, a user in the URL and a non-default port, which don't.
  - `it("leaves out a stdio server, including one that runs the plugin's own code")`, with `bun run --cwd ${CLAUDE_PLUGIN_ROOT} start`.
  - `it("leaves out an address with a variable")`.
  - `it("leaves out a matched template that needs an API key, with its own line")`.
  - `it("says when the plugin's own sign-in settings are dropped")`.
  - `it("leaves out an entry without a type")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** Measure (0/0). **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): match Claude Code MCP servers to shipped connectors`.

### Task 7: The translator

**Files:**
- Create: `apps/gateway/src/services/claude-code-plugin-translator.ts`. Test: `claude-code-plugin-translator.test.ts`.

**Interfaces:**
- Consumes: Task 6's matcher; contracts' `parsePluginManifest`, `isPortablePluginPath`, `PLUGIN_ID_PATTERN`, `PLUGIN_PIECE_ID_PATTERN` and `PLUGIN_LIMITS`.
- Produces:

```ts
export const CLAUDE_CODE_TRANSLATOR_VERSION = 1;
export interface ClaudeCodeTranslation {
  /** The generated goatcitadel-plugin.json text. Same input, same bytes. */
  manifestText: string;
  pluginJsonSha256: string;
  ignored: CapabilityPluginIgnoredPart[]; // sorted by kind, then path
  coverage: { usable: number; total: number };
  /** Plain lines for a connector piece, by piece id. */
  pieceWarnings: Readonly<Record<string, string[]>>;
}
export type ClaudeCodeTranslationResult =
  | { ok: true; translation: ClaudeCodeTranslation }
  | {
      ok: false;
      code: "CLAUDE_CODE_MANIFEST_INVALID" | "NOTHING_TO_INSTALL" | "TOO_MANY_PIECES";
      message: string;
      ignored: CapabilityPluginIgnoredPart[];
    };
export function translateClaudeCodePlugin(input: {
  snapshotDir: string;   // PluginSnapshotStore's dir for the tree
  treeSha256: string;
  templates: readonly McpServerTemplateRecord[];
}): Promise<ClaudeCodeTranslationResult>;
```

**Reads.** Every read is `lstat` then a bounded read: plain files only, at most `PLUGIN_LIMITS.maxManifestBytes` for JSON. Every path is checked with `isPortablePluginPath` and resolved under `snapshotDir`. A path that is absolute, holds `..` or `\`, or isn't portable is left out as kind `manifest_field` (or as its own kind when the key says one), with "Points outside the plugin, so GoatCitadel leaves it out." Directory listings are sorted by name.

**The manifest**, from `.claude-plugin/plugin.json`:

| plugin.json | Generated | Rule |
|---|---|---|
| `name` | `pluginId` | Required. It must match `PLUGIN_ID_PATTERN` as written; otherwise `CLAUDE_CODE_MANIFEST_INVALID`, "Its plugin.json has no name GoatCitadel can use as an id." |
| `displayName`, else `name` | `name` | It must pass the schema's name rule; otherwise `CLAUDE_CODE_MANIFEST_INVALID`. |
| `description` | `description` | Passing the schema's rule: kept. Missing or failing: "No description was provided." (exact). A failing one adds a `manifest_field` part: "Its description is too long or holds characters GoatCitadel can't show." |
| `version` | `version` | Passing the schema's rule: kept. Otherwise `content-<treeSha256.slice(0, 12)>`. |
| `author.name`, or `author` as a string | `author` | Dropped when it fails the schema's rule. |
| `homepage` | `homepage` | Only an `https` address. |

- `schemaVersion` is 1.
- The text is `JSON.stringify(manifest, null, 2) + "\n"`, with keys in the table's order, then `pieces`.
- Unreadable JSON, a non-object, or a file over 64 KiB is `CLAUDE_CODE_MANIFEST_INVALID`, "Its plugin.json isn't valid JSON GoatCitadel can read."

**Pieces:**
- **Skills.** Each folder holding a `SKILL.md` directly is a skill piece, in path order. The folders searched are:
  - every child of `skills/`
  - each path in `plugin.json`'s `skills` (a string or an array): that folder when it holds `SKILL.md` itself, else its children. A leading `./` is stripped.

  The piece id is the folder's name when it matches `PLUGIN_PIECE_ID_PATTERN` and is free, else `skill-<n>`, 1-based in path order.

  A top-level `SKILL.md` is left out (kind `skill`): "A skill at the plugin's top level. Import it from the Skills tab instead."
- **Connectors.** Servers come from `.mcp.json`, read as `{ mcpServers: {...} }` or as the server map itself, and from `plugin.json`'s `mcpServers`, an object or a path to a JSON file. They are matched in server-name order.
  - A match is `{ kind: "connector", id: "connector-<n>", templateId, asksFirst: "changes" }`.
  - A second server matching a template already taken is left out with "Another of its servers is the same app."
  - `dropsOwnSignIn` adds the piece warning "GoatCitadel signs in its own way. The plugin's own sign-in settings aren't used."
  - Every `left_out` match becomes a `mcp_server` part with the matcher's reason.

**Left out, one part each** (`reason` copy exact):

| Source | Kind | Label | Reason |
|---|---|---|---|
| `commands/**/*.md`, `plugin.json` `commands` | command | file name without `.md` | "A command. GoatCitadel doesn't take commands from plugins." |
| `agents/*.md`, `plugin.json` `agents` | agent | file name without `.md` | "A subagent. GoatCitadel's agents aren't set by plugins." |
| `hooks/hooks.json`, `plugin.json` `hooks`, hook modules | hook | the file name, or "Hooks in plugin.json" | "Hooks that run code or change what happens. Plugin hooks in GoatCitadel can only watch." |
| `output-styles/*`, `plugin.json` `outputStyles` | output_style | file name | "An output style, which changes how every reply is written. Plugins can only add instructions as skills." |
| `.lsp.json`, `plugin.json` `lspServers` | lsp_server | server name | "A language server, which would run a program. Plugins run no code." |
| `monitors/*` | monitor | file name | "A background command, which would run a program. Plugins run no code." |
| `bin/*` | executable | file name | "A program for the command line. Plugins run no code." |
| `settings.json`, `themes/`, `workflows/` | settings | the name | "Claude Code settings. GoatCitadel doesn't take settings from plugins." |
| `plugin.json` `userConfig` | manifest_field | userConfig | "Values Claude Code asks for when the plugin is switched on. GoatCitadel never asks for them, and nothing that would read them comes across." |
| `plugin.json` `dependencies` | manifest_field | dependencies | "Other plugins it needs. GoatCitadel doesn't fetch them." |
| any other `plugin.json` key outside the manifest table and the keys above | manifest_field | the key | "GoatCitadel doesn't use this." |

**Totals:**
- `coverage.usable` is the number of pieces.
- `coverage.total` is the pieces plus every left-out part whose kind isn't `manifest_field`.
- No pieces: `NOTHING_TO_INSTALL`, "GoatCitadel can't use any of this plugin's parts.", with the full `ignored` list.
- More than `PLUGIN_LIMITS.maxPieces` (32): `TOO_MANY_PIECES`, "It has <n> parts GoatCitadel could take; one plugin can hold 32."
- The generated text must pass `parsePluginManifest`. A refusal there is a translator fault: answer `CLAUDE_CODE_MANIFEST_INVALID`, "GoatCitadel couldn't read this Claude Code plugin.", and log the parse refusal.

- [ ] **Step 1: Write the failing tests:**
  - `it("translates skills, a matched connector and leaves out commands, agents and hooks")`. Assert the exact generated JSON, the `ignored` parts with their kinds, labels and reasons, and `coverage`.
  - `it("gives the same bytes and hash for the same plugin")`.
  - `it("names a missing version after the plugin's files")`, which asserts `content-` and 12 hex.
  - `it("uses the placeholder for a missing or unusable description")`.
  - `it("refuses a plugin.json without a usable name")`, which asserts the code and that `ignored` is still filled.
  - `it("refuses a plugin with nothing to take, with its full left-out list")`.
  - `it("refuses a plugin with more than 32 pieces")`. The spike's `small-business` shape gives 48.
  - `it("leaves out paths that point outside the plugin and reads nothing outside it")` (Review Focus 3). Use a sibling folder with a SKILL.md next to the fixture, and assert that it isn't a piece.
  - `it("reads extra skills paths from plugin.json")`.
  - `it("leaves out a top-level SKILL.md")`.
  - `it("leaves out a second server for the same app")`.
  - `it("generates a manifest parsePluginManifest accepts for every fixture")`.
  - `it("never counts manifest fields as parts")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** Measure (0/0). **Step 4: Run them (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): translate a Claude Code plugin into a GoatCitadel manifest`.

### Task 8: Format detection, inspection and piece warnings

**Files:**
- Create: `apps/gateway/src/services/plugin-snapshot-manifest.ts`. Test: `plugin-snapshot-manifest.test.ts`.
- Create: `apps/gateway/src/services/claude-code-skill-warnings.ts`. Test: `claude-code-skill-warnings.test.ts`.
- Modify: `capability-plugin-inspection-service.ts`:
  - `:227` reads through `readSnapshotPluginManifest`. That needs a `connectorTemplates()` source, which it already has (`:140`).
  - the frame's `ignored` at `:236`, and both the refused and the accepted inspection, carry `sourceFormat`, `claudeCode` and `ignored`
  - `checkSkill` (`:318-366`) passes `dialect: "claude_code"` for a Claude Code plugin and adds the skill's warnings
  - `checkConnector` (`:403-425`) adds the translator's connector warnings
  - `skillRefusal` (`:545-560`) words the dialect's two codes
- Modify: `capability-plugin-actions-service.ts:192-209`. Installing an inspection whose `sourceFormat` is `"claude_code"` answers 409 `CLAUDE_CODE_INSTALL_NOT_READY`, "Claude Code plugins can be checked here, but not installed yet." Task 10 removes this.
- Test: `capability-plugin-inspection-service.test.ts`, `capability-plugin-actions-service.test.ts`, `capability-plugins.integration.test.ts`

**Interfaces:**
- Consumes: Task 7's `translateClaudeCodePlugin`; Task 2's dialect; `readPluginManifestFile` (`plugin-manifest-file.ts:16-18`).
- Produces:

```ts
// plugin-snapshot-manifest.ts
export type SnapshotManifestReading =
  | { format: "goatcitadel"; parsed: PluginManifestParse }
  | { format: "claude_code"; parsed: PluginManifestParse; translation?: ClaudeCodeTranslation;
      /** On a refused translation, what it had found. */ ignored: CapabilityPluginIgnoredPart[] };
/**
 * `goatcitadel-plugin.json` wins. Else `.claude-plugin/plugin.json` (a plain file) is translated. Else the native read,
 * which answers MANIFEST_MISSING. A refused translation is `parsed: { ok: false, code, message }`.
 */
export function readSnapshotPluginManifest(input: {
  snapshotDir: string; treeSha256: string; templates: readonly McpServerTemplateRecord[];
}): Promise<SnapshotManifestReading>;

// claude-code-skill-warnings.ts
export function claudeCodeSkillWarnings(input: {
  skillMarkdown: string;     // SKILL.md as read from the snapshot
  otherFileCount: number;    // files in the skill folder other than SKILL.md
  pluginId: string;
}): string[];
```

**Inspection rules:**
- A `built_in` source never translates. A built-in folder without `goatcitadel-plugin.json` stays `MANIFEST_MISSING`.
- A refused translation is saved and answered the way a refused manifest is today (`:240-254`), with `sourceFormat: "claude_code"` and its `ignored` list, so the panel can show what was found.
- `claudeCode` is `{ translatorVersion, pluginJsonSha256, coverage }`.
- A skill piece of a Claude Code plugin is reviewed with `pluginSkill.dialect = "claude_code"`.
- Blocked lines for the dialect's codes (exact):
  - `CLAUDE_CODE_SETTING_NOT_KEPT`: "This skill uses a Claude Code setting that limits it, and GoatCitadel can't keep that limit."
  - `SKILL_RUNS_SHELL_COMMANDS`: "This skill runs shell commands before it starts. GoatCitadel never runs them."

**Warnings** (exact copy). Each line is added at most once, in this order:
1. `user-invocable: false` in the frontmatter: "In Claude Code only the AI could start this skill. Here you can also start it by name once it's switched on."
2. `allowed-tools` present: "Its pre-approved tools aren't kept. Your own tool rules and approvals apply."
3. `model` or `effort` present: "Its model and effort settings aren't kept."
4. `when_to_use` present: "Its hints on when to use it aren't kept."
5. Placeholders, `/\$ARGUMENTS\b|\$[0-9]\b|\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT|SESSION_ID)\}/`: "It uses values Claude Code fills in, such as $ARGUMENTS. GoatCitadel passes them to the AI as written."
6. `otherFileCount > 0`: "<n> other file(s) in this skill are kept but never read", with `plural`: "1 other file in this skill is kept but never read." or "3 other files in this skill are kept but never read."
7. References to left-out parts: "Its instructions mention parts of the plugin GoatCitadel left out (<list>). It may not work fully without them." The list joins, in this order, the names whose pattern matches:
   - "commands": `` new RegExp(`(^|[\\s(\`])/${pluginId}:[a-z0-9-]+`) ``
   - "other connectors' tools": `/\bmcp__[A-Za-z0-9_]+__/`
   - "subagents": `/\bsubagent(?:_type|s)?\b/i`
   - "scripts": `/\$\{CLAUDE_PLUGIN_ROOT\}\//`

The frontmatter is read with `parseSkillMarkdown` from `@goatcitadel/skills`, which passes unknown keys through. A file it can't parse gives no warnings; the review refuses it anyway.

- [ ] **Step 1: Write the failing tests:**
  - Snapshot manifest: `it("reads a goatcitadel-plugin.json first when both manifests are there")` (Review Focus 4).
  - Snapshot manifest: `it("translates when only plugin.json is there")`.
  - Snapshot manifest: `it("answers MANIFEST_MISSING when neither is there")`.
  - Snapshot manifest: `it("never translates a built-in source")`.
  - Warnings: `it.each` over each of the seven lines, with its exact copy.
  - Warnings: `it("warns when a skill mentions a left-out command, connector tool, subagent or script")` (Review Focus 1).
  - Warnings: `it("gives no warnings for a plain skill")`.
  - Inspection: `it("inspects a Claude Code plugin with format, coverage, left-out parts and warnings")`.
  - Inspection: `it("blocks a Claude Code skill that runs shell commands, with its own line")`.
  - Inspection: `it("keeps a refused translation's left-out list")`.
  - Inspection: `it("reviews a native plugin's skills without the dialect")`.
  - Actions: `it("refuses to install a Claude Code plugin until the panel can show what it leaves out")`.
  - Integration, on a real Gateway with a fixture folder: inspect, then read back, then try to install and get 409. The snapshot directory is the only new path written.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure:
  - the two new files: 0/0
  - `capability-plugin-inspection-service.ts` and `capability-plugin-actions-service.ts`: no rise. If the inspection service would grow past about 700 lines, move the Claude Code branches into `plugin-snapshot-manifest.ts`.
- [ ] **Step 4: Run them, the plugin route tests, `src/get-routes-publish-sweep.test.ts`, the Gateway typecheck, `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary` (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): check Claude Code plugins and say what they leave out`.

### Task 9: Docs and checks (PR 5b)

- [ ] **Step 1: Docs.** In `docs/CANONICAL_RUNTIME_STATE_MODEL.md` "Plugins", add "Claude Code format (experimental)":
  - which file wins
  - what translates and what is left out
  - the translator version
  - that the check works and install answers `CLAUDE_CODE_INSTALL_NOT_READY` until the next change
- [ ] **Step 2: Run the PR 5b checks:**
  - typecheck for contracts, gateway and mc-next
  - the Gateway tests from Tasks 5–8, and the plugin tests
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:gateway:async-boundary`
  - the copy guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Commit:** `docs: describe checking Claude Code plugins`. Then open PR 5b. The body says that install is held back on purpose.

---

# PR 5c: Install and the panel

### Task 10: Install, uninstall, list and detail for Claude Code plugins

**Files:**
- Modify: `apps/gateway/src/services/capability-plugin-store.ts`:
  - `StoredPluginPiece` gains `warnings?: string[]`
  - `StoredPlugin` gains `sourceFormat?: "claude_code"` and `claudeCode?: StoredClaudeCodeImport`
- Modify: `capability-plugins-composition.ts`:
  - `shared.readManifest` (`:203`) reads through `readSnapshotPluginManifest`, fresh, and answers `SnapshotManifestParse`
  - add `shared.readInstalledManifest`, used by the route service (`:291`)
- Modify: `capability-plugin-uninstall-composition.ts:70` and the uninstall scope readers. They read `readInstalledManifest`.
- Modify: `plugin-install-change-plan-adapter.ts`. `bind` (`:347-366`) keeps the fresh reading, and `writeRecord` (`:388-410`) writes `sourceFormat`, `claudeCode` and each piece's `warnings` from the inspection.
- Modify: `capability-plugin-actions-service.ts`: remove Task 8's `CLAUDE_CODE_INSTALL_NOT_READY`.
- Modify: `capability-plugins-route-service.ts`:
  - list items carry `sourceFormat`
  - the detail carries `ignored`, `claudeCode` and piece `warnings` from the record
  - `readInstalledManifest` (`:337-347`) uses the record's text
- Test: `capability-plugin-store.test.ts`, `plugin-install-change-plan-adapter.test.ts`, `capability-plugin-detail.test.ts`, `capability-plugins-install.integration.test.ts` and `capability-plugins-uninstall.integration.test.ts`

**Interfaces:**
- Consumes: Task 8's `readSnapshotPluginManifest`.
- Produces:

```ts
// capability-plugin-store.ts
export interface StoredClaudeCodeImport {
  translatorVersion: number;
  pluginJsonSha256: string;
  /** The generated goatcitadel-plugin.json text installed; its SHA-256 is the record's manifestSha256. */
  manifestText: string;
  ignored: CapabilityPluginIgnoredPart[];
  coverage: { usable: number; total: number };
}
// composition
export type SnapshotManifestParse = PluginManifestParse & {
  claudeCode?: Omit<StoredClaudeCodeImport, "ignored" | "coverage">;
};
readManifest(treeSha256: string): Promise<SnapshotManifestParse>;   // fresh: native parse or a new translation
readInstalledManifest(treeSha256: string): Promise<PluginManifestParse>; // the installed record's text first
```

**Rules:**
- **Install checks the translation fresh, at both existing checks:**
  - `capability-plugin-actions-service.ts:207-208` when the plan is requested
  - `plugin-install-change-plan-adapter.ts:359-365` when it binds and applies

  Both translate the verified snapshot again. A different `manifestSha256` is the existing `pluginChanged()`, worded "This plugin changed since it was checked. Check it again." Nothing trusts a manifest kept from the inspection.
- **`readInstalledManifest(tree)`:**
  - When an installed record with that tree has `claudeCode.manifestText`, it answers `parsePluginManifest(manifestText)`, whose hash must equal the record's `manifestSha256`; otherwise it is the existing "not the installed one" path.
  - Otherwise it answers `readManifest(tree)`.

  This keeps the detail (`capability-plugins-route-service.ts:337-347`), uninstall's labels (`plugin-uninstall-change-plan-adapter.ts:295`) and the uninstall scope's view of other plugins' kept connectors (`plugin-uninstall-scope.ts:174-177`, where a mismatch reads as `unknown`) stable when a release changes the translator or the connector catalog.
- The record's text is at most 64 KiB. The row keeps it only for installed Claude Code plugins, never for inspections.
- Uninstall is unchanged otherwise. Skills are revoked, matched connectors are removed when owned, and hosts stay allowed.

- [ ] **Step 1: Write the failing tests:**
  - `it("installs a Claude Code plugin's skills and matched connector")`. The connector is saved switched off, with "Reads free, changes ask". Each skill goes through its own two steps.
  - `it("refuses to apply when the translation changed since the check")` (Review Focus 2). Change the templates between inspection and apply so that a connector stops matching.
  - `it("reads an installed plugin's manifest from its record after the translation changes")` (Review Focus 2). The detail still lists every piece by name.
  - `it("decides another plugin's kept connector from the record during an uninstall")`.
  - `it("keeps the left-out list, coverage and warnings on the installed plugin")`.
  - `it("lists a Claude Code plugin with its format")`.
  - `it("reads a record saved before Phase 5")`.
  - `it("uninstalls a Claude Code plugin and leaves its hosts allowed")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Measure every touched file (no rise) and `pnpm verify:architecture:metrics`. If `capability-plugins-composition.ts` rises, move the two readers into `plugin-snapshot-manifest.ts` as plain functions taking the store and snapshot store as arguments.
- [ ] **Step 4: Run them, the Phase 4 plugin tests in full, `pnpm verify:journey:producers`, `pnpm verify:skill-hub:lifecycle` and `pnpm verify:durable:recovery` (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): install and uninstall Claude Code plugins from their checked translation`.

### Task 11: The panel: format, Experimental, coverage, left-out list and warnings

**Files:**
- Create in `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/`:
  - `plugin-format-view.ts`, holding the labels, the coverage line and the kind group labels. Test: `plugin-format-view.test.ts`.
  - `PluginLeftOut.tsx`, the "What it leaves out" section. Test: `PluginLeftOut.test.tsx`.
- Modify:
  - `PluginInstallAbout.tsx:26-45` (`WhereItComesFrom`): the format line, the Experimental label and the coverage line
  - `PluginPieceList.tsx:31-56`: each piece's `warnings`, as muted lines under its check line
  - `PluginInstallPanel.tsx` (`PluginInstallBody`): `PluginLeftOut` after "What it adds", for both an inspection and a refused one
  - `PluginPanel.tsx`: the same sections for an installed plugin
  - `PluginRow.tsx`: the "Claude Code format" label beside the trust label
  - `PluginSourceForm.tsx`: the Git hint
- Test: `PluginInstallPanel.test.tsx`, `PluginPanel.test.tsx`, `PluginsTab.test.tsx`, `PluginSourceForm.test.tsx`

**Copy** (exact):
- The trust line for a Claude Code plugin is "Claude Code format · Unverified", followed by the existing unverified warning.
- The label is "Experimental", a neutral `StatusBadge`, never a warning color.
- "GoatCitadel reads this Claude Code plugin in its own way. It takes the skills and the apps it already knows, and leaves out the rest."
- Coverage: "GoatCitadel can use <usable> of this plugin's <total> parts." With `plural`, "1 of this plugin's 1 part" reads "GoatCitadel can use 1 of this plugin's 1 part."
- The section title is "What it leaves out". Groups come in this order, each a heading with a count, then one row per part (its `label`, then its `reason`):
  - Commands, Subagents, Hooks, Apps and servers, Skills, Output styles, Language servers, Background commands, Programs, Settings
  - last, "Other plugin details", for `manifest_field`

  Paths go in `TechnicalDetails`.
- Git source form hint: "A GoatCitadel plugin, or a Claude Code plugin whose repository is the plugin itself."
- `TechnicalDetails` adds the translator version and the `plugin.json` hash.

**Rules:**
- The coverage line and "What it leaves out" come before "What happens next". The panel leads with them (spike risk 1).
- Nothing here counts, groups by reason, or decides. Groups follow `kind` as the Gateway wrote it.
- A refused Claude Code check (`NOTHING_TO_INSTALL`, say) still shows "What it leaves out", above the refusal lines.
- No new live region. If one is needed, add its ladder line and budget in this commit.

- [ ] **Step 1: Write the failing tests:**
  - `it("labels a Claude Code plugin's source and marks it experimental")`.
  - `it("leads with what GoatCitadel can use and what it leaves out")`, which asserts the order of the sections.
  - `it("groups left-out parts by kind with their reasons")`.
  - `it("shows the left-out list on a refused Claude Code check")`.
  - `it("shows each skill's warnings under it")`.
  - `it("keeps paths and hashes inside Technical details")`.
  - `it("shows nothing new for a GoatCitadel plugin")`.
  - `it("labels a Claude Code plugin in the list")`.
  - `plugin-format-view.test.ts`: the coverage line at 1 of 1, 1 of 3 and 3 of 11.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.**
- [ ] **Step 4: Run the `areas/capabilities/` tests, the mc-next typecheck, `perf:check`, the copy guard and the raw-values guard (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): show what a Claude Code plugin brings and leaves out`.

### Task 12: Public truth and proof (PR 5c)

**Files:**
- Docs:
  - `docs/1_0_CONTRACT.md:154`: an experimental Claude Code import, stated exactly. Skills through the dialect, remote connectors that exactly match a shipped template, and nothing else. Trust is always Unverified, and Git sources must be the plugin itself.
  - `README.md:62` and `:541`: the same, in one sentence each. No claim that Claude Code plugins "work".
  - `AGENTS.md:237`: one sentence on the experimental import and its scope.
  - `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md:237,274`: Phase 5 shipped at the narrow scope, experimental.
  - `docs/CANONICAL_RUNTIME_STATE_MODEL.md` "Plugins": install, the record's kept translation and the experimental status.
  - `docs/QA_MANUAL_TEST_PLAN.md`: a PLUGIN-02 case for a Claude Code folder plugin.
  - `CHANGELOG.md`.
- Proof: extend `scripts/verification/lib/scenarios/cockpit-library-link-proof.mjs` (Phase 4 extended it for plugins). Inspect a fixture Claude Code folder, then assert the coverage line and "What it leaves out".

- [ ] **Step 1: Update the docs and the proof scenario. Run `pnpm docs:check` and the scenario's test (PASS).**
- [ ] **Step 2: Run the PR 5c checks:**
  - typecheck for contracts, gateway and mc-next
  - the Gateway tests from Task 10, and the Phase 4 plugin tests
  - the cockpit `areas/capabilities/` tests
  - `pnpm verify:journey:producers`
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:durable:recovery`
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:gateway:async-boundary`
  - `perf:check`, the copy guard and the raw-values guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Get browser proof** on the testbench sandbox. Show:
  - **Add from folder, with a fixture plugin** written by `writeClaudeCodePluginFixture`. It holds:
    - two skills: one with `allowed-tools` and `$ARGUMENTS`, one with a `references/` file
    - `.mcp.json` with one address matching a shipped no-sign-in or OAuth template, one stdio server and one unmatched address
    - a command, an agent and `hooks/hooks.json`

    The panel shows "Claude Code format · Unverified", Experimental, the coverage line, every left-out group and each skill's warnings. Install it with the skip setting on, then uninstall it. The connector's hosts stay allowed.
  - **Install from Git: superpowers pinned to a commit** (`github.com/obra/superpowers`). First confirm that its root is the plugin and that it fits 256 files and 8 MiB; the 7.0.0 copy holds 245 files and about 2 MB. The panel shows its `hooks/` left out, and `receiving-code-review` blocked with "GoatCitadel already has a built-in skill with this name." The plugin reads as not installable. Record this as the proof of decision 5, not as a failure.
  - **Refusals:** a Claude Code plugin with only commands and agents is refused as `NOTHING_TO_INSTALL`, with its full left-out list. A skill with a shell line is blocked in plain words.
  - Each at desktop and phone widths, in light and dark themes.
- [ ] **Step 4: Note in the PR body:**
  - The panel changed, so a manual `visual-rebaseline.yml` run is needed **after merge, as its own PR against `main`**.
  - The live proof's commit hashes.
  - Every limit under "Deliberate limits".
- [ ] **Step 5: Commit:** `docs: Claude Code plugin import is experimental and narrow`. Then open PR 5c.

---

## Architecture metrics, PR by PR

| PR | GatewayService lines | Route-facing services | New files (0/0 each) | Must not rise | Allowance |
|---|---|---|---|---|---|
| 5a | 13069, unchanged | 70 | `plugin-skill-name-rules.ts`, `skill-hub-claude-code-dialect.ts` | `skill-hub-operator-service.ts`, `skill-hub-review-service.ts`, `skill-hub-plugin-skill-source.ts`, `capability-plugin-inspection-service.ts` | None |
| 5b | unchanged | 70 | `claude-code-mcp-match.ts`, `claude-code-plugin-translator.ts`, `plugin-snapshot-manifest.ts`, `claude-code-skill-warnings.ts` | `capability-plugin-inspection-service.ts`, `capability-plugin-actions-service.ts` | None |
| 5c | unchanged | 70 | none | `capability-plugin-store.ts`, `capability-plugins-composition.ts`, `capability-plugin-uninstall-composition.ts`, `plugin-install-change-plan-adapter.ts`, `capability-plugins-route-service.ts`, `capability-plugin-actions-service.ts` | None |

Measure each file with `countHostMemberAccesses` and `countDependencyMemberAccesses` while building, and run `pnpm verify:architecture:metrics` once per PR. A rise means extracting into a new 0/0 file; a C0 allowance or baseline change is never requested from inside this plan.

## Spec coverage

| Spike item | Task |
|---|---|
| 1. Contracts: source format, translator version, `plugin.json` hash, coverage, filled `ignored` | 5 |
| 2. A pure, versioned translator with bounded reads that never executes and never leaves the snapshot | 7 |
| 3. Format detection; `goatcitadel-plugin.json` wins; nothing to take is refused with its full list | 8 |
| 4. Connector matching on transport plus exact address, then `findInstallableConnectorTemplate`; stdio and unmatched left out | 6, 7 |
| 5. Install, uninstall, list and detail read the translated manifest; apply translates again and refuses on a hash change | 10 |
| 6. The dialect's ignore, warn and refuse lists, with named codes; ignored keys in the audit findings | 2 |
| 7. Refuse shell lines | 3 |
| 8. Warnings for placeholders, unread files and references to left-out parts | 8 |
| 9. "Claude Code format · Unverified", coverage, the left-out list by kind, per-skill warnings | 11 |
| 10. Docs: Plugins section, 1_0_CONTRACT, README, AGENTS.md, hub design | 4, 9, 12 |
| 11. Synthetic fixtures for each kind and refusal; live proof with a pinned public plugin | 6–8, 10, 12 |
| Manifest table (name, displayName, description placeholder, version, author, homepage, left-out fields) | 7 |
| Remote MCP: GoatCitadel's template, not the plugin's headers, OAuth or env; "GoatCitadel signs in its own way" | 6, 7 |
| Connectors install switched off | 10 (Phase 4's install, unchanged) |
| Trust always Unverified | 8 (sources already answer `unverified` for Git and folder) |
| Risk 1: lead with coverage | 11 |
| Risk 6: the translation must not drift | 10 |
| Risk 7: the dialect stays limited to Claude Code plugin skills and listed keys | 2 |
| Risk 8: public claims | 12 |
| Operator decisions 4 and 5: same-name and bundled-name blocks | 1 (decision 4 is the existing guard, unchanged) |

**Deliberate limits, and why:**
- **Experimental and narrow.** Skills and exactly matched remote connectors only. Commands, agents, hooks, output styles, LSP servers, monitors, `bin/`, settings and stdio servers never come across, because each runs code or steers chats outside a skill.
- **A Git source must be the plugin.** `git-subdir` and relative marketplace entries are deferred (decision 3), and so is marketplace resolution. A plugin in a marketplace subfolder can come in only as a folder the operator copied.
- **`plugin.json` with a `name` is required,** and a top-level `SKILL.md` is left out (see "Decided without asking").
- **Skills behave differently here.** Placeholders reach the model as written, only `SKILL.md` is read, and `user-invocable: false` doesn't hide a skill from the operator. Each case is a warning on the piece, not a silent change.
- **Updates are still uninstall then install,** and a plugin whose skill was installed can't be installed again until skills can be removed (spike risk 3).
- **The bundled-name block covers plugin skills only.** A Skills tab import from Git named like a bundled skill keeps today's rules. What routing or `use <name>` does with two skills of one name is still unverified. A plugin skill installed before a release adds a bundled skill of the same name keeps working.
- **Pass rates will be lower than the spike's numbers,** which didn't run the promptware, script or network scans (spike risk 4).
- **The SDK preflight doesn't read Claude Code plugins.**

**Found on the way (follow-ups, not in this plan):**
- Whether the bundled-name block should also cover Skills tab imports from Git, as one rule for every installed skill.
- Commands as explicit-only skills, `git-subdir` sources, marketplace resolution, and vendor templates for often-unmatched hosts (Slack, Atlassian `/v1/mcp`, HubSpot) through the normal template review. These are the spike's "Later, and only on request" list.
- The spike cites `capability-plugin-inspection-service.ts:232` for `ignored: []` and `skill-hub-operator-service.ts:684` for the name guard. On `30b58863a` they are `:236` and `:687`.

## Self-review

- **Spike coverage:** every rough-list item and every risk the spike says the plan must handle maps to a task (table above). Risk 9 (sample bias) is a statement, not a task, and is in the PR 5c body's limits.
- **Steps:** each code step names its file, signature and exact copy; each test step names its test and assertion; each check step names its command.
- **Types:** these names match across Tasks 5–11:
  - `SnapshotManifestReading` and `SnapshotManifestParse`
  - `ClaudeCodeTranslation` and `StoredClaudeCodeImport`
  - `CapabilityPluginIgnoredPart` and `CapabilityPluginClaudeCodeImport`
  - `claudeCodeSkillWarnings`, `readSnapshotPluginManifest`, `translateClaudeCodePlugin` and `matchClaudeCodeMcpServer`
  - `BUNDLED_SKILL_NAME_TAKEN`, `CLAUDE_CODE_SETTING_NOT_KEPT` and `SKILL_RUNS_SHELL_COMMANDS`
- **Review Focus:** each of the five has its named test in its owning task.
- **Proportion:** code blocks are signatures and rules. No function bodies except the regexes the tests pin.
