# Settings channel guides: fix ledger

Built 2026-10-27 from the four audit reports (group A to D) and BRIEF.md, on branch `fix/telegram-setup-one-path`
(HEAD 79aecac45). Every file:line below was re-checked on this branch; where an auditor's line was wrong it is
corrected here. Nothing was run: "static" means read and traced, not executed.

Short names used below:

- `defs/` = `apps/gateway/src/services/channel-setup-definitions/`
- `GJ` = `defs/guided-journey.ts`
- `CE` = `packages/policy-engine/src/tool-executor/comms-executor.ts`
- `IDS` = `apps/gateway/src/services/integration-diagnostics-service.ts`
- `CSS` = `apps/gateway/src/services/channel-setup-service.ts`
- `ELIG` = `apps/gateway/src/services/channel-setup-eligibility.ts`
- `PROBES` = `apps/gateway/src/services/channel-bot-live-probes.ts`
- Classic wizard = `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelSetupWizard.tsx`
- Cockpit wizard = `apps/mission-control-next/src/cockpit/areas/settings/ChannelDraftEditor.tsx` (Cockpit is the default
  layout, so every UI fix must land in both, or in the shared `use-channel-wizard.ts` / `channel-wizard-model.ts`)

Facts the whole ledger leans on (all re-checked):

- `withGuidedJourney` replaces `introSummary` and `prerequisites` with `POSTURE[key]` (GJ:343-344). The definition
  files' own `introSummary`/`prerequisites` are dead text. Copy fixes for those go into `POSTURE` (GJ:10-181).
- It splits every field step into `<id>-identity` "Connect the account" and `<id>-destinations` "Choose destinations
  and access" by `DESTINATION_KEYS` (GJ:182-199, 247-269), marks `ADVANCED_KEYS` and "Legacy…" labels advanced
  (GJ:200-213, 243), sets every secret field `required: false` (GJ:244), inserts "Who may message this bot?" before the
  test step for `GUIDED_INBOUND_CHANNELS` (GJ:277-328), and appends "first-message" (GJ:329-335).
- Continue is blocked until every checklist box is ticked (`use-channel-wizard.ts:178-182`) and every required field is
  filled (`:173-176`, `channel-wizard-model.ts:87-125`).
- Any `warn` or `fail` the test reports blocks Finalize unless `ELIG` exempts it (`ELIG:37-93`). Exemptions today:
  empty sender list, legacy-open, Discord guild-off target, missing target for matrix/qqbot/wecom (`ELIG:9-13`),
  advisory `wecom_callback`/`qqbot_bot` (`ELIG:16`), and acknowledged sandbox cleanup.
- Settings "Finalize" does not finalize: it creates a `channel_connection` Change Plan that is reviewed and applied in
  Chat (`apps/mission-control-next/src/features/native-routes/settings/sections/use-channel-draft-actions.ts:206-250`).
  The connection id is minted only when that plan applies (`CSS:464`, `connectionId: readyDraft.connectionId ?? randomUUID()`).

---

## Part A — shared

A1 to A4 are the decided Part A PR. A5 onward are other problems that reach several guides; each says where it fits
(Part A PR for UI/model changes, Part B PR for `GJ`/definition copy, Part C PR for runtime).

### A1. Show `wizard.prerequisites` in the Settings guide (decided)

- Problem: every guide's prerequisites list is computed and sent to the UI, and no Settings screen shows it.
- Reaches: all 16 guides (Telegram too).
- Evidence: set at GJ:344; Classic header renders only `introSummary`, difficulty, minutes (Classic wizard:79-98, text at
  :83); Cockpit header the same (Cockpit wizard:36-43, text at :38). `git grep prerequisites` over
  `apps/mission-control-next/src` finds no reader of `definition.wizard.prerequisites` (only tests and Google Meet).
  Hidden today, among others: public HTTPS for Slack/WhatsApp/LINE/QQ/WeCom/Nextcloud inbound, WeCom trusted IP,
  `signal-cli daemon --http`, BlueBubbles Mac, Matrix "unencrypted room", the network-allowlist hosts.
- Fix: in both headers, under the summary, render `definition.wizard.prerequisites` as a short list titled
  "What you need" (not "Before you start": Discord and Slack already have a step with that title). Put the rendering in
  one small shared component used by both wizards.
- Risk/notes: once visible, the POSTURE prerequisites must be rewritten, because several are jargon or promise things
  the code does not do (the "sender_not_allowlisted diagnostic shows the id" claim, see A6). Part B gives new text per
  guide. `defs/picker-hints.ts:15` says picker notes must stay within the prerequisites; keep them consistent.
  Existing tests: `ChannelSetupWizard.test.tsx:172` and `ChannelGuidedSetup.test.tsx:89` build fixtures with
  `prerequisites`; add an assertion there.

### A2. Show the inbound webhook address (decided)

- Problem: guides say "register the saved connection webhook URL" but nothing in the UI shows that address, and the
  connection id inside it does not exist until the Change Plan from Finalize is applied.
- Reaches: the 8 channels with inbound webhook routes: slack, google-chat (Chat app mode), whatsapp, line,
  nextcloud-talk, qqbot, wecom, telegram (web-address mode).
- Evidence: routes `apps/gateway/src/routes/integration-webhooks-{slack:31,google-chat:32,whatsapp:34,line:21,nextcloud-talk:23,qqbot:19,wecom:67,telegram:17}-routes.ts`,
  all `/api/v1/integrations/connections/:connectionId/<channel>/webhook`. `git grep "/webhook"` over
  `apps/mission-control-next/src` finds nothing that prints one. The id is shown only as a bare "Connection ID"
  (Classic `settings/sections/ChannelsSection.tsx:377-382` inside the collapsed "Connection operations" card;
  Cockpit `cockpit/areas/settings/ChannelsSettings.tsx:356`). The auditors' `ChannelsSection.tsx:325-326` is stale.
  GoatCitadel has no public-origin setting (`git grep publicBaseUrl` finds none), so the host part cannot be filled in.
- Fix: add a per-channel webhook path to the definition (for example `wizard.inboundWebhookPath: "nextcloud-talk"`,
  set for the 8 keys above, or a map next to `CHANNEL_REQUIRED_HOSTS` in `defs/picker-hints.ts`). Show it:
  1. On the saved connection (both "Connection operations" panels), above Connection ID:
     "Webhook address: `https://<your public address>/api/v1/integrations/connections/<id>/<channel>/webhook`" with a
     Copy button, and the line "GoatCitadel doesn't provide a public address. Put your own HTTPS address (a reverse
     proxy or tunnel) in front of this Gateway, then give the vendor this address."
  2. In the wizard's "first-message" step for those 8 channels, the same block. On an edit draft the id is known
     (`draft.connectionId`). On a create draft it is not, unless C3 lands; until then show "You get this address after
     you finish: Settings › Channels › this connection › Connection operations."
- Risk/notes: Google Chat's endpoint-URL audience and Nextcloud's bot install both need the address before Finalize;
  only C3 fixes that. Telegram's Chat page is unaffected (polling).

### A3. Offer missing network-allowlist hosts the way the Telegram Chat page does (decided)

- Problem: real sends and receive streams refuse hosts not on the network allowlist, the setup test either bypasses
  the allowlist or fails with an unhelpful message, and Settings never offers to add the host.
- Reaches: all 15 guides.
- Evidence:
  - Real sends: `CE:4730-4744` `fetchAllowlisted` calls `assertHostAllowed(url, config.sandbox.networkAllowlist)`.
  - Setup test fetcher adds `"*"`: `apps/gateway/src/services/gateway-service.ts:12000-12025`
    (`fetchWithDiagnosticsTimeout`). So Slack/WhatsApp/LINE/Zalo tests pass and the first real send fails (C7).
  - URL-field channels get a blocking `warn` "host is not in the current outbound allowlist" (`IDS:125-142`, used for
    ntfy :254, Google Chat webhook :284, Teams :293, Signal :312, Mattermost :321, Matrix :326, iMessage :365,
    Nextcloud :375), with the useless next step "Check the remote URL or platform availability" (`CSS:891-893, 907-908`).
    QQ/WeCom/Matrix/Nextcloud probes also fail "outside the network allowlist" (`qqbot-live-probes.ts:77`,
    `wecom-live-probes.ts:76`, `matrix-live-probes.ts:49`, `nextcloud-talk-live-probes.ts:14`).
  - Shipped example allowlist (`config/goatcitadel.example.json:266-294`) has discord.com, chat.googleapis.com,
    hooks.slack.com, `*.logic.azure.com`, `*.environment.api.powerplatform.com`, 127.0.0.1, localhost, and lacks
    slack.com (used by `CE:807`), graph.facebook.com (`CE:3094-3120`), api.line.me (`CE:1360`), openapi.zalo.me
    (`CE:2975`), bots.qq.com / api.bot.qq.com / sandbox.api.sgroup.qq.com (`qqbot-live-probes.ts:14-19`),
    qyapi.weixin.qq.com, ntfy.sh, oauth2.googleapis.com.
  - `CHANNEL_REQUIRED_HOSTS` knows only Telegram (`defs/picker-hints.ts:39-41`); only the Chat page reads
    `wizard.requiredHosts` (`cockpit/areas/chat/channel-setup/use-channel-picker-groups.ts:30-36`).
  - Chat-page pattern to copy: `use-missing-hosts.ts:7-40` (`missingHosts`, `useMissingHosts`),
    `approve-plan-in-place.ts:141-170` (`ensureHostsAllowed`: `runtime_configuration` / `network_allowlist` Change Plan,
    refuses any host the page did not list), wording `TurnOnStep.tsx:12`
    ("<host> is added to the hosts GoatCitadel may reach").
- Fix:
  1. Gateway: fill `CHANNEL_REQUIRED_HOSTS` for fixed hosts: `discord: ["discord.com"]`, `slack: ["slack.com"]`
     (plus `hooks.slack.com` only when a webhook URL is used), `whatsapp: ["graph.facebook.com"]`,
     `line: ["api.line.me"]`, `zalo: ["openapi.zalo.me"]`, `qqbot: ["bots.qq.com", "api.bot.qq.com"]` (plus
     `sandbox.api.sgroup.qq.com` when Test mode is on), `wecom: ["qyapi.weixin.qq.com"]`,
     `"google-chat": ["chat.googleapis.com"]` (plus `oauth2.googleapis.com` for Chat app mode).
  2. For channels whose host is a field value, add `wizard.hostFieldKeys` naming the field: ntfy `baseUrl`, matrix
     `homeserverUrl`, mattermost `serverUrl`, nextcloud-talk `baseUrl`, signal `baseUrl`, imessage `bridgeUrl`, teams
     `webhookUrl`. The UI takes the hostname from the current value.
  3. UI (both wizards), on the test step above Validate/Run live test: when hosts are missing, list them:
     "GoatCitadel can't reach these yet: slack.com." and a button "Allow these hosts" that calls the same
     `ensureHostsAllowed(hosts, workspaceId, shownHosts)`. While the allowlist read is pending, say nothing and keep the
     button off (same rule as the Chat page). On failure show `HOSTS_UNKNOWN` text.
  4. Gateway test side: C7 (make the test fail when a fixed provider host is not allowed, like Telegram at `IDS:236-246`).
- Risk/notes: `use-missing-hosts.ts` and `ensureHostsAllowed` live under `cockpit/areas/chat/`; the Classic wizard lives
  under `features/native-routes/`, so move them to a shared spot. `ensureHostsAllowed` approves its plan in place; that
  is the Chat page's rule ("Turn on never takes the skip"). Confirm Settings may approve an allowlist plan in place, or
  route it to Chat review like Finalize. Secondary hosts (files.slack.com for voice, lookaside.fbsbx.com for WhatsApp
  media, www.googleapis.com for Google Chat token certs) are unverified as allowlist-gated; list them only after a check.

### A4. Editing a saved channel skips the creation and intro steps (decided)

