# Functional parity and smoothness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use superpowers:subagent-driven-development only if that execution method is explicitly selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all eleven product-review findings and make learning, remembering, follow-through, setup and approvals feel continuous in Chat, with measured comparisons against OpenClaw and Hermes Agent.

**Architecture:** Preserve Gateway authority, the existing canonical stores, durable execution and Change Plans. Connect accepted knowledge to future context, improve selection and correction, and complete proposal-to-reviewed-skill reuse through existing capability owners. Mission Control presents those outcomes without owning runtime state.

**Tech stack:** TypeScript, Fastify, React/TanStack Query, the existing SQLite/PostgreSQL storage adapters, Vitest, Node verification scripts and rendered browser acceptance. No new dependency is planned.

**Spec:** [Product review: F1–F11 and smoothness requirements](../../review/2026-11-18-product-functionality-comparison.md). Also binding: `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/1_0_CONTRACT.md` and closer directory instructions.

**Status:** Implementation and milestone acceptance in progress, authorized by the user on 2026-11-19. Memory, learning, monitoring and follow-through owners are implemented in the shared uncommitted checkout; final rendered, native-model and broad regression checks remain in progress. See [the acceptance index](../../review/assistant-parity-acceptance.md) for passed, failed and inconclusive evidence. The original source HEAD was `9b972c5d2b71d58c3c378fd28a06dcdf7beca159`; source fingerprints include uncommitted and new product files. This work does not authorize a commit, push, deployment, installed-setting changes or experimentation on personal data.

## Global constraints

- Chat remains the single conversation surface. Use the existing visual language; no shell redesign is part of this work.
- `MemoryLifecycleService` remains the memory authority. A retrieval index or profile digest is a derived view, never a new place to approve or mutate knowledge.
- Trace/model-derived durable memory and skills remain proposed/inactive until their governed review, evaluation and promotion succeed. No global autonomy switch substitutes for approval, grants or current policy.
- Bind workspace, session, author, source identity, revision/hash and operation identity on the server. Group/thread/unknown-session access stays session-only unless a separately supported explicit authority permits more.
- Existing immutable context snapshots remain historical evidence. New turns use current eligibility and tombstones; replay does not silently substitute new source bytes. Do not promise removal of retained audit evidence when forgetting active memory.
- Storage changes are additive, transactional and paired for SQLite/PostgreSQL. Allocate the next migration numbers at execution time; never reserve stale numbers in this plan or rewrite existing migrations.
- Preserve unrelated tracked/untracked work. No stage/commit/rebase/merge/push without an explicit instruction for that operation. Use output-lock wrappers for every build/typecheck lane that supplies one.
- No new dependencies without demonstrated need. Reused upstream code must carry its pinned source and MIT notice in `THIRD_PARTY_NOTICES.md` and the distributed license assets.
- Fixtures use isolated roots and synthetic facts. Do not change `config/`, `data/`, `runtime/`, installed profiles or credentials to make a test pass.
- UI work requires rendered interaction checks for all affected states, desktop/mobile, both themes and reduced motion. Tests/builds alone are insufficient.

## Design decisions

1. **One authoritative record, multiple readers.** Trusted structured learnings enter normal recall and the standing-preference digest through lifecycle-owned read ports. Do not copy their text into an independently editable profile or `memory_items` row just to make it discoverable.
2. **Correct properties, not coarse categories.** A scalar preference has subject, predicate and scope. Only an explicitly identified correction may supersede its current value. Separate predicates coexist; ambiguous cases stay proposed. Confidence is not authority.
3. **Search before truncation.** Database search selects from the eligible corpus before final context limits. Embedding/profile compatibility, lineage deduplication and abstention are explicit. Short recall requests must not depend on a magic minimum character count.
4. **Useful learning is an end-to-end outcome.** A suggestion, saved draft, approved artifact, callable instruction and successful reuse are distinct states. Reuse `WorkflowSkillCaptureService` and the capability lifecycle; never impersonate an operator from a background job.
5. **Foreground first.** Learning reviews have durable queued identities, destination readiness checks, coalescing and bounded budgets. Background generation yields to an incoming turn on a shared local model. Unknown usage/effect outcomes are reconciled before retry.
6. **Follow-through is one experience over existing owners.** Compose cron, commitments, heartbeat and proactive work; do not add a second scheduler or silently increase their permission profiles.
7. **Less friction preserves exact consent.** Put review controls and eligible grant durations where the action appears; continue the original durable request after setup/approval where current bindings still allow it. Expiry requires fresh review, not recycled authorization.
8. **Evidence precedes claims.** No observations means insufficient evidence, not stability. Compare matched configurations and product defaults separately; do not claim broad parity from passing unit tests or a favorable model-judge score.

