# Canonical Runtime State Model

Last updated: 2026-08-08

This document defines the repo-native authority model for the core runtime nouns that appear across Gateway, Mission Control, storage, and replay.

## Purpose

GoatCitadel uses several operator-facing terms that are easy to blur together during implementation:

- `session`
- `turn`
- `run`
- `approval`
- `realtime event`

This file states which concept is canonical, what store owns it, and which views are derived projections rather than primary truth.

## Canonical Concepts

### Session

Definition:
A routed conversation container. A session is the durable identity for an ongoing exchange within Chat or an external channel binding.

Authority:
- Contract shape: `packages/contracts/src/session.ts`
- Session shell metadata: `packages/storage/src/chat-session-meta-repo.ts`
- Transcript event durability: transcript log plus transcript outbox

Notes:
- Mission Control session summaries are derived read models.
- A session is not the same thing as a run.

### Turn

Definition:
A single user or assistant step within a session, including execution-side details like tool use, retrieval, routing, and citations.

Authority:
- Execution trace: `packages/storage/src/chat-turn-trace-repo.ts`

Notes:
- Turns are scoped to a session.
- A turn may create or resume one or more runs.

### Routed Chat Context Snapshot

Definition:
An immutable, insert-only record of the exact structured context admitted for one Chat turn.

Authority:
- Request contract: `packages/contracts/src/routed-context.ts` and `ChatSendMessageRequest.contextRefs`
- Resolution, attestation, and budget owner: `apps/gateway/src/services/chat-routed-context-service.ts`
- Snapshot v2 admits operator-selected `personal_note` and `generated_artifact` refs. Note revision and artifact hash/version are source provenance; the snapshot owns the admitted bytes after turn preparation, so later document edits cannot change durable replay.
- Persistence and content-free inspection projection: `packages/storage/src/routed-context-snapshot-repo.ts`
- Durable replay verification: `apps/gateway/src/services/durable-execution-service.ts`
- Snapshot-bound tool execution: `packages/policy-engine/src/tool-executor/context-executor.ts`
- Assistant document proposals: `document.propose_patch` persists proposal-only state through the Gateway-owned document editing service. Its workspace, session, turn, and assistant author are server-bound from the active invocation; the public proposal route cannot manufacture assistant provenance, and only a later operator apply mutates a note or creates an artifact successor.

Canonical bindings:
- Snapshot identity is bound to `turnId`, `sessionId`, `workspaceId`, `capabilityProfileId`, and `capabilityProfileHash`.
- The ordinary turn trace carries only `snapshotId`, `snapshotHash`, `sourceRequestHash`, and `contentHash`. Rich source receipts require a scoped capability-profile inspection read, and that projection excludes admitted source text.
- Model-usage attribution carries only `contextSnapshotId`, `contextIntentHash`, and `contextResolutionHash`; raw references, labels, paths, and admitted content do not cross that boundary.