- Problem: "Edit setup" opens the same step list from step 1, replaying "create the bot/app" steps whose checklists
  block Continue, and copy that says the connection id "is created when you finalize".
- Reaches: all 16 (Telegram's Settings guide is edit-only already; do not hide its intro, see risk).
- Evidence: Edit creates `lifecycleMode: "edit"` drafts (`settings/sections/use-channel-setup-entry.ts:66-79`, :76);
  nothing under `settings/channel-setup/` reads `lifecycleMode` (`git grep lifecycleMode` hits only Chat files and
  list labels); the wizard starts at `visibleSteps[0]` (`use-channel-wizard.ts:31-36`). Examples: `defs/discord.ts:72-120`
  (create-bot, install-bot with 9 required boxes), `defs/qqbot.ts:111-123`, `defs/wecom.ts:154-166`.
- Fix:
  1. Contract: add `createOnly?: boolean` to `ChannelSetupStepDefinition`
     (`packages/contracts/src/channel-wizard.ts:128-144`).
  2. `use-channel-wizard.ts:31-34`: drop `createOnly` steps when `draft.lifecycleMode !== "create"` (covers edit,
     repair, rotate_secret, retest).
  3. Mark steps explicitly (not by kind): Discord `overview`, `prerequisites`, `create-bot`, `install-bot`; Slack
     `overview`, `prerequisites`, the new create-app step; Teams `overview`, `create-webhook`; Google Chat `overview`,
     `create-webhook`; ntfy `overview`, `prepare-topic`; and every new vendor-setup step Part B adds (Signal, LINE,
     Matrix, Mattermost, Nextcloud, WeCom). Intros of other guides: mark `createOnly` too.
  4. Banner at the top of an edit draft: "You're changing <label>. The steps for creating it are hidden."
- Risk/notes: Telegram's intro "What you can change here" (`defs/telegram.ts:75-77`) must stay visible, which is why
  marking is explicit. Every edit still needs a new live test that posts a visible message (N6). Definitions declare
  `repair`/`rotate_secret`/`retest` but Settings only ever creates `edit` drafts; not in scope.

### A5. Env-var fields: hidden name rules, no restart note, and the wrong field is "preferred"

- Problem: ~15 guides call the env-var NAME field "Preferred path" and the pasted secret "manual fallback", never say
  the name rules, and never say the Gateway must be restarted to see a new variable.
- Reaches: Discord, WhatsApp, LINE, iMessage, Matrix, Mattermost, Nextcloud, ntfy, QQ, WeCom, Zalo, Google Chat.
- Evidence: name guard `apps/gateway/src/services/gateway/integration-secret-envvar-guard.ts:1, 54-100` (uppercase,
  must start `<KEY>_`, `INTEGRATION_<KEY>_` or `CHANNEL_<KEY>_`; aliases `QQBOT_`, `PHOTON_`); inbound webhook secrets
  also need a listed suffix such as `_TOKEN`, `_SECRET`, `_APP_SECRET`, `_VERIFY_TOKEN`, `_AES_KEY`
  (`apps/gateway/src/services/channel-secret-resolution.ts:3-7`). A wrong name is silently treated as unset by the
  probe (`gateway-service.ts:12058-12075`). Pasted secrets go to the OS keychain (`CSS:818-846`).
- Fix (Part B PR, after C1 ships):
  1. Make the pasted secret field primary: first in the list, label without "(manual fallback)", explanation
     "Paste it here. GoatCitadel keeps it in this computer's secure storage."
  2. Make every `*Env` field advanced (add a rule in GJ: a field whose key is `<secretKey>Env` for a key in
     `adapter.secretFieldKeys` gets `advanced: true`), label "<Name> from an environment variable (advanced)".
  3. One shared explanation from `common.ts`, filled per channel: "The variable's name must start with WECOM_ (for
     example WECOM_SECRET). Set it where GoatCitadel starts, then restart GoatCitadel." For inbound webhook secrets add
     "and end in _TOKEN or _SECRET" (per `channel-secret-resolution.ts:4`).
- Risk/notes: do not ship step 1 before C1, or pasted secrets will pass the test and break every real send.
  C5 and C6 add the matching validation.

### A6. The "dropped message shows the sender id" promise is not backed by any screen

- Problem: guides say a dropped message's `sender_not_allowlisted` diagnostic "shows the id"; System › Diagnostics
  shows the message text and id/event/category/time only, and the sender id is only in `context`.
- Reaches: Google Chat, Signal, Mattermost, Matrix, QQ, WeCom (claims at GJ:58, 89, 100, 113, 125, 137); the same
  default-deny list with no discovery exists for ntfy, Slack, LINE, WhatsApp, Nextcloud.
- Evidence: `apps/gateway/src/services/channel-inbound-dispatch.ts:363-385` and
  `apps/gateway/src/routes/integration-webhooks.ts:~150-170` put `actorId` only in `context`;
  `apps/mission-control-next/src/cockpit/areas/system/SystemDiagnostics.tsx:317-325` renders `item.message` and
  `{id, event, category, timestamp}`. Note: with an empty list the event is `channel.inbound_allowlist_empty`, not
  `sender_not_allowlisted` (`channel-inbound-dispatch.ts:369-373`); that is the first-setup case.
- Fix (runtime string change; Part A or Part C PR): put the sender id in the message for both events:
  "Dropped a <channel> message from <actorId>: that sender isn't allowed yet. To allow them, add <actorId> under Who may
  message this bot." Then guide copy can say "Message the bot once. Open System › Diagnostics and find 'Dropped a … message
  from …'. Copy the id, add it with Edit setup, and message again."
- Risk/notes: product/privacy call (N5). If declined, remove the promise from every POSTURE entry.

### A7. "Allowed sender identities" has no per-channel help

- Problem: the field's explanation is generic for most channels; formats appear only in hidden prerequisites or after
  Finalize, and matching is exact, so a wrong format silently drops every message.
- Reaches: Slack, WhatsApp, Signal, Matrix, Mattermost, Nextcloud, LINE, ntfy (Google Chat, QQ, WeCom have partial text).
- Evidence: GJ:314-323; exact case-insensitive compare in `packages/contracts/src/channel-access.ts`
  (`evaluateChannelInboundAccess`).
- Fix (Part B, GJ:314-323), per key:
  - whatsapp: "Your WhatsApp number with country code, digits only, no plus (for example 15551234567)."
  - signal: "The sender's Signal UUID, not their phone number. Senders without a UUID use their number."
  - matrix: "Your Matrix ID with the @ and the server, for example @alice:example.com."
  - mattermost: "Mattermost user IDs (26 letters and digits), not usernames. An admin sees them in System Console ›
    User Management › Users."
  - nextcloud-talk: "users/ followed by your Nextcloud user name, for example users/alice."
  - line: "Your LINE user ID (starts with U). For a one-to-one chat it is the same ID as Default target."
  - slack: "Your Slack member ID (starts with U)." (where to copy it is unverified; see Unverified)
  - ntfy: "Added for you as ntfy-topic:<subscribe topic>. If you change the topic later, change this too."
  - google-chat, qqbot, wecom: keep, and add the A6 sentence once A6 lands.

### A8. "Who may message this bot?" shows when it can't apply

- Problem: the sender step appears even when receiving is off; for forced-allowlist channels it shows a required,
  one-option select plus an empty "Choose a value" option; for non-forced channels it offers "Open legacy access" to
  brand-new drafts.
- Reaches: step visibility: ntfy, Matrix, Mattermost (`inboundStreamEnabled`), Signal (`receiveEvents`), Google Chat
  webhook mode. Select: ntfy, Mattermost, Matrix, Signal, Google Chat, QQ, WeCom. Open legacy: Slack, WhatsApp, LINE,
  Nextcloud.
- Evidence: step inserted with no `visibleWhenFieldEquals` (GJ:282-327; `isStepVisible` supports it,
  `channel-wizard-model.ts:57-60`); select GJ:294-308; empty option `ChannelWizardFieldCollection.tsx:86`;
  `FORCED_ALLOWLIST_INBOUND_CHANNELS` in `apps/gateway/src/services/channel-setup-inbound-access.ts:28-36`.
- Fix (Part B, GJ): set `visibleWhenFieldEquals: { fieldKey: "inboundStreamEnabled", value: true }` on the inserted step
  for ntfy/matrix/mattermost, `{ fieldKey: "receiveEvents", value: true }` for signal, and the new Google Chat mode
  field (Part B Google Chat 4). For forced-allowlist keys, omit the `inboundAccessMode` field (normalize already forces
  allowlist, GJ:361-366). For the others, offer `open_legacy` only when `draft.hydration.rawLegacyConfig.inboundAccessMode
  === "open_legacy"`. Drop "Existing open legacy connections…" text when the option is not shown.

### A9. "Missing" message prints raw config keys

- Problem: Continue can say "Complete the required setup values: … or webhookUrlEnv".
- Reaches: Slack, Discord, Google Chat, Teams.
- Evidence: `channel-wizard-model.ts:98-103` falls back to the raw key; `credentialAlternatives` names `*Env` keys that
  have no field (GJ:386-394).
- Fix (Part A PR): in `findMissingFieldLabels`, skip keys with no field and dedupe; or list only keys that exist as
  fields in GJ:387-389.

### A10. `http://` passes validation, then the test rejects it

- Problem: `validate()` accepts any http(s) URL; the test fails plain http unless the host is 127.0.0.1 or localhost.
- Reaches: Signal, iMessage, Matrix, Mattermost, Nextcloud, ntfy.
- Evidence: `defs/common.ts:249` `looksLikeHttpUrl` (used at `signal.ts:216`, `imessage.ts:296`, `matrix.ts:232`,
  `mattermost.ts:245`, `nextcloud-talk.ts:223`, `ntfy.ts:287`) vs `apps/gateway/src/services/connection-url-helpers.ts:13-23`
  used by `IDS:125-142` ("uses non-local plain HTTP", a blocking fail).
- Fix (Part B, `common.ts`): add a helper that applies the same rule and the message "Use https://. Plain http:// works
  only for this computer (127.0.0.1 or localhost)." Use it in the six validators and say it in each URL field.
- Risk/notes: LAN servers over http can't be used at all today; whether to allow them is N8.

### A11. Instruction steps are labelled "Before you start" wherever they sit, and turn green on a visit

- Evidence: GJ:272-275 labels every non-test, non-confirm step `prerequisites`; `channel-wizard-model.ts:257` shows that
  as "Before you start"; instruction steps without a checklist count as complete once visited
  (`channel-wizard-model.ts:83-84`). Worst: QQ and WeCom "Register the callback URL" in the middle of the flow.
- Fix (Part B, GJ): keep a `stage` the definition already set; default only unset ones. Part B removes the QQ/WeCom
  steps anyway.

### A12. `withGuidedJourney` renames every field step "Connect the account"

- Problem: any second field-collection step a guide adds (Part B wants "Receive messages (optional)" for WhatsApp, LINE,
  WeCom) would be retitled and given `stage: "identity"`.
- Evidence: GJ:253-261 overwrites `title` and `id` for every step with fields.
- Fix (Part B, GJ): only split and retitle the first field step (or steps without an explicit `stage`); keep authored
  title, id and stage on the rest. Also exclude such a step's fields from the `requiredAnyOf` built at GJ:249-252.

### A13. Test-step troubleshooting is missing or wrong

- Evidence: `troubleshooting.commonFailures` has no UI reader (`git grep commonFailures` over
  `apps/mission-control-next/src` hits only a test fixture). Only Discord, Slack and Telegram attach
  `definitionFailures("token")` to their test step (`discord.ts:283`, `slack.ts:209`, `telegram.ts:291`), and its text
  is bot/intent-shaped (`defs/common.ts:23-56`). Nextcloud and ntfy have empty lists (`nextcloud-talk.ts:137`, `ntfy.ts:199`).
