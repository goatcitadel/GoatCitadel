# WS6 New Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WS6 of the gap-closure program:
- Matrix, QQBot and WeCom become real channels: send, inbound and a setup probe.
- Notion and GitHub become governed productivity integrations.
- Plugin package integrity is verified at install time.

**Architecture:** The channels reuse the WS5 ingress pattern.
- **Matrix** is a `ChannelStreamAdapter` (`/sync` long-poll) on the existing `ChannelStreamRuntimeService`. Its `since` token is kept in `systemSettings`, so no new table is needed.
- **QQBot and WeCom** are webhook channels built from `createWebhookHandler`, each with a `<ch>-webhook.ts` verifier and normalizer. Both dispatch through `dispatchInboundWebhookMessage`, and both dedupe durably on the provider message id.
- **Notion and GitHub** follow Trello. Each gets a catalog form, registry actions and an extracted `invoke<Provider>Action` module. Writes go through `runWardGatedExternalSideEffect` → `runIdempotentExternalSideEffect`.
- **Plugin integrity** adds an async verifier that runs before the sync record builder. The verifier handles npm tarballs (SRI `sha512`) and local folders (a deterministic manifest hash).

**Tech Stack:** TypeScript, Fastify gateway, vitest, Node's global `fetch` and `node:crypto` (repo-pinned Node 22 LTS) (ed25519, AES-256-CBC, SHA-1/256/512). No new dependencies.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md`, section "WS6 — New integrations", plus its Global Constraints and Review Focus. Issues: #356 (Matrix), #357 (QQBot), #358 (WeCom), #359 (Notion), #360 (GitHub), #348 (plugin integrity); tracker #341. Task 6.6 (iMessage via Photon) is **out of scope**, because it is blocked on the operator-supplied sidecar contract (#355).

