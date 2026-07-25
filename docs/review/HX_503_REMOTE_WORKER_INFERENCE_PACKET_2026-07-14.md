# HX-503 Assignment-Bound Inference Packet

Date: 2026-07-14
Status: architecture SHIP for a production-dark implementation; coding HOLD until HX-411 releases shared storage owners and the live migration heads are re-read

## Product and trust boundary

HX-503 adds an internal Gateway service that performs model inference for one already-admitted, actively leased remote-worker assignment. It is not an API route, worker listener, scheduler, provider adapter, or second accounting owner.

The worker may supply only its assignment/generation/request/attempt identities, raw assignment lease token, bounded text-only messages, exact input/context/model-intent hashes, and bounded output/reasoning/temperature ceilings. It cannot supply a provider, model, API style, provider URL, credential reference, key, header, tool, memory, metadata, service tier, fallback list, or multimodal body.

Gateway:

- hashes the raw lease immediately and never persists or logs it;
- verifies authenticated `worker_runtime` claims with the `gateway_inference` capability;
- revalidates workspace, worker and assignment generations, lease revision/freshness, cancellation, immutable capability profile, routed context, policy, approval, route, and budget;
- chooses the effective provider/model and owns every provider credential;
- delegates authoritative attempt, usage, outcome, and cost truth to HX-306;
- persists canonical output frames and terminal evidence before worker delivery.

Evidence owners include `packages/contracts/src/remote-worker-admission.ts`, `packages/contracts/src/remote-worker-assignment.ts`, `packages/storage/src/remote-worker-assignment-repo.ts`, `packages/gateway-core/src/model-usage-accounting.ts`, and `packages/storage/src/model-usage-event-repo.ts`.

## Exact production-dark allowlist

Contracts:

- new `packages/contracts/src/remote-worker-inference.ts`
- new `packages/contracts/src/remote-worker-inference.test.ts`
- existing `packages/contracts/src/index.ts`

Storage:

- new `packages/storage/src/remote-worker-inference-repo.ts`
- new `packages/storage/src/remote-worker-inference-repo.test.ts`
- new `packages/storage/src/remote-worker-inference-repo.postgres.test.ts`
- new `packages/storage/src/remote-worker-inference-schema-parity.test.ts`
- existing `packages/storage/src/index.ts`
- existing `packages/storage/src/sqlite.ts`
- existing `packages/storage/src/postgres/migrations.ts`
- existing `packages/storage/src/postgres-migration-integrity.test.ts`

Gateway:

- new `apps/gateway/src/services/remote-worker-inference-service.ts`
- new `apps/gateway/src/services/remote-worker-inference-service.test.ts`
- new `apps/gateway/src/services/remote-worker-inference-llm-adapter.ts`
- new `apps/gateway/src/services/remote-worker-inference-llm-adapter.test.ts`

Any need to edit routes, startup composition, `gateway-service.ts`, `llm-service.ts`, HX-306 accounting, assignment protocols, package scripts, or another storage owner returns the tranche to HOLD.

## Storage decision

A paired SQLite/PostgreSQL migration is required, but this packet allocates no number. The owner must re-read the committed heads and active reservations after HX-411 commits.

`remote_worker_inference_requests` owns immutable assignment/worker/generation/request/hash bindings, the canonical bounded request body, stable HX-306 operation/generation identity, one-winner dispatch claim and database lease, secret-free governance receipts, effective route, HX-306 event references, output counters, worker acknowledgement watermark, terminal receipt, and accounting disposition. It never stores a raw assignment lease or provider credential.

`remote_worker_inference_outbox` owns request-scoped monotonically increasing frames, allowlisted payloads, previous/frame hashes, effective-route binding, and HX-306 event references. Frames are append-only; acknowledgement advances only the request watermark.

## State machine

```text
admitted
  |-> waiting_approval -> admitted
  |-> blocked
  `-> dispatch_claimed -> streaming -> completed
                              |       -> failed
                              |       -> cancelled
                              `------ -> dispatch_unknown
```

