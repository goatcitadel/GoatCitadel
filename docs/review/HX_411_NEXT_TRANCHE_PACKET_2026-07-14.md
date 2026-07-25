# HX-411 Next-Tranche Packet

Date: 2026-07-14
Status: runtime-foundation SHIP; external-control streams, CLI, and UI remain HOLD
Integration base before this tranche: `24c04fa5677fc0eb737c756bed690622e4a98d7c`
Live migration heads: SQLite 174 / PostgreSQL 116
HX-411 pairs: SQLite 173 / PostgreSQL 115 for auth-revoke, lifecycle, and durable mutation admission; SQLite 174 / PostgreSQL 116 for durable heartbeat occurrence authority

## Implementation closeout

The lifecycle, mutation-admission, purpose-auth, production-dark control-owner, universal-fence, and heartbeat-occurrence foundations are implemented and independently accepted. The resulting runtime keeps one canonical active-turn authority while allowing an authenticated operator to atomically preempt either a pre-bind or durable-bound system heartbeat. Preemption advances the controller generation, closes pending control requests under a deterministic 256-row fail-before-mutation bound, terminalizes the old grant, closes or abandons the exact heartbeat occurrence, and emits one replay-safe `heartbeat_preempted` event. Delayed preemption beyond the former one-second trigger window passes in both SQLite and live PostgreSQL.

Heartbeat model input remains ephemeral: no user message, branch, transcript, approval, or public raw-output record is created. Exact decision JSON is sealed as an internal raw hash plus normalized receipt under the durable runtime authority. The stream is bounded before append at 65,536 UTF-16 code units and 8,192 delta chunks. Malformed, oversized, or provider-error-name-spoofed output follows bounded retry/failure; only a genuine aborted durable signal can carry cancellation authority.

A paired raw-output/receipt plus exact completed-trace state is a no-mutation `decision_committed` recovery window. Gateway recovery re-enters the canonical durable path and retries the same authenticated operator admission once without provider redispatch. Partial, one-sided, drifted, waiting, terminal, or otherwise inconsistent evidence fails closed.

`notify:false` persists no visible message. `notify:true` persists one assistant/system message and one content-free retained `chat_heartbeat_message_committed` fact. The Chat thread projects this through a separate bounded `systemNotices` collection: heartbeat traces never become conversation branches or active leaves, optimistic/live reducer updates preserve notices, and the canonical timeline/flattening paths merge them chronologically without synthesizing a user bubble.

Independent QA finished with no open P0/P1/P2 findings. It passed 269 worker/stream/dispatch cases, 108 authority/recovery/source-inventory cases, 109 route/authentication cases, 32 SQLite storage cases, 6 live PostgreSQL cases, 59 retained-notice/UI cases, 30 migration-integrity cases, 121 policy cases, 14 contract cases, 13 capability/approval-posture cases, and typechecks for contracts, policy, storage, Gateway, Mission Control Shared, threaded-surface core, and Mission Control Next. Migration heads are SQLite 174 and PostgreSQL 116. External controller routes/streams, CLI attach, and operator UI remain separate release gates; this closeout does not claim them.

## Addendum: durable heartbeat occurrence reservation

After 173/115 became the live physical heads, autonomous-ingress QA proved that heartbeat execution used a fresh process UUID on every sweep and never advanced its persisted cadence. A retry could therefore create a second Chat child, and later maintenance ticks could continue firing after the prior turn stopped.

SQLite 174 / PostgreSQL 116 are now exclusively reserved for an HX-411 durable heartbeat-occurrence owner. The pair must store only bounded, content-free occurrence authority and exact child/admission linkage; it must not store prompt, response, tool, or provider content. Reservation does not authorize implementation until the cross-dialect claim/resume/settlement contract and live PostgreSQL proof are frozen. HX-501B and every other row must select a later pair after a fresh post-HX-411 scan.

The cross-dialect contract is now frozen. A committed heartbeat claim, not model success or terminal settlement, consumes the shared cadence exactly once. One synchronous outer transaction locks and re-reads session lifecycle, current operator control, autonomy preferences, session activity, open mutation admissions, and any unresolved heartbeat occurrence; rechecks enabled, active-hours, idle, cooldown, interval, and no-active-turn gates against database time; advances the cadence monotonically without bumping the operator-facing aggregate revision; admits the exact `system-heartbeat` turn; and inserts its deterministic occurrence. Any failure rolls the complete claim back. An abandoned pre-bind occurrence retains the cadence reservation so recovery cannot create a retry storm.

