# Discord and Slack Setup Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "+ Add" on Messaging opens a one-page setup for Discord and for Slack, like Telegram's. Each page checks itself, never asks for an ID or an environment variable, and ends with an in-place Turn on. Slack gains Socket Mode, so it receives messages with no public web address.

**Architecture:**
- **Gateway: setup checks.** Two new draft-only routes, one per channel. Each reads only the vendor's own API with the draft's saved token and returns names, never tokens.
  - **Discord** returns the bot, who made it, whether Message Content Intent is on, the bot's servers and a server's text channels. It also opens the DM channel with the person who made the bot.
  - **Slack** returns the workspace and bot and whether the app-level token is accepted. It finds the person who sent the one-time code to the bot by DM, and lists the channels the bot is in.
- **Gateway: Discord runtime.** The Discord runtime accepts the connection's `ownerActorIds` in DMs and, when they mention the bot, in the chosen channel.
- **Gateway: one Slack event handler.** Slack's inline webhook dispatch moves into one shared handler (as Telegram's did in plan 2). A new Socket Mode stream adapter calls the same handler. The adapter runs in the existing channel stream runtime.
- **Cockpit: two setup pages.** They reuse plan 2's frame: `SetupFrame`, `SetupSteps`, `TurnOnStep`, `useTurnOn` and `turnOnChannelDraft`. Turn on stays the same validate → test → change → approve-in-place sequence. No approval path changes.

**Tech Stack:** TypeScript, Fastify gateway with zod route schemas, discord.js (existing), Node's global `WebSocket` (as the Mattermost adapter uses), React 19 Cockpit with TanStack Query, vitest (happy-dom, `createRoot`/`act`, no Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-25-messaging-in-chat-and-channel-quick-setup-design.md`. The relevant parts are sections 3–6, "Discord", "Slack", "Constraints" and "Calls I made". Plan 2 (`docs/superpowers/plans/2026-10-26-channel-quick-setup.md`) built the frame this plan reuses.

