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
- Standard Code Quality `#1688` and `#1689`: remove the two analyzer-confirmed dead assignments without weakening recovery behavior.
- Standard Code Quality `#1687`: retain the explicit bounded activation-resolution loop; its early-return and `out`-parameter semantics are clearer than a LINQ allocation/indirection and its rejection is recorded in the security triage guide.

## Stop rules and evidence boundary

- P0 stops the campaign immediately.
- P1 stops the affected wave until fixed and retested.
- Core or high-frequency P2 findings must be fixed before handoff.
- Environment failures are recorded separately and cannot become product passes.
- A focused test pass proves only the repaired slice. It is not the QA-ready verdict.
- The final SHA must complete the full campaign, a second clean-profile core smoke, isolated PostgreSQL restart/parity, the packaged Windows lifecycle, exact-root secret scanning, and hosted quality checks.

## Current proof

Focused proof completed on the dirty implementation candidate before its first commit:

- Verification harness Node tests: 70/70 passed.
- Shared Chat package: 59 files and 450 tests passed.
- Shared Chat typecheck passed.
- React Hooks lint for all shared Chat TypeScript/TSX passed with zero warnings.
- Targeted durable-run timer regression passed; repeated and shard proof remains in progress.
- Workspace identity proof passed 17/17 normally and under coverage; two repaired full Gateway shard runs each passed 2,126/2,126.
- Focused harness ESLint and Prettier checks passed.
- `verify:fast`, auth matrix, runtime truth, and durable recovery passed on the focused candidate; exact artifact roots are recorded in `Gate Results.csv`.

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
- Full route/action coverage: pending final `verify:usability`
- Standard queue rescan: pending post-push
- AI queue rescan: pending authenticated browser review
- Live provider pack: pending credential availability; only disposable `Reply with exactly: CHAT_OK` probes are allowed
- QA-ready verdict: **blocked until every required gate in `Gate Results.csv` passes**
