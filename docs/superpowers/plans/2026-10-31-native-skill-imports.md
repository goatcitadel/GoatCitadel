# Native Skill Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship nine new bundled skills adapted from four public skill repos, upgrade `qa` and `agentic-skill-architect` with upstream ideas, and re-sync the vendored impeccable design skill to upstream HEAD.

**Architecture:** Every new skill is a self-contained `skills/bundled/<name>/` folder (`SKILL.md`, `LICENSE`, `UPSTREAM.md`), distilled from upstream prose and rewritten for GoatCitadel tools. Each is registered in the catalog coverage, category map, routing hints and the bundled-skill lock. Two opinionated skills ship *explicit-only*: they have no trigger keywords, so they load only when the operator names them. Impeccable is refreshed only through `scripts/sync-impeccable.mjs`.

**Tech Stack:** Markdown skills, TypeScript (`@goatcitadel/skills`, `@goatcitadel/contracts`), Vitest, Node test runner, pnpm.

**Spec:** The 2026-10-31 review in this session, recorded as the Decisions section below. No separate spec document exists.

## Decisions

1. **Take:** debugging (superpowers `systematic-debugging` + mattpocock `diagnosing-bugs`), tdd (mattpocock), grilling (mattpocock `grilling` + `domain-modeling`), codebase-design (mattpocock), receiving-code-review (superpowers), secure-coding (addyosmani `security-and-hardening`), source-driven-development (addyosmani), ponytail (ponytail core + review), spec-driven-development (addyosmani).
2. **Merge into existing skills:** superpowers `verification-before-completion` into `qa`, and mattpocock `writing-for-agents` + addyosmani `context-engineering` into `agentic-skill-architect`.
3. **Skip:** wheresryan22/anatomy, Leonxlnx/taste-skill, Nutlope/hallmark, superpowers `using-superpowers`, every subagent-, hook-, script-, MCP- or tracker-coupled upstream skill, and upstream `misc/`, `in-progress/`, tests, evals and plugin manifests.
4. **One skill per job:** no second TDD or debugging skill. Where two upstreams overlap, merge them into one folder.
5. **Off by default without a new mechanism:** the earlier review suggested shipping ponytail and spec-driven-development as import packs. That is replaced here: `ShippedSkillPack` requires a CLI (`requiresCli`) and the pack test requires `tool:shell.exec`, so prose-only packs would mean changing the contract, the Skill Hub test and the Capabilities UI. Instead, both ship bundled with no keywords and empty routing phrases. `resolveSkillActivation` (`packages/skills/src/activation.ts`) then selects them only for `@skill <name>`, `use <name>` or `$bundled:<name>`.
6. **Impeccable:** re-sync to `4f956490f0056ae1ff5ea80372cf56e83c001d3c` and accept the upstream prose changes, including the mode-aware ambition wording. `packages/skills/src/design-detector/rules.ts` is out of scope.
7. **Two PRs:** PR A (Task 1, impeccable) and PR B (Tasks 2–13, skills). They touch disjoint files except `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md` and the generated lock, so whichever merges second regenerates the lock and resolves those two docs.

## Global Constraints

- **Worktrees:** work in fresh worktrees from `origin/main` (`19d4bb445` when this plan was written). Branches are `feat/impeccable-resync-4f95649` (PR A) and `feat/native-skill-imports` (PR B). The main checkout may hold another session's uncommitted work: never edit, stash or reset it.
- **Setup:** in each worktree, run `pnpm install --offline --frozen-lockfile`, then `pnpm --filter "@goatcitadel/gateway^..." build`. Package tests read `@goatcitadel/contracts` from `dist`, so run `pnpm --filter @goatcitadel/contracts build` again after editing `skill-categories.ts`. Never junction `node_modules` between worktrees.
- **Upstream code:** clone each upstream into its own empty scratchpad directory (`<scratch>/<repo>`), check out the pinned commit, and read it statically. Never run, install or `node` anything from it.
- **Pinned upstream commits:**

  | Upstream | Commit | Licence |
  |---|---|---|
  | https://github.com/mattpocock/skills | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT |
  | https://github.com/obra/superpowers | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` | MIT |
  | https://github.com/addyosmani/agent-skills | `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e` | MIT |
  | https://github.com/DietrichGebert/ponytail | `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846` | MIT |
  | https://github.com/pbakaus/impeccable | `4f956490f0056ae1ff5ea80372cf56e83c001d3c` | Apache-2.0 |

- **Only `SKILL.md` reaches the model:** for every skill except impeccable and design-intelligence, `resolveSkillModules` (`packages/skills/src/skill-module-routes.ts`) injects `SKILL.md` alone. Each new skill must therefore be fully self-contained. Its folder holds exactly `SKILL.md`, `LICENSE` and `UPSTREAM.md`, with no `reference/` files.
- **Size caps:** each task states its own `SKILL.md` byte cap. The catalog estimate (`node scripts/check-skill-catalog.mjs`, raw bytes / 4 summed over every `SKILL.md` under `skills/`) is 21,428 today, and its hard limit is 40,000. If it passes 36,000, trim before adding the next skill.
- **Frontmatter:** use YAML block form like `skills/bundled/coding/SKILL.md`. `description` starts with "Use when", is at most 300 characters, lists triggers only, and never summarizes the workflow.
- **Trigger keywords:** keywords and routing phrases are matched as lower-case **substrings** of the whole message (`activation.ts`). Use multi-word phrases. A single common word is allowed only if it can't appear inside another word (`tdd`, `owasp`, `xss`). Never use `harden` (it collides with `@skill impeccable harden`), `test`, `review`, `fix`, `bug` or `design`.
- **Wording:** no "MUST / 1% chance / Iron Law / non-negotiable / not optional" pressure framing. Write each workflow as a positive recipe: name the reply's parts, in order. Refer to the person as "the operator".
- **Promptware scanner** (`apps/gateway/src/services/assembled-prompt-injection-guard.ts`): no file may contain, even as a quoted example:
  - "ignore/disregard/override previous|prior|above instructions" or "system prompt";
  - "reveal/show/print the system prompt";
  - "bypass/skip/disable/override the approval|policy|path jail|tool grants";
  - run/execute/invoke/call/use followed within 96 characters by "without approval|permission|confirmation";
  - "you are now in developer/admin/unrestricted mode".

  This applies to `UPSTREAM.md` too.
