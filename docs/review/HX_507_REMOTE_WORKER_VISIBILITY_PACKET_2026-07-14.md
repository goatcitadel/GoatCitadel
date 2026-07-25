# HX-507 Remote Worker Visibility Packet

Date: 2026-07-14
Status: architecture SHIP for a no-migration Ops and one-Chat visibility tranche; implementation HOLD pending live HX-501 admission/listener authority and HX-502/HX-504 assignment/event composition

## Boundary

HX-507 adds operator-visible remote-worker registry, detail, assignment, event, reconciliation, and control projections in Ops, plus session/turn-bound remote-worker activity inside the existing Chat background rail. It does not create a second conversation surface, scheduler, listener, state machine, event stream, cost ledger, approval system, or client-side authority.

The implementation consumes rather than recreates:

- HX-501 admission identity, worker generation, attestation, workspace ceiling, quarantine, revoke, and control revision;
- HX-502 assignment generation, lease, cancellation, and recovery authority;
- HX-504 ordered event, watermark, settlement, and materialization truth;
- HX-503 exact assignment-to-HX-306 usage/cost references;
- HX-505 resource-cell, capacity, liveness, cleanup, and diagnostics truth;
- HX-506 artifact, verification, effect, and reconciliation truth;
- canonical Gateway auth, rate limiting, mutation intent, idempotency, approvals, audit, and retained realtime owners; and
- the existing one-Chat `DurableBackgroundTaskRail` and Mission Control Ops navigation.

Missing downstream owners remain explicitly `unavailable`. HX-507 never projects `$0`, healthy, clean, completed, or operator-owned from absent evidence.

## Authority contract

Every response section carries a server-authored truth descriptor:

```ts
type RemoteWorkerTruth<T> = {
  value: T | null;
  authorityClass: "canonical_record" | "derived_projection" | "retained_signal" | "unavailable";
  owner: string;
  observedAt: string;
  staleAfter?: string;
  caveat?: string;
};
```

Clients may format this descriptor but cannot infer, upgrade, or replace it.

| Section | Authority |
|---|---|
| Admission identity, generation, hashes, ceilings, and attestation receipt | `canonical_record` from HX-501 admission storage |
| Quarantine/revoke state and control revision | `canonical_record` from HX-501 generation control |
| Assignment, generation, lease, controls, and watermarks | `canonical_record` from HX-502/HX-504 storage |
| Online, lease-fresh, and derived-health labels | `derived_projection` from canonical database timestamps plus Gateway clock |
| Redacted diagnostics and event summaries | `derived_projection` from canonical ordered events |
| Realtime notifications | `retained_signal` used only to invalidate and refetch |
| Usage and cost | canonical HX-306 records aggregated only through HX-503 exact event references |
| Resource cell and cleanup | HX-505 canonical owner, otherwise `unavailable` |
| Artifacts, verification, effects, and materialization | HX-506 canonical owner, otherwise `unavailable` |
| Rotation, recovery, or cleanup execution | the dedicated effect owner, never approval creation alone |

The existing `RuntimeAuthorityProjection` remains a summary surface. It does not become the remote-worker registry and cannot perform client-side joins.

## Operator API

All routes are operator-only, workspace-scoped, and return `Cache-Control: no-store`, `Pragma: no-cache`, and `Vary: Authorization`. Worker credentials, device/companion identities, and unauthenticated callers are denied. Cross-workspace ID collisions return `404` without existence disclosure.

### Reads

- `GET /api/v1/ops/workspaces/:workspaceId/remote-workers`
  - `limit` defaults to 25 and is capped at 100.
  - Optional `cursor`, `posture`, and `capabilityClass` bind one stable filter set.
  - Order is `workerId ASC`; the opaque versioned cursor binds workspace, filters, and last worker ID.
- `GET /api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId`
  - `assignmentLimit` defaults to 20 and is capped at 100.
  - Optional `assignmentCursor` returns admission/control, capabilities, derived health, bounded assignments, usage availability, reconciliation, diagnostics, resource-cell, artifact/effect, and cleanup sections.
