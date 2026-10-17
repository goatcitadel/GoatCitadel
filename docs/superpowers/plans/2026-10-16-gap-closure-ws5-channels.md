# WS5 Channel Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the WS5 channel gaps: real inbound for ntfy, Mattermost, Google Chat and Signal; react/unsend/typing where the platform allows it (and an honest "platform does not support this" where it doesn't); inbound voice for Slack, Discord and Nextcloud Talk.

**Architecture:** Webhook channels (Google Chat) reuse `routes/webhook-handler-factory.ts` plus a `<ch>-webhook.ts` verifier/normalizer, and they dispatch through `channel-inbound-dispatch.ts`. The three persistent-connection channels (ntfy JSON stream, Mattermost WebSocket, signal-cli event stream) share one new `ChannelStreamRuntimeService`. Each one plugs in a small adapter, and every event goes through the same sender trust gate and durable acceptance (`dispatchInboundWebhookMessage`). Durable acceptance dedupes on a deterministic idempotency key built from the provider event id. That is how a reconnect, restart or replayed webhook yields exactly one chat turn.

**Tech Stack:** TypeScript, Fastify gateway, vitest, Node 24 global `fetch`/`WebSocket`/`node:crypto`. No new dependencies.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md`, section "WS5 — Channel parity", plus its Global Constraints and Review Focus.

**Delivery:** two PRs against `main`.
- **PR1 "WS5a inbound adapters"** covers Tasks 1–6.
- **PR2 "WS5b actions and voice"** covers Tasks 7–11. It is stacked on PR1's branch, because both edit `channel-core.ts`, `comms-executor.ts` and the parity matrix. Until PR1 merges, PR2's diff includes PR1.

## Global Constraints

- Work only in this worktree. Never edit the main checkout `C:\personal-ai`. Never `git stash`.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`. Policy-engine: `pnpm --filter @goatcitadel/policy-engine exec vitest run <file> --maxWorkers=2`. gateway-core: `pnpm --filter @goatcitadel/gateway-core exec vitest run src/channel-core.test.ts --maxWorkers=2`.
- Run one heavy job at a time, at low priority. A file that fails under load is re-run alone before it is treated as a real failure.
- Package tests resolve `@goatcitadel/contracts` and `@goatcitadel/gateway-core` from `dist`. Rebuild them after changing them: `pnpm --filter @goatcitadel/contracts build`, `pnpm --filter @goatcitadel/gateway-core build`.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- Never run `architecture:baseline:update`. Each new gateway service file gets an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`; copy an existing entry's shape.
- No new Postgres tables are planned. Durable dedupe reuses the existing inbound-channel-event store. If a task finds it needs a table, stop and report.
- No personal paths in tracked files. Run `prettier --write` only on the files you changed.
- Use `git grep`, not the Grep tool, for any exhaustive search.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit message type prefixes: feat, fix, refactor, docs, test, chore.
- Docs, UI copy and code must agree. Every "inbound routing is not yet wired / not available / outbound-only" sentence for a channel this workstream wires is rewritten in the same task. That includes `channel-core.ts` operatorSummary and supportNotes, setup definitions, `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`, and README / `docs/1_0_CONTRACT.md` / `docs/CANONICAL_RUNTIME_STATE_MODEL.md` wherever they name the gap.
- Secrets are resolved only at the tool-host boundary (`secretFrom` / `resolveConnectionSecret`). Secrets never cross the durable acceptance boundary. `dispatchInboundWebhookMessage` already strips `inboundAccessConfig`.
- Every outbound URL that a connection config constructs still goes through the connection allowlist (`fetchAllowlisted` or `isConnectionUrlAllowlisted`).

## Review Focus

1. **The same provider event delivered twice.** A stream reconnect re-sends it, a gateway restart replays it, or a webhook is retried. The expected result is exactly one chat turn. Pinned by Task 6, which runs a parametrized test against the real `InboundChannelEventService` for every new adapter, plus a key-determinism test inside each adapter task.
2. **The bot hears its own outbound message.** An ntfy publish to the subscribed topic, a Mattermost post by the bot user, a Signal sync message from our own account, or a Google Chat message from a BOT sender. None of these may start a turn. Each adapter task has a "self-echo ignored" test.
3. **Stream drops and flaps.** The server closes the stream, the network errors, or auth fails (401/403). The runtime reconnects with capped backoff, stops retrying on auth failures and records `lastError`, never runs two runners for one connection, and fully stops on `close()` or when the connection is disabled. Pinned in Task 1.
4. **A forged or stale Google Chat JWT.** Wrong `aud`, wrong `iss`, expired, unknown `kid`, or `alg: none`. Each gets a 401 and the request is never dispatched. Pinned in Task 5.
5. **A non-allowlisted sender on a new channel.** The message is dropped before acceptance, with no session and no turn. This comes from the shared gate. Pinned per adapter (Tasks 2–5).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/channels.ts` | Add `"stream"` to `ChannelInboundMode`; add `platformUnsupportedActions` to `ChannelCapabilities` (Task 7) |
| `packages/contracts/src/comms.ts` | `ChannelTypingInput.messageId?` (Task 8) |
| `packages/gateway-core/src/channel-core.ts` | Capability/posture truth per channel |
| `apps/gateway/src/services/channel-stream-runtime-service.ts` (new) | Generic persistent-stream runner: per-connection lifecycle, backoff, status, dispatch |
| `apps/gateway/src/services/channel-stream-adapters/ntfy-stream-adapter.ts` (new) | ntfy `/<topic>/json` reader + normalizer |
| `apps/gateway/src/services/channel-stream-adapters/mattermost-stream-adapter.ts` (new) | Mattermost WebSocket `posted` reader + normalizer |
| `apps/gateway/src/services/channel-stream-adapters/signal-stream-adapter.ts` (new) | signal-cli `/api/v1/events` SSE reader + normalizer |
| `apps/gateway/src/services/channel-stream-adapters/stream-line-reader.ts` (new) | Shared bounded NDJSON / SSE line splitter |
| `apps/gateway/src/services/google-chat-webhook.ts` (new) | Google Chat JWT verifier + event normalizer |
| `apps/gateway/src/routes/integration-webhooks-google-chat-routes.ts` (new) | Webhook route via `createWebhookHandler` |
| `packages/policy-engine/src/tool-executor/google-chat-service-account.ts` (new) | Service-account OAuth token minting (RS256 JWT bearer grant) with in-memory cache |
| `packages/policy-engine/src/tool-executor/comms-executor.ts` | Google Chat API send/unsend, Signal react/unsend, ntfy outbound marker tag |
| `apps/gateway/src/services/channel-typing-adapters.ts` (new) | Mattermost / Signal / WhatsApp typing implementations |
| `apps/gateway/src/services/signal-inbound-runtime-service.ts` | **Deleted** (Task 4) |
| `apps/gateway/src/services/channel-voice-inbound-service.ts` | New voice request variants: slack, discord, nextcloud-talk |
| `scripts/verification/lib/channel-parity-matrix.mjs` (+ `.test.mjs`), `scripts/verification/channel-parity-proof.mjs` | Matrix rows and proof file list |