**Program:** plan 3 of 4.
- Plan 1 (#597), plan 2 (#604) and the channel-guide fixes (#608, #611, #616, #620, #630, #631, #633) are merged.
- Plan 4 covers WhatsApp and the public web address setting.

**Calls this plan makes (operator to check):**
- **Discord skips the "say hi" code.**
  - Discord's own API (`GET /applications/@me`) says who made the bot, and that can't be faked. That person becomes the one allowed sender, so the page needs no code step.
  - A bot owned by a Discord team asks which team member it is for.
  - The spec's code step existed because a display name can be faked. This identity is stronger.
- **In the chosen Discord channel, the bot answers only that person, and only when they mention it.**
  - Anyone else there is ignored.
  - Anyone else who DMs the bot gets today's pairing-code reply.
- **Turn on waits for Message Content Intent.** GoatCitadel's Discord connection asks Discord for that intent, and Discord refuses the connection without it. This holds even though DMs alone wouldn't need the intent.
- **Slack's "say hi" uses Slack's Web API, not a setup-time socket.** The page asks every 6 seconds. Each ask reads the bot's newest DM conversations (`conversations.list`, `conversations.history`) for the code. Nothing is kept on the server between asks, as with Telegram. Slack's normal rate limits apply to apps made for your own workspace.
- **Slack's socket address isn't added to the hosts allowlist.**
  - Slack gives a different `wss://…slack.com` address on every connect. So GoatCitadel requires `slack.com` to be allowed, and opens only a `wss:` address under `.slack.com` that Slack returns.
  - Discord's socket works the same way today: `gateway.discord.gg` is in no allowlist.
- **The Slack app is created as "GoatCitadel"** (bot name `goatcitadel`). You can rename it in Slack afterwards.
- **What the Slack app receives:** direct messages, plus mentions in channels it has been added to. It doesn't receive every message in a channel. Voice messages over Socket Mode are left out, because they need an extra file-reading scope.
- **Settings keeps Discord's and Slack's guides for the other ways.** Those are Discord webhook-only, Slack webhook-only and Slack OAuth. The picker opens the new Chat pages, and only Telegram sends new setups from Settings to Chat. A draft made on a Chat page resumes on that page.
- **No new dependencies.**
- **Already done elsewhere:** the spec asks to drop the "approve the hosted GoatCitadel Slack app" wording, and it is already gone (`slack.copy.test.ts` asserts that). The Slack OAuth path stays as an advanced option in Settings, unchanged.

## Global Constraints

**Providers and scope**
- Official provider APIs only. Nothing may get an account banned.
  - **Discord REST:** `GET /users/@me`, `GET /applications/@me`, `GET /users/@me/guilds`, `GET /guilds/{id}/channels`, `POST /users/@me/channels`. The base is `https://discord.com/api/v10` and the header is `Authorization: Bot <token>`.
  - **Slack Web API:** `auth.test`, `apps.connections.open`, `conversations.list`, `conversations.history`, `users.info`, all at `https://slack.com/api/`. The header is `Authorization: Bearer <token>`.
  - **Slack Socket Mode:** the URL `apps.connections.open` returns.
- Vendor facts this plan relies on. Each was checked against the vendor's docs on 2026-10-28; nothing beyond them may ship as a vendor claim:
  - **Discord application flags:** `GATEWAY_MESSAGE_CONTENT` is `1 << 18` and `GATEWAY_MESSAGE_CONTENT_LIMITED` is `1 << 19`. Either bit means the intent is on.
  - **Discord teams:** `team.owner_user_id`, and `team.members[].membership_state`, where 2 = accepted.
  - **Discord invite:** `https://discord.com/oauth2/authorize?client_id=<applicationId>&scope=bot+applications.commands&permissions=68608`. 68608 = View Channel (1024) + Send Messages (2048) + Read Message History (65536).
  - **Discord DMs:** messages in DMs with the app, and messages that mention the app, carry their content without the intent.
  - **Slack create-from-manifest link:** `https://api.slack.com/apps?new_app=1&manifest_json=<URL-encoded JSON>`.
  - **Slack manifest limits:** `display_information.name` is at most 35 characters. `features.bot_user.display_name` uses only `a-z0-9-_.`.
  - **Slack app-level tokens** start with `xapp-` and are made under Basic Information › App-Level Tokens with the `connections:write` scope. Bot tokens start with `xoxb-`.
  - **`apps.connections.open`:** a POST with the app token in the `Authorization` header. It returns `{ok, url}`.
  - **Socket Mode envelopes:** `hello`, `disconnect` (`reason`: `warning`, `refresh_requested`, `link_disabled`), `events_api`, `slash_commands` and `interactive`. Each envelope is acknowledged by sending back `{"envelope_id": …}`. Slack refreshes a connection "once every few hours".
  - **Event scopes:** `message.im` needs `im:history`.
  - **`conversations.list`** is Tier 2 (20+ a minute), with `types` among `public_channel,private_channel,mpim,im`.
- Changes go in the Cockpit only (`apps/mission-control-next/src/cockpit`), plus the two Settings call sites named in Task 7. The Classic shell is not changed.

**Design and Cockpit guards**
- `DESIGN.md` rules apply:
  - sentence case
  - the shared status vocabulary
  - names before IDs (IDs only in `TechnicalDetails`)
  - `variant="danger"` only for irreversible actions
  - both themes and phone width
  - `TimeText` for times and `plural()` for counts
- Cockpit copy may not use "owner", "owners", "Gateway", "evidence", "revision", "snapshot" or "replay" (`check-mission-control-next-cockpit-copy.mjs`; Cockpit budgets are 0).
  - Write "who made the bot", not "owner".
  - Write "GoatCitadel", not "Gateway".
- No new live regions. Each page's only status line is `SetupSteps`'s. `LIVE_REGION_BUDGET` stays at 900, and `Callout` takes `announce={false}`.
- At most 400 lines per non-test Cockpit file (`eslint.config.mjs`). Split a page before it gets there.
- Other Cockpit checks:
  - the raw-values ratchet
  - no arbitrary Tailwind values
  - each aria-label starts with the visible text
  - `cockpitInputClass` on text inputs

**Gateway ownership, secrets and approvals**
- Mission Control is an API client. Drafts, connections, cursors and plans are all owned by the gateway.
- Approval is not weakened. Turn on runs plan 2's `turnOnChannelDraft` unchanged in its approval behaviour.
- **Tokens and socket addresses never leak:**
  - A bot token, app-level token or Socket Mode URL never appears in an error message, diagnostic, runtime status, log line, response or rendered text. The URL counts because it carries a connection ticket.
  - Errors are fixed sentences. Never build one from `error.message`, a URL or a response body.
- **Saved secrets** are read through the owner-checked resolver from the channel-guide fixes. That is the setup host's `resolveConnectionSecret(config, directKey, envKey, catalogId, owner)`, and the stream runtime's shared `resolveSecret`. An `*Env` name is read only when `isPermittedIntegrationSecretEnvVarName` allows it. Slack's catalog key allows `SLACK_…` names.
- **The setup checks are read-only toward the vendor.** The single exception is Discord's `POST /users/@me/channels`, which opens (or finds) a DM channel and sends nothing. The check refuses to open one with anyone who didn't make the bot.

**Storage and dependencies**
- No new tables or migrations, and no new dependencies.
- New state lives in existing places:
  - Draft values carry `setupCode`, `setupPage`, `ownerActorIds`, `applicationId`, `receiveMode`, `slackTeamId`, `slackTeamName` and `slackBotUserId`.
  - The new secret field key is `appToken`.

**Architecture metrics**
- Never run `architecture:baseline:update`.
- `pnpm verify:architecture:metrics` passes on main today. If it fails for anything other than an allowance below, stop and ask the operator, naming the file and the counts.
- Operator-approved allowances for this plan (C0 entries in `scripts/verification/baselines/architecture-new-service-allowances.json`). Set each entry to the measured count:

  | File | Host callbacks | Dependency reads |
  |---|---|---|
  | `apps/gateway/src/services/channel-setup-discord-check.ts` | up to 10 | up to 10 |
  | `apps/gateway/src/services/channel-setup-slack-check.ts` | up to 10 | up to 10 |
  | `apps/gateway/src/services/slack-event-processor.ts` | 0 | up to 10 |
  | `apps/gateway/src/services/channel-stream-adapters/slack-socket-stream-adapter.ts` | 0 | up to 8 |

- Every other file keeps its count and cap. In particular:

  | File | Count / cap |
  |---|---|
  | `channel-stream-runtime-registry.ts` | 8/8 |
  | `integration-channel-service.ts` | 59/59 |
  | `channel-setup-service.ts` | 55/56 host, 61/61 dependency |
  | `discord-runtime-service.ts` | 112 dependency |
  | `gateway-route-composition-integrations.ts` | ≤ 105 (102 today) |
  | `gateway-service.ts` | ≤ 13132 lines (13101 today) |

  This plan should not touch `gateway-service.ts`.

**Working practices**
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`) before running tests in other packages.
- Run heavy work at low priority:
  - vitest with `--maxWorkers=2`, one heavy job at a time;
  - gateway tests from `apps/gateway` (`pnpm exec vitest run <files> --maxWorkers=2`);
  - Mission Control tests from `apps/mission-control-next`.
- Run Prettier only on files this plan creates, or on already-clean files it touches. Never on a directory glob. The pre-commit hook formats staged files, so a file that wasn't Prettier-clean gets its own `style:` commit first.
- Bump `GUIDED_CONTENT_VERSION_SUFFIX` (`guided-journey.ts`) once, in Task 4, to `.guided-` plus that day's date. It must differ from `.guided-2026-10-28`. Bumping it makes setup tests that already passed run again.
- No personal paths in tracked files.
- Work on branch `feat/channel-setup-discord-slack` in worktree `.claude/worktrees/messaging-in-chat`. Commit only there, and never `git stash`.

## Review Focus

1. **Slack refreshes the socket every few hours.**
   - A `disconnect` with reason `warning` or `refresh_requested` reconnects at once. The status shows no error and the runtime adds no backoff.
   - A `link_disabled` stops, with "Slack turned Socket Mode off for this app.", and the runtime backs off.
   - An hour with no frame at all reconnects quietly (Task 5).
2. **One Slack mention arrives twice.** An OAuth app that subscribes to both `message.channels` and `app_mention` gets the same message as two events with different `event_id`s. It must run one turn, not two (Task 3).
3. **The Discord check is asked to open a DM with someone else.** `directMessageWith` set to an id that isn't the bot's maker, or an accepted member of its team, is refused with 400. Nothing is sent to Discord (Task 1).
4. **A secret leaks through an error.** None of these may put a token, or the Socket Mode URL with its ticket, into `lastError`, a diagnostic, a response or the page (Tasks 1, 5 and 6):
   - a fetch rejection whose message quotes the request;
   - a Slack `ok:false` body;
   - a WebSocket error event.
5. **Someone else reaches the Discord bot.**
   - A DM from anyone but `ownerActorIds` under the `pairing` policy still gets a pairing code and is not accepted.
   - A mention in the chosen channel from anyone else is ignored (Task 2).

---

### Task 1: Discord setup check

**Files:**
- Create: `packages/contracts/src/channel-setup-checks.ts`, and export it from the contracts index the way `channel-setup-operations.ts` is exported
- Create: `apps/gateway/src/services/channel-setup-discord-check.ts`
- Modify: `apps/gateway/src/services/channel-setup-service.ts` (export line, like `discoverChannelSetupTelegramTargets` at :11)
- Modify: `apps/gateway/src/services/channel-setup-route-service.ts` (`channelSetupRouteMethods` and `createChannelSetupRoutePort`)
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts` (the mapping beside :137)
- Modify: `apps/gateway/src/routes/integrations-channel-setup-routes.ts` (new route beside :30-65)
- Modify: `packages/mission-control-shared/src/api/channel-setup-operations.ts`
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json`
- Test: create `apps/gateway/src/services/channel-setup-discord-check.test.ts`
- Test: `apps/gateway/src/routes/integrations.channel-setup.test.ts`

**Interfaces:**
- Produces, in contracts:
  ```ts
  export interface ChannelSetupCheckDraftRef { draftId: string; expectedRevision: number }
  export interface ChannelSetupPerson { id: string; name: string }
  export interface DiscordSetupCheckInput extends ChannelSetupCheckDraftRef {
    /** List this server's text channels. */
    guildId?: string;
    /** Open, or find, the direct-message channel with this person. Only someone in `makers`. */
    directMessageWith?: string;
  }
  export interface DiscordSetupCheckResult {
    bot: ChannelSetupPerson;
    applicationId: string;
    /** Either Message Content Intent flag is on. */
    messageContentIntent: boolean;
    /** Who made the bot: the app's owner, or its team's owner first and then the team's accepted members. */
    makers: ChannelSetupPerson[];
    servers: ChannelSetupPerson[];
    /** Text channels of `guildId`, by position. Present only when `guildId` was asked for and the bot is in it. */
    channels?: ChannelSetupPerson[];
    directChannelId?: string;
  }
  ```
- Produces, in gateway: `checkDiscordSetup(host: ChannelSetupHost, input: DiscordSetupCheckInput): Promise<DiscordSetupCheckResult>`, and the route `POST /api/v1/channels/discord/setup-check`.
- Produces, in the shared client: `checkDiscordSetup(input: DiscordSetupCheckInput): Promise<DiscordSetupCheckResult>`.
- Fixed errors, as `ValidationError` messages:

  | Constant | Message |
  |---|---|
  | `DISCORD_TOKEN_REJECTED` | "Discord didn't accept the bot token." |
  | `DISCORD_UNREACHABLE` | "GoatCitadel couldn't reach Discord." |
  | `DISCORD_DM_REFUSED` | "GoatCitadel opens a direct message only with someone who made the bot." |
  | `DISCORD_DRAFT_ONLY` | "Choose a Discord setup draft to check." |

- [ ] **Step 1: Write the failing tests**

`channel-setup-discord-check.test.ts` uses the fake setup host that `channel-setup-telegram-discovery.test.ts` uses, with a scripted `fetchWithTimeout`:
- `it("names the bot and who made it")`:
  - `/users/@me` returns `{id: "111", username: "goatbot", global_name: "Goat Bot"}`.
  - `/applications/@me` returns `{id: "222", flags: 1 << 19, owner: {id: "333", username: "sam", global_name: "Sam"}}`.
  - The result has `bot {id: "111", name: "Goat Bot"}`, `applicationId: "222"`, `messageContentIntent: true` and `makers: [{id: "333", name: "Sam"}]`.
- `it("reports Message Content Intent off")`. `flags: 0` gives `false`, and `flags: 1 << 18` gives `true`.
- `it("lists a team's owner first, then its accepted members")`. With `team {owner_user_id: "B", members: [A accepted, B accepted, C invited (1)]}`, `makers` is `[B, A]`.
- `it("lists servers, and a server's text channels by position")`. Only `type: 0` channels are returned, sorted by `position`. `channels` is absent for a `guildId` the bot isn't in.
- `it("opens a DM only with someone who made the bot")`:
  - With `directMessageWith: "333"`, the result has `directChannelId` from `POST /users/@me/channels` with body `{recipient_id: "333"}`.
  - With `"999"`, it throws `DISCORD_DM_REFUSED`, and no POST is made.
- `it("says the token was rejected, and never quotes it")`:
  - A 401 on `/users/@me` throws `DISCORD_TOKEN_REJECTED`.
  - A fetch rejection whose message holds `Bot abc.def` throws `DISCORD_UNREACHABLE`, and the message has no `abc.def`.
- `it("checks only Discord drafts")`. A Telegram draft throws `DISCORD_DRAFT_ONLY`.

Route test:
- the body is strict;
- `guildId` and `directMessageWith` must match `^\d{10,25}$`;
- the response has `cache-control: no-store`;
- a `ValidationError` is 400 with its message.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-discord-check.test.ts src/routes/integrations.channel-setup.test.ts --maxWorkers=2`
Expected: FAIL (module not found, route 404).

- [ ] **Step 3: Implement**

**Service.** Mirror `discoverChannelSetupTelegramTargets`:
1. Load the draft and check `expectedRevision`.
2. Build the ephemeral connection the same way.
3. Resolve the token with `host.resolveConnectionSecret(config, "botToken", "botTokenEnv", catalogId, owner)`.
4. Fetch with `host.fetchWithTimeout`, reading bounded JSON as Telegram's does.
5. Make the calls in this order: `/users/@me`, `/applications/@me`, `/users/@me/guilds`, then `/guilds/{guildId}/channels` and the DM open only when asked.
6. A name is `global_name ?? username`.
7. Map every failure to the fixed errors. A non-401 HTTP error is `DISCORD_UNREACHABLE`.

**Route.** Same options as the Telegram route: `logLevel: "silent"`, a rate limit of 20 a minute, `no-store`.

**Allowance.** Measure the new file with the repository counters, then add its C0 entry, capped as approved:
- `reason`: the Discord setup check for the Messaging setup page.
- `evidence`: this test file and the measured counts.
- If the counts exceed the cap, stop and ask.
- `gateway-route-composition-integrations.ts` must stay ≤ 105.

- [ ] **Step 4: Rebuild contracts, run the tests and the gate**

Run: `pnpm --filter @goatcitadel/contracts build`, then the Step 2 command. Then, from the repo root, `pnpm verify:architecture:metrics`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src apps/gateway/src/services/channel-setup-discord-check.ts apps/gateway/src/services/channel-setup-discord-check.test.ts apps/gateway/src/services/channel-setup-service.ts apps/gateway/src/services/channel-setup-route-service.ts apps/gateway/src/services/gateway-route-composition-integrations.ts apps/gateway/src/routes/integrations-channel-setup-routes.ts apps/gateway/src/routes/integrations.channel-setup.test.ts packages/mission-control-shared/src/api/channel-setup-operations.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(discord): a setup check that names the bot, who made it, its servers and channels"
```

### Task 2: Discord lets the person who made the bot in

**Files:**
- Modify: `apps/gateway/src/services/channel-setup-definitions/discord.ts` (`hydrate` :354, `normalize` :397)
- Modify: `apps/gateway/src/services/discord-runtime-service.ts`:
  - `handleDirectMessage` :964
  - the default guild rule at :1284-1304
- Modify: `apps/gateway/src/services/channel-setup-definitions/picker-hints.ts` (Discord `minutes: 5`; update the "Only Telegram sets minutes" comment)
- Test: `discord-runtime-service.test.ts`, `discord-inbound-admission.integration.test.ts`
- Test: create `apps/gateway/src/services/channel-setup-definitions/discord.owner.test.ts`
- Test: `apps/gateway/src/services/channel-setup-definitions/picker-hints.test.ts`

**Interfaces:**
- Produces: the Discord connection config keys `ownerActorIds: string[]` and `applicationId: string`. Both are normalized, hydrated and omitted when empty.
- Uses: `resolveChannelOwnerActorIds` from `packages/contracts/src/channel-access.ts:98`.

- [ ] **Step 1: Write the failing tests**

`discord.owner.test.ts`:
- `it("keeps who made the bot and the application")`. `normalize` of a draft with `ownerActorIds: ["333"]` and `applicationId: "222"` yields both in `config`, and `hydrate` returns them.
- `it("leaves them out when the draft has none")`. Then the saved connection keeps its own.
- `it("passes the setup test with a DM channel as the default")`. Use a gateway-mode draft:
  - `guildPolicy: "off"`;
  - `defaultChannelId` = a DM channel;
  - no `defaultGuildId`;
  - the probe's `GET /channels/{id}` returns `{type: 1}` with no `guild_id`.

  `validate` has no errors, and `discord_channel_access_guild_match` doesn't fail.

Runtime tests, following the existing DM and guild cases:
- `it("accepts a DM from someone in ownerActorIds without pairing")`. Under `inboundDmPolicy: "pairing"`, the message is accepted. No pairing record is written, and no pairing reply is sent.
- `it("still asks anyone else to pair")`.
- `it("answers only ownerActorIds in the default channel when they mention the bot")`. With `defaultGuildId`, `defaultChannelId` and `ownerActorIds: ["333"]`:
  - a mention from 333 is accepted;
  - a mention from 444 is ignored;
  - a message from 333 without a mention is ignored.
- `it("keeps today's channel rule for connections without ownerActorIds")`.

`picker-hints.test.ts`: Discord's tile minutes are 5.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-definitions/discord.owner.test.ts src/services/discord-runtime-service.test.ts src/services/discord-inbound-admission.integration.test.ts src/services/channel-setup-definitions/picker-hints.test.ts --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

**DMs.** In `handleDirectMessage`, a sender in `resolveChannelOwnerActorIds(connection.config)` is handled exactly as an approved pairing is, except that no pairing is touched. This happens after the `disabled` check.

**Default guild rule.** When `ownerActorIds` is non-empty, the rule gains `users: ownerActorIds`. An explicit `config.guilds` rule is unchanged.

**Budget.** `discord-runtime-service.ts` must stay at 112 dependency reads.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command, then `pnpm exec vitest run src/services/channel-setup-definitions src/services/discord-runtime-service.loop25.test.ts src/services/discord-runtime-service.loop27.test.ts src/services/discord-runtime-service.loop32.test.ts --maxWorkers=2`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-setup-definitions/discord.ts apps/gateway/src/services/channel-setup-definitions/discord.owner.test.ts apps/gateway/src/services/discord-runtime-service.ts apps/gateway/src/services/discord-runtime-service.test.ts apps/gateway/src/services/discord-inbound-admission.integration.test.ts apps/gateway/src/services/channel-setup-definitions/picker-hints.ts apps/gateway/src/services/channel-setup-definitions/picker-hints.test.ts
git commit -m "feat(discord): the person who made the bot can message it without pairing"
```

### Task 3: One Slack event handler for the webhook and Socket Mode

**Files:**
- Create: `apps/gateway/src/services/slack-event-processor.ts`
- Modify: `apps/gateway/src/routes/integration-webhooks-slack-routes.ts`. The inline dispatch at :120-171 moves out. The route keeps the signature check and `verifySlackWebhookConnectionBinding`.
- Modify: `apps/gateway/src/services/slack-webhook.ts`:
  - `normalizeSlackWebhookPayload` :122 accepts `app_mention`;
  - `deriveSlackWebhookIdempotencyKey` :113 changes its key.
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json`
- Test: create `apps/gateway/src/services/slack-event-processor.test.ts`
- Test: `apps/gateway/src/services/slack-webhook.test.ts`
- Test (unchanged, must pass): `integrations.webhooks.test.ts`, `integration-webhooks.loop22.test.ts`, `integration-webhooks.rate-limit.test.ts`, `integration-webhooks.security.test.ts`, `integration-webhooks.saved-keys.test.ts`, `integrations.webhooks-voice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SlackEventDeps { webhooks: IntegrationWebhookRoutePort }
  export type SlackDispatchPayload = Extract<SlackWebhookNormalization, { kind: "message" }>;
  /** Today's webhook dispatch, unchanged: returns the body the webhook route sends back. */
  export function dispatchSlackEvent(deps: SlackEventDeps, input: {
    connection: IntegrationConnection; parsed: SlackDispatchPayload; payload: unknown;
  }): Promise<unknown>;
  /** Socket Mode entry: re-reads the connection, normalizes and dispatches. Undefined when the event is ignored. */
  export function runSlackEvent(deps: SlackEventDeps, connectionId: string, payload: unknown): Promise<unknown>;
  ```
- Produces: `SlackWebhookNormalization` covers `app_mention`. The idempotency key is `slack:<connectionId>:message:<channel>:<ts>` whenever the event has a channel and a ts. Otherwise it is today's `event_id` key.

- [ ] **Step 1: Write the failing tests**

`slack-webhook.test.ts`:
- `it("reads an app_mention as a room message without the mention")`. With `event {type: "app_mention", user: "U1", text: "<@UBOT> hello", channel: "C1", ts: "1.2"}` and `botUserId: "UBOT"`, the result is `kind: "message"` with `room: "C1"` and text `"hello"`.
- `it("gives a message and its app_mention the same key")`. Two envelopes with different `event_id`s give one key, `slack:conn-1:message:C1:1.2`.
- `it("keeps the event_id key when there is no channel and ts")`.

`slack-event-processor.test.ts`, with a fake `webhooks` port:
- `it("dispatches a direct message as the webhook did")`. `acceptInboundChannelEvent` receives channel `"slack"`, a direct conversation with `counterpartActorId: "U1"`, and the same `inboundAccessConfig`.
- `it("runSlackEvent reads the connection fresh and only for Socket Mode connections")`:
  - a connection with `receiveMode: "webhook"` returns `undefined` without dispatching;
  - so does one that is disabled or not `connected`.
- `it("runSlackEvent drops another workspace's event")`. `team_id: "T2"` against `config.slackTeamId: "T1"` returns `undefined`.
- `it("runSlackEvent ignores the bot's own messages and url_verification")`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/slack-event-processor.test.ts src/services/slack-webhook.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Move the code and add the two behaviours**

**Moving the dispatch.**
- Move the route's dispatch body, unchanged, into `dispatchSlackEvent`. That includes the voice branch. `integrationWebhooks` becomes `deps.webhooks`.
- The route calls `dispatchSlackEvent({ webhooks: fastify.services.integrationWebhooks }, …)`.

**`runSlackEvent`** runs these steps:
1. Reads the connection with `deps.webhooks.getIntegrationConnection`.
2. Returns `undefined` unless the connection is enabled, `connected`, and has `config.receiveMode === "socket"`.
3. Reads the voice flag with `deps.webhooks.isVoiceInboundEnabled`, treating a failure as off.
4. Drops a `team_id` that differs from a set `config.slackTeamId`.
5. Normalizes with `botUserId: config.slackBotUserId` and `appId: config.slackAppId`.
6. Dispatches any `message` result.

**The mention.** Strip a leading `<@botUserId>` and the whitespace after it.

**Allowance.** Measure the new file and add its C0 entry, capped at 10 as approved.

- [ ] **Step 4: Run the tests and the gate**

Run (from `apps/gateway`): the Step 2 command and the six unchanged route tests. Then, from the repo root, `pnpm verify:architecture:metrics`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/slack-event-processor.ts apps/gateway/src/services/slack-event-processor.test.ts apps/gateway/src/services/slack-webhook.ts apps/gateway/src/services/slack-webhook.test.ts apps/gateway/src/routes/integration-webhooks-slack-routes.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "refactor(slack): one event handler for the webhook and Socket Mode; mentions count once"
```

### Task 4: Slack gets a receive mode and an app-level token

**Files:**
- Modify: `apps/gateway/src/services/channel-setup-definitions/slack.ts`:
  - fields
  - `secretFieldKeys` :301
  - `hydrate` :340
  - `normalize` :384
  - `validate` :413
- Modify: `apps/gateway/src/services/channel-setup-definitions/guided-journey.ts`:
  - `POSTURE.slack` :37-47
  - `GUIDED_CONTENT_VERSION_SUFFIX` :216
- Modify: `apps/gateway/src/services/channel-setup-definitions/picker-hints.ts` (Slack entries)
- Modify: `apps/gateway/src/services/integration-catalog.ts` (`channel.slack` fields)
- Modify: `packages/gateway-core/src/channel-core.ts`:
  - Slack `resolveInboundModes` :182
  - posture and support notes :187-226
  - a new `isSlackSocketInboundEnabled` beside `isMattermostInboundEnabled` :1382
- Modify: `apps/gateway/src/services/channel-bot-live-probes.ts` (`runSlackBotLiveChecks` :101)
- Modify: `apps/gateway/src/services/integration-diagnostics-service.ts` (the Slack call at :690)
- Test: create `apps/gateway/src/services/channel-setup-definitions/slack.receive-mode.test.ts`
- Test: `slack.copy.test.ts`, `picker-hints.test.ts`
- Test: `packages/gateway-core/src/channel-core.test.ts`
- Test: the Slack probe tests beside `channel-bot-live-probes.ts`

**Interfaces:**
- Produces: the Slack config keys `receiveMode: "socket" | "webhook"` and `ownerActorIds: string[]`, plus the secret `appToken` (and its `appTokenEnv`).
- Produces: `isSlackSocketInboundEnabled(config): boolean`, which is true for `receiveMode === "socket"`. `inboundModes` is `["stream"]` for a socket connection.
- Produces: the probe step `slack_socket_auth`.

- [ ] **Step 1: Write the failing tests**

`slack.receive-mode.test.ts`:
- `it("offers two ways to receive, today's by default")`. `receiveMode` is an advanced select with `defaultValue: "webhook"` and the two labels from Step 3.
- `it("asks for the app-level token only for Socket Mode")`. `appToken` and `appTokenEnv` have `visibleWhenFieldEquals: {fieldKey: "receiveMode", value: "socket"}`, and `secretFieldKeys` includes `"appToken"`.
- `it("hydrates older connections as webhook connections")`. A config without `receiveMode` hydrates `receiveMode: "webhook"`, and `receiveMode: "socket"` stays `"socket"`.
- `it("keeps the mode, the token reference and who said hi")`. `normalize` carries `receiveMode`, `appToken`/`appTokenEnv` and `ownerActorIds` (omitted when empty).
- `it("needs an app-level token for Socket Mode")`. `validate` raises:
  - "Socket Mode needs the app-level token." on `appToken` when neither key is set;
  - "App-level tokens start with xapp-." for a typed value that doesn't.

`picker-hints.test.ts`:
- Slack's tile has `minutes: 5` and no note.
- `slack.com` is needed when any of `botToken`, `slackInstallId`, `appToken` or `appTokenEnv` is set.
- The inbound webhook shows only when `receiveMode` is `"webhook"`.

`slack.copy.test.ts`: the posture copy in Step 3, and the content version ending in the new suffix.

`channel-core.test.ts`:
- `receiveMode: "socket"` gives `["stream"]`.
- A webhook connection with a signing secret still gives `["webhook"]`, and without one `["none"]`.

Probe test: with `appToken`, the checks include `slack_socket_auth`, which:
- passes on `{ok: true}`;
- fails "Slack didn't accept the app-level token." on `{ok: false, error: "invalid_auth"}`;
- never opens a socket;
- never puts the token in a step's detail.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-definitions/slack.receive-mode.test.ts src/services/channel-setup-definitions/slack.copy.test.ts src/services/channel-setup-definitions/picker-hints.test.ts src/services/channel-bot-live-probes.test.ts --maxWorkers=2`, then `pnpm --filter @goatcitadel/gateway-core exec vitest run src/channel-core.test.ts --maxWorkers=2`.
Expected: FAIL on the new cases. If the probe tests live in another file, use that file and say so in the report.

- [ ] **Step 3: Implement**

**Fields.**
- `receiveMode` option labels:

  | Value | Label |
  |---|---|
  | `socket` | "GoatCitadel keeps a connection open to Slack (no public web address needed)" |
  | `webhook` | "Slack sends events to a public web address (needs an OAuth install)" |

- `appToken`:
  - type secret, sensitive;
  - label "App-level token", placeholder `xapp-…`;
  - help "From Basic Information › App-Level Tokens in your Slack app, with the connections:write scope."
- `appTokenEnv`: follows `botTokenEnv` through `secretEnvFieldCopy`, placeholder `SLACK_APP_TOKEN`.
- **Catalog:** add `appTokenEnv` to the catalog fields the way `botTokenEnv` is listed.

**`POSTURE.slack.summary`** (exact): "Send messages from your own Slack app into the channels you choose. To receive messages without a public web address, set Slack up from Messaging in Chat. Here, receiving needs an app installed with OAuth and a public HTTPS address." Leave the other posture lines as they are.

**Suffix.** Bump `GUIDED_CONTENT_VERSION_SUFFIX` as Global Constraints say.

**`channel-core.ts`:** for socket mode, the support note reads "Receives direct messages and mentions over a connection GoatCitadel keeps open to Slack; no public web address is needed."

**Probe.** `slack_socket_auth` POSTs `apps.connections.open` and reads only `ok`, never the URL. Its label is "App-level token". The diagnostics caller resolves `appToken` with the resolver it already uses for `botToken`. If that adds a counted dependency read to `integration-diagnostics-service.ts`, stop and ask.

- [ ] **Step 4: Rebuild and run the tests**

Run: `pnpm --filter @goatcitadel/contracts build` (only if contracts changed), then the Step 2 commands, then (from `apps/gateway`) `pnpm exec vitest run src/services/channel-setup-definitions src/services/integration-diagnostics --maxWorkers=2`.
Expected: PASS. Every guide's content version now ends in the new suffix.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-setup-definitions apps/gateway/src/services/integration-catalog.ts packages/gateway-core/src/channel-core.ts packages/gateway-core/src/channel-core.test.ts apps/gateway/src/services/channel-bot-live-probes.ts apps/gateway/src/services/channel-bot-live-probes.test.ts apps/gateway/src/services/integration-diagnostics-service.ts
git commit -m "feat(slack): a Socket Mode receive mode with an app-level token, checked by the setup test"
```

### Task 5: Slack receives over Socket Mode

**Files:**
- Create: `apps/gateway/src/services/channel-stream-adapters/slack-socket-stream-adapter.ts`
- Modify: `apps/gateway/src/services/channel-stream-runtime-registry.ts`:
  - register the adapter;
  - rename `provideTelegramUpdateDeps` to `provideChannelUpdateDeps` and its WeakMap to `channelUpdateHandlers`;
  - Slack's `processEvent` reads the same entry lazily.
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts:354` (the renamed call)
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json`
- Test: create `apps/gateway/src/services/channel-stream-adapters/slack-socket-stream-adapter.test.ts`
- Test: `apps/gateway/src/services/channel-stream-runtime-registry.test.ts`

**Interfaces:**
- Consumes: `runSlackEvent` (Task 3) and `isSlackSocketInboundEnabled` (Task 4).
- Produces:
  ```ts
  export interface SlackSocketLike {
    send(data: string): void; close(): void;
    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
  }
  export interface SlackSocketStreamAdapterDeps {
    fetch: typeof fetch;
    resolveSecret(config: Record<string, unknown>, directKey: string, envKey: string, catalogId?: string): string | undefined;
    isUrlAllowlisted(urlValue: string): boolean;
    createWebSocket(url: string): SlackSocketLike;
    processEvent(connectionId: string, payload: unknown): Promise<unknown>;
  }
  export function createSlackSocketStreamAdapter(deps: SlackSocketStreamAdapterDeps): ChannelStreamAdapter;
  export function provideChannelUpdateDeps(host: Pick<ChannelStreamRuntimeHost, "storage">, deps: TelegramUpdateDeps): void;
  ```
- Constants: `QUIET_RECONNECT_MS = 3_600_000` and `OPEN_TIMEOUT_MS = 15_000`. The adapter sets no `idleTimeoutMs`.

**Fixed errors:**

| When | Error |
|---|---|
| no app-level token | `ChannelStreamAuthError("Slack has no app-level token.")` |
| `slack.com` isn't allowed | `Error("GoatCitadel isn't allowed to reach slack.com.")` |
| `ok:false` with `invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive`, `not_allowed_token_type` or `missing_scope` | `ChannelStreamAuthError("Slack didn't accept the app-level token.")` |
| HTTP 429 or `ratelimited` | `Error("Slack asked GoatCitadel to wait before connecting again.")` |
| any other `ok:false` or HTTP error | `Error("Slack couldn't open a connection.")` |
| network failure | `Error("GoatCitadel couldn't reach Slack.")` |
| a returned URL that isn't `wss:` on a host ending in `.slack.com` | `Error("Slack returned an address GoatCitadel won't open.")` |
| `disconnect` with `link_disabled` | `Error("Slack turned Socket Mode off for this app.")` |
| the socket closes, or errors, without a `disconnect` | `Error("The connection to Slack closed.")` |

- [ ] **Step 1: Write the failing tests**

`slack-socket-stream-adapter.test.ts` uses a scripted fake `fetch`, a fake socket that records `send` and lets the test push frames, and a fake `ctx` like the Telegram adapter test's:
- `it("runs only for Socket Mode connections")`.
- `it("opens the address Slack returns and is ready on hello")`:
  - `apps.connections.open` was POSTed with `Authorization: Bearer xapp-1`;
  - `createWebSocket` got the returned URL;
  - `markReady` is called after a `{type: "hello"}` frame.
- `it("handles an event, then acknowledges it")`. An `events_api` frame `{envelope_id: "e1", payload: P}` causes:
  - `processEvent("conn-1", P)` through `ctx.handle`;
  - then `send('{"envelope_id":"e1"}')`.

  Two frames are handled in order.
- `it("acknowledges commands and interactions without handling them")`.
- `it("reconnects at once when Slack refreshes the connection")`. A `disconnect` with `refresh_requested`:
  - closes the socket;
  - makes a second `apps.connections.open` call;
  - opens a second socket;
  - does not reject `run`.
- `it("reconnects after an hour of quiet")`. Use fake timers.
- `it("stops when Socket Mode is turned off")`. `link_disabled` rejects with the fixed error.
- `it("won't open an address outside slack.com")`. Each of `wss://evil.example/link`, `ws://wss.slack.com/x` and `wss://slack.com.evil.example/x` rejects with the fixed error, and `createWebSocket` is not called.
- `it("maps every failure to a fixed sentence and never shows a secret")`. For each row of the errors table, the thrown message equals the table's. It contains neither `xapp-1` nor `ticket=`, even when fetch rejects with a message that quotes both.

`channel-stream-runtime-registry.test.ts`:
- the runtime has a `slack` adapter;
- before `provideChannelUpdateDeps`, its `processEvent` rejects with `Error("Slack receiving isn't ready yet.")`;
- the Telegram cases pass with the renamed provider.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-stream-adapters/slack-socket-stream-adapter.test.ts src/services/channel-stream-runtime-registry.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`run(ctx)`:**
1. Resolve the app token with `resolveSecret(config, "appToken", "appTokenEnv", catalogId)`.
2. Check `isUrlAllowlisted("https://slack.com/")`.
3. Loop until `ctx.signal` aborts:
   1. Open a URL with `AbortSignal.any([ctx.signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)])`.
   2. Validate the URL with `new URL()`.
   3. Serve the socket until a refresh, the quiet timer, or a failure.
4. On each frame:
   - call `ctx.touch()`;
   - parse only string data as JSON, ignoring anything that doesn't parse;
   - chain `events_api` handling so frames run in order;
   - acknowledge after `ctx.handle` resolves.
5. Close the socket on abort.

**Registry:**
- Build the adapter from the same `sharedDeps` that Mattermost uses, with `createWebSocket: (url) => new WebSocket(url)`.
- `processEvent` looks up `channelUpdateHandlers` at call time and calls `runSlackEvent({ webhooks: deps.webhooks }, …)`.
- The registry must measure 8/8 afterwards. If it can't, stop and ask.

**Allowance:** add the adapter's C0 entry with the measured count, capped at 8.

- [ ] **Step 4: Run the tests and the gate**

Run: the Step 2 command, then (from `apps/gateway`) `pnpm exec vitest run src/services/channel-stream-adapters src/services/channel-stream-runtime-service.test.ts src/services/gateway-runtime-factory.channel-streams.test.ts --maxWorkers=2`. Then, from the repo root, `pnpm verify:architecture:metrics`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-stream-adapters/slack-socket-stream-adapter.ts apps/gateway/src/services/channel-stream-adapters/slack-socket-stream-adapter.test.ts apps/gateway/src/services/channel-stream-runtime-registry.ts apps/gateway/src/services/channel-stream-runtime-registry.test.ts apps/gateway/src/services/gateway-route-composition-integrations.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(slack): receive over Socket Mode, no public web address needed"
```

### Task 6: Slack setup check

**Files:**
- Modify: `packages/contracts/src/channel-setup-checks.ts`
- Create: `apps/gateway/src/services/channel-setup-slack-check.ts`
- Modify: the same wiring files as Task 1:
  - `channel-setup-service.ts`
  - `channel-setup-route-service.ts`
  - `gateway-route-composition-integrations.ts`
  - `integrations-channel-setup-routes.ts`
  - the shared client
  - the allowances
- Test: create `apps/gateway/src/services/channel-setup-slack-check.test.ts`
- Test: `apps/gateway/src/routes/integrations.channel-setup.test.ts`

**Interfaces:**
- Produces, in contracts:
  ```ts
  export interface SlackSetupCheckInput extends ChannelSetupCheckDraftRef {
    checkAppToken?: true;
    /** Look for this code in the bot's newest direct messages. */
    setupCode?: string;
    listChannels?: true;
  }
  export interface SlackSetupCodeSender { actorId: string; directChannelId: string; displayName?: string }
  export interface SlackSetupCheckResult {
    workspace: { id: string; name: string };
    bot: { userId: string; name: string };
    appToken?: "ok" | "rejected" | "missing";
    codeSender?: SlackSetupCodeSender;
    /** The bot has more direct-message conversations than GoatCitadel looked at. */
    manyConversations?: true;
    /** Channels the bot is in, by name. */
    channels?: Array<{ id: string; name: string; private: boolean }>;
  }
  ```
- Produces: `checkSlackSetup(host: ChannelSetupHost, input: SlackSetupCheckInput): Promise<SlackSetupCheckResult>`, the route `POST /api/v1/channels/slack/setup-check`, and the shared client `checkSlackSetup(input)`.
- Constants: `SLACK_SAY_HI_CONVERSATIONS = 5` and `SLACK_HISTORY_LIMIT = 20`.
- Fixed errors:

  | Constant | Message |
  |---|---|
  | `SLACK_BOT_TOKEN_REJECTED` | "Slack didn't accept the bot token." |
  | `SLACK_UNREACHABLE` | "GoatCitadel couldn't reach Slack." |
  | `SLACK_DRAFT_ONLY` | "Choose a Slack setup draft to check." |

- [ ] **Step 1: Write the failing tests**

`channel-setup-slack-check.test.ts`, with the fake setup host and a scripted fetch:
- `it("names the workspace and bot")`. `auth.test` returns `{ok: true, team_id: "T1", team: "Acme", user_id: "UBOT", user: "goatcitadel"}`.
- `it("checks the app-level token only when asked, without opening a socket")`:
  - `{ok: true}` gives `"ok"`;
  - `invalid_auth` gives `"rejected"`;
  - no `appToken` gives `"missing"`;
  - the URL is never returned.
- `it("finds who sent the code in a direct message")`. `conversations.list?types=im` returns IMs D1 (USLACKBOT), D2 (U1) and D3 (deleted user). Only D2's history is read. A message `{type: "message", user: "U1", text: " Ab3dEf7hJk "}` matches, and `users.info` names them from `profile.display_name`, else `profile.real_name`, else `name`.
- `it("ignores the bot, other codes, codes inside other text and edited messages")`. Each of these is not a match:
  - `bot_id` set;
  - `user: "UBOT"`;
  - `hello Ab3dEf7hJk`;
  - `subtype: "message_changed"`.
- `it("looks at five conversations and says when there are more")`. With 7 IMs, 5 histories are read and `manyConversations` is true.
- `it("lists only channels the bot is in")`. Only `is_member` channels are returned, `exclude_archived=true`, with `private` from `is_private`.
- `it("never puts a token in its error")`:
  - `auth.test` `invalid_auth` throws `SLACK_BOT_TOKEN_REJECTED`;
  - a fetch rejection quoting `xoxb-1` throws `SLACK_UNREACHABLE` without it.

Route test:
- a strict body;
- `setupCode` at most 128 characters;
- `no-store`;
- a rate limit of 20 a minute.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-slack-check.test.ts src/routes/integrations.channel-setup.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Service.** Mirror Task 1. The bot token is `botToken`/`botTokenEnv`; the app token is `appToken`/`appTokenEnv`.

**Requests.**
- Use GET with query parameters for the read methods.
- POST `apps.connections.open` with no body.
- A message matches when:
  - its `type` is `"message"`;
  - it has no `subtype` and no `bot_id`;
  - its `user` is set and isn't the bot;
  - its trimmed `text` equals the code.

**Allowance:** add the C0 entry, capped as approved. `gateway-route-composition-integrations.ts` must stay ≤ 105.

- [ ] **Step 4: Rebuild contracts, run the tests and the gate**

Run: `pnpm --filter @goatcitadel/contracts build`, then the Step 2 command, then `pnpm verify:architecture:metrics`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/channel-setup-checks.ts apps/gateway/src/services/channel-setup-slack-check.ts apps/gateway/src/services/channel-setup-slack-check.test.ts apps/gateway/src/services/channel-setup-service.ts apps/gateway/src/services/channel-setup-route-service.ts apps/gateway/src/services/gateway-route-composition-integrations.ts apps/gateway/src/routes/integrations-channel-setup-routes.ts apps/gateway/src/routes/integrations.channel-setup.test.ts packages/mission-control-shared/src/api/channel-setup-operations.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(slack): a setup check that names the bot, finds who said hi and lists its channels"
```

### Task 7: The setup frame serves more than Telegram

**Files** (all in `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/` unless noted):
- Modify: `channel-picker-model.ts`
- Modify: `ChannelSetupView.tsx` (page and key-change dispatch)
- Modify: `TurnOnStep.tsx` (`TurnOnWording` gains `cleanup`)
- Modify: `use-channel-picker-groups.ts` (adds `useChannelSetupHosts`)
- Modify: `BotKeyField.tsx` (wraps the new `TokenField`)
- Modify: `use-telegram-setup.ts` (re-exports `latestDraft` from its new home)
- Create:
  - `setup-draft-session.ts`
  - `use-setup-state.ts`
  - `TokenField.tsx`
  - `PostingChoice.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChannelManageSection.tsx:12-18`
- Check: `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx:41,324` and `ChannelsSection.tsx:102,106`. They keep calling `chatSetupHref` and `chatSetupHrefForDraft`, whose new meaning (below) needs no change at the call site. Change them only if a test shows otherwise.
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/ChannelsSection.tsx:150` (the notice copy)
- Test: `channel-picker-model.test.ts`, `ChannelSetupView.test.tsx`, `TurnOnStep.test.tsx`
- Test: create `setup-draft-session.test.ts`, `use-setup-state.test.ts`, `TokenField.test.tsx`, `PostingChoice.test.tsx`
- Test: `ChannelPage.test.tsx:299-306` (use Mattermost as the no-key-page example), `ChatMainColumn.test.tsx:181-192`, `ChannelsSettings.test.tsx`

**Interfaces:**
- Produces, in `channel-picker-model.ts`:
  ```ts
  export const CONVERTED_SETUP_CHANNELS: ReadonlySet<string>;   // telegram, discord, slack: the picker opens their Chat page
  export const CHAT_ONLY_SETUP_CHANNELS: ReadonlySet<string>;   // telegram: Settings sends new setups to Chat
  export function chatPageHref(definition: Pick<ChannelSetupDefinition, "catalog">): string | undefined;   // picker tiles
  // chatSetupHref keeps its signature and now follows CHAT_ONLY_SETUP_CHANNELS (Settings' create button).
  // chatSetupHrefForDraft also sends a converted channel's draft to Chat when isChatSetupDraft(draft).
  ```
- Produces, in `setup-draft-session.ts`:
  ```ts
  export const CHAT_SETUP_PAGE = "messaging";
  export function isChatSetupDraft(draft: Pick<ChannelSetupDraft, "draft">): boolean;   // draft.draft.setupPage === "messaging"
  /** Unfinished = this catalog, create mode, no connectionId, made on the Chat page. The named one, else the newest. */
  export function chatSetupToResume(drafts: readonly ChannelSetupDraft[], catalogId: string, draftId?: string): ChannelSetupDraft | null;
  export function latestDraft(draftId: string): Promise<ChannelSetupDraft | null>;
  ```
- Produces, in `use-setup-state.ts`. This is the latest-state and stale-reply pattern of `use-telegram-setup.ts:109-128`, made generic:
  ```ts
  export function useSetupState<T extends object>(empty: T): {
    view: T;
    /** The latest state, readable between renders. */
    current(): T;
    /** A setter that drops its writes once `reset` has run since it was made. */
    begin(): (patch: Partial<T>) => void;
    /** Drops every pending setter and returns to `empty`. */
    reset(): void;
  };
  ```
- Produces:
  ```ts
  export function TokenField(props: { label: string; value: string; onChange(value: string): void; busy: boolean;
    placeholder?: string; button?: { label: string; checking: boolean; onCheck(): void } }): JSX.Element;
  export interface PostingOption { value: string; label: string }
  export function PostingChoice(props: { legend: string; options: readonly PostingOption[]; value: string;
    onChange(value: string): void; disabled?: boolean }): JSX.Element;
  // A fieldset of radio inputs; the options keep the given order.
  export function useChannelSetupHosts(catalogId: string, draft: ChannelSetupDraft | null): readonly string[] | undefined;
  // = channelHosts(definition, draft, draft.draft) from channel-wizard-model.ts once both are loaded; undefined before.
  // TurnOnWording gains: cleanup: string (TURN_ON_WORDING.cleanup = CLEANUP_NOTE)
  ```
- Dispatch: `ChannelSetupView` picks the setup page and the key-change page from two maps keyed by channel:
  - **Setup pages:** `{ telegram: TelegramSetupPage, discord: DiscordSetupPage, slack: SlackSetupPage }`. Until Tasks 8 and 10 land, Discord and Slack map to the existing "can't set up from Chat yet" frame.
  - **Key-change pages:** `{ telegram: TelegramKeyChange }`. Task 12 adds Discord and Slack.
  - **The channel page's link:** `ChannelManageSection` links "Change the key" to `channelKeyChangeHref` for every key that has a key-change page.

**Settings copy** (exact, `ChannelsSection.tsx:150`): "Choose a channel, start its guided setup, then save, validate, test, and finalize before runtime use. Telegram is set up on its own page in Chat. Discord and Slack have a quicker page there too."

- [ ] **Step 1: Write the failing tests**

`channel-picker-model.test.ts`:
- Discord's and Slack's tiles go to `/chat/messaging/add/discord` and `/chat/messaging/add/slack`, and their `minutes` are 5.
- `chatSetupHref` is a link only for Telegram.
- `chatSetupHrefForDraft`:
  - sends a Slack create draft with `setupPage: "messaging"` to `/chat/messaging/add/slack?draft=<id>`;
  - doesn't send one without the mark.

`setup-draft-session.test.ts`: `chatSetupToResume` skips:
- unmarked drafts;
- drafts with a `connectionId`;
- other catalogs;
- non-create drafts.

It picks the named draft when that draft qualifies, else the newest.

`use-setup-state.test.ts`: a setter made before `reset` doesn't change `view`; `current()` sees a patch before the next render.

`TurnOnStep.test.tsx`: a wording with its own `cleanup` shows that text in the cleanup state.

`ChannelsSettings.test.tsx`:
- Settings' create button for Slack still opens the Settings guide;
- the notice reads the new copy.

`ChannelSetupView.test.tsx`: every Telegram case still passes.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup src/cockpit/areas/chat/ChannelPage.test.tsx src/cockpit/areas/chat/ChatMainColumn.test.tsx src/cockpit/areas/settings/ChannelsSettings.test.tsx --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

Keep `use-telegram-setup.ts`'s behaviour unchanged. Only `latestDraft` moves out of it; don't rewrite the hook onto `useSetupState`.

- [ ] **Step 4: Run the tests and the Cockpit guards**

Run: the Step 2 command. Then, from the repo root:
- `node scripts/check-mission-control-next-cockpit-copy.mjs`
- `node scripts/check-mission-control-next-cockpit-semantics.mjs`
- `node scripts/check-mission-control-next-cockpit-classes.mjs`
- `node scripts/check-mission-control-next-raw-values.mjs`

Expected: all PASS. The live-region count stays 900.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup apps/mission-control-next/src/cockpit/areas/chat/ChannelManageSection.tsx apps/mission-control-next/src/cockpit/areas/chat/ChannelPage.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.test.tsx apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.test.tsx apps/mission-control-next/src/features/native-routes/settings/sections/ChannelsSection.tsx
git commit -m "refactor(cockpit): the setup frame serves more than Telegram; Settings keeps Discord and Slack guides"
```

### Task 8: Discord's setup page: make the bot and check its token

**Files** (in `channel-setup/`):
- Create:
  - `use-discord-setup.ts`
  - `discord-setup-model.ts`
  - `DiscordSetupPage.tsx`
- Modify: `ChannelSetupView.tsx` (Discord maps to `DiscordSetupPage`)
- Test: create `use-discord-setup.test.ts`, `discord-setup-model.test.ts`, `DiscordSetupPage.test.tsx`

**Interfaces:**
- Consumes: `checkDiscordSetup` (Task 1); `useSetupState`, `chatSetupToResume`, `CHAT_SETUP_PAGE` and `TokenField` (Task 7).
- Produces:
  ```ts
  export const DISCORD_CATALOG_ID = "channel.discord";
  export const DISCORD_TOKEN_FAILED: string;    // the page's failure sentence below
  export interface DiscordSetupState {
    draft: ChannelSetupDraft | null;
    check: DiscordSetupCheckResult | null;      // the last check that worked
    busy: boolean; error?: string;
    checkToken(token: string): Promise<void>;
    /** Checks again with the saved token, after a change in the Developer Portal. */
    recheck(): Promise<void>;
    startOver(): Promise<void>;
  }
  export function useDiscordSetup(workspaceId: string, resumeDraftId?: string): DiscordSetupState;   // Task 9 extends it
  export function discordInviteHref(applicationId: string): string;
  export const DISCORD_DEVELOPER_PORTAL = "https://discord.com/developers/applications";
  ```

**`checkToken(token)`:**
1. Create the draft when there is none: `createChannelSetupDraft({catalogId: DISCORD_CATALOG_ID, lifecycleMode: "create"})`.
2. `submitChannelSetupDraftSecrets(draftId, {expectedRevision, values: {botToken: token}})`.
3. `checkDiscordSetup({draftId, expectedRevision})`.
4. `updateChannelSetupDraft`, merging these into `draft.draft`:
   - `setupPage: CHAT_SETUP_PAGE`
   - `runtimeMode: "gateway"`
   - `applicationId`
   - `inboundDmPolicy: "pairing"`

Resuming uses `chatSetupToResume`. When the saved token is configured, it checks again. Every write carries the latest draft version, through `useSetupState`.

**Page copy** (exact):

*Page*
- Title: "Set up Discord"

*Step 1, "Make your bot"* (place "In Discord's Developer Portal")
- Text: "Open the Developer Portal and choose New Application. Name it, then open Bot and choose Reset Token. Copy the token it shows."
- Link: "Open the Developer Portal" → `DISCORD_DEVELOPER_PORTAL`

*Step 2, "Paste your bot's token"* (place "On this page")
- Field: "Bot token"
- Button: "Check token"
- On success: "Token works. Your bot is <bot.name>."
- On failure: "Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again."
- When `messageContentIntent` is false: "Turn on Message Content Intent: in the Developer Portal, open your app, choose Bot, and switch on Message Content Intent. Then check again." with the button "Check again" (`recheck`). Steps 3–5 stay locked until the intent is on.

*Footer*
- "Start over" (discards the draft)
- "More options in Settings" → `settingsChannelSetupHref("channel.discord")`

- [ ] **Step 1: Write the failing tests**

`discord-setup-model.test.ts`: `discordInviteHref("222")` equals `https://discord.com/oauth2/authorize?client_id=222&scope=bot+applications.commands&permissions=68608`.

`use-discord-setup.test.ts`:
- `it("checks a token: one draft, the token stored securely, the bot named")`. Assert the calls above and the merged draft values.
- `it("shows one plain sentence when the token fails")`. The gateway's message is never shown.
- `it("resumes only a setup made on this page")`.
- `it("checks again with the saved token")`. `recheck` calls `checkDiscordSetup` without submitting a secret.

`DiscordSetupPage.test.tsx`:
- the five step titles: "Make your bot", "Paste your bot's token", "Invite your bot to a server", "Choose where it posts" and "Turn it on";
- steps 3–5 are locked until the token works and the intent is on;
- the intent sentence and "Check again" show for `messageContentIntent: false`;
- the portal link's `href`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new files.

- [ ] **Step 3: Implement as specified above**

The key input comes from `useCredentialInput("channel:<workspaceId>:discord:bot-token", …)`, as Telegram's does. It is discarded once the bot is known, and on unmount.

- [ ] **Step 4: Run the tests and the guards**

Run: the Step 2 command and the four guard scripts from Task 7.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): Discord setup page with a token and Message Content Intent check"
```

### Task 9: Discord: invite, where it posts, Turn on

**Files** (in `channel-setup/`):
- Modify: `use-discord-setup.ts`, `discord-setup-model.ts`, `DiscordSetupPage.tsx`
- Create: `DiscordInviteStep.tsx`
- Test: `use-discord-setup.test.ts`, `discord-setup-model.test.ts`, `DiscordSetupPage.test.tsx`

**Interfaces:**
- Consumes:
  - `listenForHi`, `SETUP_CODE_TTL_MS` and `SAY_HI_POLL_MS` (plan 2);
  - `PostingChoice` and `useChannelSetupHosts` (Task 7);
  - `useTurnOn` and `TurnOnStep` (plan 2).
- Produces:
  ```ts
  export type DiscordPosting = { kind: "direct" } | { kind: "channel"; guildId: string; channelId: string };
  // DiscordSetupState gains:
  waitingForServer: boolean; serverWaitExpired: boolean;
  makerId: string | null;                 // who may message the bot; the only maker is chosen for you
  serverId: string | null; channels: ChannelSetupPerson[] | null;
  posting: DiscordPosting | null;         // saved on the draft
  waitForServer(): void;                  // asks every SAY_HI_POLL_MS until a server shows up, for SETUP_CODE_TTL_MS
  chooseMaker(id: string): Promise<void>;
  chooseServer(guildId: string): Promise<void>;
  choosePosting(posting: DiscordPosting): Promise<void>;
  export function discordTurnOnChanges(input: { makerName: string; posting: DiscordPosting; postingLabel: string;
    missingHosts: readonly string[] }): string[];
  export const DISCORD_TURN_ON_WORDING: TurnOnWording;
  ```

**What the draft gets:**
- **Choosing who** saves `ownerActorIds: [id]`. When only one person made the bot, the page saves that person in the same update that saves the default posting, without asking.
- **When `makers` is empty,** the page says "Discord didn't say who made this bot, so GoatCitadel can't tell who to let in. Use More options in Settings instead." Steps 4 and 5 stay locked.
- **Choosing direct messages:**
  1. Calls `checkDiscordSetup({…, directMessageWith: makerId})`.
  2. Saves `guildPolicy: "off"` and `defaultChannelId: directChannelId`, and drops `defaultGuildId`.
- **Choosing a channel** saves `guildPolicy: "allowlist"`, `defaultGuildId` and `defaultChannelId`.
- **The default.** Direct messages is the default choice. It is saved once the server is known.

**Step copy** (exact):

*Step 3, "Invite your bot to a server"* (place "In Discord")
- Text: "Open the invite link, pick a server, and choose Authorize. You need permission to add apps to that server. A server of your own works."
- Link: "Invite your bot" → `discordInviteHref(applicationId)`
- While waiting: "Waiting for your bot to join a server…"
- When the wait expires: "Still waiting? Open the invite link again." with the button "Check again"
- Done: "Your bot is in <server>." For more than one server: "Your bot is in <n> servers.", using `plural()`.

*Step 4, "Choose where it posts"*
- With more than one maker, first a `PostingChoice` with legend "Your bot belongs to a team. Who can message it?", one option per maker by name.
- With more than one server, a server choice with legend "Which server?".
- A `PostingChoice` with legend "Where should it post?":
  - "Direct messages with <maker>"
  - then, per text channel, "#<channel>, when <maker> mentions it"

*Step 5, "Turn it on"*. Each change is a list item:

| Change | Line |
|---|---|
| Who | "Who can message your bot: <maker>, who made it" |
| Where, for direct messages | "Where it posts: direct messages with <maker>" |
| Where, for a channel | "Where it posts: #<channel> in <server>, and it answers <maker> there when they mention it" |
| How | "How it gets messages: GoatCitadel stays connected to Discord, so no public web address is needed" |
| Test message | "GoatCitadel sends a test message there and then removes it" |
| Hosts | `hostChange(host)` for each missing host |

`DISCORD_TURN_ON_WORDING`:

| Key | Text |
|---|---|
| `button` | "Turn on" |
| `working` | "Turning on…" |
| `done` | "Discord is on. Send your bot a direct message to try it." |
| `doneLink` | "Open Discord's page" |
| `cleanup` | "GoatCitadel couldn't remove its test message. Delete it in Discord if you like." |

- The done link goes to `channelPageHref(draftId)`. A new connection keeps its draft's id (R69 in the channel-guide fixes plan).
- Turn on calls `turnOn({draftId, catalogId: DISCORD_CATALOG_ID, requiredHosts, shownHosts})`, where the hosts come from `useChannelSetupHosts`.

- [ ] **Step 1: Write the failing tests**

`use-discord-setup.test.ts` (fake timers):
- `it("waits for a server every 4 seconds and stops when one shows up")`.
- `it("stops waiting after 10 minutes and when the page closes")`.
- `it("posts in direct messages by default")`. Assert the `directMessageWith` check and the single draft update above.
- `it("saves a chosen channel")`.
- `it("chooses for you when one person made the bot, and asks when a team did")`.

`discord-setup-model.test.ts`: `discordTurnOnChanges` returns exactly the lines above for both posting kinds, with a host line only when that host is missing.

`DiscordSetupPage.test.tsx`:
- "Turn on" calls `turnOnChannelDraft` with `{catalogId: "channel.discord", requiredHosts: ["discord.com"]}`;
- the done state links to `/chat/messaging/<draftId>`;
- the cleanup state shows the Discord sentence.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement as specified above**

Keep every file at or under 400 lines. `DiscordInviteStep.tsx` holds step 3's body.

- [ ] **Step 4: Run the tests and the guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): invite the Discord bot, choose where it posts, then Turn on in place"
```

