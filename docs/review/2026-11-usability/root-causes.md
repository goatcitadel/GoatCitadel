# Root causes and ranking (2026-11 usability review)

This file groups the findings in `findings.json` by root cause, for whoever plans the fixes. It is regenerated together with `overrides.json`; `findings.json` itself is rebuilt with `tools/build-findings.cjs` (see `README.md`).

Who the ranking is for: the operator's main install is the Windows desktop app with a working OS keychain, one default workspace to start with and auth mode `none` (the shipped default). Severity reflects what that operator meets; each cause says which installs it affects. After the refutation round and the controller's rulings there is no blocker.

## How findings are ranked

`rank` (1 = first) orders findings by:

1. severity: stall, then friction, then polish;
2. the number of journeys the finding breaks (its `journey` plus `journeys`; a carried finding with only the journey `prior` counts as one);
3. how early a new operator meets it in their first hour, by this table (also in `tools/apply-overrides.cjs`); ties go to the lower id.

| Order | Journeys |
|---|---|
| 1 | FR-5 installer |
| 2 | FR-4 first start (bundled database) |
| 3 | FR-1 first run; carried first-run findings |
| 4 | FR-2 leave or skip onboarding, demo |
| 5 | CH-1 first message |
| 6 | GL-1 navigation, GL-7 phone and light theme, SY-1 Health (the sidebar status line); carried global findings |
| 8 | CH-2 to CH-6 everyday Chat; carried Chat findings |
| 9 | ST-1 provider and key, GL-P production credential box; carried Settings findings |
| 10 | ST-2, ST-3 Settings approvals and saves |
| 11 | CH-9, CH-10 approvals in Chat |
| 12 | IN-1, IN-3 Inbox; carried Inbox findings |
| 13 | GL-3 keyboard, GL-6 Back and reload |
| 14 | CH-11 to CH-16 planning, research, Code Mode, skills, managed files; MS-4 real-model pass |
| 15 | PJ-1, PJ-2 projects |
| 16 | CP-2 to CP-6 Capabilities |
| 17 | ST-6 to ST-9 other Settings pages |
| 18 | LB-1 to LB-4 Library |
| 19 | SY-2 to SY-7 System |
| 20 | WK-1 to WK-4 Work |
| 21 | MS-1 channels, MS-3 integrations |
| 22 | CH-8 two tabs, IN-2 approval with no workspace, GL-5 idle requests |
| 23 | Outage |
| 24 | FR-3 terminal wizard, GL-T token sign-in (not on the default desktop path) |
| 25 | GL-L large data |

Root-cause sections below are ordered by the best rank among their findings. A cause that explains one finding stands on its own; groups were not forced. Every `path:line` was opened on the pinned SHA. Owners named without a line are the finding's owning file where the exact line was not isolated.

## RC-01

- Cause: Feature settings that are off by default gate screens and promises that are on screen, and no Settings page can switch them; the gated screen says only that the feature is off.
- Owner: `apps/gateway/src/config.ts:1472` (feature defaults; for Library > Memory the shipped example config wins: `config/goatcitadel.example.json:202`). The Gateway already accepts these switches in the Settings patch (`apps/gateway/src/routes/dashboard.ts:266`); the Cockpit has no control for them (`evidence/st/st-9-feature-flags.json`: 69 flags, 33 off by default with no control).
- Findings: U-LB-008 (rank 1, stall), U-CH-044 (rank 7, stall), U-CP-015 (rank 9, stall), U-ST-027 (rank 74, friction), U-CP-018 (rank 101, friction)
- Smallest change: Add one Settings > Advanced "Features" section that lists the default-off settings that gate a Cockpit screen (skill instructions in Chat, static MCP in Chat, memory administration, connector diagnostics, scheduler review, engineering learnings), each as a governed switch through the existing settings patch, and make every "turned off" sentence link to its switch. Where a screen promises the gated behaviour (the Skills panel copy, the install approval), say that it needs the switch.
- Installs affected: All installs, from the first run (the defaults come from config).

## RC-02

- Cause: Settings change plans are created and linked under a hard-coded "default" workspace, so their in-place approval refuses to work while any other workspace is selected.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/GovernedSettingParts.tsx:117` and six sibling call sites (`ApprovalModeControl.tsx:177`, `FilesystemWriteAccessParts.tsx:71`, `ProviderConnectionSettings.tsx:344`, `ProviderRoutingSettings.tsx:247`, `ManagedRuntimeSettings.tsx:195`, `GatewayAuthSettings.tsx:101`); plan creation in `use-provider-connection-editor.ts:130`.
- Findings: U-ST-001 (rank 2, stall)
- Smallest change: Settings changes are install-wide: give their plans one install-wide scope that SettingsApprovalDialog accepts from any selected workspace (or pass the selected workspace consistently to creation, link and approval), instead of the literal "default".
- Installs affected: Installs with more than one workspace, while a workspace other than "default" is selected.

## RC-03

- Cause: If you save a setting while an earlier change to it is still waiting for approval, the page says 'changed elsewhere' instead of pointing to the waiting approval; and if a save's answer is lost, the page locks further saves until a reload it never mentions.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/use-governed-runtime-setting.ts:122` (Settings toggles, the public web address); `use-approval-mode-control.ts:166` (approval rule, first-run Finish); `apps/mission-control-next/src/features/native-routes/settings/sections/channel-setup-state.ts:28` (Advanced channel setup).
- Findings: U-ST-021 (rank 3, stall), U-FR-001 (rank 6, stall), U-MS-005 (rank 11, stall), U-MS-002 (rank 105, friction)
- Smallest change: On 409 WRITE_CONFLICT, look up the active plan for the same target and re-open its in-place approval (or say "one change is already waiting" with a link); on a 4xx with a Gateway reason, show the refusal and keep the page usable; after an uncertain outcome, re-read the saved value and lift the lock when it settles, instead of requiring a reload the screen never names.
- Installs affected: All installs.

## RC-04

- Cause: Skills cannot be removed, so uninstalling a plugin leaves its skill behind for good and the skill name blocks any later install, while the first uninstall confirmation promises a reinstall.
- Owner: `apps/gateway/src/services/capability-plugin-inspection-service.ts:74` (the "can't come back until skills can be removed" refusal); confirmation copy in `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/PluginUninstall.tsx:98`.
- Findings: U-CP-004 (rank 4, stall), U-CP-005 (rank 69, friction), U-CP-006 (rank 70, friction)
- Smallest change: Until skill removal exists, change the first confirmation to say a plugin with a skill cannot be installed again, and explain the second "Finish uninstalling" step; the real fix is a governed skill removal that clears the leftover row.
- Note (final review): the approval dialog that opens right after the confirmation already warns that the skill cannot be installed again (`evidence/cp/cp-3-uninstall-dialog-1.png`); the confirmation itself still promises a reinstall. Copy alone removes the false promise; a reinstall stays impossible until skill removal exists.
- Installs affected: All installs.

## RC-05