`chat_heartbeat_occurrences` is content-free and append/transition-only. Its deterministic identity binds workspace, session incarnation, exact prior cadence timestamp and run identity including explicit nulls, the evaluated policy digest, and frozen request/objective digests. It freezes the interval, cooldown, idle floor, observed session activity, system actor, admission, and domain-separated message/turn/run identities. The ordinary paths are `admitted -> durable_bound -> terminal` and `admitted -> abandoned`; exact operator preemption may also abandon a durable-bound occurrence only while atomically cancelling its linked run and closing its admission with authority-superseded evidence. A partial unique open-occurrence fence prevents more than one `admitted` or `durable_bound` row per session. `terminal` means the durable run is terminal, every required linked/autonomous/general finalizer is settled, the exact handoff exists, and the mutation admission is closed.

Expired pre-bind recovery may reclaim only the same active, unbound, occurrence-linked `system-heartbeat` admission with the same deterministic runtime owner and immutable request identity. A live lease is busy, not transferable. Lifecycle, incarnation, control, actor, material, profile, run, or child drift fails closed. Generic expired-admission cleanup excludes unresolved occurrence-linked admissions both while selecting candidates and after taking the session lock. Recovery runs before that cleanup, before proactive or maintenance schedulers start, and again before every heartbeat sweep.

PostgreSQL 116 also contains a separately named and preflighted forward repair for the generated capability-profile binding foreign key that fresh PostgreSQL schema synthesis made non-deferrable. It validates that no orphan exists, replaces only the `profile_id` foreign key with one stable `ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED` constraint, and asserts exactly one matching deferred catalog entry. PostgreSQL 115 remains immutable. SQLite 174 needs no equivalent repair because SQLite 173 already created that foreign key deferred; this intentional migration asymmetry is covered by integrity and live-dialect proof.

## Decision

The committed 172/114 storage foundation supplies control generations, requests, token/capability binding, auth-purpose columns and immutable parent binding, database-clock liveness, exact auth-revoke receipts, and content-free control evidence. It deliberately does not make Chat session lifecycle or long-lived mutation admission total.

A fresh additive pair is required. SQLite 173 / PostgreSQL 115 were reserved only after 172/114 committed and a fresh scan found no later physical migration or competing reservation. No other row may infer, share, or reuse this pair.

Implementation order is:

1. C0 and A commit atomically as the 173/115 auth-revoke/lifecycle/admission integration.
2. C production-dark `SessionControlService` and runtime owner.
3. B purpose-aware auth projections and route isolation, with no control route registration.
4. D0 exhaustive mutation/callback classifier.
5. D1 synchronous mutation fencing, D2 turn/durable callback fencing, and D3 other long-lived session work.
6. `verify:session-control`.
7. Only then consider bounded external control routes, streams, CLI, or UI.

## C0: exact auth-revoke timestamp bridge

The initial migration-free three-file implementation is **HOLD** after independent QA reproduced complete rollback with 4,000 SQLite and 300 PostgreSQL targets once the one group timestamp aged beyond the existing one-second trigger window. A target cap or faster loop is not an acceptable repair because either can strand compromised authority.

C0 therefore commits only with A in 173/115. The pair adds immutable `chat_session_control_auth_revoke_operations` and `chat_session_control_auth_revoke_operation_targets`. The operation freezes the exact binding, actor, correlation, request hash, one fresh database timestamp, target/session counts, and event-set digest. Exact target rows freeze each pending request or current grant generation/revision and its evidence identity. The operation primary key is also a `DEFERRABLE INITIALLY DEFERRED` foreign key to the immutable receipt, so commit without the final receipt fails and rolls back the header, targets, effects, and evidence.

The forward migration replaces the request-transition, grant-update, grant-insert, event-insert, and receipt-insert guards. Ordinary writes retain their existing database-clock guards. Only an exact target under an operation with no receipt may use the older group timestamp; receipt insertion validates the complete header/target/effect/event set and immediately closes every bypass predicate. Historical operations cannot be reused.