- Fix (Part B): give each test step a `troubleshooting` list with that channel's real failures (named in each Part B
  section: WeCom 60020/81013, QQ active-message refusal, Matrix not-joined, Nextcloud bot not installed, allowlist,
  env-var name). Both wizards render step troubleshooting already (Classic :484-507, Cockpit `ChannelWizardContent.tsx:65-75`).

### A14. After a passing test, "Next" says to finalize and then send a test message

- Evidence: `CSS:375` "Finalize the connection and send a sandbox message to confirm destination access.", although the
  test just sent one.
- Fix (Part A or B PR, one string): "Next: check that the test message arrived, then finalize."
- Note: the auditors' other half (drop "activation plan" wording because "there is no plan step") is wrong and dropped;
  see the end of this file.

### A15. Credential errors without a field don't jump to the field

- Evidence: `use-channel-wizard.ts:83-94` jumps only for issues with `fieldKey`. No `fieldKey` on: `qqbot_auth_missing`
  (`qqbot.ts:246-251`), `wecom_auth_missing` (`wecom.ts:311-316`), `zalo_auth_missing` (`zalo.ts:198-203`),
  `imessage_auth_missing` (`imessage.ts:300-305`), `whatsapp_auth_missing` (`whatsapp.ts:331-336`),
  `line_auth_missing` (`line.ts:247`), `matrix_auth_missing` (`matrix.ts:237`), `mattermost_auth_missing`
  (`mattermost.ts:250`), `nextcloud_talk_auth_missing` (`nextcloud-talk.ts:228`).
- Fix (Part B): add `fieldKey` = the pasted secret field (`appSecret`, `secret`, `accessToken`, `password`,
  `accessToken`, `channelAccessToken`, `accessToken`, `botToken`, `token`), and reword "Provide either a … or an
  env-backed … reference." to "Paste the <name>."

### A16. Outbound-only guides get "Choose destinations and access"; nav shows raw step kinds

- Evidence: GJ:262-269 titles every destination step that way, also for Zalo, Teams (no destination step), iMessage;
  nav sub-label uses `humanizeStepKind` ("field collection", "instruction") (`channel-wizard-model.ts:157`,
  Classic :205).
- Fix: GJ: title "Where should messages go?" when `!GUIDED_INBOUND_CHANNELS.has(key)`. Classic nav: show
  `channelStageLabel(step)` instead of the kind.
- Built differently (Ruling R42): Discord keeps "Choose destinations and access". Its step holds the DM and server
  policies. The new title is only for outbound-only channels.

### A17. Classic wizard shows why Finalize is off only as a tooltip

- Evidence: Classic :283-288 (`title={finalizeDisabledReason(...)}`). Cockpit already prints it as text (Cockpit :219-221).
- Fix (Part A PR, Classic only): render the reason as a line under the footer, as Cockpit does.

---

## Part B — per guide

Rules for this part: copy, step order, labels, advanced flags, where-to-find, and validation rules inside `defs/<channel>.ts`
and GJ `POSTURE`. Proposed POSTURE text is plain language and becomes visible with A1. Any wording marked "(unverified)"
must be checked against the vendor before shipping or left out.

### Discord (`defs/discord.ts`)

Chat page comes later (plan 3); fix the Settings guide now.

1. [misleads] The env-var NAME is the "preferred" credential and the real token field is "manual fallback". Evidence
   `discord.ts:142-181`. Change: move `botToken` above `botTokenEnv`; label "Bot token"; explanation "Paste the bot token.
   GoatCitadel keeps it in this computer's secure storage."; drop the "Use only if…" `whyNeeded`. `botTokenEnv`:
   `advanced: true`, label "Bot token from an environment variable (advanced)", A5 rule text. Reword the probe message
   `PROBES:415` to "Discord bot token not found. If you used an environment variable, check its name starts with
   DISCORD_ and restart GoatCitadel." Ship after C1.
2. [misleads] A DM-only setup hits two errors the form never marked required, and the switch that removes them is the
   last field. Evidence GJ:234-240 forces `defaultChannelId`/`defaultGuildId` to `required: false` (visible only while
   guild policy = allowlist); `validate()` requires them (`discord.ts:427-447`); `guildPolicy` is last (`:254-267`).
   Change: in the field array put `guildPolicy` then `inboundDmPolicy` before the two id fields (the destinations step
   keeps array order); relabel `guildPolicy` "Where should the bot listen?" with options "In one server channel, when
   mentioned" (allowlist) and "Direct messages only" (off); in GJ:234-240 drop `required: false` and set
   `defaultGuildId` `required: true` in `discord.ts:204` (hidden fields are skipped by `findMissingFieldLabels`, so
   DM-only stays clear).
3. [misleads] `botTokenEnv` accepts a pasted token and stores it in plain config. See C5.
4. [misleads] Test note says the webhook-only path gets no live send; it does, and the post stays. Evidence
   `discord.ts:278-281` vs `apps/gateway/src/services/discord-connection-diagnostics.ts:23-29`. Change the note to:
   "The webhook-only path sends one visible test post. A webhook can't delete it, so it stays in the channel."
5. [polish] The legacy bridge path sits in the main flow. Delete step `webhook-path` (`discord.ts:121-130`); give
   `webhookUrl` (`:221`) `advanced: true` and label "Webhook URL (send-only, advanced)". Say in its explanation that a
   webhook-only connection still needs a Default channel ID (`validate()` `:427-429`).
6. [polish] Vendor steps are slightly stale. `create-bot` body (`:76-84`): "A new application already has a bot. Open
   Bot › Reset Token and copy the token now; Discord shows it once. On the same page, turn on Message Content Intent."
   Checklist `bot-added` (`:88`) becomes "Copy the bot token (Bot › Reset Token)". `install-bot` body (`:104-111`):
   "Open Installation. Set Install Link to Discord Provided Link. Under Default Install Settings › Guild Install, add the
   scopes applications.commands and bot, and the permissions View Channels, Send Messages, Read Message History. Open
   the install link and choose Add to server." Source: https://docs.discord.com/developers/quick-start/getting-started.
7. [polish] Finish never says where to approve a DM pairing or that no public address is needed. Add to `finish` body
   (`:290-295`): "Approve DM pairing requests in Settings › Channels › this connection › Connection operations. No public
   web address is needed."
   POSTURE (GJ:11-19): summary "Chat with your Discord bot in direct messages, or let it answer in one server channel when
   mentioned. No public web address is needed."; prerequisites ["A Discord application with a bot. Turn on Message
   Content Intent on its Bot page.", "To use it in a server: permission to add the bot, and View Channel, Send Messages
   and Read Message History in that channel."]; firstMessage "Wait until the connection shows ready. In a server, mention
   the bot in the chosen channel. For a direct message, send one, approve the pairing request in Settings › Channels ›
   this connection › Connection operations, then send another and check the reply."

Shared: A3 (`discord.com`, already in the example list), A4 (createOnly: overview, prerequisites, create-bot,
install-bot), A9 (`webhookUrlEnv` in the missing message), C1 (outbound `discordSend` reads `botToken` raw, `CE:993`).

### Slack (`defs/slack.ts`)

Chat page with Socket Mode comes later (plan 3). Today a pasted token can send but never receive.

1. [blocks] The "easy" OAuth path needs the operator's own Slack app, four Gateway env vars, an HTTPS redirect and a
   restart, and the guide says none of it. Evidence `slack.ts:46-49` ("OAuth is the easiest path"), step `oauth-install`
   `:63-78`; `slack-oauth-service.ts:73-96` returns `configured:false` without `GOATCITADEL_SLACK_OAUTH_CLIENT_ID`,
   `_CLIENT_SECRET`, `_REDIRECT_URI`, `_STATE_SECRET` (`integrations-slack-oauth-routes.ts:192-199`); the UI then shows
   "Slack OAuth needs configuration: …" (`settings/sections/use-channel-setup-entry.ts:152`). Change: replace
   `oauth-install` with step `create-app` "Create your Slack app and copy its bot token", ordered list:
   1. "Open api.slack.com/apps › Create New App › From scratch, and pick your workspace."
   2. "Open OAuth & Permissions. Under Bot Token Scopes add chat:write. Add chat:write.public if you won't invite the bot
      to the channel."
   3. "Click Install to Workspace and allow it."
   4. "Copy the Bot User OAuth Token (it starts with xoxb-)."
   5. "For a private channel, type /invite @your-app in that channel."
   Link https://api.slack.com/apps. No checklist (the old one required ticking "Click Connect Slack" on a step that has no
   such button: supplementary actions render only on field steps, Classic :256, Cockpit :215-217). Mark `createOnly`.
   Overview note `:46-49` becomes: "Paste a bot token from your own Slack app. Installing with OAuth is an advanced
   option: it needs your own Slack app, a public HTTPS redirect address and four settings on the Gateway." Put the OAuth
   detail (the four variable names, "then restart GoatCitadel") in the identity step body. Validate message `:350-352`:
   "Paste the bot token (starts with xoxb-), or a webhook URL for send-only." See N7.
   Source for scopes: https://docs.slack.dev/reference/methods/chat.postMessage.
2. [blocks] The working path is labelled "Advanced fallback". Evidence `slack.ts:118-135`. Change: label `botToken`
   "Bot token", move it first; relabel `slackInstallId` "Connected Slack install (OAuth only)"; relabel `webhookUrl`
   "Incoming webhook URL (send-only)".
3. [misleads] The guide promises "verified inbound conversations" that no default setup can reach. Evidence: the
   webhook route needs `slackTeamId` and `slackAppId` (`integration-webhooks-slack-routes.ts:73-82`), written only by the
   OAuth adopt (`channel-oauth-staging-service.ts:152-153`); default OAuth scopes lack `*:history`
   (`slack-oauth-service.ts:6-14`); only event type `message` is handled (`slack-webhook.ts:159`), so `app_mention` is
   ignored; Socket Mode does not exist here. Change: intro note "In this version Slack can receive messages only from an
   app installed with OAuth here, with message history scopes (set GOATCITADEL_SLACK_OAUTH_SCOPES) and a public HTTPS
   address. A pasted bot token can send but not receive." Give `signingSecret` (`:176-196`)
   `visibleWhenFieldEquals: { fieldKey: "authMode", value: "oauth" }` and label "Signing secret (OAuth installs that
   receive messages)".
4. [misleads] First-message names a URL the UI never shows. See A2. POSTURE firstMessage text below.
5. [misleads] Public address not stated anywhere visible (only picker note `picker-hints.ts:21`). POSTURE (GJ:20-29):
   summary "Send messages from your own Slack app into the channels you choose. Receiving messages needs an app installed
   with OAuth and a public HTTPS address."; prerequisites ["Your own Slack app with the chat:write scope, installed to
   your workspace.", "The bot invited to each private channel (/invite @your-app).", "To receive messages: an OAuth
   install from here with message history scopes, and a public HTTPS address for this Gateway."]; firstMessage "Check
   the test message arrived. To receive messages (OAuth installs only): in your Slack app open Event Subscriptions,
   paste this connection's webhook address, subscribe to message events, and allow your Slack member ID under Who may
   message this bot."
6. [misleads] Sender id help and `open_legacy` on new drafts. See A7, A8.
7. [polish] Test copy `:207` is wrong (the webhook-only test does post, `IDS:648-657`): "The webhook-only path sends one
   test post that stays in the channel." Probe advice "Reconnect Slack" (`PROBES:1447, 1450`) is useless for a pasted
   token: "Copy the bot token again, or add the missing scope and reinstall the app."
8. [polish] Webhook-only still requires a channel target (`slack.ts:365-367`) although an incoming webhook is bound to
   one channel. Require `targets` only when a bot token is set.

Shared: A3 (`slack.com` missing from the example allowlist; C7 for the test), A4, A9, C1 (an OAuth install also stores
`botToken` as a keychain reference, so `slackSend` at `CE:788` is affected).

### Teams (`defs/teams.ts`)

The most truthful guide. Sends only.

