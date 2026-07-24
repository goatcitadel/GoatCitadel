# HX-505 Remote Worker Cell Packet

Date: 2026-07-14
Status: architecture SHIP for a production-dark control/state tranche; implementation HOLD until HX-411 releases shared storage owners and the live migration heads are re-read

## Boundary

HX-505 owns the immutable execution-cell profile, durable platform identity, resource reservation/high-water truth, bounded diagnostics, backup/restore state, cleanup recovery, and manual reconciliation for one active remote-worker assignment generation. It does not own worker admission, inference, transcript/live events, artifacts/effects, routes, startup, Ops, or UI.

A paired SQLite/PostgreSQL migration is required, but this packet claims no number. HX-504 events are worker-authored transcript/live evidence and cannot become Gateway/runtime cell authority. Filesystem manifests cannot become a second canonical state store.

The migration adds:

- `remote_worker_cells`: immutable assignment/profile identity, capacity reservation, platform identity, execution/cleanup/backup state and revision, high-water accounting, bounded diagnostics, receipt hashes, and manual/quarantine retained-byte truth;
- `remote_worker_cell_evidence`: append-only bounded hash-chained transition evidence with exact next sequence and byte-identical replay, excluding transcript, artifact payloads, raw terminal output, credentials, and arbitrary event types.

## Exact production-dark allowlist

Contracts:

- new `packages/contracts/src/remote-worker-cell.ts`
- new `packages/contracts/src/remote-worker-cell.test.ts`
- existing `packages/contracts/src/index.ts`

Storage:

- new `packages/storage/src/remote-worker-cell-repo.ts`
- new `packages/storage/src/remote-worker-cell-repo.test.ts`
- new `packages/storage/src/remote-worker-cell-repo.postgres.test.ts`
- new `packages/storage/src/remote-worker-cell-schema-parity.test.ts`
- existing `packages/storage/src/index.ts`
- existing `packages/storage/src/sqlite.ts`
- existing `packages/storage/src/postgres/migrations.ts`
- existing `packages/storage/src/postgres-migration-integrity.test.ts`

Policy:

- new `packages/policy-engine/src/worker-cell-egress-proxy.ts`
- new `packages/policy-engine/src/worker-cell-egress-proxy.security.test.ts`
- existing `packages/policy-engine/src/index.ts`

Gateway:

- new `apps/gateway/src/services/remote-worker-cell-service.ts`
- new `apps/gateway/src/services/remote-worker-cell-service.test.ts`
- new `apps/gateway/src/services/remote-worker-cell-filesystem.ts`
- new `apps/gateway/src/services/remote-worker-cell-filesystem.security.test.ts`
- new `apps/gateway/src/services/remote-worker-cell-terminal-capture.ts`
- new `apps/gateway/src/services/remote-worker-cell-terminal-capture.test.ts`
- new `apps/gateway/src/services/remote-worker-cell-platform.ts`
- new `apps/gateway/src/services/remote-worker-cell-platform.test.ts`
- new `apps/gateway/src/services/remote-worker-cell-container-adapter.ts`
- new `apps/gateway/src/services/remote-worker-cell-container-adapter.security.test.ts`
- new `apps/gateway/src/services/remote-worker-cell-backup-port.ts`
- new `apps/gateway/src/services/remote-worker-cell-backup-port.test.ts`

Any edit to routes, startup, Gateway composition, Ops/UI, HX-503/HX-504/HX-506, Code Mode, shared-host lifecycle, existing backup owners, external-source stores, or artifact repositories returns the tranche to HOLD for a separate owner handoff.

## Immutable profile

The server-owned profile binds workspace, worker/generation, assignment/generation, assignment-manifest and path-jail hashes, logical root, backend, runtime/launcher attestation, logical/allocated disk and file/inode limits, process/CPU/wall/memory limits, raw output and diagnostic limits, assignment-bounded artifact ceiling, exact egress posture/policy/DNS revision, backup/staging reservation, and an environment-name allowlist without values or secret references.

The worker cannot choose or widen any field. A policy change may tighten or cancel an unstarted cell, never widen an existing profile.

## State machines

```text
profiled -> provisioning -> ready -> starting -> running
                                              |-> exited
                                              |-> cancelled
                                              |-> limit_exceeded
                                              |-> failed
                                              `-> liveness_unknown

not_started -> pending -> stopping -> verifying_zero
                                   |-> verified_clean
                                   |-> failed_cleanup
                                   `-> manual_reconciliation -> quarantined

disabled
pending -> staged -> verified
                  `-> corrupt -> manual_reconciliation
restore_pending -> restored
                `-> drifted -> manual_reconciliation
```

`liveness_unknown` blocks deletion, reuse, backup publication, restore, artifact settlement, and assignment settlement. Cleanup succeeds only with OS-authoritative zero-process evidence, closed egress, unchanged root identity, and verified removal. Process outcome remains terminal even when backup/cleanup fails. Failed-cleanup and quarantine bytes remain counted. Absence never proves dead, clean, or restored.

