# HX-402 Remaining Producer Audit

Date: 2026-07-14
Status: architecture SHIP; runtime remains PARTIAL / HOLD
Audited base: `70bb46facea606a4d2fcbc91d150cd766e91bf6b`
Migration allocation: none

## Decision

The Journey read model is safe as an experimental, read-only projection, and several canonical producer slices are already complete. The row is not release-complete because the approved memory-item producer is production-dark and several structured-memory, skill/capability, improvement, and external-source mutations still lack one immutable approval/source/Journey owner.

Journey remains a projection. It may never activate a skill, promote a candidate, trust memory, or make a capability callable.

## Live producer matrix

| Producer | Verdict | Current authority truth |
| --- | --- | --- |
| HX-401 learning evidence, inactive candidate, review-only proposal | SHIP | Evidence, candidate/proposal linkage, and Journey commit together; correction provenance and no-promotion posture are explicit. |
| Approval resolution and terminal effect settlement | SHIP | Canonical resolution/effect state and Journey commit atomically. |
| HX-413 review/install/update/rollback/revoke | SHIP | Immutable snapshots, byte/audit/permission checks, approval linkage, rollback, and revoke are canonical. Legacy import must not duplicate this owner. |
| HX-407 dry-run and read-only import settlement | SHIP | Plan/settlement and Journey share the repository transaction. |
| Approved memory-item mutation | Production-dark SHIP | The producer passes its focused proof, but live patch/forget/batch routes still use unapproved branches and no recovered `memory.lifecycle` approval effect invokes it. |
| Structured and learned/session memory | HOLD | Structured history is sequential; learning/candidate rows can become authority without one immutable approved lifecycle source. |
| Runtime skill state and direct capability lifecycle | HOLD | State/CAS primitives exist, but direct routes lack a canonical actor/scope/approval/source/Journey transaction. |
| Legacy executable skill import | HOLD; retire/redirect | `confirmHighRisk` is not approval and filesystem publication is not recoverable immutable authority. |
| Improvement activate/pause/rollback | HOLD | External callbacks and database/audit state are not recoverable as one intent/inspection/settlement state machine; later mutations reuse stale approval. |
| HX-407 config/scan/attachment/knowledge producers | HOLD | The storage foundation exists, but the remaining production mutations do not all commit their required Journey source or recovered knowledge effect. |

## Ordered implementation plan

### P0: shared immutable lifecycle foundation

Wait for HX-411's exclusive SQLite 173 / PostgreSQL 115 pair to commit. Then run a fresh physical-head and reservation scan and reserve one later pair; this packet does not assume `174/116`.

Add a bounded governed-mutation contract, typed approval-effect kinds, one immutable lifecycle source for memory and direct skill/capability transitions, and a separate durable improvement intent/settlement owner. Both dialects require no-update/no-delete guards, exact replay versus same-ID/different-material conflict, and transactional Journey coupling.

Writable fence:

```text
packages/contracts/src/governed-mutations.ts                         NEW
packages/contracts/src/governed-mutations.test.ts                    NEW
packages/contracts/src/approvals.ts
packages/contracts/src/approvals.test.ts
packages/contracts/src/journey.ts
packages/contracts/src/index.ts
packages/storage/src/governed-lifecycle-event-repo.ts                NEW
packages/storage/src/governed-lifecycle-event-repo.test.ts           NEW
packages/storage/src/improvement-lifecycle-operation-repo.ts         NEW
packages/storage/src/improvement-lifecycle-operation-repo.test.ts    NEW
packages/storage/src/governance-journey-event-repo.ts
packages/storage/src/governance-journey-event-repo.test.ts
packages/storage/src/journey-producer-schema-parity.test.ts          NEW
packages/storage/src/index.ts
packages/storage/src/sqlite.ts
packages/storage/src/sqlite/governed-lifecycle-schema.ts             NEW
packages/storage/src/sqlite/migration-registry.ts
packages/storage/src/sqlite-migration-versioning.test.ts
packages/storage/src/postgres/migrations.ts
packages/storage/src/postgres-migration-integrity.test.ts
```

Gate: fresh-chain SQLite and live PostgreSQL prove immutability, scope/linkage, replay/conflict, and rollback on Journey failure. Live PostgreSQL is not an optional release skip.

### P1: complete memory authority

Every operator mutation creates a canonical `memory.lifecycle` approval. Only its recovered effect may call the existing approved producer after revalidating exact approval/linkage/actor/expiry/request hash/expected state/current policy. Remove or make private unapproved patch/forget/batch branches. Scheduled maintenance gets module-private system authority that route inputs cannot mint.

In the same tranche, make structured record/history/Journey atomic; keep extraction, trace, and session candidates evidence-only until approval; preserve explicit correction provenance; and harden immutable memory history in both dialects.

Writable fence:

```text
apps/gateway/src/services/memory-lifecycle-service.ts
apps/gateway/src/services/memory-item-helpers.ts
apps/gateway/src/services/memory-journey-producer.ts
apps/gateway/src/services/memory-journey-producer.test.ts
apps/gateway/src/services/memory-domain-journey-producer.ts           NEW
apps/gateway/src/services/memory-domain-journey-producer.test.ts      NEW
apps/gateway/src/services/chat-learned-memory-service.ts
apps/gateway/src/services/memory-maintenance-service.ts
apps/gateway/src/services/memory-maintenance-service.test.ts
apps/gateway/src/services/memory-route-service.ts
apps/gateway/src/services/memory-route-service.test.ts                NEW
apps/gateway/src/services/memory-lifecycle-service.test.ts
apps/gateway/src/services/memory-lifecycle-service.bulk-forget.test.ts
apps/gateway/src/services/memory-lifecycle-service.postgres-dialect.test.ts
apps/gateway/src/services/memory-lifecycle-service.real-postgres.test.ts
apps/gateway/src/routes/memory.ts
apps/gateway/src/routes/memory.test.ts
apps/gateway/src/routes/memory.forget-commit-truth.test.ts
apps/gateway/src/tui/api-client.ts
apps/gateway/src/tui/main.ts
apps/gateway/src/tui/main.loop28.test.ts
packages/storage/src/learned-memory-repo.ts
packages/storage/src/learned-memory-repo.test.ts
packages/mission-control-shared/src/api/memory.ts
packages/mission-control-shared/src/api/memory-lifecycle.test.ts       NEW
packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts
packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.test.tsx
apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx
apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.approvals.test.tsx NEW
apps/mission-control-next/src/features/native-routes/library/MemoryBatchToolbar.tsx
```

Gate: no durable mutation before approval; denial/expiry is a zero mutation; replay returns original IDs; material drift conflicts; no-op emits nothing; batches are atomic; neither Journey nor candidate creation promotes memory.

### P2: retire legacy import and govern skill/capability state

Keep legacy validation advisory but redirect executable install into HX-413. Fresh approval governs operator enable/disable/sleep/auto/policy and direct promote/revoke/rollback. A fail-safe internal disable/revoke may bypass approval only through unforgeable module authority while still writing the canonical source and Journey. Review-only proposal creation stays approval-free only if proposal/source/Journey are one transaction and remain non-callable.

Writable fence:

```text
apps/gateway/src/services/skill-state-service.ts
apps/gateway/src/services/skill-state-service.test.ts
apps/gateway/src/services/skill-import-service.ts
apps/gateway/src/services/skill-import-service.test.ts
apps/gateway/src/services/skill-import-service.loop29.test.ts
apps/gateway/src/services/skill-import-service.loop35.test.ts
apps/gateway/src/services/skill-import-service.loop41.test.ts
apps/gateway/src/services/skill-import-service.loop42.test.ts
apps/gateway/src/services/capability-system-service.ts
apps/gateway/src/services/capability-system-service.test.ts
apps/gateway/src/services/capability-system-service.skill-scope.test.ts
apps/gateway/src/services/skill-governance-journey-producer.ts         NEW
apps/gateway/src/services/skill-governance-journey-producer.test.ts    NEW
apps/gateway/src/services/skills-route-service.ts
apps/gateway/src/services/skills-route-service.test.ts
apps/gateway/src/services/capabilities-route-service.ts
apps/gateway/src/services/capabilities-route-service.test.ts           NEW
apps/gateway/src/services/chat-command-service.ts
apps/gateway/src/services/chat-command-service.test.ts
apps/gateway/src/routes/skills.ts
apps/gateway/src/routes/skills.test.ts
apps/gateway/src/routes/capabilities.ts
apps/gateway/src/routes/capabilities.test.ts
packages/mission-control-shared/src/api/skills.ts
packages/mission-control-shared/src/api/skills-lifecycle.test.ts        NEW
packages/mission-control-shared/src/api/capabilities.ts
packages/mission-control-shared/src/api/capabilities-lifecycle.test.ts  NEW
apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.tsx
apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.test.ts
```

Regression gates: `verify:skill-learning` and `verify:skill-hub:lifecycle`; legacy install cannot publish bytes, alter callability, or write a competing lifecycle claim.

### P3: recoverable improvement lifecycle

Fresh approval creates an exact intent. A worker claims and revalidates it, executes the external callback, re-inspects exact external state, then commits activation/candidate state, immutable settlement, canonical signal, and Journey together. Crash recovery resumes from intent and never infers success from an attempted callback. Pause and rollback require fresh approval.

Writable fence:

