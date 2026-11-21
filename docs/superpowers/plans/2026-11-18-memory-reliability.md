# Memory reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use superpowers:subagent-driven-development only if explicitly selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F1/F2/F3/F4/F6/F7/F11 so accepted, scoped knowledge is useful in future work, corrections are precise, recall reaches old facts, and compaction preserves continuity.

**Architecture:** Extend lifecycle-owned reads and existing canonical records; keep indexes and profile digests derived. Use scoped corpus retrieval, explicit claim identity and exact correction targets. Preserve approved-source provenance and immutable admitted snapshots across all paths.

**Tech stack:** Existing contracts, memory-core, storage, policy-engine and Gateway packages; SQLite FTS5/PostgreSQL full-text search through repository dialects; Vitest and isolated verification runtimes.

**Spec:** [Product review](../../review/2026-11-18-product-functionality-comparison.md), [master plan and global constraints](2026-11-18-functional-parity-and-smoothness.md). B0 is the prerequisite. Types below are planned additions unless explicitly identified as existing.

## Global constraints

Inherit every master-plan constraint. Memory writes and promotions stay with `MemoryLifecycleService`. All new SQL belongs in storage repositories. No raw logs/tool output become trusted memory. Every migration is additive and paired; no implicit inference/ownership backfill of legacy personal data. Source status/hash must be checked before new-context admission, not just at search time.

## Review focus

1. Identical completion timestamps and one failed session cannot lose unprocessed turns or advance another workspace's checkpoint (M1).
2. Ordinary words about tokens/credentials remain usable while actual synthetic credentials stay blocked in content and diagnostics (M2).
3. Two concurrent corrections or a paraphrased ambiguous target cannot replace an unrelated fact (M3).
4. Warm cache, group/unknown session and forgotten legacy records cannot leak a stale/private preference into a new turn (M4/M5).
5. A late constraint in a long message survives repeated compaction, branch edit and restart without converting historical text into authorization (M7).

## File structure

- `packages/contracts/src/memory-claims.ts` (new): claim identity/correction shapes; references added to existing memory/profile contracts.
- `packages/storage/src/memory-consolidation-progress-repo.ts` (new): workspace checkpoints/leases; existing trace repository supplies eligible pages.
- `packages/storage/src/memory-learning-repo.ts` (new): typed read, claim transition and history operations for the existing `memory_learnings` records; extract only SQL touched by these tasks from the large lifecycle service.
- `packages/storage/src/memory-recall-repo.ts` and `memory-recall-vector-index.ts` (new): scoped searchable projection and optional worker-owned semantic candidates. No independent approval state.
- `packages/memory-core/src/memory-claim-policy.ts` (new): pure claim comparison; existing collector/ranker/selector handle new sources.
- `apps/gateway/src/services/memory-intent-service.ts` and `chat-continuity-ledger.ts` (new): bounded proposal classification and task continuity respectively.
- Existing lifecycle/context/operator-profile/consolidation/history services remain their public owners. Contract additions export from `packages/contracts/src/index.ts`; repository additions register/export in `packages/storage/src/index.ts` and existing worker adapters.
- Schema changes use `packages/storage/src/sqlite.ts`, a focused schema helper under `packages/storage/src/sqlite/`, and `packages/storage/src/postgres/migrations.ts`. Allocate migration IDs at implementation, after rechecking concurrent work.

## M1 — workspace-bound consolidation and progress

**Coverage/dependency:** F2; after B0.

**Files:** modify `apps/gateway/src/services/memory-consolidation-service.ts`, `gateway-service.ts`, `gateway/system-cron-schedulers.ts`, `packages/storage/src/chat-turn-trace-repo.ts`; create the progress repository and its `.test.ts`/`.postgres.test.ts`; extend `memory-consolidation-service.test.ts` and `gateway/system-cron-schedulers.memory-consolidation.test.ts`; add paired schema changes.

**Interfaces:** replace global checkpoint dependencies with `readProgress(workspaceId: string): Promise<ConsolidationProgress>` and `commitProgress(workspaceId: string, expectedRevision: number, next: ConsolidationCursor): Promise<ConsolidationProgress>`. `ConsolidationCursor` is `{ finishedAt: string; turnId: string }`; progress has `cursor?: ConsolidationCursor` and `revision: number`. Add `resolveEligibleSourceSession(sessionId: string): Promise<{ workspaceId: string } | undefined>` and workspace-filtered `listCompletedTracePage({ workspaceId, after?, through, limit }): Promise<{ traces: ChatTurnTraceRecord[]; hasMore: boolean }>` to the service port. Missing ownership is not `default`.

