# Usability Review Plan (2026-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one ranked findings report that says, for every task an operator does in GoatCitadel, whether it works first time, smoothly, without a workaround. No product code changes.

**Architecture:** Three phases. Phase 1 re-tests every finding the earlier reviews left open and gives each a verdict. Phase 2 reviews each area fresh: a code read of the task's path from the screen to the Gateway owner, then the same task run in a throwaway sandbox. Phase 3 merges both into one report with findings grouped by root cause and ranked by how badly they stop the operator.

**Tech Stack:** `pnpm testbench` sandbox (stub model), a token-mode Gateway sandbox, Playwright Chromium driven from the review worktree, `pnpm package:desktop` for the packaged app, `git grep` for code searches.

**Spec:** There is no separate spec document. The operator's decisions of 2026-11-14 are the spec and are recorded in full under "Decisions" below.

## Decisions (operator, 2026-11-14)

1. **Deliverable:** findings report only. Fixes get their own plan afterwards.
2. **Scope:** the Cockpit (Chat including Projects, Inbox, Work, Capabilities, Library, System, Settings); first run and install; messaging channels and integrations. Classic shell and the mobile app are out of scope, except where a Cockpit task dead-ends into Classic, which is a finding.
3. **Method:** code read plus live walkthrough for every area.
4. **Earlier reviews:** close out the old lists first. Every earlier open finding gets a verdict before any new review starts.

## Global Constraints

- Review only. Nothing under `apps/`, `packages/`, `scripts/`, `config/` or `skills/` is edited. The only files written are under `docs/review/2026-11-usability/` and the evidence directory.
- Source under review is `origin/main`, pinned to one commit SHA in Task 1 and never moved. The primary checkout has another owner's uncommitted work; do not read findings from it and do not touch it.
- All work happens in one fresh worktree, `.claude/worktrees/usability-review-2026-11`, branch `review/usability-2026-11`, with its own pnpm store. Install with `HUSKY=0` and `pnpm install --offline --frozen-lockfile`. No junctions into the primary checkout's `node_modules`.
- Commits are local, docs only, on the review branch, after each task (a deleted worktree must not lose the work). Never push, open a PR, merge, stash, reset or rebase.
- Sandboxes use task-owned ports, homes, databases and backup directories. Never start against the real `config/goatcitadel.json`, the real profile, the OS keychain or the daily install. Before stopping any process, confirm its PID's command line belongs to this task.
- One heavy job at a time, at below-normal priority where the job tolerates it. Any vitest run uses `--maxWorkers=2`. Launch background processes with `Start-Process -WindowStyle Hidden`; never open a visible console window. Give every subagent these two rules in its brief.
- No real API keys, passwords or account sign-ins are typed by an agent. Provider checks use the stub model, a deliberately invalid test key, or the Claude CLI subscription that is already signed in on this PC.
- Live model budget for the whole review: at most 30 requests, counted before each dispatch, including retries. No paid API fallback.
- No real external sends: no channel message, email, calendar change or webhook leaves the PC. Steps that need one are written into the report's operator checklist instead of being run.
- Code searches that must be complete use `git grep`, not the Grep tool (it silently omits matches in this tree).
- Screenshots come from Playwright, not the built-in browser pane (it times out when the app window is hidden). The Cockpit scrolls inside `#main-content`, so capture that element for full-page shots.
- Tracked files must not contain personal absolute paths (repo hygiene rejects them). Write evidence paths relative to the worktree root.
- A finding is recorded only with evidence: for a live finding, the steps plus a screenshot, console line or network record; for a code-only finding, `file:line` on the pinned SHA plus the click path that reaches it, marked `not reproduced live`. A suspicion without either goes in the "Unconfirmed" list, not the findings.
- Not findings: missing features that no screen offers, roadmap items, and visual taste. A control that is visible and does nothing, or promises something the Gateway does not do, is a finding.

## Finding record