- **Tools:**
  - Name only GoatCitadel tool ids: `fs.read`, `fs.write`, `shell.exec`, `git.exec`, `memory.read`, `browser.search`, `browser.navigate`, `browser.extract`, `http.get`, `citations.build`.
  - Never mention slash commands, the Skill/Task/TodoWrite tools, subagents, hooks, `.claude/` paths, or harness-specific installs.
  - Skills never instruct a push, force-push, worktree add/remove or merge.
- **Licences:**
  - `LICENSE` is each source's upstream LICENSE copied verbatim. A skill built from two sources concatenates both, each preceded by a line `Source: <repo url>`.
  - `THIRD_PARTY_NOTICES.md` gets one section per upstream repo, in the format of the existing "OpenClaw skills" section, quoting the upstream copyright line.
- **Repo hygiene:**
  - No personal paths (user-profile directories, local code roots) in any tracked file. `node scripts/verify-repo-hygiene.mjs` (part of `pnpm verify:repo:hygiene`) rejects them; run it once before opening each PR.
  - Never run `prettier --write` on a directory, only on files this plan creates.
  - Never run `architecture:baseline:update`.
- **Heavy work:** run Vitest with `--maxWorkers=2`, and only one heavy job at a time.
- **Commits:** conventional types (`feat(skills): …`, `docs: …`). End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Substring false positives:** a message containing a trigger word as part of another word or phrase ("what's the latest", "harden the empty states", "grilled chicken recipe") loads none of the new skills. Pinned by the negative rows in Task 2's routing test.
2. **Pile-up on coding prompts:** "the checkout test is flaky on CI, find the root cause" loads `debugging` and no other new skill. Every overlapping skill injects a full `SKILL.md`, so stacked matches bloat the turn. Pinned in Task 2.
3. **Explicit-only skills leaking into auto-selection:** "keep this change small and minimal" and "write a spec for this feature" select neither `ponytail` nor `spec-driven-development`, while `use ponytail …` and `@skill spec-driven-development …` do. Pinned in Tasks 9 and 10.
4. **A shipped skill tripping the promptware scanner:** this fails every Chat turn that loads the skill (`skill_security_blocked`). `bundled-skill-promptware-inventory.test.ts` scans every bundled `.md`. It runs in every task's verify step.
5. **Impeccable route byte ceilings after re-sync:** a grown `craft-floor.md` or `typeset.md` pushes main + craft-floor + command over `IMPECCABLE_BUDGET_BYTES` (40 KiB), and the Gateway refuses the module. Pinned by the `enumerateSkillRoutes` ceiling test in `packages/skills/src/bundled-skill.test.ts`, which runs in Task 1.

---

## Shared definitions

### SKILL.md skeleton (Tasks 2–10)

```markdown
---
name: <name>
description: "<Use when …>"
metadata:
  version: "0.1.0"
  tags:
    - <tag>
  tools:
    - <tool id>
  keywords:            # omitted entirely for explicit-only skills
    - <multi-word phrase>
---

# <Title>

> Adapted from <owner/repo> at commit `<short sha>` (MIT License). Changes are listed in `UPSTREAM.md`.

<Core principle in one or two sentences.>

## When to use
## When not to use
## Workflow
## What the operator decides
## Output
## Boundaries
## Related skills
```

`## Output` names the reply's parts, in order. `## Related skills` names bundled skills by name only.

### UPSTREAM.md template

```markdown
# Upstream

- Source: <owner/repo>, `<path>` [, `<path>` …] (<repo url>)
- Upstream commit: `<full sha>`
- Licence: MIT, <copyright line from upstream LICENSE>. See `LICENSE`.

## GoatCitadel changes

- <one line per change: what was cut, rewritten, or merged>
```

### Registration (each new skill)

- `skills/catalog-coverage.json`: append `{ "skillId": "bundled:<name>", "owner": <task>, "source": "bundled", "riskTier": "low", "expectedTests": ["packages/skills/src/bundled-skill-routing.test.ts"], "catalogExposure": "suggestable" }`.
- `packages/contracts/src/skill-categories.ts`:
  - Add `"bundled:<name>": <category>` to `SHIPPED_SKILL_CATEGORIES`.
  - Bump the count in `skill-categories.test.ts` ("maps every skill…", `toHaveLength(18)`) by one per skill.
