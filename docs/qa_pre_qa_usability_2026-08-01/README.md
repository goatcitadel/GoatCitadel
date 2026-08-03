# GoatCitadel Pre-QA Usability, Reliability, and Quality Closure — 2026-08-01

Status: **implementation and recertification in progress; do not resume manual QA yet**

This workbook is the current execution record for the closure campaign. The 2026-07-29 workbook remains historical evidence and is not reused as proof for this branch.

## Authority and scope

- Base SHA: `d2be6908d5c90816f9ba7c5860f95d09de682fb0`
- Working branch: `codex/pre-qa-closure-2026-08-01`
- Canonical UI: `apps/mission-control-next`
- Shared Chat owner: `packages/threaded-surface-core`
- Canonical control plane: `apps/gateway`
- Toolchain: Node `22.23.1`, pnpm from the repository package manager contract
- Current implementation manifest: 42 shipped routes, 6 experimental routes, 20 legacy-query redirects, and 3 direct compatibility paths
- Required storage boundaries: isolated SQLite and isolated PostgreSQL
- Required deployment boundary: exact Windows x64 packaged candidate

The route/action and capability matrices are generated at execution time by `pnpm verify:usability`. A required row reported as `skipped` or `not_configured` fails the gate. Optional hardware or uncredentialed external systems must retain a specific limitation and are never promoted to a product pass.

## Current closure slice

The August campaign begins by repairing evidence defects found while reviewing the July closeout and current `main`:

