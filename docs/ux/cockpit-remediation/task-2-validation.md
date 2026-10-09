# Task 2 validation — compatibility routing and notification presence

Baseline: `30958cdbcfe2a8dc3234929fbee6bdf4b2248b15`. Source changes are uncommitted and unstaged in the isolated cockpit-remediation worktree. This document records source and automated checks, not installed-host parity or Classic retirement.

## Implemented

- Pure native/Classic/missing compatibility resolution, initial replacement and guarded in-app navigation; preserved record IDs, scope/query/hash and history state. Runtime, Knowledge, Projects and other unported views retain explicit Classic fallback. Arbitrary runId queries are not rewritten.
- Authorized selected-approval Inbox lookup; missing versus pending/error state; explicit existing scope review before cross-workspace details/actions. Record/scope/query/hash persist through accepted scope transitions and specialized Classic fallback.
- Ready-only Cockpit presence using existing 45-second renewal and 90-second TTL, visible Chat-session scope, focus/visibility cleanup and storage-denial fallback. Each effect owns its lease. Gateway notification suppression policy is unchanged.
- Windows/Tauri native approval destinations retain encoded IDs and available workspace scope; historical URLs and explicit Classic rollback remain supported.
- Review fix: shipped Library skills/tools aliases and generated catalog detail links are native, using the existing catalog parser and an exhaustive contract-kind map. Unknown kinds, malformed IDs and extra path segments remain missing. The original /library/skills shell error-recovery test is restored.

## Automated evidence

All commands ran from the isolated worktree. Build/typecheck/native build commands used `node scripts/run-with-worktree-output-lock.mjs --label=cockpit:task-2 -- ...`.

| Check | Result |
| --- | --- |
| Initial focused routing/Inbox/scope/presence set | 118 tests passed |
| Late focused alias/Classic/presence/navigation/scope/record set | 108 tests passed |
| Specialized approval fallback record test file | 4 tests passed |
| Review fix: cockpit-compatibility, CockpitNavigationProvider, CockpitShell | 86 tests passed in 3 files |
| Frontend package typecheck after review fix | Passed |
| Desktop frontend main notification tests | 18 tests passed |
| Windows EventStreamService/ActivationService/NavigationPolicy focused tests | 56 tests passed |
| Rust offline `cargo test ... parses_` | 3 tests passed |
| Desktop frontend production build | Passed |
| Frontend production build and perf:check | Passed before late small route amendments; budgets unchanged |
| Final frozen frontend package full suite after review fix | 454/454 files, 3,895/3,895 tests passed; exit 0; 254.89s |
| Frozen source integrity | All 31 source/test SHA-256 hashes unchanged across final run |

Focused command for review fix: `pnpm --filter @goatcitadel/mission-control-next test src/cockpit/app/cockpit-compatibility.test.ts src/cockpit/app/CockpitNavigationProvider.test.tsx src/cockpit/app/CockpitShell.test.tsx --maxWorkers=2`.

Final full command: `pnpm --filter @goatcitadel/mission-control-next test --maxWorkers=2`.

Test-first failures were observed for missing resolver, denied sessionStorage, old desktop approval URL, Classic Inbox misrouting, Classic view round-trips, specialized fallback scope loss, and all eight catalog detail kinds plus skills/tools aliases. Each subsequently passed focused checks. Existing dirty/cancel/Back-Forward guards remain covered. The held Back/hashchange test now settles setup events before dirty traversal because Happy DOM emits queued hashchange for pushState whereas browsers do not; its original review and Back assertions remain unchanged.

Earlier full runs were not green: the first had two incorrect-cwd CSS reads plus a newly added RED assertion; the second sampled three later RED assertions; the first frozen run had one existing hash/setup timing failure (453 files and 3,881 tests passed; one test failed). An immediate whole-file reproduction passed 27/27; setup-event settling and Library fixes preceded the final frozen rerun. Earlier full runs emitted localhost:8787 connection-refused fixture diagnostics; these are not evidence of a live Gateway defect. Exact logs and full implementer report are retained locally in `.superpowers/sdd/2026-10-05-cockpit-remediation/`.

## Proof boundaries

Controller owns the separate disposable-browser approval, scope-transition, missing-route/record, runtime fallback and Library acceptance evidence. This document does not certify unseen browser parity. Installed Windows/Tauri notification delivery, Ubuntu, external notification recipients and full Classic retirement remain unverified. No real notifications, installed profile changes, Gateway suppression-policy changes, or user-data mutations were performed by the implementer.

## Final acceptance evidence

The final frozen package suite passed on 2026-10-05. Its log is `task-2-fix-1-frontend-tests.log` in the local evidence directory above. No source, test, dependency-build or output-writing command overlapped this run. Localhost:8787 connection-refused fixture diagnostics were still emitted; all tests passed. The earlier unsuccessful full runs remain recorded above and are not represented as green. Scoped independent review approved the Library correction with no Important findings.

Controller-reported disposable-browser acceptance passed after the final correction: `/library/skills` on desktop/dark and `/library/tools` on phone/light rendered the catalog. Selecting Coding opened `/library/skill/skill%3Abundled%3Acoding`; Back returned to skills, Forward reopened detail, and reload retained detail. Cross-workspace approval review withheld actions until explicit scope acceptance and retained canonical workspace, workspaceId, hash and foreign history state afterward. These flows had no page errors or body overflow. Earlier controller checks covered legacy approval resolution, missing approval and explicit runtime Classic fallback. This is bounded browser evidence, not full parity certification.

Local browser provenance: `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-2-library-{skills,tools,detail}.png`, `task-2-library-flow.json`, and `task-2-scope-flow.json`. The initial Library harness locator newline mismatch was corrected to an accessible-name selector; it was not a product error. Installed Windows/Tauri delivery, Ubuntu and live external delivery remain pending.

Final handoff checks: `git diff --check` passed. Controller unknown-route browser capture `browser-proof/task-2-missing-route.json` and `.png` showed Page not found while retaining the original URL/query/hash, without page errors or body overflow. Explicit Classic fallback click/Back is not included in this claim.
