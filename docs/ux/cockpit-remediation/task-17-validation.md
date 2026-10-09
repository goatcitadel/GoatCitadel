# Task 17 validation — exact-code validation and retirement preparation — 2026-10-08

Owner: Claude Code root continuation. This records what Task 17 changed, what ran and what remains open. It claims no Ubuntu baseline, installed-host, live-provider, full PostgreSQL or release proof. Classic is not retired; saved Classic preference and `?shell=classic` rollback remain.

## Named lanes run

| Lane | Result | Evidence |
| --- | --- | --- |
| `pnpm docs:check` | PASS (after two fixes below) | `task-17-docs-check-2.log` |
| `pnpm verify:ui:parity` | PASS (runs 3 and 4, Classic shell) | `artifacts/verification/2026-10-08T13-20-54-483Z-ui-parity-486157b5`, `…13-25-23-469Z-ui-parity-a64cf692` |
| `pnpm verify:fast` (run 1) | FAILED, 16 passed / 8 failed | `artifacts/verification/2026-10-08T13-26-46-025Z-fast-2640e952` |
| `pnpm smoke -- --profile fast` | PASS, 11 steps, shipped config only | `task-17-smoke-isolation-smoke-run.txt` |

All evidence files are under `.superpowers/sdd/2026-10-05-cockpit-remediation/` unless an artifact path is given.

`verify:fast` ran on a heavily loaded machine (126 node processes, most from other applications, plus two `pnpm -r test` runs in another checkout). Every failure was triaged by isolated rerun:

- Fixed after the run: gateway `integration-control-loop21` and `change-plan-approval-reconciliation` (3), and the mission-control-next carries P3-02, P5-07, P5-08, P5-09, P5-10.
- Load or environment, each passing alone or unrelated to changed code: gateway `files-route-service` and `skill-hub-lifecycle` (timeouts), storage remote-worker cell claim (expiry after 26.8 s), policy-engine git read-only tool (5 s timeout, 2/4 alone), `threaded-surface-core` coverage worker heap out-of-memory, repo-hygiene native ASan and cell-job timing proofs (no native code changed in this worktree).
- Unresolved: gateway native worker restart end-to-end (`remote-worker-gateway-restart-e2e.test.ts`) fails deterministically with worker routes refused (403). The idempotency change was ruled out by a reversible HEAD swap; no remote-worker owner changed in this worktree; a HEAD comparison needs a clean checkout and was not run. Remote workers remain an implementation hold (HX-507).

A second, clean `verify:fast` run after these fixes has not been run.

## Source fixes

1. Docs-lane button types: `type="button"` on five buttons (including the product `ChatProjects` project row), plus a focus-return wait in `ShortcutHelp.test.tsx`.
2. UX budget and proof helpers find the cockpit composer by its settled role (`combobox` named Message): `ux-budget-chat.mjs`, `ux-budget-idle-traffic.mjs`, `cockpit-shell-controls-proof.mjs`, `chat-async-clarification-proof.mjs`, with a contract test.
3. Memory approval review shows one label per target and the Gateway's own summary sentences (`approval-helpers.ts` `targetEntries`, `ApprovalReviewSummary.tsx`); user titles and reviewed material unchanged.
4. `verify:fast` smoke isolation: `smoke.ts` copies only shipped config files; the fast lane gives smoke an empty root, pins every GoatCitadel path inside it and omits inherited GoatCitadel settings.
5. UI parity lane isolation: fresh Testbench root (tracked example config and skills), path pins, local services off, inherited settings scrubbed from Gateway and UI; the lane pins the Classic shell it certifies and starts its UI inside the guarded teardown.
6. Empty-catch rationale wording in `cockpit/data/realtime.ts` and `useChatLocalPersistence.ts` (comments only).
7. Integration PATCH reads the saved record only for configuration changes (`integrations-control-routes.ts`); credential protection unchanged.
8. Change-plan reconciliation fixture binds a real authenticated author (`workflow-capture-author-test-fixtures.ts`); the authorship tightening is kept.
9. P5-10: settings changes refresh the Library engineering and memory settings readers and device continuity checks (`SETTINGS_READER_KEYS`).
10. P5-11: integration review and confirm say when the list is refreshing instead of silently doing nothing (`use-integration-enabled.ts`).
11. P5-08: the shared read-only source strip keeps its Classic classes alongside the cockpit's, restoring Classic styling, with a class contract test.
12. P5-09, P5-07, P3-02: stale tests aligned with the native Library destination, a missing credential-input reset, and a stored-credential rejection.

Every fix was recorded test-first (red then green), passed typecheck, ESLint, the cockpit design guards and `git diff --check`, and was independently reviewed (all reviews approved with carries; no critical or high findings).