Every finding, old or new, is one object in `docs/review/2026-11-usability/findings.json`:

```json
{
  "id": "U-CH-001",
  "area": "chat",
  "journey": "CH-3 Attach a file and ask about it",
  "severity": "blocker",
  "kind": "dead-end",
  "title": "One sentence, plain words, what the operator sees",
  "trigger": "Exact steps or the input that causes it",
  "expected": "What a reasonable operator expects",
  "actual": "What happens",
  "evidence": ["evidence/chat/ch-3-step4.png", "apps/gateway/src/routes/x.ts:120"],
  "foundBy": "live",
  "confidence": "confirmed",
  "priorIds": ["CH-27", "SY-N06"],
  "owner": "apps/gateway/src/services/x.ts",
  "rootCause": "RC-04"
}
```

- `id`: `U-` + area prefix + three digits. Prefixes: `CH` Chat, `PJ` Projects, `IN` Inbox, `WK` Work, `CP` Capabilities, `LB` Library, `SY` System, `ST` Settings, `FR` first run and install, `MS` messaging channels, `GL` everywhere.
- `severity`: `blocker` (the task cannot be finished), `stall` (finished only with a retry, a reload, a workaround or knowledge the screen does not give), `friction` (finished, with extra steps, a wait with no feedback, or a confusing message), `polish` (noticed, costs nothing).
- `kind`: `bug`, `dead-end`, `missing-state` (no loading, empty, error or recovery state), `wrong-status` (the screen says something the Gateway does not agree with), `unclear-copy`, `slow` (with the measured time), `approval-friction` (more than one click to approve, a round-trip to another screen, or a manual "Continue" after approving).
- `foundBy`: `live`, `code`, `both`. `confidence`: `confirmed`, `likely` (code-only).
- `rootCause` is filled in Task 15.

## Journey walkthrough rule

For each journey, in this order:

1. **Code read.** Trace screen component → API client call → Gateway route → owning service. Check each of: loading state, empty state, error state with a next step, what happens on a 4xx/5xx/timeout, whether a success is confirmed on screen, whether the screen refreshes itself afterwards, whether Back/reload keeps the operator's place, and whether any link leaves the Cockpit for Classic.
2. **Live run.** Do the task in the sandbox as a first-time operator would, with keyboard at least once. Record time to first feedback and time to done. Then do the one failure the code read marked most likely.
3. **Record.** One finding per defect, or the line `PASS <journey id>` in `docs/review/2026-11-usability/journeys.md` with the evidence path.

A journey is `PASS` only when it finishes first time with no reload, no retry and no trip to another area that the screen did not send the operator to.

## Review Focus

Conditions the journey lists do not reach by themselves and that are most likely to bite. Each is pinned to a step in the task named.

1. The Gateway restarts, or the PC sleeps and wakes, while a Chat turn is streaming or an approval is pending. The operator expects the turn to resume or a plain statement of what was lost. (Task 6, Step 4)
2. No provider is set up, the key is wrong, or the chosen model is gone. The operator expects every screen that needs a model to say so and link to the fix. (Task 11, Step 4)
3. The install uses token auth, not the sandbox's auth `none`. The operator expects the same tasks to work; earlier reviews found features that return 403 in one mode only. (Task 13, Step 2)
4. The install is old and full: 1,000 conversations, a 300-message thread, a 15 MB attachment, hundreds of memory items. The operator expects lists and Chat to stay responsive. (Task 13, Step 3)
5. The packaged Windows app, not Chromium on the dev server: notification deep links, file pickers, window restore, a second launch. The operator expects the same result as in the browser. (Task 12, Step 4)

---

## Phase 0: Setup

### Task 1: Worktree, sandbox and scaffolding

