# Communication Channel Setup Guide

Last updated: 2026-03-29
Target audience: beginner to intermediate operators

This guide walks through GoatCitadel channel setup in the order that makes the most sense for public beta testing.

For parity status and tranche tracking, see [OPENCLAW_PARITY_STATUS.md](./OPENCLAW_PARITY_STATUS.md).

Guided Mission Control setup is currently available for `channel.discord`, `channel.slack`, `channel.telegram`, `channel.google-chat`, and `channel.teams`.

Discord, Slack, Telegram, Google Chat, and Teams guided test/retest flows now run live probe coverage before finalize. Users should still confirm manually that sandbox posts land in the intended destination, especially for webhook-backed channels.

## Guided Beta Channels At A Glance

| Channel | Recommended auth path | Guided test behavior | Manual confirmation still needed |
|---|---|---|---|
| `channel.discord` | Bot token | token, channel, sandbox send/delete, runtime readiness in gateway mode | yes |
| `channel.slack` | Bot User OAuth token | auth plus sandbox send/delete on bot-token path | yes, especially on webhook fallback |
| `channel.telegram` | BotFather token | auth plus sandbox send/delete | yes |
| `channel.google-chat` | Incoming webhook | sandbox webhook probe | yes |
| `channel.teams` | Incoming webhook | sandbox webhook probe | yes |

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

## Validation Checklist Per Channel

## Channel Capabilities And Diagnostics

GoatCitadel now publishes shared channel capability metadata from the same `channel-core` rules used by the gateway and Mission Control. Use this to confirm what a connection really supports before claiming parity.

### Public channel action endpoints

- `POST /api/v1/comms/send`
- `POST /api/v1/comms/reply`
- `POST /api/v1/comms/react`
- `POST /api/v1/comms/unsend`
- `POST /api/v1/comms/typing`
- `GET /api/v1/comms/capabilities/:connectionId`
- `GET /api/v1/comms/diagnostics/:connectionId`

### What capabilities cover

Each connection advertises:

- supported actions such as `channel.send`, `channel.reply`, `channel.react`, `channel.unsend`, and `channel.typing`
- supported attachment sources
- inbound mode (`outbound-only`, `webhook`, `gateway`, or `poll`)
- thread and reply support
- runtime policy flags such as pairing or allowlists
- setup readiness plus actionable diagnostics

Mission Control reads the same capability payload, so the UI and API should agree.

### Maturity semantics

Channel maturity is now truth-based:

- `native`: built-in and broadly supported in the current runtime
- `beta`: implemented in the current runtime but still stabilizing
- `plugin`: available through an installed plugin adapter
- `disabled`: cataloged but not available in the current runtime
- `planned`: roadmap only

Built-in channel bridges that exist but are not yet parity-complete should resolve to `beta`, not `native`.

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