Notes:
- `contextRefs` is Chat-only, accepts 1-16 unique entries when present, and supports only `attachment`, `memory_item`, `external_attachment`, `personal_note`, and `generated_artifact`. It does not accept raw filesystem paths, URLs, session or task references, or Assembly context.
- The Gateway resolves references to owned records, attests source identity and bytes, and preserves request order. Each snapshot records the exact admitted UTF-8 text and byte/token accounting plus source, rendered-content, request, and snapshot digests.
- External attachment candidates are a bounded, content-free projection of verified applied import items eligible for the current workspace, session, and operator. The final attach mutation revalidates the source/import/item/artifact chain and current source revision; exact revision plus session-incarnation CAS still governs detach. Mission Control offers Library import management rather than accepting a host path or an arbitrary raw identifier from the Chat form.
- The effective capability profile, provider/model context window, and routed-context budget are frozen by the server. Caller-supplied context references cannot select or widen those bindings.
- Routed-context v1 is a single-provider boundary. Admission requires the final frozen profile to set `subagentPolicy` to `off`; `ask_when_useful` and `auto_when_useful` fail before source resolution rather than silently mutating the operator's frozen profile. For an admitted turn, both initial execution and durable replay bypass model-orchestration planning before any planner or delegated provider call.
- Routed `memory_item` reads are workspace-only in v1. Global memory fails closed until a future explicit server-owned capability-profile policy field admits it; caller input, generic grants, and ordinary memory mode do not provide that authority.
- Durable execution strips raw `contextRefs` from its payload, verifies the stored snapshot against the bound profile, run, turn trace, and hashes, then reuses the frozen admitted text without live source re-resolution. Missing, corrupt, or mismatched bindings fail closed.
- A retry or edit creates a new turn-bound snapshot. Existing snapshots are never updated in place.
- When `attachedContextToolsV1Enabled` is enabled and a turn requests routed context, its frozen capability profile may admit `context.list`, `context.grep`, `context.query`, and `context.read_range`. Final execution removes them if the persisted snapshot has no eligible admitted text.
- Every `context.*` invocation receives its turn, workspace, snapshot ID, and snapshot hash from the server-owned Chat runner. Those fields are absent from the public tool-invoke body; matching authority-shaped model arguments are rejected. The executor re-verifies the snapshot, session, workspace, hashes, and source workspace before reading bytes.
- `context.list` is content-free. Literal grep and 1-based range reads are line- and byte-bounded. Query embeddings, when configured, are generated only over bounded in-memory snapshot chunks and are never persisted into the knowledge store; unavailable or failed embeddings fall back to deterministic lexical scoring over the same frozen bytes.
- Content-bearing results retain snapshot/source hashes, entry index/reference, and exact line ranges in the tool run. Chat derives normal tool citations from those receipts. `session.status` projects the four tool names only when its invocation carries the same valid active-turn snapshot binding.
- `ChatSessionStatusService` is the Gateway-owned read model for one Chat session's provider/model selection, routed-context budget and receipt, active/waiting turn counts, linked durable worker/recovery posture, pending attention, delegation progress, persisted capability profile, model-usage totals, and runtime build identity. `GET /api/v1/chat/sessions/:sessionId/status` returns the operator projection; `session.status` returns a smaller secret-free projection from the same service. Background tasks carry the same `attention.state`, `attention.reason`, and canonical blocker truth as the durable background-task rail. The read joins only exact session/workspace linkage and exact persisted run IDs. Realtime events trigger refresh but never replace the underlying repositories as authority.
- `NotificationRoutingService` owns workspace-scoped notification targets, rules, client-presence leases, canonical notification events, and delivery state. Targets contain only configured channel connection IDs or OS-keychain secret references for allowlisted HTTPS webhooks; URLs and credentials never enter Chat/model payloads or notification tables. Active rules select external targets, `when_away` treats unknown/expired presence as away, and each delivery persists its idempotency key, attempts, suppression, failure, completion, or `unknown_after_send` posture. Channel delivery re-enters the governed comms path; webhook delivery re-enters the durable external-side-effect runner and stops automatic retries after an unknown post-boundary outcome. Mission Control toast, sound, and desktop preferences consume the same retained event stream but remain local client preferences rather than canonical external targets.
- `ChatTimerService` and `chat_timers` own one-shot, session-scoped reminder state. The existing scheduler provides only database-clock wake and leased claim mechanics; firing performs no provider or model call. A successful claim idempotently persists one `chat-timer` system message, one canonical `timer.due` notification event, retained realtime evidence, and the final delivery posture. Lease-owner settlement plus deterministic notice/event IDs prevent duplicate visible firing across workers and restart recovery. The create boundary enforces a five-second minimum, one-year maximum, 25 active timers per session, and 100 per workspace. `cancelOnNextReply` is evaluated only from the user-message canonical commit callback. `/schedule` remains the separate restricted scheduled-agent-turn path and is not implemented through Chat timers.
- Versioned `RunVariableSchema` contracts belong to prompt packs and active agent presets; defaults belong to those owners, while entered values are stored only in browser `sessionStorage` for Prompt Lab or `chat_session_run_variable_bindings` for the durable Chat session. A palette selection sends the owner ID, owner revision, schema hash, template ID when applicable, and typed bindings. The Gateway reloads the owner, rejects stale revisions or schemas, validates every declared value, substitutes only declared placeholders, compares the exact server-resolved input with the client preview, and freezes schema, binding, and resolved-input hashes into run/turn evidence. Paths are inert strings and v1 has no secret field type. Entered bindings never become owner defaults or learned memory without a separate operator-authored update.
- `notify.request` is an approval-gated model-callable attention request. The Gateway binds it to the active session/workspace and rejects model-supplied target IDs, raw URLs, and credentials. Its internal retained signal may be projected locally, while external delivery exists only when an active operator-authored rule selects a target.
- Status availability is explicit. A section with missing canonical evidence is `unavailable` with a reason; absence is not projected as zero, idle, healthy, or verified. Runtime build identity is available only when its source and integrity can be resolved. `/status` is a local Chat action and performs no provider call.
- Independent conversation forks are Gateway-owned materialized copies. `POST /api/v1/chat/sessions/:sessionId/turns/:turnId/fork` copies only the selected root-to-turn path after every turn is terminal and settled. Messages receive new IDs while retaining visible content and timestamps; attachments receive independently stored bytes; generated artifacts receive new version chains.
- Personal notes remain owned by `personal_ops_notes` plus append-only `personal_ops_note_revisions`. Generated artifacts remain insert-only rows linked by `supersedes_artifact_id`. `document_patch_proposals` owns pending/applied/rejected/conflicted review state and complete replacement content; it is not execution evidence. Mission Control calls Gateway APIs and never writes these tables directly.
- `chat_session_fork_manifests` is the immutable relationship/provenance authority. It retains source-to-copy mappings, transcript and evidence hashes, routed-context snapshot hashes, and actor/time even if the source session is deleted. Imported traces contain hashed read-only source provenance but never clone durable runs, approvals, tool invocations, or side effects as newly executed evidence. The server-authored `conversationForksV1Enabled` gate owns availability.

