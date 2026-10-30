# Communication Channel Setup Guide

Last updated: 2026-10-29
Target audience: beginner to intermediate operators

This guide walks through GoatCitadel channel setup in the order that makes the most sense for operator-facing `1.0` validation.

For parity status and tranche tracking, see [OPENCLAW_PARITY_STATUS.md](./OPENCLAW_PARITY_STATUS.md).

Guided Mission Control setup is currently available for `channel.discord`, `channel.slack`, `channel.telegram`, `channel.google-chat`, `channel.teams`, `channel.whatsapp`, `channel.mattermost`, `channel.matrix`, `channel.qqbot`, `channel.wecom`, `channel.nextcloud-talk`, `channel.line`, and `channel.zalo`.

Discord, Slack, Telegram, Google Chat, Teams, Mattermost, Matrix, QQBot, WeCom, WhatsApp, LINE, and Zalo OA guided test/retest flows now run live probe coverage before finalize. WhatsApp and Zalo OA still rely on operator-controlled test targets for pre-finalize send checks.

## Guided Channel Setup At A Glance

| Channel | Recommended auth path | Guided test behavior | Manual confirmation still needed |
|---|---|---|---|
| `channel.discord` | Bot token | token, channel, test message and delete, runtime readiness in gateway mode | yes |
| `channel.slack` | Bot User OAuth token | auth plus test message and delete on bot-token path | yes, especially on webhook fallback |
| `channel.telegram` | BotFather token | auth plus test message and delete | yes |
| `channel.google-chat` | Incoming webhook, or Chat app service-account key | test message through the webhook (webhook mode); Google-signed JWT webhook inbound plus API send/reply/unsend in Chat app mode | yes |
| `channel.teams` | Incoming webhook | test card through the webhook | yes |
| `channel.mattermost` | Bot token | auth, channel resolution, test post and delete; opt-in bot WebSocket inbound (`inboundStreamEnabled`) | yes |
| `channel.matrix` | Bot access token | whoami auth, joined-room check, test notice (an `m.notice`); opt-in `/sync` inbound (`inboundStreamEnabled`) | yes |
| `channel.qqbot` | AppID + AppSecret | token mint, bot identity (`/users/@me`), optional active test message; ed25519-signed webhook inbound | yes |
| `channel.wecom` | CorpID + AgentId + application Secret | `gettoken`, application lookup, callback-credential check, test message; encrypted callback inbound when the Token and EncodingAESKey are set | yes |
| `channel.whatsapp` | Cloud API access token + phone-number id (the Chat page also takes the Business Account ID, App ID and App secret) | sender auth plus test message; signed inbound webhook runtime when app secret + verify token are configured; the Chat page checks the five values with Meta (read-only) | yes |
| `channel.nextcloud-talk` | Base URL + Talk token | structural and semantic validation | yes |
| `channel.line` | Channel access token | token auth plus test push message; signed inbound webhook runtime when channel secret is configured | yes |
| `channel.zalo` | Official Account access token | test message through the OA send path | yes |

Zalo Personal (`channel.zalouser`) was removed on 2026-10-26. It sent through an unofficial personal-account client (a zca bridge), and that kind of client can get the account banned. A saved Zalo Personal connection stays listed so you can delete it, but it cannot send. Zalo OA is the supported Zalo channel.

Signal (`channel.signal`) and iMessage (`channel.imessage`) were removed on 2026-10-28. Signal sent through signal-cli and iMessage sent through BlueBubbles. Both are unofficial clients, and that kind of client can get the account banned. A saved Signal or iMessage connection stays listed so you can delete it, but it cannot send or receive.

### Inbound Posture At A Glance

Inbound capability is derived from the runtime capability rules (`packages/gateway-core/src/channel-core.ts`), not from this doc:

- **Bidirectional (inbound available when configured):** Telegram, Slack, Discord, WhatsApp (app secret + verify token), LINE (channel secret), Nextcloud Talk (webhook), ntfy (opt-in persistent subscription to a topic's JSON stream; the topic is the sender, so allow `ntfy-topic:<topic>`, and GoatCitadel's own publishes are tagged and ignored on the way back in. The token gates reading the topic; anyone able to publish to the subscribed topic can start turns, so use a topic whose write access is limited to trusted publishers. Messages published while the gateway is disconnected or restarting are skipped: no history is fetched on reconnect after a restart or a connection edit. A stream silent for 2 minutes is reconnected), Mattermost (opt-in persistent bot WebSocket for `posted` events; allow the Mattermost user ids that may start turns, and the bot's own and system posts are ignored; Mattermost has no replay, so posts sent while the socket is disconnected or that fail acceptance are not recovered; the bot pings the socket every 30 seconds and reconnects one that answers nothing for 90 seconds), QQBot (signed webhook; the app secret verifies every request, and you allow the QQ openids that may start turns; see below), WeCom (encrypted callback when the Token and EncodingAESKey are set; you allow the WeCom userids that may start turns; see below), Matrix (opt-in `/sync` long-poll; allow the Matrix user ids such as `@alice:example.com` that may start turns; the bot's own messages are ignored and the `since` token is persisted, so a restart resumes where it stopped; if the homeserver rejects the stored token the runtime re-primes and messages in that gap are skipped; see below), Google Chat (Chat app mode only: a service-account key plus `audienceType`/`audience`; see below).
- **Outbound delivery today:** Microsoft Teams, Google Chat webhook mode, Zalo OA.

### Inbound voice (on by default)

Inbound channel voice is on by default (`channelVoiceInboundV1Enabled`). Telegram voice and audio messages, WhatsApp audio messages, Slack audio file shares that arrive on the signed web address (Socket Mode leaves voice out), and Discord audio attachments are downloaded (8 MB cap, provider-allowlisted hosts only, no redirects) and transcribed by the local media voice pipeline (the managed whisper.cpp runtime plus ffmpeg; see `docs/INSTALL_SETUP_TESTING.md`). The transcript starts the turn as untrusted content, and any typed caption follows it. Senders still pass the same allowlist, pairing, and policy gates as text.

The media hosts must be in the network allowlist (`toolPolicy.sandbox.networkAllowlist`), and the shipped example allowlists do not include them: add `files.slack.com` for Slack voice, and `cdn.discordapp.com` plus `media.discordapp.net` for Discord voice (`discord.com` does not cover the Discord CDN hosts). Without them the download is refused, every Slack or Discord voice message falls back to `[voice message]`, and the reason is recorded only in the `channel.voice_transcription_failed` diagnostic.

