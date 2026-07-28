# Compound Engineering Capabilities

GoatCitadel implements four compound-engineering capabilities natively. They reuse Gateway-owned state, Prompt Pack benchmarks, Assembly, durable Chat delegation, approvals, Code Mode, and Library Knowledge. No external plugin runtime or alternate Chat/Cowork/Code surface is introduced.

All four features are default-off and independently controlled:

| Capability | Feature flag | Canonical owner |
|---|---|---|
| Prompt retune campaigns | `promptRetuneCampaignV1Enabled` | Prompt Pack service and benchmark runner |
| Structured review findings | `structuredReviewV2Enabled` | Review readiness service and Assembly |
| Delegated filesystem scope expansion | `delegationScopeExpansionV1Enabled` | Delegation step state, policy engine, durable approvals |
| Engineering learnings | `engineeringLearningsV1Enabled` | Engineering learning service and Library Knowledge |

## Prompt retune campaigns

Campaigns freeze the Prompt Pack content hash, selected tests, provider/model matrix, execution style, scoring-policy hashes, repetition count, benchmark-run budget, and success bar. The A/A pass runs the existing benchmark executor two through ten times and records the largest pairwise variation for each metric as its noise floor. Candidate improvement must strictly exceed that floor and satisfy the frozen absolute and non-regression quality gates.

Every hypothesis, content hash, benchmark run, metric result, and rejected or inconclusive disposition is retained. The runtime never edits or promotes prompt content. Replay regression now prefers an exact `baselineBenchmarkRunId`; the temporary `baselineRef` compatibility input accepts only validated ISO timestamps, and clients may not send both.

## Structured review

Review runs freeze the reviewed SHA, diff hash, and changed-file inventory. General correctness and test coverage always run; security, storage, UI/accessibility, agentic runtime, and Ops/release lenses are selected from the inventory. Assembly supplies the existing critique orchestration and model receipts.

Findings are read-only evidence records. High-confidence and P0/P1 findings must meet evidence rules. Advisory findings cannot request a fix. A fix request creates an approval-gated Code Mode run, and closure requires verification evidence plus a completed follow-up review. The legacy finding import endpoint remains an additive adapter and may mirror accepted findings to Tasks.

## Delegated filesystem scope expansion

Eligible delegated code workers receive the internal `submit_work_result` tool. It records a typed result but grants no authority. A scope request leaves the delegation step active at the durable approval wait and creates a `delegation_scope_expansion` approval bound to the run, step, child dispatch generation, and current scope hash.

Approval expands only the canonicalized workspace-relative paths and resumes the same durable run. Rejection, expiry, or stale authority blocks the step. Traversal, broad roots, globs, duplicates, absolute paths, junction/symlink escape, write-jail violations, and out-of-scope resulting diffs fail closed. This capability does not expand tool, network, connector, or data permissions and does not claim hostile-code sandboxing.

## Engineering learnings

Engineering learnings are first-class records, not personal Notes and not implicit `MemoryLifecycleService` writes. Eligible verified Code Mode work can create at most one proposal per source run. Proposals remain unavailable to context retrieval until an approval applies activation, update, consolidation, replacement, rejection, or archival.

Active reads are workspace/project/path scoped, recheck source file hashes and commit reachability, and include visible source-run and verification citations. Missing or changed source evidence marks a record stale and removes it from automatic context until reviewed.

## Proof lanes

- `pnpm verify:prompt-retune`
- `pnpm verify:engineering-learnings`
- `pnpm verify:storage:migration-parity`
- `pnpm verify:runtime:truth`
- `pnpm verify:agentic:contracts`
- `pnpm verify:agentic:governance`
- `pnpm verify:agentic:proof`
- `pnpm verify:surface:regression`
- `pnpm verify:visual:regression`
- `pnpm docs:check`

Default enablement requires both SQLite/PostgreSQL parity and packaged Mission Control proof; source typecheck or focused unit tests alone are not an enablement decision.
