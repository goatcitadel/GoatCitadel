# Codex follow-up improvements

Scope: the five recommendations authorized in this chat, delivered sequentially. The missing W0–W6 specification and optional Codex adapter are not part of this plan. Upstream patterns were reviewed at Codex `09bced5ad95069494aa5a2da49c77a50a317a9b1`.

## Delivery and acceptance

1. **SF1 — Skill-selection evaluation.** Add deterministic, bounded metadata ranking and an offline comparison against the existing selector. Reuse the skills package and Gateway callable-catalog binding. Runtime selection remains unchanged; scores are rankings, not calibrated confidence. Prove explicit requests, irrelevant queries, deterministic ties, bounds, dependency behavior, and exclusion of noncallable skills. Run focused tests, the skills suite/typecheck, and the curated offline evaluation.
2. **SF2 — Windows command coverage.** Extend the existing shell-risk owner with regression cases for explicit PowerShell/CMD invocations, quoting, encoded scripts, aliases, and nested execution. Fix reproduced classification gaps without executing fixture commands, adding dependencies, weakening approvals, or claiming a sandbox. Run focused policy tests and policy typecheck.
3. **SF3 — Async clarification.** Reuse Gateway-owned pending-input, durable execution, and Chat projections. Optional questions allow independent work to continue; required input and approvals retain blocking semantics. Prove reply binding, restart behavior, cancellation, and continued enforcement. Run targeted Gateway/shared UI tests, durable recovery, and browser proof where practical.
4. **SF4 — Context visibility.** Extend existing budget accounting with a read-only model-visible estimate. Preserve unknown limits and distinguish estimates from reported usage. Do not add unconditional full-prompt serialization to the hot path. Prove scope, bounded output, provider uncertainty, and accounting against current context.
5. **SF5 — Original user authority.** Strengthen existing context/provenance composition and regression coverage so summaries and copied child context cannot become original user authorization. Preserve existing canonical grants, approvals, secure setup receipts, and frozen routed context. Run targeted composition/delegation/compaction tests and relevant truth lanes.

## Constraints

- Preserve the pre-existing tracked and untracked work. Read targets immediately before patching and inspect overlapping diffs.
- Keep experiments disabled by default; no paid/live-provider calls or operator configuration changes.
- No staging, commits, pushes, deployments, new primary conversation surfaces, or parallel runtime owners.
- Validate each slice before starting the next. Broaden proof according to the changed owner.
- Record actual results and unfinished acceptance IDs. Do not equate curated evaluation with real-world quality or a build with runtime proof.

## Results

### Package status and evidence

| Slice | Status | Result and existing owner |
| --- | --- | --- |
| SF1 | Complete, evaluation only | Added bounded metadata ranking in `packages/skills/src/selection-ranking.ts`, and an explicit evaluation entry point beside `resolveCallableSkillActivation`. Only canonical callable skills enter the comparison. Live selection and dependency activation are unchanged. |
| SF2 | Complete, conservative hardening | Extended `classifyShellRisk`, which is already used by both policy evaluation and executor revalidation. Literal PowerShell/CMD wrappers, delete aliases, encoded commands, nesting, indirect execution, and unsupported syntax receive review under the existing configured risk policy. This is not a complete shell parser or a sandbox. |
| SF3 | Partial, existing behavior proven | Three new delegation regressions prove that optional questions, required questions, and approvals pause their child and dependent steps while independent branches continue. A standalone nonblocking question/reply flow is not implemented; see unfinished acceptance IDs below. |
| SF4 | Complete, default disabled | The existing model-callable `session.status` tool can return a read-only estimate of the next provider request, using the existing input-token estimator and exact provider/model context metadata. Tools and current results are counted; output capacity is reserved. Unknown limits stay `null`. |
| SF5 | Complete, source hardening | Compaction anchors original/latest asks only to direct canonical operator messages, retains source labels and message references, marks excerpts incomplete, and fences both new and reused summaries as derived data. Summary source hashes now include actor/source/delegation provenance. Existing policy, grants, approval seals, capability profiles, and delegated-output screening remain the execution authority. |