`revokeByAuthBinding` acquires the auth-coupling lock and sorted session locks, freezes the target plan, reads one database timestamp, inserts the operation and targets, applies all effects with that timestamp, inserts exact events, and inserts the receipt last. Zero-target creation uses the same operation-to-receipt protocol. Replay validates operation-bound evidence while preserving pre-173/115 receipts honestly as legacy receipt-time evidence. Realtime/audit publication happens only after commit.

## A: session lifecycle and durable mutation admission

SQLite 173 / PostgreSQL 115 add only:

- `chat_session_control_auth_revoke_operations`;
- `chat_session_control_auth_revoke_operation_targets`;

- `chat_session_lifecycle_intents`;
- an internal lifecycle-intent binding on `chat_session_meta`;
- `chat_session_mutation_admissions`;
- append-only `chat_session_mutation_admission_events`; and
- database guards for explicit initialization, immutable workspace, direct-delete ordering, same-workspace expected-generation reactivation, workspace consistency, immutable admission identity/material, and one active durable turn-write admission per session.

The migration preflight checks both directions and aborts if any live metadata row lacks exactly one workspace-matched current control or any current control lacks matching live metadata. It performs no auth/control/content backfill and stores no message, prompt, structured part, attachment, context, tool, result, or approval body. Pre-173 metadata may retain a null lifecycle binding; every new insert requires an exact initialization or reactivation intent, and a legacy null binding may move only once to an exact deletion intent.

Writable fence:

- `packages/storage/src/sqlite.ts`
- `packages/storage/src/postgres/migrations.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/chat-session-meta-repo.ts`
- `packages/storage/src/chat-session-meta-repo.test.ts`
- `packages/storage/src/chat-session-revision-repo.ts`
- `packages/storage/src/chat-session-lifecycle-repo.ts` (new)
- `packages/storage/src/chat-session-lifecycle-repo.test.ts` (new)
- `packages/storage/src/chat-session-lifecycle-repo.postgres.test.ts` (new)
- `packages/storage/src/session-mutation-admission-repo.ts` (new)
- `packages/storage/src/session-mutation-admission-repo.test.ts` (new)
- `packages/storage/src/session-mutation-admission-repo.postgres.test.ts` (new)
- `packages/storage/src/session-control-schema-parity.test.ts`
- `packages/storage/src/session-control-repo.ts`
- `packages/storage/src/session-control-repo.test.ts`
- `packages/storage/src/session-control-repo.postgres.test.ts`
- `packages/storage/src/postgres-migration-integrity.test.ts`
- `packages/storage/src/sqlite-migration-versioning.test.ts`
- `packages/storage/src/public-api.test.ts`
- `packages/storage/src/chat-session-meta-repo.goal.test.ts`
- `packages/storage/src/chat-session-prefs-repo.test.ts`
- `packages/storage/src/chat-session-project-repo.test.ts`
- `packages/storage/src/session-autonomy-prefs-repo.test.ts`
- `packages/storage/src/chat-side-chat-repo.test.ts`
- `packages/storage/src/chat-session-list-repo.test.ts`
- `packages/storage/src/chat-delegation-step-repo.test.ts`
- `packages/storage/src/memory-maintenance-repo.test.ts`
- `packages/storage/src/model-usage-event-repo.test.ts`
- `packages/storage/src/tool-access-decision-repo.test.ts`
- `packages/storage/src/postgres/real-postgres.test.ts`
- `packages/storage/src/chat-session-aggregate-revision-cas.test.ts`
- `packages/storage/src/postgres-chat-session-revision-cas.test.ts`
- `packages/storage/src/storage.chat-session-delete.test.ts`
- `packages/storage/src/storage-index-tail10.test.ts`
- `packages/storage/src/storage-defensive-tail.test.ts`
- `packages/storage/src/external-source-test-fixtures.ts`
- `apps/gateway/src/services/chat-session-service.ts`
- `apps/gateway/src/services/chat-session-service.test.ts`
- `apps/gateway/src/services/chat-session-service.recents.test.ts`
- `apps/gateway/src/services/discord-runtime-bridge-service.ts`
- `apps/gateway/src/services/discord-runtime-bridge-service.contract.test.ts`
- `apps/gateway/src/services/chat-autonomous-turn-service.ts`
- `apps/gateway/src/services/chat-autonomous-turn-service.admission.test.ts`
- `apps/gateway/src/services/capability-system-service.test.ts`
- `apps/gateway/src/services/chat-attachment-service.test.ts`
- `apps/gateway/src/services/chat-generated-artifact-service.test.ts`
- `apps/gateway/src/services/chat-generated-artifact-service.vitest.test.ts`
- `apps/gateway/src/services/chat-thread-knowledge-service.test.ts`
- `apps/gateway/src/services/chat-thread-knowledge-service.vitest.test.ts`
- `apps/gateway/src/services/chat-turn-interruption-recovery-service.test.ts`
- `packages/gateway-core/src/event-ingest.test.ts`

