# Channel Quick Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "+ Add" on Messaging opens a grouped picker of every channel. Telegram gets a one-page setup that checks itself (QR to BotFather, paste one key, say hi, Turn on) and then receives messages with no public web address. Turning on approves the channel's change in place, through the same approval Chat uses, and Settings › Channels points to Messaging.

**Architecture:**
- **Gateway: setup data.** Setup definitions gain picker hints and the provider hosts each channel needs.
- **Gateway: setup check.** Telegram target discovery learns to find the sender of a one-time `/start <code>` and, on the operator's click, clear a webhook.
- **Gateway: one update handler.** Today's Telegram webhook handling moves into one shared function, which a new Telegram long-polling adapter also calls. The adapter runs in the existing channel stream runtime, which already owns lifecycle, backoff, status and cursors.
- **Cockpit: setup page and Turn on.** The setup page lives at new `/chat/messaging/…` routes. Turn on runs the existing calls in order:
  1. validate
  2. test
  3. create the change
  4. confirm it
  5. resolve that change's own approval
  6. continue
- **No new endpoints.** Nothing is added to the gateway route ports or the approval path.

**Tech Stack:** TypeScript, Fastify gateway, `@goatcitadel/storage`, React 19 Cockpit with TanStack Query, vitest (happy-dom, `createRoot`/`act`, no Testing Library), `uqr` for QR codes.

**Spec:** `docs/superpowers/specs/2026-10-25-messaging-in-chat-and-channel-quick-setup-design.md` (sections 1, 4, 5, 6, "Telegram", "Calls I made").

**Program:** plan 2 of 4. Plan 1 (Messaging in Chat) merged as #597. Plan 3 covers Discord and Slack Socket Mode setup pages. Plan 4 covers WhatsApp and the public web address setting.

**Calls this plan makes (operator to check):**
- **Telegram's first start skips waiting messages.** On a connection's very first start, the poller skips everything already waiting. This keeps the setup messages, including `/start <code>`, from becoming AI turns. After that, restarts resume exactly where polling stopped. This refines the spec's "nothing is consumed before polling starts".
- **The "say hi" listener keeps no server state.** The setup page asks the existing discovery route every 4 seconds, carrying the code saved on the draft. Stopping is the page stopping.
- **Turn on uses the existing calls in order.** There is no new approval endpoint.
- **A missing provider host goes through Settings' normal allowlist change.** It is approved in the same click.
- **Turn on runs the setup test.** That test sends a message to the operator's chat and removes it, and the step says so.
- **Older Telegram connections keep how they behave today.** A connection with a webhook secret shows as web-address delivery; one without shows as "Don't receive messages".
- **The picker leaves out the Zalo personal-account bridge.** It is an unofficial personal-session client, so it is out under the no-ban-risk rule. Removing it from the product is a separate decision.
- **Channels not converted yet open in Settings.** Their picker tiles open the existing Settings setup with that channel preselected.
- **One new dependency:** `uqr`, used to draw QR codes locally.

## Global Constraints

**Providers and scope**
- Official provider APIs only. The Telegram Bot API methods used are `getMe`, `getWebhookInfo`, `getUpdates`, `deleteWebhook`, `sendMessage` and `answerCallbackQuery`. Nothing may get an account or number banned.
- Changes go in the Cockpit only (`apps/mission-control-next/src/cockpit`). The Classic shell is not changed.

**Design and Cockpit guards**
- `DESIGN.md` rules apply:
  - sentence case
  - the shared status vocabulary
  - names before IDs (IDs only in `TechnicalDetails`)
  - `variant="danger"` only for irreversible actions
  - both themes and phone width
  - `TimeText` for times and `plural()` for counts
- Cockpit guards stay green:
  - **Copy glossary:** no "Gateway", "evidence", "owner", "replay", "revision" or "snapshot" in Cockpit copy. Write "GoatCitadel" or "version".
  - **Other checks:** the raw-values ratchet, no arbitrary Tailwind values, aria-label starting with the visible text, `cockpitInputClass` on text inputs.
  - **Line limit:** at most 400 lines per non-test Cockpit file.
- `LIVE_REGION_BUDGET` rises by exactly one, for the setup page's single status line (Task 8). That is 894 → 895, or main's current value + 1, with a comment naming the setup page. No other `role="status"`, `role="alert"` or `aria-live` is added; `Callout` takes `announce={false}`.

**Gateway ownership and approvals**
- Mission Control is an API client. All state is owned by the gateway: drafts, cursors and plans.
- Approval is not weakened. Turn on approves only the approval whose `kind` is `"change_plan_effect"` and whose `payload.planId` equals the plan it created or resumed. It never uses the Settings approval skip and never approves anything else.
- The bot key never appears in an error message, diagnostic, runtime status, log line or rendered text. It is part of every Bot API URL, so never build an error from a URL or a fetch error message.

**Storage and dependencies**
- No new storage tables or migrations:
  - the poll cursor uses the existing system-settings cursor store (`channel-stream-cursor-store.ts`);
  - the setup code uses the draft's existing `setupCode` field.
- One new dependency: `"uqr": "0.1.3"` (exact) in `apps/mission-control-next/package.json`, installed with `pnpm install --filter @goatcitadel/mission-control-next`. The lockfile is committed. Nothing else is added.

**Architecture metrics**
- Never run `architecture:baseline:update`.
- Operator-approved allowances for this plan (C0 entries in `scripts/verification/baselines/architecture-new-service-allowances.json`):

  | File | Host callbacks | Dependency reads |
  |---|---|---|
  | `apps/gateway/src/services/telegram-update-processor.ts` | 0 | up to 12 |
  | `apps/gateway/src/services/channel-stream-adapters/telegram-stream-adapter.ts` | 0 | up to 10 |

- Every other file keeps its current count and cap. In particular:

  | File | Count / cap |
  |---|---|
  | `channel-stream-runtime-registry.ts` | 8/8 |
  | `channel-setup-telegram-discovery.ts` | 10/10 |
  | `integration-channel-service.ts` | 59/59 |
  | `gateway-route-composition-integrations.ts` | ≤ 105 |

- `pnpm verify:architecture:metrics` is already red on main, but only for `evolution-control-plane-operator-approval-skip.ts` and `gateway/chat-stream-runtime.ts`. If it fails for any other file, stop and ask the operator, naming the file and the counts.