```text
apps/gateway/src/services/improvement-service.ts
apps/gateway/src/services/improvement-service.test.ts
apps/gateway/src/services/improvement-service.postgres-dialect.test.ts
apps/gateway/src/services/improvement-service.runtime.test.ts
apps/gateway/src/services/improvement-service-active-update.ts
apps/gateway/src/services/improvement-snapshot-service.ts
apps/gateway/src/services/improvement-lifecycle-journey-producer.ts      NEW
apps/gateway/src/services/improvement-lifecycle-journey-producer.test.ts NEW
apps/gateway/src/services/improvement-route-service.ts
apps/gateway/src/services/improvement-route-service.test.ts
apps/gateway/src/routes/improvement.ts
apps/gateway/src/routes/improvement.test.ts
packages/mission-control-shared/src/api/improvement.ts
packages/mission-control-shared/src/api/improvement-lifecycle.test.ts    NEW
```

Proof injects crashes before/after callback, inspection, settlement, signal, and Journey; rejects stale/original approval reuse; covers exact replay, competing workers, failed compensation, and zero false applied/rolled-back claims.

### P4: close HX-407's producer matrix

Extend the existing owner. Config/root/scan commits Journey in its transaction; attach/detach commits with attachment CAS and Journey; the knowledge request creates a real approval; and only the recovered effect may commit the exact knowledge document/chunks, link, optional normal attachment, and Journey. This tranche needs no new HX-407 migration.

Writable fence:

```text
packages/storage/src/external-source-config-repo.ts
packages/storage/src/external-source-scan-repo.ts
packages/storage/src/external-session-attachment-repo.ts
packages/storage/src/external-source-config-scan-repo.test.ts
packages/storage/src/external-source-import-attachment-repo.test.ts
apps/gateway/src/services/external-source-service.ts
apps/gateway/src/services/external-source-service.test.ts
apps/gateway/src/services/external-source-scan-service.ts
apps/gateway/src/services/external-source-scan-service.test.ts
apps/gateway/src/services/external-source-journey-producer.ts
apps/gateway/src/services/external-source-journey-producer.test.ts
apps/gateway/src/services/external-source-route-service.ts
apps/gateway/src/services/external-source-attachment-service.ts         NEW
apps/gateway/src/services/external-source-attachment-service.test.ts    NEW
apps/gateway/src/services/external-source-knowledge-effect-service.ts   NEW
apps/gateway/src/services/external-source-knowledge-effect-service.test.ts NEW
apps/gateway/src/services/chat-thread-knowledge-service.ts
apps/gateway/src/services/chat-thread-knowledge-service.test.ts
apps/gateway/src/routes/external-sources.ts
apps/gateway/src/routes/external-sources.test.ts
apps/gateway/src/routes/external-source-attachments.ts                  NEW
apps/gateway/src/routes/external-source-attachments.test.ts             NEW
packages/mission-control-shared/src/api/external-sources.ts             NEW
packages/mission-control-shared/src/api/external-sources.test.ts        NEW
```

### P5: shared wiring and release proof

One integration owner wires approval effects and composition after every domain contract freezes. Add `verify:journey:producers` and `verify:external-sources`; the former runs both dialects, the complete producer matrix, approval recovery, skill learning/lifecycle, durable recovery, typechecks, docs, formatting, and diff checks.

Shared writable fence:

```text
packages/storage/src/approval-effect-repo.ts
packages/storage/src/approval-effect-repo.test.ts
packages/mission-control-shared/src/api/client.ts
apps/gateway/src/services/approval-resolution-effects-service.ts
apps/gateway/src/services/approval-resolution-effects-service.test.ts
apps/gateway/src/services/gateway-service.ts
apps/gateway/src/services/gateway-service.learned-memory.test.ts
apps/gateway/src/services/gateway-route-services.ts
apps/gateway/src/services/gateway-route-composition-port.ts
apps/gateway/src/services/gateway-route-composition-memory.ts
apps/gateway/src/services/gateway-route-composition-chat.ts
apps/gateway/src/services/gateway-route-composition-integrations.ts
apps/gateway/src/services/gateway-route-composition-runtime.ts
scripts/verification/journey-producers-proof.mjs                       NEW
scripts/verification/external-sources-proof.mjs                        NEW
package.json
docs/review/HX_402_JOURNEY_PRODUCER_PACKET_2026-07-13.md
docs/OPENCLAW_HERMES_PARITY_PROGRAM.md
```

## Non-negotiable invariants

- Canonical mutation, immutable source/history, and Journey share one database transaction.
- External effects use intent/inspection/settlement recovery and are never described as database-atomic.
- Every event declares `sourceRequired` and `approvalRequired` explicitly.
- Approval-required mutations carry the actual current approval ID; state labels never imply approval.
- Fingerprints use versioned canonical material and hashes, never raw protected content.
- Exact replay returns the original event; the same identity with different material conflicts.
- Missing workspace/session/actor scope is never replaced with an inferred default.
- Same-session repetition does not strengthen recurrence; blocked or conflicting source evidence stays poisoned.
- Proposed memory and skill candidates remain inactive and review-only.
- Chat and the existing approval infrastructure remain the mutation surface; no Cowork or Code surface is added.