1. [misleads] A required checkbox can be impossible for a solo user. Checklist item `owner` "Confirm an owner and
   co-owner" (`teams.ts:61`) blocks Continue. Microsoft calls co-owners the fix for orphaned flows, not a requirement
   (https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).
   Change: delete the item; body `:56` keeps "Adding a co-owner is recommended so the workflow keeps running if the owner
   leaves."
2. [polish] The guide describes building a flow from scratch. Add to `create-webhook` body (`:52-54`): "Easiest: in the
   channel, open More options (⋯) › Workflows › 'Send webhook alerts to a channel'. Then open its trigger and set Who can
   trigger the flow? to Anyone." Which template defaults to Anyone is unverified, so keep the "set it to Anyone" sentence.
3. [polish] "before acknowledging the receipt" (`:105`) and "confirmed receipt" (`:114`): GoatCitadel never asks for that
   for Teams. Change to "Check the card arrived in the channel. If it didn't, open the workflow's run history."
4. [polish] Catalog text contradicts the guide (outside `defs/`): `apps/gateway/src/services/integration-catalog.ts:1107`
   "Teams bot/webhook integration." becomes "Send Adaptive Card notifications to a Teams channel through a Workflows
   webhook. Sends only."; drop `"threads"` from `:1110`; manual-form placeholder `:391`
   `https://outlook.office.com/webhook/...` becomes `https://<environment>.environment.api.powerplatform.com/...`.
   POSTURE (GJ:63-72): summary "Post cards to a Microsoft Teams channel through a Workflows webhook. Sends only: Teams
   can't message GoatCitadel. No public web address is needed."; prerequisites ["A Teams Workflows webhook whose trigger
   allows Anyone. Tenant-only triggers don't work.", "A co-owner on the workflow is recommended.", "Old Office 365
   connector URLs stopped working in May 2026; make a new Workflows webhook."]; firstMessage "Check the test card
   appeared in the channel. If it didn't, open the workflow's run history in Teams."

Shared: A3 (host from `webhookUrl`; example list has both Microsoft patterns), A4 (overview, create-webhook), A9
("Webhook URL or webhookUrlEnv"), A16, C1 (`webhookUrl` is a secret field, so the saved value is a keychain reference
that `teamsSend` reads raw). Sovereign-cloud URLs: Unverified.

### Google Chat (`defs/google-chat.ts`)