### Task 10: Slack's setup page: make the app and check two tokens

**Files** (in `channel-setup/`):
- Create:
  - `slack-manifest.ts`
  - `use-slack-setup.ts`
  - `SlackSetupPage.tsx`
- Modify: `ChannelSetupView.tsx` (Slack maps to `SlackSetupPage`)
- Test: create `slack-manifest.test.ts`, `use-slack-setup.test.ts`, `SlackSetupPage.test.tsx`

**Interfaces:**
- Consumes: `checkSlackSetup` (Task 6) and Task 7's pieces.
- Produces:
  ```ts
  export const SLACK_APP_MANIFEST: Readonly<Record<string, unknown>>;   // exactly the JSON below
  export function slackCreateAppHref(): string;   // "https://api.slack.com/apps?new_app=1&manifest_json=" + encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST))
  export const SLACK_CATALOG_ID = "channel.slack";
  export interface SlackSetupState {
    draft: ChannelSetupDraft | null;
    workspace: { id: string; name: string } | null;
    bot: { userId: string; name: string } | null;
    busy: boolean; error?: string;
    checkTokens(botToken: string, appToken: string): Promise<void>;
    startOver(): Promise<void>;
  }
  export function useSlackSetup(workspaceId: string, resumeDraftId?: string): SlackSetupState;   // Task 11 extends it
  ```