**Working practices**
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`) before running tests in other packages.
- Run heavy work at low priority: vitest with `--maxWorkers=2`, one heavy job at a time. Gateway tests run from `apps/gateway`.
- Run Prettier only on files this plan creates, or on already-clean files it touches. Never on a directory glob.
- No personal paths in tracked files.
- Work on branch `feat/channel-quick-setup` in worktree `.claude/worktrees/messaging-in-chat`. Commit only there, and never `git stash`.

## Review Focus

1. **The same bot is read by another app (Hermes, say).** Telegram answers `getUpdates` with 409. The channel shows "Telegram says another app is reading this bot's messages, or the bot sends them to a web address." and retries with backoff. Setup shows the conflict note, and nothing clears another app's webhook without the operator's click (Tasks 3 and 5).
2. **The gateway restarts while polling.**
   - On restart, polling resumes from the stored cursor with no update skipped.
   - On the very first start, the waiting setup messages are skipped, so the `/start <code>` message never becomes an AI turn (Task 5).
3. **The bot key leaks through an error.** A fetch error that quotes the request URL must never reach `lastError`, diagnostics or the page (Tasks 3 and 5).
4. **The code arrives the wrong way.** A message from a group, a different code, a code inside other text, or a bot sender is never accepted as "said hi". Only an exact `/start <code>`, `/start@bot <code>` or `<code>` sent in a private chat counts (Task 3).
5. **Turn on is interrupted.** Suppose the page closes after the approval but before "continue". Pressing Turn on again finishes the same plan: no duplicate plan, and no approval left hanging (Task 7).

---

### Task 1: Setup definitions carry picker hints and required hosts

**Files:**
- Modify: `packages/contracts/src/channel-wizard.ts:131-140` (`ChannelSetupWizardContent`)
- Create: `apps/gateway/src/services/channel-setup-definitions/picker-hints.ts`
- Modify: `apps/gateway/src/services/channel-setup-definitions.ts` (apply the hints where the registry assembles the definitions returned by `GET /api/v1/channels/setup-definitions`)
- Test: `apps/gateway/src/services/channel-setup-definitions/picker-hints.test.ts`

**Interfaces:**
- Produces, in contracts:
  ```ts
  export type ChannelPickerGroup = "quickest" | "team_chat" | "phone_apps";
  export interface ChannelSetupPickerHint { group: ChannelPickerGroup; minutes?: number; note?: string }
  // ChannelSetupWizardContent gains:
  picker?: ChannelSetupPickerHint;   // absent = not offered in the picker
  requiredHosts?: string[];          // provider hosts the channel must be allowed to reach
  ```
- Produces, in gateway: `CHANNEL_PICKER_HINTS: Readonly<Record<string, ChannelSetupPickerHint>>` and `CHANNEL_REQUIRED_HOSTS: Readonly<Record<string, readonly string[]>>`, keyed by channel key.

- [ ] **Step 1: Write the failing tests**

`picker-hints.test.ts` reads the full definition list the setup-definitions route returns:
- `it("offers every channel except the Zalo personal bridge")`. Every definition whose `catalog.key` is not `"zalouser"` has `wizard.picker`; `zalouser` has none.
- `it("groups channels as agreed")`. The keys per group, in this order:

  | Group | Channels |
  |---|---|
  | quickest | `["telegram","discord","ntfy","slack"]` |
  | team_chat | `["mattermost","matrix","teams","google-chat"]` |
  | phone_apps | `["signal","whatsapp","line","imessage","wecom","qqbot","zalo","nextcloud-talk"]` |

- `it("Telegram takes about three minutes and needs api.telegram.org")`:
  - `picker.minutes === 3`
  - `requiredHosts` equals `["api.telegram.org"]`
  - `wizard.estimatedMinutes` is unchanged (8)
- `it("says what each channel needs")`. The exact `note` values are below. A channel not listed has no note.

  | Channel | Note |
  |---|---|
  | slack | "Receiving needs a public web address" |
  | ntfy | "Needs an ntfy topic you control" |
  | mattermost | "Needs a Mattermost server" |
  | matrix | "Needs a Matrix bot account" |
  | teams | "Sends only" |
  | google-chat | "Receiving needs a public web address" |
  | signal | "Needs signal-cli" |
  | whatsapp | "Business account + public web address" |
  | line | "Receiving needs a public web address" |
  | imessage | "Sends only, through BlueBubbles on a Mac" |
  | wecom | "Needs a public web address" |
  | qqbot | "Needs a public web address" |
  | zalo | "Sends only, from a Zalo Official Account" |
  | nextcloud-talk | "Receiving needs a public web address" |

  Telegram and Discord have no note.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-definitions/picker-hints.test.ts --maxWorkers=2`
Expected: FAIL (`picker` undefined).

- [ ] **Step 3: Add the contract fields and the hint tables, and apply them in the registry**

Set `picker` and `requiredHosts` on each assembled definition without mutating the source definition objects. Before writing each note, read that channel's `prerequisites` in its definition and in `guided-journey.ts`. If a note claims more than the prerequisites say, stop and report rather than change the note.

- [ ] **Step 4: Rebuild contracts and run the tests**

Run: `pnpm --filter @goatcitadel/contracts build`, then the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/channel-wizard.ts apps/gateway/src/services/channel-setup-definitions/picker-hints.ts apps/gateway/src/services/channel-setup-definitions/picker-hints.test.ts apps/gateway/src/services/channel-setup-definitions.ts
git commit -m "feat(channels): setup definitions carry picker groups, notes and required hosts"
```

### Task 2: Telegram gets a receive mode

**Files:**
- Modify: `apps/gateway/src/services/channel-setup-definitions/telegram.ts`:
  - the fields around :104-240
  - `hydrate` :323
  - `normalize` :369
  - the prerequisites around :43
- Modify: `apps/gateway/src/services/channel-setup-definitions/guided-journey.ts:35` (the Telegram prerequisite line)
- Modify: `packages/gateway-core/src/channel-core.ts:321-362` (`resolveInboundModes` and the Telegram posture text)
- Modify: `apps/gateway/src/services/integration-channel-service.ts:356` (consult stream status for `"poll"` too)
- Test: create `apps/gateway/src/services/channel-setup-definitions/telegram.receive-mode.test.ts`
- Test: `packages/gateway-core/src/channel-core.test.ts`
- Test: `apps/gateway/src/services/integration-channel-service.test.ts`

**Interfaces:**
- Produces: the Telegram connection config key `receiveMode: "poll" | "webhook" | "off"`, and the key `ownerActorIds: string[]`, now normalized.
- Produces: `ChannelCapabilities.inboundModes` is `["poll"]` for a Telegram connection with `receiveMode: "poll"`.

- [ ] **Step 1: Write the failing tests**

`telegram.receive-mode.test.ts`:
- `it("new drafts default to asking Telegram for messages")`. The `receiveMode` field's `defaultValue` is `"poll"`, and `normalize` of a draft with `receiveMode: "poll"` yields `config.receiveMode === "poll"`.
- `it("leaves receiveMode out when the draft has none")`. `normalize` output has no `receiveMode` key, so the saved connection keeps its own.
- `it("hydrates older connections as they behave today")`:
  - config with `webhookSecret` → `receiveMode: "webhook"`
  - config without one → `"off"`
  - config with `receiveMode: "poll"` → `"poll"`
- `it("keeps the operator as the owner")`. `normalize` of a draft with `ownerActorIds: ["42"]` yields `config.ownerActorIds` equal to `["42"]`.
- `it("shows webhook secrets only for web-address delivery")`. The `webhookSecret` and `webhookSecretEnv` fields have `visibleWhenFieldEquals: { fieldKey: "receiveMode", value: "webhook" }`.

`channel-core.test.ts`: add a case where Telegram with `receiveMode: "poll"` gives `inboundModes` equal to `["poll"]`, and `"off"` gives `["none"]`. The existing pins at :135-156 and :238-242 stay unchanged, so legacy connections behave exactly as before.

`integration-channel-service.test.ts`: a Telegram connection with `receiveMode: "poll"` reports `ready` and `lastInboundAt` from `getChannelStreamRuntimeStatus`, following the stream cases around :383-437.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-definitions/telegram.receive-mode.test.ts src/services/integration-channel-service.test.ts --maxWorkers=2`, then `pnpm --filter @goatcitadel/gateway-core exec vitest run src/channel-core.test.ts --maxWorkers=2`.
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

**`receiveMode` select field:** place it before the webhook fields. Option labels:

| Value | Label |
|---|---|
| `poll` | "Ask Telegram for new messages (no public web address needed)" |
| `webhook` | "Telegram sends messages to a public web address" |
| `off` | "Don't receive messages" |

**`hydrate`, `fieldState` and `normalize`:** carry `receiveMode` and `ownerActorIds`. `normalize` reads `ownerActorIds` as a string array and omits it when empty.

**Prerequisite copy:** in `telegram.ts`, and in the Telegram posture line at `guided-journey.ts:35`, replace the public-HTTPS line with: "A public HTTPS address only if you choose web-address delivery."

**`resolveInboundModes`:**
- `receiveMode === "poll"` → `["poll"]`
- `receiveMode === "off"` → `["none"]`
- otherwise, today's logic

**Telegram posture text:** for poll mode, say it receives by asking Telegram for new messages.

**Status branch:** at `integration-channel-service.ts:356`, use `inboundModes.includes("stream") || inboundModes.includes("poll")`. This must add no dependency read (it stays at 59/59).

- [ ] **Step 4: Run the tests**