### Chat Workspace Snapshot

Definition:
A content-free, point-in-time workspace/project identity and bounded Git posture captured for exactly one Chat turn.

Authority:
- Request and immutable record contract: `packages/contracts/src/chat-workspace-snapshot.ts`
- Verified capture owner: `apps/gateway/src/services/chat-workspace-snapshot-service.ts`
- Turn binding and persistence: `ChatTurnCapabilityProfileSelection.workspaceSnapshot` in the immutable capability profile

Notes:
- The one-shot request carries only `capture: true` and a request ID; it carries no path authority. The Gateway resolves the active workspace/project, verifies the bound path before and after Git inspection, and binds the result to project revision and path-identity hashes.
- The Git summary contains head, optional branch, aggregate tracked and untracked change counts, dirty posture, and optional ahead/behind counts. It stores no file names, diff bytes, transcript content, or source content.
- Route preflight and send reuse one request-bound capture. Refresh uses a new request ID for a new turn; an existing turn profile is never mutated.
- Missing workspace/project/repository data, unavailable Git, failed verification, Git-summary failure, or changed path identity persists as an explicit `unavailable` record. The UI must not infer a clean or healthy repository.
- Workspace snapshots are context evidence only. They do not expand filesystem scope, grant tools, satisfy approval, or bypass deny-wins policy.

### Durable Run

Definition:
A resumable execution lifecycle used when work must survive pause/resume, approval waits, retries, or background processing.

Authority:
- Contract shape: `packages/contracts/src/durable.ts`
- Persistence: `packages/storage/src/durable-run-repo.ts`

Implementation status:
- Schema and storage repository: complete through the protected storage migration set.
- Read-only diagnostics API: complete.
- Mission-session Chat LLM HTTP/SSE send, retry, resume, approval wait/resume, linked proactive wakes, durable-linked chat stream resumption, worker restart recovery, retry scheduling, and dead-letter recovery mechanics are durably owned for the `1.0` operator path. Planning, research, delegation, and code-capability turns run inside Chat.
- Queue consumers / idempotent worker runtime for the shipped durable path: complete.
- DLQ operator actions for the shipped durable path: complete.
- See `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md` for historical implementation background and migration context, not the active rollout source of truth.

