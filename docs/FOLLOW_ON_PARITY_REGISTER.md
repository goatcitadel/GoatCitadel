# Follow-On Parity Register

Last updated: 2026-08-07

This register tracks the follow-on lanes that stay relevant after planned-channel parity is largely complete.

## Follow-On Epics

- `GC-P0-06` Browser control parity
- `GC-P0-07` Canvas / A2UI parity
- `GC-P0-14` Governed self-configuration and self-repair (open acceptance lane)
- `GC-P1-08` Companion apps / nodes / device surfaces
- `GC-P1-09` Packaging and remote deployment parity
- `GC-P1-10` Long-tail parity register
- `GC-P2-11` Extension / plugin SDK breadth
- `GC-P2-12` Voice Wake / Talk Mode parity
- `GC-P2-13` Council / facilitated specialist synthesis (name TBD)

## Recommended Order

1. `GC-P0-14` Governed self-configuration and self-repair
2. `GC-P2-12` Voice Wake / Talk Mode parity
3. `GC-P0-06` Browser control parity
4. `GC-P2-11` Extension / plugin SDK breadth
5. `GC-P1-09` Packaging and remote deployment parity
6. `GC-P1-08` Companion apps / nodes / device surfaces
7. `GC-P0-07` Canvas / A2UI parity
8. `GC-P1-10` Long-tail parity register
9. `GC-P2-13` Council / facilitated specialist synthesis (name TBD)

## Notes

- The register order puts the newly discovered blank-profile self-configuration journey first, followed by the existing ecosystem closeout path: voice, browser, SDK, packaging/deployment, mobile/device, Canvas/A2UI, then long-tail cleanup.
- `GC-P1-09` stays in both documents because it is both the remaining full-program parity epic and a follow-on lane.
- `GC-P2-13` is a deferred product-design reminder, not shipped `1.0` truth. Explore a Council-style facilitated specialist experience inside Chat for explicit positions, critique/voting, synthesis, role visibility, and decision provenance. The final name is TBD, and any future work should build on the existing Chat orchestration, delegation, Ops Kanban/Agent Board, and Library Agents boundaries rather than inventing a second runtime or conversation surface.
- `GC-P0-14` corrects a review-rubric gap: setup, doctor, secrets, approvals, and durable execution foundations were counted separately without proving the blank-profile `detect -> secure configure -> live verify -> durable resume -> rollback` journey. Its current owner contract and mandatory acceptance matrix are [GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md](./GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md). The lane is open and must not be reported as shipped parity from foundation evidence alone.
- `GC-P0-14` is a newly opened documentation/acceptance lane and is not yet represented in the typed follow-on runtime report. Its first implementation slice must add that contract and align the shared status ledger; this register entry records backlog truth, not runtime availability.