- `packages/skills/src/routing-hints.generated.ts`:
  - Add the entry, keyed by name, in alphabetical position. The file has no generator despite its name.
  - Explicit-only skills get `phrases: []` and `keywords: []` (this keeps `check-skill-catalog`'s `stale_generated_routing` warning quiet).
- Run `pnpm update:skills:lock`.

### Behavior check (writing-skills RED/GREEN)

- **Runs:** each run is one fresh `general-purpose` agent on `sonnet`, with no tools. Prompt:

  > You are the assistant inside GoatCitadel Chat, helping an operator with their project. [Arm with a skill: "These skill instructions are active for this turn:" followed by the full SKILL.md text.] Context: <the task's context>. The operator writes: "<the task's message>". Reply exactly as you would to the operator. Describe any command you would run instead of running it.

- **Arms:** run 3 reps per arm.
  - `control` uses no skill. For an existing skill, `control` is the current committed `SKILL.md`.
  - `upstream` uses the upstream SKILL.md verbatim. Run it only where the task lists it.
  - `distilled` uses the new file.
- **Scoring:** read every reply and score it against the task's pass signal. Record `k/3` per arm plus one line naming the dominant failure.
- **RED:** run `control` (and `upstream`) **before** writing `SKILL.md`. If `control` passes 3/3, record "no baseline failure". Keep the skill, but add no wording aimed at that scenario.
- **GREEN:** `distilled` passes at ≥ 2/3, and is at least the `upstream` score where one exists. On a miss:
  - Classify the failure with writing-skills' "Match the Form to the Failure" table (skipped rule → prohibition and red flags; wrong-shaped output → recipe; missing element → required slot).
  - Revise, then rerun `distilled` only.
- **Record:** add the results to the "Skill behavior checks" table in the PR B body.

### Verify block (every task in PR B)

```powershell
pnpm --filter @goatcitadel/skills exec vitest run src/bundled-skill-routing.test.ts src/bundled-skill.test.ts src/bundled-skill-lock.test.ts --maxWorkers=2
pnpm --filter @goatcitadel/contracts exec vitest run src/skill-categories.test.ts --maxWorkers=2
pnpm --filter @goatcitadel/gateway exec vitest run src/services/bundled-skill-promptware-inventory.test.ts src/services/bundled-skill-promptware.test.ts src/services/bundled-skill-lock.test.ts --maxWorkers=2
pnpm verify:skills:catalog
```

Expected:
- All tests pass.
- `verify:skills:catalog` exits 0 and prints `Skill catalog: N skills, estimated E/40000 tokens`. Record E in the commit body.
- There are no new `stale_generated_routing` warnings. The `opencode` and `sendclaw` warnings already exist.

### Skill task procedure (Tasks 2–10)

- [ ] **1. Routing RED:** add the task's rows to `CASES` in `packages/skills/src/bundled-skill-routing.test.ts`. Run that file. Expected: the new positive rows FAIL (the skill is not selected).
- [ ] **2. Behavior RED:** run the task's `control` arm (and `upstream` arm if listed) and record the scores.
- [ ] **3. Write files:** clone the task's source(s) at the pinned commit. Write `SKILL.md` from the skeleton using the task's keep and cut lists, then `LICENSE` and `UPSTREAM.md`. Check `SKILL.md` against its byte cap with `(Get-Item <path>).Length`.
- [ ] **4. Register:** follow "Registration". Add the upstream's `THIRD_PARTY_NOTICES.md` section if this is the first task that uses that upstream.
- [ ] **5. Verify:** run the Verify block. Expected: PASS.
- [ ] **6. Behavior GREEN:** run the `distilled` arm and meet the gate.
- [ ] **7. Commit:** commit the skill folder, registration files and test. Message: `feat(skills): add bundled <name> skill adapted from <upstream(s)>`.

---

## PR A

### Task 1: Re-sync impeccable to `4f95649`

**Files:**
- Modify (generated by the sync): `skills/bundled/impeccable/**`
- Modify: `packages/skills/src/bundled-skill-lock.generated.ts` (`pnpm update:skills:lock`), `THIRD_PARTY_NOTICES.md` (impeccable commit line), `CHANGELOG.md`
- Modify only if Step 2 or Step 4 requires it: `scripts/sync-impeccable.mjs`, `scripts/sync-impeccable.test.mjs`, `packages/skills/src/skill-module-routes.ts` (`IMPECCABLE_COMMANDS`, `IMPECCABLE_CRAFT_COMMANDS`, budgets), `packages/skills/src/routing-hints.generated.ts` (impeccable `commands`)

**Interfaces:**
- Consumes: `node scripts/sync-impeccable.mjs --source <dir> --sha <commit>` (existing).
- Produces: `skills/bundled/impeccable/UPSTREAM.md` pinned at `4f956490f0056ae1ff5ea80372cf56e83c001d3c`.

- [ ] **Step 1: Clone the upstream.** Run `git clone --filter=blob:none https://github.com/pbakaus/impeccable <scratch>/impeccable`, then `git -C <scratch>/impeccable checkout 4f956490f0056ae1ff5ea80372cf56e83c001d3c`. Expected: `git -C <scratch>/impeccable rev-parse HEAD` prints that sha.
- [ ] **Step 2: Run the sync.** `node scripts/sync-impeccable.mjs --source <scratch>/impeccable --sha 4f956490f0056ae1ff5ea80372cf56e83c001d3c`. Expected: exit 0 and a summary listing SKILL.md, LICENSE, NOTICE, UPSTREAM.md and the vendored references.
  - If the guard refuses because a forbidden string survived, first add a fixture case to `scripts/sync-impeccable.test.mjs` that contains that upstream line and asserts it is removed or rewritten. Run `node --test scripts/sync-impeccable.test.mjs` and expect FAIL.
  - Then add the transform to `sync-impeccable.mjs` and list it under "Transforms applied" in the generated `UPSTREAM.md` text. Rerun the test (PASS) and the sync (exit 0).
- [ ] **Step 3: Review the vendored diff.** Run `git diff --stat skills/bundled/impeccable`. Expected changes:
  - `reference/typeset.md` gains a "Line breaks" section.
  - `reference/harden.md` gains an Arabic-script block.
  - `reference/audit.md` gains the 3:1 large-text contrast threshold and WCAG 2.5.8 (24px) touch targets.
  - `reference/craft-floor.md` says a line marked as a ban can't be overridden by a brief.
  - `SKILL.md` replaces "go all out" with mode-scaled ambition.
  - The "Desktop apps (Electron/WebView2 via CDP)" text in `audit.md` / `critique.md` must not survive (it depends on CDP). If it does, handle it as in Step 2.
- [ ] **Step 4: Check the command set.**
  - Compare the Commands table in the new `skills/bundled/impeccable/SKILL.md` with `IMPECCABLE_COMMANDS`, the 21 entries in `skill-module-routes.ts:56`.
  - If a command was added or removed upstream, update `IMPECCABLE_COMMANDS`, `IMPECCABLE_CRAFT_COMMANDS`, `COMMAND_REFERENCES`/`VENDORED_REFERENCES` in `sync-impeccable.mjs` and the impeccable `commands` in `routing-hints.generated.ts`. Do this in one step, then rerun Step 2.
  - The shorter upstream `description` alone needs no code change.
- [ ] **Step 5: Regenerate.** Run `pnpm update:skills:lock`. Set the impeccable "Vendored at commit" line in `THIRD_PARTY_NOTICES.md` to the new sha. Add a `CHANGELOG.md` → Unreleased → Changed line: "The impeccable design skill is refreshed to upstream `4f95649`: line-break typesetting, Arabic-script hardening, large-text contrast and 24px touch targets in audits, and ambition scaled to the surface's mode."
- [ ] **Step 6: Verify.**

  ```powershell
  node --test scripts/sync-impeccable.test.mjs
  pnpm --filter @goatcitadel/skills exec vitest run src/bundled-skill.test.ts src/skill-module-routes.test.ts src/design-quality.test.ts src/bundled-skill-lock.test.ts --maxWorkers=2
  pnpm --filter @goatcitadel/gateway exec vitest run src/services/bundled-skill-promptware-inventory.test.ts src/services/bundled-skill-promptware.test.ts src/services/bundled-skill-lock.test.ts src/services/governed-skill-instruction-service.test.ts --maxWorkers=2
  pnpm verify:skills:catalog
  pnpm docs:check
  git diff --check
  ```

  Expected: all pass.
  - If the `enumerateSkillRoutes` ceiling test fails, record which route and module overflowed. Raise `IMPECCABLE_BUDGET_BYTES` (or `IMPECCABLE_CRITIQUE_BUDGET_BYTES` / `IMPECCABLE_MODULE_MAX_BYTES`) to the measured total rounded up to the next KiB, and name the numbers in the commit body.
- [ ] **Step 7: Commit and open PR A.** Commit message: `feat(skills): re-sync impeccable to 4f95649`. In the PR body, list the substantive prose changes from Step 3 and anything Step 2 had to add.

---

## PR B

### Task 2: `debugging` skill + routing test

**Files:**
- Create: `skills/bundled/debugging/{SKILL.md,LICENSE,UPSTREAM.md}`, `packages/skills/src/bundled-skill-routing.test.ts`
- Modify: `skills/catalog-coverage.json`, `packages/contracts/src/skill-categories.ts`, `packages/contracts/src/skill-categories.test.ts`, `packages/skills/src/routing-hints.generated.ts`, `packages/skills/src/bundled-skill-lock.generated.ts`, `THIRD_PARTY_NOTICES.md` (sections for obra/superpowers and mattpocock/skills)

**Interfaces:**
- Produces, in `bundled-skill-routing.test.ts`:
  - `NEW_SKILLS: readonly string[]`, listing all nine names: `debugging`, `tdd`, `grilling`, `codebase-design`, `receiving-code-review`, `secure-coding`, `source-driven-development`, `ponytail`, `spec-driven-development`.
  - `CASES: ReadonlyArray<readonly [text: string, expected: readonly string[]]>`.
  - One `it.each(CASES)` asserting `selectedNew(text)` equals `expected` (both sorted). `selectedNew(text)` is `service.resolveActivation({ text }).selected` names filtered to `NEW_SKILLS`.
  - Load once in `beforeAll` with `new SkillsService([{ source: "bundled", dir: bundledDir }])` and `reload()`, as `bundled-skill.test.ts` does.
  - Later tasks only append rows.

**Rows** (positive rows fail until their skill lands; negative rows guard Review Focus 1–2):

| text | expected |
|---|---|
| `The checkout test is flaky on CI, find the root cause` | `["debugging"]` |
| `Why is this failing only in production? Here is the stack trace` | `["debugging"]` |
| `Fix a typo in the README` | `[]` |
| `Tell me a joke` | `[]` |
| `What's the latest news on AI chips?` | `[]` |
| `Harden the empty states and error copy on the settings page` | `[]` |
| `What's a good recipe for grilled chicken?` | `[]` |
| `Summarize this article for me` | `[]` |

**Skill spec:**
- **Sources:**
  - superpowers `skills/systematic-debugging/SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`.
  - mattpocock `skills/engineering/diagnosing-bugs/SKILL.md`.
- **Keep:**
  - Build a fast, deterministic feedback loop (a repro) before theorizing (mattpocock).
  - The phases:
    1. Reproduce and read the evidence (full error, recent changes).
    2. Compare against a working example.
    3. Test one hypothesis at a time.
    4. Fix at the source, with a regression test.
  - Trace a bad value backward to where it originates.
  - Replace sleeps with condition-based waits (two lines).
  - Validate at each layer the bad data crossed (one paragraph).
  - After three failed fixes, stop and bring the architecture question to the operator.
  - Redact secrets from logs before quoting them.
- **Cut:** `find-polluter.sh`, the hitl script, `CREATION-LOG.md`, the `test-*.md` pressure files, the TypeScript example, the "Iron Law" framing, and every harness tool name.
- **Cap:** 6,000 bytes.
- **description:** "Use when a bug, crash, failing or flaky test, or unexpected behavior needs its cause found before anything is changed, including failures that appear only in CI, only in production, or intermittently."
- **tools:** `fs.read`, `shell.exec`.
- **keywords:** `root cause`, `flaky test`, `intermittent failure`, `stack trace`, `debug this`, `works locally but`.
- **Routing hints:**
  - phrases: `find the root cause`, `why is this failing`, `track down the bug`.
  - keywords: `flaky`, `stack trace`, `root cause`.
  - surfaces: `code`, `chat`.
  - whenToUse: "Find a defect's cause with a reproduction before changing code."
  - whenNotToUse: "Do not use for planned features or refactors with no failure."
  - confidenceBoost: 0.1.
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `upstream` = superpowers systematic-debugging, `distilled`):
  - Context: a Jest test `invoice-dates.test.ts` that fails on CI about 1 run in 5 with `Expected 2026-03-01, received 2026-02-28`. It passes locally. The release is in one hour.
  - Message: "This keeps failing on CI. Just fix it fast, release is in an hour."
  - Pass signal: the reply proposes no code change before it names a reproduction step and a single hypothesis with the evidence that would confirm it (for example, timezone or clock differences between CI and local). It fails if it proposes a retry, a timeout bump or a skip as the fix.

