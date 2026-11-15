# Task 9: Capabilities and Library

Live runs: Playwright 1.58 headless, 1440x900 dark (CP-1 and CP-3's list also at 375x812 light), sandbox testbench Gateway (auth mode `none`, stub model). Evidence: `docs/review/2026-11-usability/evidence/cp/` and `.../lb/`. New findings are U-CP-004 to U-CP-012 and U-LB-008 to U-LB-016 (after the review fixes the findings referred to here as U-CP-008, U-CP-009 and U-CP-010 carry new titles and will get new ids when the controller re-merges; they are identified by journey and topic in this file). Carried findings in these areas before this task: U-CP-001 to U-CP-003 and U-LB-001 to U-LB-007 (none duplicated).

Setup and cleanup notes:
- Skill and plugin approvals raised from the `default` workspace and, once, from the verification workspace (CP-1) were approved in place from either: confirmed that skill approvals are install-wide and work from a non-default workspace.
- Every Approve once / Deny click was scoped to the card or dialog of the approval my own action raised (matched on its title, skill name or memory id).
- Fixtures: a local plugin folder (one skill `meeting-notes`, one prompt pack) and a 20-line stdio echo MCP server, both under the git-ignored scratch folder; one throwaway memory item created through the dev route `memory-item-seed` (same route `tools/seed.mjs` uses) and then edited and forgotten through the UI.
- Sandbox values read before LB-1: `GET /api/v1/settings` returned `features.memoryLifecycleAdminV1Enabled = true` (tools/seed.mjs lines 64-69 patch it on), `chatSkillInstructionsV1Enabled = false`, `chatStaticMcpV1Enabled = false`.

## CP-1 Skills: find a skill, switch it on, use it in Chat, switch it off
Result: PARTLY RUN
Findings: none new. The Chat half is blocked by the existing finding "On a default install, typing 'use <skill>' in Chat does nothing and says nothing" (task-7); see Notes on existing findings. Approval of switching a skill on is in place (one click), no Inbox trip.
Time: first feedback on switch off 151 ms; switch on: the in-place approval dialog was open within the 2.7 s window of the script, Approve once to the row reading On 243 ms. Not timed to the millisecond.
Code path: `capabilities/skills/SkillsTab.tsx` -> `InstalledView.tsx` / `SkillRow.tsx` / `SkillPanel.tsx` -> `use-skill-switch.ts` -> `POST /api/v1/capabilities/skills/state` (`apps/gateway/src/routes/capability-skills.ts:182`) -> `capability-skill-actions-service.ts`; approval shown by `settings/SettingsApprovalDialog` from `SkillPanelSwitch.tsx`.
Live:
1. Capabilities opens on Connectors the first time (DEFAULT_TAB); Skills tab > Installed lists 24 skills, all On except `genie-npu-ir20` ("Not usable yet - It hasn't been reviewed, so the AI can't use it", its switch still reads On).
2. Typed 'debug' in the search field (about 0.8 s to filter), View debugging: side panel with On badge, 'Turn it on or off', 'Takes effect in new chats.', Pause, Uses, Tags, Instructions.
3. Switched it off: applied at once, no approval, badge Off 'The AI can't use it' (151 ms). Switched it on: row goes 'Waiting for your approval', a toast 'Turn on skill bundled:debugging - Applies to every workspace - Open Inbox item' and an in-place dialog 'Approve skill state change - Turn debugging on - Danger' open. Approve once: row On in 243 ms.
4. Reload while the approval waited: the dialog reopens by itself but with a vaguer title ('Change debugging' instead of 'Turn debugging on'). Pause is instant with no approval ('Used when you name it, or on a close match if you allow it'); Resume asks for a Danger approval again (approved in place).
5. Keyboard: from the verification workspace focused the `planning` switch, Space switched it off, Space again raised the approval, approved in place, On. Skill approvals work from a non-default workspace.
6. Phone width, light theme: list and panel fit (scrollWidth 375), switch 44 px.
Failure tried: reload with an approval waiting (step 4); search with no match not tried.
Evidence: cp-1-search.png, cp-1-panel.png, cp-1-switch-off.png, cp-1-switch-on-approval.png, cp-1-reload-while-waiting.png, cp-1-switched-on-again.png, cp-1-paused.png, cp-1-other-ws-approval.png, cp-1-other-ws-final.png, cp-1-phone-light-list.png, cp-1-phone-light-panel.png.
Not covered: "use it in Chat" (skill instructions in Chat are off by default; no Cockpit screen turns them on). Operator steps: set `features.chatSkillInstructionsV1Enabled` true through the Settings API or `GOATCITADEL_FEATURE_CHAT_SKILL_INSTRUCTIONS_V1_ENABLED`, restart, type `use debugging` in Chat with a real model.

## CP-2 Import a skill from a folder and from a Git source; an import that collides with an existing id
Result: PARTLY RUN
Findings: U-CP-004 (the collision, reached through a plugin that carries a skill). Also carried: U-CP-001 not reached.
Time: Git address refused in 2.5 s watched window (browser-side refusal instant; Gateway refusal after one POST); plugin folder check 1076 ms.
Code path: `skills/SkillGitImport.tsx` (`sendableAddress`: https only, no credentials) -> `use-skill-install.ts` -> `POST /api/v1/capabilities/skills/reviews` -> `capability-skill-actions-service.ts` `trustedGitAddress` (host must be GitHub, GitLab, Bitbucket or Codeberg; refused before any network read). Discover packs: `DiscoverView.tsx` -> `SkillInstallPanel.tsx` (Check, Install, Switch on).
Live:
1. Skills tab has Import from Git, no import from a folder. The only folder import in the Cockpit is Plugins > Add from folder, and the only other route to a skill is Discover > Install of a listed pack. A skill folder dropped into a workspace's skills folder is described only as an origin label ('From this workspace's skills folder'); no screen says where that folder is.
2. Import from Git: 'Git repository address - From GitHub, GitLab, Bitbucket or Codeberg'. `/home/x/skill` and `http://example.invalid/skill.git` refused in the browser ('Enter an https address, like https://github.com/name/repo.'). `https://example.invalid/skill.git` went to the Gateway (422 on `/skills/reviews`) and came back 'GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.' without any fetch. Clear, with a next step.
3. Discover > Install on a GoatCitadel pack (GitHub gh CLI) ran its check in a few seconds and showed What it does / Where it comes from / What it asks for / Checks / What happens next ('Asks you twice') / Progress and 'Install and switch on'. Not installed: no Cockpit screen removes a skill afterwards, so it would have left a permanent skill in the sandbox.
4. Collision: with the first plugin uninstalled (CP-3), a second local plugin folder holding the same skill name was checked: the skill row says 'This skill was removed with an earlier install. It can't come back until skills can be removed.', the plugin 'So it can't be installed.', no Install button. The refusal is clear and names the cause; the earlier promise is not (U-CP-004).
Failure tried: untrusted Git host; a skill name already used.
Evidence: cp-2-git-panel.png, cp-2-git-refused.png, cp-2-pack-panel.png, cp-2-collision-check.png.
Not covered: import from a skill folder (no Cockpit screen), successful Git import (needs the internet; operator steps: Import from Git with a public GitHub skill repository, Check, Install and switch on, approve twice), a plain id collision between two skills (same cause as step 4).

