# Parity-Review Hardening Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0/P1 proof gaps identified by `reports/external-repo-reviews/2026-07-07-hermes-openclaw-parity.md` — bounded external reads, external side-effect replay safety, MCP stream/crash regressions, and memory batch transaction proof + minimal batch UI.

**Architecture:** Four independent phases, one branch/PR each. Phases 1–3 are mostly test-hardening around verified-existing machinery; Phase 2 additionally ledgers the second (un-ledgered) Gmail send path and wires the production Activepieces replay job (currently inert — every replay skips `job_unavailable`). Phase 4 proves batch-memory atomicity against real storage and adds a minimal multi-select batch UI to the Library memory page.

**Tech Stack:** TypeScript, Fastify gateway (`apps/gateway`), vitest 4, node:test (scripts checkers), React + bespoke CSS (`apps/mission-control-next`), shared client (`packages/mission-control-shared`), zod, pnpm workspaces.

## Context

The parity review (verified against the codebase this session — all internal citations accurate) concluded GoatCitadel is not behind Hermes/OpenClaw on trust architecture but is behind on **proof breadth**. Exploration confirmed and sharpened this:

- **Bounded reads:** exactly ONE genuine unbounded external read exists in product runtime (`packages/policy-engine/src/local-embeddings.ts:284` — raw `fetch().json()` to a remote embeddings endpoint). Structural gap: the checker `scripts/check-bounded-response-reads.mjs` only scans `apps/gateway/src/services/` and is blind to `packages/policy-engine`, which has its own parallel bounding mechanism (`fetchAllowlisted` proxy in `sandbox/network-guard.ts`, 2 MiB / 15 s defaults).
- **Replay:** the durable `external_side_effect.replay` workflow is **inert in production** — no integration implements `buildExternalSideEffectReplayJob` (`gateway-service.ts:1863` omits it), so every replay skips `job_unavailable`. A second Gmail send path (`comms-service.ts:355` → policy-engine `gmailSend`) bypasses the ledger while `integration-action-service.ts:636` uses it. Ledger test gaps: `payload_mismatch`, `in_progress`. Channel session/reply-target resolution (`telegram-channel-sessions.ts`, `channel-inbound-dispatch.ts:520`) has no dedicated tests.
- **MCP:** implementation has bounds/handling for child streams, crash, HTTP caps; test gaps are: spawn failure (ENOENT), child crash mid-invoke, cancel-on-crash, stdout line overflow, stderr bounded diagnostics, HTTP body read deadline, coordinator server-level quarantine gate.
- **Memory batch:** service rollback/ConflictError tests exist but run against a **mock that fakes rollback** (`createMemoryItemBatchHarness` snapshots/restores JS Maps). Postgres storage client has no `runImmediateTransaction` (fail-closed → ConflictError — correct, already tested). No batch UI exists at all; the endpoint is API-only.

User-approved scope: tests + fix Gmail path; wire ONE replay integration (Activepieces); include minimal batch UI; all four items phased.

## Global Constraints