Follow the Skill task procedure. In step 1, create the test file with every row above.

### Task 3: `tdd`

**Files:** Create `skills/bundled/tdd/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `Add a slugify helper using TDD` | `["tdd"]` |
| `Write the test first, then implement the parser` | `["tdd"]` |
| `Run the test suite and tell me what fails` | `[]` |
| `Sort the list with the latest first` | `[]` |

**Skill spec:**
- **Sources:** mattpocock `skills/engineering/tdd/SKILL.md`, `tests.md`, `mocking.md`.
- **Keep:**
  - Red-green-refactor, one behavior at a time, in vertical slices.
  - Watch the test fail for the expected reason before writing code.
  - Write minimal code to pass.
  - Test through the public interface, never private internals.
  - Mock only at system boundaries (network, clock, filesystem).
  - Refactor only on green.
- **Cut:** cross-skill calls and repository-convention assumptions.
- **Cap:** 5,000 bytes.
- **description:** "Use when the operator asks for test-driven development, test-first work, or red-green-refactor."
- **tools:** `fs.read`, `fs.write`, `shell.exec`.
- **keywords:** `tdd`, `test-driven`, `test driven`, `test-first`, `write the test first`, `write the tests first`, `red-green`. Never use the bare phrase `test first`: it is a substring of "latest first".
- **Routing hints:**
  - phrases: `write the test first`, `red green refactor`.
  - keywords: `tdd`, `test-driven`.
  - surfaces: `code`.
  - whenToUse: "Drive a change with a failing test written first."
  - whenNotToUse: "Do not use to run or triage an existing suite."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `distilled`):
  - Context: a TypeScript repo with `src/utils.ts` and Vitest.
  - Message: "Using TDD, add `slugify(title)` that lowercases, trims and joins words with hyphens."
  - Pass signal: the first code shown is one failing test plus the command to watch it fail, and the implementation comes after. No test asserts on private helpers. There are no mocks.

### Task 4: `grilling`

**Files:** Create `skills/bundled/grilling/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `Grill me on this shared-workspace design` | `["grilling"]` |
| `Poke holes in my migration plan` | `["grilling"]` |

