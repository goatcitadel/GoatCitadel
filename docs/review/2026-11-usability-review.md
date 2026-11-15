# 2026-11 usability review: does the Cockpit just work?

Review of the Cockpit (Chat with Projects, Inbox, Work, Capabilities, Library, System, Settings), first run and install, and messaging channels and integrations, on `origin/main` at commit `996d052fa`. Review only: no product code was changed. Every count in this report is printed by `docs/review/2026-11-usability/tools/report-numbers.cjs`.

## 1. The answer

- **The everyday path works.** A first message, a follow-up, finding and renaming a conversation, switching workspaces, archiving a task, and approving a tool call in Chat with one click (the turn then carried on by itself with a real model) all worked first time.
- **Of 70 journeys, 9 passed first time, 18 failed, 38 could be run only in part and 5 were read in code only.** A journey fails when any step misses its pass condition, even for friction or polish; 7 of the 18 failures involve a stall. Partial runs mostly stopped where the test setup ran out (no real model in most runs, no OS keychain, no accounts); the parts that did run still produced findings. Nothing blocks a task outright.
- **11 places stall an operator** (they get stuck unless they reload, find a workaround or know something the screen does not say); 103 more add friction and 103 are polish. 8 of the 11 stalls can happen on any default install, 2 need more than one workspace, and 1 was read in code and not reproduced.
- **Two causes matter most; together they carry 6 of the 11 stalls.** (1) Features that ship switched off have no switch on any Settings page, so Library > Memory, `use <skill>` in Chat and Chat access for a hand-registered MCP server cannot be turned on from the app (RC-01: 5 findings, 3 of them stalls). (2) Saving a setting while an earlier change is still waiting for approval says "Settings changed elsewhere" or locks the page and never points to the waiting approval, including a WhatsApp public web address that is forgotten on reload (RC-03: 4 findings, 3 stalls). The largest group by count is not a stall: internal ids, hashes and file paths shown as ordinary text (RC-51: 20 findings, mostly polish; one sweep, batch 31).
- **Earlier reviews:** of 460 findings from earlier reviews, 301 are now fixed and 116 are still open or partly open, after three corrections found during this review; of those 116, 108 live on in 104 of today's findings (some earlier findings describe the same defect and share one) and 8 are no longer findings.

Tested in a throwaway sandbox with a scripted model, no OS keychain and a development build; one real-model pass; the desktop app was not launched (section 7). The other stalls on every install each have their own small cause: when an MCP server fails to connect the reason is hidden unless Settings > Appearance > Technical details is on (U-CP-014); a plugin that added a skill can never be installed again: its uninstall confirmation promises a reinstall, and the approval right after it warns that one is impossible (U-CP-004); and a manual task cannot be marked done in Work because nothing there records a deliverable (U-WK-001). On an install with more than one workspace, Settings changes cannot be approved while another workspace is selected (U-ST-001) and System > Sessions links lead nowhere for other workspaces' conversations (U-SY-009). The desktop app's checks are in section 6.

