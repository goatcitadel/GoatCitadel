# HX-506 Remote Worker Settlement Packet

Date: 2026-07-14
Status: architecture SHIP for a production-dark artifact, verification, and effect-settlement tranche; implementation HOLD pending a committed clean base, fresh migration allocation, and live dependency ports

## Boundary

HX-506 owns remote-worker upload parts, immutable artifact manifests, Gateway-trusted verification evidence, remote effect intents, and correlations to canonical effect outcomes for one exact assignment generation. It consumes rather than recreates:

- HX-501 admitted worker/runtime identity and listener-issued request authority;
- HX-502 assignment generation, lease, cancellation, and settlement authority;
- HX-504 ordered worker progress events;
- HX-505 capacity, staging, liveness, and cleanup accounting;
- HX-305 canonical tool/effect outcome truth;
- HX-306 provider-attempt usage and cost truth; and
- HX-411 current session-control generation for session-linked late commits.

Workers never become artifact, verifier, policy, approval, effect, usage, session, or settlement authorities. A stale worker may read an exact committed receipt, but cannot append a part, commit a manifest, satisfy verification, dispatch an effect, mutate Chat, or settle an assignment. If an external effect crossed the real boundary before authority was lost, Gateway still records the factual canonical outcome or ambiguity without granting a retry.

## Reuse and gaps

The current assignment owner already binds workspace, worker/runtime generation, assignment generation, immutable profile/manifest hashes, artifact ceiling, effect posture, path jail, database-clock lease, and parent authority. Its settlement accepts `outputManifestSha256`, but it cannot yet prove that digest names an HX-506 manifest for the same generation.

Existing Chat tool/generated artifact rows are mutable or thin projections and lack assignment generation, part identity, immutable publication, verification provenance, and replay/CAS authority. The existing external-source CAS contributes algorithms—exclusive owner-only staging, retained-handle revalidation, digest/read-back, fsync, atomic no-replace installation, same-hash convergence, and fail-closed cleanup—but its namespace and source-specific records are not reusable.

The canonical external-effect runner and tool coordinator remain the live effect owners. HX-506 stores a remote intent before policy/delivery, passes generation fences into those owners, and records only exact correlations to their approval, boundary, HX-305, and reconciliation evidence. It does not extend `external_side_effect_runs` into a worker upload or intent store, accept result-body receipt claims, or recalculate HX-306 usage/cost.

## Paired migration

A new paired SQLite/PostgreSQL migration is required. This packet allocates no number. The migration is additive and forward-only, creates no content backfill, and aborts if an existing completed remote assignment settlement cannot be proven against a canonical manifest.

It adds nine tables:

1. `remote_worker_artifact_uploads`
2. `remote_worker_artifact_parts`
3. `remote_worker_artifact_blobs`
4. `remote_worker_artifact_manifests`
5. `remote_worker_artifact_manifest_entries`
6. `remote_worker_artifact_verifications`
7. `remote_worker_effect_intents`
8. `remote_worker_effect_transitions`
9. `remote_worker_effect_receipts`

Every table binds registry workspace, execution workspace, assignment ID/generation, worker ID/generation, assignment/runtime manifest hashes, and applicable profile/posture hashes. Child rows use composite foreign keys to a full-identity unique key on `remote_worker_assignment_generations`.

Parts, blobs, manifests, entries, intents, and transitions are insert-only. Both dialects reject their update/delete. Upload, verifier-attempt, cleanup, and receipt mutations require an expected revision and, where claimed, the exact database-clock claim generation.

Assignment settlement with an output manifest fails unless the exact assignment-generation manifest exists, its upload is committed, verification is `not_required` or `satisfied`, every effect intent has a current receipt, and no receipt remains in manual reconciliation.

## State machines

```text
upload: open -> assembling -> committed
        open|assembling -> abandoned
        open|assembling -> quarantined

cleanup: not_due -> pending -> cleaned
                            -> manual_reconciliation

verification attempt: worker_reported
                      queued -> running -> passed
                                           -> failed
                                           -> indeterminate
                                           -> blocked

verification gate: not_required
                   pending -> satisfied

effect transition:
recorded -> approval_wait -> dispatch_claimed -> external_boundary_started
         -> blocked_before_dispatch
         -> failed_before_boundary
         -> completed_no_effect
         -> completed_with_effect
         -> manual_reconciliation -> manual_reconciliation_resolved

effect receipt: blocked_before_dispatch
                failed_before_boundary
                completed_no_effect
                completed_with_effect
                manual_reconciliation
```