- Cause: Lists that span workspaces (System Sessions and Activity, linked scopes, workspace-less runs) hand off links that carry no workspace, and the receiving page refuses instead of naming the workspace and offering to switch.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/SessionControlManager.tsx:211` (session control refusal); run events carry only `runId` (`apps/gateway/src/services/durable-run-service.ts:624`); `apps/mission-control-next/src/cockpit/app/IncomingScopeReview.tsx` (linked scope banner).
- Findings: U-SY-009 (rank 5, stall), U-GL-045 (rank 41, friction), U-IN-013 (rank 214, polish)
- Smallest change: Put the workspace id in every cross-area link and run event, and let the receiving page offer "Switch to <workspace>" when it differs.
- Installs affected: Installs with more than one workspace; workspace-less runs only from dev fixtures so far.

## RC-06

- Cause: The only failure reason on some screens is rendered inside TechnicalDetails, which renders nothing unless the Technical details preference is on, and that preference is off in Simple mode, the default.
- Owner: `apps/mission-control-next/src/cockpit/ui/TechnicalDetails.tsx:7` (returns null when the preference is off); default from `packages/mission-control-shared/src/state/ui-preferences.tsx:80` and `:283`.
- Findings: U-CP-014 (rank 8, stall)
- Smallest change: Show the last error as plain text on the panel; keep only codes and ids inside Technical details.
- Installs affected: All installs.

## RC-07

- Cause: The Cockpit lacks an action the Classic page had, with no Classic link to reach it.
- Owner: Each finding's Cockpit page; the Classic pages are named in the findings (for example `CoworkNativePage.tsx:380`).
- Findings: U-WK-001 (rank 10, stall), U-LB-005 (rank 76, friction), U-ST-017 (rank 176, polish), U-IN-004 (rank 183, polish)
- Smallest change: Add the missing action (deliverable entry, notification feed, skill evaluation runs, Spend link) or a labelled Classic link per DESIGN.md:73.
- Installs affected: All installs.

## RC-08

- Cause: With sign-in off (the desktop default), the Gateway refuses the request that loads Auto mode, so every project conversation shows 'Approval mode unavailable' with a Retry that cannot work.
- Owner: `apps/gateway/src/routes/session-control-request-context.ts:154` (`directLocal` requires an actor source other than none); the route gate is `apps/gateway/src/routes/chat.sessions.ts:29`.
- Findings: U-CH-018 (rank 12, friction)
- Smallest change: Pending the design decision below: either grant `directLocal` to mode-none loopback requests, or have the composer say "Auto mode and Managed files need sign-in (Settings > Access)" with that link instead of "unavailable / Retry".
- Installs affected: Every mode-none install (the packaged desktop default), in conversations that belong to a project.

## RC-09

- Cause: The Health summary counts "service control unavailable" as a problem although the Gateway can never report it as supported, while it has no check at all for the default model.
- Owner: `apps/mission-control-next/src/cockpit/areas/system/health-overview.ts:117` (Unavailable forced to the waiting tone); `apps/gateway/src/services/daemon-route-service.ts:100` (supported hard-coded false).
- Findings: U-SY-002 (rank 13, friction), U-FR-005 (rank 28, friction)
- Smallest change: Show unsupported service control as neutral information that the heading does not count, and add a "Default model" check that reads the guided-setup status.
- Installs affected: Every install, on every page (the sidebar status line).

## RC-10

- Cause: Some screens replace the Gateway's refusal with one fixed sentence, so a size limit or a permission refusal reads like a transient upload failure or a config problem.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ChatComposerTools.tsx:300` (attachment upload) and `apps/mission-control-next/src/cockpit/areas/chat/ChatManagedFiles.tsx:323` (managed files).
- Findings: U-CH-020 (rank 14, friction), U-CH-040 (rank 189, polish)
- Smallest change: Use describeApiError (it already says "That's too large to send." for 413) and name the limit; map 403 on managed files to the mode-none explanation.
- Installs affected: All installs.

## RC-11

- Cause: Commit buttons in some dialogs use the default (secondary) variant, or lose the primary style through the change-plan CSS cascade, and a reversible action uses the red danger variant.
- Owner: `apps/mission-control-next/src/features/threaded-surface/styles/change-plans.css:186` (cascade on the shared change-plan dialog); `apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx:263` and siblings (default variant); `ChannelLifecycleControls.tsx` (danger for enable/disable).
- Findings: U-ST-005 (rank 15, friction), U-GL-008 (rank 37, friction), U-ST-006 (rank 168, polish)
- Smallest change: Give the change-plan primary action the accent class outside `chat-change-plan-modal`, set `variant="primary"` on the named commit buttons, and use primary styling for enable/disable per DESIGN.md:58.
- Installs affected: All installs.

## RC-12

- Cause: When the host has no OS keychain the Gateway says so, but the shared error mapper replaces any 5xx with a generic sentence and the channel setup pages replace any failure with a sentence that blames the key.
- Owner: `packages/mission-control-shared/src/api/describe-api-error.ts:117` (generic 5xx text); `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/use-telegram-setup.ts:267` (fixed key-blaming error, same in the Discord and Slack hooks).
- Findings: U-ST-033 (rank 16, friction), U-MS-001 (rank 104, friction)
- Smallest change: Map the Gateway codes SECRET_STORE_UNAVAILABLE (503) and the 422 "Secure channel credential storage is unavailable." to one plain sentence with the next step (environment variable, or a host with a keychain), as the WhatsApp page already does, and let the channel hooks show it.
- Installs affected: Hosts without a working OS keychain: Docker, headless Linux, Linux without a secret service. A Windows desktop with a working keychain is not affected.

## RC-13

- Cause: Some governed switches create their approval and send the operator to the Inbox (or to a separate Continue step) instead of opening the in-place approval dialog the Skills switch and Settings toggles already use.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/ApprovalModeControl.tsx:173` (approval rule), `apps/mission-control-next/src/cockpit/areas/capabilities/tools/GroupSwitchParts.tsx:167` (tool groups), `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorInstallProgress.tsx:17` (connector install); the in-place path is `SettingsApprovalDialog.tsx:52`.
- Findings: U-ST-020 (rank 17, friction), U-CP-012 (rank 72, friction), U-CP-021 (rank 103, friction)
- Smallest change: Open SettingsApprovalDialog in place from these three callers and apply on approval, as SkillPanelSwitch does; keep the Inbox as the fallback when the dialog is closed.
- Installs affected: All installs.

## RC-14

- Cause: Approval cards and Inbox rows are titled from the tool's generic action name, without the target the approval is about (command, code, file name and place).
- Owner: `apps/gateway/src/services/inbox-projection-service.ts` (row titles and summaries) and `apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx` (Chat card).
- Findings: U-IN-001 (rank 18, friction), U-IN-016 (rank 54, friction), U-CH-046 (rank 61, friction)
- Smallest change: Build the row and card summary from the tool arguments the approval already stores (command line, code excerpt, file name and folder).
- Installs affected: All installs.

## RC-15

- Cause: The selected Inbox item lives only in component state.
- Owner: `apps/mission-control-next/src/cockpit/areas/inbox/InboxArea.tsx:162`
- Findings: U-IN-006 (rank 19, friction)
- Smallest change: Put the item id in the URL.
- Installs affected: All installs.

## RC-16

- Cause: "Plan first" returns a fixed engineering template from the Gateway instead of asking the model, and the Delegation card reports the template run as Done with every step Queued.
- Owner: `apps/gateway/src/services/chat-turn-helpers.ts` (the plan template, owner named by U-CH-045 and U-CH-033); Delegation card in `apps/mission-control-next/src/cockpit/areas/chat/ChatRunCard.tsx`.
- Findings: U-CH-032 (rank 20, friction), U-CH-033 (rank 21, friction), U-CH-045 (rank 60, friction)
- Smallest change: Send "Plan first" requests to the model with a planning instruction and render its steps; show the card's state from the steps it lists.
- Installs affected: All installs.

## RC-17

- Cause: Connector and integration rows show the saved or configured state with the word "Connected", which reads as a live connection.
- Owner: `apps/gateway/src/services/capability-connectors-projection.ts` (Connectors grouping) and `apps/mission-control-next/src/features/native-routes/settings/sections/IntegrationsSection.tsx` (Configured status).
- Findings: U-CP-013 (rank 22, friction), U-CP-017 (rank 100, friction)
- Smallest change: Group and label by the last connection state ("Saved, never connected"), and keep "Connected" for a confirmed connection.
- Installs affected: All installs.

## RC-18

- Cause: Controls are styled outside the shared Button, Tabs, Callout and token set, so states (current, forced colours, target size, borders) differ from page to page.
- Owner: `apps/mission-control-next/src/cockpit/ui/` (Button.tsx, Tabs.tsx, Callout.tsx) and `apps/mission-control-next/src/cockpit/styles/cockpit.css`.
- Findings: U-LB-002 (rank 23, friction), U-GL-001 (rank 35, friction), U-GL-006 (rank 36, friction), U-GL-005 (rank 125, polish), U-GL-013 (rank 129, polish), U-GL-037 (rank 143, polish), U-GL-040 (rank 146, polish), U-CH-005 (rank 155, polish), U-IN-002 (rank 182, polish), U-IN-005 (rank 184, polish), U-WK-002 (rank 204, polish), U-WK-009 (rank 207, polish)
- Smallest change: Replace the hand-made controls in the named files with the shared primitives and give the primitives a forced-colours outline, a 24 px minimum target and a distinct current state.
- Installs affected: All installs.

## RC-19

- Cause: The installer's default "Full installation" includes components that download during install and abort the install if the download fails.
- Owner: `scripts/packaging/build-windows-native-installer.mjs:226`
- Findings: U-FR-011 (rank 24, friction)
- Smallest change: Make the Chromium and Voice runtimes opt-in, or let their download fail without aborting the base install.
- Installs affected: Windows installer users on the default choice.

## RC-20

- Cause: The bundled Postgres start reports its cause (port held, wrong password, reserved port) only to the log, and the desktop window shows a generic stopped/degraded screen.
- Owner: `apps/gateway/src/bundled-postgres-runtime.ts:577` (start and timeout); window copy in `apps/mission-control-desktop/src/main.ts:173`.
- Findings: U-FR-015 (rank 25, friction)
- Smallest change: Pass the start failure's first line and recovery state to the desktop recovery screen, add a port-in-use check before the 180 s wait, and show elapsed time while it waits.
- Installs affected: Desktop installs whose port 45432 is taken or that have a stale database container.

## RC-21

- Cause: Links and routes point at pages the release scope hides or no longer has, so they open "unavailable" or "Page not found"; a held-back page opens with no label.
- Owner: `apps/mission-control-next/src/app/route-release-scope.ts:449` and `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:235`.
- Findings: U-FR-002 (rank 26, friction), U-CP-003 (rank 68, friction), U-SY-001 (rank 151, polish), U-CH-017 (rank 164, polish), U-ST-018 (rank 177, polish)
- Smallest change: Remove or retarget the links to hidden pages, redirect the old Cowork route, and label held-back pages as held back.
- Installs affected: All installs.

## RC-22

- Cause: The guided model setup drops the Gateway's warning from a connection check and recomputes readiness from stale check times, so a failed check looks like no check and the status flips between loads.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/use-guided-model-setup.ts:369` (recheckLocalEndpoint ignores `source` and `warning`); the explaining sentence lives in `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.ts:179` but only `GuidedModelSteps`, hidden on first run (`CockpitGuidedModelSetup.tsx:81`), shows it.
- Findings: U-FR-004 (rank 27, friction), U-ST-023 (rank 49, friction)
- Smallest change: Return the warning from the check and render it next to the button on every guided surface; derive Ready/Not verified from the last check result, not from its age alone.
- Installs affected: All installs that use LM Studio or llama.cpp, and every install for the alternating status.