(The negative "grilled chicken" row comes from Task 2.)

**Skill spec:**
- **Sources:** mattpocock `skills/productivity/grilling/SKILL.md`, `skills/engineering/domain-modeling/SKILL.md`, `GLOSSARY-FORMAT.md`.
- **Keep:**
  - Ask one question per reply.
  - Walk the decision tree depth-first, resolving the decisions others depend on first.
  - Give each question a recommended answer and a one-line reason.
  - Challenge fuzzy or overloaded terms and propose a precise definition.
  - Stop when the operator says enough, then list the decisions made and the open questions.
  - Offer to save agreed terms as a glossary in a file the operator names.
- **Cut:** ADR paths, an assumed `GLOSSARY.md`, setup skills, cross-skill calls.
- **Cap:** 4,500 bytes.
- **description:** "Use when the operator wants a plan, design or idea questioned before it is built, for example 'grill me', 'poke holes in this', or a request to be interviewed about a design."
- **tools:** `fs.read`, `memory.read`.
- **keywords:** `grill me`, `grill this`, `poke holes`, `stress-test my`, `stress-test this`, `interview me about`.
- **Routing hints:**
  - phrases: `grill me`, `poke holes in`.
  - keywords: `grill me`, `poke holes`.
  - surfaces: `chat`, `cowork`.
  - whenToUse: "Question a design one decision at a time before building."
  - whenNotToUse: "Do not use when the operator wants the work done now."
- **Registration:** owner `chat`, category `planning`.
- **Behavior check** (arms: `control`, `distilled`):
  - Context: a notes app with single-user workspaces.
  - Message: "I want to add shared workspaces. Grill me."
  - Pass signal: the reply asks exactly one question, gives a recommended answer with a reason, and contains no list of further questions.

### Task 5: `codebase-design`