### Actual validation

- Skills suite: **11 files, 53 tests passed**. Skills typecheck passed.
- Gateway callable selection and evaluation: **2 files, 9 tests passed**.
- Offline curated skill comparison: **6 prompts; existing selector 5/6 hits versus ranking 4/6; 8 versus 14 selections**. The candidate introduced more irrelevant selections. This small corpus does not justify changing live selection; no paid/provider evaluation ran.
- Windows classifiers, final targeted run: **3 files, 38 tests passed**. Initial fixtures reproduced ten classification failures before the fixes. Fixture commands were never executed.
- Policy engine/executor shell tests: **24 passed, 227 skipped** by the explicit shell-name filter.
- Broader policy suite before the final five additional classification fixtures: **77 files, 1,016 passed, 1 skipped**. The added fixtures and classifier refinements were then verified in the final targeted run; the final policy typecheck also passed.
- Delegation, capability profiles, ordinary/secure input routes, and durable execution: **4 files, 222 tests passed**, including the three new independent-branch cases.
- Context estimates, budget receipts, flag round-trip, and settings patch schema: **4 files, 22 tests passed**.
- Compaction/history initial compatibility run: **5 files, 43 tests passed**; new authority and provenance-hash coverage: **2 files, 23 passed**. Final combined compaction/history, context estimates, feature flags, and callable-skill regression run: **12 files, 83 tests passed**.
- Output-lock-protected typechecks passed for contracts, policy engine, Gateway, and Mission Control shared API; no live output lock was bypassed.
- `verify:gateway:async-boundary`: **10 scanner tests passed**, followed by the production scan passing for **1,124 TypeScript files**.
- `verify:routed-context:snapshots`: **passed**, seven scenarios passed; PostgreSQL execution was skipped because its test connection was not configured. Evidence: `artifacts/verification/2026-10-03T00-38-02-195Z-routed-context-snapshots-001b0941/manifest.json`.
- `verify:runtime:truth`: **passed**, three scenarios passed; `runtime-truth.canonical-next-shell-consistency` skipped because the served approvals route did not hydrate within 30 seconds. Headless profile-free approval admission and restart/resume passed. Evidence: `artifacts/verification/2026-10-03T00-40-39-446Z-runtime-truth-ade577a8/manifest.json`.
- `verify:durable:recovery`: **passed**, all four scenarios passed (stack-backed restart/dead-letter recovery, worker tests, approval wakes, orchestration phase parking). Evidence: `artifacts/verification/2026-10-03T00-43-19-192Z-durable-recovery-0a699c70/manifest.json`.
- `docs:check`: **failed on an unrelated validator/header mismatch**. The validator requires the `2026-08-14` freshness header in `docs/1_0_CONTRACT.md`; the current contract is dated `2026-10-02`. Neither file was changed by this task.
- `git diff --check`: passed, including the final source changes. New evaluation, policy, and regression files passed Prettier checks.

### Compatibility and rollout

- No new dependencies, storage migrations, provider adapter, primary UI surface, or capability activation path were introduced.
- Skill ranking is callable only through the explicit offline/evaluation function and script. It is not connected to automatic runtime selection.
- `chatContextBudgetVisibilityV1Enabled` is absent/false by default. Its optional config/env/settings plumbing preserves explicit false and existing stored values through unrelated patches. No operator configuration was changed. The estimate is computed only for a successfully executed `session.status` request after normal policy and capability enforcement.
- Budget estimates are not reported token usage, a calibrated tokenizer result, a quota promise, or execution authority. Provider-added context remains outside the estimate. Missing route/limit/output-reserve information yields unknown remaining capacity.
- Shell classification remains subordinate to configured patterns, the existing risky-command approval setting, deny-wins policy, grants, path jails, and executor checks. Empty configured risk policy retains its previous behavior. Unknown Windows constructs may now require review.
- Compaction keeps its existing persistence and model-message shape. Provenance-aware source hashes invalidate old summary reuse without a schema change; ordinary fallback remains verbatim context if a window cannot be safely rebuilt. Derived summaries never create original operator provenance or authorization records.
- Windows/PowerShell testing used repository commands and temporary verification fixtures. No user data, credentials, installed payloads, or pre-existing servers were deliberately modified or stopped.