## RC-23

- Cause: A Chat turn that fails because no provider is configured or the provider cannot be reached offers Reload or Retry, and the link to model setup is shown only for sign-in and billing failures.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ChatTurnFailureCard.tsx:31` (link limited to auth_required and provider_billing); first-send notice in `ChatAreaChrome.tsx:198`.
- Findings: U-FR-012 (rank 29, friction), U-ST-030 (rank 50, friction)
- Smallest change: Add the provider-missing and provider-unreachable classes to the "Open model providers" link, name the provider in the sentence, and drop "Reload conversation" where it cannot help.
- Installs affected: All installs; every fresh install meets the first-send case.

## RC-24

- Cause: The Cockpit has no first-visit redirect to guided setup; only the Classic shell has one.
- Owner: `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:223` (Cockpit maps only the onboarding section); the Classic guard is `apps/mission-control-next/src/app/MissionControlNextApp.tsx:748`.
- Findings: U-FR-014 (rank 30, friction)
- Smallest change: Port the Classic first-destination guard: while onboarding is not complete and no model is confirmed, open Settings > Get started on the first visit.
- Installs affected: Every fresh install.

## RC-25

- Cause: Get started shows the "Saved model defaults changed" notice when the selection differs from the saved defaults, which is always true on a fresh install, and the safety step names an option it never explains.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/CockpitGuidedModelSetup.tsx` (owner named by the finding; the comparison was not isolated).
- Findings: U-FR-016 (rank 31, friction)
- Smallest change: Show the notice only when the saved defaults changed after the page loaded; give "Skip normal prompts" one sentence of description.
- Installs affected: Every fresh install.

## RC-26

- Cause: Model setup exists as separate flows (Get started, Guided model setup on Providers & models, and Advanced provider configuration) with their own step names, state and completion rules.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/ModelsSettings.tsx:62` (both setups mounted); step list in `GuidedModelSteps.tsx:59`.
- Findings: U-ST-010 (rank 32, friction), U-FR-013 (rank 34, friction), U-ST-002 (rank 46, friction)
- Smallest change: Make Get started the one setup: Chat's "Configure models" and the launch URL open it, Providers & models shows its status instead of a second step list, and the advanced choosers stay collapsed under it.
- Installs affected: All installs.

## RC-27

- Cause: The demo preparation reports a skipped step by its feature-setting name, opens a different chat than the one it lists, and switches the workspace without saying so.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/FirstRunDemo.tsx`
- Findings: U-FR-006 (rank 33, friction)
- Smallest change: Say "Memory examples were skipped: memory administration is off" with the switch link, open the listed demo chat, and say that the demo has its own workspace.
- Installs affected: All installs.

## RC-28

- Cause: Some controls announce less than they show: hints only in title tooltips or hover, help text not tied to its field, a suggestion list without combobox roles, and no announcement on area change.
- Owner: `apps/mission-control-next/src/cockpit/ui/IconButton.tsx` (title tooltips) and `apps/mission-control-next/src/cockpit/app/CockpitShell.tsx` (area change); the rest are each finding's owner.
- Findings: U-GL-025 (rank 38, friction), U-GL-016 (rank 130, polish), U-GL-043 (rank 149, polish), U-CH-004 (rank 154, polish), U-ST-007 (rank 169, polish)
- Smallest change: Use the shared tooltip and Field (aria-describedby) primitives, give the composer suggestions combobox roles, and announce the new page title on area change.
- Installs affected: All installs.

## RC-29

- Cause: On a phone or tablet the page never shows which workspace you are acting in.
- Owner: `apps/mission-control-next/src/cockpit/app/MobileTabBar.tsx:162`
- Findings: U-GL-027 (rank 39, friction)
- Smallest change: Show the workspace name in the phone header.
- Installs affected: All installs.

## RC-30

- Cause: Operator copy bypasses the DESIGN.md glossary and the shared status presenters, so internal words and several names for one thing reach the screen.
- Owner: `packages/mission-control-shared/src/content/status-vocabulary.ts` and `apps/mission-control-next/src/cockpit/areas/system/system-vocabulary.ts`; the glossary is DESIGN.md:77-92.
- Findings: U-GL-034 (rank 40, friction), U-GL-004 (rank 124, polish), U-GL-022 (rank 133, polish), U-GL-023 (rank 134, polish), U-GL-036 (rank 142, polish), U-ST-003 (rank 166, polish), U-ST-009 (rank 170, polish), U-ST-016 (rank 175, polish), U-WK-006 (rank 205, polish), U-WK-016 (rank 208, polish), U-MS-004 (rank 211, polish)
- Smallest change: Route the listed strings through the presenters and glossary words; one sweep of the files these findings name.
- Installs affected: All installs.

## RC-31

- Cause: Chat's three columns (conversation list, transcript, inspector) have fixed widths that do not give way at 1024 to 1440 px, and the sticky prompt bar overlaps the transcript.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ThreadList.tsx`, `apps/mission-control-next/src/cockpit/app/InspectorResizeHandle.tsx`, `ChatStickyPrompt.tsx` and the inspector tab list in `chat-inspector-evidence.tsx:134`.
- Findings: U-CH-002 (rank 42, friction), U-CH-028 (rank 116, polish), U-CH-048 (rank 123, polish), U-CH-001 (rank 152, polish)
- Smallest change: Collapse the conversation list below 1280 px, let the inspector tab strip scroll or wrap, and reserve the sticky bar's height at the top of the transcript.
- Installs affected: All installs.

## RC-32

- Cause: The build editor hides its first action inside a collapsed disclosure, shows a failed worktree creation as raw JSON, and does not state the scope of Revert all.
- Owner: `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchToolbar.tsx` and `CodeWorkbenchPanel.tsx`.
- Findings: U-CH-012 (rank 43, friction), U-CH-038 (rank 59, friction)
- Smallest change: Show Create worktree beside the "Create a worktree to begin editing" line, map the failure to a sentence (no git, not a repository), and put the file count in the Revert all confirmation.
- Installs affected: All installs.

## RC-33

- Cause: Safe, reversible changes made through a change plan still need a card, a second review dialog and an explicit apply, and nothing marks the pending choice as not yet active.
- Owner: `packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx` (card and Review and confirm) and `apps/mission-control-next/src/cockpit/areas/settings/ProviderManagementSettings.tsx` (profile add).
- Findings: U-CH-021 (rank 44, friction), U-ST-022 (rank 48, friction)
- Smallest change: For safe, secret-free plans, apply on the first confirmation and show the result in place; label a pending choice "not applied yet" on the chip.
- Installs affected: All installs.