## Required owners and transactions

Every port is mandatory and has no permissive default: assignment authority, worker quarantine/revoke, shared-host admission, platform, filesystem, capacity inventory, kernel-isolated egress, backup owner, read-only artifact footprint, and approval for restore/administration.

1. Read filesystem/capacity receipts outside the database.
2. In one immediate transaction, lock/revalidate worker and assignment authority, verify pool identity/accounting, sum active reservations, and insert/exactly replay the immutable cell plus worst-case capacity reservation.
3. Claim provisioning with a database-clock lease, then provision outside the transaction.
4. Persist planned platform identity before launch.
5. Revalidate assignment, lease, cancellation, profile, policy, capacity, and shared-host admission immediately before launch.
6. Launch idempotently; after restart reattach only to exact matching live identity. Confirmed pre-dispatch absence may reprovision. Missing, changed, conflicting, or unverifiable identity becomes `liveness_unknown`.
7. Persist transitions/resource evidence through monotonic CAS.
8. After confirmed exit, finalize diagnostics/high-water, optional backup, and separately claimed restartable cleanup. Only verified zero liveness permits removal.

## Capacity truth

Pressure accounting includes mutable roots, input/backup/artifact staging, immutable artifacts, retained transcript/outbox bytes, database main/WAL/SHM/journal files, backup staging/publication, manifests, proxy/watchdog sidecars, diagnostics, failed cleanup, and quarantine evidence.

Assignment limits use logical authored/reference bytes. Worker pressure uses unique physical identity and allocated bytes. Sparse/compressed files, hard links, shared CAS objects, and overlapping roots cannot hide or double-count capacity. Hard links, mount crossings, devices, sockets, FIFOs, symlinks, junctions, reparse points, ADS, and device/UNC aliases fail closed. Backup reserves staging and publication simultaneously. Raw output counts before redaction. Pressure rejects/quarantines new work; it never deletes canonical state or evidence to improve a metric.

## Isolation and egress

Path-jail preflight is not hostile-process isolation. Parent-side scans/cleanup use per-component no-follow identity checks, descriptor reads, Windows native reparse inspection, owner-only permissions, exclusive staging, atomic no-replace publication, and identity-bound cleanup that preserves swapped nodes for reconciliation.

The first backend is a digest-pinned container with deterministic names/labels, no `--rm`, read-only root, dropped capabilities, `no-new-privileges`, no host PID/IPC or Docker socket, quota-controlled volume/tmpfs, CPU/memory/swap/PID/wall limits, internal-only network, guarded proxy-only egress, and a fixed non-secret environment allowlist. There is no best-effort host fallback.

The proxy accepts exact host/IP plus port only, rejects wildcard/userinfo/encoded/noncanonical authorities and all loopback/link-local/metadata/private/multicast/reserved destinations, rejects mixed public/private DNS answers, pins checked IPs, rechecks each connection, applies all workspace/grant allowlists conjunctively, and bounds connections/deadlines/bytes. Nonempty egress fails closed unless the platform proves direct-socket bypass impossible.

Native POSIX requires namespaces, cgroup-v2, quota/inode enforcement, `no_new_privs`, and deterministic recovery probes. Native Windows requires restricted identity/AppContainer, DACL root, Job Object limits, persistent watchdog, no direct network, WFP/proxy enforcement, and canonical recovery. Unsupported/partial adapters return `cell_backend_unavailable`.

## Terminal, backup, and reconciliation

Stdout/stderr are continuously drained and raw-byte counted. Persist only bounded UTF-8-safe prefix/tail diagnostics with truncation flags, overlap-aware secret redaction, exit/signal, raw/retained totals, redaction count, and capture hashes. Never persist unbounded raw output or credentials.

Backup delegates to the existing backup owner after confirmed zero process/network liveness. It includes mutable cell state and references other owners' immutable bytes, stages privately, no-follow scans, hashes/fsyncs, atomically publishes, and reverifies. Restore requires approval and a new empty root, exact identity/profile/manifest/digest/capacity validation, and returns only to `ready`. Corruption/drift preserves source/staging, counts all bytes, and enters manual reconciliation. Force cleanup outside the exact verified root is outside this tranche.

## Proof and release gates

Required proof covers exact contracts; replay/conflict, capacity one-winner, transition/recovery and live PostgreSQL storage races; filesystem alias/link/sparse/mount/swap attacks and complete footprint accounting; DNS/rebind/direct-socket denial; child/grandchild escape and every resource limit; restart/identity/termination ambiguity; backup corruption/restore drift/sidecars; package typechecks; `verify:workspace:path-bridge`; both Code Mode sandbox lanes; backup roundtrip; shared-host drain; and diff checks.

Live execution remains HOLD behind HX-501 listener authority, a dedicated quota pool, proven container/network/backup adapters, and the integrated `verify:remote-workers` lane. This tranche adds no route, startup, scheduler, inference, transcript, artifact/effect, Ops, UI, generic shell, native-platform parity, prune, force-delete, migration number, or release claim.