---

## PR1 — Inbound adapters

### Task 1: `ChannelStreamRuntimeService` + `"stream"` inbound mode

**Files:**
- Modify: `packages/contracts/src/channels.ts:148`. `ChannelInboundMode` becomes `"none" | "webhook" | "gateway" | "poll" | "local_bridge" | "stream"`.
- Create: `apps/gateway/src/services/channel-stream-runtime-service.ts`
- Create: `apps/gateway/src/services/channel-stream-adapters/stream-line-reader.ts`
- Test: `apps/gateway/src/services/channel-stream-runtime-service.test.ts`, `apps/gateway/src/services/channel-stream-adapters/stream-line-reader.test.ts`
- Modify: `apps/gateway/src/services/channel-inbound-dispatch.ts`. Narrow the first parameter of `dispatchInboundWebhookMessage` to `Pick<IntegrationWebhookRouteLike, "acceptInboundChannelEvent" | "recordDevDiagnostic">`. Do the same for `evaluateInboundWebhookAccess`. This is a type-only widening, so existing callers still compile.
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json` (new service entry)

**Interfaces (Produces, used by Tasks 2–4):**

```ts
// channel-stream-runtime-service.ts
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { IngestChannelMessageInput } from "./channel-inbound-dispatch.js";

export interface ChannelStreamEvent {
  /** Deterministic: `${channelKey}:${connectionId}:${providerEventId}` — never arrival time or a body hash with volatile fields. */
  idempotencyKey: string;
  eventType: string;
  bindingTarget?: string;
  message: IngestChannelMessageInput;
}

export interface ChannelStreamRunContext {
  connection: IntegrationConnection;
  signal: AbortSignal;
  /** Last provider cursor this process saw for the connection (in memory; undefined after restart). */
  cursor: string | undefined;
  markReady(): void;
  /** Resolves only after durable acceptance (or a gate drop); the cursor advances only after this resolves. */
  emit(event: ChannelStreamEvent, cursor?: string): Promise<void>;
  diagnostic(event: string, message: string, context?: Record<string, unknown>): void;
}

export class ChannelStreamAuthError extends Error {} // 401/403: stop retrying until the next sync() with a new revision

export interface ChannelStreamAdapter {
  channelKey: string;
  /** True only when the connection opted into inbound and has what the stream needs. */
  isInboundEnabled(connection: IntegrationConnection): boolean;
  /** Runs one stream session; resolves when the server ends it, rejects on error. Must honor ctx.signal. */
  run(ctx: ChannelStreamRunContext): Promise<void>;
}

export interface ChannelStreamRuntimeStatus {
  connectionId: string;
  channelKey: string;
  ready: boolean;
  lastReadyAt?: string;
  lastInboundAt?: string;
  lastReconnectAt?: string;
  lastError?: string;
  stoppedReason?: "auth_failed" | "disabled" | "closed";
}

export interface ChannelStreamRuntimeDeps {
  listConnections(): Promise<IntegrationConnection[]>;
  adapters: readonly ChannelStreamAdapter[];
  dispatch(connection: IntegrationConnection, event: ChannelStreamEvent): Promise<unknown>;
  recordDevDiagnostic(input: { level: "info" | "warn" | "error"; category: string; event: string; message: string; context?: Record<string, unknown> }): void;
  backoff?: { initialMs: number; maxMs: number }; // default 1_000 / 60_000
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export class ChannelStreamRuntimeService {
  constructor(deps: ChannelStreamRuntimeDeps);
  sync(): Promise<void>;           // start runners for enabled+connected+opted-in connections; stop removed/disabled ones; restart when connection.updatedAt/revision changed
  getStatus(connectionId: string): ChannelStreamRuntimeStatus | undefined;
  get activeRunnerCount(): number;
  close(): Promise<void>;          // abort all runners, await their settlement; sync() after close is a no-op
}
```

```ts
// stream-line-reader.ts
/** Splits a byte stream into UTF-8 lines; throws if one line exceeds maxLineBytes (default 256 KiB). */
export async function* readStreamLines(body: ReadableStream<Uint8Array>, options?: { maxLineBytes?: number; signal?: AbortSignal }): AsyncGenerator<string>;
/** Groups SSE lines into events: { event?: string; data: string; id?: string }. */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>, options?: { maxLineBytes?: number; signal?: AbortSignal }): AsyncGenerator<{ event?: string; data: string; id?: string }>;
```

- [ ] **Step 1: Write failing tests** in `channel-stream-runtime-service.test.ts`. Use a fake adapter whose `run` is driven by the test (deferreds) and a `sleep` stub that records delays:
  - `sync()` starts exactly one runner per enabled opted-in connection. A second `sync()` with an unchanged connection does not start another runner (`activeRunnerCount === 1`).
  - A disabled connection, or one with `status !== "connected"`, gets no runner. Disabling a running connection and calling `sync()` aborts it (`ctx.signal.aborted === true`) and sets `stoppedReason: "disabled"`.
  - When a run resolves or rejects, the runtime reconnects with doubling backoff capped at `maxMs` (`1000, 2000, 4000, …, 60000`). The backoff resets after `markReady()` followed by a successful `emit`. `lastReconnectAt` and `lastError` are set.
  - A `ChannelStreamAuthError` stops the runner with `stoppedReason: "auth_failed"` and no further `run` calls. A `sync()` after the connection's `updatedAt` changes restarts it.
  - `emit` calls `deps.dispatch(connection, event)`. `ctx.cursor` on the next run equals the cursor passed to the last emit that resolved. When `dispatch` rejects, the cursor does not advance, the error propagates to the adapter (so the session restarts), and `lastError` is recorded.
  - `close()` aborts every runner and resolves only after each `run` settles. A `sync()` after close starts nothing.
- [ ] **Step 2: Write failing tests** in `stream-line-reader.test.ts`. Cover: lines split across chunks; a multi-byte UTF-8 character split across chunks; `\r\n`; an over-long line throws; for SSE, `data:` lines are joined with `\n`, the blank line terminates an event, `:` comment lines are ignored, and `event:` and `id:` are captured.
- [ ] **Step 3: Run both test files.** Expected: FAIL (module not found).
- [ ] **Step 4: Implement.** Keep one `AbortController` per runner. The runner loop:

```ts
while (!controller.signal.aborted) {
  try {
    await adapter.run(ctx);
    failures += 1;                                   // server ended the stream; treat as a reconnect
  } catch (error) {
    if (controller.signal.aborted) break;
    if (error instanceof ChannelStreamAuthError) { stop("auth_failed", error); break; }
    failures += 1; record lastError
  }
  const delay = Math.min(initialMs * 2 ** Math.max(0, failures - 1), maxMs);
  await sleep(delay, controller.signal).catch(() => undefined);
  status.lastReconnectAt = now().toISOString();
}
```

Track runners in a `Map<connectionId, {revisionKey, controller, task}>`. The revision key is `${connection.updatedAt}:${connection.revision ?? ""}`. `markReady()` sets `ready=true` and `lastReadyAt`; a successful `emit` resets `failures=0` and sets `lastInboundAt`. Log diagnostics through `deps.recordDevDiagnostic` with category `"channels"` and events `"<channelKey>.stream.connected" | ".reconnecting" | ".auth_failed" | ".stopped"`.
- [ ] **Step 5: Run the tests.** Expected: PASS. Rebuild contracts and run `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] **Step 6: Commit.** `feat(channels): add persistent channel stream runtime and stream inbound mode`

