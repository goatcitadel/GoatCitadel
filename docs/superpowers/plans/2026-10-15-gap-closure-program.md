# Gap Closure Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every half-built feature found in the 2026-10-15 partial-feature audit, so that nothing users can see or configure only half works.

**Architecture:** This is a program plan. It covers ten workstreams (WS1–WS10). Each one ships as its own PR from its own worktree off `origin/main`. WS1 has a full bite-sized TDD plan in [2026-10-15-gap-closure-ws1-quick-wins.md](2026-10-15-gap-closure-ws1-quick-wins.md). Every other workstream lists its tasks here: files, interfaces, the tests that pin the behavior, and acceptance criteria. Before coding a workstream, its executor writes the step-level plan for it (with the `superpowers:writing-plans` skill), against the code as it is on `main` at that time. Main moves daily, so line numbers written now would go stale.

**Tech Stack:** TypeScript (pnpm monorepo), Fastify gateway, vitest (gateway, UI), `node:test` via `tsx --test` (storage), React (mission-control-next Cockpit), SQLite + Postgres storage, C++ (remote-worker native).

**Spec:** This document plus the audit findings it restates. The decisions below came from the operator on 2026-10-15:
- Build every catalog-only item: Matrix, QQBot, WeCom, Notion, GitHub, iMessage via Photon, AWS Bedrock.
- Fold the Cockpit → Classic hand-offs into the existing Cockpit remediation program (`2026-10-05-cockpit-remediation.md` Task 15 plus the nitpick workstreams). Don't run a parallel track.
- Re-enable the deliberately gated chat features: workspace snapshots, model council, Work Passport on new turns, and explicit-context edit/retry/child.
- **Out of scope:** signed Windows preview updates, promoting the macOS/Linux installers, cross-platform hostile-code sandbox proof, and 1.0 release-gate certification.

## Global Constraints

- Work only in a fresh worktree per workstream, branched from `origin/main`. **Never edit the main checkout `C:\personal-ai`**: it holds another agent's uncommitted feature-quality-runtime work.
- Never `git stash` (the stash ref is shared across every worktree). Copy files aside or commit instead.
- Run vitest with `--maxWorkers=2` at low process priority, and only one heavy job at a time.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`.
- Storage focused test: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`.
- Run `prettier --write` only on files you changed, never on a directory glob.
- Any new Postgres table needs a convergence migration, tested on both lineages (fresh install and upgraded install). See the PG v2 dual-lineage trap.
- Test SQLite through `TempSqliteFiles`.
- Never run `architecture:baseline:update`. A new service file needs an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`.
- No personal paths in tracked files (local user-profile or personal source-drive paths; `scripts/verify-repo-hygiene.mjs` `PERSONAL_PATH_PATTERNS` lists them).
- README edits must keep the ~17 verbatim phrases the governance gate checks.
- Docs, UI copy and code must agree (AGENTS.md "Truth Beats Theater"). Any doc that names a gap is updated in the same PR that closes it: `README.md`, `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.
- New dependencies only where this plan names them.
- Commit messages: `<type>: <description>` (feat, fix, refactor, docs, test, chore).
- Run `/verify` before each commit, except docs-only and tests-only commits.
- Proof lane per workstream:
  - `pnpm typecheck`
  - focused tests
  - `pnpm verify:fast`
  - `git diff --check`
  - plus any named lanes the workstream lists

## Review Focus

1. **Double execution after approval.** If an operator approves a mail send, calendar create, or ward-gated integration action twice, or the gateway restarts mid-execution, it must run exactly once. Owner: WS2 Task 2.1 and WS3 Task 3.1. Pin it with an idempotency-key test that replays the approval-effect handler twice.
2. **Stored durable chat payloads written by the old router.** Rows that still carry `autoRoute:false` and a `surfaceDerivation` must keep resuming after the router is deleted. Owner: WS1 Task 1. Pin it with a reconstruct test using a v1 stored payload.
3. **Invalid or unknown IANA timezone in active hours.** It must fall back to host time, never throw, and never stop all wakes. Owner: WS1 Task 2.
4. **The ward changes between approval and execution.** A ward tightened after an approval must re-gate the action at execution time. Owner: WS3 Task 3.1 handler (re-evaluates the ward). Pin it with a test that switches the ward to `deny` before the effect runs.
5. **Inbound channel events delivered twice.** This covers reconnects, restarts and replayed webhooks for the new inbound adapters. Each must produce exactly one chat turn. Owner: WS5 Tasks 5.1–5.4 and WS6 channel tasks. Pin it with a durable dedupe test per adapter, keyed on the provider event id.

