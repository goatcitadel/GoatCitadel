# Messaging in Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Channel conversations (Telegram, Discord, Slack, WhatsApp) appear in a Messaging section of the Cockpit Chat sidebar, can be read and answered there, and each connected channel has its own page; the integration catalog stops claiming things that do not exist.

**Architecture:** The gateway gains a Messaging read model (`GET /api/v1/chat/messaging`) built from existing external chat sessions, their integration bindings (now carrying conversation details), the channel connections and per-operator read markers stored in system settings. The Cockpit renders it as a sidebar section under the existing conversation list, shows channel conversations in the existing transcript with channel-aware labels and composer, and adds a channel page at `/chat/messaging/<connectionId>` that reuses the existing pairing and lifecycle components. Desk messages in the operator's own direct conversation become a new durable inbound dispatch kind so the answer reaches the channel even after an approval wait.

**Tech Stack:** TypeScript, Fastify gateway, `@goatcitadel/storage` (SQLite and Postgres through one repository class per table), React 19 Cockpit with TanStack Query, vitest (happy-dom, `createRoot`/`act`, no Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-25-messaging-in-chat-and-channel-quick-setup-design.md`

**Program:** this is plan 1 of 4. Plan 2: the channel picker, the self-checking setup page frame, in-place "Turn on", Telegram polling and the Settings › Channels pointer. Plan 3: Discord and Slack (Socket Mode) setup. Plan 4: WhatsApp setup and the public web address setting. Each later plan is written when its predecessor lands. Until plan 2, "+ Add" links to Settings › Connections › Channels.

## Global Constraints

- Official provider APIs only; nothing that can get an account or number banned.
- Cockpit only (`apps/mission-control-next/src/cockpit`); the Classic shell is not changed.
- `DESIGN.md`: sentence case, the shared status vocabulary, names before IDs (IDs only in `TechnicalDetails`), `variant="danger"` only for irreversible actions, both themes, `TimeText` for times and `plural()` for counts.
- Cockpit guards stay green with no budget raised: copy glossary (no "Gateway", "evidence", "owner", "replay", "revision", "snapshot" in cockpit copy), `LIVE_REGION_BUDGET = 892` exact (add no `role="status"`/`aria-live`), no arbitrary Tailwind values, raw-values ratchet.
- Mission Control is an API client: every new piece of state is owned by the gateway.
- Approval, deny-wins policy and tool grants are not weakened.
- No new storage tables in this plan: read markers live in system settings, conversation details in the binding's existing `target_json`.
- Never run `architecture:baseline:update`. If `pnpm verify:architecture:metrics` fails, stop and ask the operator for an allowance, naming the file and the counts.
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`) before running tests in other packages; they read its `dist`.
- Heavy work at low priority: vitest with `--maxWorkers=2`, one heavy job at a time.
- Prettier only on files this plan creates or already-clean files it touches; never on a directory glob.
- No personal paths in tracked files.
- Work on branch `feat/messaging-in-chat` in its own worktree; commit only there.

## Review Focus

1. A conversation whose channel was removed: it stays readable under a "Removed" channel row, its composer is blocked with a reason, and nothing crashes on the missing connection (tests in Tasks 4, 7, 10).
2. A Telegram group with several people: the conversation is named after the group, never after whoever spoke last (test in Task 2).
3. Someone other than the operator messages the bot directly: typing at the desk posts verbatim and never starts an AI turn on their behalf (test in Task 8).
4. A desk question whose answer waits for an approval: the event stays retryable and the answer is delivered once approved (test in Task 8).
5. No operator identity on the request (for example a companion token): new-message counts are absent, not zero (tests in Tasks 4 and 6).

---

### Task 1: Catalog and setup copy tell the truth

**Files:**
- Modify: `apps/gateway/src/services/integration-catalog.ts:1030,1039,1048-1049,1058,1103,1111,1139,1159`
- Modify: `apps/gateway/src/services/channel-setup-definitions/slack.ts:60,69,75`
- Modify: `docs/CHANNEL_GUIDED_SETUP.md:61`
- Test: `apps/gateway/src/services/integration-catalog.test.ts`
- Create: `apps/gateway/src/services/channel-setup-definitions/slack.copy.test.ts`

**Interfaces:** none produced.

- [ ] **Step 1: Write the failing tests**

In `integration-catalog.test.ts`:

```ts
it("lists only sign-in methods GoatCitadel implements for channels", () => {
  expect(byKey("discord").authMethods).toEqual(["bot-token"]);
  expect(byKey("whatsapp").authMethods).toEqual(["token"]);
  expect(byKey("googlechat").authMethods).toEqual(["webhook", "service-account"]);
  expect(byKey("teams").authMethods).toEqual(["webhook"]);
  expect(byKey("signal").authMethods).toEqual(["bridge"]);
  expect(byKey("slack").authMethods).toEqual(["oauth"]);
});
it("marks channels that receive messages as inbound-capable", () => {
  for (const key of ["slack", "telegram", "whatsapp", "line"]) {
    expect(byKey(key).capabilities).toContain("inbound");
  }
});
```