Run: the Step 2 commands.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-setup-definitions/telegram.ts apps/gateway/src/services/channel-setup-definitions/telegram.receive-mode.test.ts apps/gateway/src/services/channel-setup-definitions/guided-journey.ts packages/gateway-core/src/channel-core.ts packages/gateway-core/src/channel-core.test.ts apps/gateway/src/services/integration-channel-service.ts apps/gateway/src/services/integration-channel-service.test.ts
git commit -m "feat(telegram): receive mode with polling as the default for new connections"
```

### Task 3: Discovery finds who said hi and can clear a webhook

**Files:**
- Modify: `packages/contracts/src/channel-setup-operations.ts:5-21`
- Modify: `apps/gateway/src/services/telegram-target-discovery.ts` (new pure function)
- Modify: `apps/gateway/src/services/channel-setup-telegram-discovery.ts`
- Modify: `apps/gateway/src/routes/integrations-channel-setup-routes.ts:34-50` (body schema)
- Test: `apps/gateway/src/services/telegram-target-discovery.test.ts`
- Test: `apps/gateway/src/services/channel-setup-telegram-discovery.test.ts`
- Test: `apps/gateway/src/routes/integrations.telegram-routes.test.ts`, or whichever route test already covers `discover-targets`

**Interfaces:**
- Produces, in contracts:
  ```ts
  export interface ChannelSetupCodeSender { actorId: string; chatId: string; displayName?: string; username?: string }
  // ChannelSetupDiscoveryInput, "draft" variant only, gains: clearWebhook?: true
  // ChannelSetupDiscoveryResult gains: codeSender?: ChannelSetupCodeSender; updatesTruncated?: true; updatesConflict?: true
  ```
- Produces, in gateway: `findTelegramStartCodeSender(payload: unknown, setupCode: string): ChannelSetupCodeSender | undefined`.

- [ ] **Step 1: Write the failing tests**

`telegram-target-discovery.test.ts`, using `getUpdates`-shaped payloads:
- `it("finds the sender of /start <code> in a private chat")`. Given `from: {id: 42, first_name: "Sam", last_name: "Lee", username: "sam"}` in a private `chat: {id: 42}` with text `/start Ab3dEf7hJk`, it returns `{actorId: "42", chatId: "42", displayName: "Sam Lee", username: "sam"}`.
- `it("accepts /start@bot <code> and the bare code")`.
- `it("ignores groups, other codes, codes inside other text and bots")`. Each of these returns `undefined`:
  - the same text in a `group` chat;
  - `/start other`;
  - `hello Ab3dEf7hJk`;
  - `xAb3dEf7hJk`;
  - `from.is_bot: true`.
- `it("uses the latest matching message")`.

`channel-setup-telegram-discovery.test.ts`, using the existing fake host:
- `it("returns the code sender when the setup code matches")`.
- `it("clears the webhook before reading updates when asked")`. The fetch calls are, in order, `getMe`, `deleteWebhook`, `getWebhookInfo`, `getUpdates`, and the result has `webhookActive: false`.
- `it("marks a full page of updates")`. When 100 updates return and none match, the result has `updatesTruncated: true`.
- `it("marks another reader")`. When `getUpdates` answers 409, the result has `updatesConflict: true`. The existing warning stays as it is.
- `it("never puts the bot key in its error")`. When fetch rejects with ``new Error(`request to https://api.telegram.org/bot123:SECRET/getUpdates failed`)``, the thrown message does not contain `"123:SECRET"`.

Route test: `clearWebhook: true` with `source: "connection"` returns 400. With `source: "draft"` it is accepted.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/telegram-target-discovery.test.ts src/services/channel-setup-telegram-discovery.test.ts --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

**Matcher.** Use the trimmed text, and require `chat.type === "private"` and `!from.is_bot`. Match `^/start(?:@[A-Za-z0-9_]{1,64})?\s+(\S+)$`, or require the text to equal the code exactly. The matched code must equal `setupCode` exactly.

**Discovery service.**
- When `input.source === "draft" && input.clearWebhook`, call `call("deleteWebhook")` before `getWebhookInfo`. `deleteWebhook` sends no `drop_pending_updates`.
- When `setupCode` is set and updates were read, add `codeSender`.
- Set `updatesTruncated` when `result.length >= 100`, and `updatesConflict` when `getUpdates` answered 409.
- Reuse the existing local `call`; the file must stay at 10/10.

**Route.** Add `clearWebhook: z.literal(true).optional()` to the draft variant only.

- [ ] **Step 4: Rebuild contracts and run the tests**

Run: `pnpm --filter @goatcitadel/contracts build`, then the Step 2 command and the route test.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/channel-setup-operations.ts apps/gateway/src/services/telegram-target-discovery.ts apps/gateway/src/services/telegram-target-discovery.test.ts apps/gateway/src/services/channel-setup-telegram-discovery.ts apps/gateway/src/services/channel-setup-telegram-discovery.test.ts apps/gateway/src/routes/integrations-channel-setup-routes.ts
git commit -m "feat(telegram): setup discovery finds who sent the code and can clear a webhook on request"
```

### Task 4: One Telegram update handler for webhook and polling

**Files:**
- Create: `apps/gateway/src/services/telegram-update-processor.ts`
- Modify: `apps/gateway/src/routes/integration-webhooks-telegram-routes.ts`. Move the `dispatch` body (:82-288) and the private helpers below it out of the route. `resolveRoutePersonalityCatalog` stays.
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json` (C0 entry for the new file)
- Test: create `apps/gateway/src/services/telegram-update-processor.test.ts`
- Test (unchanged, must pass): `apps/gateway/src/routes/integrations.webhooks.test.ts`, `integration-webhooks.loop22.test.ts`, `integration-webhooks.rate-limit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TelegramUpdateDeps {
    webhooks: IntegrationWebhookRoutePort;
    readPersonalityCatalog(): Promise<Omit<PersonalityCatalogResponse, "revision">>;
  }
  export type TelegramDispatchPayload = Exclude<ReturnType<typeof normalizeTelegramWebhookPayload>, { kind: "ignore" }>;
  /** Today's webhook dispatch, unchanged: returns the body the webhook route sends back. */
  export function dispatchTelegramUpdate(deps: TelegramUpdateDeps, input: {
    connection: IntegrationConnection; parsed: TelegramDispatchPayload; payload: unknown; rawBody: Buffer;
  }): Promise<unknown>;
  /** Polling entry: re-reads the connection, normalizes, dispatches. Undefined when Telegram's update is ignored. */
  export function runTelegramUpdate(deps: TelegramUpdateDeps, connectionId: string, update: unknown): Promise<unknown>;
  /** A webhook reply body that is a Bot API call the poller must make itself. */
  export function readTelegramBotMethodCall(body: unknown):
    { method: "sendMessage" | "answerCallbackQuery"; params: Record<string, unknown> } | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

`telegram-update-processor.test.ts`:
- `it("asks an unknown sender for pairing as a sendMessage call")`. This uses a fake `webhooks` port and a private message from an unpaired sender. `readTelegramBotMethodCall(await dispatchTelegramUpdate(...))` has `method: "sendMessage"`, and `params.chat_id` is the chat.
- `it("only treats known Bot API calls as replies")`:
  - `{accepted: true}` → `undefined`
  - `{method: "deleteMessage"}` → `undefined`
- `it("runTelegramUpdate reads the connection fresh and skips ignored updates")`. `getIntegrationConnection` is called with the id. An update from a bot returns `undefined` without dispatching.
- `it("runTelegramUpdate uses the update id as the idempotency key")`. The accepted event carries `telegram:<connectionId>:<update_id>`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/telegram-update-processor.test.ts --maxWorkers=2`
Expected: FAIL (module not found).

- [ ] **Step 3: Move the code**

**Moving the dispatch.**
- Move the dispatch closure into `dispatchTelegramUpdate`, unchanged:
  - `fastify.services.integrationWebhooks` becomes `deps.webhooks`;
  - `resolveRoutePersonalityCatalog(fastify)` becomes `deps.readPersonalityCatalog()`;
  - `request.body` becomes `input.payload`.
