# Communication Channel Setup Guide

Last updated: 2026-04-02
Target audience: beginner to intermediate operators

This guide walks through GoatCitadel channel setup in the order that makes the most sense for operator-facing `1.0` validation.

For parity status and tranche tracking, see [OPENCLAW_PARITY_STATUS.md](./OPENCLAW_PARITY_STATUS.md).

Guided Mission Control setup is currently available for `channel.discord`, `channel.slack`, `channel.telegram`, `channel.google-chat`, `channel.teams`, `channel.whatsapp`, `channel.signal`, `channel.mattermost`, `channel.imessage`, `channel.nextcloud-talk`, `channel.line`, `channel.zalo`, and `channel.zalouser`.

Discord, Slack, Telegram, Google Chat, Teams, Mattermost, WhatsApp, Signal, LINE, iMessage, Zalo OA, and Zalo Personal guided test/retest flows now run live probe coverage before finalize. WhatsApp, Signal, Zalo OA, and Zalo Personal still rely on operator-controlled sandbox targets or bridge-native delivery confirmation for pre-finalize send checks.

## Guided Channel Setup At A Glance

| Channel | Recommended auth path | Guided test behavior | Manual confirmation still needed |
|---|---|---|---|
| `channel.discord` | Bot token | token, channel, sandbox send/delete, runtime readiness in gateway mode | yes |
| `channel.slack` | Bot User OAuth token | auth plus sandbox send/delete on bot-token path | yes, especially on webhook fallback |
| `channel.telegram` | BotFather token | auth plus sandbox send/delete | yes |
| `channel.google-chat` | Incoming webhook | sandbox webhook probe | yes |
| `channel.teams` | Incoming webhook | sandbox webhook probe | yes |
| `channel.mattermost` | Bot token | auth, channel resolution, sandbox send/delete | yes |
| `channel.whatsapp` | Cloud API access token + phone-number id | sender auth plus sandbox send; signed inbound webhook runtime when app secret + verify token are configured | yes |
| `channel.signal` | Bridge URL | sandbox send through the Signal bridge JSON-RPC path | yes |
| `channel.imessage` | BlueBubbles bridge URL + password | bridge query plus sandbox send/unsend | yes |
| `channel.nextcloud-talk` | Base URL + Talk token | structural and semantic validation | yes |
| `channel.line` | Channel access token | token auth plus sandbox push send; signed inbound webhook runtime when channel secret is configured | yes |
| `channel.zalo` | Official Account access token | sandbox send through the OA send path | yes |
| `channel.zalouser` | zca bridge URL + optional bearer token | sandbox send through the bridge text-send path | yes |

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

Official references:

- Discord Developer Portal: https://discord.com/developers/applications
- Discord getting started docs: https://docs.discord.com/developers/docs/getting-started
- Discord application auth/install model: https://docs.discord.com/developers/resources/application

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
7. Generate or reset the bot token.
8. Copy the token into your local environment as `DISCORD_BOT_TOKEN`.

Example:

```env
DISCORD_BOT_TOKEN=your_token_here
```

9. Open the `Installation` section.
10. For scopes, include at least:
    - `applications.commands`
    - `bot`
11. Start with minimal bot permissions:
    - `Send Messages`
    - `Read Message History`
    - `Use Slash Commands` if your workflow needs them
12. Generate the install link and add the bot to your test server.
13. In GoatCitadel Mission Control:
    - open `Connections (Integrations)`
    - create a new integration using `channel.discord`
    - set `botTokenEnv=DISCORD_BOT_TOKEN`
    - set a default channel id
14. For `Bridge`, run the built-in probe and confirm:
    - token auth passes
    - channel access passes
    - sandbox send passes
15. For `Gateway`, also confirm the runtime reports:
    - logged in / ready
    - connected bot identity
    - connected guilds

### Discord troubleshooting

- `401`: token invalid, expired, or copied incorrectly
- `404` on channel probe: wrong channel id or wrong target
- `403` on channel probe or sandbox send: bot is installed, but channel permissions are incomplete
- bridge mode showing "offline": expected, because bridge mode does not establish persistent presence
- gateway mode not ready: confirm the bot token env var is available to the gateway process and the bot is installed in the target server
- webhook-only bridge mode: send-only fallback, no reactions, no inbound routing, no online presence

### Intents and restarts

- Bridge mode does not require a gateway restart because the bot should appear online. Restart only after actual env/config changes.
- Gateway mode needs the usual Discord bot gateway setup and message-content access for inbound routing.
- Privileged-intent guidance matters for gateway mode, not for the default bridge-only path.

## Slack

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