---

## Ordering and parallelism

| Order | Workstream | Depends on | Shares hot files with |
|---|---|---|---|
| 1 | WS1 Quick wins & cleanup | — | — |
| 2a | WS2 Communications send/create | WS1 | WS3 (`approval-resolution-effects-service.ts`) |
| 2b | WS4 Providers & eval | WS1 | — |
| 2c | WS5 Channel parity | WS1 | WS6 (`channel-core.ts`, `comms-executor.ts`) |
| 2d | WS7 Runtime hardening | WS1 | WS8 (`external-side-effect-runner-service.ts`) |
| 3a | WS3 Ward enforcement | WS2 merged | WS2 |
| 3b | WS6 New integrations | WS5 merged | WS5 |
| 3c | WS8 Replay & Code Mode promote | WS7 Task 7.3 merged | WS7 |
| 4 | WS9 Gated chat features | the main-checkout feature-quality work on `chat-turn-prep-service.ts` has landed | — |
| — | WS10 Cockpit fold-in | runs inside the existing Cockpit program | — |

WS2, WS4, WS5 and WS7 can each run in their own session at the same time, since none of them touches another's files.

---

## WS1 — Quick wins and cleanup

Full step plan: [2026-10-15-gap-closure-ws1-quick-wins.md](2026-10-15-gap-closure-ws1-quick-wins.md).

- Task 1: Retire the legacy surface auto-router. Keep `autoRoute` as a deprecated, ignored contract field.
- Task 2: Make the active-hours timezone actually apply.
- Task 3: Support nested SQLite async transactions with savepoints.
- Task 4: Make add-on launch data-driven, not Arena-only.
- Task 5: Docs truth pass: README `require_dry_run`, the stale skill-output comment, and "superseded" banners on the auto-router docs.

---

## WS2 — Mail send and calendar create actually execute

**Problem:** `POST /api/v1/mail/drafts/:id/send` and `POST /api/v1/calendar/events` create approvals of kind `communications.mail.send` / `communications.calendar.create`. Nothing acts on them once they're approved. Drafts live in an in-memory `Map` and are lost on restart. `commsCalendarCreate` has no idempotency.

### Task 2.1: Execute approved communications through effect kinds
- **Files:**
  - Modify `apps/gateway/src/services/approval-resolution-effects-service.ts`:
    - In `enqueueResolutionEffects`, add branches for both kinds.
    - In the `switch (effect.effectKind)` worker, add `COMMUNICATIONS_MAIL_SEND_EFFECT_KIND` and `COMMUNICATIONS_CALENDAR_CREATE_EFFECT_KIND`.
    - Model both on the `MESH_CAPABILITY_ACTIVATION_*` enqueue/handle pair.
  - Modify `apps/gateway/src/services/communications-dashboard-service.ts`. The approval payload must carry the full send/create input, its SHA-256 `payloadHash`, and an `idempotencyKey` of `communications:<approvalId>`.
  - Modify `apps/gateway/src/routes/communications.ts` to inject the `commsGmailSend` / `commsCalendarCreate` deps.
- **Interfaces:**
  - Handlers call the existing `commsGmailSend(host, GmailSendInput)` and `commsCalendarCreate(host, CalendarCreateEventInput)` (`comms-service.ts`) with `idempotencyKey`.
  - Each must bypass a *second* policy approval by presenting the settled `approvalId` as pre-approval evidence. Use the same mechanism `handlePendingActionExecute` uses.
