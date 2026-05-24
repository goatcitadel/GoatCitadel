# Follow-On Parity Register

Last updated: 2026-05-24

This register tracks the follow-on lanes that stay relevant after planned-channel parity is largely complete.

## Follow-On Epics

- `GC-P0-06` Browser control parity
- `GC-P0-07` Canvas / A2UI parity
- `GC-P1-08` Companion apps / nodes / device surfaces
- `GC-P1-09` Packaging and remote deployment parity
- `GC-P1-10` Long-tail parity register
- `GC-P2-11` Extension / plugin SDK breadth
- `GC-P2-12` Voice Wake / Talk Mode parity

## Recommended Order

1. `GC-P2-12` Voice Wake / Talk Mode parity
2. `GC-P0-06` Browser control parity
3. `GC-P2-11` Extension / plugin SDK breadth
4. `GC-P1-09` Packaging and remote deployment parity
5. `GC-P1-08` Companion apps / nodes / device surfaces
6. `GC-P0-07` Canvas / A2UI parity
7. `GC-P1-10` Long-tail parity register

## Notes

- The register order reflects the setup and ecosystem closeout path: voice, browser, SDK, packaging/deployment, mobile/device, Canvas/A2UI, then long-tail cleanup.
- `GC-P1-09` stays in both documents because it is both the remaining full-program parity epic and a follow-on lane.