**The manifest** (exact):
```json
{
  "_metadata": { "major_version": 2, "minor_version": 1 },
  "display_information": { "name": "GoatCitadel", "description": "Talk to GoatCitadel from Slack." },
  "features": {
    "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "goatcitadel", "always_online": true }
  },
  "oauth_config": {
    "scopes": { "bot": ["app_mentions:read", "channels:read", "chat:write", "groups:read", "im:history", "im:read", "users:read"] }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["app_mention", "message.im"] },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

**`checkTokens(botToken, appToken)`:**
1. Create the draft when there is none.
2. Submit both secrets in one `submitChannelSetupDraftSecrets` call: `{botToken, appToken}`.
3. Call `checkSlackSetup({draftId, expectedRevision, checkAppToken: true})`.
4. If `appToken` isn't `"ok"`, show the app-token failure and save nothing more.
5. Otherwise merge these into `draft.draft`:
   - `setupPage: CHAT_SETUP_PAGE`
   - `receiveMode: "socket"`
   - `slackTeamId`
   - `slackTeamName`
   - `slackBotUserId`

**Page copy** (exact):

*Page*
- Title: "Set up Slack"

*Step 1, "Make your Slack app"* (place "In Slack")
- Text: "This opens Slack with GoatCitadel's app settings filled in. Pick your workspace, choose Next, then Create."
- Link: "Create the Slack app" → `slackCreateAppHref()`

*Step 2, "Install it and copy two tokens"* (place "In Slack, then on this page")
- List items:
  1. "Open OAuth & Permissions, choose Install to Workspace, then Allow. Copy the Bot User OAuth Token. It starts with xoxb-."
  2. "Open Basic Information. Under App-Level Tokens, choose Generate Token and Scopes, add the connections:write scope, and generate it. Copy the token. It starts with xapp-."
- Fields: "Bot token" and "App-level token"
- Button: "Check tokens"
- On success: "Tokens work. Your bot is @<bot.name> in <workspace.name>."
- On a bot-token failure: "Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again."
- On an app-token failure: "Slack didn't accept the app-level token. Check that it has the connections:write scope."

Before shipping step 2's list, confirm the Slack app-settings labels against `docs.slack.dev`: "OAuth & Permissions", "Install to Workspace", "Bot User OAuth Token", "Basic Information", "App-Level Tokens" and "Generate Token and Scopes". Replace any label you can't confirm with plainer words, and say so in the report.

*Footer*
- "Start over"
- "More options in Settings" → `settingsChannelSetupHref("channel.slack")`

- [ ] **Step 1: Write the failing tests**

`slack-manifest.test.ts`:
- `JSON.parse(decodeURIComponent(<the query value>))` equals `SLACK_APP_MANIFEST`;
- `display_information.name` is at most 35 characters;
- `display_name` matches `^[a-z0-9._-]+$`.

`use-slack-setup.test.ts`:
- `it("stores both tokens in one call and names the bot")`.
- `it("stops at a rejected app-level token")`. No draft update follows.
- `it("resumes only a setup made on this page")`.

`SlackSetupPage.test.tsx`:
- the five step titles: "Make your Slack app", "Install it and copy two tokens", "Say hi to your bot", "Choose where it posts" and "Turn it on";
- the create link's `href` starts with `https://api.slack.com/apps?new_app=1&manifest_json=`;
- steps 3–5 are locked until both tokens work;
- the two failure sentences.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new files.