**Files:**
- Create: `docs/review/2026-11-usability/README.md` (pinned SHA, sandbox recipe, how to re-run)
- Create: `docs/review/2026-11-usability/findings.json` (empty array)
- Create: `docs/review/2026-11-usability/journeys.md` (the journey lists from Tasks 6–14, each marked `TODO`)
- Create: `docs/review/2026-11-usability/evidence/` (one sub-directory per area prefix, lower case)
- Create: `docs/review/2026-11-usability/tools/shot.cjs` (Playwright helper)
- Create: `docs/review/2026-11-usability/tools/check-register.cjs`

**Interfaces:**
- Produces: `node docs/review/2026-11-usability/tools/check-register.cjs [prefix…]`, which reads `prior-register.json` and prints `unverdicted: N` (rows with `verdict === null`) and `uncarried: N` (`open` or `partial` rows with no `carriedAs`), limited to rows whose prior id starts with a given prefix when prefixes are passed; exit code 1 when either is above 0.
- Produces: `PINNED_SHA` in the README; sandbox URLs `TESTBENCH_URL` and `TOKEN_URL` in the README; `node docs/review/2026-11-usability/tools/shot.cjs <url> <out.png> [--phone] [--light]`, which opens the URL with the workspace keys set, waits for `#main-content`, saves the element screenshot and prints console errors and failed requests as JSON lines.

- [ ] **Step 1:** `git fetch origin`, then `git worktree add .claude/worktrees/usability-review-2026-11 -b review/usability-2026-11 origin/main`. Write the resolved SHA to the README as `PINNED_SHA`. Run `git status --short --branch` in the new worktree; expected: clean.
- [ ] **Step 2:** In the worktree: `HUSKY=0`, `pnpm install --offline --frozen-lockfile --store-dir <a store directory next to the worktree, not the shared one>`, then build `@goatcitadel/contracts` and the `mission-control-next^...` dependency chain. Expected: exit code 0 for each.
- [ ] **Step 3:** Start `pnpm testbench` hidden, in the background. Read its `[testbench]` output for the UI URL and the stop-file path; record both in the README. Expected: the Cockpit loads at the URL and `shot.cjs` saves `evidence/gl/boot-dark.png` with zero console errors.
- [ ] **Step 4:** Write `shot.cjs`. It sets localStorage `goatcitadel.ui.workspace_id.v1`, `goatcitadel.ui.citadel_id.v1` and `goatcitadel.ui.theme.v1` before navigation. Flags: `--phone` = 375×812, default = 1440×900; `--light` = light theme.
- [ ] **Step 5:** Seed the sandbox: call `POST /api/v1/demo/bootstrap` (gives two pending approvals), then run the fixture seeding in `scripts/verification/lib/scenarios/fixture-seeding.mjs`. Under auth `none` the Ops board step returns 403; note it and finish the memory, file and prompt-pack steps by hand. Record what is seeded in the README.
- [ ] **Step 6:** Record the token-mode recipe in the README without starting it yet: a second Gateway on port 18787 with scratch root, home and backup directories, keychain off, auth mode `token`, and the UI origin named in its CORS setting.
- [ ] **Step 7:** Commit: `docs(review): scaffold 2026-11 usability review`.

---

## Phase 1: Close out the earlier lists

Output of this phase: `docs/review/2026-11-usability/prior-register.json`, one row per earlier finding that was not already confirmed fixed, each with a verdict.

Row shape: `{ "priorId", "source", "title", "severity", "verdict", "evidence", "note", "carriedAs" }`.

- `verdict`: `fixed` (evidence shows the defect is gone), `open` (still reproduces), `partial`, `obsolete` (the screen or feature no longer exists), `operator-only` (needs a real account, device or installed app), `cannot-check` (say why).
- `carriedAs`: for `open` and `partial`, the new `U-…` id written into `findings.json` in the same step. Every `open` or `partial` row must have one.
- Verdict order: code read on `PINNED_SHA` first; go live only when the code cannot settle it. A `fixed` verdict needs `file:line` or a screenshot. "A PR said it fixed this" is not evidence.