**Templates to copy:**
- WS5a `34a251e91` (#386): stream runtime, ntfy, Mattermost and Google Chat inbound.
- WS5b `184086157` (#397): actions and typing.
- Trello path: `integration-action-service.ts` + `integration-writeback-run-inputs.ts`.
- npm download, SRI check and tree hash: `reviewed-mcp-package.ts`.

**Delivery:** four PRs against `main`.

| PR | Branch | Tasks | Closes |
|---|---|---|---|
| A | `feat/gap-ws6a-matrix` (off origin/main) | 1–3 | #356 |
| B | `feat/gap-ws6b-qqbot-wecom` (**stacked on A**, because both edit channel-core, comms-executor and the parity matrix) | 4–6 | #357, #358 |
| C | `feat/gap-ws6c-notion-github` (off origin/main) | 7–9 | #359, #360 |
| D | `feat/gap-ws6d-plugin-integrity` (off origin/main) | 10–11 | #348 |

Each PR body says `Refs #341`. It uses `Closes #N` only when every "Done when" box of that issue is met; otherwise it uses `Refs #N` and ticks the finished boxes.

## Global Constraints

- Work only in the dedicated WS6 worktree. Never edit the main checkout. Never `git stash`.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`. Policy-engine: `pnpm --filter @goatcitadel/policy-engine exec vitest run <file> --maxWorkers=2`. gateway-core: `pnpm --filter @goatcitadel/gateway-core exec vitest run src/channel-core.test.ts --maxWorkers=2`.
- Run one heavy job at a time, at low priority. A file that fails under load is re-run alone before it is treated as a real failure.
- Package tests resolve `@goatcitadel/contracts` and `@goatcitadel/gateway-core` from `dist`. Rebuild after editing: `pnpm --filter @goatcitadel/contracts build`, `pnpm --filter @goatcitadel/gateway-core build`.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- Never run `architecture:baseline:update`.
  - Each new `apps/gateway/src/services/**` file gets an entry in `scripts/verification/baselines/architecture-new-service-allowances.json` (`planStep: "C0"`, `reason` ≥ 20 chars, `evidence` ≥ 10 chars; copy the WS5 ntfy entry).
  - Keep all wiring out of `gateway-service.ts`.
  - `integration-writeback-run-inputs.ts` is at its 21/21 budget, so new host reads go into new files.
- **No new Postgres or SQLite tables or columns.**
  - Matrix cursors and plugin records live in `system_settings` JSON.
  - If a task finds it needs a table, stop and report.
- No personal paths in tracked files. Run `prettier --write` only on the files you changed. Use `git grep` for exhaustive searches.
- Commit messages: `<type>: <description>`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Push with `git -c credential.helper='!gh auth git-credential' push -u origin <branch>`.
- Every HTTP body read in `apps/gateway/src/services/**` and `packages/policy-engine/src/**` uses a bounded reader:
  - gateway: `readBoundedResponseText`/`Json`/`Bytes` from `bounded-response-reader.ts`;
  - policy-engine: its existing bounded readers in `comms-executor.ts`;
  - `pnpm check:bounded-response-reads` must pass.
- Secrets are resolved only at the tool-host boundary:
  - `secretFrom` in policy-engine;
  - `resolveConnectionSecret` in gateway services;
  - `readConfigSecret` in webhook routes.
  - No secret, token or AES key appears in an error message, a diagnostic, a durable event or a public projection.
- Every operator-configured outbound URL (the Matrix homeserver) passes the connection allowlist (`isConnectionUrlAllowlisted` / policy `fetchAllowlisted`).
- Token mints (QQ `getAppAccessToken`, WeCom `gettoken`) pass `{ crossesExternalSideEffect: false }`, as `googleChatFetchers` does.
- Catalog maturity: `IntegrationMaturity` has no `"live"` value, so "live" means `"beta"`, which the WS5 channels use.
- Docs, UI copy and code agree. Delete every "Catalog-only …" and "Runtime adapter probes are not wired yet" string for the channels this workstream wires (`git grep` must return nothing outside `docs/superpowers/`). Update `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`, the README channel rows (keep the governance-gate verbatim phrases), `docs/1_0_CONTRACT.md` and `docs/CANONICAL_RUNTIME_STATE_MODEL.md` wherever they enumerate channels, integrations or idempotent writes.
- No xAI/Grok/X integrations.
- Per-PR proof lanes:
  - `pnpm typecheck`;
  - the focused tests;
  - `pnpm verify:architecture:metrics`;
  - `node scripts/verify-repo-hygiene.mjs` (run from PowerShell, not Git Bash);
  - `pnpm docs:check`;
  - `git diff --check`;
  - channel PRs also run `pnpm verify:channels:parity` and `pnpm verify:channels:guided`.

## Review Focus

1. **Duplicate delivery.** A Matrix `/sync` re-delivers a batch after a crash, or QQ/WeCom retries a webhook. Exactly one chat turn results. Pinned by the parametrized `inbound-channel-event-service.test.ts` case (Task 3 and Task 6), plus key-determinism tests in each adapter.
2. **Restart and reconnect replay history.**
   - A Matrix runtime with no stored `since` must not dispatch the room's back-history.
   - After a restart it resumes from the persisted `since`.
   - The `since` advances only after the whole batch is durably accepted.
   - Pinned in Task 1.
3. **Forged or replayed webhooks.**
   - A QQ request with a bad ed25519 signature, or a WeCom request with a bad `msg_signature`, gets 401 and no dispatch.
   - A WeCom payload whose decrypted `receiveid` is not the configured CorpID is rejected.
   - The QQ op-13 validation handshake must not become a signing oracle for arbitrary bytes.
   - Pinned in Tasks 4 and 5.
4. **The bot hears itself.** A Matrix event whose `sender` is the bot's own user id never starts a turn. Pinned in Task 1.
5. **Integrity downgrade.**
   - A tarball whose bytes don't match the registry's or the operator's SRI value is never stored as verified.
   - It ends `quarantined` with `enabled: false`.
   - It cannot be re-enabled through `setIntegrationPluginEnabled`.
   - A registry host missing from the operator allowlist means no fetch and no `verified`.
   - Pinned in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/gateway/src/services/channel-stream-adapters/matrix-stream-adapter.ts` (new) | Matrix `whoami` + `/sync` long-poll reader, normalizer, self-echo filter |
| `apps/gateway/src/services/channel-stream-cursor-store.ts` (new) | Durable per-connection stream cursor over `systemSettings` |
| `apps/gateway/src/services/matrix-live-probes.ts`, `qqbot-live-probes.ts`, `wecom-live-probes.ts` (new) | Setup/diagnostic probes (Nextcloud Talk shape) |
| `apps/gateway/src/services/channel-setup-definitions/{matrix,qqbot,wecom}.ts` (new) | Guided setup definitions |
| `apps/gateway/src/services/qqbot-webhook.ts`, `wecom-webhook.ts` (new) | Signature verification, decryption, normalization |
| `apps/gateway/src/routes/integration-webhooks-qqbot-routes.ts`, `integration-webhooks-wecom-routes.ts` (new) | Webhook routes |
| `packages/policy-engine/src/tool-executor/matrix-client.ts`, `qqbot-client.ts`, `wecom-client.ts` (new) | Outbound API calls + token caches, called from `comms-executor.ts` switches (keeps the 4.8k-line executor from growing much) |
| `apps/gateway/src/services/notion-integration-action.ts`, `github-integration-action.ts` (new) | Read dispatch + write run-input builders per provider |
| `apps/gateway/src/services/integration-plugin-package-integrity.ts` (new) | npm tarball and local-manifest verification + plugin store writes |

---

## PR A — Matrix

### Task 1: Matrix inbound stream adapter + durable `since`

**Files:**
- Create: `apps/gateway/src/services/channel-stream-cursor-store.ts` + `.test.ts`
- Create: `apps/gateway/src/services/channel-stream-adapters/matrix-stream-adapter.ts` + `.test.ts`
- Modify: `apps/gateway/src/services/channel-stream-runtime-registry.ts`. Register the adapter. Extend `ChannelStreamRuntimeHost.storage` with `systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set">`, and update its allowance entry if the counts grow.
- Modify: `architecture-new-service-allowances.json`.

**Interfaces (Produces):**

```ts
// channel-stream-cursor-store.ts
export interface ChannelStreamCursorStore {
  read(channelKey: string, connectionId: string): Promise<{ cursor: string; scope?: string } | undefined>;
  write(channelKey: string, connectionId: string, value: { cursor: string; scope?: string }): Promise<void>;
}
export const CHANNEL_STREAM_CURSOR_SETTING_PREFIX = "channel_stream_cursor_v1";
export function createSystemSettingsChannelStreamCursorStore(
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set">,
  now?: () => Date,
): ChannelStreamCursorStore; // key `${PREFIX}:${channelKey}:${connectionId}`, value { cursor, scope?, updatedAt }

// matrix-stream-adapter.ts
export interface MatrixStreamAdapterDeps {
  fetch: typeof fetch;
  resolveSecret(config: Record<string, unknown>, directKey: string, envKey: string, catalogId?: string): string | undefined;
  isUrlAllowlisted(url: string): boolean;
  cursorStore: ChannelStreamCursorStore;
  longPollTimeoutMs?: number; // default 30_000
}
export function createMatrixStreamAdapter(deps: MatrixStreamAdapterDeps): ChannelStreamAdapter; // channelKey "matrix", idleTimeoutMs = longPollTimeoutMs + 60_000
export function isMatrixInboundEnabled(config: Record<string, unknown>): boolean; // exported from gateway-core channel-core (Task 2) and reused
```

**Config keys:**
- `homeserverUrl`;
- `accessToken` / `accessTokenEnv` (env names must start with `MATRIX_`, per the env guard);
- `defaultRoomId`;
- `inboundStreamEnabled` (boolean);
- plus `...forcedAllowlistInboundFields`, as ntfy has.

**Behavior:**
- **Inbound is enabled** only when `inboundStreamEnabled === true`, `homeserverUrl` is set and a token resolves.
- **Every request** is checked with `isUrlAllowlisted` first; a disallowed host throws `ChannelStreamAuthError("Matrix homeserver is not in the outbound allowlist")`. Requests carry `Authorization: Bearer <token>`. A 401/403, or `errcode` `M_UNKNOWN_TOKEN` / `M_FORBIDDEN`, throws `ChannelStreamAuthError`; any other non-2xx throws a plain Error. Bodies are read with `readBoundedResponseJson`, 4 MiB cap.
- **Startup:** `GET {hs}/_matrix/client/v3/account/whoami` gives `user_id`, the self id. The scope is `user_id`. A stored cursor whose `scope` differs from `user_id` is discarded (the token now belongs to a different account).
- **Starting cursor:** the stored cursor, else `ctx.cursor`. If there is neither:
  - Run a **priming sync**: `GET /_matrix/client/v3/sync?timeout=0&filter=<urlencoded {"room":{"timeline":{"limit":0}},"presence":{"types":[]},"account_data":{"types":[]}}>`.
  - Write `next_batch` to the cursor store, call `markReady()` and dispatch nothing.
- **Loop**, until `ctx.signal` aborts:
  - Request `GET /sync?since=<c>&timeout=<longPollTimeoutMs>&filter=<urlencoded {"room":{"timeline":{"types":["m.room.message"]}},"presence":{"types":[]},"account_data":{"types":[]}}>`.
  - Call `markReady()` on the first 2xx and `ctx.touch()` on every response.
  - For each `rooms.join[roomId].timeline.events[]` with `type === "m.room.message"`, `sender !== user_id`, `content.msgtype` in `["m.text","m.emote"]` (skip `m.notice`, which bots use) and a non-empty `content.body`, **await** `ctx.emit(event)` in order.
  - Only after every emit in the batch resolves, write `next_batch` to the cursor store and pass it as the cursor (`ctx.emit` is not used for the cursor; call `cursorStore.write` and track the cursor locally).
  - If an emit rejects, the error propagates. The cursor is not written, so the runtime refetches the same batch and durable dedupe absorbs the overlap.
- **Emitted event:**
  - `idempotencyKey = matrix:${connectionId}:${event.event_id}`
  - `eventType: "matrix-room-message"`
  - `bindingTarget: roomId`
  - `responseOptions: { deliveryReplyToMessageId: event.event_id }`
  - `message = { eventId: event.event_id, account: connectionId, room: roomId, actorId: event.sender, actorType: "user", content: content.body, threadId: content["m.relates_to"]?.rel_type === "m.thread" ? content["m.relates_to"].event_id : undefined, metadata: { roomId, originServerTs: event.origin_server_ts, msgtype } }`

- [ ] **Step 1: Write failing cursor-store tests.** Cover: round-trip; the key format `channel_stream_cursor_v1:matrix:<id>`; a missing key returns `undefined`.
- [ ] **Step 2: Write failing adapter tests** with a fake `fetch` that routes on the URL and an in-memory cursor store:
  - "primes with a limit-0 sync and dispatches no history when no cursor is stored";
  - "resumes from the persisted since after a restart" (a new adapter instance with the same store gives a first URL containing `since=<stored>`);
  - "advances the persisted since only after every event in the batch is accepted" (the second emit rejects, so the store still holds the old cursor);
  - "ignores the bot's own messages and m.notice";
  - "emits the exact normalized event" (asserting the object above);
  - "derives identical idempotency keys when the same batch is replayed in two sessions";
  - "discards a stored cursor whose whoami scope changed";
  - "401 and M_UNKNOWN_TOKEN throw ChannelStreamAuthError";
  - "a homeserver outside the allowlist throws ChannelStreamAuthError";
  - "allowlist gate drops a non-allowlisted sender" (copy `ntfy-stream-adapter.test.ts:214`: a real `ChannelStreamRuntimeService` plus `dispatchInboundWebhookMessage`, where `acceptInboundChannelEvent` must not be called and `channel.sender_not_allowlisted` is recorded).
- [ ] **Step 3: Run them.** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/channel-stream-cursor-store.test.ts src/services/channel-stream-adapters/matrix-stream-adapter.test.ts --maxWorkers=2`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** the store, the adapter and the registry registration (`createMatrixStreamAdapter({ ...sharedDeps, cursorStore: createSystemSettingsChannelStreamCursorStore(host.storage.systemSettings) })`).
- [ ] **Step 5: Run the tests again, plus** `channel-stream-runtime-service.test.ts`, `gateway-runtime-factory.channel-streams.test.ts` and `pnpm --filter @goatcitadel/gateway typecheck`. Expected: PASS. If a port literal fails typecheck for the new `systemSettings` member, fix those callers.
- [ ] **Step 6: Commit.** `feat(channels): Matrix inbound via /sync long-poll with a durable since token`

### Task 2: Matrix outbound (send, react, redact, typing) + capabilities

**Files:**
- Create: `packages/policy-engine/src/tool-executor/matrix-client.ts` + `.test.ts`
- Modify: `comms-executor.ts`. Add `case "matrix"` to the `executeCommsProviderTool`, `commsReact` and `commsUnsend` switches, and add `CHANNEL_TARGET_KEYS.matrix = ["defaultRoomId","defaultTarget","target"]`. Add matrix to the mention-neutralize list if Matrix renders mentions (it does not for plain `body`, so leave it out).
- Modify: `packages/policy-engine/src/sandbox/engine.ts` `extractGrantHostCandidates`. Add the `homeserverUrl` host for matrix, as the ntfy `baseUrl` case does.
- Modify: `apps/gateway/src/services/channel-typing-adapters.ts` (matrix case), `comms-service.ts` `commsTyping` key list, `integration-channel-activity.ts` typing list, and `apps/gateway/src/services/channel-config.ts` `CHANNEL_TARGET_KEYS`.
- Modify: `packages/gateway-core/src/channel-core.ts`. Add the `matrix` rule and export `isMatrixInboundEnabled`.
- Modify: `channel-core.test.ts`.

**Interfaces (Produces):**

```ts
// matrix-client.ts
export interface MatrixClientContext { homeserverUrl: string; accessToken: string; allowlist: string[]; grantAllowlist?: string[] }
export async function matrixSendText(ctx: MatrixClientContext, input: { roomId: string; body: string; txnId: string; replyToEventId?: string; threadRootId?: string }): Promise<{ eventId: string }>;
export async function matrixReact(ctx: MatrixClientContext, input: { roomId: string; eventId: string; key: string; txnId: string }): Promise<{ eventId: string }>;
export async function matrixRedact(ctx: MatrixClientContext, input: { roomId: string; eventId: string; txnId: string; reason?: string }): Promise<{ eventId: string }>;
export async function matrixSetTyping(ctx: MatrixClientContext, input: { roomId: string; userId: string; typing: boolean; timeoutMs?: number }): Promise<void>;
export async function matrixWhoAmI(ctx: MatrixClientContext): Promise<{ userId: string }>;
```

**Request shapes:**
- **Send:** `PUT /_matrix/client/v3/rooms/{enc roomId}/send/m.room.message/{enc txnId}` with `{ msgtype: "m.text", body }`.
  - A reply adds `"m.relates_to": { "m.in_reply_to": { event_id } }`.
  - A thread adds `"m.relates_to": { rel_type: "m.thread", event_id: threadRootId, is_falling_back: true, "m.in_reply_to": { event_id: replyToEventId ?? threadRootId } }`.
- **React:** `PUT …/send/m.reaction/{txnId}` with `{ "m.relates_to": { rel_type: "m.annotation", event_id, key } }`.
- **Redact:** `PUT …/rooms/{roomId}/redact/{eventId}/{txnId}` with `{ reason? }`.
- **Typing:** `PUT …/rooms/{roomId}/typing/{enc userId}` with `{ typing, timeout }`.
- **Transaction id:** derived from the tool call's idempotency key when present (`sha256(key + ":" + chunkIndex)` hex, first 32 chars), else `randomUUID()`. Matrix dedupes a repeated txnId per access token, so a re-sent chunk is idempotent at the provider.
- **providerMessageId** is the returned `event_id`.
- **Targets:** react and unsend take the room from the normalized target, or the original message's room, and the event id from the message id argument, as Mattermost does.

**channel-core `matrix` rule:**
- `supportedActions` are send, reply, react, unsend and typing. `supportedAttachmentSources: []` (text-only in v1, stated in supportNotes). Chunking is `"fallback"`.
- `requiredAnyOf: [["homeserverUrl"],["accessTokenEnv","accessToken"]]`.
- `resolveInboundModes` returns `["stream"]` when `isMatrixInboundEnabled`, else `["none"]`.
- Posture is persistent/stream/ready when inbound is enabled, else stateless/api.
- `operatorSummary`: "Matrix uses the client-server API with an access token; optional inbound long-polls /sync and resumes from a stored sync token after restarts."

- [ ] **Step 1: Write failing `matrix-client.test.ts`.** Cover:
  - the exact URL, method and body for each call;
  - reply and thread `m.relates_to`;
  - a deterministic txnId for the same key and chunk;
  - an allowlist-denied homeserver throws before fetch;
  - a non-2xx response surfaces `errcode`/`error` without the token.
- [ ] **Step 2: Write failing tests** for the rest:
  - a `channel-core.test.ts` matrix case (inbound and outbound-only configs);
  - a `channel-typing-adapters.test.ts` matrix case (whoami once, then the PUT typing call);
  - a policy `tool-executor.test.ts` case named `"matrix channel.send posts m.room.message"`, so the parity proof's `policyAdapterPattern` can match it.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.** Rebuild gateway-core and policy-engine dists if gateway tests import them.
- [ ] **Step 5: Run the tests,** plus `comms-service.test.ts` and the gateway and policy-engine typechecks. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(channels): Matrix send, react, redact and typing`

### Task 3: Matrix catalog, setup, probe, diagnostics, parity, docs

**Files:**
- Modify: `integration-catalog.ts`.
  - Form `channel.matrix`: the description becomes "Configure a Matrix bot account (access token) for room sends, reactions, redactions and optional /sync inbound."
  - Add the `inboundStreamEnabled` opt-in plus forced-allowlist fields.
  - Make `defaultRoomId` not required; the room comes from the target.
  - Entry: `"beta"`, description "Matrix rooms over the client-server API, with optional /sync inbound.", capabilities `["chat","rooms","reactions","unsend","typing","inbound"]`.
- Create: `apps/gateway/src/services/channel-setup-definitions/matrix.ts`. Register it in `channel-setup-definitions.ts` with `withGuidedJourney`, and add a `POSTURE.matrix` entry in `guided-journey.ts`. Add `"matrix"` to `GUIDED_INBOUND_CHANNELS` and `FORCED_ALLOWLIST_INBOUND_CHANNELS` (`channel-setup-inbound-access.ts`) and to `GENERIC_ALLOWLIST_INBOUND_CHANNELS` (`integration-diagnostics-service.ts`).
- Create: `apps/gateway/src/services/matrix-live-probes.ts` + `.test.ts`. Use the shape of `runConfiguredMatrixChecks(deps: IntegrationDiagnosticsPort, connection, includeSandboxSend)`:
  - the allowlist check;
  - `whoami` (pass, or fail with "token rejected");
  - `GET /_matrix/client/v3/joined_rooms`, which warns when `defaultRoomId` is not joined;
  - when `includeSandboxSend` is set, a `m.notice` send to `defaultRoomId`.
  - Register it in the `runIntegrationConnectionLiveChecks` switch, and add a structural-checks `case "matrix"`.
- Modify: `connector-registry.ts` (approval-delivery hint) and `connector-registry.loop28.test.ts`.
- Modify: `scripts/verification/lib/channel-parity-matrix.mjs`. Add `matrix` to `REQUIRED_CHANNEL_FAMILIES`, then add two rows:
  - `matrix.client-outbound`: `inboundMode "none"`, stateless.
  - `matrix.sync-stream`: `inboundStreamEnabled: true`, `inboundMode "stream"`, persistent, with durability override `{ inboundCommitBeforeAck: true, inboundReplay: "persisted_sync_token", restartRecovery: "persistent_runtime_resumes_from_persisted_sync_token" }`. Its proofs are the adapter test, `channel-stream-runtime-service.test.ts` and `matrix-live-probes.test.ts`.
  - Update `channel-parity-matrix.test.mjs` if it pins the family list.
- Modify: `scripts/verification/channel-parity-proof.mjs` (gateway test list plus `policyAdapterPattern`) and `scripts/verification/lib/scenarios/channel-guided-setup-lane.mjs` `GUIDED_CHANNEL_CATALOG_IDS`, with its unit test.
- Modify: `apps/gateway/src/services/inbound-channel-event-service.new-adapters.fixtures.ts`. Add `buildMatrix()` from real adapter output, and add `"matrix"` to the `it.each` in `inbound-channel-event-service.test.ts:424`.
- Modify tests that pin lists: `integration-catalog.test.ts` (the beta/runnable list; move matrix out of the planned list), `channel-setup-definitions.test.ts` (L40-62 and L1315-1330), `apps/gateway/src/services/channel-parity-matrix.test.ts`.
- Docs: `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md` (a Matrix section: create a bot account, get an access token, `MATRIX_ACCESS_TOKEN`, invite the bot to the room, add the homeserver host to the network allowlist), plus the README, 1_0_CONTRACT and canonical-model channel lists if they enumerate channels.

- [ ] **Step 1: Write the failing tests:**
  - probe tests (whoami ok and 401; joined-rooms warning; sandbox send only when requested; disallowed host gives a failed check with no fetch);
  - a setup-definition test (hydrate and normalize force `inboundAccessMode: "allowlist"` when opted in);
  - the duplicate-event `it.each` case;
  - the catalog test expecting `channel.matrix` to be beta and runnable.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates:**
  - `git grep -n "Runtime adapter probes are not wired yet\|Catalog-only Matrix"` returns only `docs/superpowers/` hits;
  - `node --test scripts/verification/lib/channel-parity-matrix.test.mjs scripts/verification/lib/scenarios/channel-guided-setup-lane.test.mjs`;
  - `pnpm verify:channels:parity`, `pnpm verify:channels:guided`, `pnpm typecheck`, `pnpm verify:architecture:metrics`, `pnpm docs:check`;
  - repo hygiene (PowerShell);
  - `git diff --check`.
- [ ] **Step 5: Commit.** `feat(channels): Matrix catalog, guided setup, live probes and parity rows`. Open PR A.

---

## PR B — QQBot + WeCom (stacked on A)

### Task 4: QQBot webhook inbound (ed25519)

**Files:**
- Create: `apps/gateway/src/services/qqbot-webhook.ts` + `.test.ts`
- Create: `apps/gateway/src/routes/integration-webhooks-qqbot-routes.ts`, test `apps/gateway/src/routes/integrations.qqbot-webhook.test.ts`
- Modify:
  - `webhook-handler-factory.ts`: the `source` union and `qqbotRawBody`;
  - `routes/integration-webhooks.ts`: registration;
  - `route-access.ts`: prefix `/api/v1/integrations/connections/:connectionId/qqbot/webhook`, `accessClass: "webhook"`;
  - `plugins/auth.ts` and `plugins/idempotency.ts`: `isQqbotWebhookPath`;
  - `webhook-rate-limit.ts`: the source union;
  - the `app.ts` `isSignedInboundWebhookRoute` regex: add `qqbot`, `wecom` and the missing `google-chat`;
  - `channel-secret-resolution.ts` `CHANNEL_SECRET_ENV_PATTERNS`: add `QQBOT_` and `WECOM_`;
  - `integration-webhooks-shared.ts`: `resolveQqbotSecret`.

**Interfaces (Produces):**

```ts
export function isQqbotWebhookPath(url: string): boolean;
export function deriveQqbotEd25519KeyPair(appSecret: string): { privateKey: KeyObject; publicKey: KeyObject };
// seed = appSecret repeated until ≥ 32 bytes, first 32 bytes (UTF-8); private key from PKCS#8 DER prefix 302e020100300506032b657004220420 + seed
export function verifyQqbotSignature(input: { appSecret: string; signatureHex: string | undefined; timestamp: string | undefined; rawBody: Buffer }): boolean; // message = timestamp + rawBody; crypto.verify(null, …)
export function signQqbotValidation(input: { appSecret: string; eventTs: string; plainToken: string }): string; // hex signature over eventTs + plainToken
export function normalizeQqbotWebhookPayload(input: { connectionId: string; payload: unknown }):
  | { kind: "validation"; plainToken: string; eventTs: string }
  | { kind: "message"; eventId: string; eventType: string; scope: "group" | "c2c" | "channel" | "dm"; target: string; actorId: string; content: string; metadata: Record<string, unknown> }
  | { kind: "ignore"; reason: string };
```

**Config keys:**
- `appId`;
- `appSecret` / `appSecretEnv` (`QQBOT_*`). This replaces the catalog's `tokenEnv`; hydrate maps a legacy `tokenEnv` to `appSecretEnv`.
- `sandbox` (boolean);
- `defaultTarget`;
- forced-allowlist inbound fields.

**Behavior:**
- **Headers:** `X-Signature-Ed25519` (hex) and `X-Signature-Timestamp`. A missing or bad signature gets 401 with no dispatch. This applies to **every** request, op 13 included.
- **op 13 (callback validation):**
  - It is answered only if `plain_token` matches `^[A-Za-z0-9_-]{1,128}$` and `event_ts` matches `^\d{1,16}$`. Otherwise 400.
  - The reply is `{ plain_token, signature: signQqbotValidation(...) }`, returned as `parsePayload` → `{ kind: "reply" }`.
  - The format check stops the reply from signing anything that could equal `timestamp + JSON body`.
- **op 0 dispatch:**
  - `GROUP_AT_MESSAGE_CREATE`: scope `group`, target `group:${d.group_openid}`, actor `d.author.member_openid`.
  - `C2C_MESSAGE_CREATE`: scope `c2c`, target `user:${d.author.user_openid}`, actor `d.author.user_openid`.
  - `AT_MESSAGE_CREATE`: scope `channel`, target `channel:${d.channel_id}`, actor `d.author.id`.
  - `DIRECT_MESSAGE_CREATE`: scope `dm`, target `dm:${d.guild_id}`, actor `d.author.id`.
  - `eventId = d.id` (the message id). `content = d.content.trim()` with a leading `<@!…>` mention stripped.
  - Other `t` values and other ops are ignored, with a reply of `{ op: 12 }`.
- **Dispatch:**
  - `idempotencyKey = qqbot:${connectionId}:${eventId}`;
  - `bindingTarget = target`;
  - `inboundAccessConfig: { ...connection.config, inboundAccessMode: "allowlist" }`;
  - `responseOptions.deliveryReplyToMessageId = eventId`;
  - `message.metadata.qqReplyMsgId = eventId`. This feeds the passive reply `msg_id`, because QQ restricts active group and C2C messages.
  - The HTTP reply is `{ op: 12 }`. A dispatch error gives 503 so QQ retries (the Google Chat pattern).

- [ ] **Step 1: Write failing verifier tests.**
  - Generate a fixture key pair from a known secret with `deriveQqbotEd25519KeyPair` and sign a body. Then assert:
    - a good signature verifies;
    - a flipped byte is rejected;
    - a wrong timestamp is rejected;
    - a missing header is rejected.
  - Pin the seed derivation with a vector: secret `"naOC0ocQE3shWLAfffVLB1rhYPG7"` gives a public key equal to the value computed once and hard-coded in the test. Record how the value was computed in a comment.
  - A validation token with `{` is refused by the format check.
  - The normalizer cases for the four event types, plus the ignore cases.
- [ ] **Step 2: Write failing route tests** (copy `integrations.google-chat-webhook.test.ts`):
  - a bad signature gets 401 and no dispatch;
  - op 13 gets a signed reply;
  - a group message dispatches once with the exact options;
  - the same delivery replayed is deduped (`deduped: true`);
  - a non-allowlisted sender is dropped;
  - legacy-open access is never applied;
  - the route passes the auth and idempotency plugins without operator credentials.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them.** Expected: PASS. Also run `webhook-handler-factory.test.ts`, `route-access` tests and `integration-webhooks.security.test.ts`.
- [ ] **Step 6: Commit.** `feat(channels): QQBot webhook inbound with ed25519 verification`

### Task 5: WeCom callback inbound (AES-CBC + SHA-1 signature)

**Files:**
- Create: `apps/gateway/src/services/wecom-webhook.ts` + `.test.ts`
- Create: `apps/gateway/src/routes/integration-webhooks-wecom-routes.ts`, test `integrations.wecom-webhook.test.ts`
- Same registration files as Task 4, with `wecom`. Add `resolveWecomCallbackSecrets` in `integration-webhooks-shared.ts`.
- Modify: `packages/contracts/src/secret-redaction.ts` `isSensitiveStructuredKey`. Also match `ENCODING_AES_KEY` / `AES_KEY`, and add a test. Add a projection test in `integration-connection-public-projection.test.ts` asserting that `encodingAesKey` is redacted.

**Interfaces (Produces):**

```ts
export function isWecomWebhookPath(url: string): boolean;
export function computeWecomSignature(token: string, timestamp: string, nonce: string, encrypted: string): string; // sha1 hex of [token,timestamp,nonce,encrypted].sort().join("")
export function decryptWecomMessage(input: { encodingAesKey: string; encrypted: string; expectedReceiveId: string }): string;
// key = base64(encodingAesKey + "=") (must be 32 bytes, else throw "WeCom EncodingAESKey is malformed"); iv = key[0..16];
// aes-256-cbc, setAutoPadding(false); strip PKCS#7 with block size 32 (pad 1..32 else throw);
// layout: 16 random bytes | uint32 BE msgLen | msg | receiveId; receiveId !== expectedReceiveId → throw "WeCom receive id mismatch"
export function encryptWecomMessageForTest(input: { encodingAesKey: string; message: string; receiveId: string; random?: Buffer }): string; // test helper, exported for tests only
export function readWecomXmlFields(xml: string, names: readonly string[]): Record<string, string | undefined>;
// flat <Name><![CDATA[v]]></Name> or <Name>v</Name>; no DTD/entities (reject "<!DOCTYPE" / "<!ENTITY"); max 256 KiB
export function normalizeWecomMessage(input: { connectionId: string; xml: string }):
  | { kind: "message"; eventId: string; actorId: string; agentId?: string; content: string; metadata: Record<string, unknown> }
  | { kind: "ignore"; reason: string };
```

**Config keys:**
- `corpId`;
- `agentId`;
- `secret` / `secretEnv` (the app secret, `WECOM_*`);
- `callbackToken` / `callbackTokenEnv`;
- `encodingAesKey` / `encodingAesKeyEnv`;
- `defaultTarget`;
- forced-allowlist inbound fields.

**Behavior:**
- **GET (URL verification):** copy the hand-written WhatsApp GET handler.
  - Query: `msg_signature`, `timestamp`, `nonce`, `echostr`.
  - Check the signature with a timing-safe compare against `computeWecomSignature(token, ts, nonce, echostr)`.
  - Reply with `text/plain`: `decryptWecomMessage({ encrypted: echostr, expectedReceiveId: corpId })`.
  - A bad signature gives 401.
- **POST:**
  - Register a route-scoped content-type parser for `text/xml` and `application/xml` that leaves the raw body (`wecomRawBody`).
  - Read the outer `Encrypt` with `readWecomXmlFields` and verify `msg_signature` over `Encrypt`. A failure gives 401.
  - Decrypt, then normalize. Only `MsgType === "text"` is dispatched; other types and `event` are ignored.
  - Fields: `eventId = MsgId`, `actorId = FromUserName`, `content = Content`.
  - The reply is an empty 200 `"success"`.
- **Dispatch:**
  - `idempotencyKey = wecom:${connectionId}:${MsgId}`;
  - `bindingTarget = user:${FromUserName}`;
  - forced allowlist;
  - a dispatch error gives 503.
- **Timestamp freshness is not enforced;** durable dedupe absorbs replays.

- [ ] **Step 1: Write failing verifier tests:**
  - an encrypt/decrypt round-trip with a fixed 43-char key and a fixed random value;
  - a wrong `receiveId` throws;
  - bad padding throws;
  - a malformed key throws with the generic message (it does not echo the key);
  - the signature matches a hand-computed SHA-1 vector;
  - the XML reader rejects `<!DOCTYPE`;
  - the normalizer handles text and ignores events.
- [ ] **Step 2: Write failing route tests:**
  - GET with a good signature echoes the decrypted echostr;
  - GET with a bad signature gets 401;
  - POST with a bad signature gets 401 and no dispatch;
  - a text message dispatches once;
  - a replayed delivery is deduped;
  - a non-allowlisted `FromUserName` is dropped;
  - a decrypted payload with a foreign CorpID gets 401 and no dispatch.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them,** plus the redaction tests (`pnpm --filter @goatcitadel/contracts exec vitest run src/secret-redaction.test.ts --maxWorkers=2`, or that package's runner). Expected: PASS.
- [ ] **Step 6: Commit.** `feat(channels): WeCom callback inbound with AES-CBC decryption and signature check`

### Task 6: QQBot + WeCom outbound, capabilities, setup, probes, parity, docs

**Files:**
- Create: `packages/policy-engine/src/tool-executor/qqbot-client.ts` and `wecom-client.ts` (+ tests). Modify the `comms-executor.ts` switches and `CHANNEL_TARGET_KEYS` (`qqbot`/`wecom: ["defaultTarget","target"]`). In `fixed-outbound-hosts.ts`, add `["qqbot", ["api.sgroup.qq.com","sandbox.api.sgroup.qq.com","bots.qq.com"]]` and `["wecom", ["qyapi.weixin.qq.com"]]` to `FIXED_OUTBOUND_HOSTS_BY_CHANNEL_KEY`.
- Modify: the `channel-core.ts` `qqbot` and `wecom` rules, and `CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS` in contracts:
  - wecom: `channel.typing` ("WeCom has no typing indicator API for app messages").
  - qqbot: `channel.typing`. react/unsend stay "not supported by this adapter"; do not claim platform-unsupported.
- Create: setup definitions `channel-setup-definitions/qqbot.ts` and `wecom.ts` with guided `POSTURE`. The setup UI shows the webhook URL the operator pastes into the QQ/WeCom console, following the Nextcloud Talk definition.
- Create: `qqbot-live-probes.ts` and `wecom-live-probes.ts` (+ tests), registered in diagnostics with structural checks.
- Modify: the catalog (both forms and entries, flipped to beta and with the "Catalog-only" copy deleted), the `integration-secret-envvar-guard.ts` stale alias (`"channel.qq"` becomes `"channel.qqbot"`), `connector-registry.ts`, the parity matrix (families plus rows `qqbot.webhook`, `wecom.callback`, default durability), the proof script, the guided lane, the duplicate-event `it.each` (`"qqbot"`, `"wecom"`), and the list-pinning tests from Task 3.
- Docs: QQBot and WeCom sections in `COMMUNICATION_CHANNEL_SETUP_GUIDE.md`, plus the README and contract lists.

**Interfaces (Produces):**

```ts
// qqbot-client.ts
export async function getQqbotAccessToken(input: { appId: string; appSecret: string; fetcher: Fetcher; now?: () => number }): Promise<string>;
// POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}; cache per sha256(appId+secret) until expires_in-60s; errors never include the secret
export async function qqbotSendText(input: { token: string; sandbox: boolean; target: string; content: string; replyMsgId?: string; msgSeq: number; fetcher: Fetcher }): Promise<{ messageId: string }>;
// base https://api.sgroup.qq.com (sandbox https://sandbox.api.sgroup.qq.com); Authorization: `QQBot ${token}`
// group:<openid> → POST /v2/groups/{openid}/messages {content,msg_type:0,msg_id?,msg_seq}; user:<openid> → /v2/users/{openid}/messages;
// channel:<id> → POST /channels/{id}/messages {content,msg_id?}; dm:<guild_id> → /dms/{guild_id}/messages; unknown prefix → throw "QQBot target must be group:, user:, channel: or dm:"
// wecom-client.ts
export async function getWecomAccessToken(input: { corpId: string; secret: string; fetcher: Fetcher; now?: () => number }): Promise<string>; // GET /cgi-bin/gettoken?corpid&corpsecret; errcode≠0 → throw `WeCom gettoken failed (errcode ${n})`
export async function wecomSendText(input: { token: string; agentId: string; target: string; content: string; fetcher: Fetcher }): Promise<{ messageId: string }>;
// POST /cgi-bin/message/send?access_token=…; user:<id>|party:<id>|tag:<id>|bare id (=touser); {touser|toparty|totag, msgtype:"text", agentid:Number(agentId), text:{content}}; errcode 40014/42001 → drop cached token and retry once; other errcode≠0 → throw `WeCom send failed (errcode ${n}: ${errmsg})`
```

**Details:**
- The token URL never appears in errors or diagnostics, because it carries `access_token`. Redact it with the existing URL redaction helper.
- The QQ `msgSeq` is the chunk index + 1.
- The QQ `replyMsgId` comes from the delivery reply id, i.e. the inbound `eventId` via `responseOptions`.
- Note in the QQ supportNotes: QQ allows active (unprompted) group and C2C messages only within platform quotas, so replies within 5 minutes of an inbound message are passive replies.
- The QQ probe calls `getAppAccessToken` and `GET /users/@me`.
- The WeCom probe calls `gettoken` and `GET /cgi-bin/agent/get?agentid=`; it warns when the callback token or AES key are missing, since inbound would be disabled.
- Each probe sends a sandbox message only when `includeSandboxSend` is set.

- [ ] **Step 1: Write failing client tests:**
  - token cache reuse and expiry;
  - token-mint failure messages contain no secret;
  - URL and body for each target kind;
  - the WeCom 42001 retry happens once;
  - an unknown QQ target prefix throws.
  - Add policy `tool-executor.test.ts` cases named `"qqbot channel.send posts a passive group reply"` and `"wecom channel.send posts message/send"`.
- [ ] **Step 2: Write failing tests:**
  - probe tests;
  - channel-core cases;
  - the setup-definition hydrate test (the legacy `tokenEnv` maps to `appSecretEnv`);
  - the duplicate-event `it.each` cases;
  - catalog beta/runnable.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the gates** from Task 3 Step 4. `git grep "Catalog-only Q\|Catalog-only W"` must return nothing.
- [ ] **Step 6: Commit.** `feat(channels): QQBot and WeCom send, setup, probes and parity rows`. Open PR B, based on A's branch.

---

## PR C — Notion + GitHub

### Task 7: Shared write-builder exports + 401 mapping

**Files:**
- Modify: `apps/gateway/src/services/integration-writeback-run-inputs.ts`.
  - Export the private helpers that new providers need, parametrizing the hard-coded `"write"` actionId: `baseInput(host, connection, options, actionId)`, `buildDedupedExecute`, `buildReconcile`, `liveDedupeScope(connection, options, boundary, actionId)`, `digestScope` and `resolveApiBaseUrl`. Trello and Gmail still pass `"write"`.
  - Do not add host reads; the file is at its 21/21 budget.
  - Add `export class ProviderAuthRejectedError extends Error { constructor(provider: string, status: 401 | 403) }`, with the message `${provider} rejected the integration credentials (${status}).`.
- Test: `integration-writeback-run-inputs.test.ts`. The existing Trello and Gmail cases stay green.

- [ ] **Step 1:** Add a failing test: `ProviderAuthRejectedError` message and status. Run it; expected FAIL.
- [ ] **Step 2:** Implement the exports and the error class. Run `integration-writeback-run-inputs.test.ts` and `integration-action-service.test.ts`. Expected: PASS.
- [ ] **Step 3:** Run `pnpm verify:architecture:metrics` and confirm it is unchanged. Commit: `refactor(integrations): share writeback builders for new productivity providers`.

### Task 8: Notion integration

**Files:**
- Create: `apps/gateway/src/services/notion-integration-action.ts` + `.test.ts`, and the allowance entry.
- Modify:
  - `integration-catalog.ts`: form override; entry `"beta"`, `["token"]`, description "Notion pages: search, read, create and append through an internal integration token.";
  - `integration-action-registry.ts`;
  - `integration-action-service.ts`: dispatch branch `productivity.notion`;
  - `integration-diagnostics-service.ts`: `key === "notion"` structural checks plus a live check `GET /v1/users/me`;
  - `integration-catalog.test.ts`: the mandatory beta list;
  - `scripts/verification/lib/scenarios/catalog-parity-lane.mjs`: base-URL env, id lists and size checks, fixture routes, config and action input;
  - docs.

**Form fields:**
- `label`;
- `tokenEnv` ("Integration Token ENV Var", placeholder `NOTION_INTEGRATION_TOKEN`, required, secretRef);
- `defaultParentPageId`;
- `enabled`.

**Actions** (registry order; reads first):

| actionId | capability | inputs | call |
|---|---|---|---|
| `search` | read | `query` | `POST /v1/search {query, page_size: 10}` → items `{id, object, title, url}` |
| `page_read` | read | `pageId` (required) | `GET /v1/pages/{id}` + `GET /v1/blocks/{id}/children?page_size=50` → `{id, title, url, blocks:[{id,type,text}]}` |
| `page_create` | write | `title` (required), `content`, `parentPageId` (falls back to `defaultParentPageId`; missing → blocked `notion_parent_missing`) | `POST /v1/pages {parent:{page_id}, properties:{title:{title:[{text:{content:title}}]}}, children:[paragraph(content), paragraph(marker)]}` |
| `block_append` | write | `blockId` (required), `content` (required) | `PATCH /v1/blocks/{id}/children {children:[paragraph(content), paragraph(marker)]}` |

**Request and reply rules:**
- **Headers:** `Authorization: Bearer`, `Notion-Version: 2022-06-28`, `Content-Type: application/json`.
- **Base URL:** `resolveApiBaseUrl("GOATCITADEL_NOTION_API_BASE_URL", "https://api.notion.com")`.
- **Missing token:** blocked `notion_auth_missing`.
- **Read errors:** 401/403 → blocked `notion_auth_rejected`, with the message "Notion rejected the integration token. Check the token and share the page with the integration." Any other non-2xx → failed, with Notion's `message`.
- **Write errors:** `send` throws `ProviderAuthRejectedError` on 401/403, and the run input sets `isExternalCallProvenNotDispatched: (e) => e instanceof ProviderAuthRejectedError`. The result is not `unknown_external_outcome`; it maps to blocked `notion_auth_rejected`.
- **Marker:** `[goatcitadel-idempotency:<32 hex>]`, from `digestScope("goatcitadel:notion-marker:v1", scope)`.
- **Probes:**
  - `block_append` reconcile probes `GET /v1/blocks/{id}/children?page_size=100`, taking the last page, for a paragraph containing the marker.
  - `page_create` has **no** reconcile probe; an unknown outcome stays manual review. Say so in a comment and in the PR body.
- **Destination fingerprints:** `fingerprintExternalSideEffectDestination(new URL("/v1/pages", base))` and `/v1/blocks/{id}/children`.
- **Replay allowlist:** not added. Replay jobs for these writes report `job_unavailable`, which is the existing behavior for non-allowlisted writes.

- [ ] **Step 1: Write failing tests** in `notion-integration-action.test.ts`, using the `integration-action-service.test.ts` host harness (`createHost`, `wardHost`, `vi.stubEnv` base URL):
  - happy path per action, with exact URL, headers and body, and output items;
  - `search` 401 → blocked `notion_auth_rejected`, with no token in the output;
  - `page_create` 401 → blocked `notion_auth_rejected`, and the side-effect run is not `unknown_external_outcome`;
  - ward deny on `search` → `citadel_ward_deny` with `wardAction "integration.productivity.notion.search"` and no fetch;
  - a `require_dry_run` ward on `page_create` opens a dry-run preview plus an approval and makes no provider call (the approval gating on writes);
  - an idempotent replay of `block_append`: the runner reports `duplicate`, so blocked `external_side_effect_duplicate` and no fetch;
  - the `block_append` reconcile probe finds the marker, so there is no second PATCH;
  - a missing parent → `notion_parent_missing`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The signature is `export async function invokeNotionAction(host: IntegrationActionHost, connection: IntegrationConnection, actionId: string, request: IntegrationActionInvokeInput, checkedAt: string, ward?: IntegrationWardContext): Promise<IntegrationActionInvokeResult>`.
- [ ] **Step 4: Run the new test,** plus `integration-action-service.test.ts`, `integration-catalog.test.ts`, `integration-diagnostics-service.contract.test.ts` and `node --test` on the catalog-parity lane unit test, if one exists. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(integrations): Notion search, page read, page create and block append`

### Task 9: GitHub integration + PR C docs

**Files:**
- Create: `apps/gateway/src/services/github-integration-action.ts` + `.test.ts`, and the allowance entry.
- Modify: the same registration files as Task 8, with `productivity.github`. In the catalog, the entry becomes `"beta"`, `["token"]`, "GitHub issues and pull requests: list, read, create issues and comment through a fine-grained token."
- Docs:
  - The idempotent-writes list in `docs/1_0_CONTRACT.md` (~L76), `docs/CANONICAL_RUNTIME_STATE_MODEL.md` (~L161), `docs/ENGINEERING_HANDBOOK.md` (~L23) and `docs/1_0_RELEASE_EVIDENCE.md` (~L112). Add "Notion page create and block append, GitHub issue create and comment", and keep the replay-allowlist sentence accurate: the allowlist is Activepieces `trigger_webhook`, Gmail `write`, Trello `write` and the local-bridge writes (Apple Notes, Apple Reminders, Things 3, Bear); Notion and GitHub stay excluded.
  - `docs/QA_MANUAL_TEST_PLAN.md` INT-05.
  - `docs/citadel_update/spec.md` L613 ("issues/PR read and draft only") gets a dated note: the 2026-10-15 gap-closure decision adds governed issue create and comment.

**Form fields:**
- `label`;
- `tokenEnv` (placeholder `GITHUB_INTEGRATION_TOKEN`, required, secretRef). The env guard already refuses `GITHUB_TOKEN`/`GH_TOKEN`; the field help says so.
- `defaultRepo` ("owner/name", required);
- `enabled`.

**Actions:**

| actionId | capability | inputs | call |
|---|---|---|---|
| `issue_list` | read | `repo?`, `state?` (open/closed/all, default open) | `GET /repos/{o}/{r}/issues?state&per_page=20`, drop items with `pull_request` → `{number,title,state,url,author}` |
| `issue_read` | read | `number` (required) | `GET /repos/{o}/{r}/issues/{n}` + `/comments?per_page=20` |
| `pr_list` | read | `repo?`, `state?` | `GET /repos/{o}/{r}/pulls?state&per_page=20` |
| `pr_read` | read | `number` (required) | `GET /repos/{o}/{r}/pulls/{n}` → `{number,title,state,draft,merged,head,base,url,body (≤4000 chars)}` |
| `issue_create` | write | `title` (required), `body`, `repo?` | `POST /repos/{o}/{r}/issues {title, body: body + "\n\n<!-- " + marker + " -->"}` |
| `issue_comment` | write | `number` (required), `body` (required), `repo?` | `POST /repos/{o}/{r}/issues/{n}/comments {body + marker comment}` |

**Request and reply rules:**
- **Repo validation:** `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`, else blocked `github_repo_invalid`.
- **Number validation:** a positive integer.
- **Headers:** `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: GoatCitadel`.
- **Base URL:** `GOATCITADEL_GITHUB_API_BASE_URL`, default `https://api.github.com`.
- **Errors:**
  - Missing token: `github_auth_missing`.
  - 401: `github_auth_rejected`.
  - 403 with `x-ratelimit-remaining: 0`: failed, "GitHub rate limit reached; retry after <reset ISO>".
  - Any other 403: `github_auth_rejected`.
  - 404: failed, "GitHub repository or item not found, or the token cannot see it."
  - Write 401/403 auth: `ProviderAuthRejectedError`, as in Notion.
- **Reconcile probes:**
  - `issue_create`: `GET /repos/{o}/{r}/issues?state=all&sort=created&direction=desc&per_page=30`, looking for the marker in the body.
  - `issue_comment`: `GET /repos/{o}/{r}/issues/{n}/comments?sort=created&direction=desc&per_page=30`.
- **Marker domain:** `"goatcitadel:github-marker:v1"`.

- [ ] **Step 1: Write failing tests** mirroring the Task 8 list, for every action:
  - `issue_list` filters PRs;
  - 401 / rate-limit 403 / 404 mapping;
  - ward deny on `issue_list`;
  - a `require_dry_run` ward on `issue_create` gives preview plus approval;
  - an `issue_comment` duplicate makes no fetch;
  - the `issue_create` reconcile probe finds the marker, so there is no second POST;
  - an invalid repo is blocked;
  - the token never appears in outputs.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `invokeGitHubAction` with the Notion signature.
- [ ] **Step 4: Run the gates:**
  - the new tests, `integration-action-service.test.ts`, `integration-public-input.test.ts` (the existing `productivity.github` fixture still passes), `integration-secret-envvar-allowlist.security.test.ts`;
  - the catalog-parity lane (`node scripts/verification/run.mjs catalog-parity`, or whatever lane id the scenario registers; read `scripts/verification/run.mjs` for it);
  - `pnpm typecheck`, `pnpm verify:architecture:metrics`, `pnpm docs:check`, repo hygiene, `git diff --check`.
- [ ] **Step 5: Commit.** `feat(integrations): GitHub issues and pull requests with governed writes`. Open PR C.

**Deviation recorded:** the program text names `fixed-outbound-hosts.ts` entries for `api.notion.com` and `api.github.com`. That file only serves agent tool names and channel keys, and operator integration actions do not read it. No `notion.*` or `github.*` agent tools are added in WS6, so adding entries would be dead config. The PR body says so.

---

## PR D — Plugin package integrity

### Task 10: Integrity verifier (npm SRI + local manifest)

**Files:**
- Create: `apps/gateway/src/services/integration-plugin-package-integrity.ts` + `.test.ts`, and the allowance entry.
- Modify: `packages/contracts/src/channels.ts` `IntegrationPluginSourceMetadata`. Add `actualIntegrity?: string; verifiedAt?: string; integritySource?: "operator" | "registry" | "manifest"; artifactPath?: string;`, where `artifactPath` is relative to the data dir.

**Interfaces (Produces):**

```ts
export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const PLUGIN_TARBALL_MAX_BYTES = 32 * 1024 * 1024;
export const LOCAL_MANIFEST_LIMITS = { maxFiles: 5_000, maxTotalBytes: 64 * 1024 * 1024 } as const;
export type PluginPackageIntegrityResult =
  | { status: "verified"; actualIntegrity: string; integritySource: "operator" | "registry" | "manifest"; verifiedAt: string; artifactPath?: string; warnings: IntegrationPluginTrustWarning[] }
  | { status: "quarantined"; actualIntegrity?: string; expectedIntegrity: string; warnings: IntegrationPluginTrustWarning[] } // critical integrity_mismatch
  | { status: "not_applicable"; actualIntegrity?: string; warnings: IntegrationPluginTrustWarning[] }   // local without expected value (hash recorded)
  | { status: "unknown"; warnings: IntegrationPluginTrustWarning[] };                                    // git/url/manual, or npm fetch blocked/failed
export function parseNpmPackageSpec(source: string): { name: string; version?: string } | undefined; // "npm:@s/n@1.2.3", "@s/n", "n@1", "n"
export function parseSriIntegrity(value: string): { algorithm: "sha512" | "sha256"; digest: string } | undefined; // single token only
export async function computeLocalPluginManifestIntegrity(root: string): Promise<string>;
// walk with lstat; skip node_modules and .git; reject symlinks/hardlinks(nlink>1)/non-regular files (throw);
// entries [posixRelPath, size, sha256hex] sorted by path; `sha256-${base64(sha256(JSON.stringify(entries)))}`; enforce LOCAL_MANIFEST_LIMITS
export async function verifyIntegrationPluginPackage(input: {
  pluginId: string;
  source: string;
  sourceType: IntegrationPluginInstallSourceType;
  expectedIntegrity?: string;
  networkAllowlist: readonly string[];
  pluginStoreRoot: string;          // <rootDir>/<dataDir>/integration-plugins
  fetchOnce?: typeof fetchAllowlistedOnce; // injectable for tests
  now?: () => Date;
}): Promise<PluginPackageIntegrityResult>;
```

**Rules:**
- **An `expectedIntegrity` that doesn't parse** (wrong algorithm for the source, multiple tokens, bad base64) throws `ValidationError("expectedIntegrity must be a single sha512-<base64> (npm) or sha256-<base64> (local manifest) value")`. The route maps it to 400.
- **npm:**
  - Metadata comes from `GET {registry}/{encodeURIComponent(name) with %40 restored to @}/{version ?? "latest"}` via `fetchOnce(url, { allowlist: networkAllowlist, maxResponseBytes: 1 MiB, init: { redirect: "error" } })`. It is read with `readBoundedResponseJson`.
  - `dist.tarball` must be `https:` on the registry host, and `dist.integrity` must parse as sha512. Otherwise the result is `unknown` with a critical warning `integrity_registry_invalid`.
  - Download with the same `fetchOnce` (`maxResponseBytes: PLUGIN_TARBALL_MAX_BYTES`, `bodyReadTimeoutMs: 60_000`) and `readBoundedResponseBytes`.
  - `actual = sha512-${base64}`. If `actual !== dist.integrity`, or `expectedIntegrity` is set and `actual !== expectedIntegrity`, the result is **quarantined** with a critical warning `integrity_mismatch` and the message "Plugin package bytes do not match the expected integrity. The package was not stored." **Nothing is written** in that case.
  - Otherwise write `<root>/<pluginId>/<sha512 hex first 16>.tgz`. Copy `assertOrdinaryPath`, stage with `mkdtemp(".install-")`, write with `writeFile` (`flag: "wx", mode: 0o600`), then `rename`, as `reviewed-mcp-package.ts` does.
  - The result is `verified` with `integritySource: expectedIntegrity ? "operator" : "registry"`. With no operator value, add a warning `integrity_not_pinned`: "Verified against the registry's published integrity; pin an expectedIntegrity to detect a re-published package."
- **Allowlist or network failure** (the guard throws, or the fetch fails): `unknown` with a critical warning `integrity_unverifiable`, "Plugin package integrity could not be verified (registry fetch blocked or failed). Add the registry host to the network allowlist and reinstall." There is no stored artifact. The guard enforces the operator allowlist exactly, with **no `"*"`**.
- **local:**
  - Run `computeLocalPluginManifestIntegrity(path.resolve(source))`.
  - With an expected value: equal → `verified` (`integritySource: "operator"`), else quarantined.
  - Without one: `not_applicable` with the hash recorded.
  - A walk error (symlink, limits) gives quarantined with a critical warning `integrity_manifest_invalid`.
- **git/url/manual/unknown:** `unknown` with no fetch. The trust warning `integrity_not_verified` reads "Integrity is not verified for git, URL or manual plugin sources." The existing `unverified_source` warning stays.

- [ ] **Step 1: Write failing tests,** with mkdtemp roots and a fake `fetchOnce`. The npm tarball fixture is `Buffer.from("fixture-tarball")`, with its SRI computed in the test.
  - "npm: verifies against registry dist.integrity and stores the tarball" (the file exists; mode on POSIX only);
  - "npm: an operator-pinned expectedIntegrity match is integritySource operator";
  - "npm: tarball bytes that mismatch the registry integrity are quarantined and nothing is stored";
  - "npm: bytes matching the registry but not the operator value are quarantined";
  - "npm: registry host absent from the allowlist → no fetch, status unknown, integrity_unverifiable" (use the real `fetchAllowlistedOnce` with allowlist `[]` and a `fetch` spy that must not be called);
  - "npm: a tarball URL off the registry host is refused";
  - "parseNpmPackageSpec handles scoped and versioned specs";
  - "local: manifest hash is deterministic across file creation order and changes when one byte changes";
  - "local: expected match → verified, mismatch → quarantined, absent → not_applicable with the hash";
  - "local: a symlink inside the tree → quarantined integrity_manifest_invalid";
  - "git/url stay unknown with integrity_not_verified";
  - "a malformed expectedIntegrity throws ValidationError".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild contracts.
- [ ] **Step 4: Run them.** Expected: PASS. Then run `pnpm check:bounded-response-reads`.
- [ ] **Step 5: Commit.** `feat(plugins): verify npm and local plugin package integrity`

### Task 11: Wire into install, block re-enabling, docs

**Files:**
- Modify: `apps/gateway/src/services/integration-plugin-author-contract.ts`.
  - `BuildInstalledIntegrationPluginRecordInput` gains `integrity?: PluginPackageIntegrityResult`.
  - When present, it sets `sourceMetadata.integrityStatus` and the record `integrityStatus` from the result. Quarantined means `enabled: false`.
  - It merges `result.warnings` into `trustWarnings` and copies `actualIntegrity`, `verifiedAt`, `integritySource` and `artifactPath`.
  - Without it, keep today's behavior, but git/url with an expected value now reports `"unknown"` rather than `"missing"`.
  - Delete the "runtime package verification is not wired yet" copy.
  - Fix `inferInstallSourceType` so `npm:@s/n`, `@s/n` and `n@1.2.3` infer `npm`.
- Modify: `integration-channel-service.ts`.
  - `installIntegrationPlugin` calls `deps.verifyIntegrationPluginPackage(...)` before building the record. Pass `sourceType` and `expectedIntegrity` into `resolveIntegrationPluginInstallMetadata` too.
  - Publish realtime on update as well, as `integration_plugin_updated`.
  - `setIntegrationPluginEnabled(pluginId, true)` throws `ValidationError("Plugin is quarantined after an integrity failure. Reinstall it; the new install's integrity result replaces the quarantine.")` when `integrityStatus === "quarantined"` or `"mismatch"`.
- Modify: `IntegrationChannelPort`. Add `verifyIntegrationPluginPackage(input: Omit<Parameters<typeof verifyIntegrationPluginPackage>[0], "networkAllowlist" | "pluginStoreRoot">): Promise<PluginPackageIntegrityResult>`. Wire it in `createIntegrationChannelPortForGateway` (`gateway-route-composition-integrations.ts`), using `gateway.config.toolPolicy.sandbox.networkAllowlist` and `path.resolve(gateway.config.rootDir, gateway.config.assistant.dataDir, "integration-plugins")`. Fix the `integration-channel-service.test.ts` `createDeps()` literal.
- Modify: `agentic-capability-availability.ts` `mapPluginIntegrityStatus`.
  - `runtimeAvailable` must also be false for `quarantined`.
  - Remap `missing` to `unverified`: it no longer means corrupt bytes, only "a value was given but this source can't be verified".
  - Update its tests.
- Modify: the route `integrations-control-routes.ts`. A `ValidationError` from install or enable maps to 400 with its message; the current catch already returns 400, so confirm it.
- Docs: `docs/PLUGIN_SDK_CONTRACT.md` "Safe Claims Now". Add: "npm plugin packages are downloaded through the network allowlist and verified against SRI sha512 (operator-pinned or registry-published) before they are recorded as verified; local plugin folders get a deterministic sha256 file-manifest hash; git and URL sources are recorded as unverified. A mismatch quarantines and disables the plugin."

- [ ] **Step 1: Write failing tests:**
  - `integration-channel-service.test.ts`: "install records verified integrity from the verifier"; "install quarantines and disables on mismatch"; "enabling a quarantined plugin is refused"; "install passes sourceType and expectedIntegrity to the verifier".
  - `integration-plugin-author-contract.test.ts`: update L153-181, where url with an expected value is now `unknown` and the new warning copy applies; add npm scoped and versioned inference cases.
  - The `agentic-capability-availability.test.ts` mapping.
  - A route test in `integrations.control.test.ts`: enabling a quarantined plugin returns 400.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates:**
  - the focused tests above, plus `integration-control-loop21.test.ts` and `wrappers.test.ts` in mission-control-shared;
  - `pnpm typecheck` (watch the UI's use of `IntegrationPluginSourceMetadata`), `pnpm verify:architecture:metrics`, `pnpm docs:check`, repo hygiene, `git diff --check`;
  - `git grep -n "not wired yet" -- apps/gateway/src/services/integration-plugin-author-contract.ts` returns nothing.
- [ ] **Step 5: Commit.** `feat(plugins): enforce package integrity at install and block re-enabling quarantined plugins`. Open PR D (`Closes #348` if the match, mismatch and missing tests and the clear failure state all landed).

---

## Self-review notes

- **Spec coverage:**
  - 6.1 → Tasks 1–3.
  - 6.2 → Tasks 4 and 6.
  - 6.3 → Tasks 5 and 6.
  - 6.4 → Tasks 7–8.
  - 6.5 → Tasks 7 and 9.
  - 6.7 → Tasks 10–11.
  - 6.6 is excluded (blocked, #355).
  - The four per-adapter tests (signature rejection, allowlist-denied, duplicate gives one turn, reconnect does not replay) are in Tasks 1, 3, 4, 5 and 6. Matrix has no signature, so its forged-input analogue is the auth/allowlist host test plus the self-echo filter.
- **Deviations from the program text, stated in the PR bodies:**
  - maturity `"beta"` (not "live");
  - no `fixed-outbound-hosts.ts` entries for Notion or GitHub;
  - Notion and GitHub writes are not added to the replay-job allowlist;
  - Notion `page_create` has no reconcile probe.
- **Type names used across tasks:**
  - `ChannelStreamCursorStore` (Task 1);
  - `ProviderAuthRejectedError` (Task 7, used in 8 and 9);
  - `PluginPackageIntegrityResult` (Task 10, used in 11).
