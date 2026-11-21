# First-run Cockpit tutorial implementation plan

**Goal** Give new users an optional, hands-on tour in the normal Cockpit after model setup.

**Architecture** Launch a fresh Cockpit document after confirmed setup. Install a tutorial-only transport and fixture before mounting the shell. Reuse the actual views and approval controls and discard the instance on departure.

**Spec** [First-run Cockpit tutorial](../specs/2026-11-19-first-run-cockpit-tutorial-design.md)

## Constraints

Preserve the existing model and safety checks. Route tutorial actions through a closed in-memory fixture. Keep saved preferences and live Gateway records outside that fixture. Use the existing Cockpit styling, access checks on return, and reduced-motion behavior.

## Tasks

- [x] Add a one-use browser handoff shared by FirstRunArea and the main entry. Offer Take the tutorial and Skip tutorial after model readiness, launch after confirmed setup, and keep Chat available if the handoff fails.
- [x] Isolate request, Chat streaming, and realtime traffic in a document-scoped transport. Install it before mounting Cockpit and verify that the rendered practice session makes no live Gateway requests.
- [x] Add in-memory sample records and outcomes. Cover duplicate sends, both decisions, timed confirmation refusal, and access after disposal.
- [x] Mount the eight-stop guide on the Cockpit views. Keep the timed picker and its help in approval review, and verify Finish, Exit from an open review, reload, and browser Back.
- [x] Run the focused tests and Cockpit build. Check desktop light, phone dark with reduced motion, and both the original-scope and fallback return paths in the browser using a stubbed Gateway.

The installed Windows entry was outside this verification run.