Required semantics:

- Metadata, generation 1, and initialization evidence commit together with an explicit workspace.
- A database `AFTER INSERT` lifecycle guard creates generation 1 and initialization evidence from the exact intent, preventing metadata from committing without its control owner.
- Calls without an explicit workspace require an existing session and cannot synthesize one.
- Stable IDs compare workspace before metadata, binding, project, preference, or control mutation.
- Tree deletion discovers and deterministically locks the complete parent/side-chat tree, verifies every node is operator-owned, cancels pending requests, terminalizes control, and appends deletion evidence before content removal.
- One external, corrupt, or missing descendant rolls back the entire tree.
- Reactivation requires no live metadata/current owner, exact terminal maximum `N`, and the immutable original workspace; it creates only operator generation `N+1`.
- Filesystem cleanup is post-commit and idempotent. A crash-safe physical cleanup outbox is a separate authorization if later required.
- Long-lived mutation admissions bind workspace, session, aggregate revision, controller generation, actor, operation, and canonical material digest without storing the material.
- Metadata-less inbound transport `sessions` and `chat_messages` remain outside controllable Chat lifecycle. Ingest cannot create metadata/control, authority-bearing usage fails without exact metadata/workspace, and later controllable mutation requires explicit lifecycle initialization.
- Discord and deterministic autonomous-session creation preflight stable identity and workspace before any session mutation and commit their metadata lifecycle in one transaction.

Proof includes raw insert/delete/reuse, unknown patch/delete, cross-workspace stable-key reuse, two concurrent reactivations, raw workspace changes, zero/duplicate/orphan-current corruption, whole-tree rollback, one-active-admission races, restart recovery, transport-only exclusion, fresh and 172-to-173/114-to-115 chains, and both live dialects. Auth-revoke proof includes a deterministic delay beyond one second, 4,000-plus targets, exact timestamps, zero-target replay/concurrency, commit-without-receipt rollback, incomplete/mismatched targets, settled-context non-reuse, ordinary stale-write rejection, and legacy receipt validation.

## B: purpose-aware auth and route isolation

Writable fence:

- `packages/contracts/src/auth.ts`
- `packages/contracts/src/auth.test.ts`
- `packages/contracts/src/companion-auth.ts`
- `packages/contracts/src/companion-auth.test.ts`
- `apps/gateway/src/services/device-access-helpers.ts`
- `apps/gateway/src/services/companion-auth-helpers.ts`
- `apps/gateway/src/services/companion-auth-helpers.test.ts`
- `apps/gateway/src/services/settings-auth-service.ts`
- `apps/gateway/src/services/settings-auth-service.test.ts`
- `apps/gateway/src/services/settings-auth-service.loop32.test.ts`
- `apps/gateway/src/services/auth-admin-route-service.ts`
- `apps/gateway/src/services/auth-admin-route-service.test.ts`
- `apps/gateway/src/services/gateway-route-composition-shared.ts`
- `apps/gateway/src/services/gateway-route-composition-runtime.ts`
- `apps/gateway/src/services/gateway-route-composition-runtime.test.ts`
- `apps/gateway/src/services/gateway-runtime-factory.ts`
- `apps/gateway/src/services/gateway-service.ts`
- `apps/gateway/src/services/gateway-service.loop13-facade.test.ts`
- `apps/gateway/src/plugins/auth.ts`
- `apps/gateway/src/plugins/auth.test.ts`
- `apps/gateway/src/plugins/auth.loopback-recovery.security.test.ts`
- `apps/gateway/src/routes/route-access.ts`
- `apps/gateway/src/routes/route-access.test.ts`
- `apps/gateway/src/routes/auth.ts`
- `apps/gateway/src/routes/auth.test.ts`
- `apps/gateway/src/routes/privileged-auth.test.ts`
- `apps/gateway/src/routes/integrations-test-fixtures.ts`

