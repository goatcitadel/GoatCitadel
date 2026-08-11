# Follow-On Parity Register

Last updated: 2026-08-08

This register preserves the original follow-on epic IDs and their owner notes.
The cross-workstream execution order is now owned by
[MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md); this file must
not be used as a competing implementation sequence.

## Follow-On Epics

| Epic | Label | Current status | Master owner |
|---|---|---|---|
| `GC-P0-06` | Browser control parity | `complete` | Closed reference only |
| `GC-P0-07` | Canvas / A2UI parity | `complete` | Closed reference only |
| `GC-P0-14` | Governed self-configuration and self-repair | `partial` | `M5` |
| `GC-P1-08` | Companion apps / nodes / device surfaces | `complete` for the original epic; HX-508 proof remains | `M8` |
| `GC-P1-09` | Packaging and remote deployment parity | `in_progress` | `M9` |
| `GC-P1-10` | Long-tail parity register | `complete` | Closed reference only |
| `GC-P2-11` | Extension / plugin SDK breadth | `complete` | Closed reference only |
| `GC-P2-12` | Voice Wake / Talk Mode parity | `complete` | Closed reference only |
| `GC-P2-13` | Council / facilitated specialist synthesis (name TBD) | `deferred` | Deferred portfolio register |

## Active and Deferred Placement

1. Continue `GC-P0-14` in master tranche `M5` after its runtime dependencies.
2. Close `GC-P1-09` in master tranche `M9` against the integrated release candidate.
3. Close the remaining external mobile proof under `HX-508` in master tranche `M8`; do not reopen the completed original `GC-P1-08` epic.
4. Keep `GC-P2-13` deferred until an explicit product decision promotes a bounded Chat-native specialist-review design.

## Notes

- Completed epics remain listed only to preserve ID and evidence continuity. They
  are not active work and must not be rescheduled from their presence here.
- `GC-P1-09` remains the only open epic from the original completion program;
  the master program places it after the release-bearing dependencies it must
  certify.
- `GC-P2-13` is a deferred product-design reminder, not shipped `1.0` truth. Explore a Council-style facilitated specialist experience inside Chat for explicit positions, critique/voting, synthesis, role visibility, and decision provenance. The final name is TBD, and any future work should build on the existing Chat orchestration, delegation, Ops Kanban/Agent Board, and Library Agents boundaries rather than inventing a second runtime or conversation surface.
- `GC-P0-14` corrects a review-rubric gap: setup, doctor, secrets, approvals, and durable execution foundations were counted separately without proving the blank-profile `detect -> secure configure -> live verify -> durable resume -> rollback` journey. Its current owner contract and mandatory acceptance matrix are [GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md](./GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md). The lane is open and must not be reported as shipped parity from foundation evidence alone.
- `GC-P0-14` now has a partial source implementation and a named deliberately
  degraded proof lane. Its broader repair classes, delegated continuation,
  remote custody, packaged restart, browser secure-input, and live-provider
  evidence remain open under `M5`.