### Task 2: ntfy inbound (5.1)

**Files:**
- Create: `apps/gateway/src/services/channel-stream-adapters/ntfy-stream-adapter.ts` + `.test.ts`
- Modify: `packages/policy-engine/src/tool-executor/comms-executor.ts` (`ntfySend`). Add the header `X-Tags: goatcitadel-outbound`. If the caller already sends tags, merge with a comma rather than replacing them.
- Modify: `packages/gateway-core/src/channel-core.ts` (ntfy rule) and `channel-core.test.ts`
- Modify: `apps/gateway/src/services/channel-setup-definitions/ntfy.ts` (+ its test). Add the optional fields `inboundStreamEnabled` (boolean) and `subscribeTopic` (string; defaults to `topic`).
- Modify: `apps/gateway/src/services/channel-setup-inbound-access.ts` (`GUIDED_INBOUND_CHANNELS` += `"ntfy"`), `apps/gateway/src/services/integration-diagnostics-service.ts` (`GENERIC_ALLOWLIST_INBOUND_CHANNELS` += `"ntfy"`)
- Wire: `gateway-service.ts`. Construct `ChannelStreamRuntimeService` with the adapters registered so far. `dispatch` calls `dispatchInboundWebhookMessage({ acceptInboundChannelEvent: (i) => this.acceptInboundChannelEvent(i), recordDevDiagnostic: (i) => this.recordDevDiagnostic(i) }, { channel: connection.key, connectionId, idempotencyKey, eventType, bindingTarget, inboundAccessConfig: connection.config, acceptedConnectionRevision: connection.revision, message })`. Call `sync()` next to `discordRuntimeService.sync()` at startup and in the connection-commit path. Close it in both `close()` and `stopExternalAdmission()`. Expose `syncChannelStreamRuntime()` through the same port chain as `syncSignalInboundRuntime` (`integration-channel-service.ts:68-69`, `integration-connection-commit-service.ts:5-19`, `gateway-route-composition-port.ts:259-260,487-488`, `gateway-route-composition-integrations.ts:574-576`).
- Modify: `integration-channel-service.ts` runtime status. For stream channels, use `getStatus()` (`readinessSource: "live_runtime"`, `authoritative: true`).

**Behavior:**
- **Inbound is enabled only when** `inboundStreamEnabled === true`, `baseUrl` and the subscribe topic are set, **and** a token is configured (`tokenEnv`/`token`). ntfy carries no sender identity, so an unauthenticated topic would let anyone start turns. With no token, `channel-core` adds a setup diagnostic: "ntfy inbound requires a token-protected topic (tokenEnv)".
- **The stream request** is `GET ${baseUrl}/${encodeURIComponent(topic)}/json?since=${cursor}` when a cursor exists. With no cursor, the `since` parameter is omitted, which means no history on a fresh start. Send `Authorization: Bearer <token>`. The connection allowlist must allow the URL; if it doesn't, throw `ChannelStreamAuthError("ntfy host is not in the outbound allowlist")`. A 401/403 response becomes `ChannelStreamAuthError`; any other non-2xx is a plain Error.
- **Each NDJSON line** is a JSON object. Mark ready on `event === "open"`, and skip `keepalive`. Only `event === "message"` is dispatched. Ignore a message whose `tags` include `goatcitadel-outbound` (self-echo). Ignore empty messages.
- **The normalized event** is `idempotencyKey = ntfy:${connectionId}:${msg.id}`, `eventType: "ntfy-message"`, `bindingTarget: topic`. `message = { eventId: msg.id, account: connectionId, room: topic, actorId: "ntfy-topic:" + topic, actorType: "user", content: (msg.title ? msg.title + "\n" : "") + msg.message, metadata: { topic, title, tags, priority, time } }`. The cursor is `msg.id`.
- **channel-core:** `resolveInboundModes` returns `["stream"]` when inbound is enabled. The posture becomes `lifecycle: "persistent"`, `inboundTransport: "stream"`, `inboundReadiness: "ready"`. Rewrite the operatorSummary and supportNotes to say: inbound subscribes to the topic's JSON stream; the sender is the topic itself, so access control is the token-protected topic; outbound publishes are tagged and ignored on the way back in.

- [ ] **Step 1: Write failing adapter tests.** Feed a fake `fetch` that returns a `ReadableStream` of NDJSON lines:
  - "open" calls `markReady`;
  - a message emits the exact event above;
  - a `goatcitadel-outbound` tag is ignored;
  - a keepalive is ignored;
  - 401 throws `ChannelStreamAuthError`;
  - with `ctx.cursor = "abc"` the URL carries `since=abc`, and with no cursor there is no `since`;
  - **replay determinism:** the same message line delivered in two sessions yields identical `idempotencyKey`s;
  - the allowlist-denied host throws `ChannelStreamAuthError`.
- [ ] **Step 2: Write failing tests** for the remaining pieces:
  - a `channel-core.test.ts` case: ntfy with `inboundStreamEnabled + tokenEnv` gives `inboundModes ["stream"]` and `lifecycle "persistent"`; without a token it gives `["none"]` plus the setup diagnostic;
  - a policy-engine test that `ntfySend` sends `X-Tags` containing `goatcitadel-outbound`;
  - a gate test: run the runtime with the real `dispatchInboundWebhookMessage` and an `inboundAccessMode: "allowlist"` config whose `allowedSenders` lacks `ntfy-topic:<topic>`, then assert `acceptInboundChannelEvent` was never called.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement** the adapter, channel-core rule, setup fields, ntfy outbound tag and gateway wiring.