- Move with it: `resolveTelegramConversation`, `parseTelegramApprovalCallback`, `renderDurableCommandResult` and their small helpers.
- The route's `dispatch` now calls `dispatchTelegramUpdate({ webhooks: fastify.services.integrationWebhooks, readPersonalityCatalog: () => resolveRoutePersonalityCatalog(fastify) }, …)`.

**`runTelegramUpdate`.** It runs these steps:
1. Reads the connection with `deps.webhooks.getIntegrationConnection`.
2. Returns `undefined` unless the connection is enabled and `connected`, as the webhook handler does.
3. Reads the voice flag with `deps.webhooks.isVoiceInboundEnabled`, treating a failure as off.
4. Normalizes with `normalizeTelegramWebhookPayload`.
5. Returns `undefined` for `ignore`.
6. Otherwise calls `dispatchTelegramUpdate` with `rawBody: Buffer.alloc(0)`.

**Allowance.** Measure the new file with the repository counters, then add the C0 allowance entry. Use `maxHostCallbacks: 0` and `maxDependencyMemberAccesses` set to the measured count, capped at 12 as approved. The `reason` says it is the shared Telegram update handler for webhook and polling. The `evidence` names this test file and the measured count. If the count is above 12, stop and ask.

- [ ] **Step 4: Run the tests and the gate**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/telegram-update-processor.test.ts src/routes/integrations.webhooks.test.ts src/routes/integration-webhooks.loop22.test.ts src/routes/integration-webhooks.rate-limit.test.ts --maxWorkers=2`. Then, from the repo root, `pnpm verify:architecture:metrics`.
Expected: all tests PASS. The gate shows only the two pre-existing main regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/telegram-update-processor.ts apps/gateway/src/services/telegram-update-processor.test.ts apps/gateway/src/routes/integration-webhooks-telegram-routes.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "refactor(telegram): one update handler shared by the webhook route and polling"
```

### Task 5: Telegram receives by polling

**Files:**
- Modify: `apps/gateway/src/services/channel-stream-runtime-service.ts`. Add `handle` to `ChannelStreamRunContext` (:25-40); `emit` (:335-350) becomes `handle(() => this.dispatch(connection, event), cursor)`.
- Create: `apps/gateway/src/services/channel-stream-adapters/telegram-stream-adapter.ts`
- Modify: `apps/gateway/src/services/channel-stream-runtime-registry.ts` (register the adapter and export `provideTelegramUpdateDeps`)
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts:334` (keep the built port in a const and provide it)
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json` (C0 entry for the adapter)
- Test: create `apps/gateway/src/services/channel-stream-adapters/telegram-stream-adapter.test.ts`
- Test: `apps/gateway/src/services/channel-stream-runtime-service.test.ts`
- Test: `apps/gateway/src/services/channel-stream-runtime-registry.test.ts`

**Interfaces:**
- Consumes: `runTelegramUpdate` and `readTelegramBotMethodCall` (Task 4), and `receiveMode` (Task 2).
- Produces:
  ```ts
  // ChannelStreamRunContext gains:
  /** Runs adapter-owned work with emit's bookkeeping: touch, error capture, cursor advance, lastInboundAt, clearError. */
  handle(work: () => Promise<unknown>, cursor?: string): Promise<void>;

  export interface TelegramStreamAdapterDeps {
    fetch: typeof fetch;
    resolveSecret(config: Record<string, unknown>, directKey: string, envKey: string, catalogId?: string): string | undefined;
    isUrlAllowlisted(urlValue: string): boolean;
    cursorStore: ChannelStreamCursorStore;
    processUpdate(connectionId: string, update: unknown): Promise<unknown>;
  }
  export function createTelegramStreamAdapter(deps: TelegramStreamAdapterDeps): ChannelStreamAdapter;
  export function provideTelegramUpdateDeps(host: Pick<ChannelStreamRuntimeHost, "storage">, deps: TelegramUpdateDeps): void;
  ```
- Constants in the adapter:

  | Constant | Value |
  |---|---|
  | `LONG_POLL_SECONDS` | 25 |
  | `REQUEST_TIMEOUT_MS` | 35_000 |
  | `idleTimeoutMs` | 60_000 |
  | `allowed_updates` | `["message","channel_post","callback_query"]` |

- [ ] **Step 1: Write the failing tests**

`telegram-stream-adapter.test.ts` uses a scripted fake `fetch`, an in-memory cursor store, and a fake `ctx` built like the Matrix adapter test's:
- `it("runs only for connections that poll")`. `isInboundEnabled` is true only for `config.receiveMode === "poll"`.
- `it("skips the waiting setup messages on its first start")`:
  - there is no stored cursor;
  - the first call is `getUpdates` with `offset=-1&limit=1&timeout=0`, which returns `update_id: 7`;
  - `processUpdate` is not called;
  - the cursor store holds `{cursor: "8", scope: "123"}`, where 123 is the bot id from key `123:abc`;
  - the next call uses `offset=8`.
- `it("skips only once")`. When the first-start check finds nothing waiting, the store holds `{cursor: "0", scope: "123"}`. A later start then polls without skipping.
- `it("resumes from its cursor for the same bot and starts fresh for another bot")`.
- `it("handles each update in order, then advances the cursor")`:
  - two updates (10 and 11) go through `processUpdate("conn-1", update)` in order, via `ctx.handle`;
  - the stored cursor is `"12"`.
- `it("sends the reply the handler returns")`. When `processUpdate` resolves `{method: "sendMessage", chat_id: 1, text: "hi"}`, the adapter POSTs `.../bot123:abc/sendMessage` with that JSON body (no `method` key). A failed reply is reported through `ctx.diagnostic` and still advances the cursor.
- `it("stops on a rejected key and reports another reader")`:
  - **401:** rejects with `ChannelStreamAuthError`.
  - **409:** rejects with `Error("Telegram says another app is reading this bot's messages, or the bot sends them to a web address.")`.
- `it("never puts the bot key in an error")`. When fetch rejects with an error whose message contains `https://api.telegram.org/bot123:abc/getUpdates`, the thrown message does not contain `"123:abc"`.
- `it("refuses to poll when api.telegram.org isn't allowed")`. It rejects with `Error("GoatCitadel isn't allowed to reach api.telegram.org.")`.

`channel-stream-runtime-service.test.ts`: add `it("handle runs adapter work with emit's bookkeeping")`. After `ctx.handle(work, "c2")`:
- `work` ran;
- status `lastInboundAt` is set;
- the cursor reads `"c2"`;
- an earlier `lastError` is cleared.

`channel-stream-runtime-registry.test.ts`: the runtime has a `telegram` adapter. Before `provideTelegramUpdateDeps` is called, its `processUpdate` rejects with `Error("Telegram receiving isn't ready yet.")`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-stream-adapters/telegram-stream-adapter.test.ts src/services/channel-stream-runtime-service.test.ts src/services/channel-stream-runtime-registry.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`run(ctx)`:**
1. Resolve the key with `resolveSecret(config, "botToken", "botTokenEnv", catalogId)`. If it is missing, throw `ChannelStreamAuthError("Telegram has no bot key.")`. The bot id is the part before `:`.
2. Check `isUrlAllowlisted("https://api.telegram.org/")`.
3. Read the cursor for scope = the bot id, and run the first-start skip when there is none.
4. Call `ctx.markReady()`.
5. Loop until `ctx.signal` aborts:
   - long-poll with `AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])`;
   - call `ctx.touch()`;
   - process each update through `ctx.handle`;
   - write the cursor after each update.
6. Map failures to these fixed messages, never to `error.message`:
   - a non-OK HTTP response becomes `` `Telegram returned HTTP ${status}.` ``;
   - a network failure becomes `"GoatCitadel couldn't reach Telegram."`.
7. Send a returned reply as JSON POST to `https://api.telegram.org/bot<key>/<method>`.

**Registry:**
- `createStreamRuntime(host, key)` receives the `key` that `getChannelStreamRuntime` already read.
- A module `WeakMap` keyed by that storage holds the provided `TelegramUpdateDeps`.
- `processUpdate` looks the deps up lazily and calls `runTelegramUpdate`.
- The cursor store is built from the same `systemSettings()` closure Matrix uses, so the registry stays at 8/8.