- [ ] Write red tests: workspace B's proposal has `workspaceId: 'B'`; identical A/B insights do not dedupe across scope; missing/group/machine-source sessions make zero model calls; equal timestamps paginate by turn ID; one failed session preserves the unprocessed prefix; flipping autonomy off between batches prevents further proposals.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-consolidation-service.test.ts src/services/gateway/system-cron-schedulers.memory-consolidation.test.ts`; verify the missing-binding test fails on current code.
- [ ] Implement server-owned workspace resolution before transcript/provider reads, scoped dedupe and a fixed upper cursor per sweep. Bind workspace to usage attribution and proposals. Store per-workspace checkpoint CAS; do not advance past an unfinished source. Keep the existing bounded session/candidate limits with fair continuation across runs.
- [ ] Add repository parity tests for equal timestamps, concurrent checkpoint CAS and restart after a partial batch. Keep the old global watermark for audit; initialize new scoped progress from a bounded seven-day lookback, with dedupe/rejection/forget exclusions preventing resurrection. Never assign old foreign-source proposals to a workspace automatically; produce a bounded reconciliation preview for operator review.
- [ ] Run the green focused tests, new repository tests and named memory/storage exits. Prove one non-default workspace round trip through the public API, not only a spy on the proposal dependency.

## M2 — value-aware secret detection

**Coverage/dependency:** F7; after B0. Independently releasable.

**Files:** modify `apps/gateway/src/services/memory-write-gate-service.ts`, `chat-learned-memory-service.ts`, `background-review-service.ts` where they repeat secret checks, and `packages/contracts/src/secret-redaction.ts` only if its current value detectors miss required cases. Create `apps/gateway/src/services/memory-write-gate-service.test.ts`; extend `packages/contracts/src/secret-redaction.test.ts` and existing learned-memory/background-review tests.

**Interfaces:** preserve existing `MemoryWriteGateService.evaluate(input): MemoryWriteGateDecision`. Use existing `redactSecretText(content, options): SecretTextRedactionResult` as the shared primitive; block storage if it detects an actual secret. Add a focused shared detector only for a tested missing value format; bare vocabulary must not be evidence of a credential. Do not import the private helper in `skill-learning-service.ts` as a new public contract.

- [ ] Write cases asserting `evaluate({authority:'operator', content:'Remember that I prefer low token usage.'}).decision === 'allowed'`, tokenization/keychain discussion is allowed, and synthetic bearer/API tokens plus `my password is <synthetic value>` are blocked. Diagnostics must not echo rejected values. Keep authority/contradiction rules independently covered.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-write-gate-service.test.ts`; expect harmless-token cases to fail before changing the gate.
- [ ] Replace bare-word secret matching with value/context detection. Normalize bounded Unicode input and handle structured assignments without turning numeric token budgets or a discussion of passwords into secrets. Reuse the same decision in learned extraction and background proposals.
- [ ] Run the green tests and `pnpm --filter @goatcitadel/contracts exec vitest run src/secret-redaction.test.ts`. Verify direct, proposal, profile-digest and tool-originated memory paths still reject actual secret values.

## M3 — claim identity and targeted corrections

**Coverage/dependency:** F3; after M1/M2.

**Files:** add `packages/contracts/src/memory-claims.ts`/`.test.ts`, `packages/memory-core/src/memory-claim-policy.ts`/`.test.ts`, the learning repository; modify existing `memory.ts`, `learned-memory.ts`, `operator-profile.ts`, `learned-memory-repo.ts`, `memory-lifecycle-policy.ts`, `chat-learned-memory-service.ts`, `operator-profile-service.ts`, `memory-lifecycle-service.ts`, memory route/client schemas and their tests; add paired claim-field/history/index migrations.

**Interfaces:** `MemoryClaimIdentity = { subject: string; predicate: string; scope: { kind: 'workspace' | 'project' | 'session'; id: string }; cardinality: 'scalar' | 'set' }`, with a server-computed key that includes workspace. Persist optional identity/value on canonical learning and learned-memory records; profile facts may carry source/claim references. `classifyMemoryClaimChange({ incoming, current }): 'independent' | 'duplicate' | 'correction' | 'ambiguous'` is pure; `incoming` includes identity, value, authority and an optional explicit target `{sourceRef, expectedSourceHash}`. The lifecycle's reviewed correction applies to that exact target/version transactionally.

- [ ] Write red tests asserting different predicates coexist; equal scalar identity plus an explicit opposite-value correction supersedes only its target; higher model confidence alone cannot replace an operator claim; set-valued interests may coexist; no identity means no automatic contradiction/supersession by text overlap. Two stale/concurrent target hashes must produce one applied correction and one conflict.
- [ ] Run policy/learned-memory tests red: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-lifecycle-policy.test.ts src/services/gateway-service.learned-memory.test.ts` plus the new memory-core policy tests.
- [ ] Implement claim identity, exact-target transition and history within the lifecycle/storage owner transaction. Remove first-item-of-type/low-overlap conflict inference. For ambiguous identification, retain an inactive proposal with a targeted clarification; do not suppress an unrelated valid fact. Migrate no legacy text into inferred semantic properties; explicit later review can bind a legacy target.
- [ ] Adapt OpenClaw's prior-entry/lineage/project-group validation and Hermes' unique-target matching as pure logic/test fixtures if useful. Typography folding may identify a review target; final mutation must still match its canonical ID/hash. Include upstream notices for any port.
- [ ] Run green contracts/policy/repository tests, real PostgreSQL CAS/unique-active-scalar tests and storage parity. Prove old preference → reviewed correction → new preference, with untouched project-language preference and inspectable old history.