- **Decision recorded:** keep the custom communications approvals, because they carry richer previews. Don't route through the generic `pending_action_execute` path.
- **Tests:** `approval-resolution-effects-service.test.ts`:
  1. approve → handler sends once;
  2. the handler runs twice → the provider is called once (Review Focus #1);
  3. the payload hash is tampered with → fail closed;
  4. the account has no send-capable provider (imap/smtp/manual) → the approval settles `failed` with an operator-readable reason.
- **Acceptance:** remove the preview copy "this route does not send the message" and "does not mutate the external calendar".

### Task 2.2: Persist mail drafts
- **Files:**
  - Create `packages/storage/src/mail-draft-repo.ts`, modeled on `channel-setup-draft-repo.ts`, with SQLite + Postgres migrations and a convergence migration.
  - Swap the `Map` in `CommunicationsDashboardService` for the repo.
- **Tests:**
  - repo round-trip on both dialects;
  - a service restart keeps the draft and its `approvalId`.

### Task 2.3: Make calendar create idempotent
- Wrap `commsCalendarCreate` in `runIdempotentExternalSideEffect` (boundary `comms_calendar_create`), following `commsGmailSend` at `comms-service.ts` (`runIdempotentExternalSideEffect` with boundary `comms_gmail_send`).
- **Test:** the same key twice → one `calendar.create_event` invoke.

### Task 2.4: Send for IMAP/SMTP accounts
- Add an SMTP send tool in the policy-engine comms executor, registered in `tool-registry.ts` as `riskLevel:"danger", requiresApproval:true`. Add host allowlisting through the connection's configured SMTP host.
- **New dependency:** `nodemailer` (justified: hand-rolled SMTP AUTH/STARTTLS is not worth the risk). If the operator vetoes it, mark IMAP/SMTP drafts `send_unavailable` in the UI instead.

---

## WS3 — Citadel Ward enforcement

### Task 3.1: `require_approval` becomes an approval loop, not a block
- **Files:**
  - `integration-action-service.ts` (~L114-126)
  - `a2a-route-service.ts` (~L630-646)
  - `a2a-push-notification-service.ts` (~L205-230)
  - `approval-resolution-effects-service.ts`
- **Behavior:**
  - Create an approval (through `approval-lifecycle-service.createApproval`). Its payload holds the full invoke request, `payloadHash`, `wardAction` and `citadelId`.
  - Return `status:"approval_required"` plus `approvalId`.
  - Add the effect kinds `citadel_ward.integration_action`, `citadel_ward.a2a_outbound` and `citadel_ward.a2a_push`.
  - Each handler **re-evaluates the ward** before running. Use the same pattern as `runtime-configuration-approval-binding.ts` (`currentWardEffect`) and replay as in `external-runtime-approval-adapter.ts` (`executeApprovedExternalRuntimeSideEffect`).
  - A2A push needs a `deferred_pending_approval` delivery state in `a2aTaskPushConfigs`.
- **Tests:**
  - Flip `integration-action-service.test.ts` "blocks require_approval fail-closed until the approval loop is wired" to expect `approval_required`.
  - approve → executes once.
  - The ward tightens to `deny` before execution → blocked (Review Focus #4).
  - Matching cases in the a2a route and push tests.

### Task 3.2: Enforce `route_local`
- **Design decision (made at kickoff, recorded in the WS3 step plan):** `route_local` is evaluated against model work. New ward action names: `model.chat.<providerId>` and `model.tool.<toolName>`.
- **Enforcement point:** the model route-decision service. If a matched `route_local` ward applies, it restricts candidate providers to local backends (`ollama`, `llama_cpp`, `openai_compatible` with a loopback base URL). If no local route is healthy, the turn fails closed with `citadel_ward_route_local_unavailable`.
- **Files:**
  - `packages/policy-engine/src/engine.ts` (~L1344)
  - `apps/gateway/src/services/citadel-ward-gate.ts`
  - the model route selector (find it at kickoff: `git grep -n "routeDecision\|selectRoute" apps/gateway/src/services`)
  - the copy in `citadel-ward-model.ts`
- **Tests:**
  - local available → the local provider is chosen;
  - no local provider → fail closed;
  - the audit reason code is still recorded.
- **Docs:** drop "route_local … not yet enforced" from README L164/L213/L546 and from `1_0_CONTRACT.md`.

---

## WS4 — Providers and evaluation

### Task 4.1: AWS Bedrock adapter
- **Files:**
  - Create `apps/gateway/src/services/llm-provider-bedrock.ts` implementing `LlmProviderAdapter` (`llm-provider-adapter.ts`).
  - Register it next to `anthropicProviderAdapter` in `llm-service.ts` (~L316) and delete the two throws (~L1812, ~L1980).
  - Contracts: add `aws-sigv4 | aws-bedrock-api-key` to `LlmProviderAuthMode` and an `aws: { region; profile? }` block to the provider config. Update the zod schema in `config-schemas.ts`.
  - Settings UI: `ProviderProfileFields.tsx`.
  - Add a template in `provider-templates.ts`.
- **API:** use Bedrock **Converse / ConverseStream**, so every Bedrock model family works, not just Claude.
- **Auth:**
  - API key → `Authorization: Bearer`.
  - SigV4 → keychain-stored access key/secret/session token, resolved like the other `resolveApiKey` keychain entries.
- **New dependencies:** `@smithy/signature-v4`, `@aws-crypto/sha256-js` and `@smithy/eventstream-codec`. These are official AWS, small, and avoid hand-rolling SigV4 and the CRC-framed event stream.
- **Tests:** a new `llm-provider-bedrock.test.ts` in the style of `llm-provider-anthropic.test.ts`, with a fake host and a `fetch` stub. Cover:
  - request body mapping;
  - SigV4 headers present;
  - event-stream decode of `contentBlockDelta` / `messageStop`;
  - tool-use round trip;
  - error mapping.
- Also update `llm-service.test.ts` bedrock upsert so it expects success.

### Task 4.2: Blind model comparison actually runs
- **Files:**
  - `model-comparison-service.ts`: add `start(comparisonId)` with the transitions queued → running → completed/failed/cancelled.
  - `packages/storage/src/model-comparison-run-repo.ts`: add `updateStatus` and `upsertResult`.
  - Wire `runPromptPackTest` in `gateway-route-composition-runtime.ts` (~L374).
  - `routes/model-comparisons.ts`: add `POST /api/v1/model-comparisons/:comparisonId/run`.
  - Add the client in `mission-control-shared`.
- **Execution:** run each (test × candidate) through `PromptPackService.runPromptPackTest(packId, testId, { providerId, model, signal })`, with bounded concurrency of 2. Keep candidate identities blind until judging completes.
- **Tests:**
  - status transitions;
  - partial failure → `failed` while keeping the completed results;
  - cancel aborts the in-flight `signal`;
  - judging unchanged.
- Remove the advisory text "does not start live provider execution".

### Task 4.3: Thinking stream streams incrementally
- **Files:**
  - `llm-provider-anthropic.ts` (~L327-357): yield partial `thinking_delta` text per event, not buffered to `content_block_stop`.
  - `chat-agent-completion-adapters.ts` `absorbCompletionStreamChunk` (~L368): return `reasoningDelta`. Also read OpenAI-compatible `delta.reasoning_content` / `delta.reasoning`.
  - `chat-turn-agent-runner.ts` (~L4469-4490): yield `thinking_delta` per chunk and drop the end-of-pass emission.
  - `config.ts` (~L123-129): remove the word "skeleton".
- **Tests:**
  - Extend `chat-turn-agent-runner.thinking-stream.test.ts`: several deltas arrive before `message_done`, in order.
  - `chat-stream-secret-projector.test.ts`: per-chunk redaction still applies.
  - The reducer's 16k cap still holds.
  - `redacted_thinking` is still never emitted.

---

## WS5 — Channel parity

Use the existing ingress pattern. Webhook channels use `routes/webhook-handler-factory.ts` (`createWebhookHandler`) plus a `<ch>-webhook.ts` verifier, dispatched through `channel-inbound-dispatch.ts`. Persistent connections follow `discord-runtime-service.ts`. Every adapter dedupes durably on the provider event id (Review Focus #5).

| Task | Channel | Inbound mechanism | Also add |
|---|---|---|---|
| 5.1 | ntfy | JSON stream subscribe (`/<topic>/json`), a persistent runtime service | — |
| 5.2 | Mattermost | WebSocket `/api/v4/websocket` `posted` events, a persistent runtime | typing (`POST /api/v4/users/{id}/typing`) |
| 5.3 | Google Chat | Chat app HTTP endpoint with Google-signed JWT verification (needs service-account mode) | unsend for the app's own messages (`spaces.messages.delete`) |
| 5.4 | Signal | signal-cli JSON-RPC daemon `receive` notifications, replacing the `signal-inbound-runtime-service.ts` facade; durable dedupe on `source+timestamp` | react (`sendReaction`), unsend (`remoteDelete`), typing (`sendTyping`); delete the deprecated `signalInboundV1Enabled` flag |
| 5.5 | WhatsApp | (inbound already works) | typing via `typing_indicator`; mark unsend **platform-unsupported** in `channel-core.ts` so the UI says so honestly, instead of falling through to "not supported" |
| 5.6 | Typing for the rest | add `channel.typing` to `supportedActions` + host method + implementation + wiring (`comms-service.ts` ~L249-263, `integration-channel-service.ts`, `gateway-route-composition-integrations.ts`) for Slack (no public bot typing API, so mark platform-unsupported), Mattermost, Signal, WhatsApp | — |
| 5.7 | Inbound voice | add voice handling to Slack, Discord and Nextcloud Talk webhooks; flip `channelVoiceInboundV1Enabled` to default-on once `verify:channels` / `channel-parity-proof.mjs` is green | — |

- **Files per channel:** the footprint the audit enumerated from Nextcloud Talk (`channel-core.ts`, `comms-executor.ts`, `integration-webhooks-<ch>-routes.ts`, `<ch>-webhook.ts`, `channel-setup-definitions/<ch>.ts`, `route-access.ts`, `connector-registry.ts`, `integration-diagnostics-service.ts`, `channel-parity-matrix.mjs`, and the matching tests).
- **Tests per task:**
  - signature verification rejects a bad signature;
  - an allowlist-denied sender is dropped;
  - a duplicate event yields one turn;
  - a reconnect resumes without replaying history;
  - `channel-parity-matrix.test.ts` rows updated.

---

## WS6 — New integrations

### Tasks 6.1–6.3: Matrix, QQBot, WeCom channels
- **Matrix:** client-server API over plain HTTP. Inbound uses a `/sync` long-poll persistent runtime with `since` token persistence. Outbound covers send, react, redact (unsend) and typing. No SDK.
- **QQBot:** app access-token exchange. Inbound is the webhook mode with ed25519 signature verification. Outbound is send.
- **WeCom:** `gettoken`. Inbound is callback mode with AES-CBC decryption and signature check. Outbound is send.
- Each one flips `maturity: "planned"` to `"live"` in `integration-catalog.ts` (~L223-275, ~L885-910) and deletes the "Runtime adapter probes are not wired yet" copy. Each adds `<ch>-live-probes.ts`.
- **Files and tests:** the full channel footprint (WS5), plus `scripts/verification/lib/channel-parity-matrix.mjs` and the guided-setup lane scenario.

### Tasks 6.4–6.5: Notion and GitHub productivity integrations
- Model on Trello:
  - form schema in `integration-catalog.ts`;
  - action specs in `integration-action-registry.ts`;
  - dispatch in `integration-action-service.ts` (`invokeNotionAction`, `invokeGitHubAction`);
  - base-URL override env;
  - `fixed-outbound-hosts.ts` entries (`api.notion.com`, `api.github.com`);
  - ward action names via `buildIntegrationWardAction`.
- **Actions:**
  - Notion: search, page read, page create, block append.
  - GitHub: issue list/read/create/comment, PR list/read.
- Writes go through `runIdempotentExternalSideEffect`.
- **Tests:** `integration-action-service.test.ts` per action:
  - happy path;
  - 401 mapping;
  - ward deny;
  - idempotent replay of a write.

### Task 6.6: iMessage via Photon/Spectrum
- **Blocked on:** the Photon sidecar HTTP contract (send/react/unsend endpoints and auth header). The repo has none. **First step: get the contract from the operator.** Then add `photonSend`/`photonReact`/`photonUnsend` in `comms-executor.ts`, dispatched where `assertBlueBubblesIMessageProvider` throws today (~L3257). Use `photonSidecarUrl` + `secretFrom(config, "photonAuth", "photonAuthEnv")`.
- Update the "diagnostics-only" copy in `channel-setup-definitions/imessage.ts` and `guided-journey.ts`.

### Task 6.7: Verify plugin package integrity
- **Today:** install only records metadata, so there are no bytes to hash.
- **Design:**
  - **npm sources:** resolve the tarball through the registry metadata (`dist.integrity`), download it into the plugin store, verify it against `expectedIntegrity` with `node:crypto` (SRI `sha512-<base64>`), and store the verified tarball.
  - **Local sources:** hash a deterministic file manifest (sorted relative path + sha256).
  - **git/url sources:** stay `unknown`, with the existing warning.
- **Files:** `integration-plugin-author-contract.ts` (~L44, ~L261-271), `integration-channel-service.ts` `installIntegrationPlugin`, `integration-plugin-store.ts`.
- **Tests:** verified / mismatch → `quarantined` / missing expected value; network allowlist respected for the registry fetch.

---

## WS7 — Runtime hardening

### Task 7.1: Legacy HTTP+SSE MCP transport
- In `mcp-http-transport.ts`, implement the legacy handshake when `transport: "sse"`:
  1. GET the SSE stream;
  2. await the `endpoint` event;
  3. require the endpoint URL to be **same-origin** and allowlisted;
  4. POST JSON-RPC to it, with responses read off the stream.
- Keep the 1 MB / 25 s limits.
- Update the preview copy in `routes/mcp.ts` (~L745-952) and graduate `GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS` record-only posture to callable for allowlisted servers.
- **Tests:** `mcp-runtime.test.ts`: handshake ok; cross-origin endpoint rejected; oversize rejected; session failure retried once.

### Task 7.2: Transcript outbox idempotency
- In `packages/gateway-core/src/event-ingest.ts` (~L440-470), make `transcripts.append` idempotent on `eventId` (unique index plus insert-or-ignore, with a convergence migration). Replace `console.warn` with the structured logger.
- **Test:** a crash between append and `markDelivered` → one transcript row after re-drain.

### Task 7.3: Generation-token fencing for external side effects
- In `external-side-effect-runner-service.ts`:
  - carry `claimToken` into `markCompleted`/`markFailed` as a compare-and-set;
  - fence the provider dispatch with `assertCurrent` (as MCP does with `effectDispatch`), and record a `dispatched` marker on the claim **before** the provider call;
  - then pass `leaseDurationMs` so stale claims can be taken over.
- **Never auto-retry an ambiguous post-boundary effect.** Takeover may redispatch only a claim with no `dispatched` marker. A claim taken over after its marker was written settles as `unknown_after_send`: it blocks automatic redispatch and surfaces for operator review, unless the effect carries a provider-enforced idempotency key (then redispatch with the same key is allowed).
- **Files:** `packages/storage/src/mutation-idempotency-repo.ts` (~L250-273) and the runner.
- **Tests:** on SQLite and Postgres, a stale claim without a `dispatched` marker is taken over and dispatched once; a stale claim with the marker settles `unknown_after_send` and the provider is not called again; the old holder's completion is rejected.

### Task 7.4: Watchtower access control on citadel cron listing
- In `packages/storage/src/cron-job-repo.ts` `listByCitadel` (~L347-357), require a `CitadelAccessScope` argument and filter by it. Add the first gateway caller (a citadel-scoped schedules list), with the scope check copied from `workspaces-route-service.ts`. Delete the TODO.
- **Tests:** denied scope → empty / 403; allowed scope → jobs.

### Task 7.5: Graduate no-agent cron
- Remove the `GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON` gate in `cron-no-agent-support.ts` once a proof lane covers its local-only execution. Update the contract line in `1_0_CONTRACT.md` (~L108).
- **Tests:** `cron-automation-service` tests flip from the 409 path to execution.

### Task 7.6: Remote-worker Windows cell capacity owners
- In `apps/remote-worker-windows-cell-native/src/cell_controller_main.cpp` (~L199-212), add `Connection::ObserveCapacity`, `ObserveBackingCapacity` and `ObserveInventory`, modeled on `Connection::ObservePoolCapacity`. Each must hold workload quiescence as `cell_controller_protocol.hpp` (~L226-233) requires.
- **Tests:** change `tests/cell_controller_protocol_test.cpp` mode `native-capacity-missing-hold` to expect success. Also `scripts/packaging/remote-worker-windows-cell-*capacity.test.mjs`.

---

## WS8 — Side-effect replay and Code Mode promote

### Task 8.1: Replayable Gmail, Trello and local-bridge side effects
- **Depends on:** Task 7.3.
- Persist an **encrypted, payload-bound replay record** (sealed with the existing secret store and re-hashed against `payloadHash` on replay).
- Extend the allowlist in `external-side-effect-replay-job-service.ts` (~L30-32).
- **Provider-side dedupe:**
  - Gmail: set a `Message-ID` derived from the idempotency key, and search for it before resending.
  - Trello: embed the idempotency marker in `desc`, and search the list before recreating. Also add the missing `externalDestinationFingerprint`.
  - Local bridge: add an `Idempotency-Key` header contract.
- **Tests:** replay after a provider timeout → exactly one email/card; a tampered sealed payload → refuse.

### Task 8.2: Aider patch promote
- Add a promote action that:
  1. re-verifies the artifact sha256 (pattern: `code-mode-verification-service.ts` ~L359-400);
  2. checks the workspace HEAD/tree pinned at plan time;
  3. applies through the workbench (`applyPatchWithScope`, `git apply --check` then apply) under an explicit approval.
- Relax `code-mode-aider-result-contract.ts` `audit_only` only for promoted runs.
- **Tests:** hash mismatch → refuse; HEAD moved → refuse; happy path → patch applied and ledger updated.

### Task 8.3: Docker backend graduation
- Remove "Planned" / `preview_only` once a digest-pinned image proof lane exists. Update `code-mode-execution-backends.ts` (~L172, ~L229) and the contract text.

---

## WS9 — Re-enable the gated chat features (profile-free)

**Context:** commit `078c420a9` (2026-09-25) removed frozen capability profiles from new turns. That disabled the features below because they depended on the frozen profile. Re-enabling them **must not** reintroduce per-turn authority snapshots, because profile/authority drift was the reason for the removal. Write a short design note before coding: `docs/superpowers/specs/2026-10-xx-profile-free-turn-bindings.md`.

| Task | Feature | Profile-free binding |
|---|---|---|
| 9.1 | Work Passport on new turns | Compute at prep with `work-passport-service.ts`, persist per turn, and inject through the live-catalog instruction builder (`chat-turn-prep-service.ts` ~L1561-1576) |
| 9.2 | Workspace snapshots | A turn-scoped immutable snapshot record keyed by `turnId`, read by the turn only, granting no tool authority |
| 9.3 | Model council | Run council members against the **live** callable catalog with a per-member policy recheck; remove the `ConflictError` at ~L662-664 |
| 9.4 | Explicit context: edit/retry/child | Extend the admission check at ~L648-655 to edit/retry (re-admit the context on the new turn) and child delegation steps (inherit the parent's admitted context ids, re-validated) |

- Each ships behind a default-off flag first, then defaults on once its proof lane is green.
- **Tests:** flip `chat-turn-prep-service.routed-context.test.ts` ~L752-753 rejections to acceptance. Extend `chat-turn-prep-service.work-passport.test.ts` and `chat-turn-capability-profile-service.test.ts` (~L574).
- **Docs:** remove the "temporarily unavailable" lines in `1_0_CONTRACT.md` (L7, L78, L80) and `CANONICAL_RUNTIME_STATE_MODEL.md`.

---

## WS10 — Cockpit → Classic hand-offs (fold into the existing program)

Don't build these here. Add them to `docs/superpowers/plans/2026-10-05-cockpit-remediation.md` Task 15 and to `docs/ux/cockpit-remediation/classic-parity-inventory.json`, in this order:

1. Approval record and history in Inbox (M, ~15 links)
2. Kanban agentic-run evidence in task detail, then retarget `/ops/kanban` links to `/work/kanban` (M, 8 links)
3. The S group: costs, schedules advanced edit, saved boards, diagnostics export, notes, settings detail panels
4. Run detail: orchestration trace, replay audit, sessions list (M)
5. Project home, intake and artifacts (M)
6. The L group: Library agents/knowledge/sources/memory/skills, the prompt-pack workbench, runtime/workers
7. Vault per-Chamber keys. These need gateway work first; add them to WS3's follow-ups.

Two clean-ups:
- Delete the unreachable `cockpit/app/AreaPlaceholder.tsx` (with its test).
- Delete the unreachable `?shell=classic` fallthrough at `settings-index.ts` ~L124.

---

## Out of scope (recorded so they aren't mistaken for forgotten)

- Signed Windows preview updates (needs a certificate and a policy change in `DesktopUpdatePolicy.cs` ~L78-81).
- macOS/Linux installer promotion.
- Cross-platform hostile-code sandbox proof.
- 1.0 release-gate certification.

## Self-review notes

- **Spec coverage:** every audit item maps to a task, except the four out-of-scope items above. Two audit corrections are folded in:
  - Remote MCP over Streamable-HTTP already works; only legacy SSE remains (7.1).
  - Postgres already nests transactions with savepoints; only the SQLite async client lacked it (WS1 Task 3).
- **The skill-output-directives comment** may be stale. It is checked in WS1 Task 5, and fixed only if `connector-delivery.ts` proves delivery is wired.