- [ ] **Step 5: Run the tests,** plus `channel-setup-definitions.test.ts`, `channel-bot-live-probes.ntfy.test.ts` and the gateway typecheck. Expected: PASS.
- [ ] **Step 6: Update the matrix.** In `channel-parity-matrix.mjs`, add row `ntfy.publish-and-stream`: config `{ baseUrl, topic, tokenEnv, inboundStreamEnabled: true }`, `inboundMode: "stream"`, `lifecycle: "persistent"`, and proof `inboundAdapter: "apps/gateway/src/services/channel-stream-adapters/ntfy-stream-adapter.test.ts"`, `reconnect: "apps/gateway/src/services/channel-stream-runtime-service.test.ts"`. Keep `ntfy.publish`. Add both test files to `channel-parity-proof.mjs`. Run `node --test scripts/verification/lib/channel-parity-matrix.test.mjs` and the gateway `channel-parity-matrix.test.ts`.
- [ ] **Step 7: Commit.** `feat(channels): ntfy inbound via persistent JSON stream subscription`

### Task 3: Mattermost inbound (5.2)

**Files:**
- Create: `apps/gateway/src/services/channel-stream-adapters/mattermost-stream-adapter.ts` + `.test.ts`
- Modify: `channel-core.ts` (mattermost rule; remove "inbound routing is not yet wired"), `channel-core.test.ts`, `channel-setup-definitions/mattermost.ts` (`inboundStreamEnabled`), `GUIDED_INBOUND_CHANNELS`, `GENERIC_ALLOWLIST_INBOUND_CHANNELS`, the `gateway-service.ts` adapter registration, and the parity matrix and proof.

**Behavior:**
- **Inbound is enabled** when `inboundStreamEnabled === true`, `serverUrl` is set and a bot token is configured.
- **Before opening the socket,** call `GET ${serverUrl}/api/v4/users/me` with `Authorization: Bearer` to learn the bot's own `id`. Use the allowlisted fetch; a 401/403 becomes `ChannelStreamAuthError`.
- **Open the socket** with `new WebSocket(wsUrl)`, where `wsUrl` is `serverUrl` with `http`→`ws` and `https`→`wss`, plus `/api/v4/websocket`. Inject `createWebSocket` through the adapter deps so tests can pass a fake. On `open`, send `{ seq: 1, action: "authentication_challenge", data: { token } }`. Mark ready on the `hello` event, or when the auth response is `status: "OK"`. An auth response with `status: "FAIL"` becomes `ChannelStreamAuthError`.
- **On a `posted` event:** `data.post` is a JSON string, so parse it. Ignore posts where `post.user_id === botUserId` (self-echo), and ignore `post.type` values that are non-empty system types (start with `system_`). Ignore empty messages.
- **The emitted event** is `idempotencyKey = mattermost:${connectionId}:${post.id}`, `eventType: "mattermost-posted"`, `bindingTarget: post.channel_id`. `message = { eventId: post.id, account: connectionId, room: post.channel_id, threadId: post.root_id || undefined, actorId: post.user_id, actorType: "user", displayName: data.sender_name?.replace(/^@/, ""), content: post.message, metadata: { channelType: data.channel_type, channelName: data.channel_name, teamId: data.team_id, rootId: post.root_id } }`. For a DM, `data.channel_type === "D"`; set `peer: post.user_id`. The cursor is `String(eventSeq)`; it is diagnostic only.
- **Lifecycle:** `run` resolves when the socket closes and rejects on `error`. Close the socket when `ctx.signal` aborts. There is no history replay on reconnect; the posted event's id dedupes any overlap.
- **channel-core:** `inboundModes ["stream"]` when enabled; posture persistent/stream/ready; rewrite the summary and notes.

- [ ] **Step 1: Write failing adapter tests** with a fake WebSocket class (an EventTarget that records `send` and lets the test push `message`, `close` and `error`):
  - the challenge is sent with the token;
  - a posted event emits the exact event above, both in a channel and in a DM (`peer` set);
  - a bot self-post is ignored;
  - a `system_join_channel` post is ignored;
  - an auth FAIL throws `ChannelStreamAuthError`;
  - a `users/me` 401 throws `ChannelStreamAuthError`;
  - an abort closes the socket and resolves;
  - **replay determinism:** the same post id delivered in two sessions yields an identical key;
  - the allowlist gate drops a non-allowlisted `user_id` before acceptance.
- [ ] **Step 2: Write a failing `channel-core.test.ts` case.**
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the tests,** plus `channel-setup-definitions.test.ts` and the gateway typecheck. Expected: PASS.
- [ ] **Step 6: Update the matrix.** Change row `mattermost.bot` to `mattermost.bot-websocket` with `inboundStreamEnabled: true`, `inboundMode: "stream"`, persistent lifecycle and an `inboundAdapter` proof. Add an outbound-only row `mattermost.bot-outbound` with the old config. Update the proof list and run both matrix tests.
- [ ] **Step 7: Commit.** `feat(channels): Mattermost inbound via WebSocket posted events`

### Task 4: Signal inbound — replace the facade (5.4 inbound half)

**Files:**
- Create: `apps/gateway/src/services/channel-stream-adapters/signal-stream-adapter.ts` + `.test.ts`
- Delete: `apps/gateway/src/services/signal-inbound-runtime-service.ts` and its test. Remove its allowance entry from `architecture-new-service-allowances.json`; do not run the baseline update.
- Delete the `signalInboundV1Enabled` flag everywhere `git grep signalInboundV1Enabled` finds it: `apps/gateway/src/config.ts`, `routes/dashboard.ts` (patch schema; old clients sending the key must still parse, so keep it as an ignored `z.boolean().optional()` with a comment, **or** strip it, whichever the schema test supports), `gateway/feature-flags.ts`, `gateway/runtime-settings.ts`, `gateway-service.ts`, `packages/contracts/src/change-plan.ts`, `config-schemas.ts`, `mission-control-shared/src/api/types.ts`, and the tests that reference it. Also remove the `syncSignalInboundRuntime` port chain; Task 2's `syncChannelStreamRuntime` replaces it.
- Modify: `integration-channel-service.ts:290-340`. Remove the legacy-blocked branch and the `connection.key === "signal" ? undefined` special case for `lastInboundAt`.
- Modify: `channel-setup-definitions/signal.ts` (+ test). Add `receiveEvents` (boolean). Legacy `inboundEnabled` and `pollIntervalSeconds` are still stripped on hydrate, but the warning text now says the setting was replaced by `receiveEvents`. Update `channel-parity-matrix.test.ts:205+` to match.
- Modify: `channel-core.ts` signal rule, `channel-core.test.ts`, `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md:39`, and `GUIDED_INBOUND_CHANNELS` / `GENERIC_ALLOWLIST_INBOUND_CHANNELS` (+= `"signal"`).