## M4 — trusted learning to fresh recall

**Coverage/dependency:** F1; after M1/M3.

**Files:** extend `packages/contracts/src/memory.ts` and `packages/memory-core/src/{types,candidate-collector,citation-validator}.ts`; modify `memory-lifecycle-service.ts`, `memory-context-service.ts`, `operator-profile-service.ts`, `chat-turn-prep-service.ts`, `memory-context-utils.ts`, `packages/storage/src/memory-context-repo.ts`; add learning-repository scoped reads and `apps/gateway/src/memory-learning-recall.integration.test.ts`. Update existing memory provenance/renderer presenters for the added source kind.

**Interfaces:** extend `MemoryCitation.sourceType` and `MemorySourceInput` with `memory_learning`, using `sourceRef = learningId` and a source hash over canonical status/content/claim/lineage. Add lifecycle-owned `collectTrustedRecallSources(input: { workspaceId: string; sessionId: string }): Promise<MemorySourceInput[]>`; it derives current access itself and returns only eligible sources. `composeFrozenProfileDigest(workspaceId)` remains the existing external method, but builds standing preferences from current canonical profile facts plus accepted scoped claims, with source references rather than a text-copy write to `operator_profiles`.

- [ ] Write a public-API test: propose in A, accept, create a fresh private session in A, ask a held-out formatting task and assert both the admitted `memory_learning` citation and the behavior. Repeat after correction/forget; assert the old source is absent from fresh admission. B, group/thread/unknown sessions cannot receive A's private learning. Proposed/rejected/superseded records never enter ordinary recall.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/memory-learning-recall.integration.test.ts src/services/memory-context-service.test.ts src/services/operator-profile-service.test.ts`; expect the new integration case to fail before the reader exists.
- [ ] Implement the lifecycle read port behind its owning access guard. Add trusted learnings to context collection and standing-property projection with deterministic conflict precedence from M3. Remove no existing legitimate reader. A source referenced in profile and ordinary recall is deduped by identity, not counted as independent evidence.
- [ ] Invalidate derived eligibility/content generations on promote/correct/forget/expiry; include them and source hashes in new-context cache identity. Preserve immutable old snapshots as evidence and the existing guarded replay policy. A failed projection/publication after canonical commit cannot make promotion retryable or claim recall readiness prematurely.
- [ ] Run green end-to-end tests on both backends, plus memory truth and routed-context snapshot lanes. Restart between promotion and fresh recall. Replaying a pre-correction snapshot must not silently substitute the new preference or act as a new authorization.

## M5 — corpus retrieval before context limits