- **Do NOT touch or stage these 6 dirty working-tree files** (owned by a concurrent session's migration fix): `packages/storage/src/cron-job-repo.ts`, `cron-job-repo.test.ts`, `postgres-client.test.ts`, `postgres-migrator.test.ts`, `postgres/client.ts`, `postgres/migrator.ts`. Always `git add <explicit paths>` — never `-A`.
- One branch per phase off `main`: `hardening/bounded-reads`, `hardening/side-effect-replay`, `hardening/mcp-stream-regressions`, `hardening/memory-batch-proof`. Commit per task, push early (`gh auth git-credential` helper is configured). Re-check `git rev-parse HEAD` before each commit (concurrent-session hazard).
- **Never run vitest and tsc concurrently** (phantom failures). Run vitest with `--maxWorkers=2`. `vitest -t` filters test NAMES — non-matching tests silently skip and look green; prefer file-path filtering.
- Commit format: `<type>: <description>` (feat/fix/test/refactor/docs). No attribution footer.
- Feature flags require FOUR plumbing sites: `apps/gateway/src/config.ts` interface + env map + defaults, PLUS the flag roundtrip/parsing test (config.ts alone is inert).
- Immutability, small files (<800 lines), explicit error handling per user's global rules.
- Existing tests must stay green byte-for-byte through refactor tasks (Task 6 especially).

---

# Phase 1 — Bounded External Read Audit (branch `hardening/bounded-reads`)

### Task 1: Bounded JSON helper in policy-engine + fix local-embeddings gap

**Files:**
- Modify: `packages/policy-engine/src/sandbox/network-guard.ts` (export `FetchBodyReadLimits` ~line 158; add `readBoundedResponseJson` next to `wrapBoundedFetchResponse` ~line 518)
- Modify: `packages/policy-engine/src/local-embeddings.ts` (fetch ~272, `.json()` ~284)
- Test: `packages/policy-engine/src/local-embeddings.test.ts`

**Interfaces:**
- Produces: `export interface FetchBodyReadLimits { timeoutMs: number; maxBytes: number }` and `export async function readBoundedResponseJson(response: Response, limits: FetchBodyReadLimits): Promise<unknown>` — public package API via `index.ts`'s `export * from "./sandbox/network-guard.js"`. Task 2's checker references this as the sanctioned policy-engine read path.

- [ ] **Step 1: Fix the test mocks so they carry real bodies** — in `local-embeddings.test.ts`, change `jsonResponse()` (~line 128) to return `new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })` and the 503 mock (~line 204) to `new Response("{}", { status: 503 })`. (The bounded reader consumes `response.body`; plain-object mocks have none — success tests would silently exercise the pseudo-fallback path.)

- [ ] **Step 2: Write the failing byte-cap test** in `local-embeddings.test.ts`:

```ts
it("falls back to pseudo when the embeddings response exceeds the byte cap", async () => {
  stubFetch(() => new Response('{"padding":"' + "x".repeat(3 * 1024 * 1024) + '"}', { status: 200 }));
  const result = await generateEmbedding("hello", providerConfig());
  expect(result.metadata.provider).toBe("pseudo");
  expect(result.metadata.fallbackReason).toContain("response body exceeded");
});
```

(Adapt `stubFetch`/`providerConfig` names to the file's existing fixtures — read the file first; it stubs global fetch and builds config from env.)

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @goatcitadel/policy-engine exec vitest run src/local-embeddings.test.ts --maxWorkers=2`. Expected: new test FAILS (no cap yet); pre-existing tests PASS (Step 1 mocks are drop-in).

- [ ] **Step 4: Implement** — in `network-guard.ts`, add `export` to `FetchBodyReadLimits` and:

```ts
export async function readBoundedResponseJson(
  response: Response,
  limits: FetchBodyReadLimits,
): Promise<unknown> {
  const buffer = await readBoundedResponseArrayBuffer(response, limits);
  return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
}
```

In `local-embeddings.ts`: import it, add constant near the timeout constants (~line 54):

```ts
// A single-input embedding response is one vector (even 8192 dims ≈ ~200 KB of
// JSON floats). 2 MiB matches DEFAULT_FETCH_MAX_RESPONSE_BYTES with >10x headroom.
const MAX_EMBEDDINGS_RESPONSE_BYTES = 2 * 1024 * 1024;
```

Replace `return (await response.json()) as unknown;` (~284) with:

```ts
return await readBoundedResponseJson(response, {
  maxBytes: MAX_EMBEDDINGS_RESPONSE_BYTES,
  timeoutMs: config.timeoutMs,
});
```

Do NOT use `fetchAllowlisted` here — it blocks loopback/private hosts, and embeddings endpoints are typically `http://127.0.0.1` llama.cpp/Ollama (operator-configured trusted infra; the missing control is only the byte cap).

- [ ] **Step 5: Run to verify pass** — same command. Expected: ALL PASS. Also run `packages/policy-engine` full suite: `pnpm --filter @goatcitadel/policy-engine test -- --maxWorkers=2` (confirm `fetch-allowlisted.security.test.ts` untouched-green).

- [ ] **Step 6: Commit** — `fix(policy-engine): bound remote embeddings response reads`

### Task 2: Extend the bounded-read checker to policy-engine

**Files:**
- Modify: `scripts/check-bounded-response-reads.mjs`
- Test: `scripts/check-bounded-response-reads.test.mjs`

**Interfaces:**
- Consumes: Task 1 removed the only raw read token from `local-embeddings.ts` (it now needs no exemption).
- Produces: `boundedByConstructionFiles` export + bare-fetch invariant; scan roots now include `packages/policy-engine/src`.

- [ ] **Step 1: Write failing checker tests** — add to `check-bounded-response-reads.test.mjs` (same synthetic-source pattern as the existing 4 tests: feed `(relativePath, source)` into exported `collectRawResponseReadViolations`):
  1. raw `.json()` in `packages/policy-engine/src/some-module.ts` → 1 violation
  2. `packages/policy-engine/src/tool-executor.ts` with `const res = await fetchAllowlisted(u); await res.response.text(); await response.json();` → `[]` (bounded-by-construction; also proves `fetchAllowlisted(` isn't misread as bare fetch)
  3. same file containing `await fetch(url)` → exactly 1 violation, `method === "fetch"`
  4. bounded-by-construction does NOT exempt unwrapped methods: `res.body.getReader()` and `await response.blob()` in `tool-executor.ts` → both flagged
  5. bare `fetch(` inside a comment/string in a bounded file → not flagged (masking coverage)
  6. `packages/policy-engine/src/sandbox/network-guard.ts`: `response.body.getReader()` → `[]`; `await response.json()` → flagged

- [ ] **Step 2: Run to verify fail** — `node --test scripts/check-bounded-response-reads.test.mjs`. Expected: new tests FAIL.

- [ ] **Step 3: Implement** the checker changes:

```js
const scanRoots = [
  path.join(repoRoot, "apps", "gateway", "src", "services"),
  path.join(repoRoot, "packages", "policy-engine", "src"),
];

// add to approvedRawResponseReads (policy-engine's own bounded reader —
// the analogue of bounded-response-reader.ts):
"packages/policy-engine/src/sandbox/network-guard.ts": new Set(["body.getReader"]),

// Files whose every Response comes from fetchAllowlisted/fetchAllowlistedOnce,
// whose Proxy bounds .text()/.json()/.arrayBuffer(). Enforced invariant: these
// files must not contain a bare `fetch(` call. The wrapper does NOT bound
// .blob()/.formData()/.body.getReader() — those stay flagged even here.
export const boundedByConstructionFiles = new Set([
  "packages/policy-engine/src/tool-executor.ts",
  "packages/policy-engine/src/browser-tools.ts",
  "packages/policy-engine/src/ingestion-backends.ts",
]);
const BOUNDED_BY_CONSTRUCTION_METHODS = new Set(["text", "json", "arrayBuffer"]);
// Matches `fetch(` / `globalThis.fetch(`; does NOT match `fetchAllowlisted(`.
const bareFetchPattern = /\bfetch\s*\(/g;
```

In `collectRawResponseReadViolations(relativePath, source, allowedReads = approvedRawResponseReads, boundedFiles = boundedByConstructionFiles)`: if the file is in `boundedFiles`, scan the **masked** source for `bareFetchPattern` and emit one violation per bare fetch; treat `BOUNDED_BY_CONSTRUCTION_METHODS` as exempt for that file; all other methods flagged as before. `main()` iterates `scanRoots` through the existing recursive `.ts`/`!*.test.ts` collector. Update the failure banner: raw reads must use bounded-response-reader helpers (gateway) or fetchAllowlisted/readBoundedResponseJson (policy-engine); if every response in a file comes from fetchAllowlisted, add it to `boundedByConstructionFiles`.

- [ ] **Step 4: Run to verify pass against fixtures AND the real tree** — `pnpm check:bounded-response-reads`. Expected: tests pass, then the real-tree scan passes (Task 1 already removed the only genuine violation; if the scan flags anything unexpected, that's a real finding — fix or exempt it deliberately, don't silence).

- [ ] **Step 5: Run `pnpm docs:check`** — the checker is embedded there; expected PASS.

- [ ] **Step 6: Commit + PR** — `feat(scripts): extend bounded-response-read checker to policy-engine`. Open PR 1.

**Out of scope (decided):** `scripts/` CI/release tooling external reads (trusted contexts, failure = failed job, not gateway DoS); loopback-only readers (doctor/tui/launcher).

---

# Phase 2 — External Side-Effect Replay Matrix (branch `hardening/side-effect-replay`)

### Task 3: Close ledger test gaps — `payload_mismatch` and `in_progress`

**Files:**
- Test: `apps/gateway/src/services/external-side-effect-runner-service.test.ts` (17 existing tests; reuse its in-memory mutation-store/run-store fixtures, see ~line 831)
- Test: `packages/storage/src/external-side-effect-run-repo.test.ts` (3 existing tests) — **new test file additions only; do not touch the 6 dirty storage files**

**Interfaces:**
- Consumes: `runIdempotentExternalSideEffect`, `claimIdempotentExternalSideEffect` (runner :313), mutation store `claim()` returning `payload_mismatch` / `in_progress` states.

- [ ] **Step 1: Write failing/absent tests** (they document behavior that exists but is unproven):
  1. runner: "blocks execution and records payload_mismatch when the same identity is claimed with a different payload hash" — claim once with payload A (complete it or leave in claimed state per mutation-store semantics), invoke again with same explicit `idempotencyKey` + payload B → assert `status: "blocked"`, run row `payload_mismatch`, `execute` never called the second time.
  2. runner: "blocks without sending when an idempotent claim is already in progress" — first invocation parked mid-execute (unresolved promise), second identical invocation → `blocked`, mutation claim `in_progress`, second `execute` not called. Resolve the first afterward.
  3. repo: "records payload_mismatch runs with non-resumable resume state" — `createOrGet` with `status: "payload_mismatch"` → assert `resumeState` and `reversibility` derived per `resumeStateForStatus`/`deriveExternalSideEffectRunReversibility` (read those at repo :336-391 for exact expected values before writing assertions).

- [ ] **Step 2: Run** — `pnpm --filter @goatcitadel/gateway exec vitest run src/services/external-side-effect-runner-service.test.ts --maxWorkers=2` and `pnpm --filter @goatcitadel/storage exec vitest run src/external-side-effect-run-repo.test.ts --maxWorkers=2`. If any assertion contradicts actual behavior, the code wins ONLY after verifying against the contract semantics (fail-closed, no double-send) — otherwise it's a real bug: stop and report.

- [ ] **Step 3: Commit** — `test(gateway): prove payload-mismatch and in-progress side-effect claim blocking`

### Task 4: Channel recipient/session identity tests

**Files:**
- Create: `apps/gateway/src/services/telegram-channel-sessions.test.ts` (source `telegram-channel-sessions.ts` has NO test file today)
- Modify: `apps/gateway/src/services/channel-inbound-dispatch.test.ts` (covers only sender-allowlist today, lines 55-236)

- [ ] **Step 1: Read `telegram-channel-sessions.ts` fully**, then write tests:
  1. "resolves a stable session id for the same account/peer/room/thread tuple" — same inputs twice → identical `sessionId`.
  2. "resolves distinct session ids across different peers and threads" — vary `peer`, `room`, `threadId` → distinct ids (reply-target isolation).
  3. "applies session rotation without leaking the prior session id" — exercise `applyTelegramChannelSessionRotation` per its actual signature.

- [ ] **Step 2: Add reply-target stability tests** to `channel-inbound-dispatch.test.ts` targeting the resolution at :520 (`target = options.bindingTarget ?? message.room ?? message.peer ?? message.account`):
  1. "routes replies to the explicit binding target when provided"
  2. "falls back to room, then peer, then account for the reply target"
  3. "keeps the reply target stable when session rotation occurs mid-dispatch" (if harness supports it — read existing harness first; drop this case if dispatch has no rotation seam and note why in the test file)

- [ ] **Step 3: Run both files, verify green, commit** — `test(gateway): pin channel session identity and reply-target resolution`

### Task 5: Ledger the comms-service Gmail send path

**Files:**
- Modify: `packages/contracts/src/comms.ts` (`GmailSendInput` ~line 183: add `idempotencyKey?: string`)
- Modify: `apps/gateway/src/routes/comms.ts` (~line 311: add `idempotencyKey` to the gmail send zod body schema)
- Modify: `apps/gateway/src/services/comms-service.ts` (`CommsHost` :24-45, `commsGmailSend` :355-378)
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts` (`createCommsHostForGateway` :322-336)
- Test: `apps/gateway/src/services/comms-service.test.ts` (6 existing tests — none touch gmail, none need changes)

**Interfaces:**
- Consumes: `runIdempotentExternalSideEffect` + `buildExternalSideEffectReplayOutput` from `external-side-effect-runner-service.ts`; `MutationIdempotencyStore`; `ExternalSideEffectRunStore`; `classifyChannelDeliveryFailure` semantics (pre-boundary = `blocked`/`not_available`; post-boundary = everything else).
- Produces: new boundary string `"comms_gmail_send"`; `CommsHost.mutationStore?/sideEffectRunStore?` optional members. **Design decision (evaluated, do not delegate):** wrap the existing `invokeCommsTool` call in the runner rather than delegating to `integration-action-service` — delegation would bypass policy-engine governance (tool grants/approvals/network allowlist) and stop writing `commsDeliveries` dashboard records.

- [ ] **Step 1: Write failing tests** — new `describe("comms gmail send external side-effect ledger")` in `comms-service.test.ts`, with an in-memory mutation store + run store host fixture (mirror the runner test fixtures):
  1. "claims idempotency and records a completed run for a successful send" — asserts claim on boundary `comms_gmail_send`, run row `completed`, no raw body persisted, replay-output fields present on the returned record
  2. "blocks a duplicate identical send without invoking the tool" — second identical call → blocked `duplicate`; `invokeAndUnwrap` called exactly once
  3. "records policy refusals as failed before the boundary" — `invokeAndUnwrap` resolves `{ outcome: "blocked", ... }` → run `failed_before_boundary`, mutation reopened, original ToolInvokeResult returned unchanged
  4. "records not_available delivery failures as failed before the boundary"
  5. "records degraded delivery failures as unknown external outcome" — `status:"failed"`, `deliveryStatus:"degraded"` → boundary marked, run `unknown_external_outcome`
  6. "blocks with idempotency_unavailable when the host has no mutation store" — tool never invoked
  7. "honors a caller-supplied idempotency key" — distinct keys ⇒ both sends execute

- [ ] **Step 2: Run to verify fail** — the gmail describe block fails (no ledger wiring yet).

- [ ] **Step 3: Implement.** Extend `CommsHost`:

```ts
mutationStore?: MutationIdempotencyStore;
sideEffectRunStore?: ExternalSideEffectRunStore;
```

Rewrite `commsGmailSend` (signature unchanged: `(host, input) => Promise<ToolInvokeResult | Record<string, unknown>>`):
- Resolve connection via `host.getIntegrationConnection(input.connectionId)` in try/catch (fallback `catalogId: "automation.gmail"` — preserves today's fail-inside-executor behavior for unknown ids).
- Call `runIdempotentExternalSideEffect` with: `boundary: "comms_gmail_send"`, `catalogId: connection?.catalogId ?? "automation.gmail"`, `connectionId: input.connectionId`, `actionId: "gmail.send"`, `idempotencyKey: input.idempotencyKey`, `payload: { provider: "gmail", connectionId, to, cc, bcc, subject, bodyText, bodyHtml }`, `label: "Gmail send (comms)"`, `mutationStore: host.mutationStore`, `sideEffectRunStore: host.sideEffectRunStore`.
- Inside `execute(claim)`: call the existing `invokeCommsTool(...)`, then classify (pattern precedent: `DryRunCommitInnerResultError` in `integration-dry-run-gate.ts:52`):
  - `ToolInvokeResult` with `outcome !== "executed"` → throw `CommsGmailPreBoundaryResultError(result)` WITHOUT marking the boundary (→ `failed_before_boundary`)
  - unwrapped record, `status === "failed"` + `deliveryStatus ∈ {blocked, not_available}` → same pre-boundary error carrier
  - unwrapped record, `status === "failed"` + any other deliveryStatus → `claim.markExternalCallStarted()` then throw carrier (→ `unknown_external_outcome`)
  - `status === "sent"` → `claim.markExternalCallStarted()` and return the record (→ `completed`)
- After the runner: unwrap `CommsGmailPreBoundaryResultError` back to the original result (byte-compatible facade for refusals/failures); for runner `blocked` return `{ status: "failed", deliveryStatus: "blocked", error: run.message, ...buildExternalSideEffectReplayOutput(run.claim) }`; for executed return `run.value` augmented with the replay-output fields.
- No feature flag — same pattern shipped un-flagged for the four integration paths, and `docs/1_0_CONTRACT.md:56` already claims Gmail sends claim idempotency; a default-off flag would make that sentence false.

Wire production in `createCommsHostForGateway` (:322):

```ts
mutationStore: gateway.mutationIdempotencyStore,
sideEffectRunStore: gateway.storage.externalSideEffectRuns,
```

Add `idempotencyKey?: string` to `GmailSendInput` in contracts and to the route zod schema.

- [ ] **Step 4: Run** — comms-service tests + `routes/comms.test.ts` + `gateway-service.loop13-facade.test.ts` (mock-based callers, should be unaffected) + contracts build (`pnpm --filter @goatcitadel/contracts build`). Expected: ALL PASS.

- [ ] **Step 5: Commit** — `feat(gateway): ledger the comms gmail send path with idempotent side-effect claims`

**Known residual (document in PR body, do not fix here):** agents invoking the `gmail.send` tool directly via the tool-invocation coordinator bypass `commsGmailSend` — ledgering that means moving the runner below `invokeTool` across the policy-engine package boundary; out of scope.

### Task 6: Extract Activepieces run-input builder (pure refactor)

**Files:**
- Modify: `apps/gateway/src/services/integration-action-service.ts` (`invokeActivepiecesAction` :355-398)
- Test: `apps/gateway/src/services/integration-action-service.test.ts` (must stay green with ZERO scenario changes)

**Interfaces:**
- Produces (Task 7 consumes):

```ts
export interface ActivepiecesTriggerWebhookJobParts {
  input: IdempotentExternalSideEffectRunInput<{ message?: string; output?: Record<string, unknown> | unknown[] | string }>;
  target: string; // webhook URL for WardGateRunOptions.externalDestination
}
export function buildActivepiecesTriggerWebhookRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: { checkedAt: string; flowId?: string; payload: Record<string, unknown>; idempotencyKey?: string; actorScope?: string },
): ActivepiecesTriggerWebhookJobParts | { blockedReason: "activepieces_webhook_missing"; message: string }
```

- [ ] **Step 1: Extract** — move webhookUrl resolution (`parseHttpUrl`), `resolveBearerAuth`, and the runner-input construction `{ boundary: "integration_operator_action", catalogId, connectionId, actionId: "trigger_webhook", payload: { provider: "activepieces", flowId, payload }, label, execute }` (fetch + `parseResponse` body currently at :378-398) into the new exported function. `invokeActivepiecesAction` becomes a thin caller passing the parts into `runWardGatedExternalSideEffect`.
- [ ] **Step 2: Run the full integration-action test file** — every existing Activepieces assertion green, no snapshot/behavior drift.
- [ ] **Step 3: Commit** — `refactor(gateway): extract activepieces trigger-webhook run input builder`

### Task 7: Production replay job for Activepieces + kill switch

**Files:**
- Create: `apps/gateway/src/services/external-side-effect-replay-job-service.ts`
- Create: `apps/gateway/src/services/external-side-effect-replay-job-service.test.ts`
- Modify: `apps/gateway/src/config.ts` (flag: interface ~:68, env map ~:719, defaults ~:1259) + the feature-flag roundtrip/parsing test (locate it — grep config tests for an existing `*V1Disabled` flag name; FOUR plumbing sites total)
- Modify: `apps/gateway/src/services/gateway-service.ts` (`externalSideEffectReplay` host block :1863-1872)
- Test: extend `apps/gateway/src/services/durable-execution-service.test.ts` (alongside :279 and :400 replay tests)

**Interfaces:**
- Consumes: Task 6's `buildActivepiecesTriggerWebhookRunInput`; `DurableExternalSideEffectReplayWorkflowHost.buildExternalSideEffectReplayJob?(run, payload)` (durable-execution-service.ts :246, invoked :859); `readReplayJobIdentityMismatch` (runner :588-602) enforcing idempotencyKey/boundary/catalogId/connectionId/actionId preservation; ledger rows persist NO raw payload (only `payloadHash` + identity fields), so reconstruction re-derives from live connection config and the hash enforces byte-identity (`payload_mismatch` on drift — mutation-idempotency-repo checks mismatch before failed-record revive).
- Produces:

```ts
export const EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST = [
  { boundary: "integration_operator_action", catalogId: "automation.activepieces", actionId: "trigger_webhook" },
] as const;
export function buildGatewayExternalSideEffectReplayJob(
  host: IntegrationActionHost,
  run: ExternalSideEffectRunRecord,
  payload: ExternalSideEffectReplayWorkflowPayload,
): IdempotentExternalSideEffectRunInput<Record<string, unknown>> | undefined
```

- Kill switch: `externalSideEffectReplayJobsV1Disabled` (repo convention — feature ON by default, matching `autonomyV1Disabled`/`subagentFanoutV1Disabled`; env `GOATCITADEL_FEATURE_EXTERNAL_SIDE_EFFECT_REPLAY_JOBS_V1_DISABLED`). When disabled → hook returns `undefined` → `job_unavailable`, byte-identical to today.

- [ ] **Step 1: Write failing tests** (`external-side-effect-replay-job-service.test.ts`):
  1. "builds an identity-preserving replay job for an allowlisted failed-before-boundary activepieces run" — assert `readReplayJobIdentityMismatch(run, job)` returns undefined; `idempotencyKey`/`actorScope`/`workspaceId` pinned from the run row
  2. "replays end-to-end through the replay-safe worker" — in-memory stores (reuse runner test fixtures :831): worker result `executed`, original run row → `completed`, webhook fetch body carries `{ source: "goatcitadel", flowId, payload: {} }`
  3. "returns undefined for non-allowlisted runs" — gmail `write`, trello `write`, local-bridge boundary → worker skip `job_unavailable`
  4. "refuses payload drift at claim time" — connection `defaultFlowId` changed since original claim → worker `blocked`, `blockedReason: "external_side_effect_payload_mismatch"`, original run row not corrupted
  5. "returns undefined when ward denies or requires dry-run at replay time" (fail-closed: runner only enforces `require_dry_run`, so `deny` must be caught in the builder)
  6. "returns undefined for missing connection or missing webhook url"
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement the builder** — logic, each miss returning `undefined`:
  1. allowlist tuple check (exact equality on `run.boundary`/`run.catalogId`/`run.actionId`)
  2. `host.storage.integrationConnections.get(run.connectionId)` — missing / catalogId drift → undefined
  3. ward re-check via `resolveWardEffectForExternalAction(...)` — any non-allow effect → undefined
  4. rebuild from live config only: `flowId = defaultFlowId` from connection config, `payload = {}`, via `buildActivepiecesTriggerWebhookRunInput`
  5. return `{ ...parts.input, checkedAt: new Date().toISOString(), idempotencyKey: run.idempotencyKey, actorScope: run.actorScope, workspaceId: run.workspaceId, mutationStore: host.mutationStore, sideEffectRunStore: host.sideEffectRunStore }`
- [ ] **Step 4: Plumb the flag (all FOUR sites) and wire the hook** in gateway-service.ts:

```ts
buildExternalSideEffectReplayJob: (run, payload) =>
  this.isFeatureEnabled("externalSideEffectReplayJobsV1Disabled")
    ? undefined
    : buildGatewayExternalSideEffectReplayJob(
        buildIntegrationActionHostForGateway(this.getRouteCompositionPort()), run, payload),
```

(`buildIntegrationActionHostForGateway` at `gateway-route-composition-integrations.ts:349` already carries every needed dep. Adapt the exact `isFeatureEnabled` accessor name to what gateway-service actually uses — grep an existing kill-switch call site.)
- [ ] **Step 5: Extend durable-execution-service.test.ts** — workflow run with production-shaped builder → checkpoint `executed:1`; kill switch on (hook returns undefined) → all `skipped/job_unavailable`.
- [ ] **Step 6: Run** — new test file + durable-execution + integration-action + config flag roundtrip test. All green.
- [ ] **Step 7: Commit** — `feat(gateway): wire production activepieces replay job behind kill switch`

### Task 8: Contract doc update

**Files:**
- Modify: `docs/1_0_CONTRACT.md` (line 56 region)

- [ ] **Step 1:** Append to the durable-execution claim sentence: production supplies an allowlisted Activepieces `trigger_webhook` replay job (kill switch `externalSideEffectReplayJobsV1Disabled`); replay re-derives the safe payload from live connection config and refuses on payload-hash drift; only config-default triggers are reconstructable. Also note the comms Gmail path now claims idempotency on boundary `comms_gmail_send`. **CAUTION:** `scripts/validate-governance-docs.mjs` asserts VERBATIM phrases from governance docs — run `pnpm docs:check` after editing; if a guarded phrase breaks, adjust the validator expectations deliberately in the same commit, never copyedit guarded text.
- [ ] **Step 2:** `pnpm docs:check` green. Commit — `docs: record activepieces replay job and comms gmail ledger claims`. Open PR 2.

---

# Phase 3 — MCP Stream/Crash Regression Pack (branch `hardening/mcp-stream-regressions`, tests only)

### Task 9: Child crash / spawn-failure / cancel-on-crash tests

**Files:**
- Test: `apps/gateway/src/services/mcp-runtime.test.ts` (Pattern 1: real Node child via inline `MCP_TEST_SCRIPT` + `process.execPath`, see file header :1-130)
- Test: `apps/gateway/src/services/mcp-runtime.lifecycle.test.ts` (Pattern 2: `vi.mock("node:child_process")` + `FakeStdin`/`createFakeChild` EventEmitter fakes, :1-137)

**Interfaces:** Consumes existing harness fixtures only — no production code changes expected. If a test exposes a real defect, stop and report before "fixing the test".

- [ ] **Step 1 (Pattern 1): crash mid-invoke** — script variant that reads the `tools/call` request then `process.exit(3)` without responding. Assert `invokeMcpRuntimeTool` rejects with message containing `exited before responding` and `code=3`; wrap the test with a `process.on("unhandledRejection")` tracker asserting zero unhandled rejections (covers the shutdown-rejection class).
- [ ] **Step 2 (Pattern 1): spawn failure** — config command `"definitely-not-a-real-binary-goatcitadel-test"` → structured rejection (ENOENT surfaced via `child.on("error")` → `rejectAll`), not a hang. Use a short timeout.
- [ ] **Step 3 (Pattern 2): cancel-on-crash** — `spawnMock.mockReturnValue(fakeChild)`; start an invoke; `fakeChild` emits `close` with `code=1, signal=null` while pending → assert the pending promise rejects with `exited before responding` AND the bounded stderr content (pre-feed `stderr` emitter with a known string) appears in the message; assert kill/terminate path invoked via `createFakeKiller`.
- [ ] **Step 4:** Run both files (`--maxWorkers=2`), green. Commit — `test(gateway): cover MCP child crash, spawn failure, and cancel-on-crash`

### Task 10: Stream bounds + HTTP deadline + coordinator quarantine gate

**Files:**
- Test: `apps/gateway/src/services/mcp-runtime.test.ts` (Pattern 1 + `withRemoteMcpHttpServer` helper :65)
- Test: `apps/gateway/src/services/tool-invocation-coordinator-service.test.ts`

- [ ] **Step 1: stdout line overflow** — script emits one garbage line > `MCP_STDOUT_LINE_MAX_BYTES` (512 KiB, constant at mcp-runtime.ts:521) then the valid JSON-RPC response line. Assert the invoke still SUCCEEDS (oversized line discarded, parser not corrupted).
- [ ] **Step 2: stderr bounded diagnostics** — script writes ~20 KiB to stderr then exits without responding. Assert rejection message includes stderr content truncated to ≤ `MCP_STDERR_MAX_BYTES` (4096, :519) — assert on a marker present within the first 4 KiB and absence of a marker placed after it.
- [ ] **Step 3: HTTP body read deadline** — `withRemoteMcpHttpServer` variant that writes headers + a partial JSON body then stalls (never ends). Drive through the runtime's existing timeout options if reachable; if the body deadline isn't reachable via public options, test the `__internal` `readBodyChunkWithDeadline`/`readHttpJsonRpcEnvelope` directly (lifecycle-test style) with a small `timeoutMs`. Assert the typed body-timeout error, not a generic hang.
- [ ] **Step 4: coordinator server-level quarantine gate** — in `tool-invocation-coordinator-service.test.ts`, following the existing "blocks MCP first-use execution before runtime invocation" (:582) fixture pattern: server record with `trustTier: "quarantined"` → invoke blocked at `resolveMcpRuntimeTarget` (:895) BEFORE runtime invocation; runtime invoke spy not called; fail-closed error shape asserted.
- [ ] **Step 5:** Run all touched files green; run the full gateway mcp-related set: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/mcp-runtime.test.ts src/services/mcp-runtime.lifecycle.test.ts src/services/tool-invocation-coordinator-service.test.ts src/routes/mcp.test.ts --maxWorkers=2`. Commit — `test(gateway): cover MCP stream bounds, HTTP read deadline, and quarantine gate`. Open PR 3.

---

# Phase 4 — Memory Batch Transaction Proof + Minimal Batch UI (branch `hardening/memory-batch-proof`)

### Task 11: Real-storage transaction proof (strict pg-dialect double)

**Files:**
- Create: `apps/gateway/src/services/testing/postgres-dialect-strict-db.ts` (extract `createPostgresDialectStrictDb` from `improvement-service.postgres-dialect.test.ts:33-68`)
- Modify: `apps/gateway/src/services/improvement-service.postgres-dialect.test.ts` (import the extracted helper; zero scenario changes)
- Create: `apps/gateway/src/services/memory-lifecycle-service.postgres-dialect.test.ts`

**Interfaces:**
- Consumes: `batchMutateMemoryItems` (memory-lifecycle-service.ts:1171); `requireMemoryBatchTransaction` guard (:2927); `GatewaySqlRepository.runImmediateTransaction` (packages/storage/src/gateway-sql-repo.ts:14) delegating to synchronous `DatabaseClient.transaction("immediate", cb)`.
- The strict double wraps a REAL migrated sqlite; its `exec()` throws on raw `BEGIN/COMMIT/ROLLBACK/...` (pg-driver simulation), `prepare` is lazy, `transaction(mode, cb)` delegates to inner sqlite. Existing ConflictError-guard and mock-rollback tests in `memory-lifecycle-service.test.ts` (:462/:546/:575/:596) stay untouched.

- [ ] **Step 1: Extract the helper** — move `createPostgresDialectStrictDb(rootDir)` verbatim into the new testing module; update the improvement test import; run `improvement-service.postgres-dialect.test.ts` green (gotcha: watch for prototype-driven tests of moved privates — export exactly what the original test consumed).
- [ ] **Step 2: Write the new proof tests** in `memory-lifecycle-service.postgres-dialect.test.ts`, driving the REAL service over a real `GatewaySqlRepository` on the strict double (seed 2-3 memory items via the service's own write paths or direct prepared inserts matching the migrated schema):
  1. "completes an atomic memory batch mutation through runImmediateTransaction without raw transaction SQL" — batch of `patch_item` + `forget_item` succeeds; strict `exec` never saw `BEGIN` (would have thrown); rows verified changed via the inner sqlite.
  2. "rolls back every batch mutation on a real transactional failure" — wrap the double's `prepare` to throw on the 2nd `UPDATE memory_items` execution (interception hook on the facade, real sqlite beneath); assert ALL rows byte-unchanged and no `memory_change_history` rows written — a REAL immediate-transaction rollback, not the mock-harness snapshot.
- [ ] **Step 3: Run** — new file + existing `memory-lifecycle-service.test.ts` green. Commit — `test(gateway): prove memory batch atomicity on real transactional storage`

### Task 12: Batch client API + hook callbacks

**Files:**
- Modify: `packages/mission-control-shared/src/api/memory.ts` (add `batchMutateMemoryItems`)
- Modify: `packages/mission-control-shared/src/api/client.ts` (re-export, alphabetical in the memory block ~:677-722)
- Modify: `packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts` (callbacks; return them ~:655)
- Test: `packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.test.tsx` (add `batchMutateMemoryItems: vi.fn()` to BOTH the hoisted `apiMocks` object and the mock factory, :5-63)

**Interfaces:**
- Consumes: existing contracts `MemoryBatchMutationRequest/Operation/Response` (`packages/contracts/src/memory.ts:637-701` — no contract changes needed); route `POST /api/v1/memory/items/batch-mutate` (1..100 ops, per-op `patch_item`/`forget_item`); each response `results[].item` is the updated `MemoryItemRecord`.
- Produces (Task 13 consumes): `memory.batchForgetItems(itemIds: string[]) => Promise<MemoryBatchMutationResponse | undefined>` (undefined = failed; notice already set) and `memory.batchSetItemsPinned(itemIds: string[], pinned: boolean)`; busy keys `memory-batch:forget` / `memory-batch:pin:{bool}`.

- [ ] **Step 1: Write failing hook tests** (react-test-renderer harness per existing file conventions):
  1. "submits an atomic batch forget and applies returned items" — API called once with `{ source: "mission-control:library", operations: [{kind:"forget_item", itemId:"mem-1"}, ...] }`; `memoryItems` updated from `results[].item`; success notice contains "Forgot 2"
  2. "reports rollback truthfully when the batch fails" — mock rejects → error notice contains "no changes were applied"; `memoryItems` deep-equal unchanged
  3. "surfaces the transactional-storage conflict message" — reject with the 409 body text → verbatim in notice after the rollback prefix
  4. "locks batch mutations when memory admin is not enabled" — warning notice, API NOT called (mirror existing "Locked" test ~:746)
  5. "refuses batches over 100 operations client-side" — error notice, API not called
  6. "submits patch_item pin operations" — `batchSetItemsPinned(ids, true)` → ops `{kind:"patch_item", itemId, patch:{pinned:true}}`; pinned flags updated
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — API method:

```ts
export async function batchMutateMemoryItems(
  input: MemoryBatchMutationRequest,
): Promise<MemoryBatchMutationResponse> {
  return request<MemoryBatchMutationResponse>("/api/v1/memory/items/batch-mutate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
```

Hook: one private `runBatchMutation(busyKey, operations, successMessage)` mirroring `saveItemPatch` conventions exactly (admin gate → warning notice; `>100` → error notice without calling API — mirrors server schema so oversized batches fail fast, never chunked; busyKey set; on success map `results` by `itemId` and immutably replace matching `memoryItems`, success notice from server `appliedCount`; on catch: `` `Batch failed — no changes were applied. ${getErrorMessage(err)}` ``; finally clear busy). Public `batchForgetItems` / `batchSetItemsPinned` wrap it. Return the response on success, undefined on failure.
- [ ] **Step 4: Run hook tests + full mission-control-shared suite green.** Commit — `feat(mission-control-shared): add atomic memory batch mutation client and hook verbs`

### Task 13: Batch toolbar + Library page wiring

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/library/MemoryBatchToolbar.tsx` (~50 lines; page is 1798 lines with a max-lines eslint-disable — do NOT grow it more than ~45 lines, extract the toolbar)
- Modify: `apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx` (selection state ~:129; list block ~:500-581; toolbar + ConfirmModal mount)
- Modify: the native-routes CSS file that carries `mc-next-*` classes (add `.mc-next-memory-batch-row` flex row)
- Create: `apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.batchSelection.test.tsx` (follows the `.namespaceFilter.test.tsx` split precedent; hook fully mocked via `vi.mock` of `useMemoryOperatorSnapshot`)

**Interfaces:**
- Consumes: Task 12's `memory.batchForgetItems`/`memory.batchSetItemsPinned`/`memory.busyKey`/`memory.notice`; existing `ConfirmModal`, `NativeButton`, `NoticeBanner` (result surfacing needs NO new UI — the hook notice renders via the existing banner at ~:405).
- A11y decision (verified no test/CSS depends on it): the items container drops `role="listbox"`/`aria-activedescendant` for `role="group" aria-label="Memory items"`; row buttons drop `role="option"`/`aria-selected` (keep `aria-pressed`/`aria-current`). A checkbox inside a listbox violates the content model. Flag this swap in the PR body for a11y review (page carries H-8 audit annotations).

- [ ] **Step 1: Write failing page tests** (findByProps/onClick interaction per existing convention; `batchForgetItems: vi.fn().mockResolvedValue({ appliedCount: 2 })` in the mocked snapshot):
  1. "selects items and forgets them atomically through the confirm dialog" — check two row checkboxes (aria-label `Select memory item …`), toolbar shows "2 selected", Forget → ConfirmModal → onConfirm calls `batchForgetItems(["mem-1","mem-2"])`, selection clears
  2. "keeps the selection when the batch fails" — resolve `undefined` → selection retained (items unchanged; operator can retry)
  3. "clears selection without calling the API"
  4. "disables batch controls when memory admin is locked"
  5. "pins selected items" — `batchSetItemsPinned(ids, true)`
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** Page state:

```tsx
const [batchSelected, setBatchSelected] = useState<ReadonlySet<string>>(new Set());
const [pendingBatchForget, setPendingBatchForget] = useState(false);
const batchBusy = memory.busyKey?.startsWith("memory-batch:") ?? false;
// Prune ids that left the snapshot — a stale id 404s server-side and rejects the whole atomic batch.
const batchIds = useMemo(
  () => Array.from(batchSelected).filter((id) => memoryItems.some((item) => item.itemId === id)),
  [batchSelected, memoryItems],
);
```

Per-row: wrap each row in `<div className="mc-next-memory-batch-row">` with a sibling checkbox (`aria-label={`Select memory item ${item.title} for batch actions`}`, disabled when `!memoryCanMutate || batchBusy`) before the existing row button (Kanban toolbar precedent: `KanbanRoutePage.tsx:108-222`). Toolbar renders inside the Memory-items `NativeCard` when `batchIds.length > 0`:

```tsx
<div className="mc-next-runtime-actions" role="toolbar" aria-label="Memory batch actions">
  <span aria-live="polite">{count} selected</span>
  <NativeButton variant="destructive" disabled={!canMutate || busy} onClick={onForget}>Forget selected</NativeButton>
  <NativeButton variant="default" disabled={!canMutate || busy} onClick={() => onPin(true)}>Pin selected</NativeButton>
  <NativeButton variant="outline" disabled={!canMutate || busy} onClick={() => onPin(false)}>Unpin selected</NativeButton>
  <NativeButton variant="secondary" disabled={busy} onClick={onClear}>Clear selection</NativeButton>
</div>
```

Batch ConfirmModal beside the single-item one: title `Forget N memory item(s)?`, message states "applied atomically — either all are forgotten or none are", `danger`, pending gated on `memory.busyKey === "memory-batch:forget"`; onConfirm: `void memory.batchForgetItems(batchIds).then((r) => r && setBatchSelected(new Set()))`. Pin buttons same clear-on-success pattern. Selection kept on failure by construction (only cleared on truthy response).
- [ ] **Step 4: Run** — new page test file + existing `MemoryRoutePage.test.tsx` (must stay green through the role swap) + mission-control-next lint (exhaustive-deps is enforced). Visual sanity: `pnpm --filter @goatcitadel/mission-control-next dev` against a running gateway OR the VR stub mode if no gateway.
- [ ] **Step 5: Commit** — `feat(mission-control-next): atomic memory batch forget/pin with multi-select`. Open PR 4.

---

## Verification (end-to-end)

Per phase before its PR:
1. **Phase 1:** `pnpm check:bounded-response-reads` && `pnpm docs:check` && `pnpm --filter @goatcitadel/policy-engine test -- --maxWorkers=2`
2. **Phase 2:** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/external-side-effect-runner-service.test.ts src/services/comms-service.test.ts src/services/integration-action-service.test.ts src/services/external-side-effect-replay-job-service.test.ts src/services/durable-execution-service.test.ts src/services/telegram-channel-sessions.test.ts src/services/channel-inbound-dispatch.test.ts src/routes/comms.test.ts --maxWorkers=2` && `pnpm --filter @goatcitadel/storage exec vitest run src/external-side-effect-run-repo.test.ts --maxWorkers=2` && `pnpm docs:check`
3. **Phase 3:** the Task 10 Step 5 command.
4. **Phase 4:** gateway memory tests + `pnpm --filter @goatcitadel/mission-control-shared test -- --maxWorkers=2` + mission-control-next test/lint.

After each phase, run that workspace's typecheck **separately from vitest** (`pnpm --filter <pkg> exec tsc --noEmit` or the package's build script). Before final merge of Phase 2: `pnpm verify:runtime:truth` if runnable locally (contract-claims lane). Confirm the 6 dirty storage files are untouched at every commit: `git status --untracked-files=no -- packages/storage`.

## Execution notes

- Phases are independent; execute in order 1→4 but any can land alone. Suggested PR titles: "Bounded external read audit (parity P0)", "External side-effect replay matrix + Activepieces replay job (parity P0)", "MCP stream/crash regression pack (parity P1)", "Memory batch transaction proof + batch UI (parity P1)".
- If any regression test in Phases 2-3 exposes a genuine defect (assertion contradicts contract-correct behavior), STOP that task and report — the sprint's premise is "prove existing behavior", and a real bug is a finding to fix deliberately, not to encode in a test.
- Copy this plan to `docs/superpowers/plans/2026-07-07-parity-hardening-sprint.md` at execution start (repo convention for plan artifacts).