## Telegram (Pilot)

Reference:

- https://core.telegram.org/bots/tutorial

### Step-by-step

1. Open `@BotFather` in Telegram.
2. Run `/newbot`.
3. Follow the naming prompts.
4. Copy the token into `TELEGRAM_BOT_TOKEN`.
5. Add the bot to your target chat/channel and grant send rights.
6. Configure the Telegram channel integration inside GoatCitadel.

Treat Telegram as pilot-only until your sandbox workflow is stable.

### Telegram environment example

```env
TELEGRAM_BOT_TOKEN=123456789:AA...
```

### Telegram troubleshooting

- `401` or auth failure: token is wrong, revoked, or copied incompletely
- send succeeds nowhere: the bot is not actually in the target chat or channel
- delete probe fails: the bot can post but lacks permission to remove the sandbox message
- `@channel_name` works inconsistently: prefer the real chat id when available

## Google Chat

Official reference:

- https://developers.google.com/workspace/chat/quickstart/webhooks

### Step-by-step

1. Open the target Google Chat space.
2. Create an incoming webhook for that space.
3. Copy the full webhook URL.
4. In GoatCitadel `Connections`, add `channel.google-chat`.
5. Paste the webhook URL.
6. Optionally set a default thread key if you want repeated outbound posts to group into a stable thread.
7. Run guided test or retest.
8. Confirm manually that the sandbox post landed in the intended space or thread.

### Google Chat troubleshooting

- validation fails immediately: the value is not a real Google Chat incoming webhook URL
- sandbox probe fails with `404` or `403`: the webhook was deleted, rotated, or tied to a different space
- post lands in an unexpected thread: remove or correct the default thread key
- duplicated sandbox posts before this release: fixed for unchanged drafts in the same gateway process lifecycle

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
8. Confirm manually that the sandbox card arrived in the intended Teams channel.

### Teams troubleshooting

- validation fails immediately: the value is not shaped like a Teams webhook URL
- sandbox webhook probe fails: the connector was removed, rotated, or restricted by the workspace
- card formatting looks plain: expected if the destination strips parts of the adaptive-card payload
- channel mismatch: recreate the webhook from the exact Teams channel you want GoatCitadel to target

## WhatsApp (Cloud API)

Official references:

- https://developers.facebook.com/docs/whatsapp/cloud-api
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started

### Step-by-step

1. Create or select a Meta app with WhatsApp Cloud API access.
2. Generate the Cloud API access token you want GoatCitadel to use for outbound delivery.
3. Record the phone number id for the sending number.
4. Record the Meta app secret and choose a webhook verify token you control.
5. In GoatCitadel `Connections`, add `channel.whatsapp`.
6. Set the outbound/runtime secrets:
   - `accessTokenEnv=WHATSAPP_ACCESS_TOKEN`
   - `appSecretEnv=WHATSAPP_APP_SECRET`
   - `webhookVerifyTokenEnv=WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - `phoneNumberId=<your_meta_phone_number_id>`
7. Point the Meta webhook subscription at:
   - `https://<your-gateway-host>/api/v1/integrations/connections/<connectionId>/whatsapp/webhook`
8. Subscribe to message events, finalize the connection, and confirm manually that:
   - the Meta challenge succeeds
   - an inbound sandbox message lands in GoatCitadel
   - outbound replies still use the expected phone number id

### WhatsApp troubleshooting

- Meta challenge fails: the verify token in Meta does not match GoatCitadel
- inbound `401`: the `x-hub-signature-256` signature does not match the configured app secret
- outbound works but inbound does not: the access token is valid, but the webhook secret pair is missing or stale
- delivery statuses appear without messages: expected when Meta posts status-only payloads; send a real inbound text to validate routing
- local-only gateway URL: Meta cannot call loopback or non-public HTTP endpoints; use a reachable HTTPS URL

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
   - `https://<your-gateway-host>/api/v1/integrations/connections/<connectionId>/line/webhook`
7. Enable webhooks in LINE, finalize the connection, and confirm manually that:
   - LINE accepts the webhook endpoint
   - an inbound sandbox message reaches GoatCitadel
   - group or room replies route back to the expected thread target

### LINE troubleshooting

- inbound `401`: the `x-line-signature` value does not match the configured channel secret
- no inbound events arrive: webhook delivery is disabled in the LINE console or pointed at the wrong connection id
- direct messages work but group routing is wrong: validate the room/group source ids and resend from the intended thread
- `404` from LINE webhook verification: the connection id in the URL is wrong or the route is not reachable from the public internet
- local HTTP URL: LINE requires a reachable HTTPS endpoint for webhook delivery

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
