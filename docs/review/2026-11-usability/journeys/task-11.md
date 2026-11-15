# Task 11: Settings

Live runs: Playwright headless, 1440x900 dark, sandbox testbench Gateway (auth mode `none`, stub model, no OS keychain), `default` workspace unless stated. Evidence: `docs/review/2026-11-usability/evidence/st/`. New findings are U-ST-019 to U-ST-028, plus one polish finding added in fix round 1 (the recorded-grants list on Safety > Tools; its id is assigned at the next merge). Carried Settings findings before this task: U-ST-001 to U-ST-018 (none duplicated; see Notes on existing findings).

Setup and cleanup notes:
- Pages walked: Settings General, Models (Get started / Providers & models / Local AI), Safety (Permissions, Tools, Trust & policy, Hooks, Budgets), Citadel (Workspaces and the rest read), Access, Advanced, first-run; plus Capabilities > Connectors > Advanced setup > Web & Search (where Firecrawl lives since the Connections retirement).
- Settings before and after: `st-9-settings-before.json` and `st-9-settings-after.json` (paths replaced by `<sandbox runtime root>`), difference in `st-9-settings-diff.json`. Revision 14 to 35. Every value touched is back to its start; the only differences are the order of the `globalToolAccess.deny` list (same set, `fs.copy` moved to the end) and the provider `ut11-local` I added (the UI has no way to remove a provider profile).
- Created and left: provider profile `ut11-local-unreachable` (http://127.0.0.1:9, no key); two archived workspaces `ut11-workspace` and `ut11-workspace-b` (the UI archives, never deletes); two Chat conversations named `ut11 hello` (one failed, one answered by the stub); three of my own provider plans still open but expired (`Replace API key` for the stub and for `ut11-local-unreachable`, `Add ut11-local-unreachable` manual required). Removed: personality `ut11-personality`.
- Mistake, repaired: while restoring a workspace description my script edited the wrong card, after the list re-ordered itself, and wrote the demo text into `Default Workspace` and a `(ut11)` suffix into `GoatCitadel Demo`. I restored name and description of both through the Gateway API with fresh idempotency keys; that regenerated the Default slug (`default-workspace`), which I set back to `default`. Both workspaces' revision numbers and updated-at times moved. The seeded shell.exec approval was left pending.
- Screenshots scanned for absolute paths: the only page that prints them is Safety > Tools (Filesystem write roots). `st-9-safety-tools.png` showed them and was redacted in place (opaque boxes, verified by cropping). Opened and found clean: `st-6-after-reload-pending.png`, `st-2-approval-rule-after-save.png`, `st-2-default-inplace-waiting.png`, `st-6-allow.png`, `st-2-default-approval-1.png`, `st-9-crawl-_settings_safety.png`, `st-1-advanced-provider-config.png`, `st-1-models-open-plans.png`, `st-1-profile-applied.png`, `st-8-set-test.png`, `st-9-safety-tools.png` (after redaction). Every other PNG comes from a page whose full text I scanned for the user name, `Users`, the repo path and the runtime folder name: none printed (Models, Local AI, Access, Advanced, Citadel, General, first-run, Web & Search, Inbox, Chat, Work, Library, System). One console capture had a dev-server module path, replaced by `<dev-server module>`.
- The Settings pages the brief listed as release-scope hidden ("Change this workspace's skills" links) were not reached from any Settings page I opened; U-FR-002 (Diagnostics Access link) not re-walked.

## ST-1 Add a provider with a key, pick a default model, send a Chat message with it
Result: PARTLY RUN
Findings: U-ST-019 (blocker if it reproduces on a production build; confirmed on the development build only, so recorded as `likely`), U-ST-022, U-ST-023 (`likely`), U-ST-024 (friction); also U-ST-002 and U-ST-014 (see notes)
Time: Add provider profile dialog to review 2.6 s, apply 0.3 s; secure-input dialog opens at once; first keystroke crashes the page. Check connection not timed (button absent on loads that showed Done).
Code path: `cockpit/areas/settings/ModelsSettings.tsx` -> `CockpitGuidedModelSetup.tsx` / `use-guided-model-setup.ts` -> `ProviderManagementSettings.tsx`, `ProviderConnectionSettings.tsx` (`prepareCredential`) -> `POST /api/v1/change-plans` (adapter `provider-connection`) -> `POST /api/v1/change-plans/:id/provider-secret` -> Gateway provider-connection service; secure input dialog `packages/mission-control-shared/src/components/chat/ChatChangePlanActionDialogBody.tsx`.
Live:
1. Models > Providers & models: guided setup lists only the stub and "Claude Code CLI (local login) - not added yet"; four Refresh buttons (header + three section buttons).
2. Advanced provider configuration > Add provider profile: filled id, label, base URL http://127.0.0.1:9, model `ut11-model` (Review is disabled until the required fields are valid). Review provider profile > Apply reviewed provider profile > card "Awaiting confirmation" > Review and confirm > Apply exact change: provider added in 4 clicks, with a leftover card "needs your attention - MANUAL REQUIRED" (U-ST-022).
3. "Apply exact change" and "Cancel" have identical computed styles (background rgb(15,29,45), text rgb(244,251,255), border rgba(178,224,245,0.24)): confirms U-ST-005 on a Settings dialog. Settings dialogs that differ: the Add profile review ("Apply reviewed provider profile" is cyan rgb(92,233,255) with dark text), approval dialogs ("Approve once" cyan, "Deny" dark), "Unsaved changes" ("Save and continue" cyan).
4. Replace API credential on the new provider > Open secure input: the dialog explains "Stored in the OS keychain and never added to Chat or model context" and the field is enabled (not disabled in this sandbox). Typed one character with the keyboard: Settings replaced by "Settings couldn't be shown" with Try again / Reload app / Go to Chat (U-ST-019, `st-1-secure-input-crash.json`); this was the development build served by the sandbox, a production build was not run, and whether Try again recovers was not captured. The single settling check: build the UI, serve the output, open Models > Providers & models > Replace API credential > Open secure input, type one character. No key could be entered, so the keychain-failure message was not seen. Where a key box really is disabled for lack of a keychain, Web & Search explains it ("The OS keychain is unavailable. Set FIRECRAWL_API_KEY in the GoatCitadel environment instead."); the provider dialog has no such sentence, and the credential-storage select offers "Installation environment file (plaintext)" with the line "A keychain failure will not switch storage automatically."
5. Default model: Change default model > provider `ut11-local-unreachable`, model `ut11-model` > Review default model change > Apply reviewed routing: applied in about 3 s; the model select lists "verification-stub-chat - Not in current catalog" for the old model.
6. Guided model setup was loaded seven times with no action between: loads alternated between "Done / Ready" and "Not verified - last check is stale / Step 1 Current" (U-ST-023).
Failure tried: sent "ut11 hello" in a new Chat with the unreachable default provider: failed after about 2 s with "The connection dropped. Check the gateway or network connection" and no Settings link; System > Health stayed "1 check needs attention" (the unrelated runtime service) (U-ST-024). Default model restored; a normal message answered by the stub (`st-s4-chat-revert-ok.png`).
Evidence: `st-1-advanced-provider-config.png`, `st-1-add-provider-review.png`, `st-1-change-plan-dialog.png`, `st-1-profile-applied.png`, `st-1-secure-input-dialog.png`, `st-1-secure-typed.png`, `st-1-secure-input-crash.json`, `st-1-advanced-model-settings.png`, `st-1-models-open-plans.png`, `st-s4-chat-after.png`, `st-s4-health.png`.
Not covered: entering a key, "Check connection" with a key, picking a model from a live catalog, and sending the first Chat message through a keyed provider (no keychain, and the key box crashes). Operator steps: on a real Windows install open Models > Advanced provider configuration > Add provider profile, then Replace API credential > Open secure input, type the key, Submit securely; then Change default model; then Chat > New > send a message and confirm the model label under the answer.

## ST-2 Change a setting that needs approval: the approval appears in place, one click, applied without a second step
Result: FAIL
Findings: U-ST-020 (Tool approval rule, filesystem access); U-ST-021; U-ST-001 confirmed live (see notes)
Time: governed toggle in `default`: dialog 0.25 s after Save, Approve once to confirmed 0.56 s, 3 clicks. Firecrawl base URL: 3 clicks, dialog 1.8 s, confirmed 0.93 s after approve. Tool approval rule: 4 clicks after choosing the value, about 6 s. Verification workspace: no approve button at all.
Code path: `GovernedSettingParts.tsx` -> `use-governed-runtime-setting.ts` -> `PATCH /api/v1/settings` (creates a Change Plan and an approval) -> `SettingsApprovalDialog.tsx` -> `POST /api/v1/approvals/:id/resolve` -> Gateway reconciliation applies the plan. Older pattern: `ApprovalModeControl.tsx` and `FilesystemWriteAccessParts.tsx` -> `SettingsApprovalOwnerAction.tsx` (link to Inbox) + `ApprovedSettingsContinuation.tsx`.
Live:
1. `default` workspace, Models: untick "Keep one Claude Code process between tool steps", Save setting: dialog "Turn off ... Caution ... Only this setting changes. You can turn it on again the same way." with Approve once / Deny. Approve once: applied. This is the intended one-click pattern.
2. Same in the verification workspace (`ws_f13a...`): dialog opens but reads "The selected workspace changed. Open this item again in the current Inbox." with no Approve; that workspace's Inbox did not list the approval (0 cards), while the `default` Inbox did. U-ST-001 reproduced (`st-2-verif-gov-governed-1.png`, `st-2-inbox-verification.png`, `st-2-inbox-default.png`). Resolved by approving in the `default` Inbox, scoped to that card.
3. Safety > Tools approval rule (approve_risky to approve_all): see U-ST-020; Inbox path measured end to end, applied by the Gateway after Approve once with no Continue needed on that path.
4. Safety > Budgets (Balanced to Saver) applied at once with no approval (0.3 s): not governed.
Failure tried: pressed Save again after the first approval was left waiting (see ST-3).
Evidence: `st-2-timings.json`, `st-2-default-gov-governed-1.png`, `st-2-verif-gov-governed-1.png`, `st-2-default-inplace-dialog.png`, `st-2-default-inplace-waiting.png`, `st-2-default-after-review-click.png`, `st-2-inbox-default.png`, `st-2-inbox-verification.png`.
Not covered: none.

## ST-3 Save a provider with no changes; save two settings in a row
Result: PARTLY RUN
Findings: U-ST-021
Time: two consecutive governed saves on Models: each Save + Approve once confirmed in about 1.5 s, no conflict (PATCH 200 twice, expectedRevision 23 then 24).
Code path: `ProviderProfileFields.tsx` / `ProviderConnectionSettings.tsx` (Review disabled until a draft differs) -> `use-provider-connection-editor.ts`; consecutive saves `use-governed-runtime-setting.ts` -> `PATCH /api/v1/settings` with `expectedRevision`.
Live:
1. Stub provider > Edit provider profile with nothing changed: "Review provider profile" stays disabled; "Review endpoint change" is disabled as well. So a no-change provider save cannot be sent and the old 409 cannot occur that way. No sentence says why the button is disabled (not recorded; polish).
2. Two settings in a row on Models (reuse-process, then tool bridge, then both restored): all four saves applied, no stale-revision error.
3. The 409 family does appear after an approval is left open and the page is reloaded (U-ST-021).
Failure tried: left an approval waiting, reloaded, saved again: 409 "Another active Change Plan already owns this target." shown as "Settings changed elsewhere".
Evidence: `st-3-provider-unchanged-dialog.png`, `st-3-warm-disabled.png`, `st-3-closed-dialog.png`, `st-3-pending-plan-conflict.png`, `st-3-pending-plan-conflict.json`.
Not covered: an unchanged provider apply (not possible from the screen).

## ST-4 Local AI: point at a local runtime, see its models, start and stop it
Result: PARTLY RUN
Findings: U-ST-024 (the unreachable-server copy); U-ST-012 (carried: raw ids in the first sentences)
Time: Check server on an unreachable URL answered in 0.3 s.
Code path: `LocalAiSettings.tsx` / `LlamaSetupSettings.tsx` -> `POST /api/v1/llm/models/preview` -> Gateway llama.cpp service; readiness from `LocalAiEvidence.tsx`.
Live:
1. Models > Local AI with nothing installed: "Set up llama.cpp" (run mode: use a running server / let GoatCitadel start one), Server URL default http://127.0.0.1:8080/v1, Check server, Finish setup (disabled), Send test message (disabled); readiness panel lists 13 model fits (all "excellent" to "borderline") with "Detected ollama command on PATH"; "No Local AI job endpoint is registered. A local runtime was found."
2. Server URL http://127.0.0.1:9 > Check server: one line, "Live catalog unavailable; template aliases are not selectable." No statement that the server could not be reached. The Advanced page then shows "Latest probe: failed".
3. "Let GoatCitadel start one": "llama-server.exe detected; 0 GGUF files discovered." Nothing to start or stop (Finish setup disabled), so Start/Stop were not run. No download or install was pressed (Advanced lists voice-model Install buttons; not touched).
Evidence: `st-4-local-ai.png`, `st-4-check-server-unreachable.png`, `st-4-managed-mode.png`.
Not covered: models of a real server, start, stop. Operator steps: install llama.cpp, put a .gguf file in the Gateway's model folder, Models > Local AI > Let GoatCitadel start one > Check server > Finish setup, then Advanced > llama.cpp lifecycle to stop.

## ST-5 Access and auth: see the auth mode, create and revoke a token, pair a device up to the code
Result: PARTLY RUN
Findings: none new; answer to the Auto mode question in Notes on existing findings (U-CH-018)
Time: Access page content on screen within 1.5 s; editor opens in 1.5 s.
Code path: `GatewayAuthSettings.tsx` -> `GatewayAuthEditor.tsx` (`features/native-routes/settings`) -> `GET /api/v1/settings` (auth) and `/api/v1/auth/settings`; devices `DeviceAccessSettings.tsx` -> device grants API.
Live:
1. Access: "Anyone who can reach this app can change settings. Set up sign-in." "Current mode: none." Configure access opens an editor: Auth mode None/Token/Basic, Loopback bypass, Save access settings (disabled until edited), Discard, Close, Generate install token (disabled).
2. Selecting Token shows "Enter the new credential. Credentials clear when the editor closes."; Basic shows username and password fields. Neither draft warns that switching mode changes how every client, including this app, must sign in. Generate install token stays disabled in a Token draft until the mode is saved (tokens exist only in Token mode); I did not save. Closed the editor; mode read back as `none`.
3. Approved devices: "No device grants recorded." There is no pairing-code button on this page; pairing starts from the companion device. "Desktop and mobile continuity" lists readiness lines ("Install token lane - Open local - Auth is open; generate and protect an install token before exposing companion access").
4. Nothing on Access tells an auth-mode-`none` operator that Chat "Use Auto mode" and Managed files are unavailable or how to enable them (full page text checked).
Evidence: `st-5-access.png`, `st-5-configure-access.png`, `st-5-mode-token.png`, `st-5-mode-basic.png`, `st-5-continuity.png`.
Not covered: create and revoke a token, pairing code (both need Token mode or a device; changing the mode would lock the sandbox). Operator steps: Access > Configure access > Token > enter a credential > Save access settings; Generate install token; revoke from the same page; install the companion app and start pairing on the device, then approve under Approved devices.

## ST-6 Permissions, Trust and policy: find out why a tool was blocked and allow it
Result: PARTLY RUN
Findings: U-ST-025 (likely), U-ST-020 (allow flow)
Time: allow flow see ST-2; revert to Denied applied at once.
Code path: `TrustPolicySettings.tsx` -> `GET /api/v1/...` trust records (347 rows); `FilesystemToolAccessPanel.tsx` -> `PATCH /api/v1/settings` (`globalToolAccess`); Chat side `ChatToolActivity.tsx`, `ChatTurnFailureCard.tsx`.
Live:
1. No blocked tool event exists in this sandbox (the stub model cannot call a denied tool; earlier Activity shows only a denied approval), so "find out why" was a code read: U-ST-025.
2. Trust & policy filtered to Blocked: 4 rows, all skills (provenance missing or revoked upstream), each with a plain reason. Rows show raw tool ids as headings (permitted in a technical table).
3. Allow a tool: Safety > Tools > Global filesystem tool access, fs.copy Denied to Available, Apply fs.copy: approval needed, no dialog opened on its own (toast "Open Inbox item", buttons "Review approval" and "Continue approved change"); approved from the Inbox; fs.copy then Denied again, applied at once with no approval.
Evidence: `st-6-trust-blocked.png`, `st-6-trust-policy.png`, `st-6-allow.png`, `st-6-after-reload-pending.png`.
Not covered: a real blocked turn. Operator steps: in Chat ask for a file copy while fs.copy is Denied; read the tool row; try to reach the blocking rule from it.

## ST-7 Workspaces and personalities: create, switch, delete
Result: PASS
Findings: U-ST-028 (polish only)
Time: create workspace 0.23 s to the list; archive dialog closes 0.2 s after confirm; personality create 0.2 s, switch and revert each one review dialog (about 3 s including page).
Code path: `WorkspaceSettings.tsx` -> `POST /api/v1/workspaces`, `PATCH /api/v1/workspaces/:id` (archive) ; `PersonalitySettings.tsx` / `PersonalityEditor.tsx` -> `POST/PATCH/DELETE /api/v1/personalities`.
Live:
1. Citadel > Workspaces > New workspace `ut11-workspace` (name + description): listed at once. Make active: header became "Personal / ut11-workspace". Make active on Default switched back. Archive > "Archive workspace?" review > Confirm archive workspace: archived. There is no Delete; the archived workspace stays listed with Restore.
2. General > Personalities > Add custom personality `ut11-personality` (ID, Label, Category, Tone, Style, Description, System overlay, Safety notes): created. Saved personality select > Review global default > Apply reviewed default: global Work default switched; reverted the same way to Default. Edit selected personality > Remove custom > "This cannot be undone" confirm > removed (Gateway confirms none left).
Failure tried: Create workspace with an empty name: button disabled.
Evidence: `st-7-new-workspace-form.png`, `st-7-created.png`, `st-7-switched.png`, `st-7-archive-dialog.png`, `st-7-personality-form.png`, `st-7-personality-created.png`, `st-7-switch-review.png`, `st-7-personality-delete-confirm.png`.
Not covered: workspace delete (not offered).

## ST-8 Web search and Firecrawl: set a base URL and allowlist, run a search from Chat
Result: PARTLY RUN
Findings: U-ST-026 (friction)
Time: Save to dialog 1.8 s; Approve once to "Done - Change saved and confirmed" 0.93 s; Test connection answered in under 1 s.
Code path: `FirecrawlSettings.tsx` (+ `isBaseUrlAllowlisted`) -> `PATCH /api/v1/settings` (`web.firecrawl`) -> approval; `POST /api/v1/settings/web/firecrawl/check`; keys `WebSearchKeys.tsx`.
Live:
1. Web & Search: Use Firecrawl, hosted vs self-hosted, base URL, default backend, fallback, timeout, Save Firecrawl, Test connection, search engine order, three API-key boxes (all disabled with "The OS keychain is unavailable. Set <ENV NAME> in the GoatCitadel environment instead.").
2. Base URL set to http://127.0.0.1:9 (a contrived loopback port; a LAN host is the realistic case): saved and approved; Test connection "Not allowlisted", with no add button and no link (U-ST-026). The allowlist itself lives on Settings > Get started > Change installation defaults ("Network allowlist" field, `FirstRunDefaults.tsx:98-102`), which this page does not point to. Restored to http://127.0.0.1:3002 with the same flow; the Gateway read-back matches the original values (enabled, 3002, firecrawl, fallback, 20 s).
3. The allowlist was not widened (the field on the first-run defaults page was read, not saved).
Evidence: `st-8-web-search.png`, `st-8-set-after-save.png`, `st-8-set-after-approve.png`, `st-8-set-test.png`.
Not covered: running a search from Chat (needs a real model and network). Operator steps: set Firecrawl or a search key, open Chat, turn Web on in the plus menu, ask a question that needs the web, read the sources line.

## ST-9 Every Settings page: open it, change one harmless value, save, reload, value kept
Result: PARTLY RUN
Findings: U-ST-027; U-ST-023 (Models); carried findings on these pages
Time: pages render within 1.5 s each; no console error except aborted event-stream requests on navigation.
Code path: `SettingsArea.tsx` and the section components listed in `settings-route-homes.ts`.
Live (page, value changed, result after reload, restored):
- General > Appearance: "Show technical details" ticked (applies at once, no Save): kept after reload; unticked: restored.
- Models: "Claude Code CLI: reuse one process" and "let it use GoatCitadel tools" off and on again (governed): kept, restored. "Show model reasoning in Chat": its own copy says it "is kept in this browser only, so it is gone after a page reload", yet the save is a governed `PATCH features.chatThinkingStreamV1Enabled` that raised an approval; I denied it, so the value is unchanged and "kept after reload" was not tested.
- Safety: Budgets Balanced to Saver (applied at once, kept per Gateway), back to Balanced. Tools approval rule approve_risky to approve_all and back (via Inbox). fs.copy Denied/Available/Denied. Permissions and Hooks (no hooks) and Trust & policy are read-only pages here.
- Citadel > Workspaces: workspace create, archive (kept), metadata edit of Demo (kept after reload, then restored; see the mistake above).
- Access: no value changed (mode change would lock the sandbox).
- Advanced: read-only apart from voice-model Install buttons (downloads; not pressed) and runtime Check health (not pressed).
- Get started (first run): all three steps Done; no change made.
- Web & Search: Firecrawl base URL changed and restored.
- Notification routing (General): New destination form read only; a webhook destination needs "Webhook URL secret reference", described only as "Use existing keychain references" (U-ST-008 confirmed).
Failure tried: saves left waiting for approval (see ST-3).
Evidence: `st-9-crawl-*.png` (each page), `st-9-general.png`, `st-9-safety-budgets.png`, `st-9-safety-tools.png` (redacted), `st-9-advanced.png`, `st-9-first-run.png`, `st-9-webhook-destination-form.png`, `st-9-settings-before.json`, `st-9-settings-after.json`, `st-9-settings-diff.json`.
Not covered: values on Access and Advanced (no harmless value), hooks (none registered; Register hook not used), Citadel Mason/Wards/Council/Vault/Blueprint tabs were only read.

## Feature settings with no screen
Source: one `GET /api/v1/settings` plus `apps/gateway/src/config.ts:1472-1585`, `config/goatcitadel.example.json` and `git grep` in `apps/mission-control-next/src` and `packages/mission-control-shared/src`; full table in `evidence/st/st-9-feature-flags.json` (69 flags: default in code, example-config value, sandbox value, Settings control, UI references, what it gates).
- 69 feature flags: 36 `...Enabled` flags default off in code, 10 `...Disabled` kill switches (off, meaning the feature is on), 23 `...Enabled` flags default on.
- Only 5 flags have any Settings control: `claudeCliToolBridgeEnabled`, `claudeCliWarmContinuationEnabled`, `browserErrandsEnabled`, `settingsApprovalSkipEnabled`, `chatThinkingStreamV1Enabled` (the last is described as a browser-only preference but saved as a governed Gateway setting).
- 33 default-off flags have no screen to turn them on, among them two of the three already recorded: `chatSkillInstructionsV1Enabled` (`use <skill>`) and `chatStaticMcpV1Enabled` (only through a template connector install). The third recorded one, `memoryLifecycleAdminV1Enabled`, defaults to on in code but off in the shipped example config, so a fresh install has it off; the sandbox seed turned it on.
- New finding U-ST-027 covers the default-off flags that a screen tells the operator about without a switch: `cronReviewQueueV1Enabled`, `engineeringLearningsV1Enabled`, `connectorDiagnosticsV1Enabled`, with `promptRetuneCampaignV1Enabled` hidden silently. Other default-off flags gate nothing an operator is told about today (mostly API-side behaviour): `replayOverridesV1Enabled`, `memoryMaintenanceV1Enabled` (Library memory diagnostics refuses with "Current runtime settings do not permit this operation."), `codeModeV1Enabled` and `codeModeHostSandboxEnabled` (Chat has its own enable flow, `enable-code-mode.ts`), `improvementLedgerV1Enabled`, `improvementActivationV1Enabled`, `structuredReviewV2Enabled`, `chatContextBudgetVisibilityV1Enabled`, `chatProviderFallbackV1Enabled` and `chatDelegationControlsV1Enabled` (Chat's feature availability shows both false), `memoryConsolidationV1Enabled` (the "Memory Consolidation Weekly" schedule shows Paused), `utilityModelRoutingV1Enabled` (read by a Claude CLI notice), and the fan-out, mesh, heartbeat and channel-voice-reply flags.
- The sandbox differs from code defaults for `replayRegressionV1Enabled`, `codeModeV1Enabled` and `codeModeHostSandboxEnabled` (on), and `memoryLifecycleAdminV1Enabled` (on).

## Step 4: no provider, invalid key, missing default model
Result: PARTLY RUN
(a) Reachable case run: the default model set to a model the provider cannot serve and a provider that answers nothing (`ut11-local-unreachable` / `ut11-model`, reversible through Change default model). Reverted and confirmed with a normal message.
- Chat: names nothing useful (U-ST-024): "The connection dropped. Check the gateway or network connection". The empty-conversation screen does carry a "Configure models" button (`ChatConversationStarterChoices.tsx:27`); the failure card has no Settings link except for sign-in and billing failures (`ChatTurnFailureCard.tsx:31`, `:76`).
- Work > Schedules: loaded normally, no mention of the model (schedules were not run).
- Library > Knowledge: loaded normally, no mention.
- System > Health: no model or provider check at all; the one attention item was the unrelated runtime service (U-ST-024).
(b) Code read, not reproduced live:
- Empty provider list: Settings shows "No providers are configured. Use guided setup to connect one." (`ProviderCatalogSettings.tsx:271`) and "No saved providers yet. Add a provider profile to start." (`ProviderList.tsx:31`); Chat's empty state offers "Configure models"; Work > Schedules, Library > Knowledge and System > Health have no code that reads the provider list (`git grep` for "no provider", "connect a provider" in those areas finds only Settings and first-run files), so they give no pointer. Likely: they show their normal content and the first model use fails as in (a).
- Invalid key (401): Chat maps `auth_required` to "The model provider needs you to sign in again" with an "Open model providers" link to `/settings/models#providers` (`ChatTurnFailureCard.tsx:14`, `:31`, `:76`): named and linked. The other three screens: no reading of a provider error.
Fresh-sandbox task (first run) should look at: Chat empty state and the first send with no provider (what the composer says, whether Send is disabled, where "Configure models" goes); Work > Schedules > New schedule and the Cost Report / built-in schedules (do they say a model is needed); Library > Knowledge > ingest and query (does retrieval name the missing model); System > Health (is a missing default model a check) and the Settings > Models guided setup "Step 1 Connect a provider" copy and its Check connection button. Also the secure input dialog: type a key (U-ST-019).

## Notes on existing findings
- U-ST-001: reproduced live (stall confirmed). In the verification workspace the in-place Settings approval says "The selected workspace changed. Open this item again in the current Inbox." with no Approve, and that workspace's Inbox lists no such approval (`st-2-verif-gov-governed-1.png`, `st-2-inbox-verification.png`). Seven call sites hard-code `workspaceId="default"` (`GovernedSettingParts.tsx:117`, `ApprovalModeControl.tsx:177`, `FilesystemWriteAccessParts.tsx:71`, `ProviderConnectionSettings.tsx:344`, `ProviderRoutingSettings.tsx:247`, `ManagedRuntimeSettings.tsx:195`, `GatewayAuthSettings.tsx:101`), so every governed Settings save is affected, not only one. Suggested severity stall (unchanged).
- U-ST-005: confirmed on a Settings change-plan dialog: "Apply exact change" and "Cancel" have identical computed colours (background rgb(15,29,45), text rgb(244,251,255)). Other Settings dialogs differ (see ST-1 step 3). Suggested severity friction (unchanged).
- U-ST-008: confirmed live: Keychain HTTPS webhook form asks for "Webhook URL secret reference" and says only "Use existing keychain references"; nothing shows the format or creates one (`st-9-webhook-destination-form.png`). Suggested severity stall (unchanged).
- U-ST-014: confirmed live: /settings/models shows four buttons named Refresh (header plus "Model reasoning in Chat", "Claude Code CLI: let it use GoatCitadel tools" and "reuse one process"); Safety > Tools has several more. DESIGN.md:102 specifies one in the page header. Suggested severity polish (unchanged).
- U-ST-002: confirmed live: below the guided setup's provider picker, "Advanced provider configuration" opens a second provider list (Provider profiles, Inspect provider, Default provider) and a third chooser in Default model. Suggested severity friction (unchanged).
- U-ST-010: confirmed live: two step lists (Guided model setup steps vs the Get started page's) with different names; the Get started page says "Choose a model / Choose your safety settings / Send a test message". Not re-measured.
- U-ST-011: switching a toggle needs one dialog but the dialog is short and one-click in the `default` workspace (see ST-2); the "modal with a paragraph" wording applies to integrations (not walked). Suggested severity polish.
- U-ST-016, U-ST-017, U-ST-018, U-ST-004, U-ST-007, U-ST-015: not re-walked.
- U-CH-018: answer for the Access question: Settings > Access in auth mode `none` does not say that Chat "Use Auto mode" and Managed files are unavailable, nor how to enable them. It says only "Anyone who can reach this app can change settings. Set up sign-in." and "Current mode: none." (`st-5-access.png`, `st-5-configure-access.png`). Suggested severity: keep, and add that the Access page is the natural place for the pointer.
- U-FR-002 (Diagnostics "Access" link) and the "Change this workspace's skills" links: not re-walked.

## Design decisions to confirm
- Budget preference (Safety > Budgets) applies at once without approval while the tool approval rule needs one: DESIGN says tightening applies freely and loosening asks; the Budgets page already says it is "a preference only". No change needed unless the operator wants budget changes governed.

## Engineering notes
- `ChatChangePlanActionDialogBody.tsx:107-113` reads `event.currentTarget.value` inside the `setSecureValues` updater; capture the value before calling `setSecureValues`. The same file has other onChange handlers (lines 193, 211, 234) that read it directly and are fine. The unit test (`ChatChangePlanActionDialog.test.tsx:269`) passes a hand-built event whose `currentTarget` is never nulled, so it cannot catch this. Users of the dialog (git grep): `GuidedModelPlanDialog.tsx`, `ProviderConnectionSettings.tsx`, `ProviderManagementSettings.tsx`, `ProviderRoutingSettings.tsx`, `LibraryCandidatePlan.tsx`.
- Safety > Tools > Recorded grants shows "Showing 30 of 171 matching records from the latest 400 grants", mostly repeats of a few tools; most are likely seeded by test tasks (also recorded as a polish finding).
- Governed settings cards still exist in two shapes (`GovernedSettingParts.tsx` in-place dialog; `ApprovalModeControl.tsx` and `FilesystemWriteAccessParts.tsx` link + Continue). `ApprovedSettingsContinuation` is rendered whenever the plan is not confirmed, although the comment at `GovernedSettingParts.tsx:123` says Approving applies the change and Continue is only for cards without an in-place approval.
- Safety page: the Permissions, Tools, Trust & policy, Hooks and Budgets tabs are anchors on one long page (the Tools tab text includes the permission-profile controls and 171 grant rows); the whole page also prints runtime folder paths.
- Per-turn `git grep` shows 21 on-by-default `...Enabled` flags with no UI reference at all (type definitions only).
- The Gateway needs an `Idempotency-Key` header on mutating API calls (used when restoring the two workspaces).

## Fix round 1 (review)
- U-ST-019: confidence changed from confirmed to likely; title and text now say confirmed on the development build only, with the production check named, the code reading, why the tests missed it, the reach, and why it is not a keychain artifact.
- U-ST-026: false sentence removed (the allowlist field exists on Settings > Get started); defect reframed as the page's own check disagreeing with the Gateway's; severity stall to friction.
- U-ST-024: severity stall to friction; wording limited to the generic message, the missing link and the missing Health check (Health's attention item is the known runtime-service warning).
- U-ST-023: confidence likely (the stale text may be a loading transient). U-ST-020: cross-reference U-CP-012. U-ST-027: cross-references U-LB-008, U-CP-015, U-CH-044; promptRetuneCampaignV1Enabled listed for completeness only. New polish finding for the grants list.