Contents: [2. Journeys](#2-journey-table) · [3. Findings by root cause](#3-findings-by-root-cause) · [4. Earlier reviews](#4-earlier-reviews-closed-out) · [5. Suggested fix batches](#5-suggested-fix-batches) · [6. Operator checklist](#6-operator-checklist) · [7. Not covered](#7-what-was-not-covered-and-why) · [8. Withdrawn and unconfirmed](#8-withdrawn-and-unconfirmed) · [9. Design decisions](#9-design-decisions-for-you)

## 2. Journey table

A journey is PASS only when it finished first time with no reload, retry or detour the screen did not send you on. PARTLY RUN means part of the journey could not be done in the test setup (each journey's notes say which part); NOT RUN means it was read in code only. "Repeated" shows the result when the same journey was walked again with a real model (the signed-in Claude CLI) or with token sign-in turned on. A PASS can still carry polish or friction findings that did not stop the journey. Finding ids are the current ids in `findings.json`: ids that were later merged or retitled are shown as the id that survived, and withdrawn ones are dropped. The full notes for every journey are in [journeys.md](2026-11-usability/journeys.md).

**Chat**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| CH-1 | First message in an empty install | PASS | Token sign-in: PASS; Real model: PASS | U-CH-024 |
| CH-2 | Follow-up, edit an earlier message, retry an answer, stop a streaming answer | PARTLY RUN | Real model: PASS | U-CH-018, U-CH-025 |
| CH-3 | Attach a text file and an image, ask about them; attach a file that is too large | FAIL | Token sign-in: FAIL | U-CH-020, U-CH-028 |
| CH-4 | Switch model and provider for one conversation; see which model answered | PARTLY RUN |  | U-ST-005, U-CH-021 |
| CH-5 | Find an old conversation, rename it, delete it, and come back to where you were after a reload | PASS |  | U-CH-018 |
| CH-6 | Use the composer's plus menu: web on and off, Review answer, a prompt pack, a variable | PARTLY RUN |  | U-CH-018, U-CH-023 |
| CH-7 | Long answer: scroll up while it streams, scroll position holds, jump to latest | PARTLY RUN |  | U-CH-003 |
| CH-8 | Two tabs on the same conversation: send in one, the other catches up | FAIL |  | U-CH-022 |
| CH-9 | Ask for something that needs a tool: the approval appears in place, one click approves, the turn continues with no "Continue" step and no trip to the Inbox | PARTLY RUN | Token sign-in: PARTLY RUN; Real model: PASS | U-IN-001, U-CH-014, U-CH-041, U-CH-042 |
| CH-10 | Deny an approval; approve after the request expired | PARTLY RUN |  | U-CH-031 |
| CH-11 | A planning or research request: steps, progress, delegation and the final synthesis are readable; a failed step says what failed and what to do | FAIL | Real model: FAIL | U-CH-032, U-CH-033, U-CH-028, U-CH-034 |
| CH-12 | Deep research with documents; a document that is truncated says so | PARTLY RUN |  | U-CH-020, U-CH-035, U-CH-036 |
| CH-13 | Code Mode run from Chat: approval, run, artifact shown, artifact opened | PARTLY RUN | Real model: PARTLY RUN | U-CH-018, U-CH-038, U-CH-043 |
| CH-14 | Use a skill by name (`use <name>`), and a skill that is switched off | FAIL |  | U-CH-044 |
| CH-15 | A browser errand started from Chat, up to its first approval | NOT RUN |  | none |
| CH-16 | Publish a managed project file with the overwrite review | NOT RUN |  | U-CH-018, U-CH-040 |
| Outage check | Gateway stopped and frozen while Chat is open | PARTLY RUN |  | U-CH-026, U-CH-027 |

**Projects**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| PJ-1 | Create a project, add files, start a conversation in it, switch projects | PARTLY RUN |  | U-CH-018, U-PJ-001, U-PJ-006, U-CH-028, U-CH-043, U-PJ-004 |
| PJ-2 | Open, edit and save a project file; leave with unsaved changes | PARTLY RUN |  | U-CH-043, U-PJ-005 |

**Inbox**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| IN-1 | Open the Inbox with pending approvals: read what is asked, approve one, deny one, see the result and where it went | FAIL | Token sign-in: FAIL | U-IN-001, U-IN-008, U-IN-011, U-IN-016, U-IN-010, U-IN-015 |
| IN-2 | An approval with no workspace: is it visible anywhere | PARTLY RUN |  | U-IN-012, U-IN-013 |
| IN-3 | Notification from the Inbox to the thing that raised it, and back | FAIL |  | U-IN-006, U-IN-015, U-IN-014 |

**Work**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| WK-1 | Create a task on the Board, move it, open its run, read its history | FAIL | Token sign-in: FAIL | U-WK-001, U-WK-005, U-WK-015, U-WK-016 |
| WK-2 | Pause, resume, cancel and retry a run; the buttons say what each will do | PARTLY RUN |  | U-WK-004, U-WK-011 |
| WK-3 | Create a schedule, edit it, see when it next runs, see that it ran | FAIL |  | U-WK-012, U-WK-013, U-WK-014, U-WK-010 |
| WK-4 | Archive and restore a task; open the Automation designer and the older Kanban view | PASS |  | U-WK-003, U-WK-010, U-WK-002, U-WK-017 |

**Capabilities**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| CP-1 | Skills: find a skill, switch it on, use it in Chat, switch it off | PARTLY RUN |  | none |
| CP-2 | Import a skill from a folder and from a Git source; an import that collides with an existing id | PARTLY RUN |  | U-CP-004, U-CP-001 |
| CP-3 | Plugins: inspect, install, see what it added, uninstall (including the second uninstall when its skill is on) | FAIL |  | U-CP-004, U-CP-005, U-CP-006 |
| CP-4 | Connectors: add a connector from a template up to the credential step with an invalid test credential; read the error; remove it | PARTLY RUN |  | U-CP-007 |
| CP-5 | MCP: add a static MCP server, see its tools, use one in Chat | PARTLY RUN |  | U-CP-014, U-CP-015, U-CP-013, U-CP-011 |
| CP-6 | Tools: find a tool, read what it can do and what approval it needs, change its permission | PARTLY RUN |  | U-CP-012 |

**Library**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| LB-1 | Memory: see what was remembered and why, edit an item, forget an item, see history | PARTLY RUN |  | U-LB-008, U-LB-002, U-LB-009, U-LB-010, U-LB-011, U-LB-003 |
| LB-2 | Files and artifacts: upload a text file, find an artifact made in Chat, open it | PARTLY RUN | Token sign-in: PARTLY RUN | U-LB-002, U-LB-012 |
| LB-3 | Agents: view profiles and the imported catalog; prompt packs: open, use in Chat | PARTLY RUN |  | U-LB-013, U-LB-014, U-LB-015 |
| LB-4 | Knowledge: add a source, see it used in an answer with its citation | PARTLY RUN |  | U-LB-002, U-LB-016 |

**System**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| SY-1 | Health: is anything wrong right now, and what to do about it | PARTLY RUN | Token sign-in: PARTLY RUN | U-SY-002, U-SY-001 |
| SY-2 | Runtime and Sessions: see what is running, stop something | FAIL |  | U-SY-009, U-SY-010, U-SY-001 |
| SY-3 | Spend: what did today cost, by model | PARTLY RUN |  | none |
| SY-4 | Activity and Diagnostics: find out why a turn failed an hour ago | FAIL |  | U-SY-009, U-SY-016, U-GL-020, U-SY-005, U-SY-015 |
| SY-5 | Create a backup; find where it went | PARTLY RUN |  | U-SY-011 |
| SY-6 | Browser sessions: open one, read its grants, close it | PARTLY RUN |  | U-GL-019, U-SY-014 |
| SY-7 | Quality and Dashboards: open each tab; a tab with nothing to show says why | PARTLY RUN | Token sign-in: PARTLY RUN | U-SY-006, U-SY-013, U-SY-017 |

**Settings**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| ST-1 | Add a provider with a key, pick a default model, send a Chat message with it | PARTLY RUN |  | U-ST-005, U-ST-002, U-ST-022, U-ST-023, U-ST-030, U-ST-029, U-ST-014 |
| ST-2 | Change a setting that needs approval: the approval appears in place, one click, applied without a second step | FAIL | Token sign-in: FAIL | U-ST-001, U-ST-021, U-ST-020 |
| ST-3 | Save a provider with no changes; save two settings in a row | PARTLY RUN |  | U-ST-021 |
| ST-4 | Local AI: point at a local runtime, see its models, start and stop it | PARTLY RUN |  | U-ST-030, U-ST-012 |
| ST-5 | Access and auth: see the auth mode, create and revoke a token, pair a device up to the code | PARTLY RUN |  | U-CH-018 |
| ST-6 | Permissions, Trust and policy: find out why a tool was blocked and allow it | PARTLY RUN |  | U-ST-020, U-ST-025 |
| ST-7 | Workspaces and personalities: create, switch, delete | PASS |  | U-ST-028 |
| ST-8 | Web search and Firecrawl: set a base URL and allowlist, run a search from Chat | PARTLY RUN |  | U-ST-031 |
| ST-9 | Every Settings page: open it, change one harmless value, save, reload, value kept | PARTLY RUN |  | U-ST-023, U-ST-027, U-ST-014 |
| No-provider check | No provider, an invalid key, a missing default model | PARTLY RUN |  | U-ST-030, U-ST-029 |

**First run and install**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| FR-1 | Fresh sandbox with onboarding not done: the first screen, Get started, choose a model, the first task, arrive in Chat | FAIL |  | U-LB-008, U-SY-002, U-FR-004, U-FR-005, U-FR-012, U-FR-014, U-FR-016, U-ST-010, U-ST-029 |
| FR-2 | Leave onboarding halfway and come back; skip it; try the demo | PARTLY RUN |  | U-FR-001, U-CH-018, U-ST-010, U-FR-006, U-FR-013 |
| FR-3 | pnpm onboarding:tui in a scratch home: every prompt, a wrong answer at each, quit halfway and rerun | NOT RUN |  | U-FR-008, U-FR-009 |
| FR-4 | Bundled Postgres: first start, start with its port taken, and what the operator is told | NOT RUN |  | U-FR-015 |
| FR-5 | Installer and update paths: code read of scripts/packaging/ and the desktop host only | NOT RUN |  | U-FR-011 |

**Everywhere**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| GL-1 | Every sidebar entry, every tab in every area, and every command palette entry opens the page its label names | FAIL |  | U-CP-003, U-GL-051, U-SY-001, U-CH-017 |
| GL-2 | Every link out of the Cockpit | PASS |  | none |
| GL-3 | Keyboard only: reach and operate the primary action of each area; focus is visible; a dialog returns focus on close | FAIL |  | U-GL-025, U-GL-046, U-GL-047, U-GL-039, U-GL-048 |
| GL-4 | Live updates: change something in one tab, the other shows it within 10 seconds | PASS |  | none |
| GL-5 | Idle for two minutes on each area: count requests; more than 12 is a finding | FAIL |  | U-GL-050 |
| GL-6 | Back, Forward and reload on each area keep the operator's place; an unsaved draft is guarded | FAIL |  | U-IN-006, U-GL-049 |
| GL-7 | Phone width and light theme on each area's first screen: nothing cut off, nothing unreadable | PASS |  | U-SY-002, U-GL-006, U-CH-048, U-GL-011 |
| GL-T | Sign-in in token mode | FAIL |  | U-CH-020, U-GL-052, U-GL-053, U-IN-010, U-GL-054 |
| GL-L | Large data | PASS |  | U-WK-018 |
| GL-P | Production build: credential box | PASS |  | U-ST-033, U-ST-029 |

**Messaging channels and integrations**

| Journey | What was tried | Result | Repeated | Findings |
|---|---|---|---|---|
| MS-1 | Channel setup to the credential step with an invalid credential | PARTLY RUN |  | U-ST-001, U-MS-005, U-ST-033, U-MS-001, U-MS-002, U-MS-003, U-MS-006, U-MS-007, U-MS-004 |
| MS-2 | A channel marked incomplete or blocked says so before the operator starts | PARTLY RUN |  | none |
| MS-3 | Integrations: Google sign-in and a vendor MCP connector up to their credential step | PARTLY RUN |  | U-CP-013, U-CP-016, U-CP-017, U-CP-018, U-CP-020, U-CP-021, U-CP-011, U-CP-019 |
| MS-4 | Real-model pass: CH-1, CH-2, CH-9, CH-11 and CH-13 with the Claude CLI subscription | PARTLY RUN |  | U-CH-032, U-CH-033, U-CH-045, U-CH-046, U-CH-047, U-CH-049 |

## 3. Findings by root cause

| Area | Stall | Friction | Polish | Total |
|---|---|---|---|---|
| Capabilities | 3 | 13 | 2 | 18 |
| Chat | 1 | 16 | 26 | 43 |
| First run and install | 1 | 12 | 0 | 13 |
| Everywhere | 0 | 12 | 30 | 42 |
| Inbox | 0 | 6 | 8 | 14 |
| Library | 1 | 9 | 6 | 16 |
| Messaging | 1 | 5 | 1 | 7 |
| Projects | 0 | 2 | 2 | 4 |
| Settings | 2 | 12 | 15 | 29 |
| System | 1 | 8 | 5 | 14 |
| Work | 1 | 8 | 8 | 17 |
| **All** | **11** | **103** | **103** | **217** |

Severity: a **stall** means the task can be finished only with a reload, a retry, a workaround or knowledge the screen does not give; **friction** means it finishes with extra steps, a silent wait or a confusing message; **polish** costs nothing but was noticed. "Seen live" means the review saw it in a running sandbox; "read in code only" means it was traced in the source. 'confirmed' means verified, live or by an exact reading of the code; 'likely' means seen only once, or traced in code but not reproduced end to end. The full records (trigger, expected, actual, evidence, owner) for all 217 findings are in [findings.json](2026-11-usability/findings.json) and the root causes in [root-causes.md](2026-11-usability/root-causes.md); this section gives the stalls in full, friction as one line each and polish as a table.

The trigger, expected and actual text below is quoted from `findings.json`, except that the review's step numbers are replaced by the name of the check (for example "the first-run check"). "The stub" is the test sandbox's scripted model.

### 3.1 Causes behind the stalls

#### RC-01

**Cause.** Feature settings that are off by default gate screens and promises that are on screen, and no Settings page can switch them; the gated screen says only that the feature is off.

**Who meets it.** All installs, from the first run (the defaults come from config).

**Smallest change.** Add one Settings > Advanced "Features" section that lists the default-off settings that gate a Cockpit screen (skill instructions in Chat, static MCP in Chat, memory administration, connector diagnostics, scheduler review, engineering learnings), each as a governed switch through the existing settings patch, and make every "turned off" sentence link to its switch. Where a screen promises the gated behaviour (the Skills panel copy, the install approval), say that it needs the switch.

- **U-LB-008** (stall, seen live). On a default install Library > Memory shows only 'This feature is turned off for this installation.' and no screen offers the setting that turns it on
  - Trigger: Fresh install on config defaults (the example config sets memoryLifecycleAdminV1Enabled false and first run copies it). Open Library > Memory.
  - Expected: The page says where to turn memory administration on, or offers a switch.
  - Actual: The full chain, read from the code: the in-code fallback is `memoryLifecycleAdminV1Enabled ?? true` (config.ts:1475), but a fresh install materialises its config from the example, which sets false (config/goatcitadel.example.json:202), so a real fresh install gets false. No onboarding or first-run code sets the flag (git grep over apps/gateway/src and apps/mission-control-next/src finds only read checks and the Settings route schema) and no Settings screen exposes it. With false the Gateway refuses the list read with 409 (requireEnabled, memory-item-pagination-service.ts:21), the shared error mapper turns it into 'This feature is turned off for this installation.' and the page shows that sentence in an error callout (LibraryMemoryWorkspace.tsx:196-201) with the filters and batch buttons still on screen. The flag appears only in read checks (LibraryMemoryBatch, LibraryMemoryDiagnostics, LibraryMemoryEditor, LibraryMemoryProposals), a type and a test fixture. The main review sandbox had the setting on (read-only GET /api/v1/settings), so the page worked there; on a fresh default install (the first-run check, fr-1-nomodel-library-memory.png) it showed the full filter row and, twice (directory and Memory proposals), the red 'This feature is turned off for this installation.' with an 'Open memory diagnostics and maintenance' button, and no way to turn the feature on.
  - Evidence: `docs/review/2026-11-usability/evidence/fr/fr-1-nomodel-library-memory.png`, `apps/gateway/src/services/memory-item-pagination-service.ts:21`, `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryWorkspace.tsx:196`, `packages/mission-control-shared/src/api/describe-api-error.ts:52`, `config/goatcitadel.example.json:202`, `apps/gateway/src/config.ts:1475`, `apps/gateway/src/config.ts:553`, `docs/review/2026-11-usability/evidence/lb/lb-1-memory.png`
- **U-CH-044** (stall, seen live). On a default install, typing 'use <skill>' in Chat does nothing and says nothing, because skill instructions in Chat are off by a setting no screen exposes
  - Trigger: Default install. Send 'use debugging skill to look at this' (an enabled, callable skill), 'use genie-npu-ir20 for this' (enabled, not callable), 'use nosuchskill please', '@skill debugging explain this' (and 'use debugging' in the verification workspace). Then open Capabilities > Skills.
  - Expected: The skill loads and a chip or line says so, or the screen says it cannot load and why, or the switch that enables it is somewhere an operator can reach.
  - Actual: All five turns answered like any other turn: no chip, no message. The skill does not load because the path that loads skill instructions runs only when feature flag chatSkillInstructionsV1Enabled is true (chat-feature-admission-service.ts:171; the `use <name>` reader callable-skill-activation.ts:157 is reached only through that branch). The flag defaults to false (config.ts:1535, feature-flags.ts:57 and :154) and a read-only GET of the sandbox's /api/v1/settings returned features.chatSkillInstructionsV1Enabled = false. No Cockpit screen sets it (git grep finds the flag only in config, Gateway and a shared API type, and the Settings route schema at dashboard.ts:266), and Capabilities > Skills still lists the skill as on and callable, so an operator following the `use <name>` guidance cannot make it work from any screen or learn why. The Gateway trace recorded activated_skill_count 0 for every turn, which is what flag-off produces (chat-turn-runtime-decisions.ts:48). No Chat UI code shows an activated or refused skill either, so even with the flag on there is no chip (git grep). A switched-off skill is dropped silently in the Gateway (chat-skill-selection-runtime.ts:74). Not run live: switching a skill off. Off by default by design (docs/1_0_CONTRACT.md:7), but Capabilities promises the Chat half: SkillPanelSwitch.tsx:13-14 says 'Paused skills are used when you name them in Chat', and the install approval reads 'Lets the AI use <name> in new chats.' (skill-install-view.ts:153). Reading skills from Chat ('skills.read') sits behind another default-off flag.
  - Evidence: `docs/review/2026-11-usability/evidence/ch/ch-14-activation-counts.json`, `docs/review/2026-11-usability/evidence/ch/ch-14-1-answer.png`, `docs/review/2026-11-usability/evidence/ch/ch-14-2-answer.png`, `docs/review/2026-11-usability/evidence/ch/ch-14-3-answer.png`, `docs/review/2026-11-usability/evidence/cp/cp-1-panel.png`, `docs/review/2026-11-usability/evidence/cp/cp-1-paused.png`, `apps/gateway/src/services/callable-skill-activation.ts:157`, `apps/gateway/src/services/chat-skill-selection-runtime.ts:74`, `apps/gateway/src/services/chat-feature-admission-service.ts:171`, `apps/gateway/src/config.ts:1535`, `apps/mission-control-next/src/cockpit/areas/capabilities/skills/SkillPanelSwitch.tsx:13`, `docs/1_0_CONTRACT.md:7`
- **U-CP-015** (stall, seen live). For an MCP server the operator registered by hand, nothing says how to let Chat use it: the screens say 'Ask the runtime operator ... features.chatStaticMcpV1Enabled', and the only Cockpit switch is a pre-ticked box in the template-install panel
  - Trigger: Register an MCP server through Connectors > Add your own > Register MCP server. Open its Connectors panel ('Chat can't use connectors yet. See Chat access in Advanced setup'), follow the link, then Inspect the server in Advanced setup. (An install from a template, such as Airtable, is the other path: its panel shows 'Also let Chat use connectors'; not installed here.)
  - Expected: For a hand-registered server, a switch for Chat access or a pointer to the template-install checkbox / Settings.
  - Actual: Static MCP in Chat defaults to off (chatStaticMcpV1Enabled ?? false, config.ts:1552). The Cockpit does have one way to turn it on: installing a connector from a template shows a pre-ticked 'Also let Chat use connectors' checkbox whenever Chat is blocked for 'mcp_in_chat_off' (ConnectorInstallPanel.tsx:42, :80-89), and the install change plan patches the flag on (connector-install-change-plan-adapter.ts:102, :163-164). A server registered by hand never reaches that panel. Its screens read 'Callable: Static MCP in Chat is disabled for this runtime', 'Ask the runtime operator to enable static MCP in Chat through a reviewed settings change, with resumable runs enabled' and, under 'Runtime operator setting', 'The reviewed settings change uses features.chatStaticMcpV1Enabled. This view does not change runtime settings.' The 'See Chat access in Advanced setup' link lands on the MCP list, which has no such switch (connector-links.ts:11 sends it there and the comment above it says the cockpit has no switch of its own). A git grep of apps/mission-control-next/src and packages/mission-control-shared finds the flag only in a type and in this text. An operator who registers their own server and has never installed a template connector is the runtime operator, is told to ask one, and is not told that installing any template with the box ticked would turn it on for every server. On a desktop install the 'runtime operator' the screens tell the operator to ask is the operator.
  - Evidence: `docs/review/2026-11-usability/evidence/cp/cp-5-inspect.png`, `docs/review/2026-11-usability/evidence/cp/cp-5-panel.png`, `docs/review/2026-11-usability/evidence/cp/cp-4-install-panel.png`, `apps/mission-control-next/src/cockpit/areas/settings/McpSetupProgress.tsx:145`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-links.ts:11`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorInstallPanel.tsx:42`, `apps/gateway/src/services/connector-install-change-plan-adapter.ts:164`, `apps/gateway/src/config.ts:1552`
- U-ST-027 (friction, seen live). Work > Schedules and Library > Knowledge say a feature is 'switched off in runtime settings', but no Settings page can switch it on (scheduler review, engineering learnings, connector diagnostics)
- U-CP-018 (friction, seen live). The integration row says 'choose Manage to run diagnostics', but Manage shows 'Run integration diagnostics' disabled with no way to turn it on

#### RC-02

**Cause.** Settings change plans are created and linked under a hard-coded "default" workspace, so their in-place approval refuses to work while any other workspace is selected.

**Who meets it.** Installs with more than one workspace, while a workspace other than "default" is selected.

**Smallest change.** Settings changes are install-wide: give their plans one install-wide scope that SettingsApprovalDialog accepts from any selected workspace (or pass the selected workspace consistently to creation, link and approval), instead of the literal "default".

- **U-ST-001** (stall, seen live). With any workspace but 'default' selected, a Settings change cannot be approved where it was made
  - Trigger: Select a workspace other than 'default'; Settings › Models › Providers & models; switch 'Keep one Claude Code process between tool steps' off; Save setting.
  - Expected: The approval opens in place and one click approves it.
  - Actual: The dialog shows 'The selected workspace changed. Open this item again in the current Inbox.' with no Approve button, and that workspace's Inbox does not list the approval (it appears only under 'default'). Only when a workspace other than 'default' is selected. Workaround the screen does not state: switch to the default workspace and save again (or approve it in the default workspace's Inbox). The Settings review found seven call sites that hard-code workspaceId="default" (GovernedSettingParts.tsx:117, ApprovalModeControl.tsx:177, FilesystemWriteAccessParts.tsx:71, ProviderConnectionSettings.tsx:344, ProviderRoutingSettings.tsx:247, ManagedRuntimeSettings.tsx:195, GatewayAuthSettings.tsx:101), so every governed Settings save is affected; reproduced identically in token mode (the token sign-in check).
  - Evidence: `docs/review/2026-11-usability/evidence/prior/OL-16-flip1-1.png`, `docs/review/2026-11-usability/evidence/prior/b8-ol16c.json`, `docs/review/2026-11-usability/evidence/prior/b8-ol16-inbox.json`, `docs/review/2026-11-usability/evidence/st/st-2-verif-gov-governed-1.png`, `docs/review/2026-11-usability/evidence/st/st-2-inbox-verification.png`, `apps/mission-control-next/src/cockpit/areas/settings/SettingsApprovalDialog.tsx:52`, `apps/mission-control-next/src/cockpit/areas/settings/GovernedSettingParts.tsx:117`, `apps/mission-control-next/src/cockpit/areas/inbox/ApprovalDecisionBar.tsx:149`

#### RC-03

**Cause.** If you save a setting while an earlier change to it is still waiting for approval, the page says 'changed elsewhere' instead of pointing to the waiting approval; and if a save's answer is lost, the page locks further saves until a reload it never mentions. This is one pattern in three separate save hooks, not one bug: `use-governed-runtime-setting.ts` (U-ST-021, U-MS-005), `use-approval-mode-control.ts` (U-FR-001) and `channel-setup-state.ts` (U-MS-002).

**Who meets it.** All installs.

**Smallest change.** On 409 WRITE_CONFLICT, look up the active plan for the same target and re-open its in-place approval (or say "one change is already waiting" with a link); on a 4xx with a Gateway reason, show the refusal and keep the page usable; after an uncertain outcome, re-read the saved value and lift the lock when it settles, instead of requiring a reload the screen never names.

- **U-ST-021** (stall, seen live). A change waiting for approval vanishes from the Settings page after a reload, and the next save is refused with 'Settings changed elsewhere' or 'Save outcome is uncertain' and no pointer to the waiting approval
  - Trigger: Models: untick 'Keep one Claude Code process between tool steps', Save setting, close the approval dialog without deciding (Escape), then reload the page; tick the box again and Save setting. Same with Safety > Tools approval rule, and with 'Replace API credential' pressed a second time after a reload.
  - Expected: The page shows the change that is still waiting (with its approval one click away), or the refusal says 'one change is already waiting for approval' and links to it.
  - Actual: After the reload the page shows no waiting change. The next save returns 409 WRITE_CONFLICT 'Another active Change Plan already owns this target.' The Models page words it 'Settings changed elsewhere. Your draft is preserved for review.' (nothing changed elsewhere), Safety > Tools words it 'Save outcome is uncertain. Further saves are locked in this app session; inspect Settings activity before continuing.' and Replace API credential says 'Change creation outcome is uncertain. Inspect provider activity...' then, after 'Check outcome', 'GoatCitadel released this change after an error, so it did not run again' while the original plan stays open. The way out is the Inbox, which none of the messages name; the plan lasts about 15 minutes. An earlier review reported a related problem ('unchanged provider save returns 409'); the no-change provider save itself now works: its Review button is simply disabled with no sentence saying why. Cause in the code: use-governed-runtime-setting.ts:122-126 turns any 409 into the page's 'changed elsewhere' sentence without looking up the change that is waiting, so every install is affected.
  - Evidence: `docs/review/2026-11-usability/evidence/st/st-3-closed-dialog.png`, `docs/review/2026-11-usability/evidence/st/st-3-pending-plan-conflict.png`, `docs/review/2026-11-usability/evidence/st/st-3-pending-plan-conflict.json`, `docs/review/2026-11-usability/evidence/st/st-2-approval-rule-after-save.png`, `docs/review/2026-11-usability/evidence/st/st-3-provider-unchanged-dialog.png`, `apps/mission-control-next/src/cockpit/areas/settings/use-provider-connection-editor.ts:157`
- **U-FR-001** (stall, read in code only, likely). After one save with a lost response, the approval rule cannot be saved again, and first-run Finish stays disabled, until the page is reloaded
  - Trigger: In Settings or Get started, save an approval rule and have the request fail after it was sent: a 5xx, a timeout, a 429 or a Gateway restart (use-approval-mode-control.ts:140-185). Then try to save again or press Refresh checks.
  - Expected: An uncertain save is reconciled by re-reading the saved setting, after which saving or finishing works again.
  - Actual: The control shows 'Save outcome is uncertain. Further saves are locked in this app session; inspect Settings activity before continuing.' plus a link to the activity page. Refresh checks does not clear it and Finish waits on 'Resolve the pending or uncertain approval-rule save'. Only a browser reload clears it, and the screen does not say so. The message says 'locked in this app session' but never names a reload as the way out. Not provoked live (the first-run check saw no lock on a fresh install with no lost response).
  - Evidence: `apps/mission-control-next/src/cockpit/areas/settings/approval-mode-state.ts:65`, `apps/mission-control-next/src/cockpit/areas/settings/use-approval-mode-control.ts:168`, `apps/mission-control-next/src/cockpit/areas/settings/use-first-run-setup.ts:104`
- **U-MS-005** (stall, seen live). A public web address awaiting approval is forgotten when the WhatsApp page is left or reloaded; saving again says 'Settings changed elsewhere' with no way to approve
  - Trigger: Chat > Messaging > Add > WhatsApp > type an https address > Save address (the in-place card with Approve once appears) > reload the page (or leave and return) before approving > type the address again > Save address.
  - Expected: The page still shows the pending address change with its Approve once button, or saving again re-opens it.
  - Actual: After the reload the address box is empty, steps 3 to 6 stay 'Locked' and nothing says a change is waiting; the Inbox badge went from 3 to 4. Saving the same address again shows 'Unsaved draft: this address is not in use yet' and 'Settings changed elsewhere. Your draft is preserved for review.' with no approval card. The change can be finished only from the Inbox row 'Set the public web address', which neither screen mentions. Approving it there worked (one click, 'Approved Set the public web address'). Same cause as U-ST-021: PublicWebAddressField.tsx:42-61 uses useGovernedRuntimeSetting, which reports the 409 from the waiting plan as 'changed elsewhere'.
  - Evidence: `docs/review/2026-11-usability/evidence/ms/ms-1-whatsapp-reload-pending.png`, `docs/review/2026-11-usability/evidence/ms/ms-1-whatsapp-second-save.png`, `apps/mission-control-next/src/cockpit/areas/settings/PublicWebAddressField.tsx:59`
- U-MS-002 (friction, seen live). In Advanced channel setup a plainly refused credential save is reported as 'Outcome uncertain' and locks the whole page

#### RC-04

**Cause.** Skills cannot be removed, so uninstalling a plugin leaves its skill behind for good and the skill name blocks any later install, while the first uninstall confirmation promises a reinstall.

**Who meets it.** All installs.

**Smallest change.** Until skill removal exists, change the first confirmation to say a plugin with a skill cannot be installed again, and explain the second "Finish uninstalling" step; the real fix is a governed skill removal that clears the leftover row.

- **U-CP-004** (stall, seen live). The uninstall confirmation promises 'Installing it again adds its pieces back', but a plugin that held a skill can never be installed again
  - Trigger: Capabilities > Plugins > Add from folder (a folder with one skill and one prompt pack) > Check > Install, approve three times. Open the plugin, click Uninstall: the confirmation reads 'This can't be undone here. Installing it again adds its pieces back.' Approve, then Finish uninstalling and approve again. Add the same folder (or another plugin with a skill of the same name) from folder and Check.
  - Expected: Either the plugin installs again, as the confirmation says, or the confirmation says up front that the skill's name is used up for good.
  - Actual: The check of the second install shows 'This skill was removed with an earlier install. It can't come back until skills can be removed.' under the skill and 'So it can't be installed.' under the plugin, with no Install button, although the prompt pack passed. The confirmation promises a reinstall, and the approval dialog that opens right after it warns that one is impossible ('A skill it added can't be installed again until skills can be removed', cp-3-uninstall-dialog-1.png), after the operator has already pressed Uninstall. No screen removes a skill, so there is no way out from the Cockpit. Scope: only a plugin that added a skill. Both approval dialogs carry the warning (plugin-uninstall-change-plan-adapter.ts:186); the confirmation before them, which promises a reinstall, does not.
  - Evidence: `docs/review/2026-11-usability/evidence/cp/cp-3-uninstall-1.png`, `docs/review/2026-11-usability/evidence/cp/cp-3-uninstall-dialog-1.png`, `docs/review/2026-11-usability/evidence/cp/cp-2-collision-check.png`, `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/PluginUninstall.tsx:98`, `apps/gateway/src/services/capability-plugin-inspection-service.ts:74`, `apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts:186`
- U-CP-005 (friction, seen live). After a plugin is uninstalled, its skill stays in Capabilities > Skills for good as 'Removed with <plugin>', counted in the skill total, with a View button and no way to clear it
- U-CP-006 (friction, seen live). After the first uninstall approval the plugin sits at 'Removing...' with both pieces marked Removed and a red 'Finish uninstalling' button that says nothing about why a second step is needed

#### RC-05

**Cause.** Lists that span workspaces (System Sessions and Activity, linked scopes, workspace-less runs) hand off links that carry no workspace, and the receiving page refuses instead of naming the workspace and offering to switch.

**Who meets it.** Installs with more than one workspace; workspace-less runs only from dev fixtures so far.

**Smallest change.** Put the workspace id in every cross-area link and run event, and let the receiving page offer "Switch to <workspace>" when it differs.

- **U-SY-009** (stall, seen live). On an install with more than one workspace, System > Sessions and Activity list every conversation, but Details, 'Open in Chat' and 'Open source' only work in the conversation's own workspace and never say so
  - Trigger: With the default workspace selected, open System > Sessions, press Details on 'Mission Control Next Verification Session 2' (it belongs to the verification workspace), then 'Open in Chat'. Or press 'Open source' on a 'Chat session updated' row in Activity.
  - Expected: Either the session opens, or the screen names the workspace it belongs to and offers to switch.
  - Actual: Details shows a red line 'This control state does not match the selected session and workspace. No control actions are available.' beside a 'Reload control' button that cannot fix it. 'Open in Chat' lands on 'Choose a conversation' with 'No conversations in this view', and the Activity conversation rows do the same. With the verification workspace selected, the same session shows 'You control this conversation' and opens in Chat. The list header says 'Conversations across every channel'; 19 rows show in both workspaces. One more link that drops the workspace (code only, not reproduced live): durable-run realtime events carry only the run id (buildDurableRealtimeOptions, durable-run-service.ts:624-629 sets links: { runId }), so an Activity run row cannot open a run that lives in a non-selected workspace directly; the operator gets 'Run outside this workspace - Choose its workspace or return to Work' (WorkRunDetail.tsx:119) and must switch by hand. A live check was not possible: the run rows in the sandbox Activity belonged to workspace-less approval-wait runs (see Sandbox artifacts in the journeys file). Scope: only installs with more than one workspace meet this; a single-workspace install (the default) does not. The durable-run event sub-claim (durable-run-service.ts:624) is likely (code only); the session rows are confirmed live.
  - Evidence: `docs/review/2026-11-usability/evidence/sy/sy-2-session-details.png`, `docs/review/2026-11-usability/evidence/sy/sy-2-open-in-chat.png`, `docs/review/2026-11-usability/evidence/sy/sy-2-session-details-own-workspace.png`, `docs/review/2026-11-usability/evidence/sy/sy-2-open-in-chat-own-workspace.png`, `docs/review/2026-11-usability/evidence/sy/sy-4-open-source-by-row-kind.json`, `apps/mission-control-next/src/cockpit/areas/chat/SessionControlManager.tsx:211`, `apps/gateway/src/services/durable-run-service.ts:624`, `apps/mission-control-next/src/cockpit/areas/work/WorkRunDetail.tsx:119`
- U-GL-045 (friction, seen live). The linked-scope banner does not say which workspace or Citadel the link asks for and cannot be dismissed
- U-IN-013 (polish, seen live, likely). A dead-lettered run with no workspace is dropped from every Inbox and its Work page says 'Run workspace unknown'

#### RC-06

**Cause.** The only failure reason on some screens is rendered inside TechnicalDetails, which renders nothing unless the Technical details preference is on, and that preference is off in Simple mode, the default.

**Who meets it.** All installs.

**Smallest change.** Show the last error as plain text on the panel; keep only codes and ids inside Technical details.

- **U-CP-014** (stall, seen live). When connecting an MCP server fails, the row says 'open it to see why' but the panel shows no reason unless Settings > Technical details is on, and nothing says so
  - Trigger: Advanced setup > MCP servers > Inspect the server > Review connection > Connect reviewed server, on a host where the connection fails (here the sandbox has no OS keychain: 'OS keychain backend is unavailable on this host'). Then read the Connectors row and open its panel, with the Settings 'Technical details' preference at its default (off).
  - Expected: The panel shows the reason, or says where it is ('turn on Technical details in Settings > Appearance').
  - Actual: The Gateway recorded the cause as the server's last error for any connect failure (reviewedConnectFailure stores the cause's own words, secret-redacted; here 'Reviewed MCP connection did not complete: OS keychain backend is unavailable on this host'). The row reads 'Not working - Stopped working; open it to see why - Try again'. The panel reads only 'Not working. Stopped working. Try again'. The reason is rendered only as 'Last error' inside a Technical details block, which exists only when the Settings > Appearance 'Technical details' checkbox is on; it is off by default (showTechnicalDetails false), and the extra sentence 'The last error is under Technical details.' that points at it is also printed only when the preference is on. With the default, the row's promise cannot be kept and no screen says a preference would show the reason. The cause in this run was the sandbox's missing keychain, but the gap holds for any connect failure. Not re-run with the preference on (Last error not seen live). Separately, after the 500 the inspection said 'MCP connection outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.' and Review connection and Review disconnect were greyed; seen once, after a 500 in the sandbox, cause not isolated. Correction: Technical details is on by default only in Advanced mode (ui-preferences.tsx:80 and :270-285 derive it from the mode); Simple mode, the default, hides the reason.
  - Evidence: `docs/review/2026-11-usability/evidence/cp/cp-5-connected.png`, `docs/review/2026-11-usability/evidence/cp/cp-5-row-after-error.png`, `docs/review/2026-11-usability/evidence/cp/cp-5-error-panel.png`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-view.ts:85`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-view.ts:101`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-view.ts:205`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorPanelParts.tsx:109`, `apps/mission-control-next/src/cockpit/ui/TechnicalDetails.tsx:7`, `apps/mission-control-next/src/cockpit/areas/settings/AppearanceSettings.tsx:116`, `packages/mission-control-shared/src/state/ui-preferences.tsx:80`, `apps/gateway/src/services/mcp-server-admin-service.ts:372`, `apps/gateway/src/services/mcp-server-admin-service.ts:399`

#### RC-07

**Cause.** The Cockpit lacks an action the Classic page had, with no Classic link to reach it. A theme, not one bug: four different missing actions, each its own change.

**Who meets it.** All installs.

**Smallest change.** Add the missing action (deliverable entry, notification feed, skill evaluation runs, Spend link) or a labelled Classic link per DESIGN.md:73.

- **U-WK-001** (stall, seen live). Work cannot record a task deliverable, so a manual task cannot be marked done there
  - Trigger: In Work, open a manual task with no deliverable and try to set it Done.
  - Expected: A way to add a deliverable (as the Classic task page had).
  - Actual: 'Done requires at least one recorded deliverable. The option appears once one is recorded.' with no control to record one. The only way to record one is the Classic shell's task page (CoworkNativePage.tsx:371-390). Runs record their deliverables themselves, so only manual tasks are hit. Confirmed live in the Work review (WK-1).
  - Evidence: `docs/review/2026-11-usability/evidence/wk/wk-1-task-detail.png`, `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:235`, `apps/mission-control-next/src/features/native-routes/cowork/CoworkNativePage.tsx:380`, `apps/mission-control-next/src/cockpit/areas/work/TaskStatusControl.tsx:102`
- U-LB-005 (friction, read in code only, likely). Skill scenario, baseline and improvement runs and the Skill Hub panel from Classic's Library › Skills have no Cockpit screen or Classic link
- U-ST-017 (polish, seen live). The Budgets page has no link to the spend figures it is about
- U-IN-004 (polish, read in code only, likely). Classic's notification feed (read/unread filter and mark unread on runtime signals) has no Cockpit screen

### 3.2 Causes behind friction

**RC-08.** With sign-in off (the desktop default), the Gateway refuses the request that loads Auto mode, so every project conversation shows 'Approval mode unavailable' with a Retry that cannot work. **Who:** Every mode-none install (the packaged desktop default), in conversations that belong to a project. **Change:** Pending the design decision below: either grant `directLocal` to mode-none loopback requests, or have the composer say "Auto mode and Managed files need sign-in (Settings > Access)" with that link instead of "unavailable / Retry".

- U-CH-018 (seen live). In every project conversation the composer shows 'Approval mode unavailable' with a Retry button that can never work when the Gateway is in its default no-login mode

**RC-09.** The Health summary counts "service control unavailable" as a problem although the Gateway can never report it as supported, while it has no check at all for the default model. Two separate changes: U-SY-002 is the Health summary, U-FR-005 is a missing check. **Who:** Every install, on every page (the sidebar status line). **Change:** Show unsupported service control as neutral information that the heading does not count, and add a "Default model" check that reads the guided-setup status.

- U-SY-002 (seen live). On every install, System > Health and the sidebar say '1 check needs attention' / '1 check needs review' because the Gateway always reports service control as unsupported
- U-FR-005 (seen live). Nothing outside Chat and Settings says that no model is configured: System > Health, Work > Schedules and Library > Knowledge are silent, and Chat's model chooser opens empty

**RC-10.** Some screens replace the Gateway's refusal with one fixed sentence, so a size limit or a permission refusal reads like a transient upload failure or a config problem. **Who:** All installs. **Change:** Use describeApiError (it already says "That's too large to send." for 413) and name the limit; map 403 on managed files to the mode-none explanation.

- U-CH-020 (seen live). A file over the 20 MB attachment limit is refused with 'The attachment didn't upload. Select the file again to retry.' and no mention of size
- Polish under this cause (table in 3.3): U-CH-040

**RC-11.** Commit buttons in some dialogs use the default (secondary) variant, or lose the primary style through the change-plan CSS cascade, and a reversible action uses the red danger variant. **Who:** All installs. **Change:** Give the change-plan primary action the accent class outside `chat-change-plan-modal`, set `variant="primary"` on the named commit buttons, and use primary styling for enable/disable per DESIGN.md:58.

- U-ST-005 (seen live). The shared change-plan dialog (Settings and Chat) shows its main action looking the same as Cancel
- U-GL-008 (read in code only). Some confirm buttons look identical to Cancel
- Polish under this cause (table in 3.3): U-ST-006

**RC-12.** When the host has no OS keychain the Gateway says so, but the shared error mapper replaces any 5xx with a generic sentence and the channel setup pages replace any failure with a sentence that blames the key. **Who:** Hosts without a working OS keychain: Docker, headless Linux, Linux without a secret service. A Windows desktop with a working keychain is not affected. **Change:** Map the Gateway codes SECRET_STORE_UNAVAILABLE (503) and the 422 "Secure channel credential storage is unavailable." to one plain sentence with the next step (environment variable, or a host with a keychain), as the WhatsApp page already does, and let the channel hooks show it.

- U-ST-033 (seen live). On a host with no OS keychain (Linux without a secret service, Docker, headless), the provider key dialog says only 'The gateway hit an error. Try again, or check System health.'
- U-MS-001 (seen live). On a host with no secure credential storage (Docker, headless Linux, a store that is unavailable), Telegram, Discord and Slack setup blame the key or token instead of the missing storage

**RC-13.** Some governed switches create their approval and send the operator to the Inbox (or to a separate Continue step) instead of opening the in-place approval dialog the Skills switch and Settings toggles already use. **Who:** All installs. **Change:** Open SettingsApprovalDialog in place from these three callers and apply on approval, as SkillPanelSwitch does; keep the Inbox as the fallback when the dialog is closed.

- U-ST-020 (seen live). Safety > Tools approval rule and filesystem tool access do not approve in place: they send the operator to the Inbox, or ask for a separate 'Continue approved change'
- U-CP-012 (seen live). Switching a tool group back on sends the operator to the Inbox ('Waiting on you in Inbox / Open in Inbox') while a skill switch is approved in place
- U-CP-021 (seen live). Installing a vendor MCP connector (Asana) sends the operator to the Inbox for approval; the panel waits at 'Waiting on Inbox…'

**RC-14.** Approval cards and Inbox rows are titled from the tool's generic action name, without the target the approval is about (command, code, file name and place). **Who:** All installs. **Change:** Build the row and card summary from the tool arguments the approval already stores (command line, code excerpt, file name and folder).

- U-IN-001 (seen live). An Inbox row for a shell approval does not say what it would run
- U-IN-016 (seen live). A 'Run code' row offers a one-click Approve once without describing the code (the generic row sentence itself is U-IN-001)
- U-CH-046 (seen live). A file-creation approval card says only 'Create document / Approval required by policy', with no file name, place or content

**RC-15.** The selected Inbox item lives only in component state. **Who:** All installs. **Change:** Put the item id in the URL.

- U-IN-006 (seen live). The Inbox item you open is not in the URL, so Back, reload and sharing lose it

**RC-16.** "Plan first" returns a fixed engineering template from the Gateway instead of asking the model, and the Delegation card reports the template run as Done with every step Queued. **Who:** All installs. **Change:** Send "Plan first" requests to the model with a planning instruction and render its steps; show the card's state from the steps it lists.

- U-CH-032 (seen live). A finished plan's Delegation card says 'Done' while it counts '0 of 4 steps done' and every step reads 'Queued'
- U-CH-033 (seen live). The plan text runs each step's fields together and shows internal names ('cowork.plan.work.synthesize', 'orch-step-1')
- U-CH-045 (seen live). 'Plan first' with a real model makes no model call and returns a fixed four-step engineering template whatever the request

**RC-17.** Connector and integration rows show the saved or configured state with the word "Connected", which reads as a live connection. **Who:** All installs. **Change:** Group and label by the last connection state ("Saved, never connected"), and keep "Connected" for a confirmed connection.

- U-CP-013 (seen live). The word 'Connected' (amber badge, 'Connected 2' group, 'Connected - not available in Chat') is shown for an MCP server that has never connected; Advanced setup says 'Last connection state: Disconnected'
- U-CP-017 (seen live). A just-saved, switched-off Gmail and Google Calendar connection reads 'Disabled · Configured status: Connected'

**RC-18.** Controls are styled outside the shared Button, Tabs, Callout and token set, so states (current, forced colours, target size, borders) differ from page to page. A sweep: each finding needs its own edit. **Who:** All installs. **Change:** Replace the hand-made controls in the named files with the shared primitives and give the primitives a forced-colours outline, a 24 px minimum target and a distinct current state.

- U-LB-002 (read in code only). Text fields in Library notes, files, mail, journey and knowledge forms have borders too faint to see (1.5 to 1.9 to 1)
- U-GL-001 (seen live). In Windows high-contrast (forced colors) the primary button loses its outline and reads as plain text
- U-GL-006 (seen live). On a phone, the 'Advanced setup' link on Capabilities is only 17 px tall
- Polish under this cause (table in 3.3): U-GL-005, U-GL-013, U-GL-037, U-GL-040, U-CH-005, U-IN-002, U-IN-005, U-WK-002, U-WK-009

**RC-19.** The installer's default "Full installation" includes components that download during install and abort the install if the download fails. **Who:** Windows installer users on the default choice. **Change:** Make the Chromium and Voice runtimes opt-in, or let their download fail without aborting the base install.

- U-FR-011 (read in code only, likely). The installer's default 'Full installation' pre-selects 'Chromium runtime' and 'Voice runtime', which download during install and abort the whole install if they fail (not run)

**RC-20.** The bundled Postgres start reports its cause (port held, wrong password, reserved port) only to the log, and the desktop window shows a generic stopped/degraded screen. **Who:** Desktop installs whose port 45432 is taken or that have a stale database container. **Change:** Pass the start failure's first line and recovery state to the desktop recovery screen, add a port-in-use check before the 180 s wait, and show elapsed time while it waits.

- U-FR-015 (read in code only, likely). A bundled-database start that fails (port taken, a leftover container with another password) ends on 'Runtime is stopped or degraded' and a log path in the desktop window; the cause is only in the log

**RC-21.** Links and routes point at pages the release scope hides or no longer has, so they open "unavailable" or "Page not found"; a held-back page opens with no label. **Who:** All installs. **Change:** Remove or retarget the links to hidden pages, redirect the old Cowork route, and label held-back pages as held back.

- U-FR-002 (seen live). The 'Access' link in Diagnostics' Ecosystem proof lanes opens a 'Settings destination unavailable' page
- U-CP-003 (seen live). 'Change this workspace's skills' and 'Change workspace capabilities' open a page that says it is unavailable
- Polish under this cause (table in 3.3): U-SY-001, U-CH-017, U-ST-018

**RC-22.** The guided model setup drops the Gateway's warning from a connection check and recomputes readiness from stale check times, so a failed check looks like no check and the status flips between loads. **Who:** All installs that use LM Studio or llama.cpp, and every install for the alternating status. **Change:** Return the warning from the check and render it next to the button on every guided surface; derive Ready/Not verified from the last check result, not from its age alone.

- U-FR-004 (seen live). 'Check connection' for LM Studio or llama.cpp says nothing when the server is not running: no error, status stays 'Not verified'
- U-ST-023 (seen live, likely). Guided model setup alternates between 'Done / Ready' and 'Not verified - the last check is stale' on consecutive page loads with nothing changed

**RC-23.** A Chat turn that fails because no provider is configured or the provider cannot be reached offers Reload or Retry, and the link to model setup is shown only for sign-in and billing failures. **Who:** All installs; every fresh install meets the first-send case. **Change:** Add the provider-missing and provider-unreachable classes to the "Open model providers" link, name the provider in the sentence, and drop "Reload conversation" where it cannot help.

- U-FR-012 (seen live). A fresh install says 'You can chat now' above a first-send failure ('no provider is configured') whose only button, 'Reload conversation', changes nothing
- U-ST-030 (seen live). When the default provider cannot be reached, Chat says 'The connection dropped. Check the gateway or network connection' with no 'Open model providers' link, and System > Health has no model check

**RC-24.** The Cockpit has no first-visit redirect to guided setup; only the Classic shell has one. **Who:** Every fresh install. **Change:** Port the Classic first-destination guard: while onboarding is not complete and no model is confirmed, open Settings > Get started on the first visit.

- U-FR-014 (seen live). The Cockpit opens a bare installation on model-less Chat; only the Classic shell redirects a first visit to guided setup

**RC-25.** Get started shows the "Saved model defaults changed" notice when the selection differs from the saved defaults, which is always true on a fresh install, and the safety step names an option it never explains. **Who:** Every fresh install. **Change:** Show the notice only when the saved defaults changed after the page loaded; give "Skip normal prompts" one sentence of description.

- U-FR-016 (seen live). On a fresh install Get started shows 'Saved model defaults changed. Your selection is kept...' although the operator changed nothing, and an amber 'Skip normal prompts is unavailable here' line with no explanation

**RC-26.** Model setup exists as separate flows (Get started, Guided model setup on Providers & models, and Advanced provider configuration) with their own step names, state and completion rules. **Who:** All installs. **Change:** Make Get started the one setup: Chat's "Configure models" and the launch URL open it, Providers & models shows its status instead of a second step list, and the advanced choosers stay collapsed under it.

- U-ST-010 (seen live). Models shows two different step lists for the same setup, with different names and states
- U-FR-013 (seen live, likely). Chat's 'Configure models' and 'Return to setup' open two different setups, and the model-only one never marks setup done (beyond U-ST-010)
- U-ST-002 (seen live). Advanced provider configuration offers three more provider choosers under the guided setup's own provider picker

**RC-27.** The demo preparation reports a skipped step by its feature-setting name, opens a different chat than the one it lists, and switches the workspace without saying so. **Who:** All installs. **Change:** Say "Memory examples were skipped: memory administration is off" with the switch link, open the listed demo chat, and say that the demo has its own workspace.

- U-FR-006 (seen live). 'Try the demo' ends as 'Partly prepared' with a raw flag name, 'Open recorded demo' opens an empty chat, and the demo switches the workspace

**RC-28.** Some controls announce less than they show: hints only in title tooltips or hover, help text not tied to its field, a suggestion list without combobox roles, and no announcement on area change. **Who:** All installs. **Change:** Use the shared tooltip and Field (aria-describedby) primitives, give the composer suggestions combobox roles, and announce the new page title on area change.

- U-GL-025 (seen live, likely). Switching area by keyboard or sidebar gives a screen-reader user no sign that the page changed
- Polish under this cause (table in 3.3): U-GL-016, U-GL-043, U-CH-004, U-ST-007

**RC-29.** On a phone or tablet the page never shows which workspace you are acting in. **Who:** All installs. **Change:** Show the workspace name in the phone header.

- U-GL-027 (seen live). On a phone or tablet the page never shows which workspace you are acting in

**RC-30.** Operator copy bypasses the DESIGN.md glossary and the shared status presenters, so internal words and several names for one thing reach the screen. A sweep: each finding needs its own edit. **Who:** All installs. **Change:** Route the listed strings through the presenters and glossary words; one sweep of the files these findings name.

- U-GL-034 (seen live). Internal words (durable run, projection, canonical, replay, authority) still appear as ordinary text on System and Library pages
- Polish under this cause (table in 3.3): U-GL-004, U-GL-022, U-GL-023, U-GL-036, U-ST-003, U-ST-009, U-ST-016, U-WK-006, U-WK-016, U-MS-004

**RC-31.** Chat's three columns (conversation list, transcript, inspector) have fixed widths that do not give way at 1024 to 1440 px, and the sticky prompt bar overlaps the transcript. **Who:** All installs. **Change:** Collapse the conversation list below 1280 px, let the inspector tab strip scroll or wrap, and reserve the sticky bar's height at the top of the transcript.

- U-CH-002 (seen live). At 1024px wide the Chat transcript is squeezed to about 536px by the side navigation and the conversations rail
- Polish under this cause (table in 3.3): U-CH-028, U-CH-048, U-CH-001

**RC-32.** The build editor hides its first action inside a collapsed disclosure, shows a failed worktree creation as raw JSON, and does not state the scope of Revert all. **Who:** All installs. **Change:** Show Create worktree beside the "Create a worktree to begin editing" line, map the failure to a sentence (no git, not a repository), and put the file count in the Revert all confirmation.

- U-CH-012 (read in code only, likely). Revert-all in the build editor does not say how many files go or that it cannot be undone
- U-CH-038 (seen live). The build editor says 'Create a worktree to begin editing' but the Create worktree button is hidden inside a collapsed 'Repo actions and checks' disclosure

**RC-33.** Safe, reversible changes made through a change plan still need a card, a second review dialog and an explicit apply, and nothing marks the pending choice as not yet active. **Who:** All installs. **Change:** For safe, secret-free plans, apply on the first confirmation and show the result in place; label a pending choice "not applied yet" on the chip.

- U-CH-021 (seen live). Choosing a different effort for one conversation takes three steps and a card with 'Exact revision 1', and a message sent in between silently uses the old setting
- U-ST-022 (seen live). Adding a provider profile takes two confirmations and then a 'needs your attention - manual required' card, although the profile holds no secret

**RC-34.** A Stop that arrives as the turn completes is treated as a provider failure. **Who:** All installs. **Change:** Treat a stop after completion as a no-op and keep the answer.

- U-CH-025 (seen live, likely). Stop pressed just as an answer finishes shows 'provider request failed' and a reload banner, though the answer is complete

**RC-35.** The webhook destination kind asks for an existing keychain reference, and no screen creates one. **Who:** All installs. **Change:** Take the webhook URL through the secure-input flow that provider keys use and store the reference for the operator, or explain the reference format and where to create it.

- U-ST-008 (seen live). A webhook notification destination cannot be completed from the screen: it needs a keychain reference that nothing in the app creates (the Configured channel destination works)

**RC-36.** The Inbox recovery dialog tells the operator to review the run but shows no run, attempts or effects. **Who:** All installs. **Change:** Show the run, attempts and recorded effects in the recovery dialog, or link the run.

- U-IN-003 (read in code only, likely). The Inbox recovery dialog tells the operator to review the run but shows no run, attempts or effects

**RC-37.** After a decision the list marks the next row 'Selected' while the side panel still shows the item just decided. **Who:** All installs. **Change:** After a decision, show the next item in the panel or clear the selection.

- U-IN-008 (seen live). After a decision the list marks the next row 'Selected' while the side panel still shows the item just decided

**RC-38.** An expired approval is still projected as waiting (Inbox count and badge) and its Chat card keeps dead buttons with no next step. **Who:** All installs. **Change:** Exclude expired plans and approvals from the waiting count, and give the expired card one "Ask again" or "Retry the turn" action.

- U-IN-011 (seen live). An expired change plan counts as '1 decision waiting' and lights the Inbox badge, although nothing can be decided
- Polish under this cause (table in 3.3): U-CH-031

**RC-39.** The Cockpit has no shared rule for where keyboard focus goes after a page loads, a button disables itself while it works, or a dialog or inline editor closes. **Who:** All installs. **Change:** Keep Refresh focusable while busy (aria-disabled instead of disabled), return focus to the opener on every dialog and inline-editor close, and stop the tab strip's scrollIntoView from moving the sequential focus start.

- U-GL-046 (seen live). After a page loads or reloads, the first Tab starts at the current tab, so the page's own buttons above it are skipped (Work's 'New task' is 54 Tab presses away)
- U-GL-047 (seen live). Keyboard focus is dropped to the page body after Refresh on Inbox and System and after approving a Settings change, so the next Tab starts from the top again
- Polish under this cause (table in 3.3): U-GL-039, U-GL-048

**RC-40.** Scroll restore records the position after the next page has already clamped the shared scroll container. **Who:** All installs. **Change:** Save the scroll position before navigation starts.

- U-GL-049 (seen live). Back from a task or run to the Work board or History does not return to where you were scrolled

**RC-41.** Attached text documents are cut to 1,600 characters for the turn and nothing records or shows the cut. **Who:** All installs. **Change:** Show "Read the first N characters of <file>" in the turn and raise or explain the limit.

- U-CH-035 (seen live, likely). A long text document attached to a message is cut to its first 1,600 characters with no word on screen about it

**RC-42.** Between approval and the effect receipt the Gateway marks the tool run "outcome uncertain" and the card prints that internal state. **Who:** All installs. **Change:** Show "Running after approval" until the receipt arrives; keep "uncertain" for a real timeout.

- U-CH-047 (seen live). Right after an approval the turn says 'Outcome uncertain. Check before retrying.' in internal words, then ends Done 19 seconds later

**RC-43.** The document tool always writes the title and a blank line at the top of a plain-text file. **Who:** All installs. **Change:** Write only the body for .txt when the request gives exact content (or drop the title line for txt).

- U-CH-049 (seen live, likely). A .txt file Chat creates always starts with its title and a blank line, so 'a file containing the single word hello' comes out as 32 bytes

**RC-44.** The project path check accepts a Windows drive path while refusing "/x" and "../x", and its refusal is worded in schema terms. **Who:** Windows installs for the drive-path case; all installs for the copy. **Change:** Reject drive-letter and UNC paths in the same rule, and word the refusal with an example of an accepted path. The path-safety question (whether a stored drive path resolves outside the workspace root) is flagged for a security look.

- U-PJ-001 (seen live). The New project form asks for a 'Workspace path' with no example, and a rejected path says 'workspacePath must be relative and jailed'
- U-PJ-006 (seen live). A project path like C:/folder is accepted although the form says paths must stay inside the workspace

**RC-45.** A plugin check failure reaches the screen as a canned line; the Gateway's specific reason (blocker code, repeated id) is dropped or left in Technical details. **Who:** All installs. **Change:** Have the Gateway attach a plain sentence per blocker (with the repeated id) and render it under the piece.

- U-CP-001 (seen live). A plugin skill that fails its check says only that it failed, not why or what to fix
- U-CP-002 (seen live). A plugin with a repeated piece id is refused without saying which id

**RC-46.** An "open" action lands at the top of a long page and does not scroll to or focus what it opened. **Who:** All installs. **Change:** Link to the field's anchor and scroll it into view with focus.

- U-CP-007 (seen live). 'Set up Brave Search' opens Advanced setup at the top of Web & Search, on the Firecrawl settings; the Brave key field is a page and a half further down and nothing scrolls or focuses it
- U-LB-013 (seen live). 'Open <agent>' in Library > Agents shows nothing in view: the editor opens below the whole profile list, about 1400 px down, with no scroll or focus move

**RC-47.** A policy block reaches Chat without the rule that blocked it, and the Trust and policy page lists only skills as blocked. **Who:** All installs. **Change:** Carry the matched rule id and its page into the block event and link it.

- U-ST-025 (read in code only, likely). A blocked tool names no rule and links nowhere: 'Blocked by policy or runtime guard' in Chat, a 'tool was blocked' card with no Settings link, and a Trust and policy page whose Blocked rows are only skills

**RC-48.** The Firecrawl page computes its own allowlist verdict instead of asking the Gateway, and offers no way to edit the allowlist. **Who:** All installs. **Change:** Use the Gateway's verdict and add a link (or button) to the allowlist entry.

- U-ST-031 (seen live). The Firecrawl page's own allowlist check can disagree with the Gateway's, and then it shows 'Not allowlisted' with no add button and no link to where the allowlist is

**RC-49.** A memory item's 'Memory provenance' shows only dates, expiry and namespace; why it was remembered (source, conversation, origin) is not on screen. **Who:** All installs. **Change:** Show the source conversation, origin and the reason recorded with the item.

- U-LB-009 (seen live). A memory item's 'Memory provenance' shows only dates, expiry and namespace; why it was remembered (source, conversation, origin) is not on screen

**RC-50.** Editing or forgetting a memory item stacks a review dialog, an approval request dialog and the danger review. **Who:** All installs. **Change:** Open the danger approval directly from the edit review, in one dialog.

- U-LB-010 (seen live). Editing a memory item takes four clicks through three stacked dialogs: Review memory changes, Request edit approval, Review danger approval, Approve once

**RC-51.** Ids, hashes, revisions, raw setting names, absolute paths and raw JSON are printed as ordinary text, which DESIGN.md:71 confines to TechnicalDetails. A sweep: each finding needs its own edit. **Who:** All installs. **Change:** Move each value into TechnicalDetails or replace it with its name (workspace, skill, model, actor), and lower the ratchet to zero for the files listed.

- U-LB-011 (seen live). The approval to forget a memory item names it only by raw id ('Subject Id: mem_5e38..., Subject Kind: memory_item'), and the Inbox card is titled 'Review memory lifecycle' for both edit and forget
- U-CH-022 (seen live). Sending from a second tab while the first tab's turn runs shows a banner with the raw session id and 'agent-send/stream', and a card saying the response was interrupted
- Polish under this cause (table in 3.3): U-CH-043, U-CP-011, U-GL-007, U-GL-019, U-GL-032, U-GL-033, U-CH-013, U-ST-012, U-ST-013, U-ST-015, U-PJ-004, U-ST-028, U-LB-001, U-LB-015, U-SY-015, U-WK-017, U-CP-019, U-IN-012

**RC-52.** 'Upload text file' has no file chooser: the operator types a path and pastes the file's text into a box. **Who:** All installs. **Change:** Add a file chooser that reads the file in the browser and fills the form.

- U-LB-012 (seen live). 'Upload text file' has no file chooser: the operator types a path and pastes the file's text into a box

**RC-53.** Some pages do not follow the DESIGN.md page anatomy (one header with one Refresh, at most one line of description, one empty state that says what will appear). A sweep: each finding needs its own edit. **Who:** All installs. **Change:** Fold section Refresh buttons and stacked caveats into the header, and give each empty list one EmptyState that says how items appear.

- U-LB-014 (seen live). An empty 'Imported catalog' shows a heading, a closed 'Import agent catalog' and a search box, with no 'nothing imported yet' message
- U-SY-006 (seen live). System > Quality opens with four stacked server-written caveats in developer words, on every tab
- Polish under this cause (table in 3.3): U-GL-020, U-ST-014, U-LB-004, U-LB-006, U-LB-007, U-SY-014

**RC-54.** Library > Knowledge has no list of ingested sources. **Who:** All installs. **Change:** List ingested sources with their date and status.

- U-LB-016 (seen live). After a knowledge source is ingested, Library > Knowledge lists no sources: the only proof it was stored is the receipt line inside the approval dialog

**RC-55.** The board editor's 'Preview live widgets' does not show the layout you are arranging. **Who:** All installs. **Change:** Render the preview from the unsaved layout.

- U-SY-003 (seen live). The board editor's 'Preview live widgets' does not show the layout you are arranging

**RC-56.** System pages render a failed load with the empty-state component. **Who:** All installs. **Change:** Use the error Callout with a Retry for failed loads.

- U-SY-004 (seen live). A failed load on System pages looks like an empty page: no error tone, icon or alert announcement

**RC-57.** The "Close session" button only closes the details panel. **Who:** All installs. **Change:** Rename it "Close details".

- U-SY-010 (seen live). The 'Close session' button on System > Sessions only hides the details panel; it does not close or stop anything

**RC-58.** The backup receipt is the only place that names the backup location, and it disappears. **Who:** All installs. **Change:** Show the latest backup path and time on the Health backup card.

- U-SY-011 (seen live). After 'Back up now' nothing on screen says where the backup was written once the receipt is gone

**RC-59.** A result shown as "unavailable" carries no reason and no next step. **Who:** All installs. **Change:** Pass the Gateway's reason (no reviewer model, nothing run yet) into the label and add the next step.

- U-SY-013 (seen live). System > Quality > Evaluations says 'Model evaluations: unavailable. No results are available for this source.' with no reason and no next step
- Polish under this cause (table in 3.3): U-CH-023

**RC-60.** System > Activity reads one page of 100 retained signals and never follows the cursor it receives. **Who:** All installs. **Change:** Add "Load older" with the cursor and count the rows actually shown.

- U-SY-016 (seen live). System > Activity cannot reach anything older than its newest 100 signals, and does not say where older history is
- Polish under this cause (table in 3.3): U-SY-005

**RC-61.** The Work board mixes tasks and runs in run-status lanes and counts only the loaded page. **Who:** All installs. **Change:** Separate task lanes from run lanes and show the Gateway's total in lane headers.

- U-WK-003 (seen live). The Work board still puts tasks and runs in the same run-status lanes, so a task's lane does not match its own state
- Polish under this cause (table in 3.3): U-WK-018

**RC-62.** A run page still ends in a stack of evidence panels, with the recorded errors list at the bottom. **Who:** All installs. **Change:** Lead the run page with what it is waiting on; move evidence panels below and do not list an approval wait as an error.

- U-WK-004 (seen live). A run page still ends in a stack of evidence panels, with the recorded errors list at the bottom

**RC-63.** Tasks created by Chat delegation record the run as `agenticContext.runId` only, and the task page links a run only through `durableRunId`. **Who:** All installs, every Chat-delegated task. **Change:** Set `durableRunId` on delegation tasks, or let the task page link `runId`.

- U-WK-005 (seen live). A task page can say 'Review its run' without giving a link to that run

**RC-64.** The run page does not refetch after Pause. **Who:** All installs. **Change:** Invalidate the run query on Pause and Resume.

- U-WK-011 (seen live). After Pause the run page shows no Resume button until the operator presses Refresh

**RC-65.** The schedule summary formats next run times coarsely and shows "Not reported" when the Gateway omits the next time for daily and weekly schedules. **Who:** All installs. **Change:** Compute and show the next fire time for every enabled schedule, and use TimeText with minutes for times within the hour.

- U-WK-012 (seen live, likely). 'Next run' reads 'just now' for a time up to a minute away, and 'Next run: 23 minutes ago' for an enabled hourly schedule
- U-WK-013 (seen live, likely). Enabled daily and weekly schedules show 'Next run: Not reported', so the operator cannot see when they will fire

**RC-66.** A Task schedule adds its task to the default workspace, whichever workspace created the schedule (cause not isolated in code). **Who:** All installs. **Change:** Store the creating workspace on the schedule and create the task there.

- U-WK-014 (seen live). A 'Task' schedule says it succeeded, but the task it adds appears only in the Default workspace

**RC-67.** History titles runs from the workflow kind, not from the task or conversation they ran for. **Who:** All installs. **Change:** Title runs from their linked task or conversation.

- U-WK-015 (seen live). Work > History lists dozens of runs titled only 'Workflow run' or 'Chat turn', with nothing to tell them apart

**RC-68.** The integration add flow starts from a full platform catalogue and leaves the Google sign-in several steps and two screens away from "Set up". **Who:** All installs. **Change:** Filter platform entries to the host OS and have "Set up" on Gmail and Calendar open the add form for that integration directly.

- U-CP-016 (seen live). 'Set up' on Gmail and Google Calendar ends on an empty 'Saved integrations' list; reaching Connect Google takes about eight more steps in three places
- U-CP-020 (seen live, likely). 'Add integration connection' offers macOS, iOS, Android, Windows and Linux platform entries, with Apple Notes preselected, on a Windows PC

**RC-69.** Every 'Start guided setup' in Advanced channel setup saves another draft, and the Drafts list shows identical rows with no time. **Who:** All installs. **Change:** Reuse an open draft for the same channel and show each draft's creation time.

- U-MS-003 (seen live). Every 'Start guided setup' in Advanced channel setup saves another draft, and the Drafts list shows identical rows with no time

**RC-70.** Channel setup marks the sender allowlist step complete when it is empty, and the only way to learn one's own sender id is a dropped message read from Diagnostics. **Who:** Installs that set up a messaging channel. **Change:** Mark the step incomplete while the list is empty, and show "Message from <id> was dropped: allow it?" in the channel page when it happens.

- U-MS-006 (seen live). Channel setup marks 'Who may message this bot?' and 'Receive messages' Complete before anything is entered, while an empty sender list blocks every inbound message
- U-MS-007 (seen live, likely). To learn their own sender id on the ten channels without a guided page, the operator must message the bot, which drops the message silently, then dig it out of System > Diagnostics

**RC-71.** Chat's outage banner and approval card are not tied to the connection probe, so the banner outlives the outage and the card offers live buttons during it. **Who:** All installs. **Change:** Clear the banner when the probe succeeds and disable decision buttons while the probe says the Gateway is unreachable.

- U-CH-026 (seen live). After the Gateway comes back the red 'Can't reach the GoatCitadel gateway' banner stays until 'Reload conversation' is pressed
- Polish under this cause (table in 3.3): U-CH-027

**RC-72.** The terminal onboarding wizard writes provider settings before saving the key and treats Ctrl+C as a crash. **Who:** Installs set up with `pnpm onboarding:tui` (not the desktop path). **Change:** Save the key first and write settings only after it succeeds; catch the prompt library's cancel error and exit quietly.

- U-FR-008 (read in code only, likely). Quitting the terminal wizard with Ctrl+C prints 'Onboarding wizard failed.' and a stack trace and exits with code 1 (not run live)
- U-FR-009 (read in code only, likely). The terminal wizard applies provider settings first and saves the key second: a failed key save reports 'wizard failed' after the settings were written, and setup is marked complete with no key

**RC-73.** The token sign-in form is not a form: Enter does nothing, a refused token is reported as "access changed", and its tick box and heading are styled outside the shared primitives. **Who:** Token-mode installs (Docker, and any install that turned sign-in on). **Change:** Wrap the fields in a form with the Connect button as submit, map a 401 on first sign-in to "That token was refused", and use the shared checkbox and heading spacing.

- U-GL-052 (seen live). Pressing Enter in the Gateway token box on the sign-in page does nothing; only the Connect to gateway button signs in
- U-GL-053 (seen live). Typing a wrong token on the sign-in page empties the box and says 'Gateway access changed', not that the token was refused; the same refusal on an open page does say 'rejected'
- Polish under this cause (table in 3.3): U-GL-054

### 3.3 Polish

Causes that explain only polish findings:

- RC-74: The secure-input change handler reads the event inside a state updater, which throws when React runs the updater late (development build).
- RC-75: The panel for a Danger shell approval shows a 'Safe' badge next to 'Run Command: with 2 arguments'.
- RC-76: The danger approval review repeats what the card or panel already shows, and the Inbox adds a row-selection click before it.
- RC-77: Reversible actions (pause, resume, archive, restore, switching an integration) each open a review dialog.
- RC-78: New conversation creates and saves an empty conversation at once and remounts the composer, so empty "New chat" rows pile up and early keystrokes can be lost.
- RC-79: Heading and body sizes do not follow the DESIGN.md type scale: most copy is 12 to 13 px and heading levels do not match their sizes.
- RC-80: The document title and page headings come from the area, not the tab, conversation or run that is open.
- RC-81: The sheet, inspector and dialog runtimes do not handle stacking and persistence: sheet headers scroll away, nested dialogs do not dim, and inspector width is not kept.
- RC-82: A failed command palette search says 'Try again' but has no Retry button.
- RC-83: Cockpit Chat still renders the Classic controller frame and Classic blocks (error rows, loading tiles, Save as skill block).
- RC-84: Jump to latest counts new messages but does not say or jump to a decision waiting for you.
- RC-85: Route preflight keeps an entry for every draft ever typed and resets its displayed result on every keystroke.
- RC-86: A finished streamed answer may remount its already-rendered blocks when streaming ends.
- RC-87: An optional background question has no Skip button.
- RC-88: Chat transcript actions decide per place whether to confirm, so Reload and Retry ask in some places and not in others.
- RC-89: The gear menu's accessible name promises an account entry the menu does not have.
- RC-90: 'Open approval' and 'Open in Inbox' on an Inbox row open the same Inbox again.
- RC-91: After a message with an attached file is sent, the transcript still says 'Attached <file> for the next turn.'.
- RC-92: After 'Keep draft and close' nothing on the project page says an unsaved draft exists.
- RC-93: Memory search needs an 'Apply memory filter' click while every other Library list filters as you type.
- RC-94: The Design quality checks look for source files relative to the Gateway process root.
- RC-95: Several panels poll their own reads instead of sharing one query, so idle pages repeat the same request.

| ID | Area | Title | Cause | How known |
|---|---|---|---|---|
| U-ST-029 | Settings | Typing a character into the API credential box crashes the page on the development build; not reproduced on a production build (0 of 5 loads; a 20-character entry and submit completed) | RC-74 | seen live, likely |
| U-CH-028 | Chat | The sticky 'You asked' bar covers the top line of the transcript | RC-31 | seen live |
| U-CH-043 | Chat | When Create worktree fails, the build editor shows raw JSON with a git command and a server folder path | RC-51 | seen live, likely |
| U-IN-010 | Inbox | The panel for a Danger shell approval shows a 'Safe' badge next to 'Run Command: with 2 arguments' | RC-75 | seen live |
| U-IN-015 | Inbox | A danger approval in the Inbox needs a row-selection click before the documented two-step review | RC-76 | seen live |
| U-CP-011 | Capabilities | After 'Register reviewed MCP server' the dialog stays open on the template list and prints 'Saved server ID: e5b16f2f-...' as plain visible text | RC-51 | seen live |
| U-WK-010 | Work | Pausing or resuming a schedule, and archiving or restoring a task, each need a review dialog | RC-77 | seen live |
| U-CH-024 | Chat | In a workspace with no conversations the main pane says 'Choose a conversation' although the list is empty | RC-78 | seen live |
| U-CH-048 | Chat | At 1024 px wide the Chat inspector's tab strip is cut off mid-word at 'Conversat' | RC-31 | seen live |
| U-GL-004 | Everywhere | Classic is still called four different things in the Cockpit | RC-30 | read in code only |
| U-GL-005 | Everywhere | The current page in the sidebar looks the same as a hovered one | RC-18 | seen live |
| U-GL-007 | Everywhere | The fallback label maker lowercases acronyms ('Mesh mcp server', 'Url') | RC-51 | read in code only |
| U-GL-011 | Everywhere | Almost all body and safety copy is 12 or 13 px | RC-79 | seen live |
| U-GL-012 | Everywhere | Heading sizes still do not follow their levels (Settings h3 larger than h2; Chat h1 smaller than page h2s elsewhere) | RC-79 | seen live |
| U-GL-013 | Everywhere | Many errors are still bare red text with role=alert instead of the shared Callout | RC-18 | read in code only |
| U-GL-016 | Everywhere | Icon-button hints are native title tooltips that never show on touch or keyboard | RC-28 | read in code only |
| U-GL-019 | Everywhere | System > Browser sessions prints the raw actor id as visible text in grants and grant reviews | RC-51 | read in code only, likely |
| U-GL-020 | Everywhere | System > Activity opens with three lines of caveats before the list | RC-53 | seen live |
| U-GL-022 | Everywhere | The sidebar scope name shows 'Reading Citadel...' with three dots while loading | RC-30 | read in code only |
| U-GL-023 | Everywhere | The word 'Updates' labels the live connection, an Inbox group and app updates | RC-30 | read in code only |
| U-GL-024 | Everywhere | The browser tab title never names the open conversation or run | RC-80 | seen live |
| U-GL-029 | Everywhere | In a long phone sheet the title and close button scroll out of view | RC-81 | read in code only, likely |
| U-GL-030 | Everywhere | The inspector width resets on reload, is capped at 480 px and the resize grip is invisible until hovered | RC-81 | read in code only, likely |
| U-GL-031 | Everywhere | Choosing 'New chat' in the palette waits several round trips and ends with 'independently verified' wording | RC-78 | read in code only, likely |
| U-GL-032 | Everywhere | Some Work labels (scheduler trigger and profile, automation validation, approval kind) are raw tokens with underscores stripped instead of named states | RC-51 | read in code only, likely |
| U-GL-033 | Everywhere | A browser-session grant is titled by its raw actor id, and Chat and Spend rows show the raw model id | RC-51 | seen live, likely |
| U-GL-035 | Everywhere | Section headings are body size (14px) and dialog titles use a different size from the 20px DESIGN.md gives section titles | RC-79 | read in code only |
| U-GL-036 | Everywhere | 'Updated · Time unavailable' and 'Updated 5 minutes ago' use different separators | RC-30 | read in code only |
| U-GL-037 | Everywhere | Page tabs and Settings section tabs look and behave differently (underline with hover versus filled pills without hover) | RC-18 | read in code only, likely |
| U-GL-038 | Everywhere | A failed command palette search says 'Try again' but has no Retry button | RC-82 | read in code only |
| U-GL-039 | Everywhere | At wide widths the docked inspector does not take keyboard focus when it opens | RC-39 | read in code only, likely |
| U-GL-040 | Everywhere | Command palette group headings sit 12px left of the items under them | RC-18 | seen live |
| U-GL-041 | Everywhere | The Chat loading screen shows four stat tiles whose values read 'Loading', plus a three-step list | RC-83 | read in code only, likely |
| U-GL-042 | Everywhere | A dialog opened over a sheet or another dialog does not dim the one underneath it | RC-81 | read in code only, likely |
| U-GL-043 | Everywhere | Which health checks failed and when they last ran appears only in a hover tooltip | RC-28 | read in code only, likely |
| U-GL-051 | Everywhere | Some pages do not carry the name of the tab or entry you chose: all four Capabilities tabs have the heading 'Capabilities', 'Advanced setup' is titled 'Connectors', Get started is titled 'First run' | RC-80 | seen live |
| U-SY-001 | System | System > Workers, held back in the release scope, opens as a normal page with no note that it is held | RC-21 | seen live |
| U-CH-001 | Chat | With the conversation inspector open on a 1440px screen the messages column is about 568px wide | RC-31 | seen live |
| U-CH-003 | Chat | Jump to latest counts new messages but does not say or jump to a decision waiting for you | RC-84 | read in code only, likely |
| U-CH-004 | Chat | The inline slash and $ suggestion list is announced as a listbox beside a plain text box, not as a combobox | RC-28 | read in code only, likely |
| U-CH-005 | Chat | Shared Button has a fixed height, so long or wrapped labels can overflow on narrow non-touch windows | RC-18 | read in code only, likely |
| U-CH-006 | Chat | Route preflight keeps an entry for every draft ever typed and resets its displayed result on every keystroke | RC-85 | read in code only, likely |
| U-CH-008 | Chat | A finished streamed answer may remount its already-rendered blocks when streaming ends | RC-86 | read in code only, likely |
| U-CH-009 | Chat | An optional background question has no Skip button | RC-87 | read in code only, likely |
| U-CH-010 | Chat | Cockpit Chat still uses the Classic controller frame's error and refresh rows | RC-83 | read in code only, likely |
| U-CH-011 | Chat | Chat still embeds Classic components, and Save as skill is a separate block under the answer | RC-83 | read in code only, likely |
| U-CH-013 | Chat | The cancel-background-task dialog shows task and watcher version numbers | RC-51 | read in code only, likely |
| U-CH-015 | Chat | Reload app asks for confirmation in some Chat places and reloads immediately in another | RC-88 | read in code only, likely |
| U-CH-016 | Chat | Retry asks for confirmation on tools with no recorded effect potential | RC-88 | read in code only, likely |
| U-CH-017 | Chat | An old /cowork/workspace link ends on 'Page not found' | RC-21 | seen live |
| U-CH-023 | Chat | With Review answer on, the receipt says 'Review unavailable' with no reason and no next step | RC-59 | seen live |
| U-ST-003 | Settings | Some Settings review texts still say 'retained draft' and print a settings revision number | RC-30 | read in code only, likely |
| U-ST-004 | Settings | The sidebar gear is named 'Settings and account' but opens a menu with no account entry | RC-89 | seen live |
| U-ST-006 | Settings | Enabling or disabling a channel is confirmed with the red delete-style button | RC-11 | read in code only, likely |
| U-ST-007 | Settings | Some Settings forms show help text that the field does not announce | RC-28 | read in code only, likely |
| U-ST-009 | Settings | To connect an MCP server the operator opens a button named 'Connections, tools and transport' | RC-30 | seen live |
| U-ST-011 | Settings | Switching an integration on or off needs a modal with a paragraph of text | RC-77 | read in code only, likely |
| U-ST-012 | Settings | Local AI setup prints a raw workspace ID and raw provider and model IDs in its first sentences | RC-51 | seen live |
| U-ST-013 | Settings | Notification routing still shows a hand-made test status, raw event types and a raw destination ID | RC-51 | read in code only, likely |
| U-ST-015 | Settings | The desktop update panel prints commit hashes beside the version | RC-51 | read in code only, likely |
| U-ST-016 | Settings | Every Settings search hit says 'Opens cockpit controls' | RC-30 | seen live |
| U-ST-017 | Settings | The Budgets page has no link to the spend figures it is about | RC-07 | seen live |
| U-ST-018 | Settings | The Citadel capabilities page is not reachable in the Cockpit | RC-21 | seen live |
| U-CH-014 | Chat | A Chat approval card still carries a separate 'How this decision works' disclosure under the buttons | RC-76 | read in code only, likely |
| U-CH-031 | Chat | An expired approval's Chat card says only 'Expired' with dead buttons and no next step | RC-38 | read in code only, likely |
| U-CH-041 | Chat | Characters typed within about 0.3 s of pressing New can be lost | RC-78 | seen live, likely |
| U-CH-042 | Chat | The danger approval review dialog repeats Action and Command that the card above it already shows | RC-76 | seen live |
| U-IN-002 | Inbox | Document diff and memory content in the Inbox inspector are still bordered sunken boxes | RC-18 | read in code only, likely |
| U-IN-004 | Inbox | Classic's notification feed (read/unread filter and mark unread on runtime signals) has no Cockpit screen | RC-07 | read in code only, likely |
| U-IN-005 | Inbox | The 'Open notes' link under a document proposal is about 21 px tall in Compact density | RC-18 | read in code only, likely |
| U-IN-014 | Inbox | 'Open approval' and 'Open in Inbox' on an Inbox row open the same Inbox again | RC-90 | seen live |
| U-GL-048 | Everywhere | Pressing Escape in Chat's inline conversation rename box leaves keyboard focus on nothing instead of the Rename button | RC-39 | seen live |
| U-CH-034 | Chat | Every click on New saves an empty 'New chat' conversation that stays in the list | RC-78 | seen live |
| U-CH-036 | Chat | After a message with an attached file is sent, the transcript still says 'Attached <file> for the next turn.' | RC-91 | seen live |
| U-CH-040 | Chat | When managed files cannot be loaded, the message tells the operator to edit config/tool-policy.json whatever the real cause | RC-10 | read in code only, likely |
| U-PJ-004 | Projects | Project screens print the raw workspace id ('Workspace ws_f13a...') as visible text | RC-51 | seen live |
| U-PJ-005 | Projects | After 'Keep draft and close' nothing on the project page says an unsaved draft exists | RC-92 | seen live |
| U-ST-014 | Settings | Settings › Models has four buttons all named 'Refresh', and other pages add section Refresh buttons beside the page one | RC-53 | seen live |
| U-ST-028 | Settings | Creating a personality asks the operator to type a raw ID, and the workspace archive review prints 'Record ID' and 'Version' as ordinary text | RC-51 | seen live |
| U-LB-001 | Library | Memory detail shows 'Owner: ws_...' as a raw id with no link | RC-51 | read in code only, likely |
| U-LB-003 | Library | Memory search needs an 'Apply memory filter' click while every other Library list filters as you type | RC-93 | read in code only, likely |
| U-LB-004 | Library | Library › Citadel shows 'Guided setup · Mason' as a page title and again as a section heading directly under it | RC-53 | seen live |
| U-LB-006 | Library | An empty Library › Memory still shows a diagnostics button and a proposals section with its own Refresh under the empty-state message | RC-53 | seen live |
| U-LB-007 | Library | Library opens on a list of skill candidates with no overview of what Library holds or where governance pages are | RC-53 | seen live, likely |
| U-LB-015 | Library | Running a prompt-pack test prints the full path of a log file on this computer in the result line ('Saved log to' followed by an absolute path) | RC-51 | seen live |
| U-SY-005 | System | System > Activity says 'Showing 100 recent signals' but lists 97 rows when background signals are shown | RC-60 | seen live |
| U-SY-014 | System | System > Browser sessions with no sessions says 'No browser sessions match this filter' and never says how a session comes to exist | RC-53 | seen live |
| U-SY-015 | System | A cancelled run's reason reads 'Cancelled by auth:[REDACTED]' and 'Run: cancelled by auth:[REDACTED]' | RC-51 | seen live |
| U-SY-017 | System | System > Quality > Design can show 'Blocking - P0' checks on the product's own source files when the install's root directory does not hold them | RC-94 | seen live, likely |
| U-WK-002 | Work | The Older Kanban view body still looks like a different product from the rest of Work | RC-18 | seen live |
| U-WK-006 | Work | A run that stopped for good is called 'Failed · needs recovery', 'Stopped run' and 'dead-lettered' in different places | RC-30 | read in code only, likely |
| U-WK-008 | Work | The Work board still refetches every loaded page of tasks and runs on each fallback poll | RC-95 | read in code only, likely |
| U-WK-009 | Work | Schedule list items are bordered cards with a hand-made Enabled/Paused pill | RC-18 | seen live |
| U-WK-016 | Work | A task page says 'No deliverables were returned.' and 'No activity was returned.' | RC-30 | seen live |
| U-WK-017 | Work | The Automation designer preview says 'Missing capabilities: automation-workflows.' with the internal id | RC-51 | seen live |
| U-CP-019 | Capabilities | The delete-integration dialog prints 'Reviewed version: 4c528e69b4e7…' (a 64-character hash) as visible text | RC-51 | seen live |
| U-MS-004 | Messaging | Deleting a saved channel draft asks 'Review channel lifecycle change' and the buttons read 'Apply reviewed channel change' and 'Keep current channel state' | RC-30 | seen live |
| U-GL-050 | Everywhere | Left idle for two minutes, System makes 16 API requests and Settings > Models makes 14, eight of them the same settings read | RC-95 | seen live |
| U-IN-012 | Inbox | The install-wide skill approval is titled 'Turn on skill bundled:documentation' with the internal skill id | RC-51 | seen live |
| U-IN-013 | Inbox | A dead-lettered run with no workspace is dropped from every Inbox and its Work page says 'Run workspace unknown' | RC-05 | seen live, likely |
| U-CH-027 | Chat | While the Gateway is unreachable a pending approval card keeps its normal Review and Deny buttons | RC-71 | seen live, likely |
| U-GL-054 | Everywhere | On the token sign-in page the 'Remember credentials on this browser' box shows a dot whether or not it is ticked, and the heading touches the line under it | RC-73 | seen live |
| U-WK-018 | Work | With 300 tasks the Needs attention lane header reads '200 tasks' and becomes '300 tasks' only after 'Load more tasks' at the bottom of the board | RC-61 | seen live |

## 4. Earlier reviews, closed out

Before the new walk, every finding from five earlier sources that was not already confirmed fixed (460 rows) was given a verdict on the reviewed commit: fixed (with a file and line or a screenshot), open, partly open, obsolete (the screen is gone), operator only (needs a real account, device or the installed app) or cannot check here (with the reason). The register is [prior-register.json](2026-11-usability/prior-register.json); the sources are described in [prior-sources.md](2026-11-usability/prior-sources.md).

| Source | Rows | Fixed | Partly open | Open | Obsolete | Operator only | Cannot check |
|---|---|---|---|---|---|---|---|
| Cockpit remediation ledger (2026-10-03 teardown, 219 findings, plus 14 parity findings) | 232 | 160 | 43 | 16 | 5 | 0 | 8 |
| One ledger row merged with an owed live check | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| Cockpit follow-up review (rows still open of its 157 new and 206 re-checked findings) | 68 | 22 | 24 | 19 | 0 | 0 | 3 |
| One follow-up row merged with a comprehensive-review row | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| Comprehensive review closure ledger (rows an operator can meet) | 85 | 82 | 1 | 0 | 0 | 1 | 1 |
| Classic-to-Cockpit route inventory (routes with no page of their own) | 39 | 31 | 6 | 1 | 1 | 0 | 0 |
| Live checks owed by earlier merged work | 34 | 4 | 2 | 1 | 0 | 25 | 2 |
| **Total** | **460** | **301** | **76** | **37** | **6** | **26** | **14** |

The table shows the register as built. Three rows were recorded with a verdict the review later corrected (the register file is generated and was left as built; the three corrections are listed in [root-causes.md](2026-11-usability/root-causes.md) under 'Register corrections'): N-04 (default auth mode, Chat 403) is partly open, now U-CH-018; OL-07 (Gateway outage and recovery) is partly open, now U-CH-026 and U-CH-027, with restart recovery still for you to check; OL-14 (`use <name>` in Chat) is open, now U-CH-044. With these applied, which is the set of figures used everywhere else in this report, the totals are 301 fixed, 78 partly open, 38 open, 6 obsolete, 24 operator only and 13 cannot check.

**The 116 earlier findings still open or partly open, by their new id** (after the three corrections; earlier ids in brackets; some earlier findings merged into one new one, and OL-07 is carried by two):

- **Stall (4)**: U-ST-001 (OL-16); U-FR-001 (FR-02); U-CH-044 (OL-14); U-WK-001 (PR-cowork-tasks).
- **Friction (31)**: U-CH-018 (N-04); U-SY-002 (N-12); U-ST-005 (ST-15); U-IN-001 (IN-04); U-IN-006 (GL-20); U-LB-002 (GL-N02); U-FR-002 (FR-06); U-ST-010 (ST-N03); U-GL-001 (GL-05); U-GL-006 (GL-16); U-GL-008 (GL-31); U-GL-025 (NV-05); U-GL-027 (NV-11); U-GL-034 (GL-L02, GL-07~fu206); U-GL-045 (SH-N12); U-CH-002 (CH-25); U-CH-012 (CH-N12); U-ST-002 (ST-07, ST-01~fu206); U-ST-008 (ST-26); U-IN-003 (IN-N06); U-CP-001 (OL-31); U-CP-002 (OL-35); U-CP-003 (PR-settings-workspace-capabilities); U-LB-005 (PR-library-skills); U-SY-003 (SY-08); U-SY-004 (SY-10); U-SY-006 (SY-06, SY-N06); U-WK-003 (WK-01); U-WK-004 (WK-05); U-WK-005 (WK-07); U-CH-026 (OL-07).
- **Polish (69)**: U-WK-010 (WK-N11); U-GL-004 (GL-10); U-GL-005 (GL-12); U-GL-007 (GL-27); U-GL-011 (GL-36); U-GL-012 (GL-37); U-GL-013 (GL-38); U-GL-016 (GL-45); U-GL-019 (GL-17); U-GL-020 (GL-22); U-GL-022 (GL-58); U-GL-023 (GL-59); U-GL-024 (GL-65); U-GL-029 (NV-21); U-GL-030 (NV-22); U-GL-031 (NV-23); U-GL-032 (GL-04~fu206); U-GL-033 (GL-06~fu206); U-GL-035 (GL-N03); U-GL-036 (GL-N05); U-GL-037 (GL-N06); U-GL-038 (GL-N09); U-GL-039 (NV-15); U-GL-040 (SH-26); U-GL-041 (SH-N01); U-GL-042 (SH-N05); U-GL-043 (SH-N07); U-SY-001 (N-05); U-CH-001 (CH-24); U-CH-003 (CH-28); U-CH-004 (CH-39); U-CH-005 (CH-45); U-CH-006 (CH-46); U-CH-008 (CH-50); U-CH-009 (CH-39~fu206); U-CH-010 (CH-N01); U-CH-011 (CH-N11); U-CH-013 (CH-N13); U-CH-015 (CH-R06); U-CH-016 (CH-R10); U-CH-017 (PR-cowork-workspace); U-ST-003 (ST-12~fu206); U-ST-004 (ST-13, SH-N09); U-ST-006 (ST-21); U-ST-007 (ST-22); U-ST-009 (ST-27); U-ST-011 (ST-N09); U-ST-012 (ST-N12); U-ST-013 (ST-N14); U-ST-015 (ST-N20); U-ST-016 (ST-N22); U-ST-017 (PR-settings-budget); U-ST-018 (PR-settings-citadel-capabilities); U-CH-014 (CH-R03); U-IN-002 (IN-N04); U-IN-004 (PR-ops-notifications); U-IN-005 (UX457-DOC-TARGET-SIZE); U-ST-014 (ST-N19); U-LB-001 (GL-23); U-LB-003 (LB-08); U-LB-004 (LB-R01, LB-05~fu206); U-LB-006 (VR-02); U-LB-007 (LB-03); U-SY-005 (SY-11); U-WK-002 (VR-01); U-WK-006 (WK-11); U-WK-008 (WK-13); U-WK-009 (WK-N07); U-CH-027 (OL-07).
- **No longer a finding (8)**: GL-06 (U-GL-002, now an engineering note); CH-49 (U-CH-007, now an engineering note); GL-42 (U-GL-014, now an engineering note); GL-43 (U-GL-015, now an engineering note); GL-48 (U-GL-017, now an engineering note); GL-50 (U-GL-018, now an engineering note); NV-18 (U-GL-028, withdrawn: not reproduced); WK-12 (U-WK-007, now an engineering note).

## 5. Suggested fix batches

This is a suggestion for the next plan, not work done. Each batch is sized as one small pull request unless it says otherwise, lists the findings it clears and the files it touches (paths repo-relative; line numbers are on the reviewed commit). The order is not the `rank` in `findings.json`: rank is mechanical (severity, then how many journeys a finding breaks, then how early a new operator meets it), while this order puts first the stalls that can happen on any default install, then the stalls that need more than one workspace, then the one stall that was only read in code, and only then friction. Batches 1 to 8 clear all 11 stalls (U-CP-004 fully only with batch 4b).

### Stalls that can happen on any install

**Batch 1. The credential-box crash guard, and switches for the features that ship off.** Two pull requests.
- 1a, one line plus a test: in `packages/mission-control-shared/src/components/chat/ChatChangePlanActionDialogBody.tsx:107` read `event.currentTarget.value` into a local before calling the setter, and make `packages/mission-control-shared/src/components/chat/ChatChangePlanActionDialog.test.tsx` use an event whose `currentTarget` is cleared after the handler returns. Clears U-ST-029 (RC-74). It is rated polish, but it crashes the page on every keystroke in the development build, and the review could not rule it out in production (0 crashes in 5 production loads); this dialog is the only place in the Cockpit to enter a provider API key, used by first run and Settings > Models.
- 1b (RC-01): one "Features" section on the Settings > Advanced page (a new file under `apps/mission-control-next/src/cockpit/areas/settings/`, shown from `apps/mission-control-next/src/cockpit/areas/settings/SettingsArea.tsx`) listing the default-off settings that gate a Cockpit screen, each a governed switch through the existing settings patch (`apps/gateway/src/routes/dashboard.ts:266` already accepts them; defaults in `apps/gateway/src/config.ts:1472` and `config/goatcitadel.example.json:202` stay as they are). Then make every "turned off" sentence link to its switch: `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryWorkspace.tsx:196`, `apps/mission-control-next/src/cockpit/areas/settings/McpSetupProgress.tsx:145`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-links.ts:11`, and say on the Skills panel (`apps/mission-control-next/src/cockpit/areas/capabilities/skills/SkillPanelSwitch.tsx:13`, `apps/mission-control-next/src/cockpit/areas/capabilities/skills/skill-install-view.ts:153`) that naming a skill in Chat needs the switch. In the same pull request, make the demo say which step it skipped and why (`apps/mission-control-next/src/cockpit/areas/settings/FirstRunDemo.tsx`, RC-27). Clears U-LB-008, U-CH-044, U-CP-015 (stalls), U-ST-027, U-CP-018, U-FR-006. Not cleared here: even with the switch on, Chat shows no chip when a skill loads (part of U-CH-044's record); decide whether that is a follow-up.

**Batch 2. A waiting change is found again instead of reported as "changed elsewhere"** (RC-03, first half). When a save gets 409 WRITE_CONFLICT because a change for the same setting is still waiting for approval, look up that change and reopen its in-place approval, or say "one change is already waiting" with a link. The 409 already carries the waiting plan's id (`packages/storage/src/change-plan-repo.ts:1020`: `details.resourceId` is the plan id), so no Gateway change is needed to find it. The hooks are the three RC-03 names: the governed setting hook `apps/mission-control-next/src/cockpit/areas/settings/use-governed-runtime-setting.ts:122` (Settings toggles and the WhatsApp public web address in `apps/mission-control-next/src/cockpit/areas/settings/PublicWebAddressField.tsx:59`), the approval mode hook `apps/mission-control-next/src/cockpit/areas/settings/use-approval-mode-control.ts:166` (Safety > Tools approval rule; there the 409 currently falls into the uncertain-save lock rather than "changed elsewhere"), and the channel setup state `apps/mission-control-next/src/features/native-routes/settings/sections/channel-setup-state.ts:28`; plus the provider editor `apps/mission-control-next/src/cockpit/areas/settings/use-provider-connection-editor.ts:157` (Replace API credential). Clears U-ST-021, U-MS-005 (stalls). Batch 8 edits the same catch block in the approval mode hook, so do batches 2 and 8 as one pull request, or batch 2 first.

**Batch 3. Show why an MCP connection failed** (RC-06). Show the last error as plain text on the connector panel; keep only codes and ids inside Technical details. The change belongs in the connector panel, not in the shared Technical details disclosure (changing that would change every page): `item.lastError` is already on the item (`apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorPanelParts.tsx:109`), the row text "Stopped working; open it to see why" is at `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-view.ts:85` and the pointer to Technical details at `:205`. Clears U-CP-014 (stall).

**Batch 4. Plugins that added a skill** (RC-04). Two steps. 4a, copy only: the first uninstall confirmation (`apps/mission-control-next/src/cockpit/areas/capabilities/plugins/PluginUninstall.tsx:98`) says that a plugin with a skill cannot be installed again, and the "Finish uninstalling" step says why a second step exists. This removes the false promise in U-CP-004 (stall) and clears U-CP-006; a reinstall stays impossible until 4b, so U-CP-004 is fully cleared only by 4b. 4b, larger and a separate plan: a governed skill removal that clears the leftover skill row (`apps/gateway/src/services/capability-plugin-inspection-service.ts:74`), which clears U-CP-005 and lets the plugin come back.

**Batch 5. Record a deliverable in Work** (RC-07, first of four separate gaps). Add the deliverable entry the Classic task page had (`apps/mission-control-next/src/features/native-routes/cowork/CoworkNativePage.tsx:380` shows the old control) to `apps/mission-control-next/src/cockpit/areas/work/WorkTaskDetail.tsx`, next to the Done rule in `apps/mission-control-next/src/cockpit/areas/work/TaskStatusControl.tsx:102`. The shared client already has the call, `addTaskDeliverable` (exported at `packages/mission-control-shared/src/api/client.ts:938`), so no Gateway work is needed. Clears U-WK-001 (stall).

### Stalls that need more than one workspace

**Batch 6. Settings approvals from any workspace** (RC-02). Settings changes are install-wide; stop creating and linking their change plans under the literal workspace "default" (seven call sites: `apps/mission-control-next/src/cockpit/areas/settings/GovernedSettingParts.tsx:117`, `apps/mission-control-next/src/cockpit/areas/settings/ApprovalModeControl.tsx:177`, `apps/mission-control-next/src/cockpit/areas/settings/FilesystemWriteAccessParts.tsx:71`, `apps/mission-control-next/src/cockpit/areas/settings/ProviderConnectionSettings.tsx:344`, `apps/mission-control-next/src/cockpit/areas/settings/ProviderRoutingSettings.tsx:247`, `apps/mission-control-next/src/cockpit/areas/settings/ManagedRuntimeSettings.tsx:195`, `apps/mission-control-next/src/cockpit/areas/settings/GatewayAuthSettings.tsx:101`) and let `apps/mission-control-next/src/cockpit/areas/settings/SettingsApprovalDialog.tsx:52` accept them from any selected workspace. What refuses today is `scopeChanged` in `apps/mission-control-next/src/cockpit/areas/inbox/ApprovalDecisionBar.tsx:149` (the selected workspace differs from the approval's). Whether the Gateway itself also creates these plans under "default" needs checking before the change. Clears U-ST-001 (stall). Only installs with more than one workspace meet it, while a workspace other than "default" is selected.

**Batch 7. Links across workspaces name the workspace** (RC-05). Put the workspace id in every cross-area link and run event, and let the receiving page offer "Switch to <workspace>". Files: `apps/mission-control-next/src/cockpit/areas/chat/SessionControlManager.tsx:211`, `apps/mission-control-next/src/cockpit/areas/system/SystemSessions.tsx`, `apps/gateway/src/services/durable-run-service.ts:624`, `apps/mission-control-next/src/cockpit/app/IncomingScopeReview.tsx` (the linked-scope banner, which also needs a dismiss). Clears U-SY-009 (stall), U-GL-045, U-IN-013.

### The stall read in code only

**Batch 8. An uncertain save unlocks itself** (RC-03, second half). After a save whose answer was lost (5xx, timeout, restart), re-read the saved value and lift the lock when it settles; on a 4xx with a Gateway reason, show the refusal and keep the page usable. Files: `apps/mission-control-next/src/cockpit/areas/settings/use-approval-mode-control.ts:166`, `apps/mission-control-next/src/cockpit/areas/settings/approval-mode-state.ts:65`, `apps/mission-control-next/src/cockpit/areas/settings/use-first-run-setup.ts:104` (first-run Finish), `apps/mission-control-next/src/features/native-routes/settings/sections/channel-setup-state.ts:28` (Advanced channel setup). Clears U-FR-001 (stall, not reproduced live) and U-MS-002. Same catch block as batch 2 in the approval mode hook: one pull request with batch 2, or after it.

### Friction, in rough order of how many operators meet it

**Batch 9. Project conversations in the default auth mode** (RC-08). Waits on design decision 2 in section 9. Either let loopback requests count as the local operator when sign-in is off, in `apps/gateway/src/routes/session-control-request-context.ts:154`, or have the composer and `apps/mission-control-next/src/cockpit/areas/chat/ChatManagedFiles.tsx:109` say "Auto mode and Managed files need sign-in (Settings > Access)" instead of "unavailable / Retry". Clears U-CH-018.

**Batch 10. Health and the first message tell the truth.** Four small edits. Health: show unsupported service control as neutral information (`apps/mission-control-next/src/cockpit/areas/system/health-overview.ts:117`, `apps/gateway/src/services/daemon-route-service.ts:100`) and, separately, add a "Default model" check (RC-09). First send with no provider or an unreachable one: add the "Open model providers" link and name the provider (`apps/mission-control-next/src/cockpit/areas/chat/ChatTurnFailureCard.tsx:31`, `apps/mission-control-next/src/cockpit/areas/chat/ChatAreaChrome.tsx:198`, RC-23). First visit: port the Classic first-destination guard (`apps/mission-control-next/src/app/MissionControlNextApp.tsx:748`) to the Cockpit (`apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:223`, RC-24, pending design decision 3). Get started: show "Saved model defaults changed" only after a real change (`apps/mission-control-next/src/cockpit/areas/settings/CockpitGuidedModelSetup.tsx`, RC-25). Clears U-SY-002, U-FR-005, U-FR-012, U-ST-030, U-FR-014, U-FR-016.

**Batch 11. One model setup.** Make Get started the one setup and show its status on Providers & models (`apps/mission-control-next/src/cockpit/areas/settings/ModelsSettings.tsx:62`, `apps/mission-control-next/src/cockpit/areas/settings/GuidedModelSteps.tsx:59`, RC-26); return the connection check's warning and derive Ready from the last check result (`apps/mission-control-next/src/cockpit/areas/settings/use-guided-model-setup.ts:369`, `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.ts:179`, RC-22). Clears U-ST-010, U-FR-013, U-ST-002, U-FR-004, U-ST-023. Possibly two pull requests.

**Batch 12. Approvals open in place.** Open the in-place approval dialog from the three callers that still send you to the Inbox or a Continue step (`apps/mission-control-next/src/cockpit/areas/settings/ApprovalModeControl.tsx:173`, `apps/mission-control-next/src/cockpit/areas/capabilities/tools/GroupSwitchParts.tsx:167`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorInstallProgress.tsx:17`, RC-13), and apply safe, secret-free change plans on the first confirmation (`packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx`, `apps/mission-control-next/src/cockpit/areas/settings/ProviderManagementSettings.tsx`, RC-33). Clears U-ST-020, U-CP-012, U-CP-021, U-CH-021, U-ST-022.