## RC-34

- Cause: A Stop that arrives as the turn completes is treated as a provider failure.
- Owner: `apps/gateway/src/routes/chat.messages.ts:1041`
- Findings: U-CH-025 (rank 45, friction)
- Smallest change: Treat a stop after completion as a no-op and keep the answer.
- Installs affected: All installs.

## RC-35

- Cause: The webhook destination kind asks for an existing keychain reference, and no screen creates one.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/NotificationRoutingFields.tsx:63`.
- Findings: U-ST-008 (rank 47, friction)
- Smallest change: Take the webhook URL through the secure-input flow that provider keys use and store the reference for the operator, or explain the reference format and where to create it.
- Installs affected: All installs.

## RC-36

- Cause: The Inbox recovery dialog tells the operator to review the run but shows no run, attempts or effects.
- Owner: `apps/mission-control-next/src/cockpit/areas/inbox/InboxRunRecovery.tsx:247`
- Findings: U-IN-003 (rank 51, friction)
- Smallest change: Show the run, attempts and recorded effects in the recovery dialog, or link the run.
- Installs affected: All installs.

## RC-37

- Cause: After a decision the list marks the next row 'Selected' while the side panel still shows the item just decided.
- Owner: `apps/mission-control-next/src/cockpit/areas/inbox/InboxArea.tsx:171`
- Findings: U-IN-008 (rank 52, friction)
- Smallest change: After a decision, show the next item in the panel or clear the selection.
- Installs affected: All installs.

## RC-38

- Cause: An expired approval is still projected as waiting (Inbox count and badge) and its Chat card keeps dead buttons with no next step.
- Owner: `apps/gateway/src/services/inbox-projection-service.ts` (waiting count) and `apps/mission-control-next/src/cockpit/areas/chat/ChatBlockers.tsx` (card).
- Findings: U-IN-011 (rank 53, friction), U-CH-031 (rank 179, polish)
- Smallest change: Exclude expired plans and approvals from the waiting count, and give the expired card one "Ask again" or "Retry the turn" action.
- Installs affected: All installs.

## RC-39

- Cause: The Cockpit has no shared rule for where keyboard focus goes after a page loads, a button disables itself while it works, or a dialog or inline editor closes.
- Owner: `apps/mission-control-next/src/cockpit/ui/OverflowTabs.tsx:53` (scrollIntoView sets the Tab start point); `apps/mission-control-next/src/cockpit/areas/system/HealthOverview.tsx:148` and `apps/mission-control-next/src/cockpit/areas/inbox/InboxArea.tsx:271` (Refresh disables itself).
- Findings: U-GL-046 (rank 55, friction), U-GL-047 (rank 56, friction), U-GL-039 (rank 145, polish), U-GL-048 (rank 186, polish)
- Smallest change: Keep Refresh focusable while busy (aria-disabled instead of disabled), return focus to the opener on every dialog and inline-editor close, and stop the tab strip's scrollIntoView from moving the sequential focus start.
- Installs affected: All installs.

## RC-40

- Cause: Scroll restore records the position after the next page has already clamped the shared scroll container.
- Owner: `apps/mission-control-next/src/cockpit/app/use-cockpit-scroll.ts:24`
- Findings: U-GL-049 (rank 57, friction)
- Smallest change: Save the scroll position before navigation starts.
- Installs affected: All installs.

## RC-41

- Cause: Attached text documents are cut to 1,600 characters for the turn and nothing records or shows the cut.
- Owner: `apps/gateway/src/services/chat-attachment-service.ts:339`
- Findings: U-CH-035 (rank 58, friction)
- Smallest change: Show "Read the first N characters of <file>" in the turn and raise or explain the limit.
- Installs affected: All installs.

## RC-42

- Cause: Between approval and the effect receipt the Gateway marks the tool run "outcome uncertain" and the card prints that internal state.
- Owner: `apps/gateway/src/services/approval-resolution-effects-service.ts:3527`
- Findings: U-CH-047 (rank 62, friction)
- Smallest change: Show "Running after approval" until the receipt arrives; keep "uncertain" for a real timeout.
- Installs affected: All installs.

## RC-43

- Cause: The document tool always writes the title and a blank line at the top of a plain-text file.
- Owner: `packages/policy-engine/src/document-artifacts.ts:479`
- Findings: U-CH-049 (rank 63, friction)
- Smallest change: Write only the body for .txt when the request gives exact content (or drop the title line for txt).
- Installs affected: All installs.

## RC-44

- Cause: The project path check accepts a Windows drive path while refusing "/x" and "../x", and its refusal is worded in schema terms.
- Owner: `packages/storage/src/chat-project-repo.ts` (path rule) and `apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx` (form copy).
- Findings: U-PJ-001 (rank 64, friction), U-PJ-006 (rank 65, friction)
- Smallest change: Reject drive-letter and UNC paths in the same rule, and word the refusal with an example of an accepted path. The path-safety question (whether a stored drive path resolves outside the workspace root) is flagged for a security look.
- Installs affected: Windows installs for the drive-path case; all installs for the copy.

## RC-45

- Cause: A plugin check failure reaches the screen as a canned line; the Gateway's specific reason (blocker code, repeated id) is dropped or left in Technical details.
- Owner: `apps/gateway/src/services/capability-plugin-inspection-service.ts:71` (blocker codes) and `apps/mission-control-next/src/cockpit/areas/capabilities/plugins/plugin-check-copy.ts:25`.
- Findings: U-CP-001 (rank 66, friction), U-CP-002 (rank 67, friction)
- Smallest change: Have the Gateway attach a plain sentence per blocker (with the repeated id) and render it under the piece.
- Installs affected: All installs.

## RC-46

- Cause: An "open" action lands at the top of a long page and does not scroll to or focus what it opened.
- Owner: `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/connector-links.ts` and `apps/mission-control-next/src/cockpit/areas/library/LibraryAgentsWorkspace.tsx`.
- Findings: U-CP-007 (rank 71, friction), U-LB-013 (rank 81, friction)
- Smallest change: Link to the field's anchor and scroll it into view with focus.
- Installs affected: All installs.

## RC-47

- Cause: A policy block reaches Chat without the rule that blocked it, and the Trust and policy page lists only skills as blocked.
- Owner: `packages/mission-control-shared/src/components/chat/ChatToolActivity.tsx:152`
- Findings: U-ST-025 (rank 73, friction)
- Smallest change: Carry the matched rule id and its page into the block event and link it.
- Installs affected: All installs.

## RC-48

- Cause: The Firecrawl page computes its own allowlist verdict instead of asking the Gateway, and offers no way to edit the allowlist.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/FirecrawlSettings.tsx:101`
- Findings: U-ST-031 (rank 75, friction)
- Smallest change: Use the Gateway's verdict and add a link (or button) to the allowlist entry.
- Installs affected: All installs.

## RC-49

- Cause: A memory item's 'Memory provenance' shows only dates, expiry and namespace; why it was remembered (source, conversation, origin) is not on screen.
- Owner: `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryEditor.tsx:264`
- Findings: U-LB-009 (rank 77, friction)
- Smallest change: Show the source conversation, origin and the reason recorded with the item.
- Installs affected: All installs.

## RC-50

- Cause: Editing or forgetting a memory item stacks a review dialog, an approval request dialog and the danger review.
- Owner: `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryEditor.tsx`
- Findings: U-LB-010 (rank 78, friction)
- Smallest change: Open the danger approval directly from the edit review, in one dialog.
- Installs affected: All installs.

## RC-51

- Cause: Ids, hashes, revisions, raw setting names, absolute paths and raw JSON are printed as ordinary text, which DESIGN.md:71 confines to TechnicalDetails.
- Owner: Each finding's own component; the ratchet that should catch them is `scripts/check-mission-control-next-raw-values.mjs`.
- Findings: U-LB-011 (rank 79, friction), U-CH-022 (rank 109, friction), U-CH-043 (rank 117, polish), U-CP-011 (rank 120, polish), U-GL-007 (rank 126, polish), U-GL-019 (rank 131, polish), U-GL-032 (rank 139, polish), U-GL-033 (rank 140, polish), U-CH-013 (rank 161, polish), U-ST-012 (rank 172, polish), U-ST-013 (rank 173, polish), U-ST-015 (rank 174, polish), U-PJ-004 (rank 190, polish), U-ST-028 (rank 193, polish), U-LB-001 (rank 194, polish), U-LB-015 (rank 199, polish), U-SY-015 (rank 202, polish), U-WK-017 (rank 209, polish), U-CP-019 (rank 210, polish), U-IN-012 (rank 213, polish)
- Smallest change: Move each value into TechnicalDetails or replace it with its name (workspace, skill, model, actor), and lower the ratchet to zero for the files listed.
- Installs affected: All installs.