- `GET /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments`
  - Optional exact `workerId`, `sessionId`, and `turnId` filters; `limit` defaults to 20 and is capped at 100.
  - Order is `(createdAt DESC, assignmentId DESC)` with an opaque workspace/filter-bound cursor.
  - Storage lineage, never caller assertion, decides session/turn membership.
- `GET /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/events`
  - `afterSequence` defaults to 0; `limit` defaults to 50 and is capped at 200.
  - Returns ordered sanitized summaries and `nextAfterSequence`.
  - Transcript deltas, tool arguments/results, terminal output, paths, and raw diagnostics are omitted; omitted counts are explicit.
- `GET /api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/reconciliation`
  - Read-only comparison of admission/control, assignment/lease, resource-cell, settlement/materialization, and cleanup owners.

### Mutations

Every mutation requires `Idempotency-Key`, authenticated actor identity, exact expected generation/revision, a bounded reason code, and an optional secret-filtered note of at most 256 characters. The note is never returned; only its digest and redacted classification may persist.

- `POST .../remote-workers/:workerId/quarantine`
  - Requires exact worker generation and control revision.
  - Immediate containment with explicit confirmation; no approval delay.
- `POST .../remote-workers/:workerId/revoke`
  - Same generation/revision CAS and typed destructive confirmation.
  - Immediate and irreversible for that generation.
- `POST .../remote-worker-assignments/:assignmentId/cancel`
  - Requires exact assignment generation and lease revision.
  - Uses the canonical HX-502 cancellation owner.
- `POST .../remote-workers/:workerId/rotate`
  - Always approval-gated and returns `202 approval_required`.
  - Returns `503 owner_unavailable` until an approved effect consumer can rotate without returning or minting credentials through this route.
- `POST .../remote-worker-assignments/:assignmentId/retry-recovery`
  - Always approval-gated and resumes through the HX-502 durable recovery owner.
- `POST .../remote-worker-assignments/:assignmentId/request-cleanup`
  - Always approval-gated and generation-fenced through HX-505.
  - Never directly deletes processes, files, or worktrees.

An identical idempotent replay returns the original result. Changed material, stale revision, or changed generation conflicts with `409`. Approval creation remains pending and cannot be rendered as successful execution before canonical convergence.

Read routes are capped at 120 requests per minute per existing Gateway key, immediate mutations at 20 per minute, and approval-gated disruptive operations at 10 per minute. Stricter existing global limits still win.

## Storage seams and no-migration rule

HX-507 requires no SQLite or PostgreSQL migration and reserves no number. It adds bounded reads/CAS over existing HX-501/HX-502/HX-504 tables:

- admission: latest generation plus latest control in one workspace-scoped read, expected-control-revision quarantine/revoke, and stable filtered cursor listing;
- assignment: workspace list with optional worker/session/turn filters, aggregate detail for current generation/lease/control/settlement/materialization, bounded redacted events, and a revision-safe cancellation point read.

Any implementation that discovers a required schema change stops and returns to architecture review.

## Realtime and gap recovery

Reuse `/api/v1/events`; do not add another SSE channel. Emit only content-free invalidations:

- `remote_worker_changed`
- `remote_worker_assignment_changed`

Links may add `workerId` and `assignmentId`. Payload contains only workspace, IDs, operation, worker/assignment generation, control/lease revision, and event watermark. Labels, diagnostics, transcript, cost, hashes, and state bodies are forbidden.

Mission Control adds a `workers` refresh topic. It deduplicates by retained sequence, never treats an event payload as canonical state, coalesces bursts, and refetches only the visible registry/detail/Chat slice. A replay gap, epoch reset, invalid sequence, or scope change discards the affected cache and performs a full canonical reload. When SSE is disconnected, visible Ops polls every 15 seconds and active Chat work every 3 seconds.

## Ops experience