**Batch 13. Approval cards say what they approve and when they are over.** Titles and summaries from the stored tool arguments (`apps/gateway/src/services/inbox-projection-service.ts`, `apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx`, RC-14); the risk badge from the approval's risk (`apps/mission-control-next/src/cockpit/areas/inbox/ApprovalShellExplanations.tsx`, RC-75); "Running after approval" until the receipt arrives (`apps/gateway/src/services/approval-resolution-effects-service.ts:3527`, RC-42); expired approvals out of the waiting count, with one next step on the card (`apps/mission-control-next/src/cockpit/areas/chat/ChatBlockers.tsx`, RC-38); the outage banner and decision buttons tied to the connection probe (`packages/threaded-surface-core/src/chat/chat-error-copy.ts`, `apps/mission-control-next/src/cockpit/areas/chat/ChatApprovalRenderer.tsx`, RC-71). Clears U-IN-001, U-IN-016, U-CH-046, U-IN-010, U-CH-047, U-IN-011, U-CH-031, U-CH-026, U-CH-027. Probably two pull requests (Gateway, Cockpit).

**Batch 14. The Inbox keeps your place.** Put the selected item in the URL and, after a decision, show the next item or clear the selection; both live in the selection state of `apps/mission-control-next/src/cockpit/areas/inbox/InboxArea.tsx:162` and `:171` (RC-15, RC-37). Also: "Open approval" opens the source (`apps/mission-control-next/src/cockpit/areas/inbox/InboxItemCard.tsx`, RC-90) and the recovery dialog shows the run (`apps/mission-control-next/src/cockpit/areas/inbox/InboxRunRecovery.tsx:247`, RC-36). Clears U-IN-006, U-IN-008, U-IN-014, U-IN-003.