**Coverage/dependency:** F4, short-prompt/knowledge-reader follow-ups; after M4.

**Files:** create the recall repository/vector index and their unit/real-PostgreSQL tests; extend `memory-context-service.ts`, `memory-context-utils.ts`, `packages/memory-core/src/{candidate-collector,candidate-ranker,candidate-selector}.ts`, `packages/storage/src/{knowledge-repo,chat-message-repo}.ts`, `packages/policy-engine/src/tool-executor/knowledge-executor.ts`, reader tests and paired search/projection migrations. Add `apps/gateway/src/services/memory-corpus-retrieval.integration.test.ts` and labeled fixtures under B0.

**Interfaces:** `searchEligibleCorpus({workspaceId, sessionId, query, sourceTypes, limit, cursor?}): Promise<{hits: RecallHit[]; coverage: RecallCoverage}>` is a lifecycle read port. A hit carries typed source ID/hash, scoped eligibility, lexical/semantic signals and bounded snippet; definitions live in `memory.ts`. `RecallCoverage` reports index readiness/generation, embedding profile and unindexed/ineligible counts. The internal repository requires canonical workspace/scope, never an undefined wildcard. Add `intent?: 'automatic' | 'explicit_recall'` to composition; this is a retrieval hint, not an access grant.

- [ ] Write red fixtures where item 37 and an old item among 10,000 entries outrank recent distractors; an early long file cannot consume every file slot; no-answer queries abstain; correction/forget removes a warm-index hit before admission. `explicit_recall` with `What did we decide?` must not short-circuit solely on character count. Duplicate automation lineages cannot crowd out interactive results.
- [ ] Implement SQLite FTS5/PostgreSQL indexed lexical candidate lookup before limits, using safe query tokenization and bounded top-K (initially 300 merged candidates, 40 ranked candidates, existing final token budget). Indexes are derived from current canonical records and are rebuilt in bounded pages; unreadable or stale source eligibility fails closed.
- [ ] Add an optional real-vector lane through the existing storage worker: normalized compatible vectors, an exact cosine index with paged rebuild/incremental updates, and bounded top-K output. Do not scan all vectors on the UI/Gateway event loop or fetch them all for each query. Measure at the 10,000-entry baseline; report incomplete coverage/degraded lexical mode when rebuilding, unavailable, over capacity or profile-incompatible. No new ANN dependency or semantic-quality claim without measured need/results.
- [ ] Scope knowledge notes before integrating them. New writes bind server-owned workspace/source metadata; legacy unowned documents remain outside automatic private recall until explicitly reconciled. Add a narrow `searchMemory(request: ToolInvokeRequest)` read dependency to `KnowledgeExecutorDeps`, wired to the lifecycle port by Gateway tool composition; the policy-engine package must not import Gateway services. An unavailable binding never falls back to an unscoped corpus. Extend `memory.search` through this port/compatible vector lane while preserving its bounded public result contract. Keep `session.search`/`session.history` for exact archived-message expansion and adopt lineage dedupe/automation demotion from the pinned Hermes reference.
- [ ] Run repository, memory-core and Gateway retrieval tests green; `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-corpus-retrieval.integration.test.ts src/services/memory-retrieval-benchmark.test.ts`. Record labeled precision/recall/abstention/forbidden sources and p50/p95 stage times against B0. No forbidden sources; no new main-thread corpus scan; investigate regressions before enabling the new reader.

## M6 — natural memory intent and correction capture

**Coverage/dependency:** F6; after M2/M3/M4.

**Files:** add `memory-intent-service.ts`/`.test.ts`; extend `learned-memory-utils.ts`, `chat-learned-memory-service.ts`, `background-review-service.ts`, `memory-lifecycle-service.ts` and existing Chat memory-intent/tool-binding tests. Reuse existing LlmService/utility accounting and canonical message authority.

**Interfaces:** `classifyMemoryIntent({content, sourceAuthority, sourceMessageId}): MemoryIntentResult` returns `none | explicit_save | correction | inferred_candidate` plus bounded claim proposals/target references. Explicit save/correction still enters existing lifecycle approval/policy semantics. A model-produced classification never upgrades source authority. The synchronous classifier does no provider calls; richer extraction uses existing admitted foreground tool intent or due background review.