Add `/ops/workers` under the existing Observe group.

- Desktop uses a two-pane registry/detail layout.
- Registry rows show worker short ID, canonical posture, generation, capability summary, derived health, active assignment count, and usage availability.
- Detail groups Identity, Assignments, Usage, Diagnostics, Reconciliation, and Controls.
- Canonical, projected, retained, and unavailable labels remain text-visible and never color-only.
- Diagnostics use bounded semantic cards, not raw JSON or a raw log viewer.
- Hashes/fingerprints are shortened by default; exact canonical digests require explicit reveal/copy. Raw certificates, keys, manifests, host paths, and tokens never render.
- At 900px and below, use list-to-detail drill-in with a focus-managed Back control. At 560px and below, stack facts and use full-width actions without a horizontally scrolling primary table.

Accessibility requires correct headings, `aria-busy`, polite convergence announcements, `role=alert` failures, keyboard-operable selection/actions, focus-trapped destructive confirmation with focus restoration, Escape support, typed revoke confirmation, non-color status, no heartbeat live-region noise, 44px targets, 200% zoom, forced colors/high contrast, and reduced motion.

## One-Chat activity

Extend the existing `DurableBackgroundTaskRail`; do not add a route, mode, conversation surface, or second rail.

`RemoteWorkerInlineActivity` loads only assignments whose stored manifest matches the active workspace/session/turn. It may show worker and assignment short IDs/generations, canonical control state, explicitly derived lease freshness, sent/acknowledged/pending watermarks, sanitized phase/progress, blockers, approval references, usage/cost availability and provenance, HX-506 artifact/effect outcomes when available, and a link to Ops detail.

Chat keeps only its existing detach, reattach, cancel, and approval-navigation affordances. Rotate, quarantine, revoke, recovery, cleanup, and reconciliation management remain in Ops.

## Exact implementation allowlist

### Contracts, storage, and Gateway

- `packages/contracts/src/remote-worker-ops.ts` (new)
- `packages/contracts/src/remote-worker-ops.test.ts` (new)
- `packages/contracts/src/monitoring.ts`
- `packages/contracts/src/monitoring.test.ts`
- `packages/contracts/src/index.ts`
- `packages/storage/src/remote-worker-admission-repo.ts`
- `packages/storage/src/remote-worker-admission-repo.test.ts`
- `packages/storage/src/remote-worker-admission-repo.postgres.test.ts`
- `packages/storage/src/remote-worker-assignment-repo.ts`
- `packages/storage/src/remote-worker-assignment-repo.test.ts`
- `packages/storage/src/remote-worker-assignment-repo.postgres.test.ts`
- `apps/gateway/src/services/remote-workers-route-service.ts` (new)
- `apps/gateway/src/services/remote-workers-route-service.test.ts` (new)
- `apps/gateway/src/routes/remote-workers.ts` (new)
- `apps/gateway/src/routes/remote-workers.test.ts` (new)
- `apps/gateway/src/services/gateway-route-services.ts`
- `apps/gateway/src/services/gateway-route-service-composition.ts`
- `apps/gateway/src/services/gateway-route-composition-runtime.ts`
- `apps/gateway/src/app.ts`

### Shared client and realtime invalidation

- `packages/mission-control-shared/src/api/remote-workers.ts` (new)
- `packages/mission-control-shared/src/api/remote-workers.test.ts` (new)
- `packages/mission-control-shared/src/hooks/useRemoteWorkerRegistry.ts` (new)
- `packages/mission-control-shared/src/hooks/useRemoteWorkerRegistry.test.ts` (new)
- `packages/mission-control-shared/src/state/realtime-derived.ts`
- `packages/mission-control-shared/src/state/realtime-derived.test.ts`
- `packages/mission-control-shared/src/index.ts`
- `apps/mission-control-next/src/app/remote-worker-realtime.ts` (new)
- `apps/mission-control-next/src/app/remote-worker-realtime.test.ts` (new)
- `apps/mission-control-next/src/app/use-event-stream.ts`