Notes:
- A run records execution intent and outcome for the shipped resumable operator flow set.
- Durable execution now owns worker startup, retry scheduling, wake/resume, dead-letter recovery mechanics, approval wait/resume wake effects, approval-linked proactive wakes, and durable-linked chat-turn stream resumption for mission-session Chat operator work.
- A durable child watcher's `attached` or `detached` state is presentation/attention truth only. `Continue in background` detaches the watcher without changing the child run, scheduling, policy, grants, approvals, waits, recovery, steering, inspection, or cancellation authority; reattach restores foreground attention. Canonical blockers remain visible in both the background rail and Chat status.
- A detached child that reaches an approval, user-input, recovery, or other attention blocker may dispatch an idempotent `durable.attention_required` event only through active operator-configured notification routing. Dispatch begins after the durable transition commits, and delivery failure is non-authoritative: it cannot roll back, advance, fail, or otherwise alter the run.
- Cowork/orchestration runs are durable-run backed and worktree-owned. `orchestration_runs.status`, `currentWaveId`, and `currentPhaseId` describe plan/operator position; `durableRunId`, `executionState`, `worktreePath`, `worktreeStatus`, and `worktreeBaseRef` describe execution truth.
- Approval-gated orchestration resume must re-enter the linked durable run. An approval action may set resume intent on the orchestration record, but durable worker execution remains the authority that advances phases after approval.
- External writeback sessions remain visible operator sessions. Integration operator write actions now record audit-only `external_writeback` evidence envelopes so the external side-effect intent and outcome are durable and inspectable. Local bridge writes, Activepieces triggers, Trello card creation, and Gmail send actions claim idempotency before crossing the external boundary and record replay outcome, replay-attempt, and manual retry posture evidence. The external side-effect run ledger is populated by the shared runner and stores pre-boundary, started, completed, failed-before-boundary, and unknown-outcome states. Mission Control can start a replay-audit durable run from a ledger row so operators can inspect eligibility in Run Detail. The replay-safe worker and durable `external_side_effect.replay` workflow may retry failed-before-boundary or stale claimed-not-sent runs only when an allowlisted owning integration reconstructs the original safe payload; unknown post-boundary outcomes stay manual. If no owning replay job is available, the durable workflow checkpoints skipped/manual-reconciliation reasons without sending an external request. Activepieces preserves safe workflow-run id/status/url evidence when the webhook returns it and surfaces that evidence in the external side-effect ledger as webhook-response-only status. Activepieces run-status checks are explicit operator read actions against a configured API base URL and token, not background polling or managed workflow execution. Workflow recipe Activepieces template export is a read-only planning artifact for operator import with structural validation evidence; native Activepieces import compatibility remains explicitly unverified, and the export is not an Activepieces flow creation, webhook trigger, or status poll.
- Legacy traces without durable linkage may still require compatibility reads or resume fallbacks for historical rows, but new mission-session LLM sends do not bypass durable ownership.
- Runs may be linked to sessions, turns, tasks, and approvals.
- The `durableKernelV1Enabled` feature flag gates durable-run APIs. The `replayOverridesV1Enabled` flag (default: off) gates replay-with-overrides.
- `unifiedComposerPaletteV1Enabled` is a Gateway-authored Mission Control projection gate. It changes only the Chat composer discovery surface: its client registry reads existing scoped APIs, caches source results per session, and degrades source failures independently. It does not create a second capability catalog, widen file/workspace access, or make inactive agents, candidates, proposals, or non-callable skills executable.

### Chat Workspace Exploration and Delegated Scope

Definition:
A single persisted Chat delegation specialized for read-only exploration of the current server-owned filesystem scope.

Authority:
- Public report and scope-candidate contracts: `packages/contracts/src/chat.ts` and `packages/contracts/src/agentic-runtime.ts`
- Delegation/profile owner: `apps/gateway/src/services/chat-delegation-service.ts`
- Scope candidate, enforcement, and approval-request owner: `apps/gateway/src/services/delegated-work-result-service.ts`
- Canonical run/step state: `chat_delegation_runs` and `chat_delegation_steps`

Notes:
- `Explore workspace` creates exactly one sequential `workspace-explorer` child. Its server-owned permission profile admits only `fs.read`, `fs.list`, `fs.stat`, `file.read_range`, `file.find`, `code.search`, `code.search_files`, and `submit_work_result`; write, shell, Git, browser, network, MCP, notification, memory/retrieval, and further delegation paths are unavailable.
- The explorer report is derived from persisted delegation truth and contains the answer, evidence references, approved searched paths and scope hashes, partial-result state, and explicit gaps. Secret projection removes delegated host roots and resolved host paths.
- Additional scope is available only for active `workspace-explorer` or `coder` steps. Chat receives opaque IDs for bounded, server-discovered eligible paths; it cannot submit an arbitrary path. Selected IDs re-enter `submit_work_result` as the existing scope-expansion approval wait.
- Approval application rechecks the exact step, approval, dispatch generation, and prior scope hash. Approval expands only that step's server-owned approved paths, computes a new scope hash, and resumes through durable execution; rejection, expiry, or stale binding retains the prior scope and fails closed.

### Chat Tool Effect Truth