**Route composition:**
- Assign the `createIntegrationWebhookRoutePort({...})` result to a const.
- Call `provideTelegramUpdateDeps(gateway, { webhooks: <that const>, readPersonalityCatalog: async () => gateway.getPersonalityCatalog() })`.
- The file must stay ≤ 105.

**Allowance:** add the adapter's C0 allowance with the measured count, capped at 10 as approved.

- [ ] **Step 4: Run the tests and the gate**

Run: the Step 2 command, then (from `apps/gateway`) `pnpm exec vitest run src/services/gateway-runtime-factory.channel-streams.test.ts src/services/channel-stream-adapters --maxWorkers=2`. Then, from the repo root, `pnpm verify:architecture:metrics`.
Expected: all tests PASS. The gate shows only the two pre-existing main regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-stream-runtime-service.ts apps/gateway/src/services/channel-stream-runtime-service.test.ts apps/gateway/src/services/channel-stream-adapters/telegram-stream-adapter.ts apps/gateway/src/services/channel-stream-adapters/telegram-stream-adapter.test.ts apps/gateway/src/services/channel-stream-runtime-registry.ts apps/gateway/src/services/channel-stream-runtime-registry.test.ts apps/gateway/src/services/gateway-route-composition-integrations.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(telegram): receive messages by long polling, no public web address needed"
```

### Task 6: Messaging routes and the channel picker

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/app/routes.ts:35-60`
- Modify: `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:88-93, 276`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/use-chat-owner-navigation.ts:41`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx:237-240, 288-291`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.tsx:10`
- Modify: `apps/mission-control-next/src/cockpit/data/query-keys.ts`
- Create, in `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/`:
  - `channel-picker-model.ts`
  - `ChannelPicker.tsx`
  - `ChannelSetupView.tsx`
- Test: `routes.test.ts`, `cockpit-compatibility.test.ts`, `ChatMainColumn.test.tsx`, `MessagingSection.test.tsx`
- Test: create `channel-setup/channel-picker-model.test.ts` and `channel-setup/ChannelPicker.test.tsx`
- Test: run, and update if they list Chat routes, `route-release-scope.projection.test.ts` and `scripts/verification/lib/release-surface-manifest.mjs`

**Interfaces:**
- Produces, in `routes.ts`:
  ```ts
  export type MessagingView =
    | { kind: "channel"; connectionId: string }
    | { kind: "picker" }
    | { kind: "setup"; channelKey: string }
    | { kind: "change_key"; connectionId: string };
  export function messagingView(rest: readonly string[]): MessagingView | null;
  export function channelPickerHref(): string;                     // "/chat/messaging/add"
  export function channelSetupHref(channelKey: string): string;    // "/chat/messaging/add/<channelKey>"
  export function channelKeyChangeHref(connectionId: string): string; // "/chat/messaging/<id>/key"
  ```
- Rules for the routes:
  - `channelKey` must match `^[a-z][a-z0-9-]{0,39}$`.
  - `channelPageConnectionId` keeps its contract and returns `null` for `"add"`.
  - `isChannelPageLocation` becomes true for every `MessagingView`, and its doc comment says so.
- Produces, in `channel-picker-model.ts`:
  ```ts
  export const CONVERTED_SETUP_CHANNELS: ReadonlySet<string>; // new Set(["telegram"])
  export interface ChannelPickerTile { channelKey: string; catalogId: string; label: string; minutes: number; note?: string; href: string }
  export interface ChannelPickerGroupView { id: ChannelPickerGroup; title: string; tiles: ChannelPickerTile[] }
  export function buildChannelPickerGroups(definitions: readonly ChannelSetupDefinition[]): ChannelPickerGroupView[];
  export function settingsChannelSetupHref(catalogId: string): string; // "/settings/connections?channel=<catalogId>#channels"
  ```
- Produces: `queryKeys.channelSetupDefinitions()` → `["channel-setup", "definitions"]`.

- [ ] **Step 1: Write the failing tests**

`routes.test.ts`, for `messagingView`:

| Input | Result |
|---|---|
| `["messaging","add"]` | `{kind:"picker"}` |
| `["messaging","add","telegram"]` | `{kind:"setup",channelKey:"telegram"}` |
| `["messaging","<uuid>","key"]` | `{kind:"change_key",…}` |
| `["messaging","<uuid>"]` | `{kind:"channel",…}` |
| `["messaging","add","Tele gram"]` | `null` |
| `["messaging","add","telegram","x"]` | `null` |
| `["messaging","a","b"]` | `null` |

`cockpit-compatibility.test.ts`: `/chat/messaging/add`, `/chat/messaging/add/telegram` and `/chat/messaging/<uuid>/key` resolve native. The existing `missing` case for `/chat/messaging/a/b` stays.

`channel-picker-model.test.ts`:
- `it("groups and orders tiles as agreed")`. The titles are "Quickest", "Team and self-hosted chat" and "Phone apps". The tile order follows each definition's group order from Task 1.
- `it("sends converted channels to their setup page and the rest to Settings")`:
  - Telegram's `href` is `/chat/messaging/add/telegram` and its `minutes` is 3.
  - Slack's `href` is `/settings/connections?channel=channel.slack#channels` and its `minutes` is 10 (its `estimatedMinutes`).
- `it("leaves out definitions without a picker hint")`.

`ChannelPicker.test.tsx`: it renders the heading "Add a channel" and three group headings. A tile reads "Telegram", "About 3 min". The Slack tile reads "Receiving needs a public web address".

`MessagingSection.test.tsx`: the "Add a channel" link's `href` is `/chat/messaging/add`.

`ChatMainColumn.test.tsx`:
- `{kind:"picker"}` renders the picker.
- `{kind:"setup", channelKey:"slack"}` renders "Set up Slack in Settings" with a link to `settingsChannelSetupHref("channel.slack")`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/app src/cockpit/areas/chat/ChatMainColumn.test.tsx src/cockpit/areas/chat/MessagingSection.test.tsx src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Wiring.**
- `ChatArea` passes `messagingView(rest)` to `ChatMainColumn`. That prop replaces `channelPageId`, and `onOpenChannel` uses `channelPageHref`.
- `ChatMainColumn` lazy-loads the view for each kind:
  - `ChannelPage`;
  - `ChannelPicker`;
  - `ChannelSetupView` for `setup` and for `change_key`. Task 10 replaces the `change_key` branch.
- **ChannelSetupView.** For now it renders, for every channel, "Set up <label> in Settings" with a `NativeOwnerLink` to `settingsChannelSetupHref`. Task 8 adds Telegram's own page here. For an unknown channel key it shows "This channel isn't available." with a link back to the picker.

**Picker.**
- It reads definitions with `useQuery({ queryKey: queryKeys.channelSetupDefinitions(), queryFn: fetchChannelSetupDefinitions, staleTime: Infinity })`.
- Layout: an `AreaHeader title="Add a channel"`, then one `Section` per group. Each tile is a `NativeOwnerLink` showing the label, `About ${minutes} min`, and the note.

**"+ Add".** `MessagingSection`'s `ADD_CHANNEL_HREF` becomes `channelPickerHref()`.

- [ ] **Step 4: Run the tests and the Cockpit guards**