- [ ] Write assertions for English everyday wording and Spanish equivalents: `I prefer concise replies.` becomes an inferred proposal; `Remember that I prefer concise replies.` enters explicit-save handling; `No, use detailed explanations from now on.` targets reply length via M3 when an unambiguous current property exists. Include a preference after the twelfth line. Questions, hypotheticals, quotations, external-channel instructions and secret values cannot become active facts.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-intent-service.test.ts src/services/gateway-service.learned-memory.test.ts`; verify the new phrasing cases are red before implementation.
- [ ] Implement Unicode-aware, bounded intent/sentence handling (8,000-character window with visible truncation/deferred remainder disposition) and structured proposals. Reuse main-turn declared memory operations; use bounded utility extraction only on due background work. Do not add an LLM classifier in front of every chat reply.
- [ ] An ambiguous correction asks one precise question with candidate targets; a bare identity statement can be proposed if durable/useful but is never silently stored as identity. Preserve actor/source evidence and M2 secret checks before any provider dispatch.
- [ ] Run green tests and an isolated Chat journey demonstrating natural save, reviewed correction and fresh-session reuse without magic prefixes. Record extra model-call count; ordinary no-memory conversation adds zero classification calls.

## M7 — typed continuity through compaction

**Coverage/dependency:** F11; after M4. This is task continuity, not automatic durable personal-memory promotion.

**Files:** create `packages/contracts/src/chat-continuity.ts`, `apps/gateway/src/services/chat-continuity-ledger.ts` and tests; modify `chat-compaction.ts`, `chat-message-history-service.ts`, `packages/storage/src/chat-conversation-summary-repo.ts`, history/compaction tests and compatible summary serialization. Add an isolated compaction/restart journey.

**Interfaces:** `buildChatContinuityLedger({messages, turnIds, previous?, canonicalLinks}): ChatContinuityLedgerV1` returns source hash, version, original/latest ask refs and typed entries (`decision | constraint | question | effect | artifact | next_step`) with exact message/span or canonical effect refs and an authority class. `renderChatContinuityLedger(ledger, {maxTokens}): {text, omittedSourceRefs}` produces non-authoritative context. Original `renderConversationSummaryForModel` retains its authorization fence and accepts legacy summaries.

- [ ] Write tests with a critical constraint beyond character 400, >12 messages, two compactions and a restart: the next step uses that constraint and does not repeat a completed effect. A model suggestion is not an accepted decision; copied external instructions are not operator constraints. Branch edits change the source hash and cannot reuse a sibling's summary.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-compaction.authority.test.ts src/services/chat-continuity-ledger.test.ts src/services/chat-message-history-service.test.ts`; confirm the late-constraint/typed-ledger case fails first.
- [ ] Build the ledger from canonical messages/effect links, preserving high-signal state across windows instead of repeatedly summarizing summaries. Render within an upper cap of 2,000 continuity tokens, clamped to the resolved model's remaining input budget so the newest user message and immutable policy prefix are preserved. Retain exact refs for omitted material. A task that requires omitted constraints reopens authorized source context before consequential execution; inability to resolve it is explicit, not silent guessing.
- [ ] Keep learned personal-memory candidates separate and governed. Pre-compaction preservation may queue a proposal through L4 after live-turn settlement; it cannot grant memory writes or delay the reply with a mandatory extra model call. Do not persist raw tool output in the ledger.
- [ ] Run green unit/history tests, storage format compatibility tests, durable recovery and routed-context snapshots. Exercise reload, cancellation and the historical-summary authority fence in the rendered acceptance lane.

## Subplan exit

- [ ] All targeted tests are green; no known regression is hidden behind a fixture skip. The review's Windows symlink fixture failures are rerun in a capable environment and reported separately until proven.
- [ ] Run `pnpm verify:memory:truth`, `pnpm verify:routed-context:snapshots`, `pnpm verify:durable:recovery`, `pnpm verify:runtime:truth`, `pnpm docs:check`, and wrapped storage migration parity plus real PostgreSQL tests for every new repository/transition.
- [ ] Prove proposal → review → fresh recall → correction → fresh recall → forget, across restart and two workspaces, with exact context citations. Publish labeled retrieval coverage/latency and legacy-data exclusions.
- [ ] Update memory sections of runtime/1.0 docs to the actual implemented semantics and retain all unavailable/experimental qualifiers until their proof exists.