## Classic retirement readiness

Gate not met: 0 of 148 parity-inventory rows are `parity_verified`, and no Stable release cycle has passed. Classic stays. Rollback is exercised by the UI parity lane, which now pins the saved Classic preference and `?shell=classic` and passes.

Static and dynamic import inventory from each shell entry (stopping at the other entry): Classic only 215 modules and 38 stylesheets; shared 641 and 8; cockpit only 426 and 14. Classic-only code is mainly the native route pages and the Classic threaded-surface styling. A draft retirement notice exists in the scratch report and is not published.

## Open gates and carries

- Unresolved: native worker restart end-to-end (T17-V-2); a clean second `verify:fast` run.
- Load-sensitive tests: `MissionControlNextApp.test.tsx` (whole-graph import per case, about 20 s under load), the policy-engine git tool test, the `threaded-surface-core` coverage worker memory.
- Not run: Ubuntu-rendered visual baselines (the local Linux renderer is unavailable: Docker engine absent, Ubuntu WSL disk cannot mount), surface, accessibility and visual regression lanes, desktop and backup lanes, durable recovery and runtime truth lanes, installed host, live providers, full PostgreSQL.
- User decisions still open: P16-RC (raw-colour gate), P4-13, P4-16, P5-01, never-expiring grants.
- Carries: T17-S-1..3 (smoke timeout passthrough, shipped-config drift guard, omit assertion), T17-G-1/2 (fixture reuse, tsconfig exclude), T17-M-2..4 (memory summary slicing and dedupe, lock notice while saving), the Task 16 carries T16-S-1, T16-J-1, T16-C-1, T16-M-1, T16-AP-1, and the Task 15 port carries listed in their closure reports.

## Task 17 closure

The ledger and parity inventory gain a top-level `task_17_accepted_slice`; all 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering and prior evidence, and no finding is claimed closed. 0 of 148 inventory rows are parity-verified, so the Classic retirement gate is not met and Classic rollback remains. All preceding bytes of this document remain an exact prefix.

## Post-closure operator decisions (2026-10-08)

The decisions listed above as open were delegated to the implementing agent ("keep usability and security in mind") and are resolved as follows. Each was implemented test-first, frozen with its own preservation record and independently reviewed.

- **Never-expiring grants.** Native browser-session grants offer "Never expires (until revoked)" as the last, never-default option. Creation omits `ttlSeconds`, the review shows "Expires: Never", and the receipt tells the operator to revoke it when no longer needed. Autonomous activation and fan-out grants still expire.
- **P16-RC (option a).** Cockpit colours live in a dedicated `cockpit/styles/cockpit-tokens.css`. The design-quality gate accepts that file as the second exempt token source, `cockpit.css` has no raw colours, and the budget is unchanged at 92.
- **P4-13.** Every schedule time names the zone it runs in. An expression without a zone suffix is labelled UTC, the Gateway's default. An unrecognised suffix stays a custom schedule, never an unlabelled time.
- **P4-16.** All architecture-metric growth added by this branch is removed or registered:
  - existing owners were consolidated back to, or below, their HEAD counts;
  - new responsibilities moved into six reviewed new owners with C0 entries;
  - `GatewayService` is at its line limit after the Engineering source-root resolver moved out;
  - the reviewed Inbox cap rose from 24 to 26 for two real reads, with the operator confirming "accept 26".
  - `verify:architecture:metrics` still fails only on five regressions already on main, which are handled in a separate change.
- **P5-01.** Migration `purge_credential_route_idempotency_payload_hashes` (SQLite v252, PostgreSQL v198) replaces historical body-derived `payload_hash` values for the provider-secret and Gateway-auth routes with a fixed sentinel. No rows are deleted, so replay and conflict behaviour is unchanged. Migration parity passes. It has not been run against a live PostgreSQL.

Review follow-ups:
- **T17-A-1 closed.** The curator archive replay test now asserts the `alreadyArchived` marker, the readback time and that no realtime event is published. A paired test pins the live path.
- **T17-A-2 closed.** The memory route composition test asserts that the knowledge port exposes exactly the knowledge route methods.

Gates after these decisions:
- The second `verify:fast` run was stopped part-way at the operator's request. It ran on a machine shared with another session's test run, and every failure it recorded was a timeout, a file lock or a native compile timeout, not an assertion.
- The native provisioner proofs that failed inside the hygiene lane pass on their own (T17-H-1, load-sensitive).
- A clean `verify:fast` run on a quiet machine remains open.
- T17-V-2 is carried as pre-existing, by operator decision.
- All preceding bytes of this document remain an exact prefix.