If the voice runtime is missing, ffmpeg or the model is unavailable, the media is too large or not audio, or the download fails, the message is never dropped: the turn runs on a plain fallback text (for example `[voice message]` or `[whatsapp audio]`, plus any typed caption) and a `channel.voice_transcription_failed` diagnostic records the reason. Nextcloud Talk bots cannot download shared files, so an audio file there is not transcribed and the turn says so.

To turn it off, set `GOATCITADEL_FEATURE_CHANNEL_VOICE_INBOUND_V1_ENABLED=false` or store `channelVoiceInboundV1Enabled: false` in Settings feature flags. With it off, Telegram voice and Slack voice-only shares are ignored, WhatsApp audio keeps its `[whatsapp audio]` placeholder, and a Discord voice-only message is declined.

Webhook-ingress channels (Telegram, Slack, WhatsApp, LINE, Nextcloud Talk, Google Chat app mode) start with an empty default-deny sender allowlist, and Telegram's polling mode uses the same one; unknown senders are rejected before any message reaches the runtime. Discord's gateway ingress is governed differently: guild allowlist policy plus per-guild channel/role/user rules and mention requirements (`apps/gateway/src/services/discord-runtime-service.ts`), so scope those pairing rules deliberately — a configured guild/channel without a user list accepts any member who mentions the bot. In every case, accepted messages still pass the standard policy gate.

Long-form walkthroughs below still focus on the current high-traffic channels. The additional guided definitions above exist so operators can draft, edit, repair, and retest those guided channels inside Mission Control without dropping back to raw JSON.

## Recommended Rollout Order

1. `channel.tui` for local operator workflows
2. `channel.webchat` for local browser workflows
3. `channel.discord` for first external beta testing
4. `channel.slack` after Discord is stable
5. `channel.telegram` as a pilot integration
6. `channel.teams` for controlled webhook-based workspace pilots

## Before You Start

Use this minimum secure baseline for any non-loopback deployment:

```env
GOATCITADEL_AUTH_MODE=token
GOATCITADEL_AUTH_TOKEN=<long-random-token>
```

Also keep these rules:

- keep break-glass env vars off
- keep bot tokens in environment variables, not repo files
- test in a sandbox server/channel/workspace before wider rollout

### Public web address

Channels that a vendor delivers to over the internet (WhatsApp, LINE, QQBot, WeCom, Google Chat in Chat app mode, and Telegram when it sends to a web address) need an `https://` address that reaches GoatCitadel. GoatCitadel does not provide one: use your own domain, reverse proxy or tunnel, then set it once in Chat › Messaging › Advanced channel setup › **Public web address**. Every `https://<your-gateway-host>/…` address in this guide starts with it. The WhatsApp page and each channel's webhook address block build the full address from it, and show a placeholder and a **Set your public web address** link until it is set. It must be a full `https://` address of at most 200 characters, with no user name or password and nothing after `?` or `#`, on a host the internet can reach (not `localhost` or a private network address). Saving it is a Settings change that you approve in place. Details are in [CHANNEL_GUIDED_SETUP.md](./CHANNEL_GUIDED_SETUP.md#public-web-address).

## Local Channels First

### TUI (`channel.tui`)

Installed path:

```bash
goatcitadel tui
```

Manual/dev path:

```bash
pnpm tui
```

Best for:

- technical operators
- keyboard-first workflows
- low-latency local use
- token-efficient operations when you do not need browser UI overhead

Future TODO:

- Align TUI runtime log styling and `--verbose` behavior with the gateway dev surface so operator output stays consistent across local channels.

### Webchat (`channel.webchat`)

Start GoatCitadel and open Mission Control in the browser.

Best for:

- first-time users
- visual approvals and dashboards
- prompt testing and richer page workflows

## Discord Bridge / Gateway

### Quick setup from Messaging

In Chat, open **Messaging**, select **+ Add**, then **Discord**. The page walks you through making the bot in the Developer Portal, pasting its token (GoatCitadel checks it with Discord and stores it as a masked credential, and asks you to switch on Message Content Intent if it is off), inviting the bot to a server with a ready-made link, choosing where it posts, and turning it on. Discord names the person who made the bot, and that person is the only one let in: the page puts them on the connection's sender allowlist and marks them as you, so they skip the pairing code in direct messages, and in the channel you choose the bot answers only people on the allowlist, and only when they mention it. Clearing the "This is you" mark later only sends them to pairing in direct messages; the channel still answers only the allowlist. Anyone else who messages the bot privately still gets a pairing code. The page needs no channel id, server id or environment variable. It does not cover a webhook with no bot, which stays in Chat › Messaging › Advanced channel setup (the steps below). The real-account checks of this page (a real bot, the invite, a direct message, a mention in the chosen channel) are still owed by the operator. Details are in [CHANNEL_GUIDED_SETUP.md](./CHANNEL_GUIDED_SETUP.md).

Official references:

- Discord Developer Portal: https://discord.com/developers/applications
- Discord getting started docs: https://docs.discord.com/developers/quick-start/getting-started
- Discord application auth/install model: https://docs.discord.com/developers/resources/application
- Discord Gateway intents: https://docs.discord.com/developers/events/gateway
- Discord permissions: https://docs.discord.com/developers/topics/permissions

### Choose the right mode first

GoatCitadel supports two Discord backends, but the normal user path is now simple:

1. If you provide a bot token, GoatCitadel uses `Gateway`
2. If you intentionally configure webhook-only delivery, GoatCitadel uses `Bridge`

You should not need to choose a runtime mode in the normal setup flow. Bridge is now an advanced fallback.

### Step-by-step

1. Open the Discord Developer Portal and sign in.
2. Click `New Application`.
3. Give it a clear name such as `GoatCitadel Beta Bot`.
4. Optionally upload a profile image and fill in the description so testers recognize it.
5. Open the `Bot` section in the left sidebar.
6. Click `Add Bot` if Discord has not created one yet.
7. Under `Privileged Gateway Intents`, enable `Message Content Intent`. GoatCitadel requests this intent when it logs in; Discord can reject the gateway session when it is disabled even if REST token checks pass.
8. Generate or reset the bot token.
9. Copy the token into your local environment as `DISCORD_BOT_TOKEN`.