Chat planning freezes a server-authored `effectPotential` of `none` or `unknown`, one secret-safe binding for every enabled `tool.call.before`, `tool.call.after`, `tool.call.error`, and `after_tool_call` hook, and the exact built-in/plugin runtime-owner generation into the immutable capability profile. `chat_tool_runs` owns recovery `effectDisposition` plus operator-facing `effectOutcomeKind`/`effectEvidence`; the runner durably crosses an auxiliary-effect fence immediately before hook delivery/materialization and a separate main-executor fence immediately before the admitted built-in, plugin, MCP, or browser-fallback owner. This separation preserves a legitimate approval reached after a hook as `approval_wait_after_auxiliary_dispatch` while suppressing an approval reported only after the main executor crossed its boundary. Only a proven pre-dispatch block, approval wait, skip, reuse, or trusted built-in safe read may settle `none`; opaque legacy invokers, hook or owner drift, browser/shell/MCP/plugin/remote/mutating paths, interruption after either effect boundary, approval-resume execution, and post-dispatch output rejection remain `unknown`/`uncertain`, carry inspect-before-retry guidance, and are never automatically replayed. A `concrete` outcome requires a typed out-of-band receipt whose Chat tool-run, tool, scope, and idempotency correlation exactly match a completed canonical owner; result payload IDs are never evidence. Chat tool cards, expanded trace detail, ordinary decision traces, and trusted Ops Run Detail project the same fields but withhold raw receipt IDs until a dedicated server-verified owner projection exists; expert raw JSON is explicitly diagnostic and non-canonical. These internal classifications are stripped at the shared complete/stream provider-send boundary.

### Work Passport

Definition:
A server-authored, operator-correctable task-boundary and review contract for one Chat turn.

Authority:
- Contract shape: `packages/contracts/src/work-passport.ts`
- Baseline owner: workspace-scoped operator profile facts under the reserved `work-passport:` source namespace
- Classification owner: `apps/gateway/src/services/work-passport-service.ts`
- Per-turn canonical record: `ChatTurnCapabilityProfileSelection.workPassport`

Notes:
- The workspace baseline is created or replaced only by an explicit operator route. The runtime does not infer or learn a person's occupation.
- The current task classifier is local, deterministic, versioned, bounded, and secret-free. Its reasons describe generic cues rather than copying task text.
- The complete Work Passport is covered by the capability profile's immutable JSON, selection hash, preflight fingerprint, profile hash, and persisted integrity verification.
- Mission Control may project and correct the baseline, but the Gateway owns persistence and classification. A successful correction forces a fresh preflight.
- Review and action posture are advisory governance context. They do not grant tools, bypass deny-wins policy, satisfy approvals, or prove that review occurred.
- Profiles created before Work Passport remain valid with the optional field absent.

### A2A Task Binding

Definition:
A peer-scoped external A2A task identity mapped into GoatCitadel session, task, and durable-run truth.

Authority:
- Contract shape: `packages/contracts/src/a2a.ts`
- Binding persistence: `a2a_task_bindings`
- Inbound/outbound Gateway owner: `apps/gateway/src/services/a2a-route-service.ts`

Implementation status:
- A2A v1.0 is the external agent-to-agent standard at the Gateway boundary, not the internal mesh protocol.
- Callable A2A v1 support includes JSON-RPC over HTTP/S, peer-authenticated HTTP+JSON task routes, peer-configured task push notification delivery, authenticated extended Agent Cards, and Gateway-owned gRPC task transport when the `GRPC` binding and loopback/default gRPC listener are explicitly configured.
- Public Agent Card discovery at `/.well-known/agent-card.json` is disabled by default; operator diagnostics remain available at `/api/v1/a2a/agent-card`.
- Inbound A2A uses configured peer credentials through the `a2a-peer` route-access class. It must not reuse operator auth as peer auth.
- Inbound `SendMessage` creates or reuses a peer-scoped hidden chat session, creates a visible TaskLifecycle task, dispatches through `agentSendChatMessage`, and stores an A2A-to-local binding with idempotency by peer/context/message identity.
- Outbound A2A uses configured peers, Agent Card discovery, optional configured `grpcUrl` fallback for gRPC peers, the network allowlist, the replay-safe external side-effect runner, and durable audit records.

Notes:
- A2A is external interoperability. GoatCitadel mesh remains native runtime coordination for readiness, leases, ownership, replication, failover, and LAN/WAN/tailnet state.
- A2A events are projections from canonical session/task/durable state plus binding sequence state. They are resumable operator signals, not a replacement for task or run persistence.

### Approval

Definition:
A durable human decision point for risky or policy-gated work.

Authority:
- Contract shape: `packages/contracts/src/approvals.ts`
- Persistence: `packages/storage/src/approval-repo.ts`
- Follow-on effect persistence: `packages/storage/src/approval-effect-repo.ts`

Canonical linkage fields:
- `sessionId`
- `turnId`
- `taskId`
- `workspaceId`
- `durableRunId`
- `correlationId`
- `traceId`
- `connectorId`
- `tokenId`
- `toolName`
- `actionType`