## RC-52

- Cause: 'Upload text file' has no file chooser: the operator types a path and pastes the file's text into a box.
- Owner: `apps/mission-control-next/src/cockpit/areas/library/LibraryFileUpload.tsx:143`
- Findings: U-LB-012 (rank 80, friction)
- Smallest change: Add a file chooser that reads the file in the browser and fills the form.
- Installs affected: All installs.

## RC-53

- Cause: Some pages do not follow the DESIGN.md page anatomy (one header with one Refresh, at most one line of description, one empty state that says what will appear).
- Owner: DESIGN.md:100-105, enforced in part by `scripts/check-mission-control-next-page-anatomy.mjs`; the pages are each finding's owner.
- Findings: U-LB-014 (rank 82, friction), U-SY-006 (rank 86, friction), U-GL-020 (rank 132, polish), U-ST-014 (rank 192, polish), U-LB-004 (rank 196, polish), U-LB-006 (rank 197, polish), U-LB-007 (rank 198, polish), U-SY-014 (rank 201, polish)
- Smallest change: Fold section Refresh buttons and stacked caveats into the header, and give each empty list one EmptyState that says how items appear.
- Installs affected: All installs.

## RC-54

- Cause: Library > Knowledge has no list of ingested sources.
- Owner: `apps/mission-control-next/src/cockpit/areas/library/LibraryKnowledgeWorkspace.tsx`
- Findings: U-LB-016 (rank 83, friction)
- Smallest change: List ingested sources with their date and status.
- Installs affected: All installs.

## RC-55

- Cause: The board editor's 'Preview live widgets' does not show the layout you are arranging.
- Owner: `apps/mission-control-next/src/cockpit/areas/system/CockpitBoardEditor.tsx:302`
- Findings: U-SY-003 (rank 84, friction)
- Smallest change: Render the preview from the unsaved layout.
- Installs affected: All installs.

## RC-56

- Cause: System pages render a failed load with the empty-state component.
- Owner: `apps/mission-control-next/src/cockpit/ui/EmptyState.tsx:20`
- Findings: U-SY-004 (rank 85, friction)
- Smallest change: Use the error Callout with a Retry for failed loads.
- Installs affected: All installs.

## RC-57

- Cause: The "Close session" button only closes the details panel.
- Owner: `apps/mission-control-next/src/cockpit/areas/system/SelectedSessionSection.tsx:37`
- Findings: U-SY-010 (rank 87, friction)
- Smallest change: Rename it "Close details".
- Installs affected: All installs.

## RC-58

- Cause: The backup receipt is the only place that names the backup location, and it disappears.
- Owner: `apps/mission-control-next/src/cockpit/areas/system/HealthBackupAction.tsx:129`
- Findings: U-SY-011 (rank 88, friction)
- Smallest change: Show the latest backup path and time on the Health backup card.
- Installs affected: All installs.

## RC-59

- Cause: A result shown as "unavailable" carries no reason and no next step.
- Owner: `packages/mission-control-shared/src/components/chat/chat-display-helpers.ts:25` (Review answer) and `apps/mission-control-next/src/cockpit/areas/system/quality/QualityEvidence.tsx:35` (evaluations).
- Findings: U-SY-013 (rank 89, friction), U-CH-023 (rank 165, polish)
- Smallest change: Pass the Gateway's reason (no reviewer model, nothing run yet) into the label and add the next step.
- Installs affected: All installs.

## RC-60

- Cause: System > Activity reads one page of 100 retained signals and never follows the cursor it receives.
- Owner: `apps/mission-control-next/src/cockpit/areas/system/SystemActivity.tsx` (nextCursor used only for a sentence).
- Findings: U-SY-016 (rank 90, friction), U-SY-005 (rank 200, polish)
- Smallest change: Add "Load older" with the cursor and count the rows actually shown.
- Installs affected: All installs.

## RC-61

- Cause: The Work board mixes tasks and runs in run-status lanes and counts only the loaded page.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkBoard.tsx`.
- Findings: U-WK-003 (rank 91, friction), U-WK-018 (rank 217, polish)
- Smallest change: Separate task lanes from run lanes and show the Gateway's total in lane headers.
- Installs affected: All installs.

## RC-62

- Cause: A run page still ends in a stack of evidence panels, with the recorded errors list at the bottom.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkRunDetail.tsx:209`
- Findings: U-WK-004 (rank 92, friction)
- Smallest change: Lead the run page with what it is waiting on; move evidence panels below and do not list an approval wait as an error.
- Installs affected: All installs.

## RC-63

- Cause: Tasks created by Chat delegation record the run as `agenticContext.runId` only, and the task page links a run only through `durableRunId`.
- Owner: `apps/gateway/src/services/chat-delegation-service.ts:1364`; link condition at `apps/mission-control-next/src/cockpit/areas/work/WorkTaskDetail.tsx:116`.
- Findings: U-WK-005 (rank 93, friction)
- Smallest change: Set `durableRunId` on delegation tasks, or let the task page link `runId`.
- Installs affected: All installs, every Chat-delegated task.

## RC-64

- Cause: The run page does not refetch after Pause.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkRunControls.tsx:229`
- Findings: U-WK-011 (rank 94, friction)
- Smallest change: Invalidate the run query on Pause and Resume.
- Installs affected: All installs.

## RC-65

- Cause: The schedule summary formats next run times coarsely and shows "Not reported" when the Gateway omits the next time for daily and weekly schedules.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkScheduleSummary.tsx`.
- Findings: U-WK-012 (rank 95, friction), U-WK-013 (rank 96, friction)
- Smallest change: Compute and show the next fire time for every enabled schedule, and use TimeText with minutes for times within the hour.
- Installs affected: All installs.

## RC-66

- Cause: A Task schedule adds its task to the default workspace, whichever workspace created the schedule (cause not isolated in code).
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkScheduleCreateForm.tsx`
- Findings: U-WK-014 (rank 97, friction)
- Smallest change: Store the creating workspace on the schedule and create the task there.
- Installs affected: All installs.

## RC-67

- Cause: History titles runs from the workflow kind, not from the task or conversation they ran for.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/work-board.ts:42`
- Findings: U-WK-015 (rank 98, friction)
- Smallest change: Title runs from their linked task or conversation.
- Installs affected: All installs.

## RC-68

- Cause: The integration add flow starts from a full platform catalogue and leaves the Google sign-in several steps and two screens away from "Set up".
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/IntegrationManagementSettings.tsx` and `apps/mission-control-next/src/cockpit/areas/capabilities/connectors/ConnectorPanel.tsx`.
- Findings: U-CP-016 (rank 99, friction), U-CP-020 (rank 102, friction)
- Smallest change: Filter platform entries to the host OS and have "Set up" on Gmail and Calendar open the add form for that integration directly.
- Installs affected: All installs.

## RC-69

- Cause: Every 'Start guided setup' in Advanced channel setup saves another draft, and the Drafts list shows identical rows with no time.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx:136`
- Findings: U-MS-003 (rank 106, friction)
- Smallest change: Reuse an open draft for the same channel and show each draft's creation time.
- Installs affected: All installs.

## RC-70