- [ ] **Step 3: Implement as specified above**

Both token inputs come from `useCredentialInput` with the keys `channel:<workspaceId>:slack:bot-token` and `…:app-token`. Both are discarded once the tokens work, and on unmount.

- [ ] **Step 4: Run the tests and the guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): Slack setup page that creates the app from a manifest and checks both tokens"
```

### Task 11: Slack: say hi, where it posts, Turn on

**Files** (in `channel-setup/`):
- Modify: `use-slack-setup.ts`, `SlackSetupPage.tsx`
- Create: `slack-setup-model.ts`, `SlackSayHiStep.tsx`
- Test: `use-slack-setup.test.ts`, `SlackSetupPage.test.tsx`
- Test: create `slack-setup-model.test.ts`

**Interfaces:**
- Consumes: `createSetupCode`, `listenForHi`, `SETUP_CODE_TTL_MS`, `PostingChoice`, `useChannelSetupHosts`, `useTurnOn` and `TurnOnStep`.
- Produces:
  ```ts
  export const SLACK_SAY_HI_POLL_MS = 6_000;   // conversations.list allows about 20 a minute
  export type SlackPosting = { kind: "direct" } | { kind: "channel"; channelId: string };
  // SlackSetupState gains:
  sender: SlackSetupCodeSender | null; code: string | null; codeExpired: boolean; manyConversations: boolean;
  channels: Array<{ id: string; name: string; private: boolean }> | null; posting: SlackPosting | null;
  newCode(): Promise<void>; refreshChannels(): Promise<void>; choosePosting(posting: SlackPosting): Promise<void>;
  export function slackDraftWithSender(values: Record<string, unknown>, sender: SlackSetupCodeSender): Record<string, unknown>;
  export function slackDraftWithPosting(values: Record<string, unknown>, posting: SlackPosting,
    channels: readonly { id: string; name: string; private: boolean }[]): Record<string, unknown>;
  export function slackTurnOnChanges(input: { senderName: string; posting: SlackPosting; channelName?: string;
    missingHosts: readonly string[] }): string[];
  export const SLACK_TURN_ON_WORDING: TurnOnWording;
  ```

**What the draft gets:**
- **`slackDraftWithSender`** sets:
  - `allowedSenders: [actorId]`
  - `ownerActorIds: [actorId]`
  - `inboundAccessMode: "allowlist"`
  - `targets`, holding one default row `{id: "slack:" + directChannelId, label: <name>, channel: directChannelId, kind: "private", source: "recent_update", setupCodeMatched: true}`, merged with `mergeDiscoveredChannelTargets` and `readChannelTargetRows(values.targets, "channel")` as `code-sender.ts` does.
- **`slackDraftWithPosting`, for a channel,** adds `{id: "slack:" + channelId, label: "#" + name, channel: channelId, kind: private ? "group" : "channel", source: "connection_config"}` as the default row. The DM row stays, but isn't the default.
- **Listening.** `newCode()` saves `setupCode`. Every `SLACK_SAY_HI_POLL_MS` it then asks `checkSlackSetup({…, setupCode})`. It stops as Telegram's does: when the sender arrives, when the code expires, on unmount, and when Turn on starts.

**Step copy** (exact):

*Step 3, "Say hi to your bot"* (place "In Slack")
- Text: "In Slack, find @<bot.name> under Apps and send it this code: <code>"
- While waiting: "Waiting for your hi…"
- On success: "<name> said hi. Only they can message your bot for now." The name is `displayName`, else "Someone".
- When expired: "This code expired." with the button "Get a new code"
- When `manyConversations`: "Your bot has many conversations, so GoatCitadel looked only at the newest ones. Send the code again if your hi doesn't show up."

*Step 4, "Choose where it posts"*
- A `PostingChoice` with legend "Where should it post?":
  - "Direct messages with <name>"
  - then, per channel, "#<channel>, when <name> mentions it". A private channel's label ends " (private)".
- Help: "To post in a channel, add your bot there first: in the channel, type /invite @<bot.name>. Then choose Refresh channels."
- Button: "Refresh channels"

*Step 5, "Turn it on"*

| Change | Line |
|---|---|
| Who | "Who can message your bot: <name>" |
| Where, for direct messages | "Where it posts: direct messages with <name>" |
| Where, for a channel | "Where it posts: #<channel>, and it answers <name> there when they mention it" |
| How | "How it gets messages: GoatCitadel keeps a connection open to Slack, so no public web address is needed" |
| Test message | "GoatCitadel sends a test message there and then removes it" |
| Hosts | `hostChange(host)` per missing host |

`SLACK_TURN_ON_WORDING`:

| Key | Text |
|---|---|
| `done` | "Slack is on. Send your bot a message to try it." |
| `doneLink` | "Open Slack's page" |
| `cleanup` | "GoatCitadel couldn't remove its test message. Delete it in Slack if you like." |

`button` and `working` are as Discord's. The done link goes to `channelPageHref(draftId)`.

- [ ] **Step 1: Write the failing tests**

`slack-setup-model.test.ts`:
- `slackDraftWithSender` and `slackDraftWithPosting` give the values above and don't change their input;
- `slackTurnOnChanges` gives the exact lines.

`use-slack-setup.test.ts` (fake timers):
- `it("saves a fresh code and asks every 6 seconds")`.
- `it("stops once someone says hi and makes them the allowed sender")`.
- `it("stops after 10 minutes and offers a new code")`.
- `it("stops when the page closes")`.
- `it("notes many conversations")`.
- `it("lists channels on Refresh channels and saves a chosen one")`.

`SlackSetupPage.test.tsx`:
- "Turn on" calls `turnOnChannelDraft` with `catalogId: "channel.slack"`, and `requiredHosts` equals `["slack.com"]` for a draft with a bot token;
- the done link is `/chat/messaging/<draftId>`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement as specified above**

- [ ] **Step 4: Run the tests and the guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): say hi to the Slack bot, choose where it posts, then Turn on in place"
```

