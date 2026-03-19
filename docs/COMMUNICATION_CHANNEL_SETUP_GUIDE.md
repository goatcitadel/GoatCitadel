# Communication Channel Setup Guide

Last updated: 2026-03-05
Target audience: beginner to intermediate operators

This guide walks through GoatCitadel channel setup in the order that makes the most sense for public beta testing.

## Recommended Rollout Order

1. `channel.tui` for local operator workflows
2. `channel.webchat` for local browser workflows
3. `channel.discord` for first external beta testing
4. `channel.slack` after Discord is stable
5. Telegram / Matrix only as pilot integrations

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

## Discord (Best First External Channel)

Official references:

- Discord Developer Portal: https://discord.com/developers/applications
- Discord getting started docs: https://docs.discord.com/developers/docs/getting-started
- Discord application auth/install model: https://docs.discord.com/developers/resources/application

### What you are creating

You are creating:

1. a Discord application
2. a bot user for that application
3. an install link to add the bot to your server
4. a GoatCitadel integration connection that references the bot token env var

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
    - set a default channel or sandbox room id
14. Send a test message.
15. Confirm the bot can post only where intended.

### Discord troubleshooting

- `401` or `403`: token invalid or scopes/permissions are incomplete
- bot appears offline: check token, installation, and channel permissions
- bot added to server but cannot post: re-check bot role and channel permission overrides
- no message content / command behavior: verify any Discord privileged intent requirements for your exact workflow

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

## Matrix (Pilot)

Reference:

- https://spec.matrix.org/latest/client-server-api/index.html

### Step-by-step

1. Create a Matrix account or service user on your homeserver.
2. Obtain an access token using the homeserver's supported auth flow.
3. Collect the room id(s) you want GoatCitadel to use.
4. Configure the Matrix integration in GoatCitadel with room ids plus token env ref.
5. Validate send-only flow first.

## Validation Checklist Per Channel

- [ ] Connection create succeeds.
- [ ] Health or connectivity check succeeds.
- [ ] Send test message succeeds.
- [ ] Bad token errors are readable.
- [ ] Missing permission errors are readable.
- [ ] Approval and policy boundaries still apply.

## Security Checklist Before Sharing A Channel Publicly

- [ ] GoatCitadel is not exposed remotely with `auth.mode=none`.
- [ ] Channel token is stored only in an env var.
- [ ] Break-glass env vars are disabled.
- [ ] Test server or sandbox channel is separate from production/community channels.
- [ ] Token rotation plan exists if a token is exposed.