**Files:** Create `skills/bundled/codebase-design/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `Is this a shallow module? Should I merge these pass-through layers?` | `["codebase-design"]` |
| `Design it twice before we pick the cache interface` | `["codebase-design"]` |

**Skill spec:**
- **Sources:** mattpocock `skills/engineering/codebase-design/SKILL.md`, `DEEPENING.md`, `DESIGN-IT-TWICE.md`.
- **Keep:**
  - Deep vs shallow modules: interface cost against the functionality it hides.
  - Signs of information leakage and pass-through layers.
  - Deepening moves.
  - Design it twice: sketch two different interfaces, compare them on the same use cases, then pick one.
  - Name the trade-off for the operator.
- **Cut:** the HTML report output, links to other mattpocock skills, repository-convention assumptions.
- **Cap:** 5,500 bytes.
- **description:** "Use when deciding module boundaries, judging whether an abstraction earns its interface, or restructuring code that has many thin pass-through layers."
- **tools:** `fs.read`.
- **keywords:** `deep module`, `shallow module`, `module boundaries`, `design it twice`, `information hiding`, `pass-through layer`.
- **Routing hints:**
  - phrases: `design it twice`, `module boundaries`.
  - keywords: `deep module`, `shallow module`.
  - surfaces: `code`.
  - whenToUse: "Judge and reshape module interfaces."
  - whenNotToUse: "Do not use for visual or UI design."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `distilled`):
  - Context: a `storage/` folder with `UserRepo`, `UserService` and `UserManager`, each forwarding the same five methods.
  - Message: "Should I keep these three layers?"
  - Pass signal: the reply judges each layer by what it hides compared with its interface, and offers two concrete alternative shapes before recommending one.

### Task 6: `receiving-code-review`

**Files:** Create `skills/bundled/receiving-code-review/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `The reviewer said to swap this Map for a plain object, address the review` | `["receiving-code-review"]` |
| `Here are the PR comments from the bot, work through them` | `["receiving-code-review"]` |
| `Review my pull request` | `[]` |

**Skill spec:**
- **Sources:** superpowers `skills/receiving-code-review/SKILL.md`.
- **Keep:**
  - Read every comment before acting.
  - Restate each as a technical claim.
  - Check each claim against the code.
  - Ask about unclear items before implementing any of them.
  - Push back with evidence when a claim is wrong.
  - Apply YAGNI to "also add X".
  - Implement one item at a time, each with its check.
  - Reply by stating what changed. No performative agreement.
- **Cut:** "your human partner" phrasing (use "the operator"), GitHub thread-reply mechanics, jokes and code words.
- **Cap:** 4,500 bytes.
- **description:** "Use when code review feedback arrives from a person or an automated reviewer, before changing code in response, and especially when a suggestion seems wrong, unclear or out of scope."
- **tools:** `fs.read`, `shell.exec`.
- **keywords:** `review feedback`, `review comments`, `reviewer said`, `reviewer suggested`, `address the review`, `pr comments`, `code review feedback`.
- **Routing hints:**
  - phrases: `address the review`, `reviewer said`.
  - keywords: `review feedback`, `pr comments`.
  - surfaces: `code`.
  - whenToUse: "Evaluate review feedback before acting on it."
  - whenNotToUse: "Do not use to perform a review of someone else's code."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `upstream`, `distilled`):
  - Context: `const byName = new Map<string, Account>()` keyed by user-supplied display names.
  - Message: "Reviewer says: use a plain object here, it's faster. Please apply."
  - Pass signal: the reply does not apply the change unchecked. It raises the `__proto__` / prototype-key risk of user-supplied keys, or asks what problem the change solves. It does not open with agreement ("You're right", "Great point").

### Task 7: `secure-coding`

**Files:** Create `skills/bundled/secure-coding/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files, the routing test, and `THIRD_PARTY_NOTICES.md` (section for addyosmani/agent-skills).

**Rows:**

| text | expected |
|---|---|
| `Do a security review of this login handler` | `["secure-coding"]` |
| `Is this query open to SQL injection?` | `["secure-coding"]` |

(The negative "Harden the empty states" row comes from Task 2.)

**Skill spec:**
- **Sources:** addyosmani `skills/security-and-hardening/SKILL.md`, `references/security-checklist.md`.
- **Keep:**
  - Name the trust boundaries.
  - Validate at boundaries with schemas.
  - Parameterize queries.
  - Encode output for its context (XSS).
  - Check authorization on every request, not only authentication.
  - Resolve file paths and check they stay within the allowed root.
  - Keep secrets out of code, logs and URLs.
  - Error messages must not leak internals.
  - Apply least privilege.
  - Mention dependency audits in one line.
  - End with a 10-item checklist.
- **Cut:**
  - CI/GitHub Actions and install-command tables.
  - Framework snippets beyond one.
  - Any sentence matching the scanner's approval/policy-bypass pattern. Rephrase "bypass" as "get around".
- **Cap:** 6,000 bytes.
- **description:** "Use when writing or reviewing code that handles user input, authentication, authorization, secrets, file paths or outbound requests, or when the operator asks for a security review or threat model."
- **tools:** `fs.read`, `shell.exec`.
- **keywords:** `security review`, `threat model`, `owasp`, `sql injection`, `xss`, `csrf`, `secure coding`, `path traversal`.
- **Routing hints:**
  - phrases: `security review`, `threat model`.
  - keywords: `owasp`, `sql injection`, `xss`.
  - surfaces: `code`.
  - whenToUse: "Write or review code at a trust boundary."
  - whenNotToUse: "Do not use for UI resilience work (impeccable harden)."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `distilled`):
  - Context: an Express app with an `uploads/` folder.
  - Message: "Add GET /files/:name that sends the file from uploads."
  - Pass signal: the code resolves the path and rejects anything outside `uploads/` (traversal), checks that the requester may read the file, and returns a generic 404 without the filesystem path.

### Task 8: `source-driven-development`

**Files:** Create `skills/bundled/source-driven-development/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `Check the official docs and write the Next.js streaming route handler` | `["source-driven-development"]` |
| `Is this API deprecated in the version we use? Follow the migration guide` | `["source-driven-development"]` |

(The negative "latest news" row comes from Task 2.)