Worker-reported verification is evidence only and never satisfies the gate, including when the worker advertises `trusted_verification`. A crashed running verifier becomes `indeterminate`; retry creates a new explicit attempt. Only a Gateway-owned verifier profile against immutable CAS bytes may advance `pending` to `satisfied`.

One effect receipt row exists per intent under exact revision CAS. Only a manual-reconciliation receipt may later advance, and only from an operator-backed canonical external-effect reconciliation record.

## Frozen bounds

- one active upload and at most four upload attempts per assignment generation;
- at most 64 files and 64 MiB total, further capped by the assignment's `maxArtifactBytes`;
- 256 KiB maximum raw part; every non-final part is exactly 256 KiB, every final part is 1-256 KiB, and zero-byte files have zero parts;
- at most 320 parts in one global contiguous sequence and one part per signed request;
- canonical unpadded base64url part bodies below the existing 512 KiB PoP body ceiling;
- 64 KiB maximum canonical manifest JSON;
- logical path at most 512 UTF-8 bytes, 32 segments, and 128 bytes per segment;
- reject absolute, UNC, drive, device, `.`/`..`, empty, control/NUL, ADS/colon, trailing-dot/space, Windows-reserved, and NFKC-lowercase-colliding paths;
- MIME at most 128 ASCII bytes without parameters; reject HTML, XHTML, SVG, and JavaScript, keep octet-stream opaque, and never extract archives;
- at most 16 worker claims and 16 Gateway verification attempts per manifest, 16 KiB evidence JSON, and 4 KiB summaries/previews;
- 15-minute maximum trusted-verifier wall time and 8 MiB combined captured output;
- at most 64 effect intents per assignment generation, 64 KiB canonical args, 16 transition events, three proven pre-boundary attempts, eight HX-305 evidence references, and 2 KiB sanitized errors;
- upload expiry is the minimum of assignment deadline, current lease expiry, and creation plus 15 minutes; no independent extension; and
- five-minute database-clock cleanup claim.

## Artifact publication and recovery

Physical paths are server-derived only:

`remote-workers/artifacts/<sha256(workspace)>/sha256/<prefix>/<blobSha256>`

Worker logical paths never become filesystem paths. Staging paths use only server-derived workspace, assignment, upload, and sequence hashes.

Each part operation verifies PoP/native listener authority, resolves exact current HX-502 authority, rechecks HX-411 when session-linked, reserves HX-505-accounted capacity, writes through exclusive owner-only no-follow staging, fsyncs and rehashes through retained handles, rechecks authority, and only then records the immutable part receipt.

Commit streams parts without buffering the full artifact; verifies every part, file, total, MIME, logical path, and canonical manifest; then fsyncs and atomically installs CAS objects without replacement. Existing objects converge only after full retained-handle verification. The final database transaction re-locks assignment authority before blob rows, manifest/entries, upload commit, and verification-gate state are recorded.

Crash convergence is explicit:

- file before part row: exact replay adopts only after full verification; otherwise it remains known staging cleanup;
- part row before later parts: resume from the committed global sequence;
- CAS object before blob/manifest row: exact replay verifies and adopts; unknown orphans remain capacity-visible/manual and are never guessed or pressure-deleted;
- manifest commit before staging cleanup: the manifest remains committed and cleanup progresses separately; and
- database loss, swapped path, reparse evidence, or unknown liveness preserves bytes and reports degraded/manual state.

Known staging is removed only after a database cleanup claim and exact no-follow identity revalidation. Committed CAS is immutable and is never garbage-collected merely to improve a capacity metric.

## Verification semantics

The manifest binds exact files/hashes, assignment and worker/runtime generations, assignment/profile/path-jail hashes, worker-claim IDs/hashes, and server-owned required-verifier profile digests.

Gateway-trusted verification rehashes immutable CAS before and after execution, uses a server-owned profile/environment digest, exposes no provider/operator secrets, denies default egress, bounds time/output, and appends evidence. It cannot activate skills, memory, capabilities, tools, or artifacts, and uploaded code is never executed merely because it was uploaded.

## Effect semantics

The worker may supply only a bounded effect/tool selector, canonical args, and idempotency key. Gateway derives workspace, session, agent, policy context, approval identity, runtime owner, profile, posture, and secrets.

1. Persist the immutable remote intent before policy or delivery.
2. Invoke only through the canonical coordinator with an assignment/HX-411 execution fence and the canonical external-side-effect boundary.
3. Record deny or approval-required only when proven before the boundary. Approval resume must match the exact intent, workspace, session, run, tool, args, and canonical approval.
4. At the real external boundary, the existing owner durably claims and records `external_call_started` before bytes leave Gateway.
5. `completed_with_effect` requires an exact completed HX-305 canonical owner; result payload fields never create a receipt.
6. Authority loss before the boundary blocks delivery. Authority loss after the boundary records actual completion or ambiguity but cannot mutate Chat, settle the assignment, or retry.
7. Any possibly dispatched error becomes manual reconciliation. Automatic replay is forbidden.