### Task 2: Build the register

**Files:**
- Create: `docs/review/2026-11-usability/prior-register.json`
- Create: `docs/review/2026-11-usability/prior-sources.md`

**Interfaces:**
- Produces: the register with every row at `verdict: null`, and `prior-sources.md` with the row count per source. Tasks 3–5 fill verdicts by `source`.

- [ ] **Step 1:** Import source `ledger-233`: every row of `docs/ux/cockpit-remediation/remediation-ledger.json` (219 teardown findings of 2026-10-03 plus 14 parity findings of 2026-10-05). Keep id, title, severity and acceptance criterion.
- [ ] **Step 2:** Import source `followup-157`: from the published review page "Cockpit follow-up review" (artifact id `RGNznEavTEJECy8bu9pUXj`, read its `data.js`), every row not marked fixed: expected 28 open, 5 partial, 9 deferred of the 157 new findings, plus the 41 open, 5 regressed and 3 deferred rows of the older 206-finding audit it re-checked.
- [ ] **Step 3:** Import source `comprehensive-138`: the findings ledger of the 2026-11-02 comprehensive review. It is the newest `findings-ledger-closure-*.json` under `.superpowers/sdd/2026-11-02-comprehensive-review/` in the `comprehensive-review-20261102` worktree (locate it with `git worktree list`; read only, never write there). Import the rows whose area is Cockpit, first run, desktop, channels, integrations or Chat behavior; skip pure storage, CI and test-harness rows and count the skipped rows in `prior-sources.md`. If the ledger file is missing, record `comprehensive-138: source missing` and import the findings named in `docs/superpowers/plans/2026-11-02-comprehensive-review-report.md` instead.
- [ ] **Step 4:** Import source `parity-routes`: every route in `docs/ux/cockpit-remediation/classic-parity-inventory.json` whose Cockpit destination is partial, link-out or missing.
- [ ] **Step 5:** Import source `owed-live`: the operator checklist in `docs/review/2026-10-cockpit-verification-gaps.md`, plus the live checks still owed from merged work: Review answer in Chat; deep research document truncation (#682); native skill import in Chat; Code Mode PDF in a turn; one-click Settings approvals (#625); the Firecrawl base URL and allowlist in Settings; a vendor MCP connector and Google desktop sign-in; each messaging channel end to end; Inbox approvals that have no workspace; the plugin panel copy items (a blocked skill gives no reason, "15 of 19" counts blocked skills, nameless-plugin copy, the moving "can't be installed" line); the vague refusal on a skill-id collision.
- [ ] **Step 6:** Merge rows that describe the same defect across sources into one row listing every prior id. Expected: `prior-sources.md` shows imported, merged and final counts per source and they add up.
- [ ] **Step 7:** Commit: `docs(review): prior findings register`.

### Task 3: Verdicts for Chat, Inbox and Work rows

**Files:**
- Modify: `docs/review/2026-11-usability/prior-register.json`, `findings.json`
- Create: `docs/review/2026-11-usability/evidence/prior/` (screenshots named by prior id)

**Interfaces:**
- Consumes: register rows whose prior id starts `CH`, `IN`, `WK`, plus `comprehensive-138` and `owed-live` rows about Chat, approvals or Work.
- Produces: a non-null `verdict` on each, and a `U-…` finding for each `open` or `partial`.

- [ ] **Step 1:** Code-read pass over every consumed row, one read-only subagent per prefix in parallel. Each returns the row with a proposed verdict and `file:line`.
- [ ] **Step 2:** Live pass, one at a time in the testbench, over every row the code read left `open`, `partial` or undecided. Screenshot each.
- [ ] **Step 3:** Write verdicts and carried findings. Check: `node docs/review/2026-11-usability/tools/check-register.cjs CH IN WK` prints `unverdicted: 0` and `uncarried: 0`.
- [ ] **Step 4:** Commit: `docs(review): prior verdicts for Chat, Inbox, Work`.

### Task 4: Verdicts for Library, System, Settings, first run, navigation and global rows

Same files, steps and check as Task 3, for rows whose prior id starts `LB`, `SY`, `ST`, `FR`, `NV`, `GL`, plus `comprehensive-138` rows about Settings, desktop and first run, and all `parity-routes` rows. A `parity-routes` row is `fixed` only when every action the Classic page offered can be done in the Cockpit; a Cockpit page that links out to Classic for an action is `partial`.

- [ ] **Step 1–3:** As Task 3.
- [ ] **Step 4:** Commit: `docs(review): prior verdicts for Library, System, Settings, global`.

### Task 5: Verdicts for the remaining rows and the Phase 1 summary

**Files:**
- Modify: `prior-register.json`, `findings.json`
- Create: `docs/review/2026-11-usability/phase-1-summary.md`

- [ ] **Step 1:** Give a verdict to every remaining row (Capabilities, channels, integrations, the rest of `owed-live`). Rows that need a real account, a real channel or the installed app are `operator-only`, with the exact steps the operator should run written in `note`.
- [ ] **Step 2:** Check: `check-register.cjs` with no prefix prints `unverdicted: 0` and `uncarried: 0`.
- [ ] **Step 3:** Write `phase-1-summary.md`: counts by source and verdict, the ten most severe rows still open, and the areas where open rows cluster. Phase 2 spends more time where they cluster.
- [ ] **Step 4:** Commit: `docs(review): phase 1 close-out summary`.

---

## Phase 2: Fresh review by area

Every task in this phase follows the "Journey walkthrough rule" and has the same shape:

**Files:** Modify `findings.json` and `journeys.md`; create screenshots under `evidence/<prefix>/`.

**Interfaces:** Consumes `TESTBENCH_URL`, `shot.cjs`, and the Phase 1 findings for its area (do not record a defect twice; add the journey to the existing finding). Produces a `PASS` line or at least one finding for every journey listed.

**Steps, unless the task adds more:**
- [ ] **Step 1:** Code read of every journey in the list (read-only subagents may take one journey each, in parallel).
- [ ] **Step 2:** Live run of every journey, one at a time, desktop width dark theme; repeat the first two journeys at phone width in the light theme.
- [ ] **Step 3:** Check: every journey id in the list appears in `journeys.md` as `PASS` or with a finding id. Commit: `docs(review): <area> journeys`.

### Task 6: Chat, the conversation itself

Journeys:
- `CH-1` First message in an empty install: New conversation, type, send, read the answer.
- `CH-2` Follow-up, edit an earlier message, retry an answer, stop a streaming answer.
- `CH-3` Attach a text file and an image, ask about them; attach a file that is too large.
- `CH-4` Switch model and provider for one conversation; see which model answered.
- `CH-5` Find an old conversation, rename it, delete it, and come back to where you were after a reload.
- `CH-6` Use the composer's plus menu: web on and off, Review answer, a prompt pack, a variable.
- `CH-7` Long answer: scroll up while it streams, scroll position holds, jump to latest.
- `CH-8` Two tabs on the same conversation: send in one, the other catches up.

- [ ] **Step 1–3:** Standard steps.
- [ ] **Step 4 (Review Focus 1):** While `CH-1` is streaming, stop the sandbox Gateway process (confirm the PID's command line first; emulated offline does not close the open stream, so it proves nothing) and start it again. Then repeat with a pending approval on screen. Record what the screen says during the outage, whether the turn resumes, and whether anything is silently lost. The testbench tears itself down when its Gateway dies; restart it and re-seed afterwards.

### Task 7: Chat, agentic work, approvals and Code Mode

Journeys:
- `CH-9` Ask for something that needs a tool: the approval appears in place, one click approves, the turn continues with no "Continue" step and no trip to the Inbox.
- `CH-10` Deny an approval; approve after the request expired.
- `CH-11` A planning or research request: steps, progress, delegation and the final synthesis are readable; a failed step says what failed and what to do.
- `CH-12` Deep research with documents; a document that is truncated says so.
- `CH-13` Code Mode run from Chat: approval, run, artifact shown, artifact opened.
- `CH-14` Use a skill by name (`use <name>`), and a skill that is switched off.
- `CH-15` A browser errand started from Chat, up to its first approval.
- `CH-16` Publish a managed project file with the overwrite review.

- [ ] **Step 1–3:** Standard steps. For `CH-9` count the clicks from the approval appearing to the turn continuing; more than one is an `approval-friction` finding.

### Task 8: Projects, Inbox and Work

Journeys:
- `PJ-1` Create a project, add files, start a conversation in it, switch projects.
- `PJ-2` Open, edit and save a project file; leave with unsaved changes.
- `IN-1` Open the Inbox with pending approvals: read what is asked, approve one, deny one, see the result and where it went.
- `IN-2` An approval with no workspace: is it visible anywhere.
- `IN-3` Notification from the Inbox to the thing that raised it, and back.
- `WK-1` Create a task on the Board, move it, open its run, read its history.
- `WK-2` Pause, resume, cancel and retry a run; the buttons say what each will do.
- `WK-3` Create a schedule, edit it, see when it next runs, see that it ran.
- `WK-4` Archive and restore a task; open the Automation designer and the older Kanban view.

- [ ] **Step 1–3:** Standard steps.

### Task 9: Capabilities and Library

Journeys:
- `CP-1` Skills: find a skill, switch it on, use it in Chat, switch it off.
- `CP-2` Import a skill from a folder and from a Git source; an import that collides with an existing id.
- `CP-3` Plugins: inspect, install, see what it added, uninstall (including the second uninstall when its skill is on).
- `CP-4` Connectors: add a connector from a template up to the credential step with an invalid test credential; read the error; remove it.
- `CP-5` MCP: add a static MCP server, see its tools, use one in Chat.
- `CP-6` Tools: find a tool, read what it can do and what approval it needs, change its permission.
- `LB-1` Memory: see what was remembered and why, edit an item, forget an item, see history.
- `LB-2` Files and artifacts: upload a text file, find an artifact made in Chat, open it.
- `LB-3` Agents: view profiles and the imported catalog; prompt packs: open, use in Chat.
- `LB-4` Knowledge: add a source, see it used in an answer with its citation.

- [ ] **Step 1–3:** Standard steps.

### Task 10: System

Journeys:
- `SY-1` Health: is anything wrong right now, and what to do about it. Every warning on a fresh sandbox is checked against the Gateway's own state; a warning the Gateway does not back is a `wrong-status` finding.
- `SY-2` Runtime and Sessions: see what is running, stop something.
- `SY-3` Spend: what did today cost, by model.
- `SY-4` Activity and Diagnostics: find out why a turn failed an hour ago.
- `SY-5` Create a backup; find where it went. Restore is read in code only and listed for the operator.
- `SY-6` Browser sessions: open one, read its grants, close it.
- `SY-7` Quality and Dashboards: open each tab; a tab with nothing to show says why.

- [ ] **Step 1–3:** Standard steps.

### Task 11: Settings

Journeys:
- `ST-1` Add a provider with a key, pick a default model, send a Chat message with it.
- `ST-2` Change a setting that needs approval: the approval appears in place, one click, applied without a second step.
- `ST-3` Save a provider with no changes; save two settings in a row.
- `ST-4` Local AI: point at a local runtime, see its models, start and stop it.
- `ST-5` Access and auth: see the auth mode, create and revoke a token, pair a device up to the code.
- `ST-6` Permissions, Trust and policy: find out why a tool was blocked and allow it.
- `ST-7` Workspaces and personalities: create, switch, delete.
- `ST-8` Web search and Firecrawl: set a base URL and allowlist, run a search from Chat.
- `ST-9` Every Settings page: open it, change one harmless value, save, reload, value kept.

- [ ] **Step 1–3:** Standard steps.
- [ ] **Step 4 (Review Focus 2):** In a sandbox with no provider configured, then with an invalid test key, then with a default model id that does not exist, open Chat, Work › Schedules, Library › Knowledge and System › Health. For each, record whether the screen names the problem and links to the Settings page that fixes it.

### Task 12: First run and install

Journeys:
- `FR-1` Fresh sandbox with onboarding not done: the first screen, Get started, choose a model, the first task, arrive in Chat. Time it.
- `FR-2` Leave onboarding halfway and come back; skip it; try the demo.
- `FR-3` `pnpm onboarding:tui` in a scratch home: every prompt, a wrong answer at each, quit halfway and rerun.
- `FR-4` Bundled Postgres: first start, start with its port taken (the `28P01` and port-squat cases), and what the operator is told.
- `FR-5` Installer and update paths: code read of `scripts/packaging/` and the desktop host only. Running an installer on this PC is not allowed; the steps go to the operator checklist.

- [ ] **Step 1–3:** Standard steps, with a second testbench started with onboarding not completed.
- [ ] **Step 4 (Review Focus 5):** Build the packaged app with `pnpm package:desktop` (one heavy job; nothing else running). The app opens a visible window, so tell the operator before launching it and wait until they are not in a full-screen game. Use a separate home, app data directory, WebView storage and ports. Check: first launch to usable Chat, a notification click lands on the thing it names, a file picker attaches a file, close and relaunch restores the window and conversation, a second launch does not start a second Gateway. Then run `pnpm verify:desktop` and record its result as evidence, not as a pass for these journeys.

### Task 13: Everywhere: navigation, live updates, auth mode, large data

Journeys:
- `GL-1` Every sidebar entry, every tab in every area, and every command palette entry opens the page its label names. Crawl with a script that records URL, `h1`, document title, console errors, failed requests and horizontal overflow; expected: one `h1` per page, title matches, zero errors.
- `GL-2` Every link out of the Cockpit: list each `?shell=classic` link and each `ClassicOwnerLink` with `git grep`, and say which journey reaches it.
- `GL-3` Keyboard only: reach and operate the primary action of each area; focus is visible; a dialog returns focus on close.
- `GL-4` Live updates: change something in one tab (approve, add a task, save a setting); the other tab shows it without a reload within 10 seconds.
- `GL-5` Idle for two minutes on each area: count requests; more than 12 is a finding.
- `GL-6` Back, Forward and reload on each area keep the operator's place; an unsaved draft is guarded.
- `GL-7` Phone width and light theme on each area's first screen: nothing cut off, nothing unreadable.

- [ ] **Step 1:** Standard code read and live run for `GL-1` to `GL-7`.
- [ ] **Step 2 (Review Focus 3):** Stop the testbench. Start the token-mode sandbox from the Task 1 recipe. Rerun, in order: `CH-1`, `CH-3`, `CH-9`, `IN-1`, `WK-1`, `LB-2`, `SY-1`, `SY-7` (Dashboards), `ST-2`. Any result that differs from the auth-`none` run is a finding naming both results.
- [ ] **Step 3 (Review Focus 4):** In the token-mode sandbox, seed 1,000 conversations, one 300-message thread, 500 memory items and 300 tasks through the Gateway API (use `GOATCITADEL_VERIFY_LONG_LIST_COUNT` where the fixture seeding supports it), and upload one 15 MB attachment. Measure: Chat list open, thread open, scroll to top of the long thread, Library › Memory open, Work board open. Over 1 second to first content or a frozen frame over 200 ms is a `slow` finding with the number.
- [ ] **Step 4:** Check journeys and commit: `docs(review): everywhere journeys, token mode, large data`.

### Task 14: Messaging channels, integrations and the real-model pass

Journeys:
- `MS-1` For each shipped channel: start setup in Chat › Messaging, follow it to the credential step, enter an invalid test credential, read the error, cancel, confirm nothing half-configured is left. Code-read the inbound and reply path.
- `MS-2` A channel marked incomplete or blocked says so before the operator starts.
- `MS-3` Integrations: Google desktop sign-in up to the browser hand-off (do not sign in); a vendor MCP connector up to its credential step.
- `MS-4` With the Claude CLI subscription (`pnpm testbench:claude-cli`, only if `claude` is already signed in; if not, record `not run` and do not sign in): `CH-1`, `CH-2`, `CH-9`, `CH-11`, `CH-13` again with a real model. Record time to first token, time to done, and anything that differed from the stub run. Stop at 30 requests.

- [ ] **Step 1–3:** Standard steps.
- [ ] **Step 4:** Write the operator checklist entries for everything this task could not run: one real message in and out per channel, Google sign-in, a vendor MCP call, with the exact clicks and what a pass looks like.

---

## Phase 3: The report

### Task 15: Root causes and ranking

**Files:**
- Modify: `findings.json`
- Create: `docs/review/2026-11-usability/root-causes.md`

**Interfaces:**
- Produces: `rootCause` on every finding; `root-causes.md` with one section per `RC-nn`: the cause in one sentence, the owning file or service, the finding ids it explains, and the smallest change that would clear them.

- [ ] **Step 1:** Merge duplicates (same defect seen in two journeys becomes one finding listing both). Re-read every `blocker` and `stall` and confirm its evidence still opens.
- [ ] **Step 2:** Group by root cause. A cause that explains one finding is fine; do not force groups.
- [ ] **Step 3:** Rank: severity first, then the number of journeys the finding breaks, then how early in a new operator's first hour it appears.
- [ ] **Step 4:** Have one fresh subagent, given only `findings.json` and the evidence directory, try to refute each `blocker` and `stall` (wrong repro, sandbox artifact, intended behavior per `AGENTS.md`, `DESIGN.md` or `PRODUCT.md`). Downgrade or withdraw what it refutes and list the withdrawn ids with the reason.
- [ ] **Step 5:** Commit: `docs(review): root causes and ranking`.

### Task 16: Write and hand over the report

**Files:**
- Create: `docs/review/2026-11-usability-review.md`

- [ ] **Step 1:** Write the report in this order: (1) the answer in five lines: how many of the journeys pass first time, how many blockers and stalls, the three root causes that matter most; (2) the journey table: every journey id, `PASS` or its finding ids; (3) findings by root cause, most severe first, each with trigger, expected, actual, evidence; (4) the Phase 1 close-out: counts by source and verdict, and the list of earlier findings still open with their new ids; (5) suggested fix batches, one per root cause, sized as small PRs, in the order to do them; this is a suggestion for the next plan, not work done; (6) the operator checklist: every `operator-only` row and every step this review could not run, with exact clicks and what a pass looks like; (7) what was not covered and why; (8) withdrawn and unconfirmed items.
- [ ] **Step 2:** Check the numbers: every count in the report equals a count computed from `findings.json`, `journeys.md` and `prior-register.json` by a script, not by hand. Every journey id from Tasks 6–14 appears in the table.
- [ ] **Step 3:** `pnpm docs:check` and `git diff --check` in the worktree. Expected: both pass; if `docs:check` fails on something outside `docs/review/2026-11-usability*`, record it and do not fix it.
- [ ] **Step 4:** Stop the sandboxes this task started (PID command line confirmed), confirm their ports are free, leave the worktree and evidence in place.
- [ ] **Step 5:** Commit: `docs(review): 2026-11 usability review report`. Tell the operator where the report is, the headline numbers, what was not run, and ask whether they want it published as a private review page like the earlier three.