**Batch 15. "Plan first" asks the model** (RC-16). Send Plan first requests to the model with a planning instruction instead of the fixed template (`apps/gateway/src/services/chat-turn-helpers.ts`), render its steps readably, and show the Delegation card's state from its steps (`apps/mission-control-next/src/cockpit/areas/chat/ChatRunCard.tsx`). Clears U-CH-032, U-CH-033, U-CH-045 together (one template).

**Batch 16. The build editor's first step.** Show Create worktree beside "Create a worktree to begin editing", turn a failed creation into a sentence instead of raw JSON, and put the file count in Revert all (`apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchToolbar.tsx`, `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.tsx`; RC-32 and the raw-JSON item from RC-51). Clears U-CH-038, U-CH-043, U-CH-012 together (same toolbar and worktree flow).

**Batch 17. Errors keep the Gateway's reason.** Seven small edits: attachment and managed-file errors through `describeApiError` (`apps/mission-control-next/src/cockpit/areas/chat/ChatComposerTools.tsx:300`, `apps/mission-control-next/src/cockpit/areas/chat/ChatManagedFiles.tsx:323`, RC-10); one plain sentence for "no OS keychain" in the shared mapper and the channel hooks (`packages/mission-control-shared/src/api/describe-api-error.ts:117`, `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/use-telegram-setup.ts:267` and the Discord and Slack hooks, RC-12, only hosts without a keychain); plugin check reasons per blocker (`apps/gateway/src/services/capability-plugin-inspection-service.ts:71`, `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/plugin-check-copy.ts:25`, RC-45); "unavailable" with its reason (`packages/mission-control-shared/src/components/chat/chat-display-helpers.ts:25`, `apps/mission-control-next/src/cockpit/areas/system/quality/QualityEvidence.tsx:35`, RC-59); failed loads as an error with Retry (`apps/mission-control-next/src/cockpit/ui/EmptyState.tsx:20`, RC-56); the blocking rule in a policy block (`packages/mission-control-shared/src/components/chat/ChatToolActivity.tsx:152`, RC-47); a Retry on a failed palette search (`apps/mission-control-next/src/cockpit/app/CommandPaletteView.tsx:178`, RC-82). Clears U-CH-020, U-CH-040, U-ST-033, U-MS-001, U-CP-001, U-CP-002, U-SY-013, U-CH-023, U-SY-004, U-ST-025, U-GL-038.