## Review focus

These conditions are mandatory tests in the owning task, not unresolved design questions:

1. A forgotten/corrected preference is still in a warm cache or frozen old snapshot: new turns exclude it, historical evidence is not rewritten (M4/M5/M7).
2. A queued review is coalesced, restarted, disabled or interrupted by a live turn: no source-turn loss, duplicate candidate, unchecked dispatch or repeated paid call with unknown settlement (L1/L2).
3. A source lacks canonical workspace/author identity, or changes while a model drafts: no default-workspace fallback, cross-scope output or promotion of stale bytes (M1/L3).
4. Two tabs approve/recover while the user has a dirty composer and switches workspace: one current operation, preserved draft/focus and an explicit stale result (U3/U4).
5. A scheduled job crosses daylight saving time, quiet hours or ambiguous external-send recovery: use its selected timezone, suppress duplicates and reconcile unknown effects rather than resending (U2).

## Work packages and coverage

Read this master plan and the linked subplan before implementing a task. Each task is one independently testable/reviewable change; it may need more than one implementation session.

| Task | Deliverable | Review coverage | Depends on |
| --- | --- | --- | --- |
| B0 | Isolated baseline and comparison fixtures | All findings; measurable starting point | None |
| [M1](2026-11-18-memory-reliability.md#m1--workspace-bound-consolidation-and-progress) | Correct workspace-bound consolidation and checkpointing | F2 | B0 |
| [M2](2026-11-18-memory-reliability.md#m2--value-aware-secret-detection) | Value-aware secret detection | F7 | B0 |
| [M3](2026-11-18-memory-reliability.md#m3--claim-identity-and-targeted-corrections) | Property-aware memory correction | F3 | M1, M2 |
| [M4](2026-11-18-memory-reliability.md#m4--trusted-learning-to-fresh-recall) | Accepted learning reaches future recall/profile digest | F1 | M1, M3 |
| [M5](2026-11-18-memory-reliability.md#m5--corpus-retrieval-before-context-limits) | Indexed selection, semantic lane and short recall | F4 | M4 |
| [M6](2026-11-18-memory-reliability.md#m6--natural-memory-intent-and-correction-capture) | Natural/multilingual memory intent | F6 | M2, M3, M4 |
| [M7](2026-11-18-memory-reliability.md#m7--typed-continuity-through-compaction) | Typed continuity through compaction/restart | F11 | M4 |
| [L1](2026-11-18-learning-and-evolution.md#l1--destination-readiness-before-model-work) | Skip learning that has no usable destination | F10 | M1 |
| [L2](2026-11-18-learning-and-evolution.md#l2--durable-foreground-first-review-queue) | Durable, foreground-first background review | F10 | L1 |
| [L3](2026-11-18-learning-and-evolution.md#l3--suggestion-to-reviewed-procedural-skill) | Complete procedural learning with exact evidence | F5 | L2, M3 |
| [L4](2026-11-18-learning-and-evolution.md#l4--governed-memory-maintenance) | Replace production-dark maintenance safely | F5 | L2, M4 |
| [L5](2026-11-18-learning-and-evolution.md#l5--evidence-based-improvement-monitoring) | Distinguish stable from insufficient evidence | F9 | B0 |
| [U1](2026-11-18-follow-through-and-friction.md#u1--effective-readiness-and-guided-setup) | Outcome-oriented effective setup | F8; setup friction | L1 |
| [U2](2026-11-18-follow-through-and-friction.md#u2--predictable-follow-through) | Unified follow-through control and delivery | F8; notification friction | U1, M7 |
| [U3](2026-11-18-follow-through-and-friction.md#u3--continue-after-setup-approval-or-expiry) | Continue after setup/approval; safe expiry recovery | Approval/connector friction | U1, M7 |
| [U4](2026-11-18-follow-through-and-friction.md#u4--inline-learning-decisions-and-use-receipts) | Inline learning review and actual-use receipts | F1/F5; review friction | M4, L3, L4 |
| [U5](2026-11-18-follow-through-and-friction.md#u5--responsiveness-and-recovery-acceptance) | Responsive streaming, recovery, focus and drafts | Smoothness across all journeys | L2, U2, U3, U4 |
| B1 | Held-out comparative acceptance and release evidence | All requirements | All preceding tasks |

Recommended sequence: B0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → L1 → L2 → L3 → L4 → L5 → U1 → U2 → U3 → U4 → U5 → B1. U1/L5 and other disjoint work can be moved earlier after their dependencies. Default to serial implementation because the composition, contracts and migration owners overlap.

The first useful milestone is **M4**: an approved lesson reliably affects a fresh conversation and can be corrected/forgotten. The next is **L3/L4**: useful learning is generated and reviewable. The final milestone is **U5/B1**: this works smoothly through the actual product and has comparative evidence.

## File structure and shared verification

- The memory subplan owns new claim/read-repository contracts and their migrations, and changes only memory-related composition in `gateway-service.ts`.
- The learning subplan owns background job contracts, draft adapters and watch outcomes, extending existing durable/capability owners.
- The UX subplan owns readiness/continuation projections and cockpit components, shared clients and route wiring. It consumes the first two subplans' types rather than reconstructing them.
- B0/B1 own `scripts/verification/assistant-parity-proof.mjs`, `scripts/verification/lib/assistant-parity/` and fixtures, plus the new `verify:assistant:parity` package script. Existing `verify:agentic:parity` retains its current meaning.
- New storage repositories register in `packages/storage/src/index.ts` and travel through the existing async/worker adapters. Add parity tests for the real PostgreSQL path; synchronous SQLite success is insufficient.
- A task that adds a public type updates contracts, schemas, shared client, producer and consumer together. New data fields remain readable by legacy rows; inactive/unknown/legacy records are not automatically promoted.
- Focused Gateway tests: `pnpm --filter @goatcitadel/gateway exec vitest run <exact test files in task>`. Frontend/contracts/memory-core use their package's `exec vitest run` in the same form. Storage tests use `pnpm --filter @goatcitadel/storage exec tsx --test <exact test files>`.
- Run focused red tests, implement, then the same green tests. Run the named risk lanes at each subplan's exit. Schema/build lanes use the repo's output-lock wrappers, including wrapping `verify:storage:migration-parity` if needed because that script currently builds dependencies.
- No commit checkbox is required by this plan: produce a reviewable diff, evidence and remaining limitations. Commit only when separately authorized.

## B0 — establish the baseline and comparative harness

**Files:** create `scripts/verification/assistant-parity-proof.mjs`, `scripts/verification/lib/assistant-parity/{runner,adapters,scoring}.mjs`, corresponding `.test.mjs` files, `scripts/verification/fixtures/assistant-parity/{cases,manifest}.json`; modify `package.json`. Promote the synthetic review probes into the relevant task's normal test suite; do not depend on ignored scratch files.

**Interfaces:** export `runAssistantParitySuite({ mode, products, caseIds, outputRoot, providerConfig, maxCostUsd })`. `mode` is `fixture | live`; product IDs are `goatcitadel | openclaw | hermes`. The result carries per-case outcome, exact product ref/config, source/grant disposition, model/tool/queue/human-wait timings, usage/cost including unknown values, and evidence paths. Fixture mode tests the harness and GoatCitadel fixture journey; it never certifies competitor behavior. A missing product adapter or unavailable runtime is `not_run`, never a win or a zero-cost result.

- [ ] Write runner/scorer tests that reject missing product/version/config, held-out leakage, substituted model identity, mislabeled fixture output and a live run without a configured cost ceiling. A 30-second operator wait must not be included in provider latency.
- [ ] Run `node --test scripts/verification/lib/assistant-parity/runner.test.mjs scripts/verification/lib/assistant-parity/scoring.test.mjs`; expect failures on the absent implementation.
- [ ] Implement the runner using the existing verification runtime isolation, redaction and artifact conventions. Record a stable baseline of current GoatCitadel behavior before any fix. Isolate every product profile and fixture tool. Do not install or run a competitor against its ordinary user profile.
- [ ] Define 120 synthetic cases: 20 each for continuity, recall, procedural learning, proactiveness, recovery and smoothness. Freeze 12 development and 8 held-out cases per suite (72/48 total); keep a separate 24-case scope/poisoning/consent adversarial set. Label expected outcomes, relevant/forbidden sources and allowed effects before execution.
- [ ] Run the green runner/scorer tests and `pnpm verify:assistant:parity -- --mode fixture`. Persist versioned baseline artifacts in the verification run's artifact root; write only a manifest/fixture corpus into source control.

## Competitor adaptation and licensing

Use the inspected refs as the initial baseline. Changes to those refs require a renewed diff/license check. Sources are implementation references, not dependencies that GoatCitadel imports at runtime.

| Mechanism | Pinned source | Receiving tasks |
| --- | --- | --- |
| Grounded merge/supersession validation | [OpenClaw consolidation](https://github.com/openclaw/openclaw/blob/7f059c01cd032a41517e6aacdc5598d4bb3b70bb/extensions/memory-core/src/dreaming-consolidation.ts) | M3, L4 |
| Durable scoped intentions, expiry and cooldown | [OpenClaw intent kernel](https://github.com/openclaw/openclaw/blob/7f059c01cd032a41517e6aacdc5598d4bb3b70bb/extensions/memory-core/src/standing-intents-kernel.ts) | U2 |
| Unique-target patching and ambiguity handling | [Hermes memory store](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/tools/memory_tool_store.py) | M3, M6 |
| Lineage-aware search and selective expansion | [Hermes session recall](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/tools/session_search_tool.py) | M5 |
| Coalescing and foreground priority | [Hermes idle queue](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/agent/review_idle_queue.py) | L2 |
| Restricted review and cache-aware routing | [Hermes background review](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/agent/background_review.py) | L2, L3 |

Both inspected root licenses are MIT. Before any literal copy or adapted port, include the full relevant upstream notice and source commit/path in `THIRD_PARTY_NOTICES.md`, retain required headers, and include its license in distributed payloads. Reuse behavior and tests where they fit; do not import file-backed authority, permissive approval fallbacks, unrelated dependencies or another scheduler. No upstream code has been integrated by this planning task.

## B1 — final acceptance and release gate

**Files:** extend B0's fixtures, adapters and scorer tests; update `docs/1_0_RELEASE_EVIDENCE.md`, `docs/1_0_CONTRACT.md` and `docs/CANONICAL_RUNTIME_STATE_MODEL.md` only to reflect completed proof. Add `docs/review/assistant-parity-acceptance.md` as the human-readable evidence index.

**Interfaces:** consumes B0's unchanged result schema plus named-lane artifacts from M/L/U tasks; emits an acceptance manifest with `passed | failed | inconclusive | not_run` per product/category/configuration. Do not overload `stable` or `passed` to mean missing evidence.

- [ ] Write scorer tests asserting that a scope/consent violation fails acceptance regardless of task score; insufficient samples or unavailable competitors cannot produce a parity claim; unknown costs remain unknown; model/config differences are disclosed.
- [ ] Run the red tests, implement the gate, and rerun them green. Run the 72 development cases throughout implementation, then the 48 held-out cases without tuning on their answers. Run all 24 adversarial cases.
- [ ] Compare each product under matched model/reasoning/tool fixtures, then separately under documented product defaults. Live mode requires configured providers and a stated budget. Record actual upstream versions; do not assume the inspected code is the version installed for a run.
- [ ] Require no forbidden-source/unauthorized-effect regressions, all mandatory deterministic journeys passing, and better GoatCitadel outcomes than its B0 baseline. Before claiming measured category parity, require the success-rate difference from the strongest measured competitor to have a 95% bootstrap interval above a -5 percentage-point non-inferiority margin. Increase independent task samples if inconclusive; report inconclusive until then. Do not inflate confidence by treating repeated answers to one task as independent tasks.
- [ ] Run `pnpm verify:memory:truth`, `pnpm verify:routed-context:snapshots`, `pnpm verify:durable:recovery`, `pnpm verify:runtime:truth`, `pnpm verify:skill-learning`, `pnpm verify:self-improvement:trust`, `pnpm verify:chat-evolution`, `pnpm verify:surface:regression`, `pnpm verify:cockpit:performance`, `pnpm verify:accessibility:smoke`, `pnpm verify:desktop`, `pnpm docs:check` and relevant schema parity proof. Recheck these existing aliases if the checkout changes before execution. Missing real-PostgreSQL credentials or Windows symlink capability is unverified, not skipped-as-pass.
- [ ] Run the manual/rendered U5 matrix with matching source frontend/backend and the packaged Windows app. Keep provider time, operator time, local queueing and UI overhead separate. Perform an isolated 24-hour proactive/restart soak with a controlled clock plus a real-clock delivery smoke, selected quiet hours and a hard cost ceiling.
- [ ] Update evidence docs with exact commands, refs, fixture/live distinction, costs, failing/unrun checks and rendered states. Publish no product-wide competitor superiority claim beyond the measured categories/configurations.

## Rollout and rollback

1. Land bounded correctness fixes first: M1/M2/M3 and L1/L5. Preserve existing flags and installation preferences.
2. Roll out new recall/candidate paths behind independent default-off flags until their lanes pass. U1 offers an explicit, scoped setup path; do not toggle users' existing settings during upgrade.
3. Build new derived indexes online in bounded pages. Mixed old/new records remain readable; unknown legacy ownership is excluded from private cross-session recall pending operator reconciliation. No broad memory migration or silent semantic inference over historical personal text.
4. Preserve pre-change policy/config revisions and immutable source/candidate evidence. Feature rollback disables new readers/dispatchers without dropping canonical records. Already queued jobs re-check flags and remain visibly deferred/cancelled; they do not disappear.
5. Never undo a reviewed correction by reviving superseded or quarantined data. Before disabling an accepted-memory reader, show degraded continuity explicitly and retain a supported operator export/review path.
6. Ship each milestone with its own evidence. The comparative benchmark is a claim gate; unavailable competitor tooling does not justify blocking unrelated correctness fixes or fabricating comparison results.

## Plan self-review

- F1–F11 each have a task, negative cases and a named verification exit; the table above is the coverage checklist.
- Smoothness includes setup, approval/expiry recovery, inline review, notifications, foreground scheduling, streaming, reconnect, draft/scroll/focus preservation and mobile accessibility.
- Existing explicit skill capture and draft recovery are extended rather than recreated. The production-dark maintenance stage is not connected to the legacy direct artifact writer without a governed proposal boundary.
- Migration, cache, source drift, tombstone, concurrency, consent, failed-model and unknown-effect conditions are included in the subplans.
- This planning task validates document structure/paths and governance checks only. Future implementation tests and competitor runs remain unchecked.
