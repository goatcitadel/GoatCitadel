# Capability System Backlog

This backlog tracks the follow-on work after Capability System v1.

## Near-Term Hardening

1. Add dedicated gateway tests for:
   - catalog snapshot freezing
   - inspectable vs callable enforcement
   - Code Mode approval creation and run execution
   - proposal inspectable-but-not-callable behavior

2. Add harness-focused tests for:
   - IPC cancellation
   - bounded message rejection
   - structured timeout errors
   - stdout and stderr truncation markers

3. Add storage-level migration tests for:
   - backfill idempotence
   - disabled-skill callable protection
   - candidate bundle dedupe and provenance preservation

## Promotion and Governance

1. Add explicit promotion and revocation APIs for candidate skills.
2. Add proposal validation workflows beyond create-and-inspect.
3. Add operator-visible rollback helpers for approved or trusted skills.

## Skills Hub Follow-On

1. Add dedicated candidate detail views with proof artifacts.
2. Add proposal detail views with event history and activation blockers.
3. Add lifecycle filters and trust-level filtering in Mission Control.

## Code Mode Follow-On

1. Add richer inspect views for submitted code and wrapper manifests.
2. Add run comparison tooling across snapshot or policy versions.
3. Explore safe continuation semantics only after explicit runtime design work.
4. Evaluate stronger production isolation if Code Mode scope expands beyond trusted code.

## Registry and Planner Hardening

1. Prove planner and wrapper generation only consume `callableCatalog`.
2. Add runtime metrics for inspectable-vs-callable drift.
3. Add audit exports for catalog snapshots and Code Mode artifact references.

## Product Decisions To Revisit

1. Whether candidate bundles should remain filesystem-managed long term or move to a more opaque asset store.
2. Whether Code Mode should eventually allow governed parallel read-only wrapper fan-out.
3. Whether existing imported skills need richer provenance normalization in the hub.