**Batch 18. Chat turn edges.** Ten small, independent edits, best split over two pull requests: Stop after completion keeps the answer (`apps/gateway/src/routes/chat.messages.ts:1041`, RC-34); say when an attached document was cut (`apps/gateway/src/services/chat-attachment-service.ts:339`, RC-41); no title line in plain-text files (`packages/policy-engine/src/document-artifacts.ts:479`, RC-43); drop the stale "for the next turn" note (`packages/threaded-surface-core/src/chat/useChatComposerPaletteActions.ts:68`, RC-91); create a conversation on first send and keep the composer mounted (`apps/mission-control-next/src/cockpit/areas/chat/ConversationListPanel.tsx`, `apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.tsx`, `apps/mission-control-next/src/cockpit/app/use-command-new-chat.ts`, RC-78); a Skip button for optional questions (`apps/mission-control-next/src/cockpit/areas/chat/ChatPendingQuestion.tsx:39`, RC-87); one confirmation rule for Reload and Retry (`apps/mission-control-next/src/cockpit/areas/chat/ChatTurnActions.tsx`, RC-88); Jump to latest names a waiting decision (`apps/mission-control-next/src/cockpit/areas/chat/ChatTranscript.tsx:344`, RC-84); bound the route preflight cache (`packages/threaded-surface-core/src/chat/useChatRoutePreflight.ts:123`, RC-85); keep streamed block keys (`packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx:581`, RC-86). Clears U-CH-025, U-CH-035, U-CH-049, U-CH-036, U-CH-024, U-GL-031, U-CH-041, U-CH-034, U-CH-009, U-CH-015, U-CH-016, U-CH-003, U-CH-006, U-CH-008.