**Behavior:**
- **Inbound is enabled** when `receiveEvents === true` and `baseUrl`/`bridgeUrl` is set. The bridge is the signal-cli HTTP daemon: `signal-cli daemon --http`.
- **The stream** is `GET ${baseUrl}/api/v1/events` (append `?account=<encoded accountId>` when `accountId`/`account` is configured), read through `readServerSentEvents`, with the URL allowlist-checked first. Mark ready when the response arrives with 2xx. A 401/403 becomes `ChannelStreamAuthError`.
- **Each SSE `data`** is a JSON-RPC notification `{ jsonrpc, method: "receive", params: { envelope, account } }`. Dispatch only when `envelope.dataMessage?.message` is a non-empty string. Ignore `syncMessage` (our own sent messages: self-echo), `receiptMessage`, `typingMessage`, and envelopes whose `sourceNumber`/`sourceUuid` equals the configured account.
- **Identity:** `source = envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source` and `timestamp = envelope.dataMessage.timestamp ?? envelope.timestamp`.
- **The emitted event** is `idempotencyKey = signal:${connectionId}:${source}:${timestamp}` (the source+timestamp dedupe the spec requires), `eventType: "signal-receive"`. The `bindingTarget` is `group:${groupId}` for group messages (`dataMessage.groupInfo.groupId`), else the sender's number or uuid. `message = { eventId: `${source}:${timestamp}`, account: connectionId, actorId: source, actorType: "user", displayName: envelope.sourceName, content: dataMessage.message, room: groupId ? `group:${groupId}` : undefined, peer: groupId ? undefined : source, metadata: { sourceNumber, sourceUuid, timestamp, groupId } }`. Keep `timestamp` in metadata; Task 9's react and unsend need it.
- **Honest residual gap:** signal-cli acknowledges messages to the Signal server itself and does not replay events to a subscriber that wasn't connected. So messages that arrive while the gateway is down are lost upstream. The supportNotes and the setup guide say exactly this. `inboundReadiness` is `"ready"` while the stream is connected.
- **channel-core:** `inboundModes ["stream"]` when `receiveEvents` is set; posture persistent/stream; remove "outbound-only" and "destructive receive" copy; drop the `inboundEnabled` deprecation note, which the setup-definition hydration warning now covers.

- [ ] **Step 1: Write failing adapter tests** with a fake SSE body:
  - a data message emits the exact event above, for both a direct message and a group message;
  - a syncMessage is ignored;
  - a receipt or typing message is ignored;
  - a message from our own account is ignored;
  - the `account` query parameter is present;
  - 401 throws `ChannelStreamAuthError`;
  - **replay determinism:** the same envelope in two sessions yields an identical key;
  - the allowlist gate drops a non-allowlisted sender.
- [ ] **Step 2: Update the existing tests that pinned the facade.** `channel-parity-matrix.test.ts` Signal case, `integration-channel-service.test.ts:293-330`, `gateway-service.feature-flags.roundtrip.test.ts`, and `dashboard.feature-flags-patch-schema.test.ts`. They should now assert that the flag is gone and that `receiveEvents` drives inbound.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement:** delete the facade and the flag, add the adapter, update channel-core, setup, docs and wiring.
- [ ] **Step 5: Run the tests.** Then `git grep -n "signalInboundV1Enabled\|SignalInboundRuntimeService\|signal-inbound-runtime"` must return nothing outside `docs/superpowers/` and historical status docs. Run the gateway typecheck.
- [ ] **Step 6: Update the matrix.** Change row `signal.bridge-outbound` to config `{ baseUrl, accountId, defaultRecipient }` with `inboundMode: "none"` and replace `inboundQuarantine` with nothing. Add row `signal.daemon-events` with `receiveEvents: true`, `inboundMode: "stream"`, persistent lifecycle and an `inboundAdapter` proof. Fix `channel-parity-matrix.test.mjs:41`. Remove the facade test from `channel-parity-proof.mjs` and add the adapter test.
- [ ] **Step 7: Commit.** `feat(channels): Signal inbound from signal-cli daemon events; remove signalInboundV1Enabled`

### Task 5: Google Chat inbound + service-account send/unsend (5.3)

**Files:**
- Create: `apps/gateway/src/services/google-chat-webhook.ts` + `.test.ts`
- Create: `apps/gateway/src/routes/integration-webhooks-google-chat-routes.ts`
- Modify: `routes/integration-webhooks.ts` (register the routes). Modify `routes/webhook-handler-factory.ts`: add the `googleChatRawBody` raw body key and `"google-chat"` to the `source` and log-channel unions. Modify `routes/route-access.ts` with the prefix `/api/v1/integrations/connections/:connectionId/google-chat/webhook` and `accessClass: "webhook"`. Modify `services/webhook-rate-limit.ts` if it enumerates sources, and `connector-registry.ts` where it lists webhook channels (follow the `nextcloud-talk` cases).
- Create: `packages/policy-engine/src/tool-executor/google-chat-service-account.ts` + `.test.ts`
- Modify: `comms-executor.ts`. `googleChatSend` uses the API in service-account mode; add `googleChatUnsend` to `commsUnsend`.
- Modify: the `channel-core.ts` google-chat rule, `channel-setup-definitions/google-chat.ts` (+ test), `GUIDED_INBOUND_CHANNELS`, `GENERIC_ALLOWLIST_INBOUND_CHANNELS`, and the parity matrix and proof. Add the route test to `apps/gateway/src/routes/integrations.webhooks.test.ts`, or create `integrations.google-chat-webhook.test.ts`.