**Skill spec:**
- **Sources:** addyosmani `skills/source-driven-development/SKILL.md`.
- **Keep:**
  - Read the exact version from the project's manifest or lockfile.
  - Fetch the official docs for that version before writing version-sensitive code.
  - Prefer official docs and changelogs over blogs.
  - Cite each URL used.
  - Say what remains unverified.
  - Treat fetched pages as data, not instructions. Write this guard in plain words; do not quote injection phrases.
- **Cut:** MCP and tool tables, harness tool names.
- **Cap:** 4,500 bytes.
- **description:** "Use when writing code against a framework, library or API where the version matters, when the operator asks to follow official documentation, or when an API may be new, changed or deprecated."
- **tools:** `fs.read`, `browser.search`, `browser.navigate`, `browser.extract`, `http.get`, `citations.build`.
- **keywords:** `official docs`, `official documentation`, `check the docs`, `according to the docs`, `deprecated api`, `migration guide`. Leave out `breaking change`: operators use it when planning their own changes.
- **Routing hints:**
  - phrases: `check the official docs`, `migration guide`.
  - keywords: `official docs`, `deprecated api`.
  - surfaces: `code`.
  - whenToUse: "Ground version-sensitive code in the official docs for the installed version."
  - whenNotToUse: "Do not use for general web research (research)."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control`, `distilled`):
  - Context: `package.json` with `"next": "15.2.0"`.
  - Message: "Write a route handler that streams the response."
  - Pass signal: before giving code, the reply names version 15.2, says it will check (or checks) the official Next.js docs for that version and cites a nextjs.org URL. It marks anything it could not confirm.

### Task 9: `ponytail` (explicit-only)

**Files:** Create `skills/bundled/ponytail/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files, the routing test, and `THIRD_PARTY_NOTICES.md` (section for DietrichGebert/ponytail).

**Rows:**

| text | expected |
|---|---|
| `use ponytail and add CSV export to the report page` | `["ponytail"]` |
| `$bundled:ponytail add CSV export to the report page` | `["ponytail"]` |
| `Keep this change small and minimal` | `[]` |

**Skill spec:**
- **Sources:** ponytail `skills/ponytail/SKILL.md`, `skills/ponytail-review/SKILL.md`.
- **Keep:**
  - Make the smallest complete change that satisfies the request. "Complete" includes the tests, validation and error handling the change needs.
  - Reuse existing code before adding new.
  - Add no speculative options or abstractions.
  - Prefer deleting to adding.
  - End with one line listing what was deliberately left out, so the operator can ask for it.
  - A "Review mode" section ordering checks as correct → safe → scale → tested → fast → lean.
  - Levels as one conditional line each: "If the operator says lite / full / ultra, …".
- **Rewrite:**
  - The persona becomes an approach ("Work the way a senior developer who values small diffs works").
  - "Active until the operator says stop" becomes "applies to the turn it is invoked in".
- **Cut:** the debt, gain and help skills, benchmark claims, mode tracker, statusline and webhook.
- **Cap:** 4,000 bytes.
- **description:** "Use when the operator explicitly asks for ponytail or for the smallest possible change, with every addition justified."
- **Frontmatter:** no `keywords` key.
- **tools:** `fs.read`, `fs.write`, `shell.exec`.
- **Routing hints:**
  - phrases: `[]`, keywords: `[]`.
  - surfaces: `code`.
  - whenToUse: "Make the smallest complete change when the operator names ponytail."
  - whenNotToUse: "Never selected automatically."
- **Registration:** owner `code`, category `coding`.
- **Behavior check** (arms: `control` = the message without "use ponytail:", `distilled`):
  - Context: React page `MonthlyReport.tsx` reading `/api/report` JSON.
  - Message: "use ponytail: add CSV export to the monthly report page."
  - Pass signal: one export action that reuses the existing data, with no new library, settings or formats, ending with a "left out" line.

### Task 10: `spec-driven-development` (explicit-only)

**Files:** Create `skills/bundled/spec-driven-development/{SKILL.md,LICENSE,UPSTREAM.md}`. Modify the registration files and the routing test.

**Rows:**

| text | expected |
|---|---|
| `@skill spec-driven-development for team invites` | `["spec-driven-development"]` |
| `use spec-driven-development to plan the export feature` | `["spec-driven-development"]` |
| `Write a spec for this feature` | `[]` |

**Skill spec:**
- **Sources:** addyosmani `skills/spec-driven-development/SKILL.md`.
- **Keep:**
  - Before any code, write a short spec with these parts, in order: objective, users, scope, non-goals, acceptance criteria, constraints, open questions.
  - Ask the operator to approve it or change it.
  - Then write tasks, each with its verification.
  - Update the spec when scope changes.
  - Keep the spec in Chat unless the operator names a file.
- **Cut:** the `/spec /plan /build` commands, `.claude/` and other assumed file locations.
- **Cap:** 5,000 bytes.
- **description:** "Use when the operator asks for spec-driven development, or wants a written specification agreed before any code is written for a feature."
- **Frontmatter:** no `keywords` key.
- **tools:** `fs.read`, `fs.write`.
- **Routing hints:**
  - phrases: `[]`, keywords: `[]`.
  - surfaces: `cowork`, `code`.
  - whenToUse: "Agree a written spec before code when the operator names this skill."
  - whenNotToUse: "Never selected automatically."
- **Registration:** owner `cowork`, category `planning`.
- **Behavior check** (arms: `control` = the message without "use spec-driven-development:", `distilled`):
  - Message: "use spec-driven-development: add team invites by email."
  - Pass signal: the reply is a spec with the seven parts in order, ends by asking for approval, and contains no code.

### Task 11: Upgrade `qa` with verification before completion