**Batch 19. Connectors and integrations.** "Connected" only for a confirmed connection (`apps/gateway/src/services/capability-connectors-projection.ts`, `apps/mission-control-next/src/features/native-routes/settings/sections/IntegrationsSection.tsx`, RC-17); "open" actions scroll to and focus what they opened (`apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-links.ts`, `apps/mission-control-next/src/cockpit/areas/library/LibraryAgentsWorkspace.tsx`, RC-46); the Gateway's allowlist verdict on the Firecrawl page (`apps/mission-control-next/src/cockpit/areas/settings/FirecrawlSettings.tsx:101`, RC-48); Gmail and Calendar "Set up" opens their add form, platform entries filtered to the host (`apps/mission-control-next/src/cockpit/areas/settings/IntegrationManagementSettings.tsx`, `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorPanel.tsx`, RC-68); the webhook destination through secure input (`apps/mission-control-next/src/cockpit/areas/settings/NotificationRoutingFields.tsx:63`, RC-35). Clears U-CP-013, U-CP-017, U-CP-007, U-LB-013, U-ST-031, U-CP-016, U-CP-020, U-ST-008.

**Batch 20. Messaging channel setup.** Reuse an open draft and show draft times (`apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx:136`, RC-69); keep "Who may message this bot?" incomplete while empty and offer to allow a dropped sender (`apps/mission-control-next/src/features/native-routes/settings/channel-setup/channel-wizard-model.ts`, `apps/gateway/src/services/channel-inbound-dispatch.ts`, RC-70). Clears U-MS-003, U-MS-006, U-MS-007.

**Batch 21. Library.** Memory provenance shows why an item was remembered (RC-49) and one dialog for edit or forget (RC-50), both in `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryEditor.tsx`; a file chooser for Upload text file (`apps/mission-control-next/src/cockpit/areas/library/LibraryFileUpload.tsx:143`, RC-52); a list of ingested knowledge sources (`apps/mission-control-next/src/cockpit/areas/library/LibraryKnowledgeWorkspace.tsx`, RC-54); filter memory as you type (`apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryWorkspace.tsx:179`, RC-93). Clears U-LB-009, U-LB-010, U-LB-012, U-LB-016, U-LB-003.

**Batch 22. System.** Preview the unsaved board layout (`apps/mission-control-next/src/cockpit/areas/system/CockpitBoardEditor.tsx:302`, RC-55); rename "Close session" to "Close details" (`apps/mission-control-next/src/cockpit/areas/system/SelectedSessionSection.tsx:37`, RC-57); the latest backup path on the Health backup card (`apps/mission-control-next/src/cockpit/areas/system/HealthBackupAction.tsx:129`, RC-58); "Load older" in Activity (`apps/mission-control-next/src/cockpit/areas/system/SystemActivity.tsx`, RC-60); skip source checks the install does not hold (`packages/skills/src/design-quality.ts:221`, RC-94). Clears U-SY-003, U-SY-010, U-SY-011, U-SY-016, U-SY-005, U-SY-017.

**Batch 23. Work.** Task lanes apart from run lanes, with the Gateway's totals (`apps/mission-control-next/src/cockpit/areas/work/WorkBoard.tsx`, RC-61); lead the run page with what it waits on (`apps/mission-control-next/src/cockpit/areas/work/WorkRunDetail.tsx:209`, RC-62); link the run of a Chat-delegated task (`apps/gateway/src/services/chat-delegation-service.ts:1364`, `apps/mission-control-next/src/cockpit/areas/work/WorkTaskDetail.tsx:116`, RC-63); refetch after Pause (`apps/mission-control-next/src/cockpit/areas/work/WorkRunControls.tsx:229`, RC-64); next run times for every schedule (`apps/mission-control-next/src/cockpit/areas/work/WorkScheduleSummary.tsx`, RC-65); a Task schedule creates its task in its own workspace (`apps/mission-control-next/src/cockpit/areas/work/WorkScheduleCreateForm.tsx`, RC-66, cause not yet isolated); History titles runs by their task or conversation (`apps/mission-control-next/src/cockpit/areas/work/work-board.ts:42`, RC-67). Clears U-WK-003, U-WK-018, U-WK-004, U-WK-005, U-WK-011, U-WK-012, U-WK-013, U-WK-014, U-WK-015.

**Batch 24. Projects.** Reject drive-letter and UNC paths in the project path rule and word the refusal with an example (`packages/storage/src/chat-project-repo.ts`, `apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx`, RC-44); show "Unsaved draft" after Keep draft and close (`apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx`, RC-92). Clears U-PJ-001, U-PJ-006, U-PJ-005. Give the drive-path question a security look first (section 9).

**Batch 25. Keyboard, focus and page titles.** Keep Refresh focusable while busy, return focus on every dialog close, stop the tab strip moving the Tab start (`apps/mission-control-next/src/cockpit/ui/OverflowTabs.tsx:53`, `apps/mission-control-next/src/cockpit/areas/system/HealthOverview.tsx:148`, `apps/mission-control-next/src/cockpit/areas/inbox/InboxArea.tsx:271`, RC-39); save scroll before navigating (`apps/mission-control-next/src/cockpit/app/use-cockpit-scroll.ts:24`, RC-40); announce hints and page changes (`apps/mission-control-next/src/cockpit/ui/IconButton.tsx`, `apps/mission-control-next/src/cockpit/app/CockpitShell.tsx`, RC-28); titles from the open tab, conversation or run (`apps/mission-control-next/src/cockpit/app/cockpit-document-title.ts`, RC-80); sheet, dialog and inspector stacking (`apps/mission-control-next/src/cockpit/ui/SheetDrawerRuntime.tsx`, `apps/mission-control-next/src/cockpit/ui/DialogRuntime.tsx`, `apps/mission-control-next/src/cockpit/app/inspector.tsx`, RC-81); the workspace name in the phone header (`apps/mission-control-next/src/cockpit/app/MobileTabBar.tsx:162`, RC-29). Clears U-GL-046, U-GL-047, U-GL-039, U-GL-048, U-GL-049, U-GL-025, U-GL-016, U-GL-043, U-CH-004, U-ST-007, U-GL-024, U-GL-051, U-GL-029, U-GL-030, U-GL-042, U-GL-027. Two or three pull requests.

**Batch 26. Chat at laptop widths** (RC-31). Collapse the conversation list below 1280 px, let the inspector tabs scroll, and reserve the sticky bar's height (`apps/mission-control-next/src/cockpit/areas/chat/ThreadList.tsx`, `apps/mission-control-next/src/cockpit/app/InspectorResizeHandle.tsx`, `apps/mission-control-next/src/cockpit/areas/chat/ChatStickyPrompt.tsx`, `apps/mission-control-next/src/cockpit/areas/chat/chat-inspector-evidence.tsx:134`). Clears U-CH-002, U-CH-028, U-CH-048, U-CH-001.

**Batch 27. The other Classic gaps and stale links.** Three separate edits for the remaining missing Classic actions (RC-07): skill evaluation runs in Library (U-LB-005), the notification feed in the Inbox (U-IN-004), a Spend link from Budgets (U-ST-017). Retarget or remove links to hidden pages and label held-back pages (`apps/mission-control-next/src/app/route-release-scope.ts:449`, `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:235`, RC-21). Give Cockpit Chat its own frame instead of the Classic one (`packages/threaded-surface-core/src/chat/controller/renderChatControllerFrame.tsx`, `packages/threaded-surface-core/src/chat/ThreadedLoadingState.tsx`, RC-83, larger). Clears U-LB-005, U-IN-004, U-ST-017, U-FR-002, U-CP-003, U-SY-001, U-CH-017, U-ST-018, U-GL-041, U-CH-010, U-CH-011.

**Batch 28. Install, first start and the terminal wizard.** Make the Chromium and Voice runtimes opt-in, or let their download fail without aborting (`scripts/packaging/build-windows-native-installer.mjs:226`, RC-19); pass the bundled database's start failure to the desktop recovery screen and check the port first (`apps/gateway/src/bundled-postgres-runtime.ts:577`, `apps/mission-control-desktop/src/main.ts:173`, RC-20); save the key before the settings and exit quietly on Ctrl+C (`apps/gateway/src/onboarding-tui.ts:207`, RC-72). Clears U-FR-011, U-FR-015, U-FR-008, U-FR-009. Needs the installer and desktop checks in section 6 afterwards.

**Batch 29. The token sign-in page** (RC-73). A real form with Connect as submit, "That token was refused" for a 401, the shared checkbox (`packages/mission-control-shared/src/components/GatewayAccessGate.tsx:399`, `apps/mission-control-next/src/app/use-gateway-access.ts`). Clears U-GL-052, U-GL-053, U-GL-054. Token sign-in installs only.

**Batch 30. Shared controls, a sweep.** RC-18 is a sweep of 12 small edits: replace hand-made controls with the shared Button, Tabs and Callout, and give those a forced-colours outline, a 24 px minimum target and a distinct current state (`apps/mission-control-next/src/cockpit/ui/Button.tsx`, `apps/mission-control-next/src/cockpit/ui/Tabs.tsx`, `apps/mission-control-next/src/cockpit/ui/Callout.tsx`, `apps/mission-control-next/src/cockpit/styles/cockpit.css`). With it: the primary style on commit buttons (`apps/mission-control-next/src/features/threaded-surface/styles/change-plans.css:186`, `apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx:263`, `apps/mission-control-next/src/cockpit/areas/settings/ChannelLifecycleControls.tsx`, RC-11) and the type scale (`apps/mission-control-next/src/cockpit/ui/Section.tsx`, `apps/mission-control-next/src/cockpit/ui/AreaHeader.tsx`, RC-79). Clears U-LB-002, U-GL-001, U-GL-006, U-GL-005, U-GL-013, U-GL-037, U-GL-040, U-CH-005, U-IN-002, U-IN-005, U-WK-002, U-WK-009, U-ST-005, U-GL-008, U-ST-006, U-GL-011, U-GL-012, U-GL-035. Several pull requests; visual baselines will move.

**Batch 31. Words on screen, a sweep.** RC-51 is a sweep of 19 edits (its 20th finding, U-CH-043, is in batch 16): move each raw id, hash, setting name or path into Technical details or replace it with its name, and lower `scripts/check-mission-control-next-raw-values.mjs` to zero for those files. RC-30 is a sweep of 11 edits through the glossary and status presenters (`packages/mission-control-shared/src/content/status-vocabulary.ts`, `apps/mission-control-next/src/cockpit/areas/system/system-vocabulary.ts`). RC-53 is a sweep of 8 page-anatomy edits (one Refresh, one line of description, one empty state; `scripts/check-mission-control-next-page-anatomy.mjs`). RC-89: rename the gear menu "Settings and theme" (`apps/mission-control-next/src/cockpit/app/Sidebar.tsx:263`). Clears U-LB-011, U-CH-022, U-CP-011, U-GL-007, U-GL-019, U-GL-032, U-GL-033, U-CH-013, U-ST-012, U-ST-013, U-ST-015, U-PJ-004, U-ST-028, U-LB-001, U-LB-015, U-SY-015, U-WK-017, U-CP-019, U-IN-012, U-GL-034, U-GL-004, U-GL-022, U-GL-023, U-GL-036, U-ST-003, U-ST-009, U-ST-016, U-WK-006, U-WK-016, U-MS-004, U-LB-014, U-SY-006, U-GL-020, U-ST-014, U-LB-004, U-LB-006, U-LB-007, U-SY-014, U-ST-004. Many small pull requests, by area.

**Batch 32. Idle requests** (RC-95). Share the settings query across panels and refetch only the first page on the fallback poll (`apps/mission-control-next/src/cockpit/areas/settings/BudgetModeControl.tsx`, `apps/mission-control-next/src/cockpit/areas/work/work-queries.ts`). Clears U-GL-050, U-WK-008.

**Waiting on a design decision (section 9).** RC-76, fewer clicks for danger approvals (U-IN-015, U-CH-014, U-CH-042; `apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalConfirmationBody.tsx`, `apps/mission-control-next/src/cockpit/areas/inbox/InboxApprovalActions.tsx`), and RC-77, reversible actions without a review dialog (U-WK-010, U-ST-011; `apps/mission-control-next/src/cockpit/areas/work/WorkScheduleInspector.tsx`, `apps/mission-control-next/src/cockpit/areas/settings/IntegrationConnectionsSettings.tsx`). RC-08 (batch 9) also waits on a decision.

## 6. Operator checklist

Things only you can check: they need the installed app, a real account or device, a real model, or something this review was not allowed to do. Each item says where to click and what a pass looks like. Checks that earlier reviews listed but that have no visible symptom (render counts, dead code, bundle internals) are left out; so is any check that a finding already answers (the `use <name>` check is answered by U-CH-044, the default auth mode check by U-CH-018).

### Desktop app and install