Notes:
- Approval payloads may still contain legacy nested values, but operator surfaces should prefer explicit `linkage`.
- Replay snapshots may expose a top-level `durableRunId`, but the approval linkage is the canonical association.
- Runtime lifecycle responses must expose per-field provenance for `sessionId`, `turnId`, `runId`, `approvalId`, and `taskId`.
- `RuntimeLifecycleResponse.canonical` is the operator-facing canonical field set. For approval-scoped reads, `canonical.sessionId`, `canonical.taskId`, and `canonical.runId` must prefer `approval.linkage` over turn-trace, execution-plan, delegation, or wait-run inference.
- `RuntimeLifecycleResponse.linked` is the related/inferred set. It may include alternate runs, sessions, turns, and tasks, but those values do not overwrite the canonical field set.
- Approval resolution follow-on truth is owned by `approval + approval_events + approval_effects`.
- `approval_wait_runs` remains a canonical wait mapping, but it is not canonical execution truth. Mission Control should label it as wait mapping, not canonical run ownership. Post-resolution wake, pending action execution, inbox finalization, and after-hooks are tracked through effect rows.

### Realtime Event

Definition:
A retained operator signal emitted onto the live stream for Mission Control and related consumers.

Authority:
- Contract shape: `packages/contracts/src/monitoring.ts`
- Persistence and retention: `packages/storage/src/realtime-event-repo.ts`

Canonical classification fields:
- `eventClass`
  - `domain_fact`
  - `operational_signal`
  - `ui_notification`
- `eventAuthority`
  - `retained_stream`
  - `durable_history`
  - `derived_projection`
- `links`
  - `sessionId`
  - `turnId`
  - `runId`
  - `approvalId`
  - `taskId`
  - `workspaceId`
  - `connectorId`
  - `tokenId`
  - `messageId`

Notes:
- Realtime events are not the authoritative historical record for sessions or runs.
- The stream is retained and pruned. Consumers must treat it as an operator signal lane, not complete history.
- Producers for approval/run/session/task/proactive events must populate `eventClass`, `eventAuthority`, and `links` explicitly.
- Repository inference is legacy compatibility-only. Protected approval/session/task/orchestration/auth-device event types must fail loudly when explicit metadata is omitted.
- If a compatibility shim remains for non-protected legacy callers, it must emit diagnostics and be removable without changing the protected producer contract.

## Linkage Rules

When a runtime action emits multiple records, link them explicitly instead of recovering relationships from nested payloads.

### Approval creation

Approval creation should attach explicit linkage before the approval is surfaced to UI or replay:

- preserve inbound linkage from the caller when present
- attach request attribution (`correlationId`, `traceId`) when available
- attach `durableRunId` from approval-wait lifecycle linkage when a durable wait/run owns the resolution path

## Read Precedence

Operator-facing runtime lifecycle reads should follow this order:

1. explicit stored linkage / explicit realtime envelope links
2. canonical side-table relationships
3. durable/task/session canonical references
4. compatibility fallback inference from payload, preview, or metadata

Fallback reads remain temporary compatibility behavior. Mission Control should label inferred relationships as inferred, not canonical.

For approval-scoped lifecycle reads, apply the precedence per field:

1. query `approvalId` and approval existence
2. `approval.linkage.sessionId`, `approval.linkage.taskId`, `approval.linkage.durableRunId`
3. explicit turn-trace / execution-plan / delegation linkage
4. wait mapping display via `approval_wait_runs`
5. compatibility fallback inference

### Approval-related realtime events

Approval events should carry `links.approvalId` and any known related identifiers such as:

- `sessionId`
- `taskId`
- `runId`
- `connectorId`
- `tokenId`

### Session-derived realtime events

Session stream events should carry `links.sessionId` and related `taskId` when known.

### Prompt-pack outcomes

Prompt-pack status must preserve `approval_paused` separately from `failed`.

### Memory Context

Definition:
A distilled or composed context pack drawn from memory items, learned memory, and workspace knowledge for use in prompts and reasoning.

Authority:
- Context pack cache: `packages/storage/src/memory-context-repo.ts`
- Memory items: `packages/storage/src/memory-item-repo.ts`
- Learned memory: `apps/gateway/src/services/chat-learned-memory-service.ts` via `packages/storage/src/chat-learned-memory-repo.ts`
- Read policy and learned-memory admission: `apps/gateway/src/services/memory-lifecycle-service.ts` and `apps/gateway/src/services/memory-context-service.ts`
- Canonical message provenance: `chat_messages.source_authority` through `packages/storage/src/chat-message-repo.ts`