- Cause: Channel setup marks the sender allowlist step complete when it is empty, and the only way to learn one's own sender id is a dropped message read from Diagnostics.
- Owner: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/channel-wizard-model.ts` and `apps/gateway/src/services/channel-inbound-dispatch.ts`.
- Findings: U-MS-006 (rank 107, friction), U-MS-007 (rank 108, friction)
- Smallest change: Mark the step incomplete while the list is empty, and show "Message from <id> was dropped: allow it?" in the channel page when it happens.
- Installs affected: Installs that set up a messaging channel.

## RC-71

- Cause: Chat's outage banner and approval card are not tied to the connection probe, so the banner outlives the outage and the card offers live buttons during it.
- Owner: `packages/threaded-surface-core/src/chat/chat-error-copy.ts` and `apps/mission-control-next/src/cockpit/areas/chat/ChatApprovalRenderer.tsx`.
- Findings: U-CH-026 (rank 110, friction), U-CH-027 (rank 215, polish)
- Smallest change: Clear the banner when the probe succeeds and disable decision buttons while the probe says the Gateway is unreachable.
- Installs affected: All installs.

## RC-72

- Cause: The terminal onboarding wizard writes provider settings before saving the key and treats Ctrl+C as a crash.
- Owner: `apps/gateway/src/onboarding-tui.ts:207`
- Findings: U-FR-008 (rank 111, friction), U-FR-009 (rank 112, friction)
- Smallest change: Save the key first and write settings only after it succeeds; catch the prompt library's cancel error and exit quietly.
- Installs affected: Installs set up with `pnpm onboarding:tui` (not the desktop path).

## RC-73

- Cause: The token sign-in form is not a form: Enter does nothing, a refused token is reported as "access changed", and its tick box and heading are styled outside the shared primitives.
- Owner: `packages/mission-control-shared/src/components/GatewayAccessGate.tsx:399` (form and tick box); `apps/mission-control-next/src/app/use-gateway-access.ts` (the refusal wording).
- Findings: U-GL-052 (rank 113, friction), U-GL-053 (rank 114, friction), U-GL-054 (rank 216, polish)
- Smallest change: Wrap the fields in a form with the Connect button as submit, map a 401 on first sign-in to "That token was refused", and use the shared checkbox and heading spacing.
- Installs affected: Token-mode installs (Docker, and any install that turned sign-in on).

## RC-74

- Cause: The secure-input change handler reads the event inside a state updater, which throws when React runs the updater late (development build).
- Owner: `packages/mission-control-shared/src/components/chat/ChatChangePlanActionDialogBody.tsx:107`
- Findings: U-ST-029 (rank 115, polish)
- Smallest change: Read `event.currentTarget.value` into a local before calling the setter.
- Installs affected: Development builds; production possible but not reproduced.

## RC-75

- Cause: The panel for a Danger shell approval shows a 'Safe' badge next to 'Run Command: with 2 arguments'.
- Owner: `apps/mission-control-next/src/cockpit/areas/inbox/ApprovalShellExplanations.tsx`
- Findings: U-IN-010 (rank 118, polish)
- Smallest change: Take the badge from the approval's risk, not from the argument parser.
- Installs affected: All installs.

## RC-76

- Cause: The danger approval review repeats what the card or panel already shows, and the Inbox adds a row-selection click before it.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalConfirmationBody.tsx` and `apps/mission-control-next/src/cockpit/areas/inbox/InboxApprovalActions.tsx`.
- Findings: U-IN-015 (rank 119, polish), U-CH-014 (rank 178, polish), U-CH-042 (rank 181, polish)
- Smallest change: Let the Inbox row's danger button open the confirmation directly, drop the repeated Action and Command lines from the dialog, and fold "How this decision works" into the dialog.
- Installs affected: All installs.

## RC-77

- Cause: Reversible actions (pause, resume, archive, restore, switching an integration) each open a review dialog.
- Owner: `apps/mission-control-next/src/cockpit/areas/work/WorkScheduleInspector.tsx` and `apps/mission-control-next/src/cockpit/areas/settings/IntegrationConnectionsSettings.tsx`.
- Findings: U-WK-010 (rank 121, polish), U-ST-011 (rank 171, polish)
- Smallest change: If the operator confirms the design decision below, apply at once with an Undo toast.
- Installs affected: All installs.

## RC-78

- Cause: New conversation creates and saves an empty conversation at once and remounts the composer, so empty "New chat" rows pile up and early keystrokes can be lost.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ConversationListPanel.tsx` (New), `ChatTextComposer.tsx` (remount) and `apps/mission-control-next/src/cockpit/app/use-command-new-chat.ts` (palette path).
- Findings: U-CH-024 (rank 122, polish), U-GL-031 (rank 138, polish), U-CH-041 (rank 180, polish), U-CH-034 (rank 187, polish)
- Smallest change: Create the conversation on first send, keep the composer mounted across New, and say "Start a conversation" when the list is empty.
- Installs affected: All installs.

## RC-79

- Cause: Heading and body sizes do not follow the DESIGN.md type scale: most copy is 12 to 13 px and heading levels do not match their sizes.
- Owner: `apps/mission-control-next/src/cockpit/ui/Section.tsx`, `AreaHeader.tsx` and `apps/mission-control-next/src/cockpit/styles/cockpit.css`.
- Findings: U-GL-011 (rank 127, polish), U-GL-012 (rank 128, polish), U-GL-035 (rank 141, polish)
- Smallest change: Set Section and dialog titles to the documented sizes and raise body and safety copy to the base size in the shared primitives.
- Installs affected: All installs.

## RC-80

- Cause: The document title and page headings come from the area, not the tab, conversation or run that is open.
- Owner: `apps/mission-control-next/src/cockpit/app/cockpit-document-title.ts`.
- Findings: U-GL-024 (rank 135, polish), U-GL-051 (rank 150, polish)
- Smallest change: Build the title from the active tab and, in Chat and Work, the conversation or run name.
- Installs affected: All installs.

## RC-81

- Cause: The sheet, inspector and dialog runtimes do not handle stacking and persistence: sheet headers scroll away, nested dialogs do not dim, and inspector width is not kept.
- Owner: `apps/mission-control-next/src/cockpit/ui/SheetDrawerRuntime.tsx`, `DialogRuntime.tsx` and `apps/mission-control-next/src/cockpit/app/inspector.tsx`.
- Findings: U-GL-029 (rank 136, polish), U-GL-030 (rank 137, polish), U-GL-042 (rank 148, polish)
- Smallest change: Sticky sheet header, a backdrop per dialog layer, and the inspector width saved per area.
- Installs affected: All installs.

## RC-82

- Cause: A failed command palette search says 'Try again' but has no Retry button.
- Owner: `apps/mission-control-next/src/cockpit/app/CommandPaletteView.tsx:178`
- Findings: U-GL-038 (rank 144, polish)
- Smallest change: Add a Retry button to the failed search state.
- Installs affected: All installs.

## RC-83

- Cause: Cockpit Chat still renders the Classic controller frame and Classic blocks (error rows, loading tiles, Save as skill block).
- Owner: `packages/threaded-surface-core/src/chat/controller/renderChatControllerFrame.tsx` and `packages/threaded-surface-core/src/chat/ThreadedLoadingState.tsx`.
- Findings: U-GL-041 (rank 147, polish), U-CH-010 (rank 159, polish), U-CH-011 (rank 160, polish)
- Smallest change: Give Cockpit Chat its own frame from the cockpit primitives.
- Installs affected: All installs.

## RC-84

- Cause: Jump to latest counts new messages but does not say or jump to a decision waiting for you.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ChatTranscript.tsx:344`
- Findings: U-CH-003 (rank 153, polish)
- Smallest change: Make Jump to latest name and jump to a waiting decision first.
- Installs affected: All installs.

## RC-85

- Cause: Route preflight keeps an entry for every draft ever typed and resets its displayed result on every keystroke.
- Owner: `packages/threaded-surface-core/src/chat/useChatRoutePreflight.ts:123`
- Findings: U-CH-006 (rank 156, polish)
- Smallest change: Bound the cache and keep the last result until the new check returns.
- Installs affected: All installs.

## RC-86

- Cause: A finished streamed answer may remount its already-rendered blocks when streaming ends.
- Owner: `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx:581`
- Findings: U-CH-008 (rank 157, polish)
- Smallest change: Reuse the streamed block keys when the answer settles.
- Installs affected: All installs.

## RC-87

- Cause: An optional background question has no Skip button.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ChatPendingQuestion.tsx:39`
- Findings: U-CH-009 (rank 158, polish)
- Smallest change: Add a Skip button for optional questions.
- Installs affected: All installs.

## RC-88

- Cause: Chat transcript actions decide per place whether to confirm, so Reload and Retry ask in some places and not in others.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ChatTurnActions.tsx` and `ChatTranscript.tsx`.
- Findings: U-CH-015 (rank 162, polish), U-CH-016 (rank 163, polish)
- Smallest change: One rule: confirm only when the turn recorded an external effect.
- Installs affected: All installs.

## RC-89

- Cause: The gear menu's accessible name promises an account entry the menu does not have.
- Owner: `apps/mission-control-next/src/cockpit/app/Sidebar.tsx:263`
- Findings: U-ST-004 (rank 167, polish)
- Smallest change: Rename it "Settings and theme".
- Installs affected: All installs.