### Ops and Chat

- `apps/mission-control-next/src/app/route-model.ts`
- `apps/mission-control-next/src/app/route-model.unified-surface.test.ts`
- `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx`
- `apps/mission-control-next/src/features/native-routes/ops/RemoteWorkersRoutePage.tsx` (new)
- `apps/mission-control-next/src/features/native-routes/ops/RemoteWorkersRoutePage.test.tsx` (new)
- `apps/mission-control-next/src/features/native-routes/ops/remote-workers.css` (new)
- `apps/mission-control-next/src/features/threaded-surface/RemoteWorkerInlineActivity.tsx` (new)
- `apps/mission-control-next/src/features/threaded-surface/RemoteWorkerInlineActivity.test.tsx` (new)
- `apps/mission-control-next/src/features/threaded-surface/useRemoteWorkerInlineActivity.ts` (new)
- `apps/mission-control-next/src/features/threaded-surface/useRemoteWorkerInlineActivity.test.ts` (new)
- `apps/mission-control-next/src/features/threaded-surface/DurableBackgroundTaskRail.tsx`
- `apps/mission-control-next/src/features/threaded-surface/DurableBackgroundTaskRail.test.tsx`
- `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx`
- `apps/mission-control-next/src/styles/background-task-rail.css`
- `docs/1_0_RELEASE_SURFACE_SCOPE.md`

### Release proof and closeout

- `scripts/verification/lib/release-surface-manifest.mjs`
- `scripts/verification/lib/release-surface-manifest.test.mjs`
- `scripts/verification/lib/scenarios/fixture-seeding.mjs`
- `scripts/verification/lib/scenarios/fixture-seeding.test.mjs`
- `docs/OPENCLAW_HERMES_PARITY_PROGRAM.md`

The release/fixture owners currently intersect unrelated work and require an explicit handoff before editing. No migration registry, provider, raw transport, or unrelated Mission Control wrapper is in scope.

## Implementation order and gates

1. Commit and compose HX-501/HX-502/HX-504 authority.
2. Add contracts and SQLite/live-PostgreSQL read/CAS proof with no migration.
3. Add read-only Gateway routes, parsers, auth, redaction, cursors, and content-free invalidation.
4. Add the shared client and read-only Ops registry/detail.
5. Enable immediate quarantine/revoke/cancel only after live authority composition.
6. Enable rotation/recovery/cleanup only with their approval-resume effect owners.
7. Add exact session/turn activity inside the existing Chat rail.
8. Integrate HX-503/HX-505/HX-506 truth sections as their owners become live.
9. Run browser, accessibility, surface, visual, and integrated remote-worker proof before changing public claims.

Proof covers strict parsers/bounds/cursors; SQLite/live-PostgreSQL cross-workspace and CAS behavior; operator/worker/device/companion auth; no-store/rate-limit/mutation-intent/idempotency semantics; redaction; retained-event duplicates/out-of-order/gaps/scope changes; unavailable states; exact Chat lineage; keyboard/focus/high-contrast/reduced-motion/zoom/mobile behavior; and two-machine mTLS admission through revoke/recovery/cleanup.

Required lanes include focused package tests/typechecks, `pnpm verify:auth:matrix`, `pnpm verify:api:compat`, `pnpm verify:runtime:truth`, `pnpm verify:surface:regression`, `pnpm verify:visual:regression`, `pnpm docs:check`, `git diff --check`, and the integrated `pnpm verify:remote-workers` lane.

## Non-goals

No new Chat/Cowork/Code surface; second scheduler/listener/state machine/event stream/cost ledger/approval system; client-side canonical joins; remote shell; process or filesystem browser; raw log or JSON viewer; prompt/transcript/tool/terminal/provider/path/token/key/certificate/manifest exposure; direct credential rotation; automatic retry/cleanup/capability widening; cross-workspace inspection; inferred health, cost, cleanup, completion, or ownership; migration; or release claim.
