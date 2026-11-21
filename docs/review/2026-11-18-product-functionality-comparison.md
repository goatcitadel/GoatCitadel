# GoatCitadel product functionality review

Review date: November 18, 2026 (America/Los_Angeles).

## Assessment

GoatCitadel has substantial runtime infrastructure for memory, scheduled work, supervision, and governed improvement. Its main shortfall is connecting that infrastructure into an assistant that reliably remembers, follows through, and improves without repeated operator intervention. Adding more surfaces would have less value than repairing those connections and measuring their outcomes.

Comparative parity is **not established**. This review combines current GoatCitadel source inspection, focused test execution, deterministic probes, rendered workflow inspection, and current upstream documentation/code. It does not report a controlled three-product live-provider benchmark. Statements that an upstream mechanism is a better fit are engineering assessments, not measured win rates.

The recommended direction is: retain GoatCitadel's authority and recovery foundations; adopt OpenClaw's stronger memory curation and prospective-memory patterns and Hermes' more direct procedural-learning loop, selective recall, and foreground-first background scheduling. Make those behaviors accessible from Chat with clear setup and compact decisions.

## Evidence and scope

- Local source: `C:\personal-ai`. The shared checkout changed during review; a later observed HEAD was `9b972c5d2b71d58c3c378fd28a06dcdf7beca159`. Pre-existing work was preserved. Findings describe the inspected implementation, not an immutable release certification.
- Runtime owners inspected: memory lifecycle/context/write gate/consolidation, learned-memory extraction, operator profiles, post-turn review, skill learning and instruction reuse, engineering learnings, proactive scheduling, commitments, heartbeat authority, compaction, improvement activation/watch, and related tools/UI.
- Browser inspection: current source frontend on a task-owned local Vite server, connected to the existing installed backend. This is a mixed source/install observation, not proof that the installed UI contains every inspected source change.
- Rendered checks: existing Chat transcript and composer options; Library entry, Memory, diagnostics, quality, entities/decisions and maintenance disclosures; System Health, Quality and experimental Improvement. Desktop dark layout and phone-sized dark Library/Memory/Improvement navigation were inspected. No new messages were sent, proposals promoted, feature switches changed, or external actions executed.
- Unverified UI states: light theme, new-user onboarding, populated proposal editors, pending/expired approval interaction, streaming/stop/reconnect, keyboard-only full journeys, and extended animation behavior. These remain acceptance work.
- Competitor code was read at pinned refs: OpenClaw `7f059c01cd032a41517e6aacdc5598d4bb3b70bb`; Hermes `3371c03df62106a4c93a545787a471e328883d08`. Public docs were accessed during this review and can evolve independently of those refs.
- Reproducible probes and upstream research snapshots: `.tmp/product-review-20261118/`. The scratch snapshots include upstream licenses and a source manifest. They are not runtime integration.

## Comparison by user outcome

| Outcome | GoatCitadel now | OpenClaw approach | Hermes approach | Recommendation |
| --- | --- | --- | --- | --- |
| Remember stable preferences | Operator profile, session learned memory, memory items, knowledge notes and structured learnings exist, but have different readers/writers | Separates curated user/core memory from episodic notes and provenance | Compact user/core stores plus targeted updates | Give every accepted memory an explicit path into the appropriate future context |
| Correct an old preference | Coarse type/overlap rules can misidentify contradictions | Consolidation validates source lineage and prior entries | Entry/span patching resolves a unique target and rejects ambiguity | Identify the subject and property being changed; preserve unrelated facts |
| Recall something from another chat | Workspace-authorized `session.search` and anchored `session.history` already exist; automatic context uses a narrower transcript set | Active recall and indexed episodic memory, with private-conversation eligibility | Search/discover/read/scroll shapes, lineage dedupe and automation demotion | Keep existing scope checks; improve selection, guidance, and retrieval coverage |
| Follow up without prompting | Cron, commitments, heartbeat and proactive durable runs exist, behind several distinct gates | Persistent automation jobs and standing intents | Scheduled tasks, event triggers and goals/loops | Present one comprehensible follow-through setup and management path |
| Learn a reusable procedure | Explicit correction capture, recurrence, candidates, review/evaluation and callable instruction reuse exist | Memory consolidation focuses on grounded durable knowledge; no general self-rewriting claim is warranted | Background review can use memory and skill-management tools | Finish the candidate-authoring-to-verified-reuse path without bypassing governance |
| Improve actual performance | Replay/evaluation, governed activation, snapshots and watch logic exist | Bounded evidence-based memory promotion | Procedural edits, review budgets and user-visible applied-write summaries | Measure held-out task improvement, cost and recurrence of mistakes |
| Stay smooth while learning | Utility routing and durable post-commit work help; some work still produces no usable learning | Memory design explicitly separates curation from the busy reply path | Managed-local reviews defer until idle and coalesce by session | Prioritize foreground turns and skip work whose destination is disabled |