Run: the Step 2 command. Then, from the repo root:
- `node scripts/check-mission-control-next-cockpit-copy.mjs`
- `node scripts/check-mission-control-next-cockpit-semantics.mjs`
- `node scripts/check-mission-control-next-cockpit-classes.mjs`
- `node scripts/check-mission-control-next-raw-values.mjs`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/app apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.test.tsx apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.tsx apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.test.tsx apps/mission-control-next/src/cockpit/areas/chat/use-chat-owner-navigation.ts apps/mission-control-next/src/cockpit/areas/chat/channel-setup apps/mission-control-next/src/cockpit/data/query-keys.ts
git commit -m "feat(cockpit): + Add opens a grouped channel picker under Messaging"
```

(Add any release-surface files Step 1 updated.)

### Task 7: Turn on approves the channel's change in place

**Files:**
- Create, in `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/`:
  - `approve-plan-in-place.ts`
  - `turn-on-channel.ts`
- Test: create `channel-setup/approve-plan-in-place.test.ts` and `channel-setup/turn-on-channel.test.ts`. Mock `@goatcitadel/mission-control-shared/api/client` the way existing Cockpit tests do.

**Interfaces:**
- Produces:
  ```ts
  export type InPlaceOutcome =
    | { kind: "completed"; plan: ChangePlanRecord }
    | { kind: "elsewhere"; plan: ChangePlanRecord; approvalId?: string }   // finish in Settings or Inbox
    | { kind: "failed"; message: string };
  export function approvePlanInPlace(planId: string, workspaceId: string): Promise<InPlaceOutcome>;
  export function ensureHostsAllowed(hosts: readonly string[], workspaceId: string): Promise<{ kind: "allowed" } | InPlaceOutcome>;
  export type TurnOnOutcome =
    | InPlaceOutcome
    | { kind: "blocked"; reasons: string[] }
    | { kind: "needs_cleanup_ack"; evidenceId: string };
  export function turnOnChannelDraft(input: {
    workspaceId: string; draftId: string; catalogId: string; requiredHosts: readonly string[];
  }): Promise<TurnOnOutcome>;
  export function acknowledgeCleanupAndTurnOn(input: {
    workspaceId: string; draftId: string; catalogId: string; evidenceId: string;
  }): Promise<TurnOnOutcome>;
  ```

**`approvePlanInPlace` algorithm** (at most 12 rounds):
1. `fresh = fetchChangePlan(planId, {workspaceId})`.
2. `completed`, `applied` or `monitoring` → completed.
3. `failed`, `cancelled`, `rolled_back`, `rollback_failed` or `manual_required` → failed, with `fresh.result?.summary ?? fresh.summary`.
4. `applying` or `verifying` with no action → wait 1 s, then go to the next round.
5. `confirmation` → `confirmChangePlan(planId, ctx, {expectedRevision: fresh.revision, actionNonce})`.
6. `approval` with `approvalId`:
   1. Fetch the approval (`fetchApproval`).
   2. Unless `kind === "change_plan_effect"` and `payload.planId === planId`, fail with "This approval belongs to another change."
   3. `pending` → `resolveApproval(approvalId, "approve")`. If that throws a 401 or 403, return `elsewhere` with the `approvalId`.
   4. `approved` → `respondToChangePlan(planId, ctx, {expectedRevision: fresh.revision, actionId, actionNonce, values: {}})`.
   5. `rejected` or `expired` → fail with "The approval was turned down."
7. Any other action kind → `elsewhere`.
8. If all rounds run out, fail with "GoatCitadel is still turning this on. Check again in a moment."

**`turnOnChannelDraft` order:**
1. Resume first. Look in `fetchChangePlans({workspaceId}, {limit: 50})` for a non-terminal plan where:
   - `request.kind === "channel_connection"`;
   - `target.ownerId === "channel_setup_draft"`;
   - `target.resourceId === draftId`.

   If one exists, return `approvePlanInPlace` on it.
2. `ensureHostsAllowed(requiredHosts)`.
3. Validate the current draft revision. If the status is not `"ok"`, return `blocked` with the issue messages.
4. Test the current draft revision:
   - `finalizationEligibility.requiresAcknowledgement` → `needs_cleanup_ack`;
   - not `allowed` → `blocked` with `blockingReasons`.
5. Create the plan with:
   ```ts
   createChangePlan({ workspaceId, surface: "settings",
     request: { kind: "channel_connection", channelKind: catalogId, draftId },
     idempotencyKey: `messaging-turn-on:${draftId}:${revision}` })
   ```
6. `approvePlanInPlace` on it.

**`acknowledgeCleanupAndTurnOn`** calls `acknowledgeChannelSetupTest` with `acknowledgement: "cleanup"`, then runs steps 5–6. It never re-tests.

**`ensureHostsAllowed`:**
1. Read `fetchSettings()`.
2. Find the missing hosts with `isBaseUrlAllowlisted(`https://${host}/`, networkAllowlist)` from `cockpit/areas/settings/web-search-state.ts`.
3. If none are missing, return `allowed`.
4. Otherwise call `patchSettings({ expectedRevision, networkAllowlist: [...current, ...missing] })` and read the result's change receipt:
   - `completed` → `allowed`;
   - `awaiting_approval` → `approvePlanInPlace` on the receipt's plan;
   - anything else → fail with "GoatCitadel couldn't add <host> to the hosts it may reach."

- [ ] **Step 1: Write the failing tests**

`approve-plan-in-place.test.ts`:
- `it("confirms, approves its own approval, then continues to completion")`. Assert that the calls happen in order and that `resolveApproval` received `("ap-1","approve")`.
- `it("never approves an approval for another change")`. With `payload.planId: "other"`, the result is failed and `resolveApproval` is not called.
- `it("hands off to Inbox when this sign-in can't approve")`. A 403 from `resolveApproval` gives `{kind:"elsewhere", approvalId:"ap-1"}`.
- `it("stops on a failed change with its summary")`.
- `it("hands off actions the page can't do")`. A `public_form` action gives `elsewhere`.
- `it("fails when the approval was turned down")`.

`turn-on-channel.test.ts`:
- `it("resumes an open change for the same draft")`. Validate, test and `createChangePlan` are not called.
- `it("adds a missing host first")`. `patchSettings` receives `networkAllowlist` ending in `"api.telegram.org"`. A receipt of `awaiting_approval` is approved in place.
- `it("stops for the test message it couldn't remove")`. The result is `needs_cleanup_ack`, and `createChangePlan` is not called.
- `it("binds the change to the tested draft version")`. The `idempotencyKey` is `messaging-turn-on:d-1:<revision after test>`.
- `it("acknowledging continues without testing again")`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup/approve-plan-in-place.test.ts src/cockpit/areas/chat/channel-setup/turn-on-channel.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement both modules as specified above**

- [ ] **Step 4: Run the tests**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup/approve-plan-in-place.ts apps/mission-control-next/src/cockpit/areas/chat/channel-setup/approve-plan-in-place.test.ts apps/mission-control-next/src/cockpit/areas/chat/channel-setup/turn-on-channel.ts apps/mission-control-next/src/cockpit/areas/chat/channel-setup/turn-on-channel.test.ts
git commit -m "feat(cockpit): Turn on approves the channel's own change in place"
```

### Task 8: The setup page frame and Telegram's first two steps

**Files:**
- Modify: `apps/mission-control-next/package.json` (`"uqr": "0.1.3"`) and `pnpm-lock.yaml`
- Create, in `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/`:
  - `QrCode.tsx`
  - `SetupSteps.tsx`
  - `use-telegram-setup.ts`
  - `TelegramSetupPage.tsx`
- Modify: `channel-setup/ChannelSetupView.tsx` (Telegram renders `TelegramSetupPage`)
- Modify: `scripts/check-mission-control-next-cockpit-semantics.mjs:24` (`LIVE_REGION_BUDGET` +1, with a comment)
- Test: `QrCode.test.tsx`, `SetupSteps.test.tsx`, `use-telegram-setup.test.ts`, `TelegramSetupPage.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function QrCode(props: { value: string; label: string }): JSX.Element;
  // <svg role="img" aria-label={label}>, dark modules on a light square in both themes, built from uqr encode(value, { ecc: "M", border: 2 }).data

  export interface SetupStepView { id: string; title: string; state: "locked" | "current" | "done"; result?: ReactNode; children?: ReactNode }
  export function SetupSteps(props: { steps: readonly SetupStepView[]; status?: string }): JSX.Element;
  // numbered <ol>; aria-current="step" on the current step; locked steps show only the title; one role="status" line renders `status`

  export interface TelegramSetupState {
    draft: ChannelSetupDraft | null;
    bot: { username: string; label?: string } | null;
    webhookActive: boolean; conflict: boolean; busy: boolean; error?: string;
    checkKey(token: string): Promise<void>;
    stopWebAddress(): Promise<void>;
    startOver(): Promise<void>;
  }
  export function useTelegramSetup(workspaceId: string): TelegramSetupState; // Task 9 extends it
  ```