## CP-3 Plugins: inspect, install, see what it added, uninstall (including the second uninstall when its skill is on)
Result: PASS for install; FAIL overall on uninstall guidance
Findings: U-CP-004, U-CP-005, U-CP-006. Also noted: the built-in 'Browser checks' plugin was inspected (adds the Playwright connector, which names registry.npmjs.org) and not installed, to avoid a download.
Time: Add from folder to checked panel 1076 ms; Install: first dialog at 562 ms, all three approvals done and 'Review task 9 plugin is installed.' at about 13.6 s (5 s of 'Asking...' between the second and third approval); uninstall first dialog 580 ms, second pass 518 ms.
Code path: `plugins/PluginsTab.tsx` -> `PluginSourceForm.tsx` -> `POST /api/v1/capabilities/plugins/inspections` -> `PluginInstallPanel.tsx` / `PluginInstallProgress.tsx` (in-place `SettingsApprovalDialog`) -> `plugin-source-service.ts` (folder source) and `capability-plugin-inspection-service.ts`; uninstall `PluginUninstall.tsx` -> `use-plugin-uninstall.ts` -> `plugin-uninstall-change-plan-adapter.ts`.
Live:
1. Plugins tab: search, Install from Git, Add from folder, 'No plugins yet', one Built in plugin (Browser checks, Ready to install).
2. Add from folder, relative path: 'Give the full path of a folder on this computer.' (browser-side, with help 'A folder on the computer GoatCitadel runs on'). Full path of a local folder: panel with What it is, Where it comes from ('Folder on this computer - Unverified - GoatCitadel hasn't reviewed this plugin'), What it adds (Skill meeting-notes, Prompt pack 'Meeting notes check 1.0 - Adds 2 tests to Library > Prompt packs. Nothing runs until you press Run.'), 'Asks you 3 times: once for the plugin and twice for its skill'.
3. Install: three in-place approvals ('Install Review task 9 plugin' Danger, 'Approve installing meeting-notes?', 'Approve switching on meeting-notes?'), all approved in place, no Inbox trip. Panel ends 'Review task 9 plugin is installed.'
4. What it added really appears: Skills list has `meeting-notes` 'From Review task 9 plugin' On; Library > Prompt packs has 'Meeting notes check 1.0 - 2 tests' beside the seeded pack.
5. Uninstall (skill on): confirmation 'This can't be undone here. Installing it again adds its pieces back.' > approval 'Delete the prompt pack ... Remove the skill meeting-notes' (Caution, in place) > badge 'Removing...' with both pieces Removed and a red 'Finish uninstalling' (U-CP-006) > second approval 'Remove the skill meeting-notes, so the AI can't use it' > plugin gone from the list. The skill stays in the Skills list as 'Removed with Review task 9 plugin' (U-CP-005). Reinstall: re-adding the original plugin was not run. A second plugin, B (another plugin id, same skill name `meeting-notes`, its own prompt pack), was added from a folder after the first was gone and was refused at the check: the skill row says 'This skill was removed with an earlier install. It can't come back until skills can be removed.' The refusal is about the skill's name, which the original plugin carries too, so it is equivalent for the original (U-CP-004).
6. Install-wide approvals confirmed from `default`; plugin approvals not raised from another workspace.
Failure tried: relative folder path; adding a second plugin with the same skill name after the first was uninstalled.
Evidence: cp-3-folder-refused.png, cp-3-folder-checked.png, cp-3-install-panel.png, cp-3-approval-1.png to cp-3-approval-3.png, cp-3-after-install.png, cp-3-plugin-list.png, cp-3-skill-in-list.png, cp-3-pack-in-library.png, cp-3-uninstall-1.png, cp-3-uninstall-dialog-1.png, cp-3-uninstall-dialog-3.png, cp-3-plugins-after-uninstall1.png, cp-3-removing-panel.png, cp-3-skill-after-uninstall1.png, cp-3-finish-dialog.png, cp-3-finish-after.png, cp-3-phone-light-plugins.png.
Not covered: a Git plugin (internet), the built-in Browser checks install (would register a connector that names registry.npmjs.org). Left in the sandbox: the skill row `meeting-notes` ('Removed with Review task 9 plugin'), which no screen removes.

## CP-4 Connectors: add a connector from a template up to the credential step with an invalid test credential; read the error; remove it
Result: PARTLY RUN
Findings: U-CP-007.
Time: Set up to panel 2.7 s watched window; Advanced setup link to page 3.1 s watched window.
Code path: `connectors/ConnectorsTab.tsx` -> `ConnectorRow.tsx` -> `ConnectorPanel.tsx` (`connector-install-copy.ts`: needs an API key means 'Set it up in Advanced setup') -> link `/capabilities/connectors/advanced#web-search` -> `settings/` web search credentials (`GET /api/v1/settings/web/credentials`).
Live:
1. Connectors lists 1 connected (Firecrawl), 4 on this device, 78 available. Only two rows say 'Needs an API key' (Brave Search, Parallel Search); every MCP template installs by sign-in ('Sign in and install' for Airtable, opens a provider sign-in, not run). The `n8n` token template is not in the list at all.
2. Brave Search > Set up: panel 'Needs an API key', one link 'Advanced setup'. It lands at the top of Web & Search on the Firecrawl settings; the Brave key field is 1518 px down (U-CP-007).
3. The key field is disabled in this sandbox ('The OS keychain is unavailable. Set GOATCITADEL_SEARCH_BRAVE_API_KEY or BRAVE_SEARCH_API_KEY in the GoatCitadel environment instead.'), so no placeholder could be typed; 'Check and save' would also contact api.search.brave.com (`approval-lifecycle-service.ts:1754` names the host), so it was not pressed. Nothing was created or half-configured; nothing to remove.
Failure tried: none possible (field disabled; a live check would leave the PC).
Evidence: cp-4-install-panel.png, cp-4-brave-row.png, cp-4-brave-panel.png, cp-4-advanced-websearch.png, cp-4-brave-anchor.json, cp-4-n8n-panel.png.
Not covered: the credential step and its error. Operator steps: on a host with an OS keychain, Connectors > Brave Search > Set up > Advanced setup, paste a deliberately wrong key into 'Brave Search API key', Check and save, read the refusal (the check is live), then clear it.

## CP-5 MCP: add a static MCP server, see its tools, use one in Chat
Result: PARTLY RUN
Findings: U-CP-008, U-CP-009, U-CP-010, U-CP-011.
Time: Review MCP registration to review dialog 2.5 s watched window; Register to saved confirmation under 1 s; Connect reviewed server answered 500 in 313 ms.
Code path: `ConnectorsTab.tsx` -> `settings/McpServerCreate.tsx` (stdio form: label, transport, command, arguments) -> `POST /api/v1/mcp/servers` -> `connectors/ConnectorPanel.tsx`; Advanced setup `settings/McpServersSettings.tsx` / `McpServerInspection.tsx` -> `POST /api/v1/mcp/servers/<id>/connect-reviewed`. Row state `capability-connectors-projection.ts:275-292`.
Live:
1. The repo's only MCP fixtures (`cockpit-mcp-connection-fixture.mjs`, `worker-mcp-stdio.mjs`) return no tools or are packaging-only, so a 20-line stdio echo server (tool `echo`) was written and registered by command.
2. Add your own > Register MCP server (71 templates, search, category, and 'Allow <host>' buttons beside templates that change the network allowlist) > label, Local process (stdio), command, arguments > Review MCP registration ('This saves a new server for the whole installation. No connection, process launch, OAuth handshake or tool call is performed.') > Register reviewed MCP server: saved, no approval.
3. The row reads 'Connected' (U-CP-008) and 'Connected - not available in Chat'; the dialog stays open with a raw 'Saved server ID' (U-CP-011).
4. Advanced setup > Inspect: '5 steps from setup to a verified task' (Saved, Connected, Discovered, Callable, Tested) and Review connection > Connect reviewed server. It failed (U-CP-009): the cause in this run was the sandbox's missing OS keychain ('OS keychain backend is unavailable on this host', read from the Gateway record). The row said 'open it to see why'; with the default Settings 'Technical details' preference (off) the panel gave no reason and no hint of that preference. Last error appears only in a Technical details block (ConnectorPanelParts.tsx:109); not re-run with the preference on. The 'outcome is unconfirmed ... locked for this app session' message was seen once after the 500, cause not isolated. No tools were discovered, so no tool could be tried.
5. 'Callable: Static MCP in Chat is disabled for this runtime' and, for a hand-registered server, no screen it reaches turns it on (U-CP-010). The Cockpit's one switch for the flag is the pre-ticked 'Also let Chat use connectors' box in a template's install panel (seen on Airtable's panel, not installed; ConnectorInstallPanel.tsx:42, :80-89, connector-install-change-plan-adapter.ts:164). Chat's tool list was therefore not checked.
6. Removed the server: panel Remove > 'This removes it for every workspace on this computer, along with its saved sign-in and keys, its tool list and any approvals waiting on it. ... it can't be undone here.' > confirmed; the list is back to the two GoatCitadel servers.
Failure tried: connect on a host without a keychain (step 4).
Evidence: cp-4-add-your-own.png, cp-5-form-filled.png, cp-5-review.png, cp-5-registered.png, cp-5-row.png, cp-5-panel.png, cp-5-advanced-mcp.png, cp-5-inspect.png, cp-5-inspect-bottom.png, cp-5-review-connection.png, cp-5-connected.png, cp-5-after-error-inspect.png, cp-5-row-after-error.png, cp-5-error-panel.png, cp-5-remove-confirm.png, cp-5-removed.png.
Not covered: seeing tools and using one in Chat. Operator steps: on a host with a keychain and with `features.chatStaticMcpV1Enabled` true (settings API; no screen), register a stdio echo server, Connect reviewed server, confirm the tool appears under 'Cached tool inventory', start a new Chat turn with a real model and ask it to call the tool, approve the first call.

## CP-6 Tools: find a tool, read what it can do and what approval it needs, change its permission
Result: PARTLY RUN (permission is a group switch; a per-tool permission is set in Settings > Safety, not run)
Findings: U-CP-012. Also: tools in the group list their raw names under each friendly title ('browser.search', 'local_business.research', 'citations.build'), part of the design's technical-detail rule, not recorded.
Time: switch off applied within the 2.5 s watched window with no approval; switch on: panel read 'Waiting on you in Inbox' within the same window.
Code path: `tools/ToolsTab.tsx` -> `ToolGroupRow.tsx` / `ToolGroupPanel.tsx` -> `GroupSwitchParts.tsx` -> `use-tool-group-switch.ts` -> change plan -> Inbox approval.
Live:
1. Tools: Essentials (Files, Web search, Memory, Browser, all On) and 'All tools' groups with risk (Danger/Caution), 'No calls yet', counts of tools blocked by other rules. A search ('web search') found the group at once.
2. View Web search: risk Caution, what it does, 'Tools in this group' with each tool's risk and 'Asks first' / 'Not used yet', and 'Detailed rules are in Settings > Safety'.
3. Group switch off: applied immediately, tools read 'Switched off', 'The AI can't use these in any chat.' Switch on: 'Waiting on you in Inbox - Open in Inbox' (U-CP-012); the card 'Switch the Web search tools back on' (Caution) approved in the Inbox with one click scoped to it. Final state On, as before.
4. Approvals raised from `default`.
Failure tried: none beyond the Inbox round trip.
Evidence: cp-6-tools.png, cp-6-group-panel.png, cp-6-off-done.png, cp-6-on-done.png, cp-6-inbox.png, cp-6-inbox-approved.png.
Not covered: changing one tool's own permission (Settings > Safety belongs to the Settings task).

## LB-1 Memory: see what was remembered and why, edit an item, forget an item, see history
Result: PARTLY RUN
Findings: U-LB-008 (default-install experience, `likely`, not reproduced live), U-LB-009, U-LB-010, U-LB-011. Carried: U-LB-003 (see Notes), U-LB-002.
Time: not timed to the millisecond; edit and forget each took about 8 s from first click to the item showing the change, four clicks.
Code path: `library/LibraryMemoryWorkspace.tsx` (list, `memory-item-pagination-service.ts`) -> `LibraryMemoryEditor.tsx` (edit, forget, history, provenance) -> governed memory-lifecycle approval -> `LibraryMemoryReceipt.tsx`.
Live (sandbox flag true):
1. Library > Memory: filters (Memory status, namespace), 'Open <item>' per row, batch review buttons, proposals ('Proposals are not trusted memory').
2. Search 'review-task-9' then Enter filtered at once, and 'Apply memory filter' also works (U-LB-003 says only Apply works).
3. Open the item: title, content, expiry, Pinned, Review memory changes, Review forget, Memory history, Memory provenance (U-LB-009).
4. Edit content > Review memory changes > Request edit approval > Review danger approval > Approve once: content changed, history 'Updated - Changed: content - Approved change' (U-LB-010). Re-requesting the same edit reused one pending approval.
5. Forget: same four clicks; the dialog says 'A forgotten item can't be restored from the cockpit.' and the item reads Forgotten (U-LB-011).
Default install, from code (U-LB-008): the in-code fallback is `?? true` (`apps/gateway/src/config.ts:1475`), but a first run materialises `config/goatcitadel.json` from the example (`config.ts:553-558`), and the example sets false (`config/goatcitadel.example.json:202`), so a real fresh install gets false. No onboarding or first-run code sets it. The list read is then refused (`memory-item-pagination-service.ts:21`), the page shows 'This feature is turned off for this installation.' in a callout (`LibraryMemoryWorkspace.tsx:196-201`, `describe-api-error.ts:50-52`), and no Settings screen exposes the flag (git grep over `apps/mission-control-next/src` and `packages/mission-control-shared`: only read checks, one type, one fixture).
Failure tried: edit approval reopened after leaving the editor (a fresh editor shows 'Request edit approval' again, no 'waiting' notice).
Evidence: lb-1-memory.png, lb-1-detail.png, lb-1-provenance.png, lb-1-edit-review.png, lb-1-edit-after-request-1.png, lb-1-danger-review.png, lb-1-inbox.png, lb-1-inbox-review.png, lb-1-inbox-approved.png, lb-1-history-after-edit.png, lb-1-forget-review.png, lb-1-forget-done.png.
Not covered: the default-install screen live (needs an install with the flag false; operator steps: start with the example config, open Library > Memory).

## LB-2 Files and artifacts: upload a text file, find an artifact made in Chat, open it
Result: PARTLY RUN
Findings: U-LB-012.
Time: upload confirmation within the 2.5 s watched window after Upload file (review dialog 1.9 s).
Code path: `library/LibraryFileUpload.tsx` -> `uploadFile` -> `POST /api/v1/files/upload`; `LibraryResources.tsx` / `LibraryArtifactDownload.tsx` for artifacts.
Live:
1. Library > Files: 'Installation shared files. Workspace selection does not change this file root', folders chat/ and workspace/, two files listed. Upload text file: path and text boxes (U-LB-012), Review upload ('Confirm the installation shared destination before writing. Target: review-task-9-note.txt'), Upload file: 'GoatCitadel accepted review-task-9-note.txt (68 B).' and the file listed. The Inspect button for the new file was not found by name in the dialog-open state; the list row appeared.
2. Library > Artifacts (verification workspace): one 'Generated note' (seeded, Text, Version 1, Source: Conversation); Inspect opened a preview with Download artifact, Open artifact conversation, Reopen exact artifact, Use artifact in Chat. No artifact from an earlier task's Code Mode run exists, and none can be made without a model.
Failure tried: none.
Evidence: lb-2-files.png, lb-2-upload-form.png, lb-2-upload-review.png, lb-2-uploaded.png, lb-2-artifacts.png, lb-2-artifact-open.png.
Not covered: an artifact made in a real Chat turn; Download and 'Use artifact in Chat' not pressed. Left in the sandbox: `review-task-9-note.txt` in the shared file root (no delete control).

## LB-3 Agents: view profiles and the imported catalog; prompt packs: open, use in Chat
Result: PARTLY RUN
Findings: U-LB-013, U-LB-014, U-LB-015.
Time: Open QA Goat: URL changed at once, editor 1395 px below the fold.
Code path: `library/LibraryAgentsWorkspace.tsx` (profiles) / `LibraryImportedAgents.tsx` (catalog) / `LibraryAgentEditor.tsx`; `LibraryPromptPacks.tsx` -> `features/prompt-packs/usePromptPacksWorkbenchState.ts`.
Live:
1. Agents > Profiles: 10 installation profiles (eight built-in roles plus two custom, with state, kind and conversation count) and 'New agent profile'. Open QA Goat appears to do nothing (U-LB-013). Imported catalog: empty with no message (U-LB-014).
2. Prompt packs: the screen is a test console (selected pack, latest attempts, pass readiness, model lane `verification-stub/verification-stub-chat`, harness, assessment threshold 78%, per-test Run, Run all, Auto-score, Import a new pack). Run on TEST-01 gave first feedback in 332 ms and 'Ran TEST-01. Auto-scored 60.3/100 (review)' on the stub model, with an absolute log path in the line (U-LB-015).
3. "Use in Chat": no control on the Library side offers it (a search for chat links in the page found none). Earlier tasks found that packs without a run-variable schema are not listed in the composer's prompt-pack menu, so from Library's side 'use' means 'run a test against the selected model lane'.
Failure tried: none.
Evidence: lb-3-agents.png, lb-3-profile.png, lb-3-profile-open-bottom.png, lb-3-profile-position.json, lb-3-imported.png, lb-3-prompt-packs.png, lb-3-pack-run.png.
Not covered: the imported agent catalog with entries (needs a catalog repository; operator steps: Imported catalog > Import agent catalog with the configured source) and using a pack from the Chat composer (Task 6 area). A prompt-pack run record remains in the sandbox.

## LB-4 Knowledge: add a source, see it used in an answer with its citation
Result: PARTLY RUN
Findings: U-LB-016.
Time: ingest approval and receipt within the 3.5 s watched window (one click in place).
Code path: `library/LibraryKnowledgeWorkspace.tsx` -> `LibraryKnowledgeSourceFields.tsx` / `LibraryKnowledgeActions.tsx` -> docs ingest approval -> `LibraryKnowledgeResults.tsx` / `LibraryKnowledgeEvidence.tsx`.
Live:
1. Library > Knowledge asks first for a Source conversation (a long list of conversations, including earlier tasks' `review-task-8 ...`), then namespace, source type (Text, File, URL), title and text. 'Tool policy and read access still decide what this conversation can use.'
2. Review knowledge ingest > Confirm knowledge request > 'Knowledge request requires approval' with Approve once in the same dialog (Caution, 'Docs ingest ... Persist this exact source and its chunks') > one click > 'Original ingest completed; the canonical document receipt is available.'
3. The page then lists no sources (U-LB-016). What the screen says about use: 'Ingest persists source material. Indexing can invoke an embedding provider. Retrieval returns only content allowed for this conversation.'
4. Note: two identical pending 'Docs ingest' approvals appeared because my test script submitted the form three times; it needs a manual repeat by an operator before it could be a finding (the memory approval did not duplicate on the same repeat).
Failure tried: repeat confirm (step 4).
Evidence: lb-4-knowledge.png, lb-4-form.png, lb-4-ingest-review.png, lb-4-after-confirm-1.png, lb-4-approved-1.png, lb-4-ingested.png, lb-4-knowledge-after.png, lb-4-retrieval-review.png.
Not covered: indexing, retrieval and seeing a cited answer (the stub model does not cite). Operator steps: with a real embedding provider and model, run Review knowledge indexing for namespace `review-task-9`, then in the source conversation ask 'When is the quarterly planning meeting?' and look for a citation chip.

## Notes on existing findings
- Task-7 finding "On a default install, typing 'use <skill>' in Chat does nothing and says nothing": Capabilities makes it worse because it promises the Chat half. `SkillPanelSwitch.tsx:9` prints 'Takes effect in new chats.' under every On skill, `SkillPanelSwitch.tsx:13` prints 'Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.' (and the row for a paused skill reads 'Used when you name it, or on a close match if you allow it'), and `skill-install-view.ts:153` has the install approval read 'Lets the AI use <name> in new chats.' No Capabilities screen says that skill instructions in Chat are off by a setting, or where that setting is. Seen live on all three (cp-1-panel.png, cp-1-paused.png, cp-3-approval-3.png). Suggested severity: keep stall, and add that the Capabilities copy is the promise that fails.
- U-LB-003 (Memory search needs Apply): pressing Enter in 'Search memory' also applies the filter (live), so only pointer users hit it; suggested severity polish.
- U-LB-002 (Library text fields have faint borders): seen again on the Files upload, Knowledge and Memory search fields (not remeasured).
- Skill and plugin approvals are install-wide and worked from the verification workspace (skill) and from `default` (skill, plugin, tool); Settings approvals from a non-default workspace were not raised, so OL-16 was not re-tested.
- The shared change-plan dialog's primary button looking like Cancel (U-ST-005 / U-GL-008): in the Uninstall confirmation ('Keep it' beside 'Uninstall Review task 9 plugin') the primary is red and distinct; not reproduced there.

## Design decisions to confirm
- Turning a skill on, or resuming a paused one, is a Danger approval ('Turn debugging on - Danger') while turning it off and pausing are instant. For a built-in skill the operator switched off 30 seconds earlier the Danger label reads heavy; if the asymmetry is by design, consider a lower risk label for built-in, trusted skills.
- Tool group switch-off is instant but switch-on asks (same asymmetry); see U-CP-012 for the Inbox trip.

## Engineering notes
- The Connectors tab opens on `DEFAULT_TAB` = connectors on a first visit (`capabilities-tabs.ts:14`), while the area's title line reads 'Everything GoatCitadel's AI can use'; Skills is the first tab in the row.
- `GET /api/v1/capabilities/plugins` without `workspaceId` answers 400 (a validation message in raw zod shape); the UI always sends it.
- The Memory forget approval title in the Inbox ('Review memory lifecycle') comes from the generic approval title, whereas docs ingest sets its own ('Docs ingest - Ingests a document').
- The 404 on `GET /api/v1/capabilities/plugins/detail` after an uninstall finishes comes from the still-open plugin panel reading a plugin that no longer exists; harmless, shows once in the console.
