# HX-407 Closure Packet

Date: 2026-07-14  
Status: architecture SHIP; runtime HOLD behind HX-411 and proof gates  
Committed storage foundation: SQLite 166 / PostgreSQL 108  
Migration posture: no new migration is required or reserved

## Decision

The existing HX-407 schema already owns durable external-source attachment and recovered-knowledge records. Close the remaining row in four migration-free, dependency-ordered tranches. Only the final integrated tranche may remove the proof-only production gate or claim row completion.

The current runtime still requires both a non-production environment and `GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED=1`. That gate remains until C1-C3 are committed and C4 proves the production composition without it.

## C1 - attachment and read-only Chat context core

Status: smallest independently shippable production-dark tranche after HX-411.

Owners:

- `packages/contracts/src/external-sources.ts`
- `packages/contracts/src/external-sources.test.ts`
- `packages/contracts/src/routed-context.ts`
- `packages/contracts/src/approvals.ts`
- `packages/contracts/src/approvals.test.ts`
- `packages/storage/src/external-session-attachment-repo.ts`
- `packages/storage/src/external-source-import-attachment-repo.test.ts`
- `packages/storage/src/routed-context-snapshot-repo.ts`
- `packages/storage/src/routed-context-snapshot-repo.test.ts`
- `apps/gateway/src/services/external-source-journey-producer.ts`
- `apps/gateway/src/services/external-source-journey-producer.test.ts`
- `apps/gateway/src/services/external-source-attachment-service.ts` (new)
- `apps/gateway/src/services/external-source-attachment-service.test.ts` (new)
- `apps/gateway/src/services/chat-routed-context-service.ts`
- `apps/gateway/src/services/chat-routed-context-service.test.ts`
- `apps/gateway/src/services/chat-turn-prep-service.routed-context.test.ts`

C1 adds strict attach/list/detach/knowledge-request contracts, an `external_attachment` routed-context kind, and exact effect/target vocabulary. Attach and detach commit with content-free Journey evidence. Every operation rechecks applied import, managed CAS, workspace, session incarnation, attachment revision, and exact source/import/item/artifact identity. Selected external bytes and provenance are frozen into the HX-307 snapshot before provider use. No operation promotes content into knowledge, memory, a skill, or a callable capability.

## C2 - governed recovered-knowledge effect

Status: production-dark and independently committable after C1.

Owners, both new:

- `apps/gateway/src/services/external-source-knowledge-effect-service.ts`
- `apps/gateway/src/services/external-source-knowledge-effect-service.test.ts`

C2 creates a real deterministic approval over exact session incarnation, attachment, source/import/item/artifact identity, and bounded expiry. Approved recovery reopens and re-hashes the managed artifact, re-evaluates deny-wins policy, revalidates actor/expiry/attachment/import identity under one transaction, and materializes the deterministic knowledge document, chunks, link, optional thread attachment, and Journey record. Replay, concurrency, crash recovery, denial, expiry, revoke, and policy-flip behavior fail closed. It does not call the public ingest shortcut.

## C3 - typed Library and Chat controls

Status: may develop against C1 contracts in parallel with C2; cannot be called shipped before C4.

Owners:

- `packages/mission-control-shared/src/api/external-sources.ts` (new)
- `packages/mission-control-shared/src/api/external-sources.test.ts` (new)
- `apps/mission-control-next/src/features/native-routes/library/LibraryExternalSourcesSection.tsx` (new)
- `apps/mission-control-next/src/features/native-routes/library/LibraryExternalSourcesSection.test.tsx` (new)
- `apps/mission-control-next/src/features/native-routes/library/LibraryKnowledgeSection.tsx`
- `apps/mission-control-next/src/styles/07-settings-library.css`
- `packages/threaded-surface-core/src/chat/useExternalSourceAttachments.ts` (new)
- `packages/threaded-surface-core/src/chat/useExternalSourceAttachments.test.tsx` (new)
- `packages/threaded-surface-core/src/chat/useChatSurfaceOrchestration.ts`
- `packages/threaded-surface-core/src/chat/useChatSurfaceOrchestration.test.tsx`
- `packages/threaded-surface-core/src/chat/useChatOutboundExecution.ts`
- `packages/threaded-surface-core/src/chat/useChatOutboundExecution.test.tsx`
- `packages/threaded-surface-core/src/chat/MissionControlActiveSessionSurface.tsx`
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.test.tsx`
- `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx`
- `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx`
- `apps/mission-control-next/src/styles/composer.css`

Library owns registration, scanning, catalog inspection, dry run, apply, and provenance. Chat owns durable attach/list/detach, explicit per-turn selection, queue-frozen context references, read-only chips, and a governed knowledge request. Selection clears only after successful send. No raw JSON or direct knowledge/memory mutation enters the UI.

## C4 - composition, production promotion, and proof

Status: final row-closing tranche after C1-C3.

Owners:

- `apps/gateway/src/services/external-source-route-service.ts`
- `apps/gateway/src/services/external-source-route-service.test.ts` (new)
- `apps/gateway/src/routes/external-sources.ts`
- `apps/gateway/src/routes/external-sources.test.ts`
- `apps/gateway/src/services/approval-resolution-effects-service.ts`
- `apps/gateway/src/services/approval-resolution-effects-service.test.ts`
- `apps/gateway/src/services/gateway-service.ts`
- `apps/gateway/src/app.ts`
- `apps/gateway/src/external-sources.integration.test.ts`
- `apps/gateway/src/external-sources-closure.integration.test.ts` (new)
- `packages/storage/src/external-source-closure-repo.postgres.test.ts` (new)
- `scripts/verification/external-sources-proof.mjs` (new)
- `scripts/verification/lib/scenarios/external-sources-lane.mjs` (new)
- `scripts/verification/lib/scenarios/external-sources-lane.test.mjs` (new)
- `package.json`

C4 composes route, attachment, effect, recovery, policy, and HX-307 owners. It adds `GET /api/v1/chat/sessions/:sessionId/external-source-attachments?workspaceId=...` so clients can durably reload content-free attachment truth. Knowledge requests carry identifiers and expected attachment revision; the server derives every hash. C4 removes the proof-only production gate and proves the production runtime works without the environment flag.

Row completion requires one committed SHA with:

- isolated-schema live PostgreSQL replay and concurrency proof;
- the complete Library-to-Chat selection/send/approval-recovery browser path;
- light/dark desktop and mobile coverage;
- `pnpm verify:external-sources` green.

`GOATCITADEL_TEST_POSTGRES_URL` is currently unset. That condition is an explicit C4 HOLD, not an accepted skip.

## Exclusions

No new migration, client-supplied artifact hash, public ingest shortcut, direct knowledge/memory/skill/capability promotion, raw external transcript body in Journey, second Chat surface, or premature production-gate removal enters this closure.