Implementation status:
- QMD composition, distillation, and caching: complete.
- Memory maintenance (retention, compaction, recommendations): feature-flagged behind `memoryMaintenanceV1Enabled`.
- Learned-memory promotion, dedupe, workspace scope resolution, maintenance recommendation suppression, memory item list/edit/forget/history, and shared write-policy decisions now route through lifecycle-owned policy helpers coordinated by `MemoryLifecycleService`.
- Memory reads use server-owned access policy `1`, derived only from canonical `sessions.kind`. A canonical `dm` receives `workspace_private`; `group`, `thread`, missing, or inconsistent session truth receives `session_only`. Session-only composition reads only the current transcript with relation scope `self`; it cannot read workspace/global memory items or files. Explicit routed context applies the same boundary, rejects `memory_item` and `personal_note` identifiers before source reads, and admits attachments, external attachments, and generated artifacts only through current-session storage predicates. The access receipt is part of cache identity, memory quality, and the turn context manifest.
- Every new canonical Chat message has server-owned authority: `operator`, `external_channel`, `agent_proposed`, `trusted_lifecycle`, or fail-closed `unknown`. Learned-memory rebuild reads canonical `chat_messages`; caller hints cannot override stored authority or mismatched role/content. `external_channel` and `unknown` messages can create only redacted, deterministically deduplicated trace candidates. They never create active learned memory until an operator promotes the candidate; operator rejection is durable and prevents retry/rebuild recreation. Secret-like content is blocked before proposal persistence.
- SQLite migration 190 and PostgreSQL migration 133 backfill source authority, add trace-candidate dedupe, record reconciliation counts, and reversibly disable legacy learned-memory items whose authority cannot be trusted. Rollback does not automatically re-enable quarantined items.
- Memory context citations carry retrieval strategy and match-signal provenance. Current retrieval is native hybrid ranking: BM25-style lexical scoring, optional operator-visible semantic hints from memory item metadata, optional caller-supplied embedding similarity when embeddings are present, recency, and source diversity. Provenance distinguishes `lexical_recency`, `semantic_hints`, `semantic_vector`, and `hybrid_rank` rather than hiding them behind a generic semantic-search claim.
- QMD distillation receives a budgeted selected subset of ranked candidates. Context-pack quality metadata records the available candidate count/token estimate, selected candidate count/token estimate, dropped count, and evidence-token budget while preserving the existing context-pack cache and quality JSON storage boundary.
- Memory context insertion preserves leading system/policy messages and places retrieved non-authoritative memory immediately before the final user message when one exists, otherwise after the leading system-message block. Context manifests record the placement metadata for operator inspection.
- Library Memory may display the explanatory memory-engineering taxonomy `working`, `episodic`, `semantic`, and `procedural` over existing context packs, trace candidates, memory items, structured facts, decisions, and learnings. The taxonomy is presentation metadata only; it is not a new write authority, permission gate, graph/vector store, or hidden promotion path.
- Trace-derived memory capture is proposal-only. Durable run/chat/tool traces can create `agent_proposed` trace memory candidates behind `MemoryLifecycleService`, but promotion into trusted memory still re-enters operator authority, write-gate policy, browser-content guard, and evidence-envelope rules. Raw logs, raw tool outputs, and secret-like payloads are rejected.
- Explicit recall modes are part of the memory route layer: targeted recall, broad summary recall, and post-compaction resume context. These return inspectable context/quality/provenance records and open memory quality issues to callers; they are not invisible automatic prompt injection.
- Memory quality feedback records track useful, stale, missing, and irrelevant recall outcomes for Library/Memory and Ops diagnostics. Memory quality issue records queue scanner findings for source drift, stale low-value records, near duplicates, likely contradictions, and retrieval gaps until an operator resolves or dismisses them.

Notes:
- `MemoryLifecycleService` is the operator-facing lifecycle owner for context composition, explicit recall, trace-candidate proposal, recall-quality feedback, memory quality scans/queueing, learned-memory entry points, maintenance policy/run orchestration, memory item list/edit/forget/history, and shared dedupe/scope/write policy decisions.
- `MemoryContextService`, `ChatLearnedMemoryService`, and `MemoryMaintenanceService` remain focused collaborators behind that owner.
- `ChatLearnedMemoryService` is storage-repo backed for learned-memory item persistence.
- Remaining direct-SQL owners in core runtime-adjacent code no longer include `GatewayService` for `memory_items` lifecycle flows; selected migration and ops services may still touch adjacent stores outside the memory lifecycle owner boundary.