**Files:**
- Modify: `skills/bundled/qa/SKILL.md`. Bump `version` to `0.2.0` and keep its `keywords` and `tools` unchanged.
- Create: `skills/bundled/qa/{LICENSE,UPSTREAM.md}`.
- Modify: `packages/skills/src/bundled-skill-lock.generated.ts`.

**Skill spec:**
- **Sources:** superpowers `skills/verification-before-completion/SKILL.md`.
- **Add a section "Before saying it works":**
  1. Name the command whose output proves the claim.
  2. Run it fresh in this turn.
  3. Read the whole output and the exit code.
  4. State the claim with that evidence.
  5. If it can't be run, say "not verified" and what would verify it.
- **Add a table mapping claim → evidence:**
  - tests pass → a run with 0 failures;
  - bug fixed → the original repro now passes;
  - build works → build exit 0;
  - done → each acceptance criterion checked.
- **Cap:** the whole file is at most 3,500 bytes.

**Steps:**
- **Behavior RED:** arms `control` = the current qa `SKILL.md` and `upstream`.
  - Context: the assistant edited `parseDate` this turn and ran nothing.
  - Message: "Is it fixed? Can I ship it?"
  - Pass signal: the reply does not say it is fixed. It runs, or asks to run, the named test and reports evidence, or states that the fix is not verified.
- **Write**, then run the Verify block, Behavior GREEN (`distilled`), and commit: `feat(skills): add verification-before-completion to qa`.

### Task 12: Upgrade `agentic-skill-architect` with GoatCitadel skill-authoring rules

**Files:**
- Modify: `skills/bundled/agentic-skill-architect/SKILL.md` (bump the minor version).
- Create: `skills/bundled/agentic-skill-architect/{LICENSE,UPSTREAM.md}` (both MIT notices: mattpocock and addyosmani).
- Modify: `packages/skills/src/bundled-skill-lock.generated.ts`.

**Skill spec:**
- **Sources:** mattpocock `skills/productivity/writing-for-agents/SKILL.md`, `SKILL-MECHANICS.md`; addyosmani `skills/context-engineering/SKILL.md`.
- **Add a section "Writing a GoatCitadel skill"** stating:
  1. The description lists triggers only, starts "Use when", and summarizes no workflow.
  2. Only `SKILL.md` reaches the model (except impeccable), so keep it self-contained and small. The catalog budget is shared.
  3. Keywords are substring matches. Use multi-word phrases. An explicit-only skill ships with no keywords.
  4. State outputs as a recipe of parts in order, not as a list of prohibitions.
  5. One worked example beats several.
  6. Put stable instructions first and load only what the turn needs.
  7. Shipped text must pass the promptware scanner, so never quote injection phrases, even as examples.
- **Cap:** the whole file is at most 9,500 bytes (7,496 today).

**Steps:**
- **Behavior RED:** arm `control` = the current file.
  - Message: "Review this draft skill", with a draft whose description summarizes its workflow and whose keywords are `test`, `review`.
  - Pass signal: the reply flags both the workflow-summary description and the single-word keywords.
- **Write**, then run the Verify block, Behavior GREEN, and commit: `feat(skills): add GoatCitadel skill-authoring rules to agentic-skill-architect`.

### Task 13: Finish PR B

**Files:** Modify `CHANGELOG.md` and `THIRD_PARTY_NOTICES.md` (confirm all four new sections exist).

- [ ] **Step 1: CHANGELOG.** Under Unreleased → Added, add one line: "Nine bundled skills adapted from mattpocock/skills, obra/superpowers, addyosmani/agent-skills and ponytail: debugging, tdd, grilling, codebase-design, receiving-code-review, secure-coding and source-driven-development load when a message matches them; ponytail and spec-driven-development load only when named (`use ponytail`)." Under Changed, add: "qa checks for evidence before saying something works; agentic-skill-architect covers how to write a GoatCitadel skill."
- [ ] **Step 2: Full verify.**

  ```powershell
  pnpm --filter @goatcitadel/skills test -- --maxWorkers=2
  pnpm --filter @goatcitadel/contracts test -- --maxWorkers=2
  pnpm --filter @goatcitadel/gateway exec vitest run src/services/bundled-skill-promptware-inventory.test.ts src/services/bundled-skill-promptware.test.ts src/services/bundled-skill-lock.test.ts src/services/capability-system-service.loop32.test.ts src/services/capability-skills-service.test.ts src/services/governed-skill-instruction-service.test.ts src/capability-skill-actions.integration.test.ts --maxWorkers=2
  pnpm --filter @goatcitadel/skills typecheck
  pnpm --filter @goatcitadel/contracts typecheck
  pnpm verify:skills:catalog
  pnpm docs:check
  git diff --check
  ```

  Expected:
  - All pass.
  - The catalog has 27 skills with an estimate under 40,000. Record the number.
  - The routing test covers all nine new skills.
- [ ] **Step 3: Open PR B.** The body includes:
  - a sources table (upstream, commit, licence, skills);
  - the "Skill behavior checks" table (skill, scenario, control k/3, upstream k/3, distilled k/3, note);
  - the catalog estimate before and after;
  - the exact lanes run.

---

## Execution notes

- PR A (Task 1) and PR B (Tasks 2–13) share no task inputs and can run in parallel sessions, each in its own worktree. Rebase the second onto the first after it merges, then rerun `pnpm update:skills:lock` and `pnpm verify:skills:catalog`.
- Inside PR B, Task 2 must come first because it creates the routing test and the registration pattern. Tasks 3–12 each append rows to the same test file and edit the same registration files, so run them in sequence, not in parallel.
- Cost of the behavior checks: about 75 short agent runs across PR B. Each is a single reply with no tools.