Example:

```env
DISCORD_BOT_TOKEN=your_token_here
```

10. Restart GoatCitadel if you added or changed the process environment so the Gateway can read the new value.
11. Open the `Installation` section and choose a server install with the `bot` scope. Discord currently includes `applications.commands` with bot installs; keep application commands enabled for GoatCitadel's slash commands.
12. Start with these channel permissions:
    - `View Channel`
    - `Send Messages`
    - `Read Message History`
13. Add capability-specific permissions only when needed:
    - `Add Reactions` for the best-effort seen marker
    - `Send Messages in Threads` for thread replies
    - `Attach Files` for uploaded files
    - `Embed Links` for rich URL-backed messages
14. Generate the install link and add the bot to your test server.
15. Enable Developer Mode in Discord. Copy both:
    - the server id from the target server
    - the channel id from the sandbox channel inside that server
16. In GoatCitadel Mission Control:
    - open `Settings > Channels`
    - create a Discord setup draft
    - set `botTokenEnv=DISCORD_BOT_TOKEN`
    - set the default channel id
    - set the default server (guild) id when guild policy is `allowlist`
    - keep DM policy at `pairing` unless you intentionally want open or disabled DMs
17. Run `Test`. On the bot-token path, the wizard confirms:
    - token auth passes
    - channel access passes
    - the channel belongs to the configured server
    - a visible test message is posted and then deleted
18. Finish the setup. A new Gateway runtime cannot exist before the connection is saved, so initial runtime readiness is deferred until this step. After finalize, confirm diagnostics report:
    - logged in / ready
    - connected bot identity
    - connected guilds
19. In the sandbox channel, send `@YourBot hello`. The default guild route requires the mention for normal messages.
20. If DM policy is `pairing`, send the bot a DM, have an operator approve the generated pending code, then send the message again.

### Default server and sender boundary

The guided Gateway path uses `guildPolicy=allowlist`. The default server id and default channel id create its initial inbound route:

- normal guild messages are accepted only from that server and channel and must mention the bot
- without narrower advanced user or role rules, any member who can use the selected channel can invoke the bot by mentioning it
- slash commands still require the allowlisted server/channel route, but they do not require an `@mention`
- set guild policy to `off` for a DM-only setup; in that mode a default server id is not required
- DM `pairing` is separate from guild access and remains the recommended default

The advanced webhook-only Bridge path is outbound-only. The wizard structurally validates its webhook URL, but it does not run an automatic live webhook send; confirm that fallback manually in Discord.

### Discord troubleshooting

- "Discord didn't accept that token, or GoatCitadel couldn't reach Discord.": the token on the Messaging page is wrong or was reset; copy the new one from the Bot page (and check that `discord.com` is in the network allowlist)
- `401`: token invalid, expired, or copied incorrectly
- gateway close `4014` or valid token but no ready state: enable `Message Content Intent` on the application's Bot page; verified apps may also need intent approval
- `404` on channel probe: wrong channel id or wrong target
- `403` on channel probe or test message: bot is installed, but channel permissions are incomplete
- server/channel match failure: the channel id belongs to a different server; copy both ids again from the same sandbox route
- bot is online but ignores a normal server message: confirm the server/channel ids match and mention the bot
- slash command is missing or unavailable: confirm the app was installed with application commands enabled and the member can use application commands in that channel
- first DM returns a pairing code instead of starting work: expected under the default pairing policy; approve the pending sender, then retry
- bridge mode showing "offline": expected, because bridge mode does not establish persistent presence
- gateway mode not ready: confirm the bot token env var is available to the gateway process and the bot is installed in the target server
- webhook-only bridge mode: send-only fallback, no reactions, inbound routing, or online presence; confirm delivery manually

### Intents and restarts

- Gateway mode explicitly requests Discord's privileged Message Content intent for normal inbound text.
- Restart GoatCitadel after adding or changing `DISCORD_BOT_TOKEN` so the Gateway process receives the environment value.
- Finalizing or updating a saved Gateway connection synchronizes its persistent runtime; use connection diagnostics to inspect login or reconnect failures.
- Bridge mode never creates online presence. It needs a restart only when its process environment changes.

## Slack

### Quick setup from Messaging

In Chat, open **Messaging**, select **+ Add**, then **Slack**. The page opens Slack with an app named "GoatCitadel" ready to create from a manifest (you can rename it in Slack afterwards), then asks for two tokens: the Bot User OAuth Token (`xoxb-`) after you install the app, and an app-level token (`xapp-`, with the `connections:write` scope) from Basic Information. GoatCitadel checks both with Slack and stores them as masked credentials. It then asks you to send a one-time code to the bot in Slack; the person who sends it becomes the only allowed sender. You choose where the bot posts (direct messages with that person, or a channel the bot has been added to) and turn it on. This path receives over Socket Mode: GoatCitadel opens a connection to Slack, so no public web address or signing secret is needed, and `slack.com` must be in the network allowlist (Turn on adds it after its approval). The app receives direct messages and mentions in channels it has been added to, not every channel message, and only from allowed senders (Socket Mode is always allowlist-only). Its voice messages are left out because the app has no `files:read` scope: an audio share with no text is ignored. The OAuth sign-in, the signed web address and an incoming webhook stay in Chat › Messaging › Advanced channel setup (the steps below). The real-account checks of this page (a real Slack app, both tokens, hi, a reply, a mention, and a socket refresh after a few hours) are still owed by the operator. Details are in [CHANNEL_GUIDED_SETUP.md](./CHANNEL_GUIDED_SETUP.md).

Official references:

- Slack OAuth v2: https://api.slack.com/authentication/oauth-v2
- Slack first app tutorial: https://api.slack.com/tutorials/first-bolt-app

### Step-by-step

1. Open the Slack API app dashboard.
2. Create a new app `From scratch`.
3. Choose your workspace.
4. Under `OAuth & Permissions`, add bot scopes such as `chat:write`.
5. Install or reinstall the app to the workspace.
6. Copy the Bot User OAuth token into `SLACK_BOT_TOKEN`.
7. In GoatCitadel `Connections`, add `channel.slack`.
8. Set `botTokenEnv=SLACK_BOT_TOKEN`.
9. Set a default channel such as `#ops-sandbox`.
10. Send a test post.

### Slack troubleshooting