OpenClaw documents curated, episodic, prospective and review tiers, and provenance checks between them. Its consolidation is enabled by default but still has promotion thresholds; that does not guarantee useful promotions in every workload. [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture), [Dreaming](https://docs.openclaw.ai/concepts/dreaming).

Hermes documents bounded `MEMORY.md` and `USER.md` snapshots and optional write approval. Its background review can save memory or update skills; a notification distinguishes applied work from staged writes. These defaults are more permissive than GoatCitadel's reviewed promotion path. [Persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

Both competitors have changed substantially: current OpenClaw docs describe migration of heartbeat monitors to ordinary automations, and current Hermes session-search code returns database messages without an LLM summarization call. Older descriptions of either product would lead to the wrong comparison. [Heartbeat migration](https://docs.openclaw.ai/gateway/heartbeat), [Pinned Hermes search implementation](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/tools/session_search_tool.py).

## Findings, ordered by product impact

### F1 — P1: accepted structured learning is not connected to ordinary recall

**Evidence: source-confirmed reader/writer gap.** `MemoryLifecycleService.promoteTraceMemoryCandidate` creates a trusted record in `memory_learnings`. `insertMemoryLearning` persists that record and publishes an event. The ordinary `MemoryContextService.collectSources` reads transcripts, `memory_items`, and files; it does not read `memory_learnings`. The operator digest reads `operator_profiles`. The generic `memory.search`/`memory.read` tools read the separate knowledge document/chunk store. No ordinary-context consumer of promoted structured learnings was found in the inspected paths.

This is narrower than saying memory never works: explicit notes, memory items, transcripts, profiles and specialized engineering-learning retrieval have working paths. The defect is that promoting a trace-derived insight does not, by itself, connect that insight to those ordinary recall paths.

**User consequence:** an operator can review a proposal successfully and still see no behavioral improvement next chat. This wastes both trust and review effort.

**Change:** make the lifecycle owner expose trusted, current structured learnings as scoped retrieval sources. Route accepted profile preferences to the profile projection through the same governed owner. Preserve source lineage, version, forget/supersession status and frozen context evidence. Avoid maintaining a second unsynchronized copy.

**Acceptance:** propose a preference from session A, approve it, start session B, and prove its exact source appears in B's admitted context and affects a held-out task. Forget or supersede it and prove fresh turns stop using it. Run in SQLite and PostgreSQL and with private/group/workspace boundaries.

Owners: `apps/gateway/src/services/memory-lifecycle-service.ts:3337`, `:3861`; `memory-context-service.ts:855`; `operator-profile-service.ts:149`; `packages/policy-engine/src/tool-executor/knowledge-executor.ts:405` and `:471`.

### F2 — P1: consolidation drops the source workspace binding

**Evidence: deterministic probe plus source.** Consolidation submits a source session/turn but omits `workspaceId`. The lifecycle proposal owner normalizes an omitted workspace to `default`. The service has no dependency that resolves the source session's workspace. Its dedupe reads are also invoked without a workspace; the current lifecycle list methods interpret that as the default workspace, not a global corpus.

The probe produces a candidate from `session-in-workspace-B` with `workspaceIdSubmitted: null`. This proves the binding omission; it does not claim a live cross-workspace disclosure was performed.

**Change:** resolve canonical workspace and session eligibility before transcript/model reads; bind that workspace into drafting attribution, proposal creation, dedupe and progress checkpoints. Partition processing so one workspace cannot suppress another's lessons. Missing/inconsistent ownership should stop that item with a diagnostic.

**Acceptance:** two workspaces with identical and contradictory facts must yield correctly scoped proposals and independent progress. Neither workspace may list, dedupe against, or later recall the other's private facts.

Owners: `memory-consolidation-service.ts:116`, `:194`; `gateway-service.ts:3159`; `memory-lifecycle-service.ts:3225`, `:5099`. Probe: `.tmp/product-review-20261118/probes.ts`.

### F3 — P1: preference conflict handling confuses unrelated and opposite claims

**Evidence: deterministic policy probes.** Two equally confident preferences about different subjects—TypeScript use and reply length—produce `record_conflict`. Two opposite reply-length preferences produce `insert_active`, retaining both. The algorithm compares the first item of the same coarse type using word overlap and confidence distance. It has no property identity or semantic contradiction check. Operator-profile merging also deduplicates by exact kind/content, leaving opposite statements distinct.

**Change:** introduce stable claim identity such as `(workspace, subject, predicate)`, with value, observed time and provenance. A correction to reply length supersedes reply length; it must not affect language preference. When identity is uncertain, propose a targeted question rather than silently creating opposing active rules.

Example desired behavior:

```text
operator.reply_length: concise -> detailed
project.language: TypeScript -> unchanged
```

OpenClaw's inspected consolidation validator requires exact prior-entry evidence, rejects unrelated merges, checks project groups, and requires matching lineage for supersession. This is a stronger model to adapt than overlap-based contradiction inference. [Pinned validator](https://github.com/openclaw/openclaw/blob/7f059c01cd032a41517e6aacdc5598d4bb3b70bb/extensions/memory-core/src/dreaming-consolidation.ts#L199).

**Acceptance:** unrelated facts coexist, direct corrections replace only their target, conflicting claims retain authority and time evidence, and fresh sessions do not receive two active instructions about the same property.

Owners: `memory-lifecycle-policy.ts:77`; `chat-learned-memory-service.ts:148`; `operator-profile-service.ts:439`.

### F4 — P1: relevance ranking happens after a small recency/pinning cutoff

**Evidence: source and deterministic candidate probe.** The default context reader fetches 36 active memory items, ordered pinned-first then newest-first, before relevance ranking. A relevant 37th item never reaches ranking. The collector also caps file chunks globally; a large early file can consume that budget. The probe confirms the relevant item is unreachable after collection, even when the ranker itself is asked for 40 candidates.

**Change:** query an indexed, workspace-filtered corpus for lexical and semantic candidates before applying the final context limit. Reserve a bounded slot for durable standing preferences and diversify by source. Keep limits on returned evidence and work performed, rather than letting a newest-first slice decide what can ever be recalled.

Two additional retrieval distinctions matter: composition short-circuits when its prompt parameter is below the configured minimum (48 characters by default), while the generic knowledge-note `memory.search` path is lexical despite storing embeddings on writes. Neither behavior means all short questions fail or all retrieval is lexical: model-invoked session tools and the separate optional vector-ranking context path already exist. Benchmark the actual reader used by each journey.

Hermes searches a larger FTS candidate pool, deduplicates lineage, demotes recurring automation content before selection, and hydrates detail selectively. Those are useful mechanisms to compare in an indexed retrieval benchmark. [Pinned search](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/tools/session_search_tool.py#L449).

**Acceptance:** retrieve an old exact fact from 10,000 scoped memories despite many newer irrelevant items; score paraphrases, automation noise, competing facts and no-answer queries. Measure precision, recall, forbidden sources and p95 latency.

Owners: `memory-context-service.ts:259`, `:920`; `config.ts:1299`; `packages/storage/src/memory-maintenance-repo.ts:611`; `packages/memory-core/src/candidate-collector.ts`.

### F5 — P1: background review does not finish procedural learning

**Evidence: source-confirmed behavior.** Background review extracts memory facts and a possible skill summary. Post-commit processing submits memory review candidates but retains only a skill fingerprint/boolean; it does not author a skill candidate from that suggestion. Its memory-maintenance stage explicitly returns `production_dark` and `governed_memory_promotion_not_implemented`.

The explicit `/learn` system is more substantial: authenticated correction evidence, history selection, recurrence across at least three sessions, immutable artifacts, candidate lifecycle, evaluation and fresh-turn instruction reuse exist. It should be reused, not replaced. A background suggestion fingerprint is not equivalent to that lifecycle.

**Change:** let eligible review results create an inactive, inspectable skill draft with canonical evidence, test cases and a named review action. Bind evaluation and promotion to that exact draft. For explicitly requested one-off learning, offer a directly reviewed draft without requiring the user to manufacture three sessions; recurrence can remain a stricter rule for automatic staging.

Hermes' background review has actual memory/skill-management execution, bounded iterations/input and isolated persistence. GoatCitadel should adopt the complete learning outcome while retaining its own approval and callable-catalog boundaries. [Pinned review implementation](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/agent/background_review.py).

**Acceptance:** solve a task, propose a procedure, approve/evaluate it, and solve a different task better using the reviewed instructions. Revoke it and prove fresh reuse disappears. Fail or poison the draft and prove it never becomes callable.

Owners: `background-review-service.ts:173`; `chat-post-commit-effect-service.ts:204`, `:304`; `skill-learning-service.ts:46`, `:263`, `:744`; `governed-skill-instruction-service.ts`.

### F6 — P2: extraction requires unnatural wording and loses corrections

**Evidence: deterministic extraction probes.** `I prefer concise replies.`, `My name is Mira.`, `No, I now prefer detailed explanations.` and a Spanish remember request produce no learned-memory candidates. `Remember that I prefer concise replies.` does. Extraction reads only the first 12 nonempty lines, recognizes a small English rule set and returns at most eight items.

This is a limitation of that extractor, not proof that the model-assisted background path never catches such facts. The latter is periodic, gated, proposal-only and affected by F1/F5.

**Change:** classify explicit requests/corrections by intent, with multilingual examples, bounded model assistance where necessary, and structured output. Keep inference-derived personal facts proposed until governed acceptance. Do not automatically store all conversational statements.

**Acceptance:** everyday phrasings and corrections work without magic prefixes, while questions, hypotheticals, quoted instructions and untrusted content do not become standing facts.

Owner: `learned-memory-utils.ts:61`.

### F7 — P2: secret filtering blocks harmless vocabulary

**Evidence: deterministic gate probes.** `Remember that I prefer low token usage.` and `Remember that I work on tokenization research.` are blocked as secrets. The gate matches bare substrings including `token`, `password` and `secret`, without requiring an actual secret value.

**Change:** use the shared secret detectors with value/context evidence. Distinguish discussing credentials from storing one. Keep actual credentials blocked and give a useful, precise reason. Do not simply remove the guard or expose a rejected value.

**Acceptance:** credential values are rejected/redacted; normal software vocabulary and preferences survive; Unicode, obfuscated, copied and structured secrets retain coverage.

Owner: `memory-write-gate-service.ts:11`.

### F8 — P2: proactiveness exists, but its setup and scope are fragmented

**Evidence: source and rendered effective-state inspection.** Session proactive mode defaults off. Session heartbeat preference defaults on, while profile-free heartbeat-turn restoration defaults off. Consolidation, weekly model evaluation and engineering learnings have separate opt-ins. The reviewed installation renders memory administration and memory maintenance as off. A green core-health badge therefore does not imply that learning/follow-through features are operating.

De-novo scheduling is currently limited to active mission sessions, open commitments or linked tasks, cadence/active-hour checks and five read-only tools. That is useful safe information gathering, but not a general autonomous project worker. Cron, supervised delegation and event hooks must be considered alongside it.

**Change:** add one outcome-oriented setup flow with independently scoped choices: remember reviewed preferences, suggest reusable skills, follow open commitments, run selected scheduled work. Show effective readiness, next check, last result, restrictions and cost budget. Do not collapse all permissions into one autonomy switch.

OpenClaw's standing-intent implementation supplies expiration, cooldown/rearming, scoped indexed matching and durable state. Its automations provide persistent scheduled jobs. Hermes documents one-shot/recurring and event-triggered jobs with origin delivery. These are good references for predictable follow-through. [Pinned intent kernel](https://github.com/openclaw/openclaw/blob/7f059c01cd032a41517e6aacdc5598d4bb3b70bb/extensions/memory-core/src/standing-intents-kernel.ts), [OpenClaw automations](https://docs.openclaw.ai/automation/cron-jobs), [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

**Acceptance:** an operator can understand and authorize one useful follow-through workflow without knowing feature-flag names; it fires within the selected window, stays quiet when nothing changed, survives restart and reports blocked delivery once.

Owners: `config.ts:1490`, `:1543`, `:1559`, `:1567`; `packages/storage/src/session-autonomy-prefs-repo.ts:85`; `chat-proactive-service.ts:437`; `chat-proactive-denovo-planner.ts:94`; `gateway/commitment-sweep-service.ts`.

### F9 — P2: improvement monitoring can label an unobserved change stable

**Evidence: source-confirmed condition.** `reconcileActiveWatchWindows` marks an activation stable when either its signal target is reached **or** its watch deadline expires. Expiry does not require any observations. The label therefore means a watch window ended under this policy; it does not establish improved behavior or even runtime coverage.

**Change:** separate `watch complete: insufficient evidence` from demonstrated stability. Require minimum relevant observations and held-out outcomes before claiming improvement. Retain governed pause/restore and expose why evidence is insufficient.

**Acceptance:** zero-traffic expiry never becomes proven stability; matched negative evidence triggers the governed recovery path; unrelated traffic does not satisfy the evaluation target.

Owner: `improvement-service.ts:5475`.

### F10 — P2: learning can do paid work without a usable destination

**Evidence: inspected call order and guards.** Post-commit review performs extraction and skill-suggestion calls before filing facts. Feature-disabled proposal errors count as rejected candidates. The skill suggestion currently becomes only a fingerprint. This can expend model work without yielding accepted or even actionable learning. Actual cost on this installation was not measured.

**Change:** check destination readiness before dispatch, make review conditional on relevant signals, coalesce repeated work and prioritize interactive inference. Track useful accepted lessons and later reuse per unit of review cost.

Hermes' managed-local idle queue coalesces by session, retains the original enqueue age, waits for a quiet window, and rechecks enabled state at dispatch. Adapt the scheduling idea to GoatCitadel's durable jobs rather than copying its in-memory durability limits or permissive error fallbacks. [Pinned queue](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/agent/review_idle_queue.py).

Owners: `chat-post-commit-effect-service.ts:252`, `:356`; `background-review-service.ts:277`; `background-scheduler.ts`.

### F11 — P2: compaction needs a continuity test suite grounded in behavior

**Evidence: implementation review.** The deterministic summary preserves original/latest operator asks, selected decisions/failures and artifacts, while explicitly withholding authorization. That authority fence is good. Selection is keyword-driven, with six recent matches per section and short excerpts; a constraint late in a long message can be lost.

**Change:** preserve a typed continuity ledger of goal, accepted decisions, active constraints, unresolved questions, approval/effect references and next step. Render it within a budget with links to original messages. Never turn a summary into renewed authority.

OpenClaw documents a pre-compaction flush; that is useful inspiration for preserving unsaved context, but GoatCitadel must route any resulting memory through its own lifecycle governance. [Memory flush](https://docs.openclaw.ai/concepts/memory#automatic-memory-flush).

**Acceptance:** after multiple compactions and a restart, continue a task without losing a late constraint, repeating a completed side effect or treating a summary as permission.

Owner: `chat-compaction.ts:9`.

## Making everyday use smoother

The following are prioritized product changes, not a claim that every associated UI bug was reproduced.

1. **Finish the current request after setup or approval.** A missing capability should produce an exact setup/consent card and return to the original task when resolved. An expired approval should offer a fresh, revalidated review without making the user reconstruct the request. Denial must still stop the action.
2. **Make learning a compact part of Chat.** Show the exact proposed lesson, an edit action and its review decision beside the originating result. Show `Used your preference…` or a similarly short receipt when it actually affected context. Keep full provenance in the inspector.
3. **Resolve consent at the level of work the user intended.** Present eligible duration and scope on the first relevant approval card; reuse existing grants only within their exact authority. Avoid repeated questions for the same approved operation. Never generalize consent from one connector/action to unrelated access.
4. **Explain capability setup by outcome.** `Connect Calendar so I can show your week` is easier than choosing among implementation categories. Keep one path back to the requested task and distinguish read permission, write permission and missing credentials.
5. **Make quiet work visibly accountable.** A single follow-through view should answer what will run, when, why, where it will report, what it may do, and how to stop it. Group duplicate notifications and surface only meaningful changes or required decisions.
6. **Keep foreground interaction responsive.** Acknowledge send immediately, stream a truthful status, retain drafts, preserve scroll/focus and cancel owned work promptly. Separate provider time, tool time, human wait, queueing, retrieval and UI overhead in measurements.
7. **Improve empty/disabled learning states.** The rendered Memory screen repeats the administration-off notice, still presents filters, and sends the operator to Advanced settings. Improvement requires a direct link and is advisory. Put the useful next action and consequence at the point of need; keep the advanced controls available for experts.

The existing inline approvals, grant controls, stale-record checks, outcome receipts and single Chat surface are foundations to retain. Their present rendered pending/expiry journeys were not exercised in this review, so historical chat failures observed in the installation are not treated as fresh reproductions of those source paths.

Suggested acceptance budgets, to be calibrated on the supported reference machine: input acknowledgement under 100 ms; warm navigation p95 under 300 ms excluding remote data waits; an available safe approval decision reachable without navigation; zero repeated consent prompts for the exact valid grant; review work cannot delay an incoming foreground turn behind background generation. These are proposed targets, not measured results.

## Upstream code worth adapting

| Candidate | Concrete value | Adaptation boundary |
| --- | --- | --- |
| OpenClaw `dreaming-consolidation.ts` | Validated add/merge/supersede plans; exact prior entries; project/lineage checks; output budget | Adapt the pure plan validation and fixtures to lifecycle records and Change Plans; preserve Gateway approval and transaction authority |
| OpenClaw `standing-intents-kernel.ts` | Durable prospective intentions, expiry, cooldown/rearming and scoped candidate search | Integrate with existing commitments/durable execution; do not create a competing scheduler |
| Hermes `memory_tool_store.py` | Exact-target precedence, tolerant typography matching, ambiguity errors, pinned staged targets and span patches | Port behavior/tests to TypeScript and canonical record IDs; keep server-owned revisions/hashes authoritative |
| Hermes `session_search_tool.py` | Lineage dedupe, automation demotion, selective detail, raw-message recall without a summarizer call | Extend current authorized session search/history; retain workspace/private-session boundaries |
| Hermes `review_idle_queue.py` | Coalesced idle review, age bounds and foreground priority | Use durable queued jobs and actual local-provider contention signals; do not copy best-effort loss on restart |
| Hermes `background_review.py` | Detached review execution, restricted tool dispatch, cache parity on the same model and digest routing on another | Reuse existing utility routing and evidence owners; do not copy unrestricted writes or fail-open approval behavior |

The pinned upstream [OpenClaw license](https://github.com/openclaw/openclaw/blob/7f059c01cd032a41517e6aacdc5598d4bb3b70bb/LICENSE) and [Hermes license](https://github.com/NousResearch/hermes-agent/blob/3371c03df62106a4c93a545787a471e328883d08/LICENSE) are MIT. They allow reuse/modification/distribution with preservation of their copyright and permission notices. GoatCitadel's root license is Apache-2.0. For any actual port, retain the source commit/path, mark adaptations, include the upstream notice/license, and inspect file-specific and dependency licensing before adding dependencies. The research snapshots retain the notices. No upstream runtime code was integrated in this review.

Pinned source links for all six candidates are preserved in `.tmp/product-review-20261118/upstream/manifest.json`. Fetching a newer upstream revision requires a fresh compatibility review.

## Execution order and definition of done

| Order | Work | Release evidence |
| --- | --- | --- |
| 1 | Correct workspace binding and connect promoted learning to recall | Two-workspace proposal→approval→fresh recall→forget round trip, both databases, no forbidden sources |
| 2 | Replace coarse conflict logic and reduce extraction/redaction false positives | Natural phrasing, multilingual corrections, independent facts and actual-secret negative cases |
| 3 | Query the corpus before cutting candidates | Labeled old-fact/paraphrase/noise/no-answer retrieval benchmark at realistic corpus sizes |
| 4 | Complete reviewed procedural learning | Successful task→inactive draft→evaluation→approval→fresh callable reuse→revocation |
| 5 | Simplify follow-through and recovery | One meaningful scheduled/event-triggered workflow survives restart, respects hours/grants and reports once |
| 6 | Tune responsiveness and prove improvement | Foreground/background contention measurements, streamed/approval/expiry recovery journeys, held-out behavioral gains |

This order favors actual usefulness before further visual redesign. The first two stages remove inconsistencies that make every later feature feel unreliable.

## Three-product benchmark to establish parity

Run the same synthetic, non-sensitive corpus and tasks on all three products. Pin versions; use the same model/provider, reasoning settings and tool fixtures where possible. Publish a second comparison using each product's recommended defaults. Record configuration and approval burden separately so different defaults are not mistaken for better reasoning.

| Suite | Cases | Measures |
| --- | --- | --- |
| Personal continuity | Learn preferences, correct one, start new chats, return after days | Correct use, obsolete instruction use, prompts repeated, provenance |
| Episodic recall | Old exact facts, paraphrases, mixed language, competing projects, no-answer prompts | Precision/recall, reciprocal rank, abstention, scope violations, latency/cost |
| Procedural learning | Novel workflow, a correction, a different task using the lesson, then revoke | Task success delta, repeated mistake rate, actual instruction reuse, operator decisions |
| Proactive usefulness | A timed task, an event trigger, due commitment, unchanged situation, quiet hours, restart | Useful delivery, duplicate/noise rate, lateness, missed work, unattended cost |
| Recovery | Restart during work, approval wait, expired approval, ambiguous external send, interrupted stream | Correct continuation, no duplicated effects, draft/history retention, actions to recover |
| Smoothness | First useful task, connector setup, memory correction, skill review, timer/schedule, mobile approval | Time to completion, clicks, interruptions, explanations repeated, focus/scroll stability |
| Learning integrity | External instruction injection, fabricated success, stale source, conflicting correction | No unreviewed promotion/activation, exact evidence binding, clear rejection |

Use blinded scoring of task outcomes and hold out tasks from the learning/evaluation examples. Human-wait time must be reported separately from runtime latency. Track harmful false memories and unwanted actions alongside success; a system that saves more things is not necessarily a better learner. Promote a change only when its measured value exceeds its cost and does not weaken the authority model.

## Validation actually performed

1. Gateway batch: memory lifecycle policy, consolidation, operator profiles, background review, proactive scheduler/de-novo planning, skill learning, retrieval benchmark accounting, compaction authority and heartbeat occurrences. **146 passed; 5 failed at symlink fixture creation (`EPERM`)**. All five were in skill-learning symlink tests; they did not reach the product assertions.
2. Gateway batch: heartbeat authority, proactive service, consolidation scheduler, post-commit effects, governed skill instructions, callable-skill selection, engineering learnings and memory context. **143 passed; 1 failed at symlink fixture creation (`EPERM`)**. The failing governed-skill directory-link test did not reach its product assertion. The selector for `memory-write-gate-service.test.ts` matched no test file; gate behavior was instead exercised by the deterministic probes.
3. Memory-core ranker, candidate selection and coverage suites: **35 passed**.
4. Combined focused suites: **324 passed; 6 fixture-setup failures; 330 tests across 21 files**. No failing product assertion was established by those six failures; symlink handling remains unverified in this environment.
5. Deterministic probes: extraction misses, wrong conflict classification, coexistence of opposite preferences, harmless-token rejection, candidate cutoff and missing consolidation workspace binding. Recorded in `.tmp/product-review-20261118/probe-results.json`.
6. Rendered inspection as listed above. No claim of complete visual regression coverage or measured UI performance.
7. `pnpm docs:check` passed, including its nine Docker-secret checks. Tracked diff whitespace and the new untracked report's `git diff --no-index --check` passed. The task-owned frontend server was stopped after inspection.

Not run: full `verify:memory:truth`, durable recovery, self-improvement trust, full workspace build/typecheck, real PostgreSQL parity, installed upgrade lifecycle, a long-running proactive soak, or live three-product provider benchmarks. These are required when implementing the corresponding changes; source tests and this review do not replace them.

## Scope beyond the primary priorities

Tool reliability, provider normalization, connector readiness, approval continuation, restart recovery, channel delivery, local inference contention, cost and onboarding all materially affect the assistant experience and are included in the acceptance plan. Voice quality, physical Android use, remote-worker/two-machine behavior, full installer lifecycle, exhaustive connector compatibility and hostile-code isolation were not validated here. None should be inferred from the comparison.

The product decision is to prioritize dependable continuity and completed work: every accepted lesson must reach future behavior, every proactive action must have an inspectable purpose/outcome, and every improvement claim must have task-level evidence. GoatCitadel's existing governance should support that experience without becoming a sequence of disconnected review chores.