### Task 12: Change Discord's or Slack's tokens from the channel page

**Files** (in `channel-setup/`):
- Create:
  - `ChannelTokenChange.tsx`
  - `use-token-change.ts`
- Modify: `ChannelSetupView.tsx` (key-change map gains Discord and Slack)
- Test: create `ChannelTokenChange.test.tsx` and `use-token-change.test.ts`
- Test: `ChannelPage.test.tsx` and `ChatMainColumn.test.tsx`

**Interfaces:**
- Consumes: `checkDiscordSetup`/`checkSlackSetup`, `TokenField`, `useTurnOn`, `TurnOnStep` and `SAVE_KEY_WORDING` (plan 2).
- Produces: `ChannelTokenChange(props: { connection: IntegrationConnection; workspaceId: string }): JSX.Element` for `key` `"discord"` or `"slack"`.

**Behaviour:**
- **Draft.** Reuse the rotate draft the way `use-telegram-key-change.ts` does (`draftForKeyChange`), else create one with `createChannelRotateSecretDraft(connectionId)`.
- **Check.** Submit the new token(s), then run that channel's check (Slack with `checkAppToken: true`).
- **Bot changed.** Warn when the bot changed:
  - Discord: `applicationId` differs from `config.applicationId`, when that is set.
  - Slack: `bot.userId` differs from `config.slackBotUserId`, when that is set.