1. **First launch to Chat.** Install the latest Windows build with the default components (note the components page, any SmartScreen prompt and the time taken), then launch it. Pass: the first window appears without a light flash in the dark theme, and you reach a usable Chat (or Get started) without a recovery screen.
2. **Notifications, file picker, relaunch, single Gateway.** With the app open, trigger a notification (for example an approval from a Chat turn) and click it. Attach a file through the Chat composer's plus menu. Close the app and start it again. Start it a second time while it is running. Pass: the notification lands on the thing it names; the file attaches; the window and the open conversation come back after relaunch; the second launch brings up the existing window and does not start a second Gateway (Task Manager shows one Gateway process).
3. **Desktop verification lane.** From the repository root run `pnpm verify:desktop`. Pass: it exits 0.
4. **Keyboard and input in the app.** Press Ctrl+K, Ctrl+1 to Ctrl+5 and Ctrl+B, in the composer and outside it; type Japanese with the Windows input method and confirm a conversion with Enter. Pass: each shortcut acts once and the conversion Enter does not send. (On a Mac, repeat the input check with the macOS Japanese input.)
5. **Provider key in the installed app.** Settings > Models > Providers & models > Advanced provider configuration > Replace API credential > Open secure input, then type a key. Pass: dots appear, the page does not crash, and Submit securely stores it. (The review saw no crash in 5 loads of a served production build, but not in the installed app; see U-ST-029.)
6. **Bundled database start.** On a spare profile: start with nothing on port 45432 and time the first start; then hold the port with any listener and launch; then run a Postgres container with another password on 45432 and launch. Read the window at 10 s, 60 s and at failure, and compare with Open Logs. Pass: a normal start reaches Chat; a failed start says why on screen (today it does not, U-FR-015).
7. **Installer, update and uninstall.** On a clean machine, run the setup file with defaults, then switch the update channel to Preview and use Check, Download, Show installer, and run it while a Chat task is running; then uninstall. Pass: each step says what it is doing, the update keeps your data, and the uninstall leaves only what it says it leaves in the local app data and home folders. Watch whether the default Chromium and Voice downloads can abort the install (U-FR-011).
8. **Stop and restart the Gateway.** With a Chat draft open, stop the Gateway (tray or service controls), wait for the banner, press Check again, then restart it. Pass: within about 15 s the banner says the Gateway is unreachable and the draft is kept; Check again shows it is checking; about one probe every 5 s in the Network tab; after the restart the banner clears without a reload and the draft is still there (the frozen-Gateway case, U-CH-026, does not clear today).

### First run and models

9. **First run with a real key.** On a fresh install: Get started > Use a cloud provider > a provider > Connect provider > paste the key; Confirm model; Continue to safety; Keep current rule; Finish; then send "hello". Pass: each step is reachable without a reload, Finish completes, and the first words of the reply arrive; note the time and every point where the next step was unclear.
10. **Second provider and model.** With two providers configured, open the conversation's model chip, pick the other provider and model, confirm, send. Pass: the receipt under the answer names the new model; a model that does not support the chosen effort, and a provider whose key is missing, each say so.
11. **Local AI.** Install llama.cpp, put a `.gguf` file in the Gateway's model folder, then Settings > Models > Local AI > Let GoatCitadel start one > Check server > Finish setup; later stop it from Advanced > llama.cpp lifecycle. Pass: models are listed, start and stop work, and Check server says plainly when the server is down (U-FR-004 says it does not today).
12. **Terminal wizard.** Against a scratch Gateway, run `pnpm onboarding:tui` in a real terminal and answer with Enter throughout; rerun and press Ctrl+C at each prompt; enter `http://127.0.0.1:9` as the provider base URL. Pass: a finished run leaves a working provider; Ctrl+C exits quietly (U-FR-008 expects a stack trace today); a bad URL is refused with a reason.

### Chat with a real model

