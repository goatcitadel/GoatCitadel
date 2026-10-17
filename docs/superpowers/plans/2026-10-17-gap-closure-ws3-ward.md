# WS3 Citadel Ward Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Citadel Ward `require_approval` on an integration action, an outbound A2A call or an A2A push opens an operator approval that executes the action exactly once on approve (PR A, issue #346). A `route_local` ward keeps matching model work on a local backend or fails the turn closed (PR B, issue #347).

**Architecture:** The three call sites keep their existing ward gate. On `require_approval` they now create a `citadel_ward.*` approval that holds the exact request and its `payloadHash`, and they return `approval_required` with the `approvalId`. Resolving the approval enqueues one `citadel_ward_*_apply` effect row. A new owner file runs that row. It re-reads the approval, re-checks the hash, and re-invokes the owning call site with a `wardApproval` reference. The call site re-evaluates the ward: `deny` still wins, the matched `require_approval` counts as satisfied, and execution goes through the existing dispatch-fenced `runIdempotentExternalSideEffect`, keyed `citadel-ward:<approvalId>`.

**Tech Stack:** TypeScript, Fastify gateway, vitest, `@goatcitadel/contracts`, `@goatcitadel/storage`.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md`, section "WS3 — Citadel Ward enforcement"; issues #346 and #347; tracker #341.

## Global Constraints

- Work only in this worktree (branch off `origin/main`). Never edit the main checkout. Never `git stash`.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`, at low priority, one heavy job at a time.
- Use `git grep` (the Grep tool silently omits matches on this tree).
- `prettier --write` only on files you changed.
- Never run `architecture:baseline:update`. A new service file needs an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`. If an owner file's `host.X`/dependency member accesses grow, `verify:architecture:metrics` goes red, so consolidate.
- `gateway-service.ts` stays at or below `gatewayLineCount` 13132 (it is 13030 now). Add at most a couple of lines there.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- No new Postgres table or column is needed: `a2a_task_push_configs.last_delivery_status` is unconstrained `TEXT`. If that turns out to be wrong, stop and add a convergence migration tested on both lineages.
- No personal paths in tracked files. README keeps the governance gate's verbatim phrases.
- Commits: `<type>: <description>`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Proof lane: focused tests, `pnpm typecheck`, `pnpm verify:architecture:metrics`, `pnpm verify:gateway:async-boundary`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check`.

## Review Focus