**Page copy** (exact):

*Page*
- Title: "Set up Telegram".

*Step 1, "Make your bot"*
- Text: "Scan this with your phone to open BotFather in Telegram. Send /newbot and pick a name."
- QR label: "QR code that opens BotFather"
- Link: "Open BotFather" → `https://t.me/BotFather`

*Step 2, "Paste the key BotFather sent you"*
- Field label: "Bot key"
- Button: "Check key"
- On success: "Key works. Your bot is @<username>."
- On failure: "Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again."
- When a webhook is active: "This bot sends its messages to a web address, so GoatCitadel can't read them here. If another app uses that address, it stops getting messages." with the button "Stop sending to that address".
- When another app holds the bot: "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel."

*Footer*
- "Start over" (discards the draft)
- "More options in Settings" → `settingsChannelSetupHref("channel.telegram")`

**`useTelegramSetup` behaviour:**
- **Resuming.** On mount, resume the newest Telegram draft without a `connectionId` from `fetchChannelSetupDrafts({catalogId: "channel.telegram"})`. When its key is configured, re-run discovery to get the bot.
- **`checkKey(token)`:**
  1. Create the draft if there is none: `createChannelSetupDraft({catalogId: "channel.telegram", lifecycleMode: "create"})`.
  2. `submitChannelSetupDraftSecrets(draftId, {expectedRevision, values: {botToken: token}})`.
  3. `discoverTelegramSetupTargets({source: "draft", draftId, expectedRevision})`.
  4. `updateChannelSetupDraft`, merging `botUsername` and `receiveMode: "poll"` into `draft.draft`.
- **Key input.** It comes from `useCredentialInput`, is volatile and never persisted.
- **Discovery warnings.** Never render discovery's `warnings` strings. Map only `webhookActive` and `updatesConflict` to the copy above.

- [ ] **Step 1: Write the failing tests**

- `QrCode.test.tsx`: the SVG has `role="img"` and the given label. Its `viewBox` is square and matches the matrix size, and it renders one `<path>`.
- `SetupSteps.test.tsx`: steps are numbered 1–n. Only the current step has `aria-current="step"`. A locked step's children are not rendered. The status line has `role="status"`.
- `use-telegram-setup.test.ts`:
  - `it("checks a key: one draft, the key stored securely, the bot named")`. Assert the calls and arguments above. The final draft update contains `botUsername: "MyGoatBot"` and `receiveMode: "poll"`.
  - `it("shows one plain sentence when the key fails")`. The error is the exact failure copy; the gateway message is never shown.
  - `it("resumes the newest unfinished draft")`.
  - `it("clears a webhook only when asked")`. `stopWebAddress` calls discovery with `clearWebhook: true`; `checkKey` never does.
- `TelegramSetupPage.test.tsx`:
  - it renders the four step titles;
  - steps 3 and 4 are locked until the key works;
  - the BotFather link goes to `https://t.me/BotFather`;
  - after a webhook result it shows "Stop sending to that address";
  - after an `updatesConflict` result it shows the another-app sentence.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new files.

- [ ] **Step 3: Add the dependency and implement**

Install `uqr` as stated in Global Constraints. Check that `uqr`'s `encode` returns `{ data: boolean[][] }` before relying on it. Build the QR path from the matrix rather than injecting `renderSVG` output; no `dangerouslySetInnerHTML`. Raise `LIVE_REGION_BUDGET` by one, with the comment "Channel setup page status line (SetupSteps)".

- [ ] **Step 4: Run the tests, guards and build**

Run:
- the Step 2 command;
- the four guard scripts from Task 6, Step 4;
- `pnpm --filter @goatcitadel/mission-control-next build`;
- `pnpm perf:check:next`.

Expected: PASS. The build's only circular-chunk warning is the known `vendor-markdown` one.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/package.json pnpm-lock.yaml apps/mission-control-next/src/cockpit/areas/chat/channel-setup scripts/check-mission-control-next-cockpit-semantics.mjs
git commit -m "feat(cockpit): Telegram setup page with a BotFather QR code and a key check"
```

### Task 9: Say hi, Turn on, done

**Files:**
- Modify: `channel-setup/use-telegram-setup.ts`
- Modify: `channel-setup/TelegramSetupPage.tsx`
- Create: `channel-setup/setup-code.ts`
- Create: `channel-setup/TurnOnStep.tsx`
- Create: `channel-setup/use-turn-on.ts`
- Test: `use-telegram-setup.test.ts`, `TelegramSetupPage.test.tsx`
- Test: create `setup-code.test.ts` and `TurnOnStep.test.tsx`

**Interfaces:**
- Consumes: `turnOnChannelDraft` and `acknowledgeCleanupAndTurnOn` (Task 7), `codeSender` and `updatesTruncated` (Task 3), and `requiredHosts` (Task 1).
- Produces:
  ```ts
  export const SETUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  export function createSetupCode(): string;                     // 10 chars, crypto.getRandomValues
  export const SETUP_CODE_TTL_MS = 600_000;
  export const SAY_HI_POLL_MS = 4_000;                           // the discovery route allows 20 a minute
  // TelegramSetupState gains:
  sender: ChannelSetupCodeSender | null; code: string | null; codeExpired: boolean; manyWaiting: boolean;
  newCode(): Promise<void>;
  export function useTurnOn(workspaceId: string): {
    state: "idle" | "working" | "done" | "cleanup" | "blocked" | "elsewhere" | "failed";
    message?: string; approvalId?: string;
    turnOn(input: { draftId: string; catalogId: string; requiredHosts: readonly string[] }): Promise<void>;
    acknowledgeCleanup(): Promise<void>;
  };
  export function TurnOnStep(props: { changes: readonly string[]; turnOn: ReturnType<typeof useTurnOn>; onTurnOn(): void; doneHref?: string }): JSX.Element;
  ```

**Step 3 copy, "Say hi to your bot"** (exact):
- Text: "Scan this with your phone, or open your bot, then tap Start."
- QR label: "QR code that opens your bot"
- Link: "Open @<username>" → `https://t.me/<username>?start=<code>`
- Fallback: "Can't see Start? Send your bot this code: <code>"
- While waiting: "Waiting for your hi…"
- On success: "<name> said hi. Only they can message your bot for now." The name is `displayName`, else `@username`, else "Someone".
- When expired: "This code expired." with the button "Get a new code".
- When `manyWaiting`: "Your bot has many waiting messages, so your hi may take a while to show up."