`byKey` is a local helper over the catalog list the file already imports; use the catalog's real `key` values (check the `entry(...)` calls for Google Chat's key).

In `slack.copy.test.ts`: import every export of `./slack.js`, `JSON.stringify` them, and assert the result does not contain `"hosted GoatCitadel"`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/integration-catalog.test.ts src/services/channel-setup-definitions/slack.copy.test.ts --maxWorkers=2`
Expected: FAIL on the authMethods, inbound and copy assertions.

- [ ] **Step 3: Fix the catalog entries, the Slack copy and the doc**

Catalog: set the `authMethods` arrays to the values in the test; add `"inbound"` to the capability arrays of Slack, Telegram, WhatsApp and LINE. Slack copy at :60, :69, :75: say "your Slack app" instead of the hosted GoatCitadel app. `docs/CHANNEL_GUIDED_SETUP.md:61`: replace the "Receive remains prohibited…" sentence with "Receiving is available when you turn on `receiveEvents`; see `COMMUNICATION_CHANNEL_SETUP_GUIDE.md`."

- [ ] **Step 4: Run the tests and docs check**

Run: the Step 2 command, then `pnpm docs:check` from the repo root.
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/integration-catalog.ts apps/gateway/src/services/integration-catalog.test.ts apps/gateway/src/services/channel-setup-definitions/slack.ts apps/gateway/src/services/channel-setup-definitions/slack.copy.test.ts docs/CHANNEL_GUIDED_SETUP.md
git commit -m "fix(channels): catalog and Slack setup copy claim only what works"
```

### Task 2: Conversations keep their names

**Files:**
- Modify: `packages/storage/src/session-repo.ts:76-82` (upsert SQL)
- Modify: `apps/gateway/src/routes/integration-webhooks-telegram-routes.ts:242-252` (agent-turn dispatch)
- Test: `packages/storage/src/session-repo.test.ts`
- Test: `apps/gateway/src/routes/integrations.webhooks.test.ts` (or the Telegram webhook route test that already covers agent-turn dispatch)

**Interfaces:** none produced.

- [ ] **Step 1: Write the failing tests**

`session-repo.test.ts`: `it("keeps the saved display name and routing hints when a later upsert omits them")` — upsert with `displayName: "Sam Lee"` and `routingHints: { a: "1" }`, upsert again with neither, expect `getBySessionKey(...).displayName` to be `"Sam Lee"` and `routingHints` to equal `{ a: "1" }`.

Telegram route test: `it("names a private conversation after the sender and a group after its title")` — dispatch a private-chat update from "Sam Lee" and a group update in "Family group" sent by "Alex"; expect the accepted inbound payloads' `message.displayName` to be `"Sam Lee"` and `"Family group"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/storage exec vitest run src/session-repo.test.ts --maxWorkers=2`, and from `apps/gateway`: `pnpm exec vitest run src/routes/integrations.webhooks.test.ts --maxWorkers=2`
Expected: FAIL (`displayName` is `undefined` after the second upsert; the agent-turn payload has no `displayName`).

- [ ] **Step 3: Implement**