- `not_in_channel`: invite the app or bot into the target channel, then retest
- `channel_not_found`: use the real channel id or a resolvable default target, not display text
- `missing_scope`: add the needed bot scopes and reinstall the app
- webhook-only fallback: expected to remain send-only and manual-confirm oriented
- "Slack didn't accept the app-level token.": the `xapp-` token is wrong, revoked, or was made without the `connections:write` scope; make a new one under Basic Information › App-Level Tokens and use **Change the key** on the channel's page
- "Slack turned Socket Mode off for this app.": Socket Mode was switched off for the app in Slack; switch it on again
- "GoatCitadel isn't allowed to reach slack.com.": add `slack.com` to the network allowlist
- your hi is never seen: the code may have expired, so get a new one; send it as a direct message to the bot, not in a channel
- the bot ignores a channel message (app made from the Messaging page): it hears a channel only after it has been added there (`/invite @<bot name>`), and only when it is mentioned

## Telegram (Pilot)

Reference:

- https://core.telegram.org/bots/tutorial

New Telegram connections receive by polling: GoatCitadel asks Telegram for new messages, so you do not need a public web address or a webhook secret. Delivery to a public HTTPS web address (a webhook) is the advanced option, covered below.

### Step-by-step (Messaging)

1. In Chat, open **Messaging**, select **+ Add**, then **Telegram**.
2. **Make your bot.** Scan the QR code or open the link to reach `@BotFather`, send `/newbot` and follow the naming prompts.
3. **Paste the key BotFather sent you.** GoatCitadel checks it with Telegram and stores it as a masked credential. If the bot still sends its messages to a web address, or another app is reading them, the page says so. For a web address it offers **Stop sending to that address**.
4. **Say hi to your bot.** Scan the new QR code or open the link, then tap Start. If you do not see Start, send the code shown on the page. The code works for ten minutes, and **Get a new code** replaces it. If the bot already has more waiting messages than GoatCitadel can look through, the step says it can't see your hi yet and offers **Clear waiting messages**; GoatCitadel skips them when it turns on anyway, and a hi sent before you clear them may need to be sent again. Whoever says hi from a private chat becomes the only person allowed to message the bot until you add others, and that chat becomes its default destination.
5. **Turn it on.** The step lists what will change: who can message the bot, where it posts, how it gets messages, a test message that GoatCitadel sends and then removes, and `api.telegram.org` if it is not yet in the allowed hosts. Turn on makes and approves that change in place. If the approval cannot be given there, the step links to Inbox or Settings.
6. Send your bot a message to try it.

To replace the key later, open the channel in Messaging and select **Change the key**. Chat › Messaging › Advanced channel setup offers every option, including the receive mode, and points back to Messaging.

### Step-by-step (environment variable)

1. Create the bot with `@BotFather` and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your target chat/channel and grant send rights.
3. In Chat › Messaging › Advanced channel setup, add Telegram and point it at that environment variable.

### Receiving messages

- **Ask Telegram for new messages (default).** Needs no public web address. `api.telegram.org` must be in the network allowlist.
- **Telegram sends messages to a public web address (advanced).** Choose it as the receive mode in Chat › Messaging › Advanced channel setup, set the webhook secret and register the connection's web address with Telegram. The address must be public and HTTPS.
- **Don't receive messages.** The channel can still send.

Existing Telegram connections keep working as they do today. One with a webhook secret stays on the web address, and one without stays off until you change it in Chat › Messaging › Advanced channel setup. Polling and the web address use the same sender allowlist, pairing and policy gates, and an empty allowlist denies every sender.

Telegram allows only one reader per bot. While the bot sends to a web address, or another app is reading it, polling reports an error instead of receiving.

The first time a bot is polled, GoatCitadel skips whatever is already waiting. It saves its place after each message, so a restart resumes there. Telegram does not keep unread messages indefinitely, so messages sent during a long outage may be gone.

Treat Telegram as pilot-only until your sandbox workflow is stable.

### Telegram environment example

```env
TELEGRAM_BOT_TOKEN=123456789:AA...
```

### Telegram troubleshooting

- `401` or auth failure, or "Telegram rejected the bot key.": token is wrong, revoked, or copied incompletely; use **Change the key** on the channel's page
- "Telegram says another app is reading this bot's messages, or the bot sends them to a web address.": stop the other reader, or use **Stop sending to that address** during setup
- "GoatCitadel isn't allowed to reach api.telegram.org.": add `api.telegram.org` to the network allowlist; Turn on does this for you after its approval
- your hi is never seen: the code may have expired, so get a new one; only a private chat with the bot counts, not a group
- send succeeds nowhere: the bot is not actually in the target chat or channel
- delete probe fails: the bot can post but lacks permission to remove the test message
- `@channel_name` works inconsistently: prefer the real chat id when available

## Google Chat

Official references:

- https://developers.google.com/workspace/chat/quickstart/webhooks
- https://developers.google.com/workspace/chat/authenticate-authorize-chat-app
- https://developers.google.com/workspace/chat/verify-requests-from-chat

Google Chat has two modes. Webhook mode posts into one space through an incoming webhook and cannot receive messages. Chat app mode runs GoatCitadel as a Chat app: it receives messages, replies through the Chat API with a service account, and can delete only the app's own messages.

### Step-by-step (webhook mode)

1. Open the target Google Chat space.
2. Create an incoming webhook for that space.
3. Copy the full webhook URL.
4. In GoatCitadel `Connections`, add `channel.google-chat`.
5. Paste the webhook URL.
6. Optionally set a default thread key if you want repeated outbound posts to group into a stable thread.
7. Run guided test or retest.
8. Confirm manually that the test message landed in the intended space or thread.

### Step-by-step (Chat app mode)