### Governed Skill Instructions

Definition:
Model-facing instruction bytes contributed by bundled, imported, generated, learned, staged, or activated skills.

Authority:
- Canonical scanner: `apps/gateway/src/services/assembled-prompt-injection-guard.ts`
- Shared draft admission: `apps/gateway/src/services/skill-content-validation.ts`
- Import and lifecycle enforcement: `apps/gateway/src/services/skill-import-service.ts` and `apps/gateway/src/services/skill-hub-lifecycle-service.ts`
- Provider-bound runtime assembly: `apps/gateway/src/services/governed-skill-instruction-service.ts`

Implementation status:
- `goatcitadel.promptware-scan` version `1.0.0` scans bounded whole sources for instruction hierarchy override, privileged prompt exfiltration, approval/policy bypass, unapproved tool execution, and role/identity override. It preserves original line positions and hashes, recognizes narrow protective negation, returns bounded structured findings, and does not exempt quotes or code fences.
- Skill imports scan every canonical-UTF-8 `.md` and `.txt` file in the exact content-integrity tree. Oversized, malformed, unreadable, truncated, or otherwise unscanned model-facing content is a hard blocker. Generated and self-authored drafts enter through the same `validateSkillContent` admission path.
- Skill Hub snapshots carry a versioned immutable scanner audit. Promptware findings, incomplete coverage, or stale scanner policy cannot be cleared by high-risk confirmation or lifecycle approval; non-revoke lifecycle operations rescan the exact hash-verified artifact.
- Chat scans every exact activated instruction after receipt/hash verification and scans the final rendered bundle. A finding fails turn preparation as `skill_security_blocked` with recovery action `review_skill_security` before any provider call. Stored failure evidence is limited to skill IDs, rule IDs, scanner version, and hashes. Clean results are cached only by scanner version plus instruction SHA-256.

## Derived Views

The following are explicitly derived projections, not canonical truth:

- Mission Control session summaries and timeline rollups
- dashboard refresh topic inference
- replay-gap banners
- UI freshness smoothing indicators

Derived views should prefer explicit `links`, `eventClass`, and `eventAuthority` over payload scraping or keyword heuristics.

## Trusted Ops Authority Envelope

Trusted Ops views consume the Gateway-owned `RuntimeAuthorityProjectionResponse` from
`GET /api/v1/ops/runtime-authority`. The endpoint is an additive read model over existing
owners; it is not a new write authority and Mission Control must not recreate its
classifications from browser-side joins.

Every item uses one explicit authority class:

- `canonical_record`: a durable record from the domain owner, such as a durable run,
  approval/effect settlement, backup manifest, release certificate, config generation,
  or unresolved external side-effect ledger row.
- `derived_projection`: a server-side calculation over canonical fields, such as
  lease/heartbeat freshness, runtime-owner reconciliation, or UI materialization posture.
- `retained_signal`: a retained realtime event used for operator awareness. A contradicting
  signal is labeled `contradictory`; the canonical repository still wins.
- `inferred`: a read-time observation such as current process/build/filesystem identity.
  Inference never upgrades release or backup evidence.
- `unavailable`: the canonical owner, valid row, or required evidence could not be read.
  Unavailable items do not receive an invented canonical reference.

The envelope is server-authored and bounded. Clients may select a workspace only; they
cannot submit authority, owner, source, basis, freshness, or deep-link metadata. Workspace
records fail closed to the selected scope, while Citadel-wide process, mesh, backup,
release, and config observations are labeled with Citadel scope. References are semantic
route kinds rather than arbitrary URLs, so Mission Control can link only to existing run,
approval, release-evidence, and reconciliation views.

Important failure modes and tradeoffs:

- malformed legacy rows are omitted from trusted state and produce an `unavailable`
  posture instead of being guessed into a valid record;
- stale or expired worker leases are derived health projections, not execution-state
  rewrites;
- approval decisions and follow-on effect settlement remain distinct from their Mission
  Control materialization;
- backup trust is verified against an isolated staged copy so semantic verification cannot
  mutate the published artifact, and filesystem presence alone is never labeled verified;
- the response is a bounded recent operational window, not a replacement for repository
  retention, audit export, or full historical detail APIs.

## Migration Guidance

When touching old code:

1. Prefer adding explicit linkage and classification fields over adding more payload inference.
2. Preserve backwards compatibility for older rows/events where practical.
3. Keep canonical writes close to the owning repository or contract boundary.
4. Treat UI scraping helpers as compatibility fallbacks, not the primary path.