The request, approved grant, companion session, exchange/refresh response, and authenticated projection carry the stored immutable purpose. Inputs cannot broaden purpose during approval, exchange, or refresh.

Add access classes:

- `device-session-exchange`
- `session-control-companion`
- `operator-or-session-control-companion`

The central purpose guard runs before the access-class switch and before signed-request replay persistence. A purpose-bound device can use only exact session exchange. A purpose-bound companion can use only the two control classes. Generic device, companion, authenticated-read, SSE-read, default, unrelated, and unscoped routes reject it. Public routes ignore attached bearer authority.

Auth revocation accepts explicit idempotency/correlation, calls C0/C inside the auth transaction, and marks the HTTP mutation complete only with the canonical commit. No session-control route is registered here.

## C: production-dark control owner

Writable fence:

- `apps/gateway/src/services/session-control-service.ts` (new)
- `apps/gateway/src/services/session-control-service.test.ts` (new)
- `apps/gateway/src/services/session-control-runtime-owner.ts` (new)
- `apps/gateway/src/services/session-control-runtime-owner.test.ts` (new)

The storage-keyed runtime owner supplies one stateless domain service for B and D without route registration. It owns request, handoff, heartbeat, stale, reconnect, release, revoke, takeover, identity classification, auth-binding revoke, synchronous mutation admission, durable long-lived admission, admission lookup, restart recovery, and final pre-side-effect/pre-commit fence classification.

Canonical digests change for content, structured parts, attachment references, and context references while persisting none of those values. No database transaction remains open across provider, tool, command, filesystem, or stream work.

## D: universal mutation and late-callback fence

### D0 classifier

- `apps/gateway/src/services/session-mutation-classification.ts` (new)
- `apps/gateway/src/services/session-mutation-classification.test.ts` (new)
- `apps/gateway/src/services/session-mutation-source-inventory.test.ts` (new)

Every source is classified as synchronous authority mutation, long-lived turn mutation, external-effect dispatch, authority-bearing callback/result, allowed actual-attempt evidence, operator approval exemption, advisory/read-only, or forbidden/unclassified. Any new/unclassified source fails the inventory gate.

### D1 synchronous composition

- `apps/gateway/src/services/gateway-route-composition-chat.ts`
- `apps/gateway/src/services/gateway-route-composition-chat.test.ts`

Fence existing Chat mutation facades without reopening A-owned lifecycle files. A direct internal bypass requires an explicit allowlist widening and a new review.

### D2 turn and durable callbacks

Writable owners are the Chat turn type/collaborator/host, entry, prep, dispatch, durable-run, stream, agent-runner, post-commit, and interruption-recovery modules plus focused integration tests named in the parent HX-411 packet. The tranche commits a durable admission before work, fences before dispatch, and fences again before every authority-bearing result.

If generation changes after an actual attempt, GoatCitadel preserves HX-305 effect truth and HX-306 actual usage/cost, never redispatches, blocks assistant content/tool result/artifact/transcript/normal terminal mutation, and appends only content-free late classification evidence.

### D3 other long-lived work

Attachment, workbench, thread-knowledge, generated/tool artifact, delegation, proactive, compaction-breaker, message-runtime, and post-commit-effect owners receive the same admission and late-fence semantics in separate bounded slices.

## Named proof

Add `verify:session-control` through:

- `package.json`
- `scripts/verification/run.mjs`
- `scripts/verification/lib/scenarios.mjs`
- `scripts/verification/lib/scenarios/session-control-lane.mjs` (new)

The lane combines storage parity, purpose-auth matrix, restart/worker-move recovery, shared-host drain, mutation classification, and late-callback proof. External routes, streams, CLI, and UI remain HOLD until this lane and the parent packet's browser/content-leak requirements pass.

## Non-goals

No external control route registration, CLI, UI, new Chat surface, steer capability, generic auth token, payload/content storage, second mutation owner, transaction held across external work, inferred operator ownership, erased HX-305/HX-306 evidence, automatic redispatch, migration sharing, or release claim.