1. **Double execution after approval** (program Review Focus #1). The same approved effect runs twice, or the worker restarts mid-run. The provider must be called once. Pinned in Task 5 ("runs the approved integration action once across two effect runs").
2. **The ward tightens to `deny` between approval and execution** (program Review Focus #4). Pinned in Tasks 2, 3 and 4 (owner level) and Task 5 (effect level).
3. **The request is tampered with after approval.** If the stored approval payload's request no longer hashes to `payloadHash`, nothing runs and the effect fails terminally with `payload_hash_mismatch`. Pinned in Task 5.
4. **A push event keeps firing while its approval is pending.** Repeated `deliverForTask` calls must not open a second approval, and later events must not be delivered out of order past the deferred one. Pinned in Task 4.
5. **A `wardApproval` reference is forged or replayed.** Example: an approval for another action, or one that is not approved. The owner must refuse it. The effect owner only passes approvals it re-read as `approved` and of the matching kind. The owner checks that the reference's `wardAction` equals the live ward action. Pinned in Tasks 2 and 5.

---

## Design decisions (recorded at kickoff)

- **Approval kinds:** `citadel_ward.integration_action`, `citadel_ward.a2a_outbound`, `citadel_ward.a2a_push`.
- **Effect kinds** (`ApprovalEffectKind`): `citadel_ward_integration_action_apply`, `citadel_ward_a2a_outbound_apply`, `citadel_ward_a2a_push_apply`. The approval-resolution worker enqueues them the way WS2 enqueues `communications_*_apply`, through a builder in the new owner file. No `pendingApprovalActions` row is created, so the generic `pending_action_execute` path never runs these.
- **Payload** (every kind): `{ wardAction, citadelId, workspaceId?, payloadHash, request }`. `request` is the full invoke input for that site. `payloadHash` = SHA-256 hex of the stable-JSON `request`.
- **Idempotency key on replay:** `citadel-ward:<approvalId>`. It is passed as the runner's key, so a second run of the same approval becomes a runner `duplicate`, never a second send.
- **Ward re-evaluation:** done by the owning call site on every invoke, including the approved replay. `deny` blocks with `citadel_ward_deny`. `require_approval` is satisfied only when `wardApproval.wardAction` equals the live ward action. `require_dry_run` keeps its existing path.
- **Deny / reject / expiry evidence:** the approval record keeps its terminal status. On reject or expiry, the effect row completes with `{ disposition: "rejected" | "expired" }`. For push, the config's delivery is recorded `blocked` with an operator-rejected error, and `lastEventSequence` moves past the event.
- **Push deferral:** a new `A2ATaskPushDeliveryStatus` value `"deferred_pending_approval"`. The deferred event does not advance `lastEventSequence`. While the config is deferred, `deliverForTask` returns `[]` without opening another approval. After an approved delivery, the service calls `deliverForTask` again, so later events flow, each under the live ward.

## File structure

- Create `apps/gateway/src/services/citadel-ward-approval.ts`. A pure contract with no host: kind constants, `buildCitadelWardApprovalPayload`, `computeCitadelWardPayloadHash`, `readCitadelWardApprovalPayload`, and `citadelWardReplayIdempotencyKey`.
- Create `apps/gateway/src/services/citadel-ward-approval-effect-service.ts`. The effect upsert builder, the effect runner and the executor composition over the gateway.
- Modify the three call sites, `approval-resolution-effects-service.ts` (enqueue + one `case`), `gateway-service.ts` (one spread line), `gateway-route-composition-system.ts` (a2a `createApproval`), contracts (`approvals.ts`, `integrations.ts`, `a2a.ts`), `packages/storage/src/a2a-task-push-config-repo.ts` (`normalizeDeliveryStatus`), and Mission Control vocabularies wherever typecheck shows an exhaustive map over a widened union.

---

### Task 1: Contracts and the pure approval contract

**Files:**
- Modify: `packages/contracts/src/approvals.ts` (`ApprovalEffectKind`), `packages/contracts/src/integrations.ts` (`IntegrationActionInvokeStatus` += `"approval_required"`), `packages/contracts/src/a2a.ts` (`A2AOutboundSendResponse.status` += `"approval_required"`, add `approvalId?: string`; `A2ATaskPushDeliveryStatus` += `"deferred_pending_approval"`; `A2ATaskPushDeliveryResult` add `approvalId?: string`)
- Modify: `packages/storage/src/a2a-task-push-config-repo.ts` (`normalizeDeliveryStatus` accepts the new value)
- Modify: every Mission Control / shared map that typecheck flags as non-exhaustive (e.g. `apps/mission-control-next/src/cockpit/areas/inbox/inbox-vocabulary.ts` effect labels: "Run the approved integration action", "Send the approved A2A call", "Deliver the approved A2A push")
- Create: `apps/gateway/src/services/citadel-ward-approval.ts`, `apps/gateway/src/services/citadel-ward-approval.test.ts`

**Interfaces — Produces:**
```ts
export const CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND = "citadel_ward.integration_action";
export const CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND = "citadel_ward.a2a_outbound";
export const CITADEL_WARD_A2A_PUSH_APPROVAL_KIND = "citadel_ward.a2a_push";
export type CitadelWardApprovalKind = typeof ...; // union of the three
export interface CitadelWardApprovalPayload<TRequest extends Record<string, unknown> = Record<string, unknown>> {
  wardAction: string; citadelId: string; workspaceId?: string; payloadHash: string; request: TRequest;
}
export interface CitadelWardApprovalRef { approvalId: string; wardAction: string; }
export function computeCitadelWardPayloadHash(request: Record<string, unknown>): string; // sha256 hex of stable JSON (reuse hashStableJson if one exists in gateway, else sort keys recursively)
export function buildCitadelWardApprovalPayload<T extends Record<string, unknown>>(input: Omit<CitadelWardApprovalPayload<T>, "payloadHash">): CitadelWardApprovalPayload<T>;
export function readCitadelWardApprovalPayload(payload: unknown): CitadelWardApprovalPayload | undefined; // undefined on any missing/blank field or non-object request
export function citadelWardReplayIdempotencyKey(approvalId: string): string; // `citadel-ward:${approvalId}`
export function isCitadelWardApprovalKind(kind: string): kind is CitadelWardApprovalKind;
```

- [ ] **Step 1: Write failing tests** in `citadel-ward-approval.test.ts`:
  - `"hash is stable under key reordering and changes with content"`. `computeCitadelWardPayloadHash({a:1,b:{c:2}})` equals the hash of `{b:{c:2},a:1}` and differs from the hash of `{a:1,b:{c:3}}`. Assert it matches `/^[0-9a-f]{64}$/`.
  - `"build then read round-trips and read rejects malformed payloads"`. `readCitadelWardApprovalPayload(build(...))` deep-equals the built value. Missing `payloadHash`, blank `wardAction`, or `request: "x"` each return `undefined`.
  - `"replay key is namespaced by approval id"`. `citadelWardReplayIdempotencyKey("ap-1") === "citadel-ward:ap-1"`.
- [ ] **Step 2: Run them** with `pnpm --filter @goatcitadel/gateway exec vitest run src/services/citadel-ward-approval.test.ts --maxWorkers=2`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement** the module and the contract widenings above. Register `citadel-ward-approval.ts` in `architecture-new-service-allowances.json` (planStep `C0`, 0 host callbacks, 0 dependency accesses, a reason that names WS3 and an evidence line citing the test).
- [ ] **Step 4: Run** the test again (PASS). Then run `pnpm --filter @goatcitadel/contracts build` and `pnpm typecheck`, and fix every exhaustive map typecheck flags.
- [ ] **Step 5: Commit** with `feat: citadel ward approval contract and widened outcome unions`.

### Task 2: Integration action — `require_approval` opens an approval

**Files:**
- Modify: `apps/gateway/src/services/integration-action-service.ts` (~L104-140; `IntegrationActionInvokeOptions`)
- Test: `apps/gateway/src/services/integration-action-service.test.ts` (flip the test at ~L1840)

**Interfaces:**
- Consumes: Task 1 helpers and `host.createApproval` (already on `IntegrationActionHost`).
- Produces: `IntegrationActionInvokeOptions.wardApproval?: CitadelWardApprovalRef`. With it, the call `invokeIntegrationConnectionAction(host, connectionId, actionId, request, { wardApproval })` executes when the live ward is `require_approval` and `wardApproval.wardAction === wardAction`. The approval request shape is `{ connectionId, actionId, invokeRequest: { input, idempotencyKey? } }`.

- [ ] **Step 1: Rewrite the failing test** "blocks require_approval fail-closed until the approval loop is wired (Stage 2)". Rename it to `"opens a citadel ward approval for require_approval instead of blocking"`. Use a `createApproval` mock that returns `{ approvalId: "approval-ward-1", ... }`. Expect `result.status === "approval_required"` and `result.output` to match `{ approvalId: "approval-ward-1", wardAction: "integration.automation.activepieces.trigger_webhook", citadelId: "citadel-guarded" }`. Expect `createApproval` to have been called with `kind: "citadel_ward.integration_action"`, a `payload.payloadHash` matching `/^[0-9a-f]{64}$/`, `payload.request.connectionId === connection.connectionId`, and `linkage.workspaceId === "ws-guarded"`. Expect `fetchWithDiagnosticsTimeout` not to have been called.
- [ ] **Step 2: Add the failing tests:**
  - `"executes an approved ward replay through the idempotent runner"`. Call with `{ wardApproval: { approvalId: "approval-ward-1", wardAction: "integration.automation.activepieces.trigger_webhook" } }` and `request.idempotencyKey: "citadel-ward:approval-ward-1"`. Expect `status === "executed"` and the webhook fetch called once.
  - `"deny still wins over an approved ward replay"`. Same call, but the ward rows are `[{ actionPattern: "integration.*", effect: "deny" }]`. Expect `blockedReason === "citadel_ward_deny"` and no fetch.
  - `"refuses a ward approval minted for a different action"`. Pass `wardAction: "integration.other.x"` under a `require_approval` ward. Expect `status === "approval_required"` (a new approval is opened) and no fetch.
  - `"stays blocked when the host cannot create approvals"`. Omit `createApproval`. Expect `blockedReason === "citadel_ward_approval_required"`, with the message still saying no approval loop is available on this host.
- [ ] **Step 3: Run** the file. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.** In the dispatcher, a `require_approval` without a matching `wardApproval` calls `openIntegrationWardApproval(host, connection, actionId, request, ward, checkedAt)`. The function is a small helper in the same file (or in `integration-dry-run-gate.ts` if `integration-action-service.ts` would grow past its eslint `max-lines`). It returns `approval_required` with `blockedReason: "citadel_ward_approval_required"`, `message: "A Citadel Ward requires operator approval for <wardAction>; approval <id> is pending."` and output `{ approvalId, wardAction, wardEffect, citadelId }`. Approval `riskLevel: "caution"`, `expiresAt` = checkedAt + 15 min (reuse the dry-run TTL constant by exporting it), and `preview: { title: "<action label> — Citadel Ward approval", route: wardAction, target: connectionId:actionId }`. A matching `wardApproval` sets the effective ward effect to `undefined` and continues to the per-catalog branches. The result falls through to the existing writeback envelope + realtime tail. If `createApproval` throws, keep the blocked result and put `approvalError` in its output.
- [ ] **Step 5: Run** the file (PASS) and `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] **Step 6: Commit** with `feat: integration actions open a citadel ward approval on require_approval`.

### Task 3: A2A outbound — `require_approval` opens an approval

**Files:**
- Modify: `apps/gateway/src/services/a2a-route-service.ts` (`A2ARouteServiceDependencies` += `createApproval?: (input: ApprovalCreateInput) => Promise<ApprovalRequest>`; `sendOutbound(input, actorId, checkedAt?, options?: { wardApproval?: CitadelWardApprovalRef })`; ward block ~L620-646)
- Modify: `apps/gateway/src/services/gateway-route-composition-system.ts` (a2a deps: `createApproval: (input) => gateway.createApproval(input)`; widen the port's `Pick` if needed)
- Test: `apps/gateway/src/services/a2a-route-service.test.ts`

**Interfaces — Produces:**
- `A2ARouteService.sendOutbound(input: A2AOutboundPreviewRequest, actorId: string, checkedAt?: string, options?: { wardApproval?: CitadelWardApprovalRef }): Promise<A2AOutboundSendResponse>`.
- The approval request shape is `{ outbound: A2AOutboundPreviewRequest, actorId }`, with no workspace (the personal citadel).
- On replay the caller passes `input.idempotencyKey = citadelWardReplayIdempotencyKey(approvalId)`.

- [ ] **Step 1: Write failing tests** in a new `describe("citadel ward gate on outbound")`, using an enabled outbound peer and ward storage stubs:
  - `"opens an approval for require_approval and sends nothing"`. Expect `status === "approval_required"`, `approvalId` set, `createApproval` called with `kind: "citadel_ward.a2a_outbound"` and `payload.wardAction === "a2a.outbound.jsonrpc.message.send"`, and no outbound fetch.
  - `"sends once on an approved replay"`. Pass `{ wardApproval }` and the replay key. Expect `status === "sent"` and one fetch. A second identical call returns `status === "replayed"` without another fetch.
  - `"deny after approval blocks the replay"`. The ward rows become `deny`. Expect `status === "blocked"`, a warning matching `/denies/`, and no fetch.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror Task 2. Without `deps.createApproval`, keep the current blocked response. Apply the same `wardAction` match rule.
- [ ] **Step 4: Run** the file (PASS) and the gateway typecheck.
- [ ] **Step 5: Commit** with `feat: a2a outbound opens a citadel ward approval on require_approval`.

### Task 4: A2A push — deferred delivery state

**Files:**
- Modify: `apps/gateway/src/services/a2a-push-notification-service.ts` (deps += `createApproval?`; `deliverForTask`, `deliverPushEvent`; new public methods). Pass `createApproval` through from `A2ARouteService`'s constructor.
- Modify: `apps/gateway/src/services/a2a-route-service.ts`. Add a public pass-through `deliverApprovedPush(...)` / `recordRefusedPushApproval(...)` so the effect owner needs only the route service.
- Test: `apps/gateway/src/services/a2a-route-service.test.ts` (push section) or a new `a2a-push-notification-service.test.ts`

**Interfaces — Produces:**
```ts
// approval request shape: { taskId, peerId, eventSequence, eventKind, urlHash }
deliverApprovedPush(input: { approvalId: string; wardAction: string; taskId: string; peerId: string; eventSequence: number }, checkedAt?: string): Promise<A2ATaskPushDeliveryResult[]>;
recordRefusedPushApproval(input: { approvalId: string; taskId: string; peerId: string; eventSequence: number; disposition: "rejected" | "expired" }, checkedAt?: string): Promise<void>;
```

- [ ] **Step 1: Write failing tests:**
  - `"defers a ward-gated push and opens one approval"`. Under a `require_approval` ward on `a2a.outbound.push`, the result is `status === "deferred_pending_approval"` with `approvalId`. The stored config has `lastDeliveryStatus === "deferred_pending_approval"` and `lastEventSequence` unchanged. `createApproval` is called once with `kind: "citadel_ward.a2a_push"`. There is no push fetch.
  - `"does not open a second approval while deferred"`. A second `deliverForTask` returns `[]`, with `createApproval` still at one call.
  - `"approved push delivers the deferred event exactly once"`. `deliverApprovedPush` delivers it with one fetch and `lastDeliveryStatus === "delivered"`. Calling it again makes no second fetch.
  - `"deny after approval blocks the deferred push"`. The ward becomes `deny`, then `deliverApprovedPush` runs. The status is `blocked` and there is no fetch.
  - `"rejected approval records a blocked delivery"`. After `recordRefusedPushApproval({ disposition: "rejected" })`, `lastDeliveryStatus === "blocked"`, the error matches `/rejected/`, and `lastEventSequence === eventSequence`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `deliverApprovedPush` re-reads the config and binding. It rebuilds the task and the event with `buildEventsForTask(task, eventSequence - 1)`, filtered to `sequence === eventSequence`, and refuses quietly (returns `[]`) if the event is gone. It delivers with the `wardApproval`. On success it calls `deliverForTask` for the remaining events. The runner key stays `buildPushIdempotencyKey(task, event, peerId)`, which is already per-event, so the replay stays deduped. Without `createApproval`, keep the current `blocked` behavior.
- [ ] **Step 4: Run** (PASS) and the gateway typecheck.
- [ ] **Step 5: Commit** with `feat: a2a push defers ward-gated delivery pending approval`.

### Task 5: Approval effects execute ward-gated actions once

**Files:**
- Create: `apps/gateway/src/services/citadel-ward-approval-effect-service.ts`, `apps/gateway/src/services/citadel-ward-approval-effect-service.test.ts`
- Modify: `apps/gateway/src/services/approval-resolution-effects-service.ts`. Next to the communications enqueue (~L800), add `buildCitadelWardApprovalEffectUpsert`. Next to the communications cases (~L1556), add one `case` group that delegates to `runCitadelWardApprovalEffect`. `ApprovalEffectsServiceDeps` extends `CitadelWardApprovalEffectExecutors`.
- Modify: `apps/gateway/src/services/gateway-service.ts`. Add one spread next to `...buildCommunicationsApprovalEffectDeps(...)` (~L2282): `...buildCitadelWardApprovalEffectDeps({ storage: this.storage, integrationHost: () => buildIntegrationActionHostForGateway(this.getRouteCompositionPort()), a2a: () => this.routeServices.a2a })`.
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json` (new entry)

**Interfaces — Produces:**
```ts
export const CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND = "citadel_ward_integration_action_apply";
export const CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND = "citadel_ward_a2a_outbound_apply";
export const CITADEL_WARD_A2A_PUSH_EFFECT_KIND = "citadel_ward_a2a_push_apply";
export function isCitadelWardEffectKind(kind: string): boolean;
export type CitadelWardEffectErrorCode = "approval_not_approved" | "invalid_payload" | "payload_hash_mismatch" | "ward_denied" | "blocked";
export class CitadelWardApprovalEffectError extends Error { code: CitadelWardEffectErrorCode }
export interface CitadelWardApprovalEffectExecutors {
  executeApprovedCitadelWardAction?(input: { approvalId: string }): Promise<Record<string, unknown>>;
  recordCitadelWardApprovalRefused?(input: { approvalId: string; expired: boolean }): Promise<Record<string, unknown>>;
}
export function buildCitadelWardApprovalEffectUpsert(approval: ApprovalRequest, decision: "approve" | "reject" | "edit", expired?: boolean): (ApprovalEffectRecord upsert) | undefined;
// target: targetKind "citadel_ward_action", targetId = approvalId; payload { decision, expired?, payloadHash }
export function runCitadelWardApprovalEffect(effect, executors, settlement): Promise<void>; // same settlement shape and semantics as runCommunicationsApprovalEffect
export function buildCitadelWardApprovalEffectDeps(input: { storage: Pick<AsyncStorage, "approvals">; integrationHost: () => IntegrationActionHost; a2a: () => Pick<A2ARouteService, "sendOutbound" | "deliverApprovedPush" | "recordRefusedPushApproval"> }): Required<CitadelWardApprovalEffectExecutors>;
```

The executor (`executeApprovedCitadelWardAction`) does these steps in order:
1. Re-read the approval. It must be `approved` and its kind must be a citadel ward kind; otherwise `approval_not_approved`.
2. Run `readCitadelWardApprovalPayload`; on failure, `invalid_payload`.
3. Recompute the hash and compare it to `payloadHash`; on a mismatch, `payload_hash_mismatch`.
4. Dispatch by kind with `wardApproval = { approvalId, wardAction }` and the replay idempotency key.
5. Map the owner result. An executed / sent / replayed / delivered result returns `{ disposition, ... }`. `citadel_ward_deny` or a deny warning throws `ward_denied`. Any other block throws `blocked` with the owner's message.

Only an unexpected throw defers for retry. The runner's idempotency keeps a retry exactly-once.

- [ ] **Step 1: Write failing tests** in `citadel-ward-approval-effect-service.test.ts`:
  - `"enqueues one effect for an approved, rejected or expired ward approval and none for other kinds"`.
  - `"runs the approved integration action once across two effect runs"`. Use a real `invokeIntegrationConnectionAction` over an in-memory runner store (follow the `integration-action-service.test.ts` fixtures). Run the executor twice. The provider fetch is called once. The second result is a replay/duplicate disposition, not an error.
  - `"ward tightened to deny before execution blocks the action"`. The effect fails terminally with `errorCode: "ward_denied"` and nothing is fetched.
  - `"tampered request fails with payload_hash_mismatch and executes nothing"`.
  - `"non-approved approval fails with approval_not_approved"`.
  - `"rejection completes with disposition rejected and records the refused push"`.
  - `"a2a outbound and push kinds dispatch to the route service with the ward approval reference"`.
  - In `approval-resolution-effects-service.test.ts`: `"resolving a citadel ward approval enqueues and completes its apply effect"` (follow the WS2 communications test there).
- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement.** Model it on `communications-approval-effect-service.ts` (upsert identity + `buildApprovalEffectIdempotencyKey`, a settlement that completes / fails / defers). Add the allowance entry. If `approval-resolution-effects-service.ts` goes over its metrics baseline (259), move the glue into the new file until it is back at or below the baseline.
- [ ] **Step 4: Run** both files (PASS), `pnpm typecheck`, `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary`.
- [ ] **Step 5: Docs.** Update the README "Gatehouse Wards" / Citadels rows and the `docs/1_0_CONTRACT.md` ward lines. Integration actions, outbound A2A and A2A push now turn `require_approval` into an operator approval that executes once on approve and re-checks the ward at execution. Keep every governance-gate phrase. Run `pnpm docs:check` if the script exists.
- [ ] **Step 6: Commit** with `feat: execute approved citadel ward actions exactly once through approval effects`.

---

## PR B — Task 3.2: enforce `route_local`

### Design decision (kickoff, 2026-10-17)

- **Ward action:** `model.chat.<providerId>`, evaluated per Chat turn against the session's workspace citadel. It goes through `resolveWardEffectForExternalAction`, which is deny-wins and resolves to the personal citadel when the session is unbound.
- **`model.tool.<toolName>` is not wired in this PR.** No single model-backed tool boundary exists to gate yet. The docs say `route_local` is enforced for Chat model routing only, and #347 is closed against its "boundary gate" wording. This is recorded as a follow-up, not claimed.
- **Primary enforcement point:** `resolveChatRouteDescriptor` (`apps/gateway/src/services/chat-route-resolution.ts:207`). There is no ranked candidate list, so the pool is `runtime.providers`.
- **Local backend (strict):** a provider counts as local only in two cases.
  - Its inferred engine kind (`inferRuntimeEngineKind`) is `ollama` or `llama_cpp`, and `isLocalChatProviderUrl(baseUrl)` holds.
  - Its kind is `openai_compatible` and its baseUrl host is loopback: `localhost`, `127.0.0.0/8`, or `[::1]`. This uses a new strict `isLoopbackUrl` helper.
- **Health:** a candidate is usable unless `getCachedModelAvailability(providerId, model)` is `"unavailable"` or `"stale_unavailable"`.
- **Outcome:**
  - Requested provider is already local: keep it.
  - Otherwise: switch to the first usable local provider, using its configured default model, with `selectionSource: "citadel_ward_route_local"`.
  - No usable local provider: set `blockedReason` to "A Citadel Ward requires this chat to stay on a local model, and no local model route is available." and set `wardReasonCode: "citadel_ward_route_local_unavailable"`.
  - A matched `deny` blocks the same way with `wardReasonCode: "citadel_ward_deny"`. This is deny-wins honesty, since a deny on `model.chat.*` must not be weaker than `route_local`.
- **Fail closed at turn entry:** every `chat-turn-entry-service.ts` call site that reads the descriptor must throw `PolicyViolationError` with `details: { reason: <wardReasonCode>, citadelId }` when `wardReasonCode` is a blocking code. Today those sites do not throw on `blockedReason`.
- **Dispatch backstop:** the dispatch-time cross-provider fallback (`resolveFallbackTargets`, `gateway-service.ts:11596`, which can return the cloud `moonshot`) must not leave a local route. The `LlmDispatchGuard` (`llm-dispatch-guard.ts`) re-evaluates `model.chat.<route.providerId>` for `attribution.workspaceId`. If the ward is `route_local` and the provider is not local, it rejects with `LlmDispatchGuardRejectedError` (`citadel_ward_route_local_unavailable`).
- **Audit:** the descriptor carries `wardReasonCode` (`citadel_ward_route_local` when enforced and satisfied) plus `wardCitadelId`. They are added to `RoutingDecisionSnapshot` and its fingerprint, and to each call site's `recordDevDiagnostic` context.

### Task 6: Route resolution enforces `route_local`

**Files:**
- Modify: `apps/gateway/src/services/chat-route-resolution.ts`. Deps: `storage` Pick += `workspaces`/`citadels` (optional), `resolveSessionWorkspaceId?(sessionId): Promise<string | undefined>`. Descriptor += `wardReasonCode?`, `wardCitadelId?`. Update the snapshot and fingerprint.
- Create: `apps/gateway/src/services/chat-route-local-ward.ts`, exporting:
  - `isLoopbackUrl(url?: string): boolean`
  - `isRouteLocalProvider(provider: LlmProviderSummary | LlmProviderConfig): boolean`
  - `buildModelChatWardAction(providerId: string): string`, which returns `model.chat.<providerId>`
  - `selectRouteLocalProvider(...)`

  Add its allowance entry.
- Modify: `packages/contracts/src/chat.ts` (`RoutingDecisionSnapshot` / `RoutingPreflightResult` += optional `wardReasonCode`, `wardCitadelId`)
- Modify: `apps/gateway/src/services/chat-turn-entry-service.ts` (fail closed at each descriptor call site; diagnostic context)
- Modify: `apps/gateway/src/services/citadel-ward-gate.ts` header comment
- Test: `apps/gateway/src/services/chat-route-resolution.test.ts`, `apps/gateway/src/services/chat-route-local-ward.test.ts`, `apps/gateway/src/services/chat-turn-entry-service.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `isLoopbackUrl`: true for `http://localhost:11434`, `http://127.0.0.2:8080/v1` and `http://[::1]:1234`. False for `http://192.168.1.5:11434`, `https://api.openai.com`, `http://localhost.evil.com` and `undefined`.
  - `isRouteLocalProvider`: true for an ollama provider on `http://127.0.0.1:11434`. False for an openai_compatible provider on `http://10.0.0.5:8000` and for an `ollama`-named provider on `https://ollama.com`.
  - Resolution, `"route_local ward keeps a local requested provider"`: the session requests local `ollama`. The descriptor keeps it with `wardReasonCode: "citadel_ward_route_local"`.
  - Resolution, `"route_local ward switches a cloud request to the available local provider"`: `effectiveProviderId === "ollama"` and `selectionSource === "citadel_ward_route_local"`.
  - Resolution, `"route_local ward with no healthy local provider fails closed"`: availability is `"unavailable"`. Expect `blockedReason` to be set and `wardReasonCode === "citadel_ward_route_local_unavailable"`.
  - Resolution, `"no ward storage leaves routing unchanged"`.
  - Turn entry, `"a route_local-unavailable descriptor rejects the turn with PolicyViolationError"`: the error's `details.reason` is `"citadel_ward_route_local_unavailable"`, and no provider is called.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** as decided above. Wire `resolveSessionWorkspaceId` and the ward storage on the real host (`GatewayService` already has both).
- [ ] **Step 4: Run** the files (PASS) and the gateway typecheck.
- [ ] **Step 5: Commit** with `feat: enforce citadel ward route_local at chat route resolution`.

### Task 7: Dispatch backstop and docs

**Files:**
- Modify: `apps/gateway/src/services/llm-dispatch-guard.ts`, or wherever the guard is composed. Re-evaluate the ward per dispatch.
- Modify: `README.md` (L165, L214, L547 ward rows: `route_local` is now enforced for Chat model routing; keep the governance phrases) and `docs/1_0_CONTRACT.md` (the same wording)
- Modify: `apps/mission-control-next/src/features/native-routes/library/citadel-ward-model.ts` copy, if it claims more or less than this
- Test: the guard's test file

- [ ] **Step 1: Write the failing test** `"route_local ward rejects a dispatch to a non-local provider"`. The guard input has `route.providerId: "moonshot"` under a `route_local` ward. Expect it to reject with `LlmDispatchGuardRejectedError` and reason `citadel_ward_route_local_unavailable`. A local provider passes.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** (PASS).
- [ ] **Step 5: Docs.** Run `node scripts/verify-repo-hygiene.mjs` and the README governance gate (find it with `git grep -n "governance" scripts package.json`).
- [ ] **Step 6: Commit** with `feat: citadel ward route_local backstop at LLM dispatch and docs`.