- **Save.** Write the new `applicationId`, or the new `slackBotUserId`/`slackTeamId`/`slackTeamName`, to the rotate draft. If the gateway refuses that update for a rotate draft, leave it out. Record that as a ruling in the ledger, and keep the warning.
- **Turn on.** "Save key" runs Turn on with `{ ...SAVE_KEY_WORDING, cleanup: <that channel's cleanup sentence from Tasks 9 and 11> }`. The change list is "GoatCitadel sends a test message there and then removes it" plus any missing host.

**Copy** (exact):

| Element | Text |
|---|---|
| Title | "Change Discord's token" / "Change Slack's tokens" |
| Step 1 | "Paste the new token" / "Paste the new tokens", with the same fields, button and results as Tasks 8 and 10 |
| Bot changed | "This token is for <new>, not <old>. Saving it switches the bot people message." For Slack, "These tokens are…" with "them" |
| Step 2 | "Save the new token" / "Save the new tokens", with the button "Save key". It reuses `SAVE_KEY_WORDING` |

- [ ] **Step 1: Write the failing tests**

`use-token-change.test.ts`:
- it reuses an open rotate draft, else creates one;
- Slack submits both tokens in one call.

`ChannelTokenChange.test.tsx`:
- it shows the bot-change warning;
- "Save key" calls `turnOnChannelDraft` with the rotate draft's id.