13. **Stop.** Ask for a 600-word story; press Stop after the first sentence; then ask again and press Stop as the last paragraph appears. Pass: the text so far stays, the turn reads Cancelled, no "provider request failed" card appears (U-CH-025), and the composer is ready.
14. **Long answer and scrolling.** Ask for a long answer, scroll up one screen as it starts, wait for the end, then click Jump to latest. Pass: the text under your eyes does not move, and Jump to latest reaches the end and stays there while a second answer streams.
15. **A long real conversation.** Open a conversation of several hundred messages with rich markdown (code, tables, lists). Pass: it opens in under about 1 second and scrolls without stutter (the 300-message test thread with plain short replies took 909 ms on a production build).
16. **Approvals from a real turn.** In a project conversation ask "Run the project's tests" (shell commands allowed in tool policy). Pass: the approval appears in the conversation, Review danger approval then Approve once (two clicks, by design), and the answer carries on by itself with no Continue and no trip to the Inbox. Repeat with a caution action: one click.
17. **Approval after it expired.** Raise an approval that has an expiry (for example a messaging-channel approval), wait past it with the card open, then click. Pass: the card says it expired and offers a next step, with no spinner left behind.
18. **Planning and research.** Turn Plan first on and ask "Plan and research the options for X, then give a recommendation"; then force a failure (deny a step's approval). Pass: the card counts steps as they finish, the failed step is named with Retry, and the final answer cites sources (today Plan first returns a fixed template, U-CH-045).
19. **Attached and generated documents.** Attach a long PDF and a long text file and ask about their last sections; ask for a document over 12,000 characters saved as PDF or DOCX. Pass: the answer or the card says when a document was cut (U-CH-035 says attached text is cut at 1,600 characters without a word today), and a created document's "Download the document" saves a file in the packaged app.
20. **Code Mode to the end.** Import a small git repository as a project; ask "Write a TypeScript helper that sums two numbers, run it and keep the output as a file"; approve once; also ask for a PDF made by running code. Pass: the card lists the artifact, it opens, Run named proof works, the PDF appears in the turn and in Library > Artifacts, and "Open run in Work" opens the run.
21. **Review answer.** Turn on Review answer in the plus menu and ask a question with a checkable fact. Pass: "Reviewing the answer" shows while it runs, and a readable review result appears under the answer (the stub could only show "Review unavailable").
22. **Prompt pack with variables.** Import or create a pack with run variables, open Commands and context in the composer, choose it, fill the form, send. Pass: the values appear in the sent message.
23. **Web search and Firecrawl.** Capabilities > Connectors > Advanced setup > Web & Search: set the self-hosted Firecrawl base URL, add its host to the allowlist if asked (approve), Save, Test connection; then in Chat turn Web on and ask a question that needs a web page. Pass: the save is confirmed, the test says Reachable or says why not, and the answer's source is the configured Firecrawl.
24. **Browser errand.** Ask "Open example.com in a browser errand and read the heading"; at the first approval card check it shows the page and the step, Deny, then start another and press Stop. Afterwards open System > Browser sessions, read its grants, close it. Pass: the card says the errand ended after the denial, Stop stops it, and the session and its grants are readable.
25. **Skills by name, once the switch exists.** After batch 1 (or by setting `GOATCITADEL_FEATURE_CHAT_SKILL_INSTRUCTIONS_V1_ENABLED=true` for the Gateway), type `use debugging` in Chat; switch the skill off and try again; send a message with only a common word. Pass: the turn says which skill loaded, a switched-off skill says it is off, and the common word loads nothing.

### Capabilities, Library and System

26. **Static MCP server end to end.** On a host with a keychain, turn on Chat access for static MCP first; no Settings screen can (U-CP-015), so either tick "Also let Chat use connectors" while installing any template connector, or set `features.chatStaticMcpV1Enabled` through the settings API, or set `GOATCITADEL_FEATURE_CHAT_STATIC_MCP_V1_ENABLED=true` for the Gateway and restart. Then register a stdio echo server, Connect reviewed server, then ask Chat to call its tool. Pass: the tool appears under the cached tool inventory and the first call asks for approval.
27. **Connector credential error.** On a host with a keychain: Connectors > Brave Search > Set up > Advanced setup, paste a deliberately wrong key, Check and save. Pass: the refusal names the problem; clearing the key works.
28. **Git skill import.** Capabilities > Skills > Import from Git with a public GitHub skill repository; Check, Install, switch on; approve. Pass: the skill is listed as on and usable in Chat.
29. **Library > Memory by keyboard.** With memory administration on (after batch 1, or by setting `GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED=true` for the Gateway and restarting) and at least one memory item (approve a memory write from Chat first): Tab to the item in Library > Memory, press Enter, edit it, approve; then forget another, approve. Pass: focus is visible throughout and returns to the item (or its list position) after each approval.
30. **Knowledge with citations.** With a real embedding provider: add a knowledge source, run Review knowledge indexing, then ask a question the source answers. Pass: the answer carries a citation to the source.
31. **Spend, runs and diagnostics.** After a day with a real provider, check that System > Spend's daily total equals the sum of its call rows; start a long Chat turn, open Work > Runs and use its run control; press Export recent diagnostics and read the file. Pass: totals match, the run control acts, and the file holds the recent entries with the personal-data warning.
32. **Backup restore.** Stop the Gateway, run `goatcitadel admin backup restore --file <backup-file> --confirm` (or `pg_restore` for Postgres), start again. Pass: the restored data is there. (No screen links to this procedure.)

### Access and devices

33. **Token sign-in.** Settings > Access > Configure access > Token > enter a credential > Save access settings; Generate install token; revoke it from the same page; pair the companion app and approve it under Approved devices. Pass: each step confirms, a revoked token stops working, and the paired device appears.
34. **Second device.** With Chat open on two machines (or a PC and a phone), send from one. Pass: the other shows the message within about 10 seconds without a reload.

### Messaging channels and integrations

35. **One real message in and out per shipped channel.** Chat > Messaging > Add > the channel's tile; follow every step: credential, who may message, where it posts, Turn on. Pass: the status reads working; a message from your phone or app appears under the channel within about 10 seconds; a reply typed in Chat (or by the agent) arrives in your app; a sender you did not allow does not open a conversation (System > Diagnostics shows the dropped message). Per channel:
    - Telegram: bot key from BotFather, the "say hi" step.
    - Discord: Developer Portal bot token with Message Content Intent on; invite the bot; choose where it posts.
    - Slack: the Create the Slack app link; Bot token and App-level token.
    - WhatsApp (Cloud API): save your public https address first; phone number id, business account id, app id and secret; point Meta at the shown callback address.
    - Microsoft Teams (sends only): a Workflows webhook; the test posts a card.
    - Google Chat, LINE, WeCom, QQBot, Nextcloud Talk: Advanced channel setup > Start guided setup, a public address to receive, Validate the draft, Finish setup, Verify the first conversation; add your own sender id under "Who may message this bot?".
    - Matrix, Mattermost, ntfy, Zalo OA: the same Advanced route; Matrix needs a bot account in an unencrypted room.
36. **Wrong credential with a working keychain.** On your desktop, start Telegram, Discord and Slack setup and enter a deliberately wrong token. Pass: the message names the vendor's refusal (the review could only see the "no secure storage" path, U-MS-001).
37. **Retired channel kinds.** Only if you still hold a Zalo Personal, Signal or iMessage connection: open it from Chat > Messaging. Pass: it says it is no longer supported and offers only removal.
38. **Google sign-in (Gmail and Calendar).** Create an OAuth client of type Desktop app with the Gmail and Calendar APIs enabled. Capabilities > Connectors > Gmail and Google Calendar > Set up > Advanced setup > Add and manage integrations > Add integration connection, paste the client ID, Review, Apply; Manage > Connect Google > choose capabilities, paste the client secret > Continue; in the desktop app click "Open Google setup in browser", finish there, then Refresh sign-in status. Pass: the default browser opens the sign-in, the connection reads connected with the chosen capabilities, a Gmail read works in Chat, a send or an event asks for approval every time, and Disconnect returns it to not connected and says whether Google revoked access.
39. **Vendor MCP connector.** Capabilities > Connectors > a vendor you have an account with (for example Asana) > Install > Sign in and install; approve in the Inbox; return, Open sign-in page, sign in, return. Pass: the panel carries on without a reload to Connected; with "Also let Chat use connectors" ticked, a read in Chat runs without asking and a change asks first.

### Browsers, accessibility and long runs

40. **Firefox and WebKit.** `pnpm exec playwright install firefox webkit` (a download), start a sandbox with `pnpm testbench`, then `node scripts/verification/cross-browser-smoke.mjs --ui <UI URL>`. Pass: one ok line per engine for every area.
41. **Real browsers by hand.** In Firefox and Safari at 1440 and 390 px: send by Enter and by Send, Japanese input Enter, open and cancel an approval review, open the inspector by keyboard, reload in the dark theme, Tab through Chat, Inbox and Library. Pass: no send while composing, no light flash, focus ring always visible.
42. **Screen readers.** With NVDA, Narrator or VoiceOver: switch areas, send a message and hear the reply, press J and K in the Inbox, open an approval dialog, press Back with an unsaved setting. Pass: each is announced and focus never lands on a hidden element (U-GL-025 says area changes are silent today).
43. **Four hours.** Leave Chat and an idle Inbox open in two tabs; record JS heap size and requests per minute at each hour. Pass: both stay roughly flat.
44. **Production performance.** On a production build run the Cockpit performance proof (`scripts/verification/lib/scenarios/cockpit-performance-proof.mjs` through its verification lane) and profile leaving and returning to Chat while a stream runs. Pass: at most 20 startup requests and 350,000 bytes of initial JavaScript (gzip), and a running stream reattaches without duplicates.
45. **Nightly UX budgets.** `gh workflow run verification-ux-budgets-nightly.yml --ref main` once, then class each failure as harness, product or environment. Pass: the run completes and every failure has a class. A 1,000-record run of the long-list proof waits until that proof counts rows (System > Quality also reads at most 200 prompt packs and does not say so).

### More journeys the walks could not finish

46. **Publish a Managed project file through the overwrite review (CH-16).** On a connection where Auto mode loads (today that means token sign-in; see U-CH-018): open a project conversation, choose Managed files, publish a saved file to the original folder, change the file on disk, publish again. Pass: the overwrite review shows what will be replaced and Cancel leaves the file alone; publishing again after editing shows the review lock.
47. **Unsaved edit in the code workbench (PJ-2).** In a project conversation ask for a change with Code Mode, open the code workbench from the conversation, edit a file, Save; then edit again and, without saving, press Back and then click a sidebar entry. Pass: Save writes the file, and leaving with an unsaved edit asks first (Save and continue, Keep draft and close, Discard changes, Cancel).
48. **Retry a failed run from Work (WK-2).** With a real model, start a supervised plan that fails, open its run in Work, press Retry, read the dialog ("Steps and external effects may run again") and confirm. Pass: the dialog says what will run again and the retried run appears with its own status.
49. **Follow a policy block to its rule (ST-6).** Set the file-copy tool to Denied, then in Chat ask for a file copy; read the tool row and try to reach the blocking rule from it. Pass: the row names the rule and links to where it can be changed (U-ST-025 says it does not today).
50. **Real models, earlier-review check OL-04.** (a) Pick a cloud model with tools and ask it to run a tool: the approval and run cards show action, scope and result. (b) Pick a reasoning model with thinking on and watch the thinking stream, recording frame times in the browser's Performance panel: frames under 50 ms. (c) With a local llama.cpp model, leave two idle Chat tabs for 3 minutes and count requests in the Network tab: 6 or fewer per minute per tab.
51. **Live updates when something goes wrong.** With two tabs (or two devices, item 34) on the same page, take one offline in DevTools for 30 s, change something in the other, then bring the first back. Pass: it catches up within about 10 seconds without a reload. Not tried by the review.

## 7. What was not covered and why

**Test setup.** Every area was walked in a throwaway sandbox started from this worktree: its own home, database and backup folder, auth mode `none`, the scripted stub model (fixed short replies in about 0.4 s), and no OS keychain (secure storage switched off on purpose so nothing touched the real keychain). The UI was the development server build, except two checks run on a production build: large data and the credential box. A second sandbox with token sign-in was used to compare auth modes. One pass used a real model through the Claude CLI already signed in on this PC: 14 of the 30 model requests the review allowed, and no paid API. No real API key, password or account was typed, and no message, email or webhook left the PC.

**Not covered:**
- **Classic shell and the mobile app**: out of scope by decision. The check of every link out of the Cockpit (GL-2) found no Cockpit task that ends in Classic. What it did find: four actions that exist only on Classic pages with no link to them (RC-07: U-WK-001 task deliverables, U-LB-005 skill evaluation runs, U-IN-004 the notification feed, U-ST-017 the Spend link from Budgets), and the first-visit redirect to setup that only Classic has (U-FR-014).
- **The packaged desktop app**: not built or launched. It opens a visible window on your PC, so it is left for you (section 6, checks 1-8). The installer and first database start were read in code only (FR-4, FR-5, NOT RUN). Checks in section 6.
- **Real channels, sign-ins and vendor connectors**: no credentials were entered, by rule. Channel setup was followed to the credential step with deliberately invalid values, which the sandbox's missing keychain stopped before any vendor saw them, so no vendor error text was read. Google sign-in and a vendor MCP connector stopped before the browser hand-off.
- **Real models** beyond the one pass: streaming pace, long answers, stopping mid-stream (except in the real-model pass), research with sources, delegated steps that fail, Code Mode to completion, cited knowledge answers, review of an answer, prompt packs with variables.
- **Docker, basic auth and access through a proxy**: not run. Token sign-in was run on a second sandbox; basic auth was not.
- **A second device** for live updates: two tabs in one browser were used (GL-4 PASS); a second machine or a phone was not, and no failure case (a change made while the other tab was disconnected or hidden) was tried.
- **Stopping or restarting the Gateway** on the same data (recovery after an outage), stopping a live run or service, restore from backup (read in code only: a live Gateway refuses it; the operator path is `goatcitadel admin backup restore --file <backup-file> --confirm` with the Gateway stopped).
- **Destructive or outside actions**: installing a plugin that downloads, a Git import from the internet, Export recent diagnostics (a download), a Library memory item by keyboard (the sandbox had none then), screen readers, Firefox and WebKit, a four-hour session, 10,000 messages in one thread.
- **Long real conversations**: opening the 300-message test thread took 909 ms on the production build, with plain short replies; close to the 1 second line. A long conversation with rich markdown was not tried.

Leftovers in the shared sandbox (not on your install): a skill row from an uninstalled test plugin, a test note file, a prompt-pack run record, test conversations and tasks, a pending "Install Asana" approval and a public web address. The sandbox has been stopped; nothing from this review is still running on your PC.

## 8. Withdrawn and unconfirmed

**Removed from the findings** (from [withdrawn.json](2026-11-usability/withdrawn.json)): 1 withdrawn because it did not reproduce, 8 moved to engineering notes because they have no symptom an operator can see (they are listed in root-causes.md under "Engineering notes"). Reasons are quoted from the file. Where a reason says 'ledger b4', it refers to the fourth batch of earlier-review verdicts in prior-register.json.

| ID | Now | Title | Reason |
|---|---|---|---|
| U-CH-007 | Engineering note | The Chat inspector is re-registered on every controller render, so it renders twice while open | Render count only (the inspector registers twice); no operator-visible symptom was measured. |
| U-GL-002 | Engineering note | Opening any non-Chat page still loads the whole Chat module graph | Bundle structure (non-Chat pages load the Chat module graph); the production build opens every area in under 1 s (the token sign-in check), so no operator-visible cost was shown. |
| U-GL-014 | Engineering note | Raw buttons and literal radii still sit beside the shared Button and radius tokens | Developer hygiene (raw buttons and literal radii beside the shared primitives); no operator-visible symptom of its own (ledger b4, GL-42). |
| U-GL-015 | Engineering note | The Cockpit still overrides 67 Classic/shared class names with selectors of different strength | Developer hygiene (67 Classic/shared class names restyled with mixed selector strength); the register row itself says not operator-visible (ledger b4, GL-43). |
| U-GL-017 | Engineering note | The bundle budget check measures the entry stub, not the Cockpit that loads first | Build tooling: the bundle budget check measures the entry stub, not the Cockpit (ledger b4, GL-48). |
| U-GL-018 | Engineering note | Tailwind still scans the whole app folder (Classic, tests, mockups) | Build tooling: Tailwind scans the whole app folder; no styling is missing, the cost is build work (ledger b4, GL-50). |
| U-GL-028 | Withdrawn | On a phone, the More tab does not look selected while you are in Capabilities, System or Settings | Not reproduced: the More tab carries aria-current=page and a teal underline in Capabilities, System and Settings in both themes (gl-7-system-375-light.png and the finding's own NV-18.png show the underline). |
| U-ST-032 | Engineering note | Safety > Tools lists dozens of identical-looking 'Allow - Session' grants with only 'Inspect grant' and 'Revoke grant' to tell them apart | The 171 near-identical grants were most likely seeded by earlier test tasks in the shared sandbox; not shown to occur on a real install (the Settings review). |
| U-WK-007 | Engineering note | Each owner link in Work and Inbox lists mounts its own navigation handoff owner | Code structure only (one navigation handoff owner per link); impact on speed was never measured and no operator symptom is described. |

Also not in the findings: U-GL-044 (the gear menu named "Settings and account" has no account entry) was merged into U-ST-004, the same control with the live measurement; and U-CH-029 (a danger approval takes two clicks) was recorded as a design decision, because DESIGN.md:60 specifies it (section 9, question 1). A greeting that started a code search in one project (seen only because the stub model returns an empty turn) and "Run workspace unknown" on test-fixture runs were dropped as artifacts of the test setup.

**Likely, not reproduced.** 64 findings are rated `likely`: traced in the code (or seen once) but not reproduced end to end. Treat them as strong leads, not certainties.

- U-FR-001 (stall): After one save with a lost response, the approval rule cannot be saved again, and first-run Finish stays disabled, until the page is reloaded.
- Friction (18): U-FR-011, U-FR-015, U-FR-013, U-GL-025, U-CH-012, U-CH-025, U-ST-023, U-IN-003, U-CH-035, U-CH-049, U-ST-025, U-LB-005, U-WK-012, U-WK-013, U-CP-020, U-MS-007, U-FR-008, U-FR-009.
- Polish (45): U-ST-029, U-CH-043, U-GL-019, U-GL-029, U-GL-030, U-GL-031, U-GL-032, U-GL-033, U-GL-037, U-GL-039, U-GL-041, U-GL-042, U-GL-043, U-CH-003, U-CH-004, U-CH-005, U-CH-006, U-CH-008, U-CH-009, U-CH-010, U-CH-011, U-CH-013, U-CH-015, U-CH-016, U-ST-003, U-ST-006, U-ST-007, U-ST-011, U-ST-013, U-ST-015, U-CH-014, U-CH-031, U-CH-041, U-IN-002, U-IN-004, U-IN-005, U-CH-040, U-LB-001, U-LB-003, U-LB-007, U-SY-017, U-WK-006, U-WK-008, U-IN-013, U-CH-027.

**Severe findings that a deliberate disproof pass downgraded.** Before ranking, a separate pass tried to disprove every blocker and stall. None was withdrawn; five were downgraded:
- U-ST-029 (the credential box crash) was a blocker candidate. A production build did not crash in 0 of 5 loads and a 20-character key was submitted; the crash comes from React's development-only double call of a state updater. Now polish and likely, with the one-line fix in batch 1 because a production crash stays possible if the updater ever runs late.
- U-FR-015 (a failed bundled-database start) is friction and likely: the recovery screen does offer Open Logs and the window changes to recovery after 180 s; the cause is only in the log. Read in code only.
- U-ST-008 (webhook destination needs a keychain reference) is friction: the other destination kind, a configured channel, works.
- U-FR-004 (Check connection for LM Studio or llama.cpp says nothing when the server is down) is friction: the right sentence exists in the code but only on the step list that first run hides.
- U-MS-001 (Telegram, Discord and Slack blame the key) is friction: it happens only on hosts without secure credential storage; on a Windows desktop with a working keychain the message is correct.

## 9. Design decisions for you

Current behaviour that DESIGN.md or PRODUCT.md specifies, or that no document settles, is not a finding. Each question says what it rests on and what would change.

**The three that change the most:**

1. **Should a danger approval take one click where the card already shows what will run?** Today a danger approval takes two clicks (a red review button, then Approve once) and caution or safe take one; in the Inbox it takes three, because the row's Review opens the panel first (U-IN-015). This rests on DESIGN.md:60 ("A danger or nuclear approval is a red, risk-labelled review button"), against your stated wish for at most one click. If you choose one click: use the existing one-click path in `apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx:43` where the card already shows the command, keep the typed confirmation for nuclear, change DESIGN.md:60, and batch "waiting on a design decision" (RC-76) clears U-IN-015, U-CH-014 and U-CH-042.
2. **Should installs in the default auth mode get Auto mode and Managed project files in Chat?** In the default mode (`none`, what the desktop app ships with) the Gateway cannot prove a caller is local, so every project conversation shows "Approval mode unavailable" with a Retry that cannot work, and Managed files never appears; an install with token sign-in has both (U-CH-018, compared on both setups). No document states this; it rests on the Gateway rule in `apps/gateway/src/routes/session-control-request-context.ts:154` and PRODUCT.md:24 (risky actions stay governed). If yes: let loopback requests count as the local operator when sign-in is off. If no: the composer and Settings > Access should say "needs sign-in" instead of offering Retry (batch 9).
3. **Should the Cockpit send a first-time visitor to setup, as Classic does?** Today a bare install opens on Chat with no model, and only the Classic shell redirects a first visit to guided setup (U-FR-014). No document settles it; PRODUCT.md:13 promises first-timers "guided setup, safer defaults". If yes: port Classic's first-destination guard (batch 10), so that until a model is confirmed the first visit opens Settings > Get started.

**The rest**, from root-causes.md (earlier review ids in brackets where the question came from one):

4. Should risk labels read Low, Medium, High, Critical instead of Safe, Caution, Danger, Nuclear (GL-08)? Rests on DESIGN.md:54, :60, :71. Other way: change the shared presenter and DESIGN.md; policy values stay.
5. Should surfaces (canvas, raised, sunken) differ more than by hairlines (GL-34)? Rests on DESIGN.md:30 and :48. Other way: widen the surface ladder.
6. Should text tiers in dark mode differ more (GL-35)? Rests on DESIGN.md:31. Other way: widen the tiers.
7. Should tabs drop the Citadel names ("Rules · Wards", ST-14)? Rests on DESIGN.md:69 (plain names first, Citadel second).
8. No bordered box inside another (ST-16): already met (DESIGN.md:103); listed because an earlier review asked for a change.
9. Should Dashboards and Quality move out of System to an expert-only place (SY-09)? Rests on PRODUCT.md:37 and :15. Moving them would also take most System > Quality polish findings off the default path.
10. Should pages that update live drop their manual Refresh (GL-57)? Rests on DESIGN.md:102. Dropping it would also clear U-ST-014 and the focus loss after Refresh in U-GL-047.
11. Should "running" get its own status colour (GL-60)? Rests on DESIGN.md:34 and :54.
12. Is turning on an install-wide skill meant to be a danger approval that takes one click in Capabilities and two in the Inbox, with no danger review in either? Rests on DESIGN.md:60.
13. Should turning on a built-in, trusted skill or tool group ask for approval labelled Danger while turning it off is instant? Rests on PRODUCT.md:24. Other way: a lower risk label for built-in skills.
14. Should reversible actions (archive, restore, pause, resume, switching an integration) apply at once with an Undo instead of a review dialog? DESIGN.md:58 lists them as reversible and does not ask for a dialog. Yes clears U-WK-010 and U-ST-011 (RC-77).
15. Should a budget change be governed like other Settings? Today it applies at once; the Budgets page calls it a preference, and PRODUCT.md:24 governs risky actions, not preferences.
16. Should first run pre-confirm the safe default approval rule instead of asking "Keep current rule"? Rests on PRODUCT.md:13.
17. Editing the first message branches the conversation and hides version 1's later turns behind a version selector, while the list keeps the old title. No document covers it. Other way: keep later turns visible, or retitle from the current version.
18. Prompt packs appear in the composer only when they have a run-variable schema, and no screen creates one. No document covers it. Other way: list every pack.
19. The Chat composer keeps an unsent draft silently when you leave, while Settings, Work and Library editors ask (DESIGN.md:62 specifies the prompt for editors). Other way: one rule for both.
20. A first-time operator on a token sign-in install must find the token themselves; the sign-in page gives no hint where it is printed. Rests on PRODUCT.md:13. Other way: one sentence saying where to find it.
21. Messaging channels are "beta" in the catalogue (13 of 14) but no screen says so, and the picker's time estimate differs from the setup page's. PRODUCT.md:21 and DESIGN.md:69 ask experimental things to say so. Other way: a "beta" label and one estimate.
22. "Plan first" stays on after sending, so the next message is planned too. No document covers it. Other way: a one-message option.
23. Spend shows cost per provider and recent calls, not per model. PRODUCT.md:37 puts cost in System without detail. Other way: a per-model breakdown.
24. Dashboards can be archived and restored but not deleted (DESIGN.md:58 treats archive as the reversible path). Other way: a governed delete.
25. System > Sessions lists every workspace's conversations while its controls work only in the selected workspace (the cost is U-SY-009, batch 7). PRODUCT.md:37 puts runtime truth in System. Decide which gives way: list only the selected workspace, or let the controls switch workspace.

**A note outside usability.** U-PJ-006: a project accepts a drive-letter path such as `C:/folder`, and the Gateway resolves it with `path.resolve`, which may point outside the workspace root (`apps/gateway/src/services/chat-workbench-service.ts:1029`). This review did not test it; it is worth a path-safety look by someone doing a security review before batch 24.

## Appendix: numbers

Output of `node docs/review/2026-11-usability/tools/report-numbers.cjs` (run on the final data; `--check` on this file passes):

```text
findings: 217
  by severity: blocker 0, stall 11, friction 103, polish 103
  confidence: confirmed 153, likely 64 (likely by severity: blocker 0, stall 1, friction 18, polish 45)
  found by: live 53, both 107, code 57 (seen live, live or both: 160; read in code only: 57)
  carried from earlier reviews (priorIds set): 100; with no journey of this review: 80
  by area (stall / friction / polish / total):
    capabilities: 3 / 13 / 2 / 18
    chat: 1 / 16 / 26 / 43
    first-run: 1 / 12 / 0 / 13
    global: 0 / 12 / 30 / 42
    inbox: 0 / 6 / 8 / 14
    library: 1 / 9 / 6 / 16
    messaging: 1 / 5 / 1 / 7
    projects: 0 / 2 / 2 / 4
    settings: 2 / 12 / 15 / 29
    system: 1 / 8 / 5 / 14
    work: 1 / 8 / 8 / 17

stalls (11): every install 8, more than one workspace 2, read in code only 1; in rank order:
  1 U-LB-008 RC-01 confirmed/both [every install]
  2 U-ST-001 RC-02 confirmed/both [more than one workspace]
  3 U-ST-021 RC-03 confirmed/live [every install]
  4 U-CP-004 RC-04 confirmed/both [every install]
  5 U-SY-009 RC-05 confirmed/live [more than one workspace]
  6 U-FR-001 RC-03 likely/code [read in code only]
  7 U-CH-044 RC-01 confirmed/both [every install]
  8 U-CP-014 RC-06 confirmed/both [every install]
  9 U-CP-015 RC-01 confirmed/both [every install]
  10 U-WK-001 RC-07 confirmed/both [every install]
  11 U-MS-005 RC-03 confirmed/live [every install]

root causes: 95; with more than one finding: 48; findings without a cause: 0
  RC-51: 20 (friction 2, polish 18)
  RC-18: 12 (friction 3, polish 9)
  RC-30: 11 (friction 1, polish 10)
  RC-53: 8 (friction 2, polish 6)
  RC-01: 5 (stall 3, friction 2)
  RC-21: 5 (friction 2, polish 3)
  RC-28: 5 (friction 1, polish 4)
  RC-03: 4 (stall 3, friction 1)
  RC-07: 4 (stall 1, friction 1, polish 2)
  RC-31: 4 (friction 1, polish 3)
  RC-39: 4 (friction 2, polish 2)
  RC-78: 4 (polish 4)
  RC-04: 3 (stall 1, friction 2)
  RC-05: 3 (stall 1, friction 1, polish 1)
  RC-11: 3 (friction 2, polish 1)
  RC-13: 3 (friction 3)
  RC-14: 3 (friction 3)
  RC-16: 3 (friction 3)
  RC-26: 3 (friction 3)
  RC-73: 3 (friction 2, polish 1)
  RC-76: 3 (polish 3)
  RC-79: 3 (polish 3)
  RC-81: 3 (polish 3)
  RC-83: 3 (polish 3)
  RC-09: 2 (friction 2)
  RC-10: 2 (friction 1, polish 1)
  RC-12: 2 (friction 2)
  RC-17: 2 (friction 2)
  RC-22: 2 (friction 2)
  RC-23: 2 (friction 2)
  RC-32: 2 (friction 2)
  RC-33: 2 (friction 2)
  RC-38: 2 (friction 1, polish 1)
  RC-44: 2 (friction 2)
  RC-45: 2 (friction 2)
  RC-46: 2 (friction 2)
  RC-59: 2 (friction 1, polish 1)
  RC-60: 2 (friction 1, polish 1)
  RC-61: 2 (friction 1, polish 1)
  RC-65: 2 (friction 2)
  RC-68: 2 (friction 2)
  RC-70: 2 (friction 2)
  RC-71: 2 (friction 1, polish 1)
  RC-72: 2 (friction 2)
  RC-77: 2 (polish 2)
  RC-80: 2 (polish 2)
  RC-88: 2 (polish 2)
  RC-95: 2 (polish 2)
  RC-02: 1 (stall 1)
  RC-06: 1 (stall 1)
  RC-08: 1 (friction 1)
  RC-15: 1 (friction 1)
  RC-19: 1 (friction 1)
  RC-20: 1 (friction 1)
  RC-24: 1 (friction 1)
  RC-25: 1 (friction 1)
  RC-27: 1 (friction 1)
  RC-29: 1 (friction 1)
  RC-34: 1 (friction 1)
  RC-35: 1 (friction 1)
  RC-36: 1 (friction 1)
  RC-37: 1 (friction 1)
  RC-40: 1 (friction 1)
  RC-41: 1 (friction 1)
  RC-42: 1 (friction 1)
  RC-43: 1 (friction 1)
  RC-47: 1 (friction 1)
  RC-48: 1 (friction 1)
  RC-49: 1 (friction 1)
  RC-50: 1 (friction 1)
  RC-52: 1 (friction 1)
  RC-54: 1 (friction 1)
  RC-55: 1 (friction 1)
  RC-56: 1 (friction 1)
  RC-57: 1 (friction 1)
  RC-58: 1 (friction 1)
  RC-62: 1 (friction 1)
  RC-63: 1 (friction 1)
  RC-64: 1 (friction 1)
  RC-66: 1 (friction 1)
  RC-67: 1 (friction 1)
  RC-69: 1 (friction 1)
  RC-74: 1 (polish 1)
  RC-75: 1 (polish 1)
  RC-82: 1 (polish 1)
  RC-84: 1 (polish 1)
  RC-85: 1 (polish 1)
  RC-86: 1 (polish 1)
  RC-87: 1 (polish 1)
  RC-89: 1 (polish 1)
  RC-90: 1 (polish 1)
  RC-91: 1 (polish 1)
  RC-92: 1 (polish 1)
  RC-93: 1 (polish 1)
  RC-94: 1 (polish 1)

journeys walked in the area reviews: 70
  PASS 9, FAIL 18, PARTLY RUN 38, NOT RUN 5
  failed journeys that involve a stall: 7 (CH-14, WK-1, CP-3, SY-2, SY-4, ST-2, FR-1)
  repeated with real model: 5 (PASS 3, FAIL 1, PARTLY RUN 1, NOT RUN 0)
  repeated with token sign-in: 9 (PASS 1, FAIL 4, PARTLY RUN 4, NOT RUN 0)
  other checks: Outage PARTLY RUN [U-CH-026 U-CH-027], ST-none PARTLY RUN [U-ST-030 U-ST-029]
  CH-1 PASS [1] U-CH-024
  CH-2 PARTLY RUN [2] U-CH-018 U-CH-025
  CH-3 FAIL [2] U-CH-020 U-CH-028
  CH-4 PARTLY RUN [2] U-ST-005 U-CH-021
  CH-5 PASS [1] U-CH-018
  CH-6 PARTLY RUN [2] U-CH-018 U-CH-023
  CH-7 PARTLY RUN [1] U-CH-003
  CH-8 FAIL [1] U-CH-022
  CH-9 PARTLY RUN [4] U-IN-001 U-CH-014 U-CH-041 U-CH-042
  CH-10 PARTLY RUN [1] U-CH-031
  CH-11 FAIL [4] U-CH-032 U-CH-033 U-CH-028 U-CH-034
  CH-12 PARTLY RUN [3] U-CH-020 U-CH-035 U-CH-036
  CH-13 PARTLY RUN [3] U-CH-018 U-CH-038 U-CH-043
  CH-14 FAIL [1] U-CH-044
  CH-15 NOT RUN [0]
  CH-16 NOT RUN [2] U-CH-018 U-CH-040
  PJ-1 PARTLY RUN [6] U-CH-018 U-PJ-001 U-PJ-006 U-CH-028 U-CH-043 U-PJ-004
  PJ-2 PARTLY RUN [2] U-CH-043 U-PJ-005
  IN-1 FAIL [6] U-IN-001 U-IN-008 U-IN-011 U-IN-016 U-IN-010 U-IN-015
  IN-2 PARTLY RUN [2] U-IN-012 U-IN-013
  IN-3 FAIL [3] U-IN-006 U-IN-015 U-IN-014
  WK-1 FAIL [4] U-WK-001 U-WK-005 U-WK-015 U-WK-016
  WK-2 PARTLY RUN [2] U-WK-004 U-WK-011
  WK-3 FAIL [4] U-WK-012 U-WK-013 U-WK-014 U-WK-010
  WK-4 PASS [4] U-WK-003 U-WK-010 U-WK-002 U-WK-017
  CP-1 PARTLY RUN [0]
  CP-2 PARTLY RUN [2] U-CP-004 U-CP-001
  CP-3 FAIL [3] U-CP-004 U-CP-005 U-CP-006
  CP-4 PARTLY RUN [1] U-CP-007
  CP-5 PARTLY RUN [4] U-CP-014 U-CP-015 U-CP-013 U-CP-011
  CP-6 PARTLY RUN [1] U-CP-012
  LB-1 PARTLY RUN [6] U-LB-008 U-LB-002 U-LB-009 U-LB-010 U-LB-011 U-LB-003
  LB-2 PARTLY RUN [2] U-LB-002 U-LB-012
  LB-3 PARTLY RUN [3] U-LB-013 U-LB-014 U-LB-015
  LB-4 PARTLY RUN [2] U-LB-002 U-LB-016
  SY-1 PARTLY RUN [2] U-SY-002 U-SY-001
  SY-2 FAIL [3] U-SY-009 U-SY-010 U-SY-001
  SY-3 PARTLY RUN [0]
  SY-4 FAIL [5] U-SY-009 U-SY-016 U-GL-020 U-SY-005 U-SY-015
  SY-5 PARTLY RUN [1] U-SY-011
  SY-6 PARTLY RUN [2] U-GL-019 U-SY-014
  SY-7 PARTLY RUN [3] U-SY-006 U-SY-013 U-SY-017
  ST-1 PARTLY RUN [7] U-ST-005 U-ST-002 U-ST-022 U-ST-023 U-ST-030 U-ST-029 U-ST-014
  ST-2 FAIL [3] U-ST-001 U-ST-021 U-ST-020
  ST-3 PARTLY RUN [1] U-ST-021
  ST-4 PARTLY RUN [2] U-ST-030 U-ST-012
  ST-5 PARTLY RUN [1] U-CH-018
  ST-6 PARTLY RUN [2] U-ST-020 U-ST-025
  ST-7 PASS [1] U-ST-028
  ST-8 PARTLY RUN [1] U-ST-031
  ST-9 PARTLY RUN [3] U-ST-023 U-ST-027 U-ST-014
  FR-1 FAIL [9] U-LB-008 U-SY-002 U-FR-004 U-FR-005 U-FR-012 U-FR-014 U-FR-016 U-ST-010 U-ST-029
  FR-2 PARTLY RUN [5] U-FR-001 U-CH-018 U-ST-010 U-FR-006 U-FR-013
  FR-3 NOT RUN [2] U-FR-008 U-FR-009
  FR-4 NOT RUN [1] U-FR-015
  FR-5 NOT RUN [1] U-FR-011
  GL-1 FAIL [4] U-CP-003 U-GL-051 U-SY-001 U-CH-017
  GL-2 PASS [0]
  GL-3 FAIL [5] U-GL-025 U-GL-046 U-GL-047 U-GL-039 U-GL-048
  GL-4 PASS [0]
  GL-5 FAIL [1] U-GL-050
  GL-6 FAIL [2] U-IN-006 U-GL-049
  GL-7 PASS [4] U-SY-002 U-GL-006 U-CH-048 U-GL-011
  GL-T FAIL [5] U-CH-020 U-GL-052 U-GL-053 U-IN-010 U-GL-054
  GL-L PASS [1] U-WK-018
  GL-P PASS [2] U-ST-033 U-ST-029
  MS-1 PARTLY RUN [9] U-ST-001 U-MS-005 U-ST-033 U-MS-001 U-MS-002 U-MS-003 U-MS-006 U-MS-007 U-MS-004
  MS-2 PARTLY RUN [0]
  MS-3 PARTLY RUN [8] U-CP-013 U-CP-016 U-CP-017 U-CP-018 U-CP-020 U-CP-021 U-CP-011 U-CP-019
  MS-4 PARTLY RUN [6] U-CH-032 U-CH-033 U-CH-045 U-CH-046 U-CH-047 U-CH-049

earlier-review register: 460 rows
  ledger-233: fixed 160, partial 43, open 16, obsolete 5, cannot-check 8
  ledger-233,owed-live: fixed 1
  followup-157: fixed 22, partial 24, open 19, cannot-check 3
  followup-157,comprehensive-138: fixed 1
  comprehensive-138: fixed 82, partial 1, operator-only 1, cannot-check 1
  parity-routes: fixed 31, partial 6, open 1, obsolete 1
  owed-live: fixed 4, partial 2, open 1, operator-only 25, cannot-check 2
  totals: fixed 301, partial 76, open 37, obsolete 6, operator-only 26, cannot-check 14
  open or partial as recorded: 113 rows
  corrections (root-causes.md "Register corrections"): N-04 partial U-CH-018; OL-07 partial U-CH-026+U-CH-027; OL-14 open U-CH-044
  totals with the 3 corrections: fixed 301, partial 78, open 38, obsolete 6, operator-only 24, cannot-check 13
  open or partial after corrections: 116 rows; now: finding 108, engineering-note 7, withdrawn 1; distinct current findings: 104
  operator-only or cannot-check rows: 40

withdrawn.json: 9 (engineering-note 8, withdrawn 1); merged into another finding: U-GL-044 into U-ST-004
```