- `GC-HARNESS-075`: make the durable-run timer assertion honor integer timer granularity while retaining a strict bounded contract.
- `GC-HARNESS-076`: never reuse a stale fast-lane scratch root when Windows holds a file handle; use a fresh sibling root and keep cleanup best-effort after execution.
- `GC-HARNESS-077`: include the native scroll contract in the named `verify:usability` self-proof prefix.
- `GC-HARNESS-078`: make visual-regression console validation reuse the same exact, bounded SSE recovery classifier as usability browser actions.
- `GC-USAB-069`: extend React Hooks correctness enforcement to the shared Chat owner and repair every resulting stale or over-broad dependency set.
- `GC-USAB-070`: compare native evidence-root file identities at full BigInt width so distinct 64-bit identifiers cannot collapse through JavaScript number precision.
- `GC-HARNESS-079`: run foundation browser proof against one immutable preview bundle so a Vite dependency-optimizer reconnect cannot leave a later profile with HTML but no React shell.
- `GC-HARNESS-080`: configure the operator approval-resume proof with the isolated loopback provider that its frozen durable request names.
- `GC-HARNESS-081`: project operator auth-boundary evidence onto a credential-free issuance/denial schema instead of retaining one-time device and companion credentials.
- `GC-HARNESS-082`: refresh the architecture debt tripwire from the reviewed post-`#239` Gateway source after the prior baseline became stale.
- `GC-HARNESS-083`: keep the remote-worker deadline proof independent of whether saturated process startup emits a ready frame before the absolute deadline.
- `GC-HARNESS-084`: set the five-second provider idle watchdog in authoritative `goatcitadel.json` as well as the compatibility assistant file so boot sync cannot silently restore the 120-second production default.
- `GC-HARNESS-085`: automatically unmount React test renderers after each Mission Control test and make listener effects remove handlers from the exact registration target, preventing aggregate worker-shutdown console races.
- `GC-USAB-071`: make the initialized Windows WebView2 controller navigate explicitly and require the packaged installer smoke to prove a non-blank loopback page and exact Mission Control document title.
- `GC-USAB-072`: retire exact terminal `chat.turn.execute.v1` post-commit markers with hashed compatibility evidence and no side-effect replay instead of retrying an authority shape that did not exist when they were written.
- `GC-USAB-073`: treat auth-none SSE discovery as a tokenless success so the native desktop status poll does not generate an HTTP 400 warning every ten seconds.
- `GC-USAB-074`: map the onboarding completion config-generation fence through the shared retryable 409 contract instead of leaking an HTTP 500 during startup reconciliation.
- `GC-HARNESS-087`: pair the live recursive config snapshot with the completed backup payload before destructive mutation so atomic owner writes cannot make a valid restore look stale.
- `GC-HARNESS-088`: carry the canonical durable row out of legacy settlement instead of rereading it, then advance the independently reviewed literal architecture baseline by the one required durable update access. The baseline remains a separate tripwire and is not derived from the current manifest or collector output.
- `GC-HARNESS-089`: serialize Kanban bulk-action journey steps on their exact visible completion notice so a completed asynchronous refresh cannot clear the next selection before its action runs.
- `GC-HARNESS-090`: retry backup-fixture mutation only for bounded transient Windows file-lock codes after the isolated Gateway exits, while preserving immediate failure for other I/O errors and exact sentinel absence checks.
- `GC-HARNESS-091`: compare backup payloads with committed config only, excluding the config owner's private `.generations/staging` mirror while keeping recursive byte equality fail-closed for every committed JSON file.
- `GC-HARNESS-092`: run route-surface regression against one built Gateway and immutable preview UI so Vite HMR fallback behavior cannot become a false page failure or introduce a transient token into retained evidence.
- `GC-HARNESS-093`: preserve the real npm restricted-tool working-directory integration while giving its Windows V8 coverage process-start boundary a 45-second test budget beneath the independent 120-second production deadline.
- `GC-HARNESS-094`: give the two Code Mode candidate child-execution and committed-I/O integration cases a 45-second Windows coverage budget while preserving every product timeout, rollback, immutable replay, and artifact assertion.
- `GC-HARNESS-095`: let the native route proof observe a transient zero-height stage within its existing shared five-second layout deadline, while preserving fail-closed persistent-collapse diagnostics and stable-bottom certification.
- `GC-USAB-076`: correct the code-driven Windows long-path uninstall fallback so Inno expands valid PowerShell braces and a deep Gateway dependency tree cannot abort uninstall.
- `GC-HARNESS-096`: make packaged lifecycle proof use a genuinely separate mutable runtime home and immutable app directory, follow the route-derived Start Here title, await process teardown, and retain the primary failure alongside cleanup diagnostics.
- `GC-USAB-077`: map expected config-generation conflicts from both settings read routes through the shared HTTP 409 error boundary so startup clients can retry truthfully.
- `GC-ENV-008`: keep an unsupported verifier help probe and its orphaned coverage shard classified as an environment failure; kill the exact owned process tree and require a clean serial rerun.
- `GC-HARNESS-097`: prove the packaged launcher stall spans the production health deadline while allowing bounded cold-child startup overhead in the repository-wide Windows gate; the 2-second product abort remains unchanged.
- `GC-HARNESS-098`: bind every copied Windows desktop host to the bundle's exact source commit and dirty-state truth so a clean JavaScript rebuild cannot silently ship a stale native binary.
- `GC-HARNESS-099`: keep native runtime-log evidence array-shaped under PowerShell strict mode so a missing log reports the intended isolation failure instead of a scalar `.Count` exception.
- `GC-USAB-078`: let stream admission wait within the existing 30-second terminal-effects cap so load-bearing durable child completions can settle without turning completed provider output into a false branch-send failure.
- Standard Code Quality `#1688` and `#1689`: remove the two analyzer-confirmed dead assignments without weakening recovery behavior.
- Standard Code Quality `#1687`: retain the explicit bounded activation-resolution loop; its early-return and `out`-parameter semantics are clearer than a LINQ allocation/indirection and its rejection is recorded in the security triage guide.
- AI Code Quality `llm.loop23.test.ts`: retain synchronous Fastify registration and document that awaited `inject()` owns boot and setup-error propagation; the generated async rewrite is rejected as non-actionable.
- AI Code Quality `legacy-route-adapter.test.ts`: explain the independent reviewed `42` shipped and `6` experimental route-inventory literals without deriving them from the table under test.
- AI Code Quality `model-usage-accounting.test.ts`: prove cancel-first terminal idempotency against later failure and success attempts, including persisted usage immutability.
- AI rescan boundary: GitHub refreshes AI findings only after default-branch pushes and offers no manual rescan/API, so the exact ready-to-merge branch can be checked by PR Code Quality but its next AI wave is necessarily post-merge.