`ChannelPage.test.tsx`: "Change the key" is `/chat/messaging/<id>/key` for Telegram, Discord and Slack, and `/settings/connections#channels` for Mattermost.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup src/cockpit/areas/chat/ChannelPage.test.tsx src/cockpit/areas/chat/ChatMainColumn.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement as specified above**

- [ ] **Step 4: Run the tests and the guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup apps/mission-control-next/src/cockpit/areas/chat/ChannelPage.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.test.tsx
git commit -m "feat(cockpit): change Discord's or Slack's tokens from the channel page"
```

### Task 13: Docs, parity and proof

**Files:**
- Modify: `docs/CHANNEL_GUIDED_SETUP.md`. Add "## Discord quick setup" and "## Slack quick setup" after the Telegram section (:47-106), with the same bullets: Where, Receive mode, Who can message the bot, Starting and resuming, Allowed hosts, Changing the key, Settings.
- Modify: `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`. Add a short "Quick setup from Messaging" paragraph at the top of the Discord section (:118) and the Slack section (:222).
- Modify: `CHANGELOG.md` ([Unreleased] › Added: the two setup pages and Slack Socket Mode)
- Modify: `scripts/verification/lib/channel-parity-matrix.mjs` (a Slack Socket Mode row beside the four Slack rows at :72-130, `inboundMode: "stream"`)
- Artifacts (gitignored): `artifacts/channel-quick-setup/` (scripts `*-plan3.mjs`, `shots-plan3/`, report)

- [ ] **Step 1: Update the docs and the parity row**

Write the facts Tasks 1–12 built, and nothing beyond them. Each doc names the calls this plan made that an operator would notice:
- Discord allows the person who made the bot;
- Slack receives DMs and mentions;
- the app is named "GoatCitadel".

- [ ] **Step 2: Run the lanes**

From the repo root, in this order, one at a time:
1. `pnpm typecheck`
2. `pnpm docs:check`
3. `pnpm verify:gateway:async-boundary`
4. `pnpm verify:channels:parity`
5. `pnpm verify:architecture:metrics`
6. `pnpm --filter @goatcitadel/mission-control-next build`
7. `pnpm perf:check:next`
8. the four Cockpit guard scripts
9. `git diff --check`
10. `pnpm verify:fast`

Expected: each exits 0. If `verify:fast` times out in a file this branch doesn't touch, record it, rerun that file alone, and report both results.

- [ ] **Step 3: Browser proof in a sandbox**

Use the plan 2 and PR 4 harness:
- the tracked example config only;
- `GOATCITADEL_DISABLE_SECRET_STORE=true`;
- all outbound traffic blocked and logged.

Capture these screens in light and dark themes, at 1440×900 and 375×812:
- the picker, with Discord and Slack at "About 5 min";
- the Discord page with step 2 current;
- the Discord token-failure sentence (provider blocked);
- the Slack page with step 2 current;
- the Slack create-app link's decoded manifest;
- the Slack token-failure sentence;
- Settings › Channels' notice.

Expected:
- 0 requests reached Discord or Slack;
- 0 console or HTTP errors;
- no token appears in any screenshot, page text or log.

- [ ] **Step 4: Commit**

```bash
git add docs/CHANNEL_GUIDED_SETUP.md docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md CHANGELOG.md scripts/verification/lib/channel-parity-matrix.mjs
git commit -m "docs(channels): Discord and Slack set up from Messaging; Slack receives over Socket Mode"
```

**Not covered by this plan's proof:** live runs against a real Discord bot and a real Slack app. The operator does those after merge:
- Discord: token, intent, invite, DM, mention in the chosen channel, Turn on;
- Slack: manifest create, install, both tokens, hi, DM reply, mention in a channel, Turn on, and a socket refresh after a few hours.