Worker-reported provider usage/cost is rejected. HX-306 rows remain authoritative through disconnect, cancellation, replay, or stale generation.

## Exact production-dark allowlist

New files:

- `packages/contracts/src/remote-worker-settlement.ts`
- `packages/contracts/src/remote-worker-settlement.test.ts`
- `packages/storage/src/remote-worker-artifact-repo.ts`
- `packages/storage/src/remote-worker-artifact-repo.test.ts`
- `packages/storage/src/remote-worker-artifact-repo.postgres.test.ts`
- `packages/storage/src/remote-worker-effect-repo.ts`
- `packages/storage/src/remote-worker-effect-repo.test.ts`
- `packages/storage/src/remote-worker-effect-repo.postgres.test.ts`
- `packages/storage/src/remote-worker-settlement-schema-parity.test.ts`
- `apps/gateway/src/services/remote-worker-artifact-store.ts`
- `apps/gateway/src/services/remote-worker-artifact-store.test.ts`
- `apps/gateway/src/services/remote-worker-artifact-settlement-service.ts`
- `apps/gateway/src/services/remote-worker-artifact-settlement-service.test.ts`
- `apps/gateway/src/services/remote-worker-verification-service.ts`
- `apps/gateway/src/services/remote-worker-verification-service.test.ts`
- `apps/gateway/src/services/remote-worker-effect-settlement-service.ts`
- `apps/gateway/src/services/remote-worker-effect-settlement-service.test.ts`
- `apps/gateway/src/services/remote-worker-settlement.integration.test.ts`

Existing files:

- `packages/contracts/src/index.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/sqlite.ts`
- `packages/storage/src/postgres/migrations.ts`
- `packages/storage/src/postgres-migration-integrity.test.ts`
- `packages/storage/src/remote-worker-assignment-repo.ts`
- `packages/storage/src/remote-worker-assignment-repo.test.ts`
- `packages/storage/src/remote-worker-assignment-repo.postgres.test.ts`
- `packages/storage/src/remote-worker-assignment-schema-parity.test.ts`

Existing artifact stores/repositories, policy, approvals, external-effect runner, session control, usage accounting, routes, startup, composition, Mission Control, and docs are dependency owners, not writable HX-506 files.

## Proof and live gates

Proof covers strict contracts/hashes/bounds; SQLite/live-PostgreSQL replay, changed replay, composite-FK isolation, two-connection winners, immutable triggers, claims, migration parity; part gaps/races/quota/digest/manifest settlement; symlink/junction/reparse/ADS/device/UNC/casefold/staging/CAS/fsync/crash attacks; worker-claim non-authority; verifier drift/timeout/redaction/egress/crash; policy/approval/generation races; result-body spoofing and ambiguous delivery; HX-306 missing-versus-zero cost; and HX-504 duplicate non-authority.

Live runtime remains HOLD until:

1. the coordinator supplies a committed clean base, exact 27-file delegation, and a fresh paired migration allocation;
2. HX-411's universal mutation/late-callback fence is committed with no permissive default;
3. HX-505 supplies real capacity/staging/cleanup accounting and unknown liveness fails closed;
4. native HX-501 listener authority, credential/revoke resolution, no-follow key/attestation loading, and route isolation are live;
5. HX-502 scheduler/lease and HX-504 transport/outbox integration are live;
6. canonical policy/approval/HX-305/HX-306 ports are bound and independently tested; and
7. independent QA and `pnpm verify:remote-workers` pass, including conditional live PostgreSQL, Windows no-follow, and two-machine native-mTLS proof.

## Non-goals and ordering

This tranche adds no live route, listener, startup, scheduler, worker binary, Mission Control/Chat UI, generic artifact-store rewrite, migration of existing artifacts, cross-workspace dedupe, archive extraction, active-content preview, uploaded-code execution, worker-selected verifier, memory/skill/capability promotion, provider secret, direct worker egress, new policy/effect/accounting/session owner, automatic ambiguous retry, compensating rollback, pressure deletion, migration number, or release claim.

Implementation order is: freeze contracts/ports; contracts export; paired storage/repositories/assignment-settlement gate; CAS and crash recovery; trusted verification; canonical effect adapter; independent adversarial QA; then a separate runtime-route/composition handoff. No production-dark SHIP verdict grants the later runtime handoff.