## Stop rules and evidence boundary

- P0 stops the campaign immediately.
- P1 stops the affected wave until fixed and retested.
- Core or high-frequency P2 findings must be fixed before handoff.
- Environment failures are recorded separately and cannot become product passes.
- A focused test pass proves only the repaired slice. It is not the QA-ready verdict.
- The final SHA must complete the full campaign, a second clean-profile core smoke, isolated PostgreSQL restart/parity, the packaged Windows lifecycle, exact-root secret scanning, and hosted quality checks.

## Current proof

Proof completed on the first clean implementation candidate `0c39a37b4120cc68668b54cae96e8a7e438ec334`:

- Verification harness Node tests: 70/70 passed.
- Shared Chat package: 59 files and 450 tests passed.
- Shared Chat typecheck passed.
- React Hooks lint for all shared Chat TypeScript/TSX passed with zero warnings.
- Targeted durable-run timer regression passed; repeated and shard proof remains in progress.
- Workspace identity proof passed 17/17 normally and under coverage; two repaired full Gateway shard runs each passed 2,126/2,126.
- Focused harness ESLint and Prettier checks passed.
- `verify:fast`, auth matrix, runtime truth, and durable recovery passed on the focused candidate; exact artifact roots are recorded in `Gate Results.csv`.
- Full `verify:usability` passed 120/120 scenarios with no required `skipped` or `not_configured` row, followed by a passing clean-profile core smoke.
- Full visual regression passed all 408 route/viewport/theme scenarios without updating baselines; surface and accessibility regressions also passed.
- Agentic, memory, realtime, backup, desktop-source, external-source, and isolated Docker/PostgreSQL recovery/parity lanes passed.
- The first aggregate `verify:all` correctly failed on a persisted-mobile Vite module connection, an operator-proof provider-fixture mismatch, credential-bearing auth evidence, and a stale architecture baseline. Those four defects are repaired; focused operator proof, exact-root redaction, and architecture proof now pass. Final clean-SHA recertification remains pending.
- The next full-usability rerun exposed two more harness defects: a saturated scanner assertion coupled to a pre-deadline ready frame and a Gateway fault fixture that wrote its five-second watchdog only to a boot-overwritten compatibility file. Both are repaired. The focused real-Gateway fault journey now passes all 9/9 steps with 16 loopback dispatches, including terminal timeout reconciliation and next-turn admission.
- The repaired full usability campaign passed on `01581a74900f41e6b4aad0954ab713b228c4b7fc` with 148 assertions and no required skip, followed by a passing second clean-profile core smoke and isolated PostgreSQL recovery/parity run with 30/30 storage contracts. Exact artifacts are recorded in `Gate Results.csv`.
- The next aggregate passed 650 scenarios and every one of its 951 Mission Control assertions, but Vitest reported six late console-RPC rejections from renderers left mounted at worker shutdown. Automatic renderer cleanup exposed five listener effects that dereferenced replaced `window` or `document` globals during teardown. Those owners now retain the exact event target, a sequential cleanup regression passes, and the complete Mission Control suite passes 123 files and 953 tests with coverage. Final clean-commit aggregate recertification remains pending.
- Clean commit `7dda6bd4ff31fbda7d23e366b3e6365a191bb3f7` then passed `verify:fast` and the 651-scenario aggregate with zero failures. Its first exact Windows x64 installer updated successfully and the packaged Gateway/UI reached ready, but direct WebView2 inspection found that the titled native window remained on `about:blank`. The previous installed boundary was restored byte-for-byte and the failed candidate retained in a quarantined sibling. `CoreWebView2.Navigate` repairs the focused host, and the installer smoke now fails closed unless the embedded page has a loopback URL and `GoatCitadel Mission Control Next` title. Rebuild and full packaged lifecycle recertification are pending.
- The same persisted-package exercise exposed two compatibility defects outside fresh-profile proof: 35 completed v1 Chat parents were trapped in a repeated post-commit recovery error, and auth-none desktop polling generated a token-bridge 400 every ten seconds. The compatibility repair never replays legacy side effects, records a hashed retirement receipt, keeps v2 authority checks unchanged, and makes the tokenless SSE contract an HTTP success. Focused Gateway, auth, native-host, and packaging contracts pass; final clean-SHA and packaged persisted-profile proof remain pending.
- The first fast recertification of those repairs passed all 19 code, test, build, and documentation scenarios but repository hygiene rejected three workbook cells containing the local Windows profile path. Those evidence references now use `%LOCALAPPDATA%`; the focused repository lane passes all 604 script assertions plus hygiene and supply-chain posture. Final fast recertification remains pending.
- The next strict-usability foundation reached onboarding completion during config-generation reconciliation. Reads already returned the documented retryable 409, but the completion route lacked their shared error boundary and emitted HTTP 500. The route now preserves the same structured conflict contract; 13/13 focused route tests and the complete named auth matrix pass, while the full clean-state campaign remains pending.
- Strict usability then passed 148/148 with no required skip, the second clean-profile core smoke passed, isolated PostgreSQL recovery/parity passed 30/30, and `verify:fast` passed. The following aggregate passed 648 scenarios but found an intermittent snapshot-to-backup config race and the expected architecture ratchet from durable legacy settlement. A standalone backup roundtrip immediately passed, confirming that restore semantics remained correct. Both proof defects are now repaired without weakening byte equality or the independent literal architecture baseline; focused and complete final-SHA reruns remain pending.
- The first strict run after those aggregate repairs passed every source prerequisite and 9 of 10 browser-action bundles, then stopped on the Kanban lifecycle because the journey advanced before the preceding asynchronous bulk refresh reached its visible completion. The product request completed successfully; the later refresh cleared the next selection and left `Close` disabled. The journey now waits for the exact one-task completion notice after every bulk mutation. Its 48/48 browser-action contracts and filtered real Chromium `ops-work` journey pass; complete strict recertification remains pending.
- The following strict rerun stopped before browser actions when Windows retained the isolated `index.db` handle briefly after the Gateway process tree exited. The proof now retries only transient OS lock failures within a fixed bound, records removal attempts by run-relative path, still fails immediately for other I/O errors, and still requires every mutation sentinel to be absent before offline restore. Six focused lock/error contracts and two consecutive complete backup roundtrips pass; complete strict recertification remains pending.
- Clean commit `34bbee45be319e860202b7c5a29d89776c891eb3` passed strict usability with 149 verifier tests and no required skip, a second clean-profile core smoke, isolated PostgreSQL restart/parity with 30/30 contracts and zero owned-resource residue, and `verify:fast`. Its aggregate passed 638 scenarios before the backup verifier compared intentionally excluded atomic staging paths and the source-mode route proof retained Vite's transient HMR fallback token. The committed-config proof and production-preview route boundary are repaired; six backup helper contracts, the complete backup roundtrip, the complete surface regression, and exact-root artifact redaction pass. Final aggregate recertification remains pending.
- Clean commit `4e9bbeec1573253c8a41e00a246bb7dab23ff14b` passed all 149 strict-usability self-tests, Gateway coverage, storage coverage, and Mission Control coverage before the policy-engine prerequisite stopped on one Windows process-start timing bound. The real npm restricted-tool cwd case passes focused; its 15-second test ceiling is widened to 45 seconds while the production restricted-run timeout remains unchanged at 120 seconds. Two consecutive complete policy-engine coverage runs pass 60/60 files and 796/796 tests; full final-SHA recertification remains pending.
- Clean commit `fa5c8a80981cb93cbeda8eac715537b0d7c19e74` passed all 149 strict-usability self-tests before Gateway coverage shard 1 stopped on two late Code Mode candidate tests that crossed Vitest's 15-second default under four-worker V8 coverage. Both pass focused in under four seconds; their child-execution and committed-filesystem integration budgets are widened to 45 seconds without changing product timeouts or assertions. The harness-isolated exact shard now passes 221/221 files and 2,095/2,095 tests; final-SHA recertification remains pending.
- Clean commit `5133309f94d5f71bebbed8d90a9ca67440ab9cb3` passed the repaired Gateway and policy coverage prerequisites, backup/runtime foundations, and 61 strict-usability scenarios before Settings Workspaces produced one zero-height native-stage sample 246 ms after navigation. The page and APIs were healthy with no console or page errors. The geometry owner now waits within the same absolute layout deadline, charges the remainder to stable-bottom proof, and still rejects a persistently collapsed stage. All 11 native-scroll contracts, the complete surface regression, and exact-root artifact redaction pass; final clean-SHA recertification remains pending.
- Provisional source head `51ae180564e1bf21da047b0dbb9da42cf41d89b2` passed the 651-scenario aggregate with zero failures after the Gateway terminal-effects admission repair. The same functional repair passed strict usability, the second clean-profile core smoke, isolated PostgreSQL restart/parity, and the disposable Sol/Terra/Luna provider pack on its pre-comment candidate. These artifacts are not reused as frozen-head proof after the AI quality batch.
- The authenticated 2026-08-03 AI queue contained three findings in three files. The route-inventory explanation and cancel-first settlement regression were accepted and pass 18/18 and 15/15 focused tests; the Fastify async rewrite was rejected with source and 4/4 route-test evidence. Exact dispositions and the default-branch-only rescan boundary are recorded in `docs/security/findings-triage.md`.
- Frozen source SHA `08d9ec8e5af76af98665dfbfc5e3947c90c5bc31` passed the strict-usability prerequisites and every preceding scenario, then stopped after all eight Settings core/auth/provider actions passed. Chromium reported one `ERR_CONNECTION_FAILED` while a registered route navigation replaced the old EventSource, but did not emit the `requestfailed` event required by the prior recovery classifier. The retained log proves the exact navigation-scoped `close/error/retry`, a new event-stream 200 and `open` 217 ms later, and a healthy current-page stream. `GC-HARNESS-102` adds that bounded proof contract and propagates the completed navigation windows through the lane's recovery-polling handoff while preserving fatal treatment for repeated, truncated, unscoped, or unrecovered failures; 51/51 focused harness tests pass and strict recertification is pending.
- The filtered exploratory rerun at `artifacts/verification/2026-08-03T17-50-54-266Z-usability-da100d43` passed all 110 scenarios it executed, including the exact Settings core/auth/provider Chromium scenario with 8/8 actions, nine event-stream 200 responses, no truncated stream evidence, and clean console health. Its overall status is correctly not a product pass: the final evidence-integrity scenario rejected the nine deliberately omitted browser bundles. That filter limitation does not weaken the complete strict gate, which remains pending on the next clean SHA.

These results are intentionally marked focused. The final result files are updated only after clean-SHA execution.

## Workbook files

- `Defect Ledger.csv`: reproduction, severity, fix, regression, and retest status.
- `Execution Summary.csv`: wave order, stop conditions, commands, and artifact roots.
- `Environment Matrix.csv`: storage, profile, viewport, provider, and deployment boundaries.
- `Journey Matrix.csv`: operator journey owners and required evidence.
- `Gate Results.csv`: final-SHA gates and external blockers.
- `Quality Queue.csv`: Standard, AI, CodeQL, and PR-head quality disposition.

## Handoff placeholders

- Final source SHA: pending
- Ready-to-merge PR: pending
- Installer SHA-256: pending
- Installed version: pending
- Full route/action coverage: passed on the first clean candidate; pending final-SHA rerun
- Standard queue rescan: pending post-push
- AI queue review: current default-branch queue triaged; exact branch AI wave is post-merge by GitHub design
- Live provider pack: passed provisionally with disposable probes; frozen-SHA rerun pending
- QA-ready verdict: **blocked until every required gate in `Gate Results.csv` passes**