- Same idempotency key plus identical canonical bytes returns the existing request and frames.
- Changed replay conflicts.
- Only one transactional dispatch claimant wins.
- Terminal state and terminal frame commit atomically and are immutable.
- Provider acceptance without an exact recoverable terminal becomes `dispatch_unknown`; it never increments dispatch generation or triggers speculative redispatch.
- Restart/reconnect replays the durable outbox rather than invoking the provider again.

## Transaction and dispatch boundaries

1. Load current assignment authority plus immutable session/turn capability-profile and routed-context snapshots. V1 rejects sessionless assignments.
2. Obtain exact secret-free policy/approval/route and atomic budget-reservation decisions through mandatory injected ports. Missing ports fail closed.
3. In an immediate transaction, re-resolve active lease authority, verify worker claims and immutable hashes, then insert or exactly replay the request.
4. In a second transaction, repeat authority/profile/policy/budget/cancellation checks and acquire the one-winner dispatch claim.
5. Dispatch outside the database with `callKind=delegation_worker`, deterministic `operationId`, persisted `dispatchGeneration`, full parent/workspace/session/turn/task/worker/context attribution, and the one Gateway-selected provider/model. Cross-provider fallback is forbidden in V1.
6. Append each projected frame in a short transaction with exact sequence, hash chain, authority revision, and output limits.
7. Verify HX-306 event attribution, effective route, operation, and generation rather than recalculating usage or cost.
8. Atomically append the terminal frame and finalize the request from HX-306 receipts.
9. Revalidate current credentials and active assignment authority on every worker read or acknowledgement.

A socket disconnect stops delivery but does not cancel provider execution. Only Gateway-owned cancellation, deadline, or policy signals may abort it. Authority loss after dispatch preserves HX-306 evidence and cost while blocking stale-worker delivery and assignment settlement.

## Recovery and failure truth

- Crash before HX-306 begins may resume the same stable request.
- Existing HX-306 intent/accepted truth after restart forbids another provider fetch; reconcile or mark `dispatch_unknown`.
- Persisted frames replay after restart; a missing exact terminal receipt remains unknown/manual.
- Zero chunks, unterminated streams, accounting failure, or inconsistent attribution fail closed.
- Cancellation after provider acceptance preserves actual usage/cost evidence and blocks late settlement.
- Raw provider errors, headers, bodies, private reasoning, credentials, and reusable secret-derived material never enter the worker outbox.

## Mandatory injected owners

The production-dark service requires:

- a governance port returning `allowed | approval_required | denied`, exact route, policy revision/hash, approval receipt, token/reasoning ceilings, and expiry;
- an atomic budget port returning an idempotent reservation and settling it only from HX-306 event IDs.

Current daily USD settings/reporting are not atomic budget enforcement. Live enablement remains blocked until that owner exists. The first tranche permits one effective provider/model and no cross-provider fallback; the adapter may retain only the existing bounded output-cap recovery behavior.

## Acceptance proof

- exact-key/canonical-hash, accessor/proxy/cycle, size/depth/count, and forbidden-field contract tests;
- SQLite exact replay/conflict, one-winner claim, lease/cancellation, frame sequence/hash/output bounds, acknowledgement, immutable terminal, and restart tests;
- live PostgreSQL two-connection admission/claim/finalize/ack races, database-clock, and recovery proof;
- cross-dialect schema parity and migration integrity;
- Gateway credential/capability, generation/lease/profile/context drift, policy/approval/budget denial, cancellation, disconnect, output filtering, redaction, HX-306 attribution, terminal replay, and unknown-dispatch proof;
- focused tests and typechecks, live PostgreSQL, exact lint/format, and `git diff --check`.

## Explicit non-goals and release gates

No listener, mTLS/PoP issuance, credential minting, startup composition, public route, scheduler, assignment creation, permissive governance/budget stub, tools, MCP, Code Mode, multimodal input, memory injection, metadata, cross-provider fallback, Chat transcript settlement, durable-run settlement, Ops, or Mission Control change is in this tranche.

Live RPC remains HOLD until HX-501 supplies authenticated listener authority, an atomic budget adapter exists, and the integrated `verify:remote-workers` lane proves reconnect/restart without provider redispatch or duplicate accounting.