1. In Google Cloud, enable the Google Chat API and create a service account with a JSON key.
2. Store the whole JSON key in an environment variable on the gateway host (for example `GOOGLE_CHAT_SA_KEY`); never paste it into a tracked file.
3. Configure the Chat app: set its HTTP endpoint URL to this connection's `/api/v1/integrations/connections/<connectionId>/google-chat/webhook` URL, and note its authentication audience (project number or HTTP endpoint URL).
4. In GoatCitadel `Connections`, add `channel.google-chat` with `serviceAccountKeyEnv`, `audienceType` (`project_number` or `endpoint_url`), `audience` (the project number, or this endpoint's public HTTPS URL), and optionally `defaultSpace` (`spaces/...`). If the Chat app is built as a Google Workspace add-on, also set `addOnProjectNumber` (see below); leave it empty for a regular Chat app.
5. Allow `chat.googleapis.com` and `oauth2.googleapis.com` in the network allowlist.
6. Add the Google Chat user resource names (`users/...`) that may start conversations. Inbound is default-deny; a dropped message's `sender_not_allowlisted` diagnostic shows the id. Existing Google Chat connections never inherit a legacy-open posture.
7. Message the app (or @mention it in a space) and confirm its threaded reply.

Every inbound request must carry a Google-signed bearer token: GoatCitadel requires RS256, picks the signing certificate by `kid` from Google's published certificates (cached per their `Cache-Control` max-age), and checks the issuer (`chat@system.gserviceaccount.com` for project-number audiences; `accounts.google.com` plus the `chat@system.gserviceaccount.com` email for endpoint-URL audiences), the configured audience, and expiry before anything is accepted.

Workspace add-on Chat apps: Google signs their requests as an OIDC ID token with the same issuer (`accounts.google.com`) and the HTTP endpoint URL as audience, but the email is the add-on's own service account, `service-<PROJECT_NUMBER>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`. Set `audienceType` to `endpoint_url` and `addOnProjectNumber` to that numeric project number; GoatCitadel then also accepts exactly that one address (with `email_verified` true). Without `addOnProjectNumber`, add-on requests are rejected with `bad_email`. Any other add-on or service-account address is always rejected, because any Google Cloud project can mint a token for a public URL and the email is what proves the request came from your app.

The message resource name (`spaces/.../messages/...`) is the dedupe key, so a redelivered event is accepted once. Messages from bots, including the app's own messages, are ignored.

### Google Chat troubleshooting

- validation fails immediately: the value is not a real Google Chat incoming webhook URL
- the test message fails with `404` or `403`: the webhook was deleted, rotated, or tied to a different space
- post lands in an unexpected thread: remove or correct the default thread key
- duplicated test messages before this release: fixed for unchanged drafts in the same gateway process lifecycle
- Chat app requests rejected with `401`: the audience type or audience does not match the Chat app configuration (check the gateway log reason, for example `bad_audience`)
- Workspace add-on Chat app requests rejected with `401` and log reason `bad_email`: set `addOnProjectNumber` to the add-on's numeric project number (with the `endpoint_url` audience type)
- Chat app requests rejected with `400`: the connection has no `audienceType`/`audience`
- Chat app sends fail before reaching Google: allow `chat.googleapis.com` and `oauth2.googleapis.com`, and check that the key environment variable holds the full JSON key

## Teams

Official reference:

- https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using

### Step-by-step

1. Open the target Teams channel.
2. Create or configure the incoming webhook or approved connector path.
3. Copy the full webhook URL.
4. In GoatCitadel `Connections`, add `channel.teams`.
5. Paste the webhook URL.
6. Optionally set a default card title such as `GoatCitadel`.
7. Run guided test or retest.
8. Confirm manually that the test card arrived in the intended Teams channel.

### Teams troubleshooting

- validation fails immediately: the value is not shaped like a Teams webhook URL
- the test card fails to post: the connector was removed, rotated, or restricted by the workspace
- card formatting looks plain: expected if the destination strips parts of the adaptive-card payload
- channel mismatch: recreate the webhook from the exact Teams channel you want GoatCitadel to target

## WhatsApp (Cloud API)

### Quick setup from Messaging

In Chat, open **Messaging**, select **+ Add**, then **WhatsApp**. Meta delivers messages only to a public `https://` address, so the page first asks for GoatCitadel's public web address (Chat › Messaging › Advanced channel setup › Public web address; use your own domain, reverse proxy or tunnel, since GoatCitadel does not provide one). You make a Meta app yourself and paste five values: the access token (a system user's token is best, since a temporary one stops working), the Phone number ID, the WhatsApp Business Account ID, the App ID and the App secret. GoatCitadel checks them with Meta (read-only calls: the number, `debug_token`, the account's numbers and its subscribed apps), stores the token and secret as masked credentials, and names the number. If the token will stop working, the page says when and points you to **Change the key** later. You then set Meta's Callback URL and Verify token yourself (WhatsApp › Configuration › Verify and save, then subscribe to `messages`); for a setup draft made on that page, GoatCitadel answers Meta's check at the draft's address and hears the code (it keeps only the check's time and the code's sender, in memory for 15 minutes) and, if the app isn't subscribed, offers one button that subscribes it. You send a one-time code from your phone (a QR code or `wa.me` link); the person who sends it becomes the only allowed sender and the default recipient. Turn on tests, then activates in place, and adds `graph.facebook.com` to the network allowlist if it is missing. Pairing for other people is not on the page yet: add more numbers to `allowedSenders` in Chat › Messaging › Advanced channel setup. WhatsApp allows a free-form reply only within 24 hours of the person's last message, so Chat's composer and GoatCitadel refuse a later operator reply (answers the agent writes are not checked). A connection that keeps its Phone number ID, Business Account ID, App ID and App secret changes its access token from **Change the key**. Chat › Messaging › Advanced channel setup keeps WhatsApp's guide for the other ways (environment-variable keys, a send-only connection), which is the step list below. The real-account checks of this page (a real Meta app, the five values, the Callback URL, hi, Turn on, a reply within the window and a reply after 24 hours) are still owed by the operator. Details are in [CHANNEL_GUIDED_SETUP.md](./CHANNEL_GUIDED_SETUP.md).

Official references:

- https://developers.facebook.com/docs/whatsapp/cloud-api
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started

### How inbound enablement works

Inbound webhook routing is only enabled when BOTH the app secret and the webhook verify token are configured on the connection. With only one of the two, the connection stays outbound-only:

- the app secret verifies the `x-hub-signature-256` HMAC that Meta attaches to every POST delivery
- the verify token answers the one-time Meta GET verification challenge when you register the webhook URL

On top of the signature check, each inbound sender must pass the connection's sender allowlist before GoatCitadel ingests the message. New connections default to `inboundAccessMode=allowlist` with an empty list, which denies all inbound senders until you explicitly add the phone numbers (WhatsApp `wa_id` values, digits only) you trust.

### Step-by-step

1. Create or select a Meta app with WhatsApp Cloud API access:
   - open the Meta developer console at https://developers.facebook.com/apps
   - create a `Business` app (or reuse one) and add the `WhatsApp` product
2. Generate the Cloud API access token you want GoatCitadel to use for outbound delivery, and store it in `WHATSAPP_ACCESS_TOKEN`.
3. Record the phone number id for the sending number (the numeric Cloud API sender id, not the display phone number).
4. Copy the Meta app secret from `App settings > Basic` and store it in `WHATSAPP_APP_SECRET`.
5. Choose a webhook verify token you control (any long random string) and store it in `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
6. In GoatCitadel `Connections`, add `channel.whatsapp`.
7. Set the outbound/runtime secrets:
   - `accessTokenEnv=WHATSAPP_ACCESS_TOKEN`
   - `appSecretEnv=WHATSAPP_APP_SECRET`
   - `webhookVerifyTokenEnv=WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - `phoneNumberId=<your_meta_phone_number_id>`
8. Allowlist the inbound senders you trust:
   - keep `inboundAccessMode=allowlist`
   - add each permitted sender phone number to `allowedSenders`
   - an empty allowlist rejects every inbound message before it reaches a session
9. In the Meta app dashboard under `WhatsApp > Configuration`, point the webhook subscription at:
   - `https://<your-gateway-host>/api/v1/integrations/connections/<connectionId>/whatsapp/webhook`, where the address starts with the public web address from Chat › Messaging › Advanced channel setup (the connection's webhook address block shows the full address)
   - use the same verify token value you configured in step 5
10. Subscribe to the `messages` webhook field, finalize the connection, and confirm manually that:
    - the Meta challenge succeeds
    - an inbound test message from an allowlisted sender lands in GoatCitadel
    - outbound replies still use the expected phone number id

### WhatsApp environment example

```env
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_APP_SECRET=your_meta_app_secret
WHATSAPP_WEBHOOK_VERIFY_TOKEN=long-random-string-you-chose
```

### WhatsApp troubleshooting

- Meta challenge fails: the verify token in Meta does not match GoatCitadel
- inbound `401`: the `x-hub-signature-256` signature does not match the configured app secret
- inbound `400` with a missing-app-secret error: the connection has a verify token but no app secret, so signed POST deliveries cannot be verified
- outbound works but inbound does not: the access token is valid, but the app secret plus verify token pair is missing or stale; both are required for inbound
- signature and challenge both pass but messages never appear: the sender is not on the connection allowlist; add the sender phone number to `allowedSenders` or check for an empty allowlist
- repeated deliveries of the same message id: expected to be idempotent; GoatCitadel dedupes on the WhatsApp message id, so a Meta retry does not create a second reply
- inbound `413` or rejected large payloads: inbound webhook bodies are capped at 256 KiB; oversized deliveries are dropped before processing
- delivery statuses appear without messages: expected when Meta posts status-only payloads; send a real inbound text to validate routing
- local-only gateway URL: Meta cannot call loopback or non-public HTTP endpoints; use a reachable HTTPS URL
- "Meta didn't accept the access token." (Messaging page): the token is wrong, revoked or expired (Graph's access-token error, code `190`, reads this way too); make a system user's token in Business Settings › System users, and for a channel that is already on use **Change the key** on its page
- "That access token was made for a different Meta app." or "Meta didn't accept that App ID and App secret together." (Messaging page): the token, App ID and App secret must all come from the same Meta app
- "That phone number isn't in that WhatsApp Business Account.": the Phone number ID and the WhatsApp Business Account ID come from different accounts (GoatCitadel reads only the first 100 numbers of an account)
- "Meta hasn't checked your address yet. Choose Verify and save in Meta, then check again." (Messaging page): the Callback URL or Verify token in WhatsApp › Configuration doesn't match the page, the public web address isn't reachable from the internet, or the draft was started over (a new draft has a new Callback URL); choose **Check again** after fixing it
- "Meta isn't set to send this number's messages to your app yet.": choose **Let this app receive your number's messages**, or subscribe to `messages` under WhatsApp › Configuration
- "Meta refused the request. Check that the access token has the whatsapp_business_management and whatsapp_business_messaging permissions." (Messaging page): Meta answered with a refusal that has no sentence of its own, such as a `403` or a rate limit (`429`); make the token again with both permissions, or wait a few minutes when you have just checked many times, then check again
- "GoatCitadel couldn't reach Meta." (Messaging page): no readable answer came back from `graph.facebook.com`, because of the network (check that this computer can reach `graph.facebook.com`) or because Meta is down (a `5xx`); try again later
- "This page stores your keys in this computer's secure storage, which isn't available here. Use WhatsApp's guide in Advanced channel setup with environment variables instead." (Messaging page): this computer has no OS keychain for GoatCitadel to keep keys in; follow WhatsApp's guide in Chat › Messaging › Advanced channel setup and give the keys as environment variables
- your hi is never seen on the Messaging page: the code may have expired, so get a new one; send it from your phone to the business number as it is, and with Meta's test number add the phone under API Setup › To first
- the composer says "WhatsApp allows a reply only within 24 hours of their last message. Once they message again, you can reply.": the free-form reply window has closed; have the person message the number again (Meta's error code for a late send is `131047`)
- Turn on or **Save key** can't deliver its test message: WhatsApp delivers a plain message only within 24 hours of the recipient's last message to the number; have them message it first

## LINE

Official references:

- https://developers.line.biz/en/docs/messaging-api/getting-started/
- https://developers.line.biz/en/docs/messaging-api/receiving-messages/

### Step-by-step

1. Open the LINE Developers console and create or select a Messaging API channel.
2. Copy the channel access token for outbound delivery.
3. Copy the channel secret for signed webhook verification.
4. In GoatCitadel `Connections`, add `channel.line`.
5. Set:
   - `channelAccessTokenEnv=LINE_CHANNEL_ACCESS_TOKEN`
   - `channelSecretEnv=LINE_CHANNEL_SECRET`
6. Set the webhook URL to:
   - `https://<your-gateway-host>/api/v1/integrations/connections/<connectionId>/line/webhook`, where the address starts with the public web address from Chat › Messaging › Advanced channel setup
7. Enable webhooks in LINE, finalize the connection, and confirm manually that:
   - LINE accepts the webhook endpoint
   - an inbound test message reaches GoatCitadel
   - group or room replies route back to the expected thread target

### LINE troubleshooting

- inbound `401`: the `x-line-signature` value does not match the configured channel secret
- no inbound events arrive: webhook delivery is disabled in the LINE console or pointed at the wrong connection id
- direct messages work but group routing is wrong: validate the room/group source ids and resend from the intended thread
- `404` from LINE webhook verification: the connection id in the URL is wrong or the route is not reachable from the public internet
- local HTTP URL: LINE requires a reachable HTTPS endpoint for webhook delivery

## Matrix

Official reference:

- https://spec.matrix.org/latest/client-server-api/

Matrix outbound is text-only (no attachments). It supports room sends, replies, reactions, redactions (unsend) and typing notices through the client-server API.

End-to-end encrypted rooms are not supported: inbound ignores encrypted events and outbound sends unencrypted messages; use an unencrypted room.

### Step-by-step

1. Create a Matrix account for the bot on your homeserver.
2. Obtain an access token for that account (for example from your client's advanced settings or the login API) and export it in the gateway environment, for example `MATRIX_ACCESS_TOKEN`.
3. Invite the bot to the room and accept the invite (join it) so it can post and, for inbound, receive.
4. Add the homeserver host to the network allowlist.
5. In GoatCitadel `Connections`, add `channel.matrix` and set:
   - `homeserverUrl=https://matrix.example.com`
   - `accessTokenEnv=MATRIX_ACCESS_TOKEN`
   - `defaultRoomId=!roomid:example.com` (optional; sends normally take the room from the target)
6. Optional inbound: set `inboundStreamEnabled=true` and allow the Matrix user ids that may start turns. Inbound is default-deny and always allowlist-only.
7. Run the guided test: it checks the token (whoami), that the bot has joined the default room, and posts a test notice (an `m.notice`) when you run the explicit send. Confirm receipt in the room.

### Matrix troubleshooting

- `token rejected`: the homeserver refused the access token; generate a new one and update the env var
- bot has not joined the default room: invite the bot account and accept the invite
- host outside the network allowlist: add the homeserver host before probing or sending
- messages missing after a long outage: if the homeserver reports the stored sync token as unknown or invalid (`M_UNKNOWN_POS`, or a 400 whose error names the token or stream position) the runtime re-primes from the present, so messages in that gap are skipped; other request errors are retried with backoff and never skip messages
- replies to threaded messages are posted as rich replies in the main timeline (inbound thread roots are not carried through the shared reply routing), and outbound delivery is text-only, so a send with attachments fails with a clear error
- inbound messages are ignored: the sender is not on the allowlist (a dropped message's `sender_not_allowlisted` diagnostic shows the id)
- messages from an encrypted room never arrive: end-to-end encrypted rooms are not supported; an `encrypted_event_ignored` diagnostic records the count, so move the bot to an unencrypted room
- messages missing after a busy period: if a room produces more than 100 messages in one sync, the older ones are skipped and a warn `timeline_limited` diagnostic records how many rooms were affected
- edited messages do not start a new turn: Matrix edits are ignored on inbound
- room ids look like `!opaque:example.com`; a `#alias:example.com` is not accepted as a send target

## QQBot

Official reference:

- https://bot.q.qq.com/wiki/develop/api-v2/

QQBot sends text to group (`group:<openid>`), C2C (`user:<openid>`), guild channel (`channel:<id>`) and guild direct-message (`dm:<guild id>`) targets through the QQ Bot Open Platform. Outbound is text-only: a send with attachments fails with a clear error. Reactions and unsend are not supported by this adapter, and QQ has no typing indicator for bot messages.

QQ allows active (unprompted) group and C2C messages only within platform quotas, so a reply sent soon after an inbound message (within about 5 minutes) is a passive reply that carries the inbound message id. A reply carries the inbound message id and fails once QQ's passive window has passed; it does not fall back to an active send. Every chunk of a split reply is a passive reply to the same inbound message id with an increasing `msg_seq` (each send starts from a random base so a second send to the same message does not collide with an earlier one). QQ allows 4 passive replies per C2C (`user:`) message and 5 per group message, so a reply that would need more chunks than that is refused before anything is sent: shorten it. QQ openids differ by scope (a group `member_openid` is not the C2C `user_openid`), so allowlist each scope's id. Replies are split at 2,000 characters as a conservative guess because the exact QQ text limit is unverified.

Inbound is a signed webhook. GoatCitadel verifies the ed25519 signature (keyed from the AppSecret) on every event before accepting it. QQ's op 13 callback validation is answered with an AppSecret signature, and its request signature is verified whenever QQ includes one. Inbound is default-deny: only the QQ openids in `allowedSenders` can start turns, and an empty list drops everything. A dropped message's `sender_not_allowlisted` diagnostic shows the openid to add.

### Step-by-step

1. Create a QQ Bot Open Platform application and note the AppID and AppSecret.
2. Export the AppSecret in the gateway environment, for example `QQBOT_APP_SECRET`.
3. Add `bots.qq.com` and `api.bot.qq.com` (and `sandbox.api.sgroup.qq.com` if you use the sandbox) to the network allowlist.
4. In GoatCitadel `Connections`, add `channel.qqbot` and set:
   - `appId=<AppID>`
   - `appSecretEnv=QQBOT_APP_SECRET` (an earlier `tokenEnv` value is shown here as `appSecretEnv` when you edit)
   - `defaultTarget=user:<openid>` (optional)
   - `sandbox=true` while the application is unpublished
5. Save and enable the connection, then in the QQ console set the callback URL to `https://<your-gateway>/api/v1/integrations/connections/<connectionId>/qqbot/webhook` (the address starts with the public web address from Chat › Messaging › Advanced channel setup) and subscribe to the events you need. QQ sends a validation request (op 13) that GoatCitadel answers with an AppSecret signature; QQ may send it without signature headers, and if it includes them they must verify. Every other event must be signed.
6. Add the QQ openids that may start turns to `allowedSenders`.
7. Run the guided test: it mints a token, reads the bot identity and, when you run the explicit send, sends one active test message to the default target. A rejection of that message can be a quota, not a credential problem.

### QQBot troubleshooting

- `credentials rejected`: QQ refused the AppID and AppSecret; copy them again from the console
- host outside the network allowlist: add the QQ hosts before probing or sending
- the callback URL fails validation in the console: the connection must be enabled with a resolvable AppSecret, and the URL must be reachable over public HTTPS
- inbound messages are ignored: the sender is not on the allowlist, or the event is not one of the supported message types (group at-message, C2C, guild at-message, guild direct message)
- sends fail after a few minutes: the passive-reply window passed; message the bot again (replies do not fall back to active sends)
- `QQBot target must be group:, user:, channel: or dm:`: fix the target prefix

## WeCom

Official reference:

- https://developer.work.weixin.qq.com/document/path/90664

WeCom sends application text messages to a user (`user:<userid>` or a bare userid), department (`party:<id>`) or tag (`tag:<id>`). Outbound is text-only: a send with attachments fails with a clear error, and text above 2,048 bytes is refused (WeCom would silently truncate it), so replies are split into chunks of at most 680 characters. Reactions and unsend are not supported by this adapter, and WeCom has no typing indicator for application messages.

The application secret mints an access token that is cached and refreshed; if WeCom reports it invalid or expired (errcode 40014 or 42001) the send retries once with a fresh token. The token travels in the request URL, so GoatCitadel never writes that URL into errors or diagnostics. The gateway host's public IP must be on the application's trusted IP list, otherwise sends fail with errcode 60020.

Inbound is an encrypted callback and stays off until the callback Token and EncodingAESKey are configured. GoatCitadel verifies the SHA-1 signature, decrypts with AES-256-CBC and checks the CorpID before accepting anything. Only plain text messages start turns. Inbound is default-deny: only the WeCom userids in `allowedSenders` can start turns, and an empty list drops everything. A dropped message's `sender_not_allowlisted` diagnostic shows the userid to add.

### Step-by-step

1. Create a WeCom self-built application and note the CorpID, AgentId and Secret.
2. Export the Secret in the gateway environment, for example `WECOM_SECRET`, and add `qyapi.weixin.qq.com` to the network allowlist.
3. Add the gateway host's public IP to the application's trusted IP list.
4. In GoatCitadel `Connections`, add `channel.wecom` and set:
   - `corpId=<CorpID>`
   - `agentId=<AgentId>`
   - `secretEnv=WECOM_SECRET`
   - `defaultTarget=user:<userid>` (optional)
5. For inbound, choose a Token and generate an EncodingAESKey in the application's message-receiving settings, export them (for example `WECOM_CALLBACK_TOKEN` and `WECOM_ENCODING_AES_KEY`) and set `callbackTokenEnv` and `encodingAesKeyEnv`.
6. Save and enable the connection, then set the callback URL in WeCom to `https://<your-gateway>/api/v1/integrations/connections/<connectionId>/wecom/webhook` (the address starts with the public web address from Chat › Messaging › Advanced channel setup). WeCom sends an encrypted `echostr` that GoatCitadel verifies and answers.
7. Add the WeCom userids that may start turns to `allowedSenders`.
8. Run the guided test: it mints a token, reads the application, reports whether the callback credentials are set (a missing Token or EncodingAESKey only disables inbound) and, when you run the explicit send, sends one test message.

### WeCom troubleshooting

- `errcode 40013` or `40001`: the CorpID or Secret is wrong
- `errcode 60020`: the gateway host's public IP is not on the application's trusted IP list
- `errcode 81013` or an invalid-recipient error: the user, department or tag does not exist or cannot see the application
- URL verification fails: the connection must be enabled, and the Token and EncodingAESKey in WeCom must match the stored values exactly
- inbound messages are ignored: the sender is not on the allowlist, or the message is not plain text (events and media are acknowledged and dropped)
- host outside the network allowlist: add `qyapi.weixin.qq.com` before probing or sending

## Validation Checklist Per Channel

## Channel Capabilities And Diagnostics

GoatCitadel now publishes shared channel capability metadata from the same `channel-core` rules used by the gateway and Mission Control. Use this to confirm what a connection really supports before claiming parity.

### Public channel action endpoints

- `POST /api/v1/comms/send`
- `POST /api/v1/comms/reply`
- `POST /api/v1/comms/react`
- `POST /api/v1/comms/unsend`
- `POST /api/v1/comms/typing`
- `POST /api/v1/comms/activity`
- `GET /api/v1/comms/capabilities/:connectionId`
- `GET /api/v1/comms/diagnostics/:connectionId`

### What capabilities cover

Each connection advertises:

- supported actions such as `channel.send`, `channel.reply`, `channel.react`, `channel.unsend`, `channel.typing`, and `channel.activity`
- supported attachment sources
- inbound mode (`outbound-only`, `webhook`, `gateway`, or `poll`)
- thread and reply support
- runtime policy flags such as pairing or allowlists
- setup readiness plus actionable diagnostics

Mission Control reads the same capability payload, so the UI and API should agree.

Shared channel activity uses `channel.activity` as a best-effort operator signal. The default transient phases are `seen` (`👀`), `thinking` (`🧠`), `tooling` (`🔧`), `waiting_approval` (`⚠️`), `failed` (`❌`), and `clear`; successful completion clears the transient badge instead of leaving a permanent success reaction.

### Maturity semantics

Channel maturity is now truth-based:

- `native`: built-in and broadly supported in the current runtime
- `beta`: implemented in the current runtime but still stabilizing
- `plugin`: available through an installed plugin adapter
- `disabled`: cataloged but not available in the current runtime

Visible built-in channels must now resolve to `native` or `beta` in the catalog. Runtime availability remains a separate signal so operators can distinguish between "implemented but currently blocked" and "implemented and runnable now."

- `maturity` answers "how complete is parity?"
- runtime availability answers "can an operator wire this up in the current runtime?"
- visible built-in channels no longer use legacy planned-state treatment in Mission Control; blocked setups stay visible with explicit diagnostics and operator-readable next actions

- [ ] Connection create succeeds.
- [ ] Health or connectivity check succeeds.
- [ ] Send test message succeeds.
- [ ] Capability and diagnostics endpoints reflect the real runtime behavior.
- [ ] Bad token errors are readable.
- [ ] Missing permission errors are readable.
- [ ] Approval and policy boundaries still apply.

## Security Checklist Before Sharing A Channel Publicly

- [ ] GoatCitadel is not exposed remotely with `auth.mode=none`.
- [ ] Channel token is stored only in an env var.
- [ ] Break-glass env vars are disabled.
- [ ] Test server or sandbox channel is separate from production/community channels.
- [ ] Token rotation plan exists if a token is exposed.