**Step 4 copy, "Turn it on"** (exact). Each change is a list item:
- "Who can message your bot: <name>"
- "Where it posts: your chat with @<username>"
- "How it gets messages: GoatCitadel asks Telegram for new ones, so no public web address is needed"
- "GoatCitadel sends a test message to your chat and then removes it"
- "<host> is added to the hosts GoatCitadel may reach", only for hosts the settings query shows as missing (reuse the Cockpit's existing settings query and key)

Button: "Turn on". Each outcome:

| Outcome | Copy |
|---|---|
| working | "Turning on…" |
| done | "Telegram is on. Send your bot a message to try it." with link "Open Telegram's page" |
| cleanup | "GoatCitadel couldn't remove its test message. Delete it in Telegram if you like." with button "Continue" |
| blocked | the reasons, one per line |
| elsewhere with `approvalId` | "Approve it in Inbox" link to the Inbox approval, using the Cockpit's existing Inbox approval href |
| elsewhere without `approvalId` | "Finish this in Settings" link |
| failed | the message |

**Listening.**
- `newCode()` saves the code to the draft's `setupCode` (`updateChannelSetupDraft`). Every `SAY_HI_POLL_MS` it then calls `discoverTelegramSetupTargets({source: "draft", draftId, expectedRevision, setupCode})`.
- It stops when any of these happens:
  - `codeSender` arrives;
  - `SETUP_CODE_TTL_MS` passes, which sets `codeExpired`;
  - the page unmounts;
  - Turn on starts.
- When a sender arrives, update the draft in one call:
  - `allowedSenders: [actorId]`
  - `ownerActorIds: [actorId]`
  - `inboundAccessMode: "allowlist"`
  - targets merged with `mergeDiscoveredChannelTargets`, adding `{id: "telegram:"+chatId, label: <name>, chatId, kind: "private", source: "recent_update", setupCodeMatched: true}` as the default target.

**Done link.** After `done`, find the new connection with `fetchIntegrationConnections("channel")`. Take the newest connection whose key is `telegram` and whose `config.botUsername` equals the bot (case-insensitive). The link goes to `channelPageHref(connectionId)`.

- [ ] **Step 1: Write the failing tests**

`setup-code.test.ts`: the code matches `/^[A-HJ-NP-Za-km-z2-9]{10}$/`, and 100 codes are all distinct.

`use-telegram-setup.test.ts` (fake timers):
- `it("saves a fresh code and listens every 4 seconds")`.
- `it("stops listening once someone says hi and makes them the allowed sender and owner")`. Assert the single draft update above, and no discovery calls after the match.
- `it("stops after 10 minutes and offers a new code")`.
- `it("stops when the page closes")`.
- `it("notes a full page of waiting messages")`.

`TurnOnStep.test.tsx`:
- the host line shows only when a host is missing;
- the `cleanup` state shows "Continue", which calls `acknowledgeCleanup`;
- the `elsewhere` state links to the Inbox approval.

`TelegramSetupPage.test.tsx`:
- "Turn on" calls `turnOnChannelDraft` with `{catalogId: "channel.telegram", requiredHosts: ["api.telegram.org"]}`;
- the done state links to `/chat/messaging/<id>` for the connection whose `botUsername` matches.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement as specified above**

- [ ] **Step 4: Run the tests and guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): say hi with a one-time code, then Turn on Telegram in place"
```

### Task 10: Change Telegram's key from its channel page

**Files:**
- Create: `channel-setup/TelegramKeyChange.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChannelManageSection.tsx:55-57`
- Modify: `ChatMainColumn.tsx` (the `change_key` branch)
- Test: create `channel-setup/TelegramKeyChange.test.tsx`
- Test: `ChannelPage.test.tsx:285` and `ChatMainColumn.test.tsx`

**Interfaces:**
- Consumes: `useTurnOn` and `TurnOnStep` (Task 9), `channelKeyChangeHref` (Task 6), `SetupSteps` (Task 8).
- Produces: `TelegramKeyChange(props: { connectionId: string; workspaceId: string }): JSX.Element`.

**Copy** (exact):
- Title: "Change Telegram's key"
- Step 1: "Paste the new key", with the same field, button and results as Task 8 step 2
- When the bot changes: "This key is for @<new>, not @<old>. Saving it switches the bot people message."
- Step 2: "Save the new key". The button is "Save key", and on success: "Saved. Telegram uses the new key now." with the link "Back to Telegram's page".

**Behaviour.** On the first "Check key", reuse the newest draft from `fetchChannelSetupDrafts({connectionId})`, or create one with `createChannelRotateSecretDraft(connectionId)`. Then submit the secret and run discovery as in Task 8. "Save key" calls `turnOn` with this draft and Telegram's `requiredHosts`. Turn on's change list is just "GoatCitadel sends a test message to your chat and then removes it".

**Links.** In `ChannelManageSection`, "Change the key" links to `channelKeyChangeHref(connectionId)` for Telegram connections. Other channels keep the Settings link. In `ChatMainColumn`, `change_key` renders `TelegramKeyChange` when the connection is Telegram, and the Settings pointer otherwise.

- [ ] **Step 1: Write the failing tests**

`TelegramKeyChange.test.tsx`:
- it shows the bot-change warning when discovery's bot differs from `config.botUsername`;
- "Save key" calls `turnOnChannelDraft` with the rotate draft's id.

`ChannelPage.test.tsx`: "Change the key" is `/chat/messaging/<id>/key` for Telegram and `/settings/connections#channels` for Discord.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup/TelegramKeyChange.test.tsx src/cockpit/areas/chat/ChannelPage.test.tsx src/cockpit/areas/chat/ChatMainColumn.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement as specified above**

- [ ] **Step 4: Run the tests and guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup/TelegramKeyChange.tsx apps/mission-control-next/src/cockpit/areas/chat/channel-setup/TelegramKeyChange.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChannelManageSection.tsx apps/mission-control-next/src/cockpit/areas/chat/ChannelPage.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatMainColumn.test.tsx
git commit -m "feat(cockpit): change Telegram's key from its channel page"
```

### Task 11: Settings › Channels points to Messaging

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx:34-40`
- Test: `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.test.tsx` (create the file if none exists)

**Interfaces:**
- Consumes: `channelPickerHref` (Task 6), and `owner.setPanel` and `owner.setCreateCatalogId` from `useChannelSettings`.

**Pointer and preselect:**
- **Pointer copy** (exact), placed above the existing header text: "Add and manage channels from Messaging in Chat." with a `NativeOwnerLink` "Open Messaging" to `channelPickerHref()`. It is a plain `<p>`, not a live region.
- **Preselect.** When `search` has `channel=<catalogId>` and that catalog has a loaded definition, call `owner.setPanel("create")` and `owner.setCreateCatalogId(catalogId)` once. No draft is created until the operator clicks.

- [ ] **Step 1: Write the failing tests**

- the pointer link's `href` is `/chat/messaging/add`;
- `?channel=channel.slack` opens the create panel with Slack selected, and `createChannelSetupDraft` is not called;
- an unknown `channel` value changes nothing.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/settings/ChannelsSettings.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.test.tsx
git commit -m "feat(cockpit): Settings channels point to Messaging and open a picked channel"
```

### Task 12: Docs and proof

**Files:**
- Modify: `docs/CHANNEL_GUIDED_SETUP.md` (Telegram: polling is the default, a web address is the advanced option, and the setup page in Chat › Messaging)
- Modify: `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md` (Telegram section, same facts)
- Artifacts (gitignored): `artifacts/channel-quick-setup/` (screenshots, scripts, report)

- [ ] **Step 1: Update both docs** with the facts above and nothing beyond what Tasks 1–11 built.

- [ ] **Step 2: Run the lanes**

From the repo root, in this order, one at a time:
1. `pnpm typecheck`
2. `pnpm docs:check`
3. `pnpm verify:gateway:async-boundary`
4. `pnpm verify:channels:parity`
5. `pnpm verify:architecture:metrics`. Only the two pre-existing main regressions may appear.
6. `pnpm --filter @goatcitadel/mission-control-next build`
7. `pnpm perf:check:next`
8. the four Cockpit guard scripts
9. `git diff --check`
10. `pnpm verify:fast`

Expected: each exits 0, apart from the noted gate. Record any `verify:fast` timeout in a file this branch does not touch, rerun that file alone, and report both results.

- [ ] **Step 3: Browser proof in a sandbox**

Use plan 1's sandbox recipe:
- tracked example config only;
- `GOATCITADEL_DISABLE_SECRET_STORE=true`;
- a blocking proxy that logs every provider request.

Capture the screens below in light and dark themes, at 1440×900 and 375×812:
- the Messaging "+ Add" link;
- the picker;
- the Telegram setup page with step 2 current;
- the key-failure sentence (provider blocked);
- Settings › Channels with the pointer;
- `?channel=channel.slack` preselected.

Expected:
- the provider log shows 0 requests that reached Telegram;
- there are 0 console or HTTP errors;
- the bot key never appears in any screenshot, page text or log.

- [ ] **Step 4: Commit the docs**

```bash
git add docs/CHANNEL_GUIDED_SETUP.md docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md
git commit -m "docs(channels): Telegram polls by default and sets up from Messaging"
```

**Not covered by this plan's proof:** a live run against a real Telegram bot. The operator does that after merge with their own bot.