SQL: `display_name = COALESCE(excluded.display_name, sessions.display_name)` and the same for `routing_hints_json` (valid on both SQLite and Postgres). Telegram agent-turn dispatch: pass `displayName: chatType === "private" ? metadata.actorDisplayName : metadata.chatTitle ?? metadata.actorDisplayName`, using the fields the parser already sets (`telegram-webhook.ts:169,175`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/session-repo.ts packages/storage/src/session-repo.test.ts apps/gateway/src/routes/integration-webhooks-telegram-routes.ts apps/gateway/src/routes/integrations.webhooks.test.ts
git commit -m "fix(sessions): stop message ingest from erasing conversation names"
```

### Task 3: Bindings remember what kind of conversation they are

**Files:**
- Modify: `packages/contracts/src/chat.ts:384-392` (`ChatSessionBindingRecord`)
- Modify: `packages/storage/src/chat-session-binding-repo.ts` (`get` :48, `upsert` :53, plus new `listBySessionIds`)
- Modify: `apps/gateway/src/services/inbound-channel-event-service.ts:470` (`ensureInboundChatSession` call)
- Modify: `apps/gateway/src/services/chat-session-service.ts:1188-1256` (`ensureInboundIntegrationChatSession`)
- Modify producers: `apps/gateway/src/routes/integration-webhooks-telegram-routes.ts:242-252`, `apps/gateway/src/routes/integration-webhooks-slack-routes.ts:123-133`, `apps/gateway/src/services/discord-runtime-service.ts:~843`, the WhatsApp inbound route
- Test: `packages/storage/src/chat-session-binding-repo.test.ts`, `apps/gateway/src/services/inbound-channel-event-service.test.ts`, and each producer's existing route or service test

**Interfaces:**
- Produces (contracts, exported from the package index):
  ```ts
  export interface ChatChannelConversation {
    kind: "direct" | "group";
    counterpartActorId?: string; // provider user id of the other person, direct only
    title?: string;              // person's name (direct) or group/channel title
  }
  // ChatSessionBindingRecord gains: conversation?: ChatChannelConversation;
  ```
- Produces (storage): `ChatSessionBindingRepository.listBySessionIds(sessionIds: string[]): Map<string, ChatSessionBindingRecord>`
- Produces (inbound payload): stored payload field `conversation?: ChatChannelConversation`; `ensureInboundChatSession` input gains `conversation?: ChatChannelConversation`.

- [ ] **Step 1: Write the failing tests**

Binding repo: `it("round-trips conversation details and keeps them when a later upsert omits them")` and `it("lists bindings by session id")`. Conversation details are stored inside `target_json` next to `target`; no migration.

Inbound service: `it("stores conversation details on the session binding")` — accept an event whose payload has `conversation: { kind: "direct", counterpartActorId: "42", title: "Sam Lee" }`, process it, expect the binding's `conversation` to equal that object.

Producers, one test each: Telegram private → `{ kind: "direct", counterpartActorId: String(from.id), title: actorDisplayName }`, group → `{ kind: "group", title: chatTitle }`; Slack `channel_type === "im"` → direct with the user id, otherwise group; Discord message without a guild → direct with the author id and display name, otherwise group titled `#<channel name>` when known; WhatsApp → direct with the sender's `wa_id` and profile name.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/contracts build`, then `pnpm --filter @goatcitadel/storage exec vitest run src/chat-session-binding-repo.test.ts --maxWorkers=2`, then from `apps/gateway` the inbound service test and the four producer tests with `--maxWorkers=2`.
Expected: FAIL (`conversation` undefined).

- [ ] **Step 3: Implement**

Repo: serialize `{ target, conversation }` into `target_json`; on upsert without `conversation`, keep the stored one. Inbound service passes `payload.conversation` to `ensureInboundChatSession`; `ensureInboundIntegrationChatSession` writes it on the binding. Producers add `conversation` to the payload they accept.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/chat.ts packages/storage/src/chat-session-binding-repo.ts packages/storage/src/chat-session-binding-repo.test.ts apps/gateway/src/services/inbound-channel-event-service.ts apps/gateway/src/services/inbound-channel-event-service.test.ts apps/gateway/src/services/chat-session-service.ts apps/gateway/src/routes/integration-webhooks-telegram-routes.ts apps/gateway/src/routes/integration-webhooks-slack-routes.ts apps/gateway/src/services/discord-runtime-service.ts
git add <the WhatsApp route and the producer test files you changed>
git commit -m "feat(channels): record direct or group conversation details on channel bindings"
```

### Task 4: Messaging read model and read markers

**Files:**
- Create: `packages/contracts/src/chat-messaging.ts` (export from the package index)
- Modify: `packages/contracts/src/channel-access.ts` (owner list helper)
- Modify: `packages/contracts/src/chat.ts:252-289` (`ChatSessionRecord.channelConnectionId?`)
- Modify: `packages/storage/src/chat-message-repo.ts` (new `countAfter`)
- Create: `apps/gateway/src/services/chat-messaging-service.ts`
- Modify: `apps/gateway/src/services/chat-session-service.ts:80` (`listChatSessions` projects `channelConnectionId`)
- Create: `apps/gateway/src/routes/chat.messaging.ts` and register it beside the other chat routes; wire the service through the chat route composition (`gateway-route-composition-chat.ts`)
- Test: `packages/storage/src/chat-message-repo.test.ts`, `apps/gateway/src/services/chat-messaging-service.test.ts`, `apps/gateway/src/routes/chat.messaging.test.ts`, `apps/gateway/src/services/chat-session-service.test.ts`

**Interfaces:**
- Consumes: `ChatChannelConversation`, `ChatSessionBindingRepository.listBySessionIds` (Task 3).
- Produces (contracts):
  ```ts
  export type ChatMessagingChannelStatus = "on" | "off" | "needs_attention" | "removed";
  export interface ChatMessagingConversation {
    sessionId: string; title: string; kind: "direct" | "group"; own: boolean;
    lastActivityAt: string; lastReadAt?: string; newMessageCount?: number;
  }
  export interface ChatMessagingChannel {
    connectionId: string; channelKey: string; label: string;
    status: ChatMessagingChannelStatus; conversations: ChatMessagingConversation[];
  }
  export interface ChatMessagingOverview { workspaceId: string; channels: ChatMessagingChannel[] }
  export interface ChatSessionReadRequest { readThrough: string }
  export interface ChatSessionReadResponse { sessionId: string; lastReadAt: string }
  export function resolveChannelOwnerActorIds(config: Record<string, unknown> | undefined): string[]; // channel-access.ts, reads config.ownerActorIds
  // ChatSessionRecord gains: channelConnectionId?: string  (set when the binding transport is "integration")
  ```
- Produces (storage): `ChatMessageRepository.countAfter(sessionId: string, after: string): number` — counts `role = "user"` messages with source authority `"external_channel"` and timestamp after `after`.
- Produces (gateway):
  ```ts
  listChatMessaging(deps: ChatMessagingDeps, input: { workspaceId: string; actor?: string }): Promise<ChatMessagingOverview>
  markChatSessionRead(deps: ChatMessagingDeps, input: { sessionId: string; workspaceId: string; actor: string; readThrough: string }): Promise<ChatSessionReadResponse>
  ```
  Routes: `GET /api/v1/chat/messaging?workspaceId=` → `ChatMessagingOverview`; `POST /api/v1/chat/sessions/:sessionId/read` with `ChatSessionReadRequest` → `ChatSessionReadResponse` (400 on a non-ISO `readThrough`, 404 for an unknown session; rate-limited like the other chat write routes).

Rules the service applies:
- Only external sessions whose binding transport is `"integration"`; mission sessions bound to a channel stay out.
- Status: enabled and `status === "connected"` → `on`; disabled, `paused` or `disconnected` → `off`; `error` → `needs_attention`; connection no longer exists → `removed` (label from the catalog entry for the session's channel key, falling back to the key).
- Title: `binding.conversation.title`, then the session title, then `"Direct message"` or `"Group conversation"`.
- `own`: `kind === "direct"` and `counterpartActorId` is in `resolveChannelOwnerActorIds(connection.config)`.
- Read marker: system setting `chat.read.v1.<sha256(actor + "\n" + sessionId)>` holding `{ at: string }`, written with `compareAndSet`, never moved backwards. With no `actor`, `lastReadAt` and `newMessageCount` are left out.
- Order: channels `on`/`needs_attention` before `off` before `removed`, then by label; conversations by `lastActivityAt`, newest first.

- [ ] **Step 1: Write the failing tests**

`chat-message-repo.test.ts`: `it("counts only channel messages newer than a timestamp")`.

`chat-messaging-service.test.ts`:
- `it("groups conversations under their connection and marks the operator's own direct conversation")`
- `it("counts only channel messages newer than the operator's read marker")`
- `it("leaves read state and counts out when there is no operator identity")` — expect `newMessageCount` to be `undefined`, not `0`.
- `it("lists conversations of a removed connection under a removed channel")`
- `it("never moves a read marker backwards")`
- `it("leaves mission sessions bound to a channel out of Messaging")`

`chat-session-service.test.ts`: `it("projects the channel connection on integration-bound sessions")`.

`chat.messaging.test.ts` (Fastify with stubbed services): 200 shape for the overview; 400 for `{ readThrough: "yesterday" }`; 404 for an unknown session.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/contracts build`, the storage test, then from `apps/gateway`: `pnpm exec vitest run src/services/chat-messaging-service.test.ts src/routes/chat.messaging.test.ts src/services/chat-session-service.test.ts --maxWorkers=2`
Expected: FAIL (modules and fields missing).

- [ ] **Step 3: Implement the contracts, `countAfter`, the service, the projection and the routes**

Follow `InboxReadStatusService` (`apps/gateway/src/services/inbox-read-status-service.ts`) for the system-settings read and `compareAndSet` pattern.

- [ ] **Step 4: Run the tests and the architecture and async gates**

Run: the Step 2 commands, then `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary`.
Expected: PASS. If the metrics gate fails, stop and ask the operator (Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/chat-messaging.ts packages/contracts/src/index.ts packages/contracts/src/channel-access.ts packages/contracts/src/chat.ts packages/storage/src/chat-message-repo.ts packages/storage/src/chat-message-repo.test.ts apps/gateway/src/services/chat-messaging-service.ts apps/gateway/src/services/chat-messaging-service.test.ts apps/gateway/src/services/chat-session-service.ts apps/gateway/src/services/chat-session-service.test.ts apps/gateway/src/routes/chat.messaging.ts apps/gateway/src/routes/chat.messaging.test.ts apps/gateway/src/services/gateway-route-composition-chat.ts
git commit -m "feat(chat): Messaging overview and per-operator read markers for channel conversations"
```

### Task 5: Messaging section in the Chat sidebar

**Files:**
- Modify: `packages/mission-control-shared/src/api/chat.ts` (client calls), `packages/mission-control-shared/src/content/status-vocabulary.ts` (presenter)
- Create: `apps/mission-control-next/src/cockpit/areas/chat/use-messaging-overview.ts`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.tsx`
- Modify: `apps/mission-control-next/src/cockpit/data/query-keys.ts`, `apps/mission-control-next/src/cockpit/data/event-map.ts:72,140`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ConversationListPanel.tsx:52,105`
- Test: `packages/mission-control-shared/src/api/wrappers.test.ts`, the status-vocabulary test, `apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.test.tsx`, `ThreadList.test.tsx` (or a `ConversationListPanel` test)

**Interfaces:**
- Consumes: Task 4 contracts and routes.
- Produces:
  ```ts
  fetchChatMessaging(workspaceId: string, options?: { signal?: AbortSignal }): Promise<ChatMessagingOverview>
  markChatSessionRead(sessionId: string, readThrough: string): Promise<ChatSessionReadResponse>
  presentChannelStatus(status: ChatMessagingChannelStatus): StatusPresentation
  // on → { label: "On", tone: "done" }; off → { label: "Off", tone: "neutral" };
  // needs_attention → { label: "Needs you", tone: "waiting" }; removed → { label: "Removed", tone: "neutral" }
  queryKeys.chatMessaging(workspaceId: string) // ["chat", "messaging", workspaceId]
  useMessagingOverview(workspaceId: string): UseQueryResult<ChatMessagingOverview>
  MessagingSection(props: {
    workspaceId: string; selectedSessionId?: string;
    onSelectSession: (sessionId: string) => void; onOpenChannel: (connectionId: string) => void;
  })
  ```

UI as agreed in the spec: a "Messaging" heading with an "Add a channel" link (visible text "+ Add", to `/settings/connections#channels`) under the conversation list; one channel row per channel (label and `StatusBadge`), conversation rows indented under it (title, `TimeText` of last activity, and a new-message count when known, text from `plural(n, "new message")`). The selected conversation row has `aria-current="page"`. No channels: "No channels yet" with the same Add link. The realtime `channels` source and chat-session updates invalidate `chatMessaging`. `ConversationListPanel` stops repeating external sessions that have `channelConnectionId` in its merged list. No new live regions.

- [ ] **Step 1: Write the failing tests**

Shared: `it("fetches the Messaging overview for a workspace")`, `it("marks a session read through a timestamp")`, `it("presents channel statuses with the agreed labels")`.

`MessagingSection.test.tsx`:
- `it("shows each channel with its status and its conversations under it")`
- `it("opens the channel page from the channel row")` — expects `onOpenChannel("conn-1")`
- `it("selects a conversation")` — expects `onSelectSession("sess-1")` and `aria-current` on the selected row
- `it("shows a new-message count only when it is known")` — count `undefined` renders no count
- `it("offers to add a channel when there are none")`

Conversation list: `it("does not repeat channel conversations in the conversation list")`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/wrappers.test.ts --maxWorkers=2`, then `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/chat/MessagingSection.test.tsx src/cockpit/areas/chat/ThreadList.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement the client calls, presenter, query key, hook, section and list change**

- [ ] **Step 4: Run the tests and the cockpit guards**

Run: the Step 2 commands, then `pnpm --filter @goatcitadel/mission-control-next build` and `pnpm perf:check:next`.
Expected: PASS with no budget changes.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/api/chat.ts packages/mission-control-shared/src/api/wrappers.test.ts packages/mission-control-shared/src/content/status-vocabulary.ts apps/mission-control-next/src/cockpit/areas/chat/use-messaging-overview.ts apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.tsx apps/mission-control-next/src/cockpit/areas/chat/MessagingSection.test.tsx apps/mission-control-next/src/cockpit/data/query-keys.ts apps/mission-control-next/src/cockpit/data/event-map.ts apps/mission-control-next/src/cockpit/areas/chat/ConversationListPanel.tsx
git add <the status-vocabulary and conversation-list test files you changed>
git commit -m "feat(cockpit): Messaging section in the Chat sidebar"
```

### Task 6: Reading a channel conversation

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx:207` (header session lookup includes external sessions)
- Modify: `packages/threaded-surface-core/src/chat/useChatSessionData.ts:244,445` (exact deep-link reads use `scope: "all"`)
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-conversation.ts`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatTranscriptContent.tsx:85-88,111-113,179-196`, `ChatTranscript.tsx`, `ChatAreaChrome.tsx` (header action)
- Test: `channel-conversation.test.ts`, `ChatTranscript.test.tsx`, `ChatArea.visible-session.test.tsx`, `ChatAreaChrome.test.tsx`, the `useChatSessionData` test

**Interfaces:**
- Consumes: `useMessagingOverview`, `markChatSessionRead` (Task 5).
- Produces:
  ```ts
  interface ChannelConversationContext {
    sessionId: string; connectionId: string; channelLabel: string; title: string;
    kind: "direct" | "group"; own: boolean; status: ChatMessagingChannelStatus; lastReadAt?: string;
  }
  describeChannelConversation(sessionId: string, overview: ChatMessagingOverview | undefined): ChannelConversationContext | undefined
  ```

Behaviour:
- Message labels in a channel conversation: source authority `"external_channel"` → `You · via Telegram` when the conversation is `own`, otherwise `via Telegram` with the conversation title for direct conversations; source authority `"operator"` → `You · from your desk`. Retry, edit and the workflow capture control are hidden for `"external_channel"` messages.
- A "N new since you were last here" divider (text from `plural`) before the first channel message newer than `lastReadAt`; not a live region.
- When a channel conversation is visible and its newest message is newer than `lastReadAt`, call `markChatSessionRead(sessionId, newestTimestamp)` once and invalidate `chatMessaging`.
- Header action "Continue in a new chat" calls the existing `onStartNewThreadFromTurn(latestTurnId)` (the fork creates a mission chat with the history copied); hidden when the conversation has no turn yet.

- [ ] **Step 1: Write the failing tests**

- `it("finds the channel context for a session from the Messaging overview")` and `it("returns nothing for a mission session")`
- `it("labels channel and desk messages by where they came from")`
- `it("hides retry and edit on messages that arrived through a channel")`
- `it("marks where the new messages start")`
- `it("marks the conversation read once it is shown")` — expects one `markChatSessionRead` call with the newest timestamp
- `it("shows the header for a selected channel conversation")` (ChatArea, external session selected)
- `it("offers Continue in a new chat and forks from the latest turn")`
- `it("reads an exact channel session link with scope all")` (useChatSessionData)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/chat --maxWorkers=2` and the threaded-surface-core test file with `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run <file> --maxWorkers=2`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and guards**

Run: the Step 2 commands, then `pnpm perf:check:next`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat packages/threaded-surface-core/src/chat/useChatSessionData.ts
git add <the threaded-surface-core test file you changed>
git commit -m "feat(cockpit): read channel conversations in Chat with source labels and new-message marker"
```

### Task 7: The channel composer

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.types.ts:3`, `ChatTextComposer.tsx:117,133-147,246,286`, `composer-send-block.ts:34,56`, `ChatComposerTools.tsx:120`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx:375` (pass the channel context)
- Test: `ChatTextComposer.test.tsx`, `composer-send-block.test.ts`

**Interfaces:**
- Consumes: `ChannelConversationContext` (Task 6).
- Produces: `ComposerProps.channelReply?: { mode: "ask" | "post"; channelLabel: string; targetTitle: string; status: ChatMessagingChannelStatus }`; `ComposerSendBlock` kinds gain `"channel-removed"` and `"channel-off"`.

Copy (exact):
- `ask` (own direct conversation): placeholder `Ask GoatCitadel. The answer also goes to Telegram.`; submit label `Send`.
- `post`: placeholder `Posts to <targetTitle> on Telegram as your bot`; submit label `Post to <targetTitle>`.
- `removed`: block message `This channel was removed. Its conversations stay readable.`
- `off`: block message `Turn Telegram back on to reply.`
- (`Telegram` stands for `channelLabel` throughout.)
- Model, mode and attachment tools are hidden in both channel modes; the desk turn uses the conversation's own route.

- [ ] **Step 1: Write the failing tests**

- `it("asks GoatCitadel in the operator's own conversation")` — placeholder and submit label as above
- `it("posts verbatim in someone else's or a group conversation")`
- `it("blocks replies in a removed channel's conversation")` and `it("blocks replies while the channel is off")` (composer-send-block)
- `it("hides model and attachment tools in channel conversations")`

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/chat/ChatTextComposer.test.tsx src/cockpit/areas/chat/composer-send-block.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and guards**

Run: the Step 2 command and `pnpm perf:check:next`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.types.ts apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.tsx apps/mission-control-next/src/cockpit/areas/chat/composer-send-block.ts apps/mission-control-next/src/cockpit/areas/chat/ChatComposerTools.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.test.tsx apps/mission-control-next/src/cockpit/areas/chat/composer-send-block.test.ts
git commit -m "feat(cockpit): channel-aware composer for asking or posting from the desk"
```

### Task 8: Desk questions in the operator's own conversation

**Files:**
- Modify: `packages/contracts/src/inbound-channel-events.ts:39` (`InboundChannelDispatchKind`)
- Modify: `packages/storage/src/inbound-channel-event-repo.ts:861` (accept the new kind)
- Create: `apps/gateway/src/services/channel-desk-turn.ts`
- Modify: `apps/gateway/src/services/inbound-channel-event-service.ts:447-560` (`processClaim`)
- Modify: `apps/gateway/src/services/gateway-service.ts:4845-5033` (`respondToExistingChatMessage` gains `deliveryPrefix`)
- Modify: `apps/gateway/src/routes/chat.messages.ts:565,649` (agent-send and agent-send/stream short-circuit) and the chat route composition that exposes the new calls
- Test: `apps/gateway/src/services/channel-desk-turn.test.ts`, `apps/gateway/src/services/inbound-channel-event-service.test.ts`, `apps/gateway/src/routes/chat.routes.test.ts`, the inbound repo test

**Interfaces:**
- Consumes: `ChatChannelConversation` (Task 3), `resolveChannelOwnerActorIds` (Task 4).
- Produces:
  ```ts
  // InboundChannelDispatchKind gains "operator_desk_turn"
  resolveDeskConversationMode(binding: ChatSessionBindingRecord, connection: IntegrationConnection | undefined): "ask" | "post" | "blocked"
  // "ask": integration binding, conversation.kind "direct", counterpartActorId in the owner list, connection enabled
  // "post": any other integration binding on an enabled connection; "blocked": connection missing or disabled
  acceptOperatorDeskTurn(host: ChannelDeskTurnHost, input: {
    sessionId: string; sessionKey: string; binding: ChatSessionBindingRecord; content: string; idempotencyKey: string;
  }): Promise<ChatSendMessageResponse>
  // respondToExistingChatMessage input gains: deliveryPrefix?: string
  ```

Behaviour:
- The agent-send routes check the mode before the normal entry (which holds a turn admission): `ask` → `acceptOperatorDeskTurn` and return; `blocked` → 409 with `Turn Telegram back on to reply.` (or the removed message); `post` → today's verbatim path, unchanged.
- `acceptOperatorDeskTurn` accepts an inbound event with `dispatchKind: "operator_desk_turn"`, `transport: "operator_desk"`, `idempotencyKey: "desk:<sessionId>:<request idempotencyKey>"`, the lane provider ingress gives the same conversation (`buildInboundConversationLaneKey`, `channel:connection:conversation[:thread]`, built from the route decoded from `sessionKey`; `session:<sessionId>` only for a route naming no conversation), and a payload carrying the route decoded from `sessionKey` (`decodeSessionKeySegment`), `bindingTarget` and the desk text. It returns a response whose `userMessage` has `messageId = stableInboundId("message", eventId)`, role `"user"`, actor `operator`, source authority `"operator"`, and `transport: "integration"`. The streaming route ends its stream with its normal terminal event carrying that response (see `agentSendChatMessageStream`, `chat-turn-entry-service.ts:1299`, for the terminal event type).
- `processClaim` for the new kind never calls `ensureInboundChatSession`. On every attempt, before anything is recorded, it reads the session's existing binding (`readChatSessionBinding`, no write) and suppresses the event unless the binding is a writable integration binding on the event's connection and `bindingTarget`, the connection is on and connected, and the conversation is still the operator's own (`resolveDeskQuestionGate`). Then it ingests the desk text as an operator message (actor `{ type: "user", id: "operator" }`, source authority `"operator"`), skip the bot-loop guard, then continue like `agent_turn`, calling `respondToExistingChatMessage` with the durable inbound identity and `deliveryPrefix: 'From your desk: "<first 200 characters>"\n\n'`.

- [ ] **Step 1: Write the failing tests**

`channel-desk-turn.test.ts`:
- `it("asks GoatCitadel in the operator's own direct conversation")` — mode `ask`
- `it("posts verbatim when the direct conversation is someone else's")` — owner list without the counterpart → `post`
- `it("posts verbatim in group conversations")`
- `it("blocks desk replies when the channel is off or removed")`
- `it("accepts a durable desk event with a stable idempotency key")` — two calls with the same request key accept one event id

Inbound service:
- `it("records a desk message with operator authority and skips the bot-loop guard")`
- `it("delivers the answer with the desk prefix")` — `commsSend` message starts with `From your desk: "`
- `it("keeps a desk turn retryable while its answer waits for approval")` — follow the existing approval-wait recovery test (`inbound-channel-event-service.test.ts:381`); the event is not terminal until the settled turn is delivered

Routes: `it("routes a desk send in the operator's own conversation to a desk turn")` and `it("refuses a desk send while the channel is off")` (409).

Inbound repo: `it("accepts the operator desk dispatch kind")`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/contracts build`, the storage repo test, then from `apps/gateway`: `pnpm exec vitest run src/services/channel-desk-turn.test.ts src/services/inbound-channel-event-service.test.ts src/routes/chat.routes.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and the gates**

Run: the Step 2 commands, then `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary`. Expected: PASS (stop and ask on a metrics failure).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/inbound-channel-events.ts packages/storage/src/inbound-channel-event-repo.ts apps/gateway/src/services/channel-desk-turn.ts apps/gateway/src/services/channel-desk-turn.test.ts apps/gateway/src/services/inbound-channel-event-service.ts apps/gateway/src/services/inbound-channel-event-service.test.ts apps/gateway/src/services/gateway-service.ts apps/gateway/src/routes/chat.messages.ts apps/gateway/src/routes/chat.routes.test.ts
git add <the inbound repo test and composition files you changed>
git commit -m "feat(channels): desk questions in your own channel conversation get an answer delivered to the channel"
```

### Task 9: The channel page

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts:78-82,147,262`, `apps/mission-control-next/src/cockpit/app/CockpitShell.tsx:72-73,169-181`, `apps/mission-control-next/src/cockpit/app/routes.ts:16-31`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/ChannelPage.tsx`, `apps/mission-control-next/src/cockpit/areas/chat/channel-page-model.ts`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx` (render the page for `/chat/messaging/<connectionId>`; `MessagingSection`'s `onOpenChannel` navigates there)
- Test: `ChannelPage.test.tsx`, `channel-page-model.test.ts`, and the route tests `cockpit-compatibility.test.ts`, `CockpitShell.test.tsx`, `routes.test.ts`, `ChatArea.route-sync.test.tsx`, `ChatArea.alias-navigation.test.tsx`

**Interfaces:**
- Consumes: `useMessagingOverview` (Task 5), `resolveChannelOwnerActorIds` (Task 4), existing `ChannelOperations({ connection, onUpdated, connectorDiagnosticsEnabled })`, `ChannelLifecycleControls({ workspaceId, selection: { connection }, reload })`, `fetchChannelRuntimeStatus`, `fetchIntegrationConnections`, `updateIntegrationConnection`.
- Produces:
  ```ts
  ChannelPage(props: { connectionId: string; workspaceId: string })
  ownerCandidates(connection: IntegrationConnection, approved: Array<{ actorId: string; label: string }>): Array<{ actorId: string; label: string; isOwner: boolean }>
  postingTargets(connection: IntegrationConnection): Array<{ label: string; isDefault: boolean }>
  // Telegram: config.targets / defaultChatId; Discord: defaultChannelId; Slack: config.targets / defaultChannel; WhatsApp: defaultTarget
  ```

Page sections (spec section 3): header with the channel label, status badge and bot name when known (Discord `connectedBotTag`, Telegram `config.botUsername`, Slack `config.slackTeamName`); "Whether it's working" with last message (`TimeText` of `lastInboundAt`) and a "Check now" button that refetches runtime status; "Who can message it" with `ChannelOperations` for pending requests plus the approved list, each with "This is you" or "Not you", which saves `config.ownerActorIds` with the connection's current `expectedRevision`; "Where it posts" (labels only); then `ChannelLifecycleControls` and a "Change the key" link to `/settings/connections#channels` (replaced by the setup page in plan 2). A removed connection shows `This channel was removed. Its conversations stay readable under Messaging.` and no actions.

- [ ] **Step 1: Write the failing tests**

- `it("opens /chat/messaging/<connectionId> as a channel page, not a conversation")` (compatibility, shell, routes)
- `it("shows status, last message, who can message it and where it posts")`
- `it("marks an approved sender as you")` — expects `updateIntegrationConnection` with `config.ownerActorIds` containing that actor and the current `expectedRevision`
- `it("lists posting targets by name")` and `it("marks the default target")` (model)
- `it("shows a removed channel without actions")`

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/app src/cockpit/areas/chat --maxWorkers=2`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the route plumbing, model helpers and page**

- [ ] **Step 4: Run the tests, guards and typecheck**

Run: the Step 2 command, `pnpm perf:check:next`, `pnpm --filter @goatcitadel/mission-control-next typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/app apps/mission-control-next/src/cockpit/areas/chat
git commit -m "feat(cockpit): channel page in Chat with status, who can message it and where it posts"
```

### Task 10: Removing a channel deletes its keys and keeps its conversations

**Files:**
- Modify: `apps/gateway/src/services/integration-channel-service.ts:566-584` (`deleteIntegrationConnection`)
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/ChannelLifecycleControls.tsx` (confirmation copy)
- Test: `apps/gateway/src/services/integration-channel-service.test.ts`, `apps/mission-control-next/src/cockpit/areas/settings/ChannelLifecycleControls.test.tsx`

**Interfaces:**
- Produces: `collectConnectionSecretRefs(connectionId: string, config: Record<string, unknown>): string[]` — every string value, at any depth, starting with `keychain:goatcitadel:channel-connection:<connectionId>:`.

Behaviour: after the delete commits, delete each collected ref through `ChannelSecretCustodyService.delete` (a failure is logged with the ref's field name, never the value, and does not undo the delete), and remove that connection's records from the `discord_pairings_v1` system setting. Sessions, bindings and transcripts are untouched. Confirmation copy (exact): `Remove <label>? This disconnects the bot and deletes its keys. Its conversations stay readable under Messaging until you delete them.`

- [ ] **Step 1: Write the failing tests**

- `it("deletes the connection's stored keys when it is removed")`
- `it("removes the connection's Discord pairings")`
- `it("keeps the connection's conversations when it is removed")` — session, binding and messages still readable
- `it("finishes the removal when deleting a key fails")`
- `it("says the conversations stay readable before removing")` (UI)

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/integration-channel-service.test.ts --maxWorkers=2`, and `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/settings/ChannelLifecycleControls.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests**

Run: the Step 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/integration-channel-service.ts apps/gateway/src/services/integration-channel-service.test.ts apps/mission-control-next/src/cockpit/areas/settings/ChannelLifecycleControls.tsx apps/mission-control-next/src/cockpit/areas/settings/ChannelLifecycleControls.test.tsx
git commit -m "fix(channels): removing a channel deletes its keys and pairings and keeps its conversations"
```

### Task 11: Whole-branch verification and visual proof

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run the lanes**

Run, one at a time: `pnpm typecheck`; `pnpm verify:fast`; `pnpm verify:architecture:metrics`; `pnpm verify:gateway:async-boundary`; `pnpm verify:channels:parity`; `pnpm verify:storage:migration-parity`; `pnpm --filter @goatcitadel/mission-control-next build`; `pnpm perf:check:next`; `pnpm docs:check`; `git diff --check main...HEAD`.
Expected: every command exits 0.

- [ ] **Step 2: Browser proof**

Run the testbench against a sandbox gateway (never the real `config/`), seed one Telegram connection with a direct and a group conversation, and screenshot: the Messaging section with a new-message count; a channel conversation with source labels and the "N new" divider; the channel page; the composer in ask and post modes; a removed channel's conversation. Repeat the sidebar shot at 375px width (the Conversations sheet) and in dark theme.
Expected: screenshots match the spec's agreed mockups; no console errors.

- [ ] **Step 3: Commit any fixes, then hand back**

Report what changed, what was validated, what was not, and remaining risk.