## RC-90

- Cause: 'Open approval' and 'Open in Inbox' on an Inbox row open the same Inbox again.
- Owner: `apps/mission-control-next/src/cockpit/areas/inbox/InboxItemCard.tsx`
- Findings: U-IN-014 (rank 185, polish)
- Smallest change: Make "Open approval" open the source (conversation or run) and drop the duplicate link.
- Installs affected: All installs.

## RC-91

- Cause: After a message with an attached file is sent, the transcript still says 'Attached <file> for the next turn.'.
- Owner: `packages/threaded-surface-core/src/chat/useChatComposerPaletteActions.ts:68`
- Findings: U-CH-036 (rank 188, polish)
- Smallest change: Remove the "for the next turn" note once the message is sent.
- Installs affected: All installs.

## RC-92

- Cause: After 'Keep draft and close' nothing on the project page says an unsaved draft exists.
- Owner: `apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx`
- Findings: U-PJ-005 (rank 191, polish)
- Smallest change: Show "Unsaved draft" on the file row after Keep draft and close.
- Installs affected: All installs.

## RC-93

- Cause: Memory search needs an 'Apply memory filter' click while every other Library list filters as you type.
- Owner: `apps/mission-control-next/src/cockpit/areas/library/LibraryMemoryWorkspace.tsx:179`
- Findings: U-LB-003 (rank 195, polish)
- Smallest change: Filter as the operator types, like the other Library lists.
- Installs affected: All installs.

## RC-94

- Cause: The Design quality checks look for source files relative to the Gateway process root.
- Owner: `packages/skills/src/design-quality.ts:221`
- Findings: U-SY-017 (rank 203, polish)
- Smallest change: Skip the source checks when the files are absent, with a "not applicable to this install" line.
- Installs affected: All installs.

## RC-95

- Cause: Several panels poll their own reads instead of sharing one query, so idle pages repeat the same request.
- Owner: `apps/mission-control-next/src/cockpit/areas/settings/BudgetModeControl.tsx` (repeated settings read) and `apps/mission-control-next/src/cockpit/areas/work/work-queries.ts` (refetch of every loaded page).
- Findings: U-WK-008 (rank 206, polish), U-GL-050 (rank 212, polish)
- Smallest change: Share the settings query across panels and refetch only the first page on the fallback poll.
- Installs affected: All installs.

## Design decisions for the operator

Current behaviour that DESIGN.md or PRODUCT.md specifies (or that no document settles) is not a finding. Each entry says what it rests on and what would change if you decide the other way. Sources: the `DESIGN-DECISION` notes in `prior-register.json` and the "Design decisions to confirm" sections of the journey files, deduplicated.

1. Risk labels read Safe, Caution, Danger, Nuclear (register GL-08). Rests on DESIGN.md:54, :60, :71. Other way: switch the shared presenter to Low, Medium, High, Critical and update DESIGN.md; the policy values do not change.
2. Flat surfaces: canvas, raised and sunken are nearly the same tone, separated by hairlines (register GL-34). Rests on DESIGN.md:30 and :48. Other way: widen the surface ladder in the colour table.
3. Text tiers are close to each other in dark mode while meeting contrast (register GL-35). Rests on DESIGN.md:31. Other way: widen the tiers.
4. Plain names first, Citadel names second ("Rules · Wards") (register ST-14). Rests on DESIGN.md:69. Other way: drop the Citadel names from tabs.
5. No bordered box inside another (register ST-16). Rests on DESIGN.md:103. Already met; listed because the old review asked for a change.
6. Dashboards and Quality stay in System (register SY-09). Rests on PRODUCT.md:37 and :15. Other way: move them to an expert-only place, which would also take most of the System > Quality polish findings off the default path.
7. Every page header carries a Refresh button despite live updates (register GL-57). Rests on DESIGN.md:102. Other way: drop manual Refresh where the page is live, which would also clear U-ST-014 and the focus loss after Refresh in U-GL-047.
8. Running uses the accent colour and neutral uses muted text, with distinct icons (register GL-60). Rests on DESIGN.md:34 and :54. Other way: give running its own status colour.
9. A danger approval takes two clicks (a red review button, then Approve once); caution and safe take one (Task 7, the former U-CH-029). Rests on DESIGN.md:60. Other way: use the existing one-click `reviewedInPlace` path (`RiskApprovalAction.tsx:43-46`) where the card already shows the command, keeping the typed confirmation for nuclear; that needs a DESIGN.md change and matches your one-click preference.
10. In the Inbox a danger approval is three clicks: the row's Review opens the panel before the documented review (Task 8). Rests on DESIGN.md:60, which specifies two. The extra click is kept as the polish finding U-IN-015; decide whether the row's button should open the confirmation directly.
11. Turning on an install-wide skill is a Danger approval: one click in the Capabilities dialog, two in the Inbox, and no danger review step in either (Task 8). Rests on DESIGN.md:60 (approvals scale with risk). Decide which behaviour is meant for install-wide skill changes.
12. Turning a skill or tool group on asks for approval (labelled Danger for skills) while turning it off is instant, even for a built-in skill switched off a moment earlier (Task 9). Rests on PRODUCT.md:24 (capability activation stays governed). Other way: a lower risk label for built-in, trusted skills.
13. Reversible actions (archive, restore, pause, resume, switching an integration) each open a review dialog (Tasks 8 and 11; findings U-WK-010 and U-ST-011, polish). DESIGN.md:58 lists them as reversible but does not ask for a dialog. Other way: apply at once with an Undo toast, which clears both findings.
14. Auth mode `none` cannot use Chat's "Use Auto mode" or Managed project files, which token mode can (U-CH-018; confirmed by the token-mode comparison, `evidence/gl/tk-ch-1-project.json`). Rests on the Gateway's rule that mode none cannot prove a local caller (`session-control-request-context.ts:154`) and PRODUCT.md:24; no document states it. Question: should mode-none installs (the desktop default) get both? If yes, grant `directLocal` to mode-none loopback requests; if no, the composer and Settings > Access should say so (RC for U-CH-018).
15. The budget preference applies at once without approval, while the tool approval rule asks (Task 11). The Budgets page calls it "a preference only"; PRODUCT.md:24 governs risky actions, not preferences. Other way: govern budget changes like other Settings.
16. First run asks for an explicit "Keep current rule" even when the approval rule is already the safe default (Task 12). Rests on PRODUCT.md:13 (safe by default, guided). Other way: pre-confirm the default and save a click.
17. Editing the first message branches the conversation ("Version 2 of 2") and hides the later turns of version 1 behind the version selector; the conversation list keeps the old title (Task 6). No DESIGN.md or PRODUCT.md line covers it. Other way: keep later turns visible or retitle the conversation from the current version.
18. Prompt packs appear in the composer only when they have a run-variable schema, and no screen creates one (Task 6). No document covers it. Other way: list every pack and ask for variables only when a schema exists.
19. The Chat composer keeps an unsent draft silently when you leave, while Settings, Work and Library editors ask before you leave (Task 13a). DESIGN.md:62 specifies the shared unsaved-changes prompt for editors. Other way: one rule for both.
20. A first-time operator on a token-mode install must find the token themselves; the sign-in page offers "Request approval from another device" but no hint where the token is (Task 13b). Rests on PRODUCT.md:13. Other way: add one sentence naming where the token is printed.
21. Messaging channel maturity ("beta" on 13 of 14 channels) is never shown, and the picker's minutes differ from the setup page's estimate (Task 14). PRODUCT.md:21 and DESIGN.md:69 ask experimental things to say so. Other way: a "beta" label on the tiles and one time estimate.
22. "Plan first" stays on after sending, so the next message is planned too (Task 14). No document covers it. Other way: make it a one-message option.
23. Spend shows cost per provider and recent calls, not per model (Task 10). PRODUCT.md:37 puts cost in System without detail. Other way: add a per-model breakdown.
24. Dashboards can be archived and restored but not deleted (Task 10). DESIGN.md:58 treats archive as the reversible path. Other way: add a governed delete.
25. System > Sessions lists every workspace's conversations, while its controls bind to the selected workspace (Task 10; the cost is U-SY-009). PRODUCT.md:37 puts runtime truth in System. Decide which side gives: list only the selected workspace, or let the controls switch workspace.

## Engineering notes

Developer hygiene with no operator-visible symptom, including the findings moved here (listed in `withdrawn.json` with disposition `engineering-note`).

