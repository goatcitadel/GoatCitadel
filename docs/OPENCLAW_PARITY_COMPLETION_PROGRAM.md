# OpenClaw Parity Completion Program

Last updated: 2026-04-02
Scope: repo code, `GoatCitadel-mobile` runtime proof, manual operator proof lanes, and release/publication tasks required to truthfully close the parity roadmap

## Why This Exists

- `docs/OPENCLAW_PARITY_STATUS.md` records what has already landed.
- `docs/FOLLOW_ON_PARITY_REGISTER.md` records the follow-on foundations and safe claims.
- This document is the closeout program for everything still unfinished.
- The live OpenClaw parity report now classifies open work as repo-runtime, manual/operator-proof, external-repo, or publication blockers so closeout ownership stays explicit.

Until the external OpenClaw research matrix is refreshed in-repo, these three docs together are the operative parity contract for GoatCitadel.

## Already Complete

- `GC-P0-01` Shared channel runtime semantics
- `GC-P0-02` Stabilize core beta channels
- `GC-P0-03` Ship Tier-1 planned channels
- `GC-P0-05` Channel action API completeness
- `GC-P1-04` Ship Tier-2 planned channels
- `GC-P1-10` Long-tail parity register
- `GC-P2-11` Extension / plugin SDK breadth
- `GC-P2-12` Voice Wake / Talk Mode parity

## Unfinished Epic Checklist

### `GC-P0-07` Canvas / A2UI parity

Current gap:
- No current gap for the closure bar; Android runtime proof is now on file for the platform-side A2UI surface.

Completion checklist:
- Keep the Mission-Control-first A2UI proof lane export current.
- Keep the Android Canvas/parity evidence bundle current when the contract, deployment profile, or operator flow changes.
- Re-run the Android/emulator proof only when runtime truth changes.

Proof artifact:
- `docs/testing/A2UI_VALIDATION_CHECKLIST.md`
- `templates/verification/a2ui-proof-bundle.md`

### `GC-P1-08` Companion apps / nodes / device surfaces

Current gap:
- No current gap for the closure bar; Android runtime/UI proof is now on file end to end for the current companion lane.

Completion checklist:
- Keep `companion.android.v1` plus the exported companion bootstrap brief aligned with the separate mobile runtime.
- Re-run the Android/emulator proof only when signed-session, SSE resume, refresh rotation, or bootstrap behavior changes.
- Keep the Android evidence bundle current and reproducible.

Proof artifact:
- `docs/COMPANION_CONTRACT.md`
- mobile repo proof bundle produced from `GoatCitadel-mobile`

### `GC-P1-09` Packaging and remote deployment parity

Current gap:
- The checklist, template, and current April 2, 2026 `trusted_local` plus `remote_hardened` operator-evidence bundles now exist, but parity still depends on repeatable clean-install, packaged-startup, and rollback evidence across target environments.

Completion checklist:
- Keep the System-generated packaging proof lane current for the active deployment profile.
- Collect repeatable clean-install, packaged-startup, `remote_hardened`, and rollback evidence on target environments instead of only on the developer workstation.
- Refresh stale or profile-mismatched proof artifacts before relying on them.
- Re-run the lane whenever deployment posture changes.

Proof artifact:
- `docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md`
- `templates/verification/packaging-deployment-proof-bundle.md`

## Completion Order

This is the full-program closeout order. It is intentionally broader than the follow-on-only order in `docs/FOLLOW_ON_PARITY_REGISTER.md`.

1. `GC-P1-09` Packaging and remote deployment parity

## Done Means

Parity is only finished when all of these are true:

- Every open epic above is marked complete in `docs/OPENCLAW_PARITY_STATUS.md`.
- The “not safe to claim yet” list no longer contains an open item unless it is explicitly de-scoped.
- Every proof-driven lane has a current artifact, not just code or docs.
- Mission Control, gateway reports, setup/docs, catalog maturity, and tests all agree on the final state.
- `GoatCitadel-mobile` has produced the required Android/emulator proof for companion and platform-side A2UI work.
- `@goatcitadel/extensions-sdk` is published and its public boundary is explicit.

## Assumptions

- This program is for full closeout, not repo-only cleanup.
- Manual/operator proof is required for completion; code-complete without proof does not count.
- TUI/Mission Control surface mirroring is already sufficient; the remaining blockers are parity breadth, hardening, proof, and publication.