**Config (service-account mode):** `serviceAccountKeyEnv` (env holding the service-account JSON key) or `serviceAccountKey`; `audienceType: "project_number" | "endpoint_url"`; `audience` (the project number, or this endpoint's public URL). Webhook mode (`webhookUrl`) keeps working, outbound-only. `requiredAnyOf` becomes `[["webhookUrl", "url", "serviceAccountKeyEnv", "serviceAccountKey"]]`.

**Verifier interface (Produces):**

```ts
export type GoogleChatCertFetcher = (url: string) => Promise<{ certs: Record<string, string>; maxAgeSeconds?: number }>;
export const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
export const GOOGLE_CHAT_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
export const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
export async function verifyGoogleChatBearer(input: {
  authorizationHeader: string | undefined;
  audienceType: "project_number" | "endpoint_url";
  audience: string;
  fetchCerts: GoogleChatCertFetcher;   // cached by caller per maxAge
  now?: () => number;
}): Promise<{ ok: true } | { ok: false; reason: "missing_token" | "malformed" | "bad_alg" | "unknown_kid" | "bad_signature" | "bad_issuer" | "bad_audience" | "expired" | "bad_email" }>;
export function normalizeGoogleChatEvent(input: { connectionId: string; payload: unknown }):
  | { kind: "message"; eventId: string; space: string; threadName?: string; actorId: string; displayName?: string; content: string; metadata: Record<string, unknown> }
  | { kind: "ignore"; eventType?: string; reason: string };
```

- **Verification rules.** The algorithm must be `RS256`; anything else, including `none`, is `bad_alg`. Pick the certificate by `kid` from the cert map, verify with `crypto.createVerify("RSA-SHA256")` against `crypto.createPublicKey(pem)`, then check `exp` (with 60 s skew) and `iat`.
  - For `project_number`: `iss === GOOGLE_CHAT_ISSUER`, `aud === audience`, certs from `GOOGLE_CHAT_CERTS_URL`.
  - For `endpoint_url`: `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud === audience`, `email === GOOGLE_CHAT_ISSUER`, `email_verified === true`, certs from `GOOGLE_OIDC_CERTS_URL`. `GOOGLE_OIDC_CERTS_URL` returns PEM certs keyed by kid in the `v1` format.
  - The cert fetcher in the route is a fixed-host `fetch`; the URL is a constant, not taken from config. Cache it per URL for `maxAge`, taken from `Cache-Control`, default 1 h.
- **Normalization.** Support both the classic event shape (`type === "MESSAGE"`, `message`, `space`, `user`) and the Workspace add-on shape (`chat.messagePayload.{message,space}`, `chat.user`).
  - Ignore `ADDED_TO_SPACE`, `REMOVED_FROM_SPACE` and `CARD_CLICKED`. A reply of `{}` is fine.
  - Ignore `message.sender.type === "BOT"` (self-echo).
  - `eventId = message.name` (`spaces/S/messages/M`). `content = message.argumentText?.trim() || message.text`, which strips the @mention. `actorId = message.sender.name` (`users/123`). `metadata.email = sender.email`.
- **Route.** It uses `createWebhookHandler` with `source: "google-chat"`.
  - `verifySignature` → `verifyGoogleChatBearer`. A missing `audience` config gives 400; a failure gives 401 with `logReason` = reason.
  - The dispatch `idempotencyKey` is `google-chat:${connectionId}:${eventId}`. `bindingTarget` is the space name. `message = { eventId, account: connectionId, room: space, threadId: threadName, actorId, displayName, content, metadata }`. The HTTP reply is `{}`. The durable worker replies asynchronously through the API.
- **Service-account client (policy-engine).** `getGoogleChatAccessToken(keyJson: string, fetcher, now?)` builds the JWT `{ iss: client_email, scope: "https://www.googleapis.com/auth/chat.bot", aud: token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat+3600 }`, signs it RS256 with `private_key`, and POSTs `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…`. Cache the token per `sha256(client_email + private_key_id)` until `expires_in - 60` s. A malformed key JSON throws `"Google Chat service-account key is malformed"`; the error must never include key material.
- **Send in SA mode.** `POST https://chat.googleapis.com/v1/${space}/messages` with `{ text, thread?: { name } }`. When a thread is given, also send `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`. `target` is `spaces/…`. The result is `message.name`, which becomes the providerMessageId.
- **Unsend in SA mode.** `DELETE https://chat.googleapis.com/v1/${messageName}`. `messageName` comes from `args.messageId` and must match `/^spaces\/[^/]+\/messages\/[^/]+$/`. Both calls go through `fetchAllowlisted`.
- **channel-core.** In SA mode with `audience`: `supportedActions ["channel.send", "channel.reply", "channel.unsend"]`, `inboundModes ["webhook"]`, `outboundTransport "api"`, and the summary says app messages can be deleted (only the app's own messages). Webhook mode stays as it is but loses the phrase "inbound routing is not available": it now says "inbound requires Chat app (service-account) mode".

- [ ] **Step 1: Write failing verifier tests.** Generate an RSA key pair in the test with `crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })`, build the PEM cert map, and sign tokens with a test helper. Cases:
  - a valid project-number token gives ok;
  - a valid endpoint-url token with the email gives ok;
  - wrong aud → `bad_audience`;
  - wrong iss → `bad_issuer`;
  - expired → `expired`;
  - unknown kid → `unknown_kid`;
  - `alg: "none"` with an empty signature → `bad_alg`;
  - a tampered payload → `bad_signature`;
  - endpoint-url mode with the wrong email → `bad_email`;
  - no header → `missing_token`.

  The `createVerify` path accepts a raw public key PEM as well as an x509 cert PEM, so the test map can hold the public key PEM. Note this in the test.
- [ ] **Step 2: Write failing normalizer tests.** Cover a classic MESSAGE, the add-on shape, a BOT sender ignored, ADDED_TO_SPACE ignored, and argumentText preferred over text.
- [ ] **Step 3: Write failing route tests.** Follow the existing webhook route tests (e.g. the Nextcloud Talk cases in `integrations.webhooks.test.ts`):
  - a bad token gets 401 and is not dispatched;
  - a valid token dispatches with the key `google-chat:<conn>:spaces/S/messages/M`;
  - **the same request replayed** dispatches with the identical key;
  - a non-allowlisted sender is dropped;
  - a disabled connection gets an ignored reply.
- [ ] **Step 4: Write failing policy-engine tests.** Token minting posts the jwt-bearer grant and caches the token (one token fetch for two sends). SA send posts to the API URL with `Bearer`. Unsend issues a DELETE. An invalid message name is rejected before any fetch.
- [ ] **Step 5: Run the tests.** Expected: FAIL.
- [ ] **Step 6: Implement.**
- [ ] **Step 7: Run the tests,** plus `webhook-handler-factory.test.ts`, `integration-webhooks.security.test.ts`, `channel-setup-definitions.test.ts`, the policy-engine `tool-executor.test.ts` Google Chat cases, and the typecheck. Expected: PASS.
- [ ] **Step 8: Update the matrix.** Add row `google-chat.app-service-account`: config `{ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audienceType: "project_number", audience: "123456789012" }`, `inboundMode: "webhook"`, `outboundTransport: "api"`, and the proof files. Update the proof list.
- [ ] **Step 9: Commit.** `feat(channels): Google Chat app inbound with verified Google JWTs and service-account send/unsend`

### Task 6: Durable exactly-once pin for every new adapter (Review Focus #1)

**Files:**
- Modify: `apps/gateway/src/services/inbound-channel-event-service.test.ts`

- [ ] **Step 1: Write the test.** Add `it.each` over four cases. Each one builds its `DurableInboundChannelAcceptInput` from the **real** normalizer or adapter output, captured by running the adapter with a recording `emit`, or for Google Chat by calling `normalizeGoogleChatEvent` and building the key:
  - ntfy message → `ntfy:<conn>:<id>`
  - Mattermost post → `mattermost:<conn>:<postId>`
  - Signal envelope → `signal:<conn>:<source>:<timestamp>`
  - Google Chat MESSAGE → `google-chat:<conn>:spaces/S/messages/M`

  For each case, using the file's existing `createHarness()`: accept the input, then accept the identical input again as a reconnect replay. Assert that the second result has `deduped === true` and the same `inboundEventId`. Then restart the harness's service on the same storage (follow the existing "recovers … after restart without duplicating its turn" test) and accept once more. Assert `deduped === true` and exactly one turn was admitted, using the harness's turn counter or its recorded calls.
- [ ] **Step 2: Run it.** Expected: PASS. The durable store already dedupes, so this is a pin, not a behavior change. If it fails, the adapter key is non-deterministic: fix the adapter, not the test.
- [ ] **Step 3: Commit.** `test(channels): pin exactly-once inbound for ntfy, Mattermost, Signal and Google Chat`

**PR1 gate.** Run the focused tests; `pnpm typecheck`; `node scripts/verification/run.mjs` is not needed; `pnpm verify:architecture:metrics`; `node scripts/verify-repo-hygiene.mjs`; `pnpm verify:channels:parity`; `git diff --check`. Push, then open PR1. The PR body says this is part 1 of 2 and that PR2 (actions and voice) follows, stacked on this branch.

---

## PR2 — Actions and voice

### Task 7: Platform-unsupported actions in the capability contract (5.5 unsend half, 5.6 Slack)

**Files:**
- Modify: `packages/contracts/src/channels.ts`. Add `platformUnsupportedActions: Partial<Record<ChannelActionName, string>>` to `ChannelCapabilities`. Each value is the operator-facing reason.
- Modify: `channel-core.ts`. Add `platformUnsupportedActions?: Partial<Record<ChannelActionName, string>>` to `ChannelRule`. `describeChannelCapabilities` copies it, defaulting to `{}`. Populate:
  - `whatsapp`: `{ "channel.unsend": "WhatsApp Cloud API has no endpoint for deleting a sent message." }`. Also rewrite the WhatsApp summary and notes: drop "delete parity is still incomplete / not wired", and state that the platform does not support it.
  - `slack`: `{ "channel.typing": "Slack has no typing-indicator API for bots (only legacy RTM, which bot tokens cannot use)." }`
  - `nextcloud-talk`: `{ "channel.unsend": "Nextcloud Talk bots cannot delete messages through the bot API." }`. Only add this if the docs confirm it; otherwise leave it out.
  - `google-chat`: `{ "channel.typing": "Google Chat has no typing-indicator API." }`
  - `ntfy`: `{ "channel.react": …, "channel.typing": … }`. (Final fix: ntfy unsend is implemented as `DELETE /<topic>/<message id>`, so it is no longer declared platform-unsupported.)
- Modify: `apps/gateway/src/services/comms-service.ts` (`commsTyping`) and `comms-executor.ts` (`commsReact`/`commsUnsend` default branches). When the action is in `platformUnsupportedActions`, return or throw with that reason, and with `status: "unsupported"` and `reason` prefixed `"Platform does not support this: "`, instead of the generic "not supported" text.
- Modify: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelJourneyEvidence.tsx:28`. After the supported list, render "Not offered by the platform: typing (Slack has no …)" when the map is non-empty. Use plain operator language, per DESIGN.md / PRODUCT.md. Update any fixture that constructs `ChannelCapabilities` literally; `git grep -n "supportedDeliveryActions:"` finds them.

- [ ] **Step 1: Write failing tests.**
  - `channel-core.test.ts`: whatsapp `platformUnsupportedActions["channel.unsend"]` is defined and `supportedActions` lacks unsend; the same for slack typing.
  - A comms-service test: typing on Slack returns `status "unsupported"` with a reason starting "Platform does not support this".
  - A policy-engine test: `channel.unsend` on whatsapp throws with the platform reason.
  - A mission-control-next component test that renders the "Not offered by the platform" line.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild contracts and gateway-core.
- [ ] **Step 4: Run the tests and the typecheck.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(channels): report platform-unsupported channel actions honestly`

### Task 8: Typing for Mattermost, Signal and WhatsApp (5.2 / 5.4 / 5.5 / 5.6)

**Files:**
- Modify: `packages/contracts/src/comms.ts`. Add `messageId?: string` to `ChannelTypingInput`; it is the inbound provider message being answered. Find where the inbound reply path emits typing or activity (`git grep -n "commsTyping\|emitChannelTyping\|channel.typing" apps/gateway/src`). Pass the inbound event's provider message id there when it is available.
- Create: `apps/gateway/src/services/channel-typing-adapters.ts` + `.test.ts`
- Modify: `comms-service.ts`. Add the `CommsHost.emitProviderTyping(connection, input): Promise<ChannelTypingResult>` host method, and route `mattermost | signal | whatsapp` to it.
- Modify: `integration-channel-service.ts` (implement `emitProviderTyping` by delegating to the adapters) and `gateway-route-composition-integrations.ts:608-610` (wire it).
- Modify: `channel-core.ts`. Add `"channel.typing"` to the mattermost, signal and whatsapp supportedActions; update their notes.

**Adapters** (each takes `{ connection, input, resolveSecret, isAllowlisted, fetch }`, returns `ChannelTypingResult`, and never throws; failures come back as `status: "unsupported"` with a reason):
- **Mattermost:** `GET /api/v4/users/me` (cache the id per connectionId + token hash), then `POST /api/v4/users/{id}/typing` with `{ channel_id: target, parent_id: threadId }`.
- **Signal:** a JSON-RPC `sendTyping` to `${baseUrl}/api/v1/rpc` with `{ account?, recipient: [num] }` or `{ groupId }`. Reuse the target parsing from `buildSignalTargetParams` semantics: a `group:` prefix means groupId.
- **WhatsApp:** requires `input.messageId`. Without it, return unsupported: "WhatsApp typing indicators are tied to an inbound message; no message id was supplied." With it, `POST {graph}/{phoneNumberId}/messages` with `{ messaging_product: "whatsapp", status: "read", message_id, typing_indicator: { type: "text" } }`. Reuse the Graph base-URL helper the voice service uses.

- [ ] **Step 1: Write failing adapter tests** for each channel. Cover: the success request shape (URL, headers, body); an allowlist denial gives unsupported; a 4xx gives unsupported with the status in the reason; WhatsApp without a messageId gives unsupported. Also write a comms-service routing test.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the typecheck.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(channels): typing indicators for Mattermost, Signal and WhatsApp`

### Task 9: Signal react and unsend (5.4 actions)

**Files:** `comms-executor.ts` (`signalReact`, `signalUnsend`, and the cases in `commsReact`/`commsUnsend`), `channel-core.ts` (signal supportedActions += react, unsend, reply-as-send), and the policy-engine tests.

- **react:** RPC `sendReaction` with `{ account?, emoji: args.emoji ?? args.reaction, targetAuthor, targetTimestamp: Number(args.messageId), remove: args.remove === true, ...recipientOrGroup }`. `targetAuthor` is `args.targetAuthor`; for direct targets it falls back to the target itself. A group target without `targetAuthor` throws "Signal group reactions need targetAuthor". A non-numeric `messageId` throws before any fetch.
- **unsend:** RPC `remoteDelete` with `{ account?, targetTimestamp: Number(args.messageId), ...recipientOrGroup }`. The supportNote says Signal deletes only messages this account sent.
- Return the RPC `timestamp`, or `signal-react-<ts>` / `signal-unsend-<ts>`.

- [ ] **Step 1: Write failing tests.** A direct react body, a group react with targetAuthor, a group react without it throws, unsend uses remoteDelete, and a non-numeric messageId is rejected with no fetch.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(channels): Signal reactions and remote delete`

### Task 10: Inbound voice for Slack, Discord and Nextcloud Talk (5.7)

**Files:**
- Modify: `channel-voice-inbound-service.ts`. Add these `ChannelVoiceInboundRequest` variants:
  - `{ channel: "slack"; connectionConfig; fileId: string; downloadUrl: string; mimeType?: string }`. `downloadUrl` must be `https://files.slack.com/...`. Download with the bot token as `Authorization: Bearer`. Validate `fileId` with `/^F[A-Z0-9]{6,20}$/`.
  - `{ channel: "discord"; connectionConfig; attachmentId: string; url: string; mimeType?: string }`. The URL host must be `cdn.discordapp.com` or `media.discordapp.net`. No auth.
  - `{ channel: "nextcloud-talk"; connectionConfig; fileId: string; downloadPath: string; mimeType?: string }`. Before implementing, research (WebFetch on the Nextcloud Talk bot docs) whether a Talk bot can download a shared voice file. If it can, implement it with the required credential (e.g. optional `webdavUser` + `webdavAppPasswordEnv`, downloading `${baseUrl}/remote.php/dav/files/${user}/${path}`). If it cannot, do **not** add a download variant. Instead, the webhook dispatches a normal agent turn whose content is the honest fallback "[voice message received — Nextcloud Talk bots cannot download shared media, so it was not transcribed]". Add a supportNote saying so. Record whichever you chose in the commit message.
  - All variants share the existing caps: 8 MB, no redirects, allowlist check, audio sniffing.
- Modify: the Slack webhook (`integration-webhooks-slack-routes.ts` / its normalizer). When `isVoiceInboundEnabled()`, a `message` event with `files[]` whose `mimetype` starts with `audio/` or whose `subtype === "slack_audio"` dispatches through `dispatchInboundVoiceWebhookMessage`, with fallback content `"[voice message]"` plus any text.
- Modify: `discord-runtime-service.ts` / `discord-runtime-bridge-service.ts`. A message with an attachment whose `contentType` starts with `audio/` (voice messages carry flag `IsVoiceMessage`) dispatches `dispatchKind: "voice_agent_turn"` with `voiceRequest` when voice is enabled. Respect the existing pairing and allowlist gates exactly as text messages do.
- Modify: the Nextcloud Talk webhook normalizer and route, per the research outcome above.
- Modify: the `channel-core.ts` notes for these three channels.

- [ ] **Step 1: Write failing tests.**
  - voice-service: URL host validation rejects a non-Slack or non-Discord host; a redirect is refused; the over-size cap is enforced; the Slack request carries Bearer.
  - Slack route: an audio file dispatches a voice_agent_turn when enabled, and a text turn when disabled.
  - Discord bridge: an audio attachment gives a voice_agent_turn.
  - Nextcloud: the chosen behavior.
  - Replay of the same Slack/Discord voice event gives an identical idempotency key; the existing keys are unchanged.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the typecheck.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(channels): inbound voice transcription for Slack, Discord and Nextcloud Talk`

### Task 11: Flip `channelVoiceInboundV1Enabled` on, then truth sweep and parity proof

**Files:** `apps/gateway/src/config.ts:1462` (`?? true`); feature-flag tests that assert the default; README, `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md` and `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md` wherever they describe channel voice as opt-in or name the closed WS5 gaps. Keep the README's governance-gate phrases verbatim. Also the parity matrix and proof list.

- [ ] **Step 1: Run `pnpm verify:channels:parity`** with the flag still default-off. It must be green before the flip. If it is red, fix the cause first.
- [ ] **Step 2: Write a failing test** that the config default for `channelVoiceInboundV1Enabled` is `true` when the env and the stored value are absent.
- [ ] **Step 3: Flip the default.** Update the tests that pinned `false`.
- [ ] **Step 4: Run the truth sweep:**

```
git grep -n -i "not yet wired\|inbound routing is not available\|outbound-only\|outbound only\|delete parity\|not wired in this bridge" -- packages/gateway-core/src apps/gateway/src/services/channel-setup-definitions docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md README.md docs/1_0_CONTRACT.md docs/CANONICAL_RUNTIME_STATE_MODEL.md
```

Every hit about ntfy, Mattermost, Google Chat, Signal or WhatsApp-unsend must now be true. Rewrite any that aren't. Teams, Zalo and LINE are out of scope; leave them.
- [ ] **Step 5: Run the full PR2 gate:** `pnpm verify:channels:parity`, `pnpm typecheck`, `pnpm verify:architecture:metrics`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check`, and `pnpm docs:check` if the docs changed.
- [ ] **Step 6: Commit.** `feat(channels): enable inbound channel voice by default after parity proof`, then push and open PR2.