- Moved findings: U-GL-014 (raw buttons and literal radii, register GL-42), U-GL-015 (67 restyled Classic/shared class names, GL-43), U-GL-017 (bundle budget measures the entry stub, GL-48), U-GL-018 (Tailwind scans the whole app folder, GL-50), U-GL-002 (non-Chat pages load the Chat module graph; production opens every area in under 1 s), U-WK-007 (one navigation handoff owner per link), U-CH-007 (the Chat inspector registers twice), U-ST-032 (171 near-identical grants, most likely seeded by test tasks).
- Path safety (ledger ruling for U-PJ-006): a project stored with a Windows drive path is resolved with `path.resolve` at `chat-workbench-service.ts:1029` and `:1610`, which may point outside the workspace root. This review did not test exploitation; give it a security look before the copy fix.
- `ChatChangePlanActionDialogBody.tsx:107-113` reads `event.currentTarget.value` inside the updater; the unit test (`ChatChangePlanActionDialog.test.tsx:267`) passes an event whose `currentTarget` is never nulled, so it cannot catch it.
- `daemon-route-service.ts:100` hard-codes `supported: false`, so the Running and Problem branches of `describeRuntimeService` (`packages/mission-control-shared/src/content/runtime-service.ts`) are unreachable.
- `SystemActivity.tsx` receives `nextCursor` and uses it only for a sentence; `packages/skills/src/design-quality.ts:218` checks files under the Gateway process root.
- Governed Settings cards exist in two shapes (in-place dialog in `GovernedSettingParts.tsx`; link plus Continue in `ApprovalModeControl.tsx` and `FilesystemWriteAccessParts.tsx`). Task 11 also noted that `ApprovedSettingsContinuation` renders whenever the plan is not confirmed; on the pinned SHA it is skipped when the receipt names an approval (`GovernedSettingParts.tsx:124-131`), so only cards without an in-place approval show it.
- `ChatManagedFiles.tsx` requests approval mode for every project conversation even in auth modes where the route always refuses; the Gateway logs a WARN per load.
- `use-first-run-setup.ts` keeps "safety confirmed" in React state (lost on reload; Finish re-checks, so no harm). `recheckLocalEndpoint` ignores `source` and `warning` (see the guided-setup root cause). After the development-build crash the Models page keeps a stale "awaiting input" plan card; plans are not expired on the next visit.
- 21 on-by-default `...Enabled` flags have no UI reference at all (Task 11); `use-cockpit-shell-switch.tsx` exports `visit()` with no caller; other `scrollIntoView` callers (for example `WindowedRecordList.tsx:212`) may move the Tab start point like `OverflowTabs.tsx:53`.
- API hygiene: `GET /api/v1/capabilities/plugins` without `workspaceId` answers 400 with a raw zod message; a 404 on `plugins/detail` after an uninstall comes from the still-open panel; `GET /api/v1/files/download` returns JSON (base64), and Chat's "Download the document" works only through its in-page handler; mutating calls need an `Idempotency-Key` header; `route-preflight` and `agent-send` both need `providerId` and `model` or the send returns 409 `route_effective_mismatch`.
- A sentence with "review ... project" (or inspect, audit, trace near repo, codebase, workspace, project) can start a controller-driven code search and its approval when the model returns an empty turn (`chat-turn-agent-runner.ts:14593-14612`); a real model that answers does not reach it.
- Verification routes: `chat-approval-scenario` answered 500 `STATE_CONFLICT` within about 4 s of a finished turn (the durable admission is released a few seconds after the reply shows); `durable-recovery-seed` creates approvals without linkage and runs without a workspace.
- Testbench: no slow-stub option, so streaming states cannot be tested from outside; it always completes onboarding; about 40 s to start; the Stop button stays 100 to 250 ms after the Gateway completed the turn.
- Memory forget uses the generic approval title "Review memory lifecycle" while docs ingest sets its own; the Connectors tab opens by default although Skills is first in the row.

## Sandbox artifacts

Things seen only because of the test setup; not findings.

- The shared sandbox ran with no OS keychain (`GOATCITADEL_DISABLE_SECRET_STORE=true`). That is why U-ST-033, U-MS-001 and the MCP connect failure in U-CP-014 could be seen; on the Windows desktop app with a working keychain the first two do not occur, and U-CP-014's gap holds for any connect failure.
- U-PJ-003 (withdrawn in Task 8): a greeting containing "review ... project" raised a code-search approval only because the stub returns an empty turn.
- The seeded "Mission Control Verification" project folder is not a git repository, so Create worktree failed there (U-CH-043 is real only when a project folder has lost its `.git` or git is missing).
- "Run workspace unknown" on Activity's durable-run rows (the withdrawn U-SY-008) came from dev verification routes that create runs with no workspace; U-IN-013 has the same dependency.
- Activity's 76 signals in 14 minutes and the 171 recorded grants are seeding volume, not real-use rates.
- Seeded turns show "Version 2 of 2" and an approved fixture tool line reads "Outcome uncertain" because the fixture has no executor.
- Development-server numbers in the large-data check (first content 1.2 to 1.9 s, a 300 ms frame opening a 1,001-conversation thread, about 130 ms per key in the list filter) are Vite dev-server effects; the production build was 0.5 to 0.9 s with at most a 100 ms frame. The production thread open, 909 ms with plain stub text, is the closest to the 1 s line; a long real conversation was not covered.
- A public web address left in the shared sandbox by Task 14 was not declared in its notes; the Task 13b sandbox and its data were removed with its scratch runtime.

## Register corrections

The ledger asked for three corrections to `prior-register.json`. `apply-verdicts.cjs` refuses a priorId that appears in more than one verdict file (`loadEntries`: "priorId also appears in ..."), so a later `b10-corrections.json` cannot override an earlier row. The register is therefore left unchanged and the corrections are recorded here:

- N-04 (auth mode none: Dashboards dead end and a Chat 403 on every open), recorded `cannot-check`: should read `partial`. The Dashboards half is fixed; the Chat-composer half is real mode-none behaviour, not a sandbox artifact, and is carried as U-CH-018 (confirmed by the token-mode comparison in Task 13b).
- OL-07 (Gateway outage and recovery), recorded `operator-only`: should read `partial`. Task 6 verified the stop behaviour live (banner within about 5 s, draft kept); the frozen-Gateway banner that stays until reload is U-CH-026 and the live-looking approval buttons are U-CH-027; recovery after a real restart remains operator-only.
- OL-14 (`use <name>` in Chat), recorded `operator-only`: should read `open`, carried as U-CH-044. The reader runs in the Gateway before the model, so the stub settled it: with the default `chatSkillInstructionsV1Enabled` false no skill loads and nothing is shown.

## For the operator checklist

- The packaged-app step of Task 12 (Step 4: installed desktop app, which shows a window) is still pending your answer; if not run it stays operator-only.
- Library > Memory by keyboard: edit and forget an item and check focus returns after the approval (the sandbox had no memory item when Task 13a ran).
- Task 13b stopped two seed-helper processes (PIDs 63212 and 9164) without first checking their command lines; they were the review's own helpers, but you may want to know.
- Gateway restart recovery (register OL-07): stop and restart the desktop Gateway with a Chat draft open and check the banner clears without a reload.
- The real-account steps for channels, Google sign-in, a vendor MCP call and the real-model leftovers are in `journeys/task-14.md` ("Operator checklist").

## Retired ids

Ids that earlier journey notes mention but that are not in `findings.json`, because the finding was retitled before Task 15 (the id map is keyed by title) or withdrawn by its task: U-CH-019 is U-CH-025; U-CH-029 became design decision 9; U-CH-030 is U-CH-041; U-CH-037 is U-CH-043; U-CH-039 is U-CH-044; U-PJ-002 is U-PJ-006; U-PJ-003 was withdrawn (sandbox); U-IN-007 is U-IN-015; U-IN-009 is U-IN-016; U-CP-008 is U-CP-013; U-CP-009 is U-CP-014; U-CP-010 is U-CP-015; U-SY-007 is U-SY-016; U-SY-008 was withdrawn (sandbox); U-SY-012 is U-SY-017; U-ST-019 is U-ST-029; U-ST-024 is U-ST-030; U-ST-026 is U-ST-031; U-FR-003 is U-FR-012; U-FR-007 is U-FR-013; U-FR-010 is U-FR-015. Task 7's note that the sticky "You asked" bar is "U-CH-001" means U-CH-028.