1. [blocks] Webhook mode can't be finalized unless the "optional" thread key is filled. See C2.
2. [blocks] Chat app mode can never pass the test. See C2 and N3.
3. [blocks] Chat app instructions need this connection's address before it exists, and the word "webhook URL" names two
   different things. Evidence `google-chat.ts:72-77` (step 2 body), `:128-137` (audience = "this connection's public
   HTTPS webhook URL"), field `webhookUrl` labelled "Webhook URL (webhook mode)" (`:90-91`); address pattern
   `integration-webhooks-google-chat-routes.ts:32`; id minted at `CSS:464`. Change: relabel `webhookUrl` "Incoming
   webhook URL"; in app-mode copy say "Pick Project number as the audience (the endpoint-URL audience needs this
   connection's address, which you only get after finishing). After you finish, paste this connection's webhook address
   into the Chat app's HTTP endpoint URL." See A2 and C3.
4. [misleads] Two products share one form. All fields show together and mode is guessed from the key variable
   (`google-chat.ts:18-28`, `:88-169`). Change: add a first select `mode` "Connect with" with options "Incoming webhook
   (sends only)" / "Chat app (sends and receives)"; give every mode-specific field `visibleWhenFieldEquals` on it;
   set `hydrate` to derive `mode` from `serviceAccountKeyEnv`/`serviceAccountKey`; drop `mode` in `normalize` (the
   diagnostics keep inferring app mode at `IDS:536`); hide the sender step for webhook mode (A8).
5. [misleads] Incoming webhooks need a Workspace Business or Enterprise account and an admin who allows them, and can't be
   made in the phone app. Add to step 2: "Needs a Google Workspace Business or Enterprise account, and your admin must
   allow webhooks. Personal Gmail accounts can't add them. On a computer: open the space › its name › Apps &
   integrations › Add webhooks › name it › Save › More › Copy link."
   Source: https://developers.google.com/workspace/chat/quickstart/webhooks.
6. [misleads] Chat app setup steps are missing. Add an ordered list for app mode: "1. In Google Cloud, create a project
   and turn on the Google Chat API. 2. On the Chat API Configuration page set the app name, avatar and description, turn
   on interactive features, choose HTTP endpoint URL, choose the authentication audience, and set who can see it.
   3. Create a service account and download its JSON key. 4. Add the app to your space." Sources:
   https://developers.google.com/workspace/chat/configure-chat-api,
   https://developers.google.com/workspace/chat/authenticate-authorize-chat-app.
7. [misleads] The only way to give the key is an env var holding the whole JSON key (`:102-112`), although
   `serviceAccountKey` is a secret field key (`:203`) and the executor reads it (`CE:1906`). Change: add a secret
   textarea field `serviceAccountKey` "Service-account key (paste the JSON)"; make `serviceAccountKeyEnv` advanced
   (A5). Ship after C1. (The Windows `setx` 1024-character limit is unverified; don't cite it in copy.)
8. [misleads] Allowed sender ids (`users/…`) are not findable. See A6, A7.
9. [polish] Test copy overclaims (`:179-181`): "GoatCitadel checks that the key is set and the audience looks right; it
   doesn't contact Google in this mode." `defaultSpace` has no where-to-find (format in the web address is unverified).
   POSTURE (GJ:52-62): summary "Incoming webhook: send messages into one Google Chat space (sends only). Chat app: send
   and receive, with a Google Cloud project and a public HTTPS address."; prerequisites ["Incoming webhook: a Google
   Workspace Business or Enterprise account and permission to add webhooks to the space.", "Chat app: a Google Cloud
   project with the Chat API on, a service account key, and a public HTTPS address for this Gateway.", "Chat app: the
   Google user ids (users/…) allowed to message it."]; firstMessage "Incoming webhook: check the test message appeared in
   the space. Chat app: paste this connection's webhook address into the Chat app's HTTP endpoint URL, allow your
   users/… id, then message the app and check the reply."

Shared: A3 (`chat.googleapis.com`, plus `oauth2.googleapis.com` in app mode), A4 (overview, create-webhook), A9, C1.

### WhatsApp (`defs/whatsapp.ts`)

Chat page comes later (plan 4).

1. [blocks] The live test sends plain text, which WhatsApp delivers only in the 24 hours after the recipient messaged the
   business. Evidence `PROBES:920-936` (`type: "text"`); Meta
   https://developers.facebook.com/docs/whatsapp/cloud-api/get-started. Runtime choice: C4 and N2. Copy now:
   `defaultTarget` explanation (`whatsapp.ts:108`) and test body (`:179-181`): "First, from the recipient's phone, send
   any message to your business number. That opens WhatsApp's 24-hour window. Then run the live test. GoatCitadel's test
   is plain text, which WhatsApp only delivers inside that window." Move "confirm the message arrived" from the finish
   body (`:192-194`) to the test step; the message is sent by the test, not by Finalize.
2. [blocks] No instructions for the access token, and the obvious one expires. Token fields have no `whereToFind`
   (`:57-86`). Add to `accessToken`: "Use a permanent System User token, not the temporary one on the API Setup page
   (that one expires quickly). Business Settings › Users › System users › Add › assign your app and WhatsApp account ›
   Generate token with whatsapp_business_messaging, whatsapp_business_management and business_management."
   Source: the get-started page above.
3. [misleads] Receiving needs a public HTTPS address with a trusted certificate; nothing visible says so, and the app
   secret / verify token look like normal options. Change: intro body (`:40-49`) "Sending works from this computer. To
   chat with the bot, Meta must reach your Gateway over a public HTTPS address with a trusted certificate. GoatCitadel
   doesn't provide one; without it WhatsApp is send-only. Personal WhatsApp (QR code linking) isn't supported." Move the
   four inbound fields (`appSecretEnv`, `appSecret`, `webhookVerifyTokenEnv`, `webhookVerifyToken`, `:115-171`) into
   their own field step "Receive messages (optional)" before the test step (needs A12). Webhook registration steps go in
   POSTURE firstMessage. Source: https://developers.facebook.com/docs/graph-api/webhooks/getting-started.
4. [misleads] Allowed sender format: `wa_id`, digits only (`whatsapp-webhook.ts:187`); `+1555…` never matches. See A7.
5. [misleads] Phone number ID where-to-find is vague (`:94-98`): "In Meta's App Dashboard open WhatsApp › API Setup.
   The Phone number ID is under the From number."
6. [polish] "can post a sandbox message" (`:48`, `:180`): it always posts (`CSS:351`). "will post a test message to your
   Default recipient".
7. [polish] App secret location: "App settings › Basic" per the repo doc only (unverified on Meta's pages).
   POSTURE (GJ:73-82): summary "Send WhatsApp messages from a WhatsApp Business number through Meta's Cloud API.
   Receiving messages needs a public HTTPS address. Personal WhatsApp (QR code linking) isn't supported.";
   prerequisites ["A Meta app with WhatsApp set up, its phone number ID, and a permanent System User access token.",
   "The recipient messages your business number first; WhatsApp delivers the plain-text test only in the 24 hours
   after that.", "To receive messages: a public HTTPS address with a trusted certificate, the app secret, and a verify
   token you choose."]; firstMessage "Check the test message arrived. To receive: in Meta's App Dashboard open WhatsApp ›
   Configuration, paste this connection's webhook address and your verify token, verify, and subscribe to messages.
   Allow your number (digits only, no plus) under Who may message this bot, then send a message and check the reply."

Shared: A3 (`graph.facebook.com`; C7), A5, A15, C1.

### Signal (`defs/signal.ts`) — gated: Signal/iMessage decision (N1)

Retired 2026-10-28 (N1); not applied.

1. [blocks] The bridge guidance names software the code can't talk to. Field `baseUrl` where-to-find "signal-cli REST
   or JSON-RPC proxy" (`signal.ts:65-67`), `officialDocsUrl` bbernhard/signal-cli-rest-api (`:162`); code calls
   `POST /api/v1/rpc` (`PROBES:1272`, `CE` signal send) and `GET /api/v1/events`
   (`channel-stream-adapters/signal-stream-adapter.ts`), the `signal-cli daemon --http` endpoints
   (https://github.com/AsamK/signal-cli). Change: "Run `signal-cli daemon --http` on this computer. It listens on
   http://127.0.0.1:8080. signal-cli-rest-api is a different program and isn't supported."; `officialDocsUrl`
   https://github.com/AsamK/signal-cli.
2. [blocks] The bot needs its own number. Messages from the bot's own account and sync messages are dropped
   (`signal-stream-adapter.ts:79-93`), so linking signal-cli to your own number sends but can never chat. Add a
   `createOnly` instruction step before the fields: "Get a separate phone number for the bot. Register it in signal-cli
   (`signal-cli -a +1… register`, then `verify`), start the daemon, then message that number from your own Signal."
   Give `defaultRecipient` (`:88`) a different example than `accountId` (`:79`, both `+15551234567`).
3. [misleads] Group recipients must be `group:<groupId>` (`PROBES:1645-1646`). `looksLike` (`:88`): "+15557654321 or
   group:<groupId>".
4. [misleads] Sender id is the UUID (`signal-stream-adapter.ts:87`). See A7.
5. [misleads] "Account ID" is called optional "when the bridge exposes multiple accounts" (`:74-81`); a daemon started
   without `-a` is multi-account and needs it. Change: "Enter the bot's number, unless you started the daemon with -a."
   (Whether single-account mode needs it is unverified.)
6. [misleads] The stated reason messages are lost is stale (`:48`, GJ:92): "GoatCitadel doesn't ask signal-cli to replay
   missed messages, so messages that arrive while it is disconnected are lost."
7. [polish] Sender step shows with receiving off. See A8.
8. [polish] The test only sends (`PROBES:1238-1305`). Test body (`:111`): "The test only sends. After you finish, send the
   bot a message to check receiving."
   POSTURE (GJ:83-93): summary "Send and receive Signal messages through signal-cli, a community-made Signal client
   running on this computer. It needs its own phone number."; prerequisites ["signal-cli running as
   `signal-cli daemon --http` on this computer.", "A separate phone number registered in signal-cli for the bot. Don't
   use your own number: messages you send yourself are ignored.", "To receive: the sender UUIDs allowed to message it."];
   firstMessage "Check the test message arrived. To receive: turn on Receive messages, allow your sender UUID, send the
   bot's number a message from your own Signal, and check the reply. Messages that arrive while GoatCitadel is
   disconnected are lost."

Shared: A10 (LAN http fails), C1 (no secrets for Signal; not affected).

### iMessage (`defs/imessage.ts`) — gated: Signal/iMessage decision (N1)

Retired 2026-10-28 (N1); not applied.

1. [blocks] Bridge URL example uses the wrong port and assumes the same Mac. `looksLike http://127.0.0.1:3001`
   (`imessage.ts:82`); BlueBubbles' default is 1234 (https://docs.bluebubbles.app/server/); plain LAN http fails
   (`connection-url-helpers.ts:13-23`). Change explanation: "On the Mac running BlueBubbles use http://127.0.0.1:1234.
   From another computer, use the HTTPS Server URL BlueBubbles shows (Cloudflare, Zrok or Ngrok). A plain
   http://192.168… address won't pass the test." `looksLike` "http://127.0.0.1:1234".
2. [misleads] Never says iMessage can't receive (`packages/gateway-core/src/channel-core.ts:768-790` `inboundModes:
   ["none"]`); the intro lists "replies" (`imessage.ts:50`). First line: "iMessage is send-only here. You can't message
   GoatCitadel through iMessage."
3. [blocks, unverified] The test unsends its message; a non-403 4xx from unsend blocks Finalize. See C8. Say in the test
   body (`:142`): "The test sends a message and then unsends it. Unsend needs BlueBubbles' Private API."
4. [misleads] Photon can never finish (`IDS:785-800` returns `fail`), yet the success criteria read as if it can
   (`imessage.ts:160`). Remove Photon from `IMESSAGE_PROVIDER_OPTIONS` (`:18-21`) or label it "Photon (not available
   yet)"; delete the Photon clause in `:160`.
5. [misleads] Required values aren't marked required. GJ:225-230 sets `required: false` on `bridgeUrl`, `password`,
   `passwordEnv`, `defaultHandle`; GJ:392 gives no `requiredAnyOf`. Change: keep `required: true` on `bridgeUrl` and
   `defaultHandle` (keep the visibility condition); once Photon is out of the select, return
   `[["password","passwordEnv"]]` for imessage in GJ:392; add `fieldKey: "password"` (A15).
6. [misleads] The password has no where-to-find. "The server password you set in BlueBubbles Server." A5 rule: the
   variable name must start with IMESSAGE_.
7. [polish] Default handle example (`:131`) suggests a prefix is needed; a bare number or email works
   (`PROBES:1691-1721`). `looksLike` "+15551234567 or name@icloud.com".
8. [polish] Keep the Mac on and awake (plain caution; BlueBubbles docs fetched don't say).
   POSTURE (GJ:142-151): summary "Send iMessages through BlueBubbles on a Mac. Sends only: you can't message GoatCitadel
   through iMessage."; prerequisites ["A Mac with iMessage signed in and BlueBubbles Server running, and its server
   password.", "If GoatCitadel runs on another computer: BlueBubbles' HTTPS address. A plain http:// LAN address won't
   pass the test.", "BlueBubbles' Private API, for unsend and reactions."]; firstMessage "Check the test message
   arrived in Messages."

Shared: A3 (bridge host; loopback is on the example list), A5, C1 (`imessageSend` reads `password` raw, `CE:2677`).

### LINE (`defs/line.ts`)

1. [blocks] Default target is required and LINE shows no user id in its app. Evidence `line.ts:94-101`, validate
   requires it. Add `whereToFind`: "For a one-to-one chat use your own user ID: LINE Developers Console › your channel ›
   Basic settings › Your user ID (starts with U). Add your Official Account as a friend first (scan the QR code on the
   Messaging API tab). Group and room IDs only appear in webhook events." Source:
   https://developers.line.biz/en/docs/messaging-api/getting-user-ids/ (the friend requirement is unverified).
2. [misleads] No vendor steps, and Messaging API channels can no longer be created directly in the Developers Console
   (since 2024-09-04). Add a `createOnly` instruction step before the fields: "1. In LINE Official Account Manager,
   create an Official Account. 2. Open its settings › Messaging API and turn it on. 3. In LINE Developers Console, open
   the channel's Messaging API tab and issue a long-lived channel access token." Token `whereToFind`: "Messaging API tab ›
   Channel access token (long-lived). GoatCitadel can't renew short-lived tokens." Secret `whereToFind`: "Basic settings
   tab" (unverified). Source https://developers.line.biz/en/docs/messaging-api/getting-started/.
3. [misleads] Receiving needs public HTTPS with a trusted certificate. Intro: "LINE can send you messages only if it can
   reach your Gateway over public HTTPS. GoatCitadel doesn't provide that; without it this connection is send-only."
   Move `channelSecretEnv`/`channelSecret` (`:72-92`) into "Receive messages (optional)" (needs A12).
4. [misleads] Every reply is a push message (`CE:1329-1375`, push only), and push messages count toward the monthly
   limit (free plan 200 a month; https://developers.line.biz/en/docs/messaging-api/pricing/). One intro sentence.
5. [misleads] Sender id help. See A7.
6. [polish] "can post a sandbox push message" (`:42`, `:110`) → "will post a test message". Move "confirm the push
   arrived" (`:120`) to the test step.
   POSTURE (GJ:162-171): summary "Send LINE messages from your LINE Official Account. Receiving needs a public HTTPS
   address. Every message is a push message, which counts toward your plan's monthly limit."; prerequisites ["A LINE
   Official Account with the Messaging API on, and its long-lived channel access token.", "Your LINE user ID (Developers
   Console › your channel › Basic settings) with the Official Account added as a friend.", "To receive: a public HTTPS
   address and the channel secret."]; firstMessage "Check the test message arrived. To receive: in LINE Developers
   Console › Messaging API set Webhook URL to this connection's webhook address, click Verify, turn on Use webhook, and
   turn off auto-reply and greeting messages in Official Account Manager. Allow your LINE user ID under Who may message
   this bot."

Shared: A3 (`api.line.me`; C7), A5 (`LINE_` prefix; secret name must end `_CHANNEL_SECRET` or `_SECRET`), A15, C1.

### Matrix (`defs/matrix.ts`)

1. [blocks] No way to get the access token. Add a `createOnly` instruction step before the fields: "Create a Matrix
   account for the bot. Sign in as the bot and get its access token (your Matrix app may show it under Settings › Help &
   About › Advanced; unverified). Signing that session out makes the token stop working. GoatCitadel doesn't renew
   tokens." Source https://spec.matrix.org/latest/client-server-api/ (login).
2. [blocks] Joining the room is unexplained and GoatCitadel doesn't accept invites (`matrix-stream-adapter.ts:169` reads
   only `rooms.join`; test fails "Invite the bot account… and accept", `matrix-live-probes.ts:172`). Same step: "Invite
   the bot from your own account, then sign in as the bot in a Matrix app and accept. GoatCitadel doesn't accept invites
   for you."
3. [blocks] Homeserver must be allowlisted; the guide says so but not where (`matrix.ts:49`). See A3.
4. [misleads] Encrypted rooms fail silently (`matrix-stream-adapter.ts:173-176`). Same step: "Create a new room with
   encryption off and invite the bot into it. A default direct message is usually encrypted, and the bot won't see it."
   (client default unverified)
5. [misleads] Sender id format. See A7.
6. [misleads] Never says no public address is needed. POSTURE (GJ:105-117): summary "Send and receive Matrix messages
   through a bot account on your homeserver. No public web address is needed: GoatCitadel connects out, and only hears
   messages while it's running."; prerequisites ["A Matrix account for the bot and its access token.", "The bot invited
   to and joined in a room with encryption off. GoatCitadel can't read encrypted rooms and doesn't accept invites.",
   "Your homeserver in the hosts GoatCitadel may reach."]; firstMessage "Check the test notice arrived. To receive: turn
   on Receive messages, allow your Matrix ID (for example @alice:example.com), post in the room, and check the reply."
7. [polish] `defaultRoomId` (`:88-96`) has no where-to-find (client location "Room settings › Advanced › Internal room ID"
   unverified); homeserver API URL can differ from the server name (delegation, unverified); receive default off (N10);
   dead copy `:31-34`.

Shared: A5 (`MATRIX_`), A8, A10, A15, C1 (`CE:2286`), C6.

### Mattermost (`defs/mattermost.ts`)

1. [blocks] The server host must be allowlisted and nothing says so; the stream also stops for good on an allowlist
   refusal (`mattermost-stream-adapter.ts:220-222`). See A3.
2. [misleads] No token instructions, and only system admins can create bots. Add a `createOnly` instruction step: "Ask
   a system admin if you aren't one. 1. System Console › Integrations › Bot Accounts: turn on Enable Bot Account
   Creation. 2. Product menu › Integrations › Bot Accounts › Add Bot Account. 3. Copy the token; it is shown once.
   4. Add the bot to the team and to each channel it should use; it doesn't join on its own." Source
   https://docs.mattermost.com/developers/integrate/reference/bot-accounts.
3. [misleads] "Default channel" is required and its wording invites a display name. Evidence `mattermost.ts:86-93`,
   resolver `PROBES:1745-1776, 1822`. Change label "Where should the test post go?", explanation "The channel name from
   its web address (for example town-square), or @your-username to have the bot message you. The bot must already be a
   member."
4. [misleads] Sender ids: the prerequisites' "open a person's profile and choose Copy user ID" (GJ:100) is unverified;
   usernames never match (`mattermost-stream-adapter.ts:164-186`). Drop the "Copy user ID" claim; see A7.
5. [misleads] A wrongly named variable gives a test with no live proof that still finalizes. See C6.
6. [polish] `defaultTeam` (`:106-114`) → `advanced: true`. `officialDocsUrl` (`:174`) → the docs.mattermost.com page.
   Dead copy `:31-33`.
   POSTURE (GJ:94-104): summary "Send and receive Mattermost posts through a bot account. No public web address is needed:
   GoatCitadel connects out, and only hears posts while it's running."; prerequisites ["A bot account and its token. Only
   a Mattermost system admin can create bots.", "The bot added to the team and to each channel it should use.", "Your
   Mattermost server in the hosts GoatCitadel may reach."]; firstMessage "Check the test post arrived. To receive: turn on
   Receive posts, allow your user ID, post in a channel the bot is in (or message the bot directly), and check the reply."

Shared: A5 (`MATTERMOST_`), A8, A10, A15, C1 (`CE:2132`).

### Nextcloud Talk (`defs/nextcloud-talk.ts`)

1. [blocks] Receiving is circular: the test needs the bot installed, the bot's webhook address is fixed at install, and the
   address needs a connection id that exists only after Finalize. Evidence `nextcloud-talk-live-probes.ts:24-27`
   (blocking fail without an installed bot), `integration-webhooks-nextcloud-talk-routes.ts:23`, `CSS:464`. Runtime: C3.
   Copy until C3 lands (two phases): "Sending: install the bot with any placeholder address, turn it on for the room,
   test, finish. Receiving (optional), after you finish: copy this connection's webhook address, uninstall the bot and
   install it again with that address and the same secret, then turn it on for the room again. A Talk bot's address
   can't be changed." Source https://nextcloud-talk.readthedocs.io/en/latest/occ/.
   Superseded (Ruling R53): no address is claimed to work. Send-only uses `occ talk:bot:create`, which needs no webhook
   address. Receiving uninstalls the bot and installs it again with the real address.
2. [blocks] No bot setup steps. Add a `createOnly` instruction step: "You need shell access to your Nextcloud server.
   1. `occ talk:bot:install` with a name, a secret of 40 to 128 characters, the webhook address, and the features
   webhook and response. 2. `occ talk:bot:setup <bot-id> <room-token>` for the conversation." Without the response feature
   the bot can't post. Source https://nextcloud-talk.readthedocs.io/en/latest/bots/ (confirm exact flag syntax there).
   Superseded (Ruling R53): the send-only step uses `occ talk:bot:create`. The `occ talk:bot:install` step with the real
   address is only for receiving.
3. [blocks] "Default room ID" is the conversation's room token, and "Token" means two things here. Relabel `tokenEnv`
   "Bot secret from an environment variable (advanced)", `token` "Bot secret", `defaultRoomId` "Room token" with
   explanation "The code at the end of the conversation's web address (…/call/<token>)" (location unverified).
4. [blocks, receiving] Sender ids are `users/<name>`; a bare name never matches (`nextcloud-talk-webhook.ts:132`). See A7.
5. [blocks] Nextcloud host must be allowlisted (`nextcloud-talk-live-probes.ts:14`). See A3.
6. [misleads] Public address only in hidden prerequisites; the test passes without one. Intro: "Sending works without a
   public address. Receiving needs an HTTPS address your Nextcloud server can reach."
7. [misleads] Variable names must start with NEXTCLOUD_TALK_ (probe guard) and end in _SECRET or _TOKEN (webhook guard,
   `channel-secret-resolution.ts:4`); NEXTCLOUD_TALK_TOKEN satisfies both. A5 text.
8. [misleads] A pasted secret breaks receiving: `resolveNextcloudTalkSecret` reads it raw
   (`apps/gateway/src/routes/integration-webhooks-shared.ts:60-66`). See C1.
9. [misleads] Internal note shown to operators (`nextcloud-talk.ts:43-46`, "brings its setup flow into parity…"). Delete it.
10. [polish] Test-step troubleshooting is empty (`:137`); add "Bot not installed or response feature missing", "Secret
    under 40 characters", allowlist (A13).
    POSTURE (GJ:152-161): summary "Send Nextcloud Talk messages through a Talk bot. Receiving needs an HTTPS address your
    Nextcloud server can reach."; prerequisites ["Shell access to your Nextcloud server, to add a bot with occ.", "A bot
    secret of 40 to 128 characters.", "The room token of the conversation the bot should use."]; firstMessage "Check the
    test message arrived. To receive: reinstall the bot with this connection's webhook address and the same secret, turn
    it on for the room again, allow users/<your user name>, and send a message."

Shared: A10, A15, C1, C3.

### ntfy (`defs/ntfy.ts`)

1. [blocks] The pre-filled `https://ntfy.sh` isn't on the default allowlist, so the "beginner, 4 minutes" path can't
   finish. Evidence default `ntfy.ts:79`, `IDS:254`. See A3 (host from `baseUrl`).
2. [blocks, receiving] Receiving needs a token, there is no way to paste one, and no instructions. `validate()` requires
   it (`ntfy.ts:304-311`); `secretFieldKeys: ["token"]` (`:186`) but no `token` field. Change: add a secret field `token`
   "Access token" (after C1) with where-to-find "Create one with `ntfy token add` on your server, or in your account on
   the ntfy web app (unverified for ntfy.sh). It starts with tk_." Source https://docs.ntfy.sh/config/; keep `tokenEnv`
   advanced (A5).
3. [misleads, security] On public ntfy.sh anyone who knows the topic can post to it and start conversations
   (https://docs.ntfy.sh/config/ "auth-default-access"). Replace "The token gates reading the topic…" (`:49`, `:113`,
   GJ:43) with: "Receiving is only safe on a topic nobody else can post to: your own ntfy server with access control, or
   a reserved topic. On the free public ntfy.sh, anyone who knows the topic name can post and start conversations. Use a
   long random topic name." See N9.
4. [misleads] Topic validation accepts dots and 128 characters; ntfy allows letters, digits, _ and -, up to 64
   (https://docs.ntfy.sh/publish/). Change regex at `ntfy.ts:292` and `:296` (and the probe
   `ntfy-channel-live-probes.ts:111`) to `^[A-Za-z0-9_-]{1,64}$`, message "Topics use letters, numbers, _ and -, up to 64
   characters."
5. [misleads] Dry run can finish with nothing ever sent, and stays on (`ntfy-channel-live-probes.ts:30-41`,
   `CE:1696-1698`). Field `dryRun` explanation and finish body: "With dry run on, nothing is ever sent. Turn it off after
   testing."
6. [misleads] The sender step says an empty list blocks everything, but `normalize()` adds `ntfy-topic:<topic>` for you
   (`ntfy.ts:263-279`) and doesn't update it when the topic changes. See A7 (ntfy text) and A8.
7. [polish] Checklist item `token-env` (`:66`) must be ticked even for a token-less topic: reword "If the topic needs a
   token, have it ready". Split the long overview note (`:49`) into "Sending", "Receiving (optional)", "Limits". Probe
   note "ntfy does not expose a portable delete" (`ntfy-channel-live-probes.ts:84-91`) is wrong per the docs; say "The
   test message stays on the topic." Test troubleshooting empty (`:199`).
   POSTURE (GJ:41-51): summary "Send notifications to an ntfy topic. Optionally, messages posted to a topic can start
   conversations; only do that on a topic nobody else can post to. No public web address is needed."; prerequisites ["An
   ntfy server (ntfy.sh or your own) and a topic name.", "The ntfy app subscribed to that topic, to see the test.", "To
   receive: an access token that can read the topic."]; firstMessage "Check the test notification arrived. If dry run is
   on, turn it off; with it on nothing is sent. To receive: post to the subscribe topic from another device and check the
   reply."

Shared: A5 (`NTFY_`), A10, C1 (`CE:1699`).

### QQ Bot (`defs/qqbot.ts`)

1. [blocks] Nobody gets a reply until their openid is allowed, and QQ shows openids nowhere. Evidence default-deny
   GJ:215, `integration-webhooks-qqbot-routes.ts:113`; the only route is the unbacked diagnostic promise (GJ:125). Change
   after A6: sender explanation "QQ doesn't show your openid. Finish setup, message the bot once (it won't reply), copy
   your openid from System › Diagnostics, add it here with Edit setup, and message again. Group and direct-message ids
   differ: allow each." Without A6 the copy must say there is no screen that shows it.
2. [blocks] "Register the callback URL" sits before Finalize but can only be done after it. Step `webhook`
   (`qqbot.ts:111-123`). Delete the step; move its text to POSTURE firstMessage with A2's address.
3. [misleads] Public address not said up front. Intro (`:42-53`): "QQ delivers messages only to a public HTTPS address on
   port 443, 8443, 80 or 8080 that you provide (a reverse proxy or tunnel to this Gateway, which listens on 8787).
   GoatCitadel runs no relay. Without one this connection can only send, and QQ limits unprompted messages." Source
   https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html.
4. [misleads] "Default target" invites a value nobody has, and a refused test send blocks Finalize
   (`qqbot-live-probes.ts:257-266`). Explanation (`:94-97`): "Leave empty on first setup. QQ often refuses a message the
   user didn't ask for, and that stops you finishing. Add one later, after you've messaged the bot."
5. [misleads] The sandbox switch is hidden under Advanced and "sandbox message" is wrong when it's off. Remove `"sandbox"`
   from `ADVANCED_KEYS` (GJ:212; only QQ uses it); label "Test mode (sandbox)", explanation "Turn on while your QQ app is
   not published yet." (rule unverified); move it next to App ID. Test copy (`:130`, `:145`): "test message".
6. [misleads] Hosts listed only in a note (`:51`). See A3. The token endpoint host `bots.qq.com` vs QQ's documented
   `api.bot.qq.com` is unverified (code comment `qqbot-live-probes.ts:15-17`).
7. [misleads] "Subscribe to the group, C2C, guild-channel and direct-message events" isn't actionable. Name them:
   GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE, AT_MESSAGE_CREATE, DIRECT_MESSAGE_CREATE (`qqbot-webhook.ts:152-176`);
   "Group messages arrive only when the bot is @-mentioned. QQ must approve group and direct-message events first."
8. [polish] No where-to-find for App ID / App secret and no docs link: add "q.qq.com › your bot › Development settings"
   (labels unverified) and https://bot.q.qq.com/wiki/develop/api-v2/. "Ready when" bullet "or you confirmed delivery
   manually" (`:145`) isn't enforced; drop it. `estimatedMinutes: 12` (`:27`) → 25, difficulty "advanced".
   POSTURE (GJ:118-129): summary "Send and receive QQ messages through a QQ Bot Open Platform app. Receiving needs a
   public HTTPS address on port 443, 8443, 80 or 8080."; prerequisites ["The QQ Bot app's AppID and AppSecret.", "A
   public HTTPS address for this Gateway (a reverse proxy or tunnel); GoatCitadel doesn't provide one.", "QQ's approval
   for group and direct-message events, if you want them."]; firstMessage "In the QQ Bot console set the callback URL to
   this connection's webhook address and subscribe to GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE, AT_MESSAGE_CREATE and
   DIRECT_MESSAGE_CREATE. Message the bot once; it won't answer yet. Add your openid (see Who may message this bot) with
   Edit setup, then message again."

Shared: A5 (`QQBOT_`), A15, C1 (`CE:2386`; inbound `resolveQqbotSecret`), N6 (every edit re-sends a test message).

### WeCom (`defs/wecom.ts`)

1. [blocks] Token and EncodingAESKey are asked for before the guide says where they come from, and WeCom's Save only
   succeeds after Finalize. WeCom defines them on its receive form and verifies the URL on Save
   (https://developer.work.weixin.qq.com/document/path/90930); the GET handler refuses until the connection exists and is
   on (`integration-webhooks-wecom-routes.ts:82-93`). Change: move `callbackTokenEnv`, `callbackToken`,
   `encodingAesKeyEnv`, `encodingAesKey` (`wecom.ts:101-140`) into a field step "Receive messages (optional)" before the
   test (needs A12), body: "1. In the WeCom admin console open your app › receive messages settings. Choose a Token and
   generate an EncodingAESKey there, but don't save yet. 2. Enter them here. 3. Test and finish. 4. Then enter this
   connection's webhook address in WeCom and save." Delete step `webhook` (`:154-166`).
2. [blocks] The trusted-IP rule stops Finalize and is only in hidden prerequisites. The test fails on errcode 60020
   (`wecom-live-probes.ts:236-248`; https://developer.work.weixin.qq.com/document/path/90313). Intro warning note and a
   test troubleshooting item: "WeCom only accepts calls from IPs on your app's trusted IP list. Add this computer's public
   IP (search 'what is my IP'). If your IP changes, sending stops with error 60020." (console location unverified)
3. [misleads] Recipients must be in the app's visible range (81013,
   https://developer.work.weixin.qq.com/document/path/90236). `defaultTarget` (`:146-151`): "Leave empty on first setup,
   or add the person to the app's visible range first."
4. [misleads] Public address not up front (`:46-56`): "Sending works from this computer once its IP is trusted. Receiving
   needs a public HTTPS address you provide (a reverse proxy or tunnel); GoatCitadel runs no relay."
5. [misleads] No where-to-find for Agent ID and Secret. `agentId` (`:73-80`): "App Management › Apps › your self-built
   app"; `secret`: same page; `corpId` (`:68`): "My Enterprise › Enterprise Info"
   (https://developer.work.weixin.qq.com/document/path/90665).
6. [misleads] Variable names differ by path: `WECOM_ENCODING_KEY` passes the probe guard but fails the webhook guard
   (needs a suffix such as `_AES_KEY`, `channel-secret-resolution.ts:4`). A5 text for the two callback fields: "start
   with WECOM_ and end in _TOKEN or _AES_KEY".
7. [misleads] `qyapi.weixin.qq.com` only in a note (`:54`). See A3.
8. [polish] `estimatedMinutes: 15` (`:30`) is optimistic; "Ready when" bullet "this server's IP is trusted" is the only
   visible IP mention today.
   POSTURE (GJ:130-141): summary "Send and receive WeCom messages through a self-built application. Sending needs this
   computer's public IP on the app's trusted IP list. Receiving needs a public HTTPS address."; prerequisites ["A WeCom
   self-built application: its CorpID, AgentId and Secret.", "This computer's public IP on the app's trusted IP list.",
   "To receive: a public HTTPS address, and the Token and EncodingAESKey from the app's receive messages settings."];
   firstMessage "Check the test message arrived. To receive: in the app's receive messages settings enter this
   connection's webhook address with the same Token and EncodingAESKey, and save. Allow your WeCom userid, message the
   app, and check the reply."

Shared: A11, A15, C1 (`CE:2437`; inbound `resolveWecomCallbackSecrets`).

### Zalo OA (`defs/zalo.ts`)

1. [blocks] "Default OA user ID" is required and can't be found. Evidence `zalo.ts:69-76`, `validate()` `:205-207`, test
   fails without it (`PROBES:1341-1349`); no discovery route exists for Zalo. Change `whereToFind`: "Zalo doesn't show
   this ID in its apps. It is the user_id Zalo's Official Account API returns for someone who follows your Official
   Account or has messaged it. If you can't get it, this channel can't be finished." Replace `looksLike`
   "zalo-oa-user-id" with a neutral "A long number" only once verified. Keep `validate()` strict.
2. [blocks] No instructions for the access token, and nothing renews it. Field help `:53`. Add where-to-find: "Get an
   Official Account access token from your Zalo app's settings on developers.zalo.me." and, if N11 confirms short
   lifetimes, "This token expires. GoatCitadel doesn't renew it." (lifetime unverified; see Unverified)
3. [misleads] The test fails for ordinary recipient-eligibility reasons and a failure blocks Finalize
   (`PROBES:1364-1372`). Note (unverified rule): "Zalo lets an Official Account message only people who have interacted
   with it recently. Send your Official Account a message from the recipient's Zalo first."
4. [misleads] `openapi.zalo.me` isn't allowlisted, the test bypasses the allowlist, and sends then fail. See A3 and C7.
5. [misleads] Send endpoint `v2.0` (`PROBES:1355`, `CE:2975`) may be stale (unverified).
   Verified and fixed (Ruling R57): Zalo shut down the v2 message API (error -240). The send endpoint moved to
   `v3.0/oa/message/cs`.
6. [polish] Overview note jargon (`zalo.ts:39`) → "This channel only sends. It can't receive replies." Finish body
   "manual confirmation closes the loop" (`:95`) → "Check the test message arrived." `validate()` message "Default
   recipient ID is required." (`:206`) → "Default OA user ID is required." Step title: A16.
   POSTURE (GJ:172-180): summary "Send messages from a Zalo Official Account. Sends only: Zalo can't message
   GoatCitadel."; prerequisites ["A Zalo Official Account access token.", "The Zalo user_id of someone who follows your
   Official Account and has messaged it recently."]; firstMessage "Check the test message arrived in the recipient's
   Zalo."

Shared: A5 (`ZALO_`), A15, C1 (`CE:2959`).

---

## Part C — runtime

Each entry: write the failing test first, then fix.

### C1. Saved (pasted) secrets are sent as the literal keychain reference

- Status: fixed by PR 1 (#611). This entry describes the code before that fix.
- Claim: a secret typed into any wizard secret field is saved in the connection config as
  `keychain:goatcitadel:channel-connection:<connectionId>:<field>:<uuid>`. The setup test resolves it, so the test
  passes; every real send and every inbound signature check uses the reference text itself as the secret.
- Reach: wider than QQ/WeCom/Zalo. Every channel with a secret field, including Telegram (bot token set in Chat ›
  Messaging): outbound sends for all channels, and inbound secret checks for Slack, WhatsApp, LINE, Nextcloud, QQ,
  WeCom and Telegram's webhook secret. Teams/Google Chat/Discord webhook URLs are secret fields too, so their send URL
  becomes the reference. The Telegram, Discord, Matrix, Mattermost, Signal and ntfy receive streams are fine (they use
  the resolver).
- How sure: static read, high confidence; not executed. Telegram is the fastest real check, and it matters before the
  operator's live Telegram test: polling receives, but the reply goes through the broken path.
- Code path:
  - Write: `CSS:818-846` (`persistConnectionWithSecretReferences`) copies each secret to the keychain and stores the
    reference in `config[fieldKey]`.
  - Outbound: `CE:101, 116` reads the connection straight from storage; `CE:4828-4835` `secretFrom` returns the direct
    value as is. Callers include Telegram `CE:1395` (in `telegramSend`, `:1385`), Slack `:788`, Discord `:993`, LINE
    `:1341`, ntfy `:1699`, WhatsApp `:1983`, Mattermost `:2132`, Matrix `:2286` (`resolveMatrixClient`), QQ `:2386`,
    WeCom `:2437`, iMessage `:2677`, Nextcloud `:2836`, Zalo `:2959`, webhook URLs `:565, 756, 967, 1831, 1877`, Google
    Chat key `:1906`. No
    resolver exists in `packages/policy-engine` or `packages/storage` (`git grep keychain` finds none for channel refs).
  - Inbound: `apps/gateway/src/services/channel-secret-resolution.ts:94-104` `readConfigSecret` returns the direct value
    as is; used by `apps/gateway/src/routes/integration-webhooks-shared.ts:60-106` (Nextcloud, QQ, WeCom, WhatsApp
    secret and verify token, LINE), `integration-webhooks-slack-routes.ts:49` (signing secret) and
    `resolveTelegramWebhookSecret` (`channel-secret-resolution.ts:21-27`).
  - The only resolver: `apps/gateway/src/services/gateway-service.ts:12037-12057` (`resolveConnectionSecret`), used by
    probes and stream adapters. That is why the test passes.
- Failing tests:
  1. New `packages/policy-engine/src/tool-executor/comms-executor-secret-refs.test.ts` (pattern:
     `comms-executor-boundary.test.ts`): storage stub returns a `zalo` channel connection, enabled, connected, config
     `{ accessToken: "keychain:goatcitadel:channel-connection:conn-1:accessToken:00000000-0000-4000-8000-000000000000",
     defaultRecipientId: "123" }`; allowlist `["openapi.zalo.me"]`; stub `fetch` and record headers; call
     `executeCommsTool` for `channel.send` with runtime hook `resolveChannelConnectionSecret: () => "real-token"`.
     Assert the request's `access_token` header is `"real-token"` and no request carries a string starting `keychain:`.
     Add the same for `telegram` (token is in the URL path). Fails today: the header is the reference.
  2. New `apps/gateway/src/services/channel-secret-resolution.test.ts` or a case in
     `apps/gateway/src/routes/integrations.webhooks.test.ts`: a `nextcloud-talk` connection whose `token` is a connection
     keychain reference, secret store holding the real secret; send a webhook signed with the real secret; expect 200.
     Fails today (signature checked against the reference).
- Minimal fix:
  1. Outbound: add `resolveChannelConnectionSecret?: (secretRef: string) => string | undefined` to the comms runtime
     hooks (`CE:64-70`, and the executor hooks in `packages/policy-engine/src/tool-executor.ts:~160`), wired in
     `gateway-service.ts:~1474` next to `resolveApprovalActionTokenSecret`, using `parseChannelSecretRef` +
     `secretStore.getSecret` exactly as `resolveConnectionSecret` does. In `executeCommsToolWithBoundaryTracking`, before
     `executeCommsProviderTool` (`CE:157`), replace each config string that starts with
     `keychain:goatcitadel:channel-connection:<this connectionId>:` with its resolved value, in memory only (same binding
     rule as `collectConnectionSecretRefs`, `integration-channel-service.ts:577-593`). A reference that can't be resolved
     fails the send with "The saved <channel> credential is unavailable from secure storage."
  2. Inbound: give `readConfigSecret` an optional resolver argument and pass `gateway.resolveConnectionSecret`-backed
     resolution from the webhook route deps (the route composition already has it,
     `gateway-route-composition-integrations.ts:88-89`).
- Notes: A5 (make the pasted secret primary) must not ship before this. `secretFrom`'s env path reads any variable name
  without the guard; leave it, or align it with C6.

### C2. Google Chat can't be finalized

- Claim: (a) webhook mode fails to finalize unless the optional thread key is set; (b) Chat app mode can never finalize.
- How sure: static read. (b)'s warning is pinned by `integration-diagnostics-service.live-checks.test.ts:301`.
- Code path: (a) `IDS:284-290`: webhook mode adds `requireText("target", "Default Google Chat thread key", …, "warn")`;
  `resolveChannelConfigTarget` returns nothing for an empty space/thread key
  (`apps/gateway/src/services/channel-config.ts:6, 19-36`); `ELIG:61-70` defers a missing target only for
  matrix/qqbot/wecom; `ELIG:81-82` makes it blocking. (b) `IDS:741-751` returns a single `warn`
  `google_chat_app_live_send` with no probe step, so `ELIG:71-75` can't treat it as advisory and `ELIG:81-82` blocks;
  also the app-mode `target` warn for an empty `defaultSpace` (`IDS:276-280`) blocks.
- Failing tests (`apps/gateway/src/services/channel-setup-eligibility.test.ts`):
  (a) connection `{ key: "google-chat", config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/x/messages?key=k" } }`,
  result with issue `{ key: "target", level: "warn" }` and no probe: expect `allowed: true` and the issue `deferred`.
  Better, also in `integration-diagnostics-service.contract.test.ts`: webhook-mode checks contain no `target` warn.
  (b) only after N3: app-mode result with issue `{ key: "google_chat_app_live_send", level: "warn" }` → expect `allowed`
  with that issue `advisory`.
- Minimal fix: (a) drop the thread-key `requireText` in webhook mode (`IDS:285-290`); an incoming webhook is bound to its
  space and the thread key is optional. Do not add `"google-chat": "defaultThreadKey"` to `OPTIONAL_DEFAULT_TARGET_KEYS`
  as group A suggested: that check looks at one key and would also hide app mode's missing `defaultSpace`. (b) per N3:
  either add `google_chat_app_live_send` to the advisory set (and defer an empty `defaultSpace` in app mode), or hide
  Chat app mode in the wizard and say "use the manual form".

### C3. The webhook address needs a connection id that only exists after Finalize

- Claim: every webhook channel's address contains the connection id, which is minted only when the Finalize Change Plan
  is applied. For Nextcloud Talk this is a dead end: the test needs the bot installed, and a Talk bot's address is fixed at
  install. Google Chat's endpoint-URL audience has the same problem.
- How sure: static read, certain for the id. Nextcloud's "address can't be changed" is from the occ docs (auditor read).
- Code path: `CSS:142` (draft id = `randomUUID()`), `CSS:464` (`connectionId: readyDraft.connectionId ?? randomUUID()`);
  finalize runs only when the `channel_connection` plan applies
  (`settings/sections/use-channel-draft-actions.ts:225-250`); Nextcloud probe `nextcloud-talk-live-probes.ts:24-27`.
- Failing test (`apps/gateway/src/services/channel-setup-service.contract.test.ts`): create a `create` draft for
  `channel.nextcloud-talk`, read the id the wizard would show (for example `draft.draftId`), finalize it with the
  existing contract-test host, and assert the new connection's `connectionId` equals that id. Fails today (random).
- Minimal fix (N4 picks): use `readyDraft.connectionId ?? readyDraft.draftId` at `CSS:464`, so the id is known from draft
  creation with no schema change; then A2 shows the address before Finalize ("works once you finish"). Check nothing
  treats a draft id and a connection id as distinct namespaces (keychain refs use different prefixes,
  `channel-secret-custody-service.ts:6-7`). The alternative (a new reserved-id column) needs a PG migration on both
  lineages.

### C4. WhatsApp's live test sends plain text

- Claim: the test sends a free-form text message, which Meta delivers only inside the 24-hour window after the recipient
  messaged the business. A first-time recipient gets nothing, and the test may still report success.
- How sure: code certain (`PROBES:920-936`, `type: "text"`); Meta rule from Meta's docs (auditor verified the window
  rule); whether Graph rejects synchronously or returns 200 and fails later is unverified.
- Failing test (only if N2 picks the template): in `apps/gateway/src/services/channel-bot-live-probes.test.ts`, capture
  the sandbox-send body and assert `type === "template"` and `template.name === "hello_world"` with
  `language.code === "en_US"`. Fails today.
- Minimal fix: per N2, either send Meta's `hello_world` template (availability on production numbers unverified), or
  keep text and ship only the Part B copy (WhatsApp 1).

### C5. Env-var-name fields accept a pasted secret and store it in plain config

- Claim: every `*Env` field is a plain text field; a token pasted there passes validation and is saved as plain config
  JSON (not the keychain), and is never resolved.
- How sure: static read.
- Code path: Discord `defs/discord.ts:142-162` (field), `:392` (normalize keeps it), `:412-470` (no shape check); same
  shape in every guide with an `*Env` field. Only Google Chat checks the name (`defs/google-chat.ts:313-318`).
- Failing test (`apps/gateway/src/services/channel-setup-definitions.test.ts`): for every definition, for every field
  whose key ends in `Env`, run `validate()` with that field set to a token-shaped value (for Discord
  `"MTA0NjY3ODkwMTIzNDU2Nzg5MA.Gx1234.abcdefghijklmnopqrstuvwx"`) and expect an error issue with that `fieldKey` and
  `failureCategory: "malformed_value"`. Fails today for all but Google Chat.
- Minimal fix: one shared check in `withGuidedJourney.validate` (GJ:368-382): a non-empty `*Env` value must match
  `^[A-Z][A-Z0-9_]{2,127}$` and pass `isPermittedIntegrationSecretEnvVarName(value, catalogId)`
  (`gateway/integration-secret-envvar-guard.ts:54`). Message: "That looks like a token, not a variable name. Paste it
  into <secret field label> instead. Variable names start with <PREFIX>_." Check existing saved connections with
  lower-case names before shipping (they would fail on their next edit).

### C6. A wrongly named variable gives a "passing" test with no live proof

- Claim: the structural check passes if any variable with that name is set, but the probe resolver refuses names
  without the channel prefix; the live check then returns no checks at all, and Finalize is allowed with zero proof.
- How sure: static read.
- Code path: `IDS:107-117` `requireSecretRef` tests `process.env[name]` only; probes resolve through the guard
  (`gateway-service.ts:12058-12075`) and return `{ checks: [] }` when the secret is missing: WhatsApp `IDS:710-715`,
  Mattermost `:770-773`, iMessage `:800-805`, LINE `:826-832`. `ELIG` then finds no warn/fail.
- Failing test (`apps/gateway/src/services/integration-diagnostics-service.contract.test.ts`): Mattermost connection with
  `botTokenEnv: "MY_TOKEN"` and `process.env.MY_TOKEN` set; expect the `auth` check `fail` with a message naming
  `MATTERMOST_`. Fails today (pass).
- Minimal fix: `requireSecretRef` resolves through `deps.resolveConnectionSecret(config, directKey, envKey,
  connection.catalogId)`; when the variable exists but is refused, fail with "The variable name must start with
  <PREFIX>_. Rename it and restart GoatCitadel." C5 stops most cases at validate.

### C7. The test doesn't check fixed provider hosts, so it passes while real sends are blocked

- Claim: for Slack, WhatsApp, LINE and Zalo the setup test reaches the provider through a fetcher that allows any
  public host, while real sends use the operator allowlist, which by default lacks those hosts.
- How sure: static read; depends on the operator's real allowlist (unverified).
- Code path: test fetcher `gateway-service.ts:12019-12024` (`[...operatorAllowlist, "*"]`); real send `CE:4741`; no
  structural host check for these channels (`IDS:198-216` Slack, `:295-310` WhatsApp, `:384-391` LINE/Zalo). Precedent:
  Telegram warns when `api.telegram.org` isn't allowed (`IDS:236-246`).
- Failing test (`integration-diagnostics-service.contract.test.ts`): config allowlist `["discord.com"]`, a `zalo`
  connection; expect a `url` check with status `warn` naming `openapi.zalo.me`. Repeat for slack (`slack.com`, bot-token
  mode), whatsapp (`graph.facebook.com`), line (`api.line.me`). Fails today (no such check).
- Minimal fix: add Telegram-style checks driven by `CHANNEL_REQUIRED_HOSTS` (A3 step 1) for every channel with fixed
  hosts. A3's "Allow these hosts" button is what clears the warning.

### C8. iMessage: an unsend failure other than 403/5xx blocks Finalize (gated: Signal/iMessage decision)

- Claim: the test sends and unsends; a 4xx from unsend (other than 403) is a hard `fail`.
- How sure: code certain (`PROBES:1208-1216`); what BlueBubbles returns without the Private API is unverified.
- Failing test (`apps/gateway/src/services/channel-bot-live-probes.test.ts`): BlueBubbles stub returns 2xx for send and
  400 for unsend; expect the `imessage_sandbox_cleanup` step `warn` (so the existing acknowledge path applies via
  `channel-probe-result.ts:8`). Fails today (`fail`).
- Minimal fix: map every non-2xx unsend to `warn` with the message "The test message was sent but couldn't be unsent
  (unsend needs BlueBubbles' Private API). Remove it by hand and acknowledge."

---

## Needs the operator

- N1. Signal (signal-cli) and iMessage (BlueBubbles): both are unofficial clients. Options: keep, with the Part B fixes and
  a visible "community-made client, use a dedicated number" label; hide from the picker and Settings create list but keep
  existing connections working; retire. All Signal and iMessage entries in Part B and C8 wait on this.
- N2. WhatsApp test message (C4): send Meta's `hello_world` template (arrives without the 24-hour window, but its
  availability on production numbers is unverified); keep plain text and tell the person to message the business first;
  or make the test send optional for WhatsApp (auth probe only, delivery checked by hand).
- N3. Google Chat Chat-app mode (C2b): let it finish without a live check (advisory warning, "message the app after you
  finish"); or hide Chat app mode in the wizard until a real probe exists.
- N4. Connection id before Finalize (C3): reuse the draft id as the connection id (no schema change); add a reserved-id
  column (migration); or no runtime change and two-phase copy only (Nextcloud reinstall, Google Chat project-number
  audience).
- N5. Show the sender id in the diagnostic message (A6): yes, so guides can say where to find it; or no, and guides say
  plainly that QQ/WeCom/Google Chat/Signal ids can't be found in GoatCitadel.
- N6. Every edit needs a new live test that posts a visible message, even "add my id to allowed senders" (QQ/WeCom send
  to the default target again). Options: allow sender-list-only edits to reuse the last passing proof; keep as is.
- N7. Slack OAuth in Settings: keep the Connect Slack button as an advanced option that names the four Gateway settings;
  or hide it until plan 3 (Socket Mode Chat page).
- N8. Plain `http://` to a LAN server (Signal bridge, BlueBubbles, Mattermost, Matrix, Nextcloud, ntfy at 192.168.x.x):
  keep "https or this computer only" and say so (A10); or add an explicit, audited per-connection opt-in.
- N9. ntfy receiving on public ntfy.sh: warn only (Part B ntfy 3); or refuse receiving when the base URL is ntfy.sh.
- N10. Default to "chat with my bot": Discord guild policy default (server channel today) vs direct messages only;
  Matrix and Mattermost "Receive messages" default off vs on (sender allowlist still default-deny).
- N11. Zalo (and LINE short-lived tokens): if Zalo OA tokens expire within about a day and GoatCitadel can't refresh
  them, keep Zalo in the picker with a warning, or hide it until refresh exists. Needs the lifetime verified first.

---

## Unverified

Do not state these as fact in copy or plans until checked.

- C1 and every other "blocks" in this ledger come from reading code, not running it. C1 is the one to run first.
- Network: whether the operator's live allowlist already contains the provider hosts; whether files.slack.com,
  lookaside.fbsbx.com (WhatsApp media) and www.googleapis.com (Google Chat token certs) fetches are allowlist-gated.
- Slack: whether `http://localhost` is accepted as an OAuth redirect URL; how a user copies their member ID.
- Teams: which Workflows template defaults to "Anyone"; sovereign-cloud (US Gov, China) Workflows hostnames, which
  `classifyTeamsWebhookUrl` (`defs/teams.ts:223-235`) would reject.
- Discord: whether a DM to a bot works without sharing a server (group A's proposed sentence; don't ship it).
- Google Chat: whether Chat apps work for personal accounts; space id format in the web address; Windows `setx`
  truncating at 1024 characters.
- WhatsApp: synchronous rejection vs later `failed` status for out-of-window text; test-number recipient limits; App
  secret location ("App settings › Basic" is from the repo doc only); exact temporary-token lifetime; `hello_world`
  availability; effect of stripping `+` (`PROBES:1607`).
- Signal: whether a single-account daemon needs the `account` param; signal-cli's replay behaviour (man page says it keeps
  the last 1000 events for `Last-Event-ID`); any ban risk.
- iMessage: BlueBubbles' unsend and chat-creation responses without the Private API; whether the Mac must stay awake.
- LINE: whether push needs the user to have added the Official Account as a friend; whether the console still issues
  long-lived tokens; where the channel secret is shown; how to get group and room ids.
- Matrix: where clients show the access token and internal room ID; whether MAS homeservers allow password login;
  whether default direct messages are encrypted; delegation (API URL vs server name).
- Mattermost: a "Copy user ID" profile action (GJ:100 claims it); WebSocket auth and `posted` payload details.
- Nextcloud: room token location (`…/call/<token>`); whether Nextcloud accepts private-network webhook addresses; exact
  `occ talk:bot:install` flag syntax.
- ntfy: how an ntfy.sh account user creates an access token.
- QQ: sandbox rules and host, IP whitelist, active-message quotas, console menu names; whether `bots.qq.com` still issues
  tokens now that QQ documents `api.bot.qq.com` (`qqbot-live-probes.ts:14-17`).
- WeCom: where the trusted-IP list lives in the current console; callback port limits; the member detail label for a
  userid.
- Zalo: token lifetime and refresh; current send endpoint version (`v2.0`); recipient eligibility rules; how to get a
  user_id.

---

## Dropped or corrected findings

- Dropped: group D SH-8's second half ("drop 'activation plan' wording; the flow has no plan step"). Wrong: Settings
  Finalize creates a Change Plan reviewed in Chat (`settings/sections/use-channel-draft-actions.ts:225-250`; Cockpit's
  button is "Prepare finalization plan", Cockpit :212). Only the `CSS:375` half is kept (A14).
- Narrowed: group D "Finalize reason is only a tooltip". True for the Classic wizard only; Cockpit (the default) prints it
  (Cockpit :219-221). Kept as A17, Classic only.
- Corrected: group B S4's assumption that pasted secrets "must work for Telegram already". They don't on the send path;
  see C1, which also reaches Telegram.
- Corrected: group A's Google Chat fix (add `"google-chat": "defaultThreadKey"` to `OPTIONAL_DEFAULT_TARGET_KEYS`)
  replaced by dropping the webhook-mode thread-key check (C2), because the eligibility exemption reads one config key and
  would also hide Chat app mode's missing `defaultSpace`.
- Corrected line numbers: `ChannelsSection.tsx:325-326` → `:377-382`; `gateway-service.ts:12001-12030` → `:12000-12025`;
  group A's "ChannelDraftEditor.tsx last lines" → Cockpit :215-217. All other cited lines matched or were tightened.