### Unfinished acceptance IDs and limitations

- **SF3-A1 — standalone asynchronous question issuance:** the current pending-input owner has one prompt and blocking wait semantics. There is no default-off model-callable optional-question operation with nonblocking issuance.
- **SF3-A2 — durable reply delivery during active work:** `SessionMutationAdmissionRepository.resolveDurableChatUserInput` accepts an exact waiting durable run and queues it through the atomic continuation seal. A running-turn answer needs a distinct guarded delivery operation; bypassing that with `ChatSteerService` would lose replies on restart because its queue is in memory.
- **SF3-A3 — answer consumption/replay/cancellation:** no new durable mailbox/consumption contract or same-turn model-loop injection was added. These need exact admission/session/turn/run, generation, scope, actor, expiry, duplicate-delivery, and cancellation proof before use.
- **SF3-A4 — nonblocking Chat projection and browser proof:** no new optional-question card or reply client flow was added. Existing required questions and approvals continue to block the dependent execution they govern.
- The supplied W0–W6 specification remains absent from this checkout. No W0–W6 acceptance IDs or section-10 completion are claimed, and O1 remains excluded.
- No live-provider, paid, installed-desktop, installer, or hostile-code sandbox proof was performed. The skipped UI and PostgreSQL scenarios are not counted as executed proof.

### Changed files owned by this task

- Skills/evaluation: `packages/skills/src/selection-ranking.ts`, `selection-ranking.test.ts`, `index.ts`; `scripts/evaluate-skill-selection.ts`; `apps/gateway/src/services/callable-skill-activation.ts`, `callable-skill-selection-evaluation.test.ts`.
- Windows policy: `packages/policy-engine/src/sandbox/windows-shell-risk.ts`, `shell-risk-gate.windows.test.ts`, `shell-risk-gate.ts`.
- Independent wait coverage: `apps/gateway/src/services/chat-delegation-service.loop20-worker-a.test.ts`.
- Context budget/runtime plumbing: `apps/gateway/src/services/chat-agent-prompt-budget-receipt.ts`, `chat-context-budget-visibility.test.ts`, `chat-turn-agent-runner.ts`, `gateway-service.ts`, `gateway/feature-flags.ts`, `gateway/runtime-settings.ts`, `gateway-service.feature-flags.roundtrip.test.ts`; `apps/gateway/src/config.ts`, `routes/dashboard.ts`, `routes/dashboard.feature-flags-patch-schema.test.ts`; `packages/contracts/src/config-schemas.ts`; `packages/mission-control-shared/src/api/types.ts`.
- Compaction: `apps/gateway/src/services/chat-compaction.ts`, `chat-compaction.authority.test.ts`, `chat-message-history-service.ts`, `chat-message-history-service.test.ts`, `gateway-service.compaction.test.ts`.
- Plan and report: this file.

### Repository state

Work remains unstaged in the shared `main` checkout, with **32 modified tracked files and 18 untracked files** including pre-existing work. The index is empty. This task did not stage, commit, push, deploy, reset, restore, or change operator configuration. Other work advanced HEAD during the task from `26c83276c07e46f3ca7e4f8409840c2b4126293e` to `8f2b95d2b1438b6bc5a052a984d33849fba5bddf`; this task did not perform that publication. Initial hashes still match 35 of the 36 pre-existing tracked/untracked files. The remaining file, `chat-turn-agent-runner.ts`, was surgically extended while retaining its pre-existing edits. The verification/build output lock is absent. No listeners remain on the fixture ports recovered from the task-owned logs (`54780`, `58799`, `61699`).
