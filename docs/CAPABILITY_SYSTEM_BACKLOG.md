# Capability System Backlog

Last updated: 2026-08-08

This backlog owns detailed capability-system follow-ons. Aggregate ordering is
canonical in [MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md),
primarily tranche `M6`.

The May 2026 list predated the current governed lifecycle. Current contracts,
Gateway services, and Mission Control clients now cover snapshot freezing,
inspectable-versus-callable enforcement, Code Mode approval/run execution,
bounded IPC/timeout/output behavior, migration/backfill guards, candidate
promotion/revoke/rollback, candidate detail, and lifecycle filtering. Those
rows are complete or superseded and must not be reopened from an unchecked
historical list.

Historical closeout evidence remains in
[backlog-closeout-2026-05-15.md](./review/backlog-closeout-2026-05-15.md) and
[CAPABILITY_SYSTEM_V1.md](./CAPABILITY_SYSTEM_V1.md). New work requires a
current reproduction or an explicit product decision.

## Reconciled Baseline

| Area | Current status |
|---|---|
| Catalog snapshot freezing and inspectable/callable enforcement | `complete` |
| Code Mode approval creation and governed execution | `complete` |
| Bounded IPC, cancellation, timeout, and output truncation | `complete` |
| Backfill, disabled-skill protection, candidate dedupe/provenance tests | `complete` |
| Candidate promotion, revoke, and rollback APIs | `complete` |
| Candidate detail and lifecycle/trust filtering | `complete` |
| Verified source/wrapper artifact inspection | `complete` |
| Run comparison across catalog, source, wrapper, policy, permission, override, and sandbox evidence | `complete` |
| Inspectable-versus-callable drift metrics | `complete` |
| Catalog snapshot and Code Mode artifact-reference audit export | `complete` |
| Automatic proposal filing or validation beyond current lifecycle | `not assumed`; requires a fresh design/reproduction |

## Code Mode Follow-On

The Gateway and Chat workbench already expose hash-verified previews for source,
wrapper manifests, result envelopes, and supported adapter artifacts. They also
compare catalog snapshots, source/input/wrapper/policy hashes, permission and
operator-override identities, and sandbox posture across runs. Treat both rows
as complete; reopen them only for a current reproduction or a specifically
approved UX expansion.

1. Explore safe continuation semantics only after explicit runtime design work.
2. Evaluate stronger production isolation if Code Mode scope expands beyond trusted code.

## Registry and Planner Hardening

1. Preserve the existing proof that planner and wrapper generation consume only
   `callableCatalog`; add a new task only for a current regression.
2. Runtime drift metrics now report the intentional inspectable-only population,
   per-kind counts, catalog hashes, review warnings, and the broken-subset
   invariant separately.
3. Snapshot audit exports now bind an exact catalog snapshot to explicitly
   requested, workspace-scoped Code Mode runs and export only hashes and durable
   artifact references, never artifact contents.

## Product Decisions To Revisit

1. Whether candidate bundles should remain filesystem-managed long term or move to a more opaque asset store.
2. Whether Code Mode should eventually allow governed parallel read-only wrapper fan-out.
3. Whether existing imported skills need richer provenance normalization in the hub.
