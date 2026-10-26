# Messaging in Chat and channel quick setup

Date: 2026-10-25
Status: draft, builder-checked, awaiting operator approval
Surface: Mission Control cockpit (`apps/mission-control-next/src/cockpit`) and the gateway channel runtime (`apps/gateway`)

## Why

The operator uses Hermes Agent alongside GoatCitadel and likes two things about it: a Messaging section where every channel is one click away, and a "Create with QR" quick setup for Telegram. GoatCitadel's channel setup, by contrast, "is just messy and even though it should have wizards, it still puts too much of the work on the user". The goal is for GoatCitadel to take a bigger hand in getting channels connected, and to make channel conversations easy to reach day to day.

The everyday moment this serves: the operator is out, talking to GoatCitadel through Telegram. When they get home, they want that Telegram conversation on the same page as their chats, so they can read it and then open a local chat if they need one. It is a quality-of-life change, not a cross-device hand-off of a single thread.

### What Hermes actually does (reference, not a template)

Recon of Hermes Agent (github.com/nousresearch/hermes-agent, 2026-10-22):

- The Telegram "Create with QR" flow uses Telegram's official managed-bots feature (`t.me/newbot/<manager>/<username>?name=`, `managed_bot` update, `getManagedBotToken`), but through a Nous-hosted pairing service that owns the manager bot and relays each new bot's token. It is not a local mechanism.
- Telegram is the only quick setup in the Hermes desktop app. Discord token checks with invite links, the Slack manifest generator and the Chinese vendors' QR app creation exist only in the Hermes CLI. WhatsApp QR pairing uses the unofficial Baileys client.
- Hermes's Messaging page is mostly a clean channel list with status pills, built from a per-platform declaration of required and recommended fields.

## Goals

1. Channel conversations sit in Chat, next to local chats, and can be read and answered there.
2. Adding a channel starts from one picker that shows every channel, grouped, with an honest estimate of the effort and anything extra it needs.
3. Each channel's setup is one page whose steps check themselves; the operator types as little as possible (for Telegram, one key) and never hunts for IDs.
4. Telegram, Discord and Slack receive messages without a public web address.
5. Turning a channel on happens on that page in one click; the approval still happens and is still recorded.
6. The catalog and setup copy only claim what works.

## Non-goals

- Any hosted or self-hosted GoatCitadel setup service. This rules out managed-bot Telegram creation and a shared GoatCitadel Slack app. (Operator: "that takes the project out of scope".)
- Moving one conversation between devices as a hand-off. Channel conversations stay their own conversations; Chat just shows them.
- Converting every channel to the new setup pattern in this project (see "First four channels").
- A tunnel or public-address helper. (My call; see "Calls I made".)
- The Classic shell. It is retiring (`DESIGN.md`).

## Anti-goals (failure even if it technically works)

- Anything that can get the operator's account or number banned: unofficial clients, reverse-engineered APIs, terms-of-service-violating automation. Official provider APIs only. (Operator: "we're not going to do anything that can get us banned".)
- Setup that still ends with the operator copying IDs out of developer modes or editing environment variables for the first four channels.
- An approval that silently disappears. The in-place "Turn on" must leave the same record an approval from Chat leaves today.
- Copy that promises a sign-in button, inbound support or automation that does not exist.
- Raw IDs, JSON or API paths on primary screens (`DESIGN.md`, "Values are presented, never dumped").

## Decided with the operator

These were agreed from mockups during brainstorming.

### 1. Where Messaging lives: a section inside Chat

Messaging is a section in the Chat sidebar, below the operator's chats. No new rail area. The operator chose this so they can move quickly between a channel conversation and a local chat.

- Each connected channel connection appears as a channel row (name, and a status label from the shared status vocabulary, for example "On", "Needs you", "Couldn't deliver").
- Under each channel row, one row per conversation: each person or group that talks to the bot ("You", "Family group", "#general"), with last activity and a new-message count.
- A "+ Add" control on the Messaging heading opens the channel picker.
- Settings › Connections › Channels stops being a second home for channels and points to Messaging.

### 2. The conversation view

Opening a conversation row shows its transcript in the main Chat pane:

- Messages labelled with their source ("You · via Telegram · 4:12 pm").
- A "N new since you were last here" marker.
- "Continue in a new chat" in the header: starts a local chat with this conversation attached as context, so the operator does not re-explain.
- A composer labelled "Reply in Telegram" (or the channel's name). What it does depends on the conversation (decided after review):
  - **The operator's own conversation ("You").** Typing here is a turn with GoatCitadel in that conversation: GoatCitadel answers, and its answer is also delivered to the channel, so the operator's phone holds the whole thread. The desk message is labelled as sent from the desk, distinct from messages that arrived through the channel. Today a session bound to a channel never starts an AI turn when the operator types in it: `chat-turn-entry-service.ts` routes it to `sendPreparedIntegrationChatTurn`, which posts the text verbatim. This needs a new path through durable execution and channel reply delivery.
  - **Group conversations and other people's conversations ("Family group").** The bot posts the operator's words into the conversation as-is, which is today's behaviour, and the composer says plainly where they go ("Posts to Family group as @MyGoatBot").

### 3. The channel page

Clicking the channel row itself (for example "Telegram") opens that channel's page:

- Whether it is working: status, bot name, last message, checked just now, with a check-now action.
- Who can message it: the allowed list, and pending requests from people who messaged the bot, with Approve and Deny.
- Where it posts: its default conversations or channels.
- Change the key, Turn off, Remove (Remove is a danger action per `DESIGN.md`).
- Remove disconnects the bot and deletes its keys, but keeps the channel's conversations readable under Messaging, marked as removed, until the operator deletes them separately (decided after review). Its confirmation says exactly that.
- Advanced settings that the current wizard exposes remain reachable from here.

The operator saw the conversation view and the channel page as the same screen in two states and accepted both.

### 4. The channel picker

"+ Add" opens a picker showing every channel, grouped, which the operator specifically liked:

- Quickest: Telegram, Discord, ntfy, Slack.
- Team and self-hosted chat: Mattermost, Matrix, Teams ("Sends only"), Google Chat.
- Phone apps: Signal, WhatsApp, LINE, and the rest (iMessage via BlueBubbles, WeCom, QQ, Zalo, Nextcloud Talk).

Each tile gives a rough time ("About 3 min") and says plainly when the channel needs something extra ("Needs a public web address", "Business account + public web address", "Needs signal-cli"). Clicking a tile opens that channel's setup page.

### 5. The setup page pattern

Every channel's setup is one page of numbered steps. Each step checks itself and shows the result in words before the next one unlocks. The steps replace the separate Save, Validate and Test buttons of today's wizard; their checks are the proof that turning on needs.

Telegram, as agreed:

1. **Make your bot.** A QR code (generated locally, linking to `https://t.me/BotFather`) opens BotFather on the operator's phone; the text says to send /newbot and pick a name.
2. **Paste the key BotFather sent you.** GoatCitadel checks it immediately and shows the bot's name ("Key works. Your bot is @MyGoatBot.").
3. **Say hi to your bot.** A second QR code and link open the new bot. GoatCitadel watches for the first message, shows who sent it, and puts that person on the allowed list. No user-ID lookup. (Refined after review, my call: the page shows a one-time code and the link carries it, so tapping Start in Telegram sends it; see "Calls I made".)
4. **Turn it on.** No public web address needed. Turning it on is recorded in Activity.

The operator confirmed every channel follows this same pattern.

### 6. Turning on counts as the approval

Today, Finalize creates a `channel_connection` Change Plan, hands off to Chat (`/chat?channelPlan=…`, `packages/mission-control-shared/src/api/channel-plan-handoff.ts`), the operator approves there, returns to Settings and continues. The operator agreed that the "Turn on" click on the setup page is the approval: one click, on the page, recorded in Activity. The Change Plan still exists and is still approved by the operator; only where and how it is approved changes.

### 7. First four channels

The operator will use Discord, Slack, Telegram and WhatsApp, so those four get the new setup pages first. All other channels appear in the picker and open their existing guided setup until they are converted.

### 8. Local only, official APIs only

Everything runs on the operator's machine. No Nous-style hosted relay. WhatsApp uses the official WhatsApp Business Cloud API only.

## The first four channels in detail

Each section says what the operator still does by hand, what GoatCitadel does, and what is new in the runtime. Provider API names are given so the builder can confirm them; anything marked "confirm" was not verified during design.

### Telegram

- By hand: create the bot in BotFather, paste one key, send the bot a message.
- GoatCitadel: checks the key (`getMe`), shows the bot's name, detects the first sender and allowlists them, and receives messages by long polling (`getUpdates`).
- New in the runtime: a polling receive mode for Telegram. Today Telegram inbound is a signed webhook only and needs a public HTTPS address (`apps/gateway/src/services/channel-setup-definitions/telegram.ts`); `getUpdates` is used only for chat discovery (`channel-setup-telegram-discovery.ts`, `telegram-target-discovery.ts`). Polling becomes the default; the webhook mode stays as an advanced option.
- Telegram refuses `getUpdates` while a webhook is set (409, already handled as `conflict` in the discovery code). If the bot already has a webhook, the page says the bot looks connected somewhere else and asks before clearing it (`deleteWebhook`).
- Adding the bot to groups and choosing where it posts reuse the existing chat discovery and Telegram pairing (`integrations-telegram-routes.ts`).

### Discord

- By hand: create an application and bot in the Discord developer portal, reset and copy the token, switch on Message Content Intent, open the invite link, send the bot a message.
- GoatCitadel: checks the token (`GET /users/@me`, `GET /applications/@me`), shows the bot's name, reads the application flags to tell whether Message Content Intent is on and, if not, says exactly where to switch it on and re-checks; builds the invite link with the `bot` and `applications.commands` scopes and the View Channel, Send Messages and Read Message History permissions; detects the server the bot joined and lists its channels to pick from, instead of Developer Mode ID copying; detects the first person who messages the bot and allowlists them, suggesting the application owner.
- Runtime: Discord already defaults to gateway mode, so no public address is needed (`channel-setup-definitions/discord.ts`). Discord pairing already exists (`integrations-control-routes.ts`, `discord-pairing-helpers.ts`).

### Slack

- By hand: click "Create Slack app" (a pre-filled link), pick a workspace, install the app, create an app-level token, paste two tokens, send the bot a message.
- GoatCitadel: generates the app manifest (bot name, scopes, events for direct messages and mentions, Socket Mode on) and opens Slack's create-from-manifest link (`https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded>`, documented by Slack); checks the bot token (`auth.test`) and shows the workspace and bot name; checks the app-level token can open a Socket Mode connection; lists channels to choose from instead of typed `#channel` names; detects the first person who messages the bot and allowlists them.
- New in the runtime: Slack Socket Mode receive. Today Slack inbound is a signed Events API webhook that needs a public address. Socket Mode becomes the default for apps made this way.
- The existing self-owned OAuth path (`slack-oauth-service.ts`, `integrations-slack-oauth-routes.ts`) stays as an advanced option. Its "hosted" mode still needs the client secret locally, so it is not a hosted app, and the wizard copy that says "approve the hosted GoatCitadel Slack app" (`channel-setup-definitions/slack.ts`) must change.

### WhatsApp (official Cloud API)

WhatsApp cannot avoid a public web address: Meta delivers incoming messages only to an HTTPS webhook. The picker says so up front.

- By hand: create a Meta developer app with the WhatsApp product and a phone number (Meta's test number is fine), make a long-lived access token, paste the token, phone number ID, app ID and app secret, have a public HTTPS address for GoatCitadel, send the business number a message.
- GoatCitadel: checks the token against the phone number (`GET /{phone-number-id}`) and shows the display number and verified name; generates the webhook verify token itself; shows its webhook address with copy buttons; registers the webhook itself where Meta's API allows (app subscriptions with the `messages` field, and subscribing the app to the business account: confirm), otherwise shows "Meta checked your address just now" when Meta's verification request arrives; detects the first sender and allowlists them.
- Replies: WhatsApp only allows free-form replies within 24 hours of the person's last message. The "Reply in WhatsApp" composer must say when that window is closed instead of failing silently.
- New setting: GoatCitadel has no "public web address" setting today. WhatsApp setup needs one place to record it, and the other webhook channels should read the same setting.

## Constraints

- Repository invariants (`AGENTS.md`): deny-wins policy, approval requirements, path jails and runtime authority are not weakened. The in-place approval goes through the same approval path and leaves the same record; it is a different place to approve, not a skipped approval.
- Plans that a model proposes, or that originate from Chat content, keep their normal review. Only the operator's own click on the setup page approves in place (consistent with the operator's standing preference that friction on their own deliberate settings is a bug, while floors that guard against models and untrusted content stay).
- Mission Control is an API client: new state (last-read markers, receive modes, the public address) is owned by the gateway, not written by the UI to runtime files.
- `DESIGN.md`: sentence case, the shared status vocabulary, names before IDs, danger styling only for irreversible actions, both themes, phone width (the Chat sidebar becomes a drawer below 640px and Messaging goes with it).
- Cockpit guards: copy glossary (`scripts/check-mission-control-next-cockpit-copy.mjs`), live-region budget, no arbitrary Tailwind values, settings-reading queries registered in `SETTINGS_READER_KEYS`.
- Architecture metrics gate: new services and new reads of classified dependencies are counted; a new service may need an operator-approved allowance. Prefer existing owners with headroom.
- Storage: any new table needs migrations for both SQLite and Postgres, and for both fresh and upgraded Postgres installs.
- Secrets: keys go through the existing channel secret custody (`channel-secret-custody-service.ts`, OS keychain). Installs without a keychain (Docker, headless) keep the environment-variable alternative, tucked under Advanced.
- Network allowlist: the example config already allows `api.telegram.org`, `discord.com` and `hooks.slack.com`. Slack's API and Socket Mode hosts, Discord's gateway host and `graph.facebook.com` need checking; turning a channel on should add any missing provider host as part of the same approval rather than send the operator elsewhere.
- Official provider APIs only.

## Current state the builder starts from

- Cockpit channel UI: `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx` (dropdown, form, drafts list), wizard parts in `src/features/native-routes/settings/channel-setup/` and `sections/use-channel-*.ts`.
- Cockpit Chat: `src/cockpit/areas/chat/` (`ThreadList.tsx`, `ConversationListPanel.tsx`, `ChatTranscript.tsx`). Chat has no awareness of channel conversations today.
- Channel conversations are saved as sessions carrying `channel`, `account` and peer details (`packages/contracts/src/session.ts`), routed by `resolveSessionRoute` from `inbound-channel-event-service.ts`.
- Guided setup definitions: `apps/gateway/src/services/channel-setup-definitions/*`, routes in `apps/gateway/src/routes/integrations-channel-setup-routes.ts`. Activation needs the evolution control plane (`evolutionControlPlaneV1Enabled`, default on).
- Live probes: `channel-bot-live-probes.ts`. Stream receive adapters (ntfy, Mattermost, Matrix, Signal): `channel-stream-runtime-registry.ts`.
- Catalog: `apps/gateway/src/services/integration-catalog.ts`.
- Background docs: `docs/CHANNEL_GUIDED_SETUP.md`, `docs/CHANNEL_GUIDED_SETUP_IMPLEMENTATION.md`, `docs/CHANNEL_SETUP_CONNECTION_REVIEWS.md`, `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`.

### Truth fixes that ride along

- The catalog lists "oauth" sign-in for Discord, WhatsApp, Google Chat and Teams and "device-link" for Signal; none exists. Correct the claims.
- The catalog omits "inbound" for Slack, Telegram, WhatsApp and LINE although they receive messages. Correct the flags.
- `docs/CHANNEL_GUIDED_SETUP.md` says Signal cannot receive, but a Signal stream adapter is registered. Correct the doc.

## Calls I made (operator to check)

- No tunnel or public-address helper in this project; WhatsApp setup tells the operator they need a public address and records it.
- Polling is Telegram's default receive mode and Socket Mode is Slack's; their webhook modes remain as advanced options.
- Proving the first sender is the operator: display names can be faked and allowlisted senders can drive the agent, so the "say hi" step uses a one-time code shown on the setup page, not a name. Telegram's link carries it (`https://t.me/<bot>?start=<code>`, so tapping Start sends it); WhatsApp's link pre-fills it (`https://wa.me/<number>?text=<code>`); for Discord and Slack the operator sends the code to the bot. Only the sender of the right code is allowlisted. Later requests from other people keep the existing code-based pairing (`telegram-channel-pairing.ts`, Discord pairing), extended to Slack and WhatsApp.
- Listening during setup: to see the code, the setup page runs a read-only listener before "Turn on". It looks only for the code, runs no agent turns, keeps the bot silent, and stops after 10 minutes, at "Turn on", or when the operator leaves the page. It is a setup check, like today's Telegram chat discovery, not an activation. For Telegram it reads updates without acknowledging them, so nothing is consumed before polling starts.
- "Turn on" is a real approval, always available: the setup page approves the channel's Change Plan in place through the normal approval path, leaving the same record as an approval from Chat. It is not tied to the "apply my Settings changes without an Inbox approval" opt-in, and works on every install profile because it is an explicit operator approval, not a skipped one. The step lists what turning on will change (who can message the bot, where it posts, any provider host added to the network allowlist) next to the button. The Chat hand-off (`/chat?channelPlan=…`) stays only for channel plans that were not started from the setup page.
- Which conversations appear under Messaging: channel conversations, meaning the external sessions bound to a channel connection. A local chat that the operator has bound to a channel stays under Chats.
- Channels other than the first four open their existing guided setup from the picker until they are converted.
- Suggested delivery order (the builder may change it): Messaging section, conversation view and channel page on existing connections; then the picker, the setup page frame, Telegram polling and in-place turn on; then Discord and Slack Socket Mode; then WhatsApp with the public-address setting; the truth fixes can land early.

## Left to the builder

- Where last-read markers live and how new-message counts are computed (gateway-owned).
- How many conversation rows show per channel before a "show more".
- How "Continue in a new chat" attaches the conversation (reference, summary or transcript).
- Whether Telegram polling and Slack Socket Mode run inside the existing stream runtime registry or alongside it.
- Exact Slack manifest scopes and events, Discord permission bits, and polling intervals.
- Whether Settings › Connections › Channels redirects to Messaging or shows a short pointer.

## Success looks like

- Telegram connected in about three minutes from "+ Add", typing one key, without leaving the page.
- Discord and Slack connected in about five minutes each, with no ID copying and no environment variables.
- WhatsApp connected with the provider steps stated honestly up front and no guesswork about the webhook.
- After a day out on Telegram, the operator opens Chat and the conversation is there under Messaging, with the new messages marked.
