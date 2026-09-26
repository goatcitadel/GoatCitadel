# Canonical Runtime State Model

Last updated: 2026-08-14

This document defines the repo-native authority model for the core runtime nouns that appear across Gateway, Mission Control, storage, and replay.

**2026-09-25 transition:** New Chat turns do not create a frozen capability profile or catalog snapshot. The runner exposes tools from the current callable catalog after Gateway policy checks and rechecks authority when a tool is invoked. Approval-required tools retain their canonical durable wait and resume path. New cross-provider fallback, routed-context and workspace snapshots, Work Passport, automatic remote placement, dynamic requester MCP/mesh tools, delegated fan-out, governed code delegation, and model council are temporarily disabled. New scheduled agent turns fall back to deterministic inbox tasks; new heartbeat and commitment Chat turns are paused. Sections below that describe frozen profiles and their dependent records apply to historical turns and guarded replay only. Permission profiles and their security checks remain active.

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
- `ChannelDeliveryRuntimeService` owns queued outbound channel delivery. `channel_delivery_parts` binds each normalized message part to its queue attempt, request/payload hashes, approval and provider receipt before dispatch. Approval waits pause the same attempt; reopening the runtime reuses acknowledged parts and never repeats an ambiguous send. Linked provider receipts remain exact-ID evidence rather than additional logical queue jobs. Cron settles the original queued delivery only after its canonical send outcome is recorded. Persisted delivery diagnostics survive cold API reads.
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
- Chat execution placement: `packages/storage/src/remote-worker-chat-placement-repo.ts`
- Generated worker Chat task binding: `packages/storage/src/remote-worker-chat-task-repo.ts`, through the assignment and durable-run repositories
- Worker Chat resume evidence: `packages/storage/src/remote-worker-chat-resume-ledger.ts`, through the assignment repository

Implementation status:
- Schema and storage repository: complete through the protected storage migration set.
- Read-only diagnostics API: complete.
- Mission-session Chat LLM HTTP/SSE send, retry, resume, approval wait/resume, linked proactive wakes, durable-linked chat stream resumption, worker restart recovery, retry scheduling, and dead-letter recovery mechanics are durably owned for the `1.0` operator path. Planning, research, delegation, and code-capability turns run inside Chat.
- Queue consumers / idempotent worker runtime for the shipped durable path: complete.
- DLQ operator actions for the shipped durable path: complete.
- See `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md` for historical implementation background and migration context, not the active rollout source of truth.

Notes:
- A run records execution intent and outcome for the shipped resumable operator flow set.
- `chat_execution_placements` retains the immutable local or remote-worker choice before Chat starts its runner. Remote placement commits with its exact assignment; local placement excludes a later worker offer. Retries preserve the choice, while the current durable lease and mutation admission still govern execution and writes. Worker failure never authorizes a second local runner.
- Automatic remote placement requires frozen admitted context, a supported text/tool profile, delegation disabled, explicit runtime activation, and an eligible native Windows worker covered by the admitted operator's execution-workspace spending grant. Native MCP tools require the Gateway's current requester authority or static configuration/environment authority; mesh tools require current activation authority and composed Gateway effect/approval owners. Inference and tool execution revalidate the retained profile; the Gateway mints and verifies private contexts and preserves the exact target through approved replay. Credentials and context handles never enter the worker protocol. Native MCP without an explicit supported binding and council/delegation workflows remain local. See `docs/testing/COMPARISON_IMPLEMENTATION_STATUS.md` for proof limits.
- Mesh tool profiles bind a `mesh_tool` or `mesh_mcp_server` catalog entry by its derived publication capability ID. Preflight and replay validate the publisher, manifest, entry, effect posture and activation projection against the frozen binding, reject local-name collisions, and preserve conservative remote-effect classification. The shared Chat/worker authority gate also requires the Gateway's current activation owner; absent or changed authority fails before model dispatch. Placement and effect dispatch use the Gateway owners described below; destination-node execution remains unfinished.
- Chat without a caller-selected task can receive a generated execution task when its worker offer commits. `remote_worker_chat_tasks` (SQLite 216 / PostgreSQL 161) immutably binds that task to the original run, workspace, session, turn and payload hash. Task creation, parent-context metadata and placement commit together; the admitted request is not rewritten. Failed offers and local placement create no task. Generated task status follows the durable transition in the same transaction; existing caller-selected task lifecycles retain their owners. Oversized generic Chat input keeps the local path without truncating a worker snapshot.
- Worker model tool requests are retained in the canonical inference terminal frame. A protected call selection resolves exact arguments and current profile authority through `RemoteWorkerChatToolRuntime`, then enters the existing effect and Chat tool owners. `readCanonicalWorkerChatInput` and `readCanonicalWorkerChatOutput` reconstruct bounded model continuations from the frozen context, retained calls and canonical settled results; artifact verification and Chat materialization check the whole sequence and account for every model step, including tool-owned model attempts. The verified assignment supplies the task owner for canonical usage ingestion. A tool result alone cannot complete Chat.
- Pending worker tool approvals retain nonterminal effect history and the original approval correlation. `retainRemoteWorkerChatApprovalWait` verifies exact Chat/assignment linkage inside the parent write fence; the normal Chat finalizer owns the durable wait and approval-keyed checkpoint. `assertLocalApprovedActionOwner` prevents the ordinary approval executor from taking over a worker-owned tool, including historical assignments without a placement row. An operator decision still requires current native generation, lease, capability and policy authority before execution.
- `RemoteWorkerChatApprovalWaitReadService` lets protected native sync observe an exact sealed approval wait across restart, including expiry of the retained lease. It checks current credentials, mesh admission, assignment generation, retained token and canonical approval/checkpoint linkage. This read does not renew authority. The foreground worker retains its assignment and polls while waiting.
- The assignment repository retains separate immutable approval-wake, parent-dispatch and recovery bindings. Gateway wake and worker reconnect use these owners to resume the original approved action under a fresh admitted parent claim and protected native lease. Approved effects enter the canonical pending-action executor and retain execution receipts; uncertain outcomes require reconciliation rather than redispatch. Local real-process proof does not certify protected native hosting, an installed Windows service or a second physical machine.
- Windows worker service mode reads its fixed `configuration/worker.environment` through `InstalledWorkerFiles`. The native owner checks protected payload/configuration permissions, separates worker-writable state, and retains file handles for the child lifetime. The stopped-service installer requires an independently pinned v3 package inventory; uninstall retains configuration and state. These source owners do not authorize protected signer access or establish successful installed-service custody, startup or recovery.
- The native signing transport classifies OS-collected callers as an elevated interactive operator or the dedicated runtime worker. The latter is restricted to inspect, runtime PoP and TLS client signatures. Primary/pipe token identity and LSA logon authority are checked before protected execution; the exchange advertises and verifies the caller's exact operation set. The installer and native validators require worker read/execute access to the signer/client images and their protected directories, bounded pipe read/write access, and query-only signer SCM access. After validating its own service identity, signer startup adds worker query/wait access to its process and query-only access to its primary token while retaining existing ACL entries and owner/protection state; failure prevents transport startup. Broker control remains SYSTEM/Administrators-only. Fresh-install status 1077 is accepted only for a stopped signer with no PID and clean remaining status metadata. Actual cross-account authentication, availability and installed custody remain incomplete; these source grants do not establish an operational installed signing path.
- Durable execution now owns worker startup, retry scheduling, wake/resume, dead-letter recovery mechanics, approval wait/resume wake effects, approval-linked proactive wakes, and durable-linked chat-turn stream resumption for mission-session Chat operator work.
- A durable child watcher's `attached` or `detached` state is presentation/attention truth only. `Continue in background` detaches the watcher without changing the child run, scheduling, policy, grants, approvals, waits, recovery, steering, inspection, or cancellation authority; reattach restores foreground attention. Canonical blockers remain visible in both the background rail and Chat status.
- A detached child that reaches an approval, user-input, recovery, or other attention blocker may dispatch an idempotent `durable.attention_required` event only through active operator-configured notification routing. Dispatch begins after the durable transition commits, and delivery failure is non-authoritative: it cannot roll back, advance, fail, or otherwise alter the run.
- Cowork/orchestration runs are durable-run backed and worktree-owned. `orchestration_runs.status`, `currentWaveId`, and `currentPhaseId` describe plan/operator position; `durableRunId`, `executionState`, `worktreePath`, `worktreeStatus`, and `worktreeBaseRef` describe execution truth.
- Approval-gated orchestration resume must re-enter the linked durable run. An approval action records resume intent on the orchestration record and leaves the run paused; durable worker execution remains the authority that applies the approval, runs the approved phase, and then advances. A phase marked `requiresApproval` (every phase in `hitl` mode) pauses before it runs, and approving it lets that phase execute. Plan limits are checked between phases, not during one.
- An orchestration phase runs as a child Chat turn on its own durable run. The parent durable run parks (`waiting`, orchestration `executionState: waiting_for_child`) until that child settles, so the durable worker can execute the child, and is then woken to read the child's canonical trace, output, and model usage. A child waiting on a tool approval keeps the parent parked; the approval is resolved in Chat. A child that stops for user input fails the phase. Cancelling the run, or failing its phase, also cancels the child turn if it has not finished. Phase cost is the child turn's recorded model usage; when any call reported no cost, the phase records `costUnreported: true` and plan cost limits may understate real spend.
- An orchestration run and its linked durable run end together. A workflow error fails the orchestration run under the durable lease before the worker fails the durable run. When a durable run ends outside the orchestration lifecycle (an operator cancel through the durable API, a continuation gate, a dead letter, or a workflow error that could not settle the run), a reconciler on the durable worker's recovery pass settles the orchestration run to the durable outcome and releases its worktree. Worktree allocation, queueing, and cancellation write the run with compare-and-set, so a concurrent cancel is never overwritten and a cancelled run's durable run is never resumed. A blocking `orchestration.run.before` hook fails the run, cancels its paused durable run, releases its worktree, and returns a conflict.
- External writeback sessions remain visible operator sessions. Integration operator write actions now record audit-only `external_writeback` evidence envelopes so the external side-effect intent and outcome are durable and inspectable. Local bridge writes, Activepieces triggers, Trello card creation, and Gmail send actions claim idempotency before crossing the external boundary and record replay outcome, replay-attempt, and manual retry posture evidence. The external side-effect run ledger is populated by the shared runner and stores pre-boundary, started, completed, failed-before-boundary, and unknown-outcome states. Mission Control can start a replay-audit durable run from a ledger row so operators can inspect eligibility in Run Detail. The replay-safe worker and durable `external_side_effect.replay` workflow may retry failed-before-boundary or stale claimed-not-sent runs only when an allowlisted owning integration reconstructs the original safe payload; unknown post-boundary outcomes stay manual. If no owning replay job is available, the durable workflow checkpoints skipped/manual-reconciliation reasons without sending an external request. Activepieces preserves safe workflow-run id/status/url evidence when the webhook returns it and surfaces that evidence in the external side-effect ledger as webhook-response-only status. Activepieces run-status checks are explicit operator read actions against a configured API base URL and token, not background polling or managed workflow execution. Workflow recipe Activepieces template export is a read-only planning artifact for operator import with structural validation evidence; native Activepieces import compatibility remains explicitly unverified, and the export is not an Activepieces flow creation, webhook trigger, or status poll.
- Legacy traces without durable linkage may still require compatibility reads or resume fallbacks for historical rows, but new mission-session LLM sends do not bypass durable ownership.
- Runs may be linked to sessions, turns, tasks, and approvals.
- The `durableKernelV1Enabled` feature flag gates durable-run APIs. The `replayOverridesV1Enabled` flag (default: off) gates replay-with-overrides.
- `unifiedComposerPaletteV1Enabled` is a Gateway-authored Mission Control projection gate. It changes only the Chat composer discovery surface: its client registry reads existing scoped APIs, caches source results per session, and degrades source failures independently. It does not create a second capability catalog, widen file/workspace access, or make inactive agents, candidates, proposals, or non-callable skills executable.

### Evolution Change Plan

Definition:
A durable, Gateway-owned lifecycle for an allowlisted persistent change to GoatCitadel configuration, connections, capabilities, improvements, remediation, or product source.

Authority:
- Contract shape: `packages/contracts/src/change-plan.ts`
- Persistence: `change_plans`, append-only `change_plan_events`, and immutable `change_plan_links`
- Orchestration owner: `apps/gateway/src/services/evolution-control-plane-service.ts`
- Frozen mutation inventory: `apps/gateway/src/services/evolution-control-plane-governance.ts`
- Detailed contract: [docs/EVOLUTION_CONTROL_PLANE.md](./EVOLUTION_CONTROL_PLANE.md)

Notes:
- One singleton Control Plane serves Chat, Settings, compatibility routes, startup reconciliation, and local observers. Mission Control never writes canonical owner state directly.
- The model-facing `change.request` tool creates only a bounded, secret-free plan. Confirmation, canonical approval, apply, activation, rollback, restart, and external-effect authority remain server-owned.
- Every transition uses revision CAS. Effectful actions additionally bind an action nonce, immutable form snapshot, target revision or hash, idempotency key, expiry, and one active target claim.
- Provider/channel credentials, OAuth values, and native paths use dedicated owner routes. Plans and model context retain only sanitized state and opaque owner links.
- Restart recovery inspects the linked low-level owner and reconciles observed state. It does not blindly replay an interrupted apply.
- Realtime Change Plan events are refresh signals. The plan, event, owner, approval, and artifact repositories remain canonical.
- Legacy Chat plan records are compatibility projections and are backfilled into the canonical owner. The `applied` state is compatibility-only for one window.

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

### Chat Trusted Automatic Fan-Out

Definition:
A default-disabled, Chat-native durable aggregate for up to three independently delegated child tasks. It is not a second orchestration runtime or a separate Cowork surface.

Authority:
- Grant and policy contract: `packages/contracts/src/autonomy.ts` and `packages/contracts/src/chat-fanout.ts`
- Canonical aggregate state: `chat_fanout_invocations`
- Canonical child run/step state: `chat_delegation_runs`, `chat_delegation_steps`, and durable child watchers
- Admission, freeze, cancellation, and recovery owner: `apps/gateway/src/services/chat-durable-fanout-service.ts`

Notes:
- The feature is gated by `durableChatFanoutV1Enabled`, which defaults off. With the gate off, automatic fan-out fails closed and does not fall back to the historical in-memory automatic path.
- Admission requires both the Chat autonomy selection `auto_when_useful` and one active, expiring, exact-project `subagent_fanout` grant in the same workspace. The grant is Chat-only, carries an explicit child-activation limit and budget ceiling, and can be revoked immediately. A legacy, wildcard-workspace, or projectless grant cannot authorize this kind.
- Before any child starts, the Gateway atomically reserves all requested child activations and the conservative aggregate cost ceiling. The maximum is three children. Insufficient quota or budget rejects the whole aggregate; a durable reservation ID makes duplicate tool delivery/recovery idempotent.
- The parent durable Chat run waits on the canonical fan-out invocation. Each child retains the existing frozen policy/capability context, per-child limits, approvals, effects, and non-recursive delegation boundary. The parent wakes only after child terminal state/result materialization reaches canonical delegation storage; synthesis uses only committed child output plus explicit failure or approval truth.
- A changed session project, archived project, project binding, expiry, revocation, changed frozen grant binding, or policy block prevents later dispatch/recovery. Parent cancellation or grant revocation requests durable child cancellation and leaves unresolved effect posture explicit; it never retries ambiguous effects.
- Chat exposes only inspect, continue-in-background, and **Stop aggregate** controls. Stop is session-bound and cancels the canonical aggregate plus its active durable children; it does not expose per-child retry or manual rewiring.
- Compaction receives a bounded secret-free agentic state capsule. It preserves active parent tail, child/approval waits, capability/grant hashes, committed-result references, and citations; it does not promote child output into memory or treat stale grant authority as current.
- The two-host remote-worker promotion remains a separate parity milestone. This Chat aggregate does not claim remote-worker runtime parity.

### Chat Tool Effect Truth

Optional OpenCode CLI delegation remains a `shell.exec` invocation within the
canonical Chat turn. Its bounded `externalAgent` result is a derived projection
of redacted external JSONL, retained when raw output is virtualized into an
artifact. Agent session IDs, tool steps, and reported file diffs are external
evidence, never Gateway run identities, approval effects, or verified file
receipts. The shell exit code and Chat lifecycle remain separate from the
agent's claimed completion. See [OpenCode integration](./OPENCODE_INTEGRATION.md).

Chat planning freezes a server-authored `effectPotential` of `none` or `unknown`, one secret-safe binding for every enabled `tool.call.before`, `tool.call.after`, `tool.call.error`, and `after_tool_call` hook, and the exact built-in/plugin runtime-owner generation into the immutable capability profile. `chat_tool_runs` owns recovery `effectDisposition` plus operator-facing `effectOutcomeKind`/`effectEvidence`; the runner durably crosses an auxiliary-effect fence immediately before hook delivery/materialization and a separate main-executor fence immediately before the admitted built-in, plugin, MCP, or browser-fallback owner. This separation preserves a legitimate approval reached after a hook as `approval_wait_after_auxiliary_dispatch` while suppressing an approval reported only after the main executor crossed its boundary. Only a proven pre-dispatch block, approval wait, skip, reuse, or trusted built-in safe read may settle `none`; opaque legacy invokers, hook or owner drift, browser/shell/MCP/plugin/remote/mutating paths, interruption after either effect boundary, approval-resume execution, and post-dispatch output rejection remain `unknown`/`uncertain`, carry inspect-before-retry guidance, and are never automatically replayed. A `concrete` outcome requires a typed out-of-band receipt whose Chat tool-run, tool, scope, and idempotency correlation exactly match a completed canonical owner; result payload IDs are never evidence. Chat tool cards, expanded trace detail, ordinary decision traces, and trusted Ops Run Detail project the same fields but withhold raw receipt IDs until a dedicated server-verified owner projection exists; expert raw JSON is explicitly diagnostic and non-canonical. These internal classifications are stripped at the shared complete/stream provider-send boundary.

MCP requester context is an app-private branded handle derived from the frozen
Chat capability profile. Ordinary Chat and worker execution pass it through
runtime options; request DTOs and pending-action payloads cannot carry that
authority. Ordinary approved MCP replay restores the profile only through an
exact join of the retained request, approval, Chat tool run and admitted actor
scope. Worker approval continuation uses its protected execution-owner checks.
The MCP dispatch owner revalidates the profile and requester connection before
calling the remote tool, awaits the execution/effect boundaries, and applies the
canonical approval policy's redaction decision. Named-tool placement additionally
requires the explicit static or requester binding and its current Gateway owner,
as described below.

The policy engine has a process-local named-MCP mapping to the registered
`mcp.invoke` definition. It preserves the exact native name and arguments in
pending approvals and audit records while inheriting MCP risk and untrusted-input
restrictions. Deny patterns and Citadel Wards match either identity, and the
active permission ceiling must cover the native name or its MCP policy owner.
Scoped allow grants retain the existing selection and consumption rules. A grant
whose pattern covers `mcp.invoke` counts all mapped MCP calls; a native-only grant
counts that exact tool. SQLite 217 / PostgreSQL 162 persist this shared accounting
identity without changing historical records. Inspection and dry-run rows do not
consume the limits. The mapping is neither requester authority nor a credential,
and approved replay requires a fresh process-local mapping as well as the exact
retained approval request. Generic MCP wrappers project their target from the
same trimmed server/tool fields used by transport and evaluate the actual nested
arguments. Both forms record the canonical native target plus the shared MCP
identity in access decisions; approvals and audit retain the original invocation
form and arguments. Historical generic rows continue to count toward MCP-wide
limits without invented native-target attribution. This projection cannot create
a named dispatch handle or requester authority. Direct MCP policy checks use the
same Gateway context normalizer as generic Chat calls, including canonical
workspace/Citadel resolution, while retaining the exact target and arguments sent
to transport. Both forms reject a native target that collides with a registered
tool.

The policy engine also has a process-local mesh mapping for exact `mesh_tool`
and `mesh_mcp_server` publication identities. Its private `mesh.invoke` policy
template is absent from the public tool registry and cannot be invoked as a
generic tool. It supplies conservative network, secret and mutation posture;
MCP permission does not grant mesh access. Denies, Wards, permission ceilings and
scoped grants consider both the publication and shared mesh identity. Approved
replay retains the exact request and requires a fresh mapping plus current policy.
SQLite 219 / PostgreSQL 164 widen the constrained accounting column while
preserving recorded values and the existing index. Mesh and MCP counters remain
separate. This mapping grants no publication or transport authority.

Chat schema admission now reads mesh descriptors through the digest-verifying
publication repository and binds them to current activation authority. Tool
publications retain their exact input schema. MCP-server publications expose an
explicit advertised-tool selector and argument envelope; their native schema
digests are not treated as schema bytes. A bounded inventory interleaves nodes,
shares immutable manifest reads, and batches current activation checks. Private
schema handles carry the policy mapping, while persisted profiles retain only
the exact provider definition, alias and publication binding. Profile freeze
rechecks selected activations after policy inspection. Current mesh policy
probes require a process-local context and reload the exact profile/catalog,
actor, scope, schema and activation. Cloned handles and drift fail closed.
Chat mesh calls enter the canonical invocation coordinator and retain its hooks,
policy, plugin-owner exclusion and Ward redaction. Ordinary invocation cannot
execute an approval replay inline. The approved-effect owner recovers the exact
Chat approval/profile join and supplies a fresh mapping to approved policy and
dispatch. The shared dispatch adapter rechecks identity after execution/effect
fences, and the invocation service rechecks activation and deadline before
exposure. Node polling exposes only its own exact, confirmed replication
envelopes through `/api/v1/mesh/capabilities/invocations/pending`. The bounded
transient input vault owns discoverability; generic replication events cannot
mint a delivery, and a restart cannot fabricate lost arguments. Neither pending
delivery nor arguments are exposed before the transport confirms the exact
envelope. Input reads recheck admission/certificate, current activation, health,
lease, deadline and terminal settlement. Polling is not an execution claim.
The destination worker's optional `WorkerMeshCapabilityRuntime` binds deliveries
to constructor-supplied local owners and verifies complete manifest, entry,
descriptor, permission and input hashes. The worker process's state lock owns
its local execution journal. An execution marker precedes local authority
checks and the effect; after disk/progress awaits, a fresh input read rechecks
origin admission and activation. The local owner enforces its schemas,
permissions, path/network policy and execution limits.
The exact bounded result precedes settlement transmission. A confirmed receipt
replaces transient output with a permanent invocation/hash tombstone. Recovery
resends a retained settlement, or settles an interrupted execution as unknown;
it never re-enters the local owner. A retained unknown receipt also prevents
fresh work after another process restart; restart is not reconciliation. Both
local authority checks and effect entry obey the invocation's cancellation and
deadline. One budget starts before the first input read and includes subsequent
disk/progress waits, input revalidation and local execution. Transport receives
the same cancellation signal; checks after awaits use both wall and monotonic
time so a delayed timer or backwards clock cannot admit late work. Expiry before
the execution marker leaves no effect claim; expiry after the marker but before
the owner records a known timeout. A late result after owner entry is unknown
and requires reconciliation. Retained settlement reporting does not inherit the
expired execution deadline. An active journal without room for its terminal
receipt is rejected.
After retained recovery, the process can drive one assignment and one serialized
mesh cycle concurrently. This allows an assignment to await a mesh effect on the
same worker. Normal assignment completion stops polling and drains the current
mesh cycle; failure cancels both branches and awaits their coordinators before
returning. The local execution adapter still owns OS process termination and
resource enforcement. This coordinator is not a native isolation boundary; the
shipped protected host still needs its local capability adapters and custody.
Worker lease/control refresh tolerates at most two raced control-read rejections
by renewing from its newly retained lease before another authenticated read.
Each renewal re-enters current assignment, credential and parent authority.
Persistent rejection, malformed receipts and ambiguous renewal still stop work;
the helper never retries a model/tool operation. Cancellation may proceed only
to the existing terminal-settlement path.
The native `CellWorkspaceDirectories` helper verifies the admitted parent's
exact owner/group, protected DACL and integrity label before walking its path,
then reopens and pins its NTFS ancestry and rechecks the admitted identity and
security. Creation uses that retained parent handle. Later verification rejects
parent permission or label drift as well as cell-root drift; closing releases
handles without deleting partial or completed directories. The descriptor grants
SYSTEM and the frozen controller full control and suppresses implicit owner
DACL rights. This is internal parent/root custody, not volume provisioning,
quota enforcement, AppContainer profile storage confinement or installed-service
authority. Those remain required before native backend activation.
The internal `CellVirtualDiskFile` owner creates only a new fixed VHDX backing
file under the verified controller directory. It takes a frozen nonzero disk
identifier and explicit virtual/file-byte reservations. The file preserves the
controller's owner, group, protected access rights and medium no-write-up label;
inheritance flags are normalized for a file before kernel creation. Verification
checks the retained NTFS identity, exact file descriptor, single unnamed stream,
actual physical/allocated bytes, VHDX provider/type, fixed subtype, identifier,
sector size and unattached state. It never adopts an existing image or ordinary
file. Cancellation and provisioning expiry cancel and join submitted I/O; a slow
driver may delay that join. Closing releases handles without deleting disk state.
This helper verifies allocation after creation and requires reserved metadata
headroom. It does not provide a transient allocation limit, attached/formatted
volume, disk/file-count quota, AppContainer profile confinement or installed
service authority. Native backend readiness remains gated on those owners.
The internal `CellVirtualDiskAttachment` operation retains an already-created,
verified backing-file identity before opening the SDK handle for attachment.
It checks the effective thread token's existing volume-management privilege;
process-token fallback occurs only without an impersonating thread token. The
production helper neither enables privileges nor grants account rights. Attach
requests no drive letter and permanent lifetime. A lost controller handle thus
does not silently detach an uncertain workload. Cancellation/expiry joins a
submitted asynchronous attach, and any uncertain result remains `unknown`.
Verification rechecks the exact file/disk identity and SDK-reported attached
device path. That path is diagnostic data, not authority to format a numbered
disk. Explicit detach rechecks current identity and privilege, with cancellation
and deadline checks before and after the synchronous Windows operation. The
outer service watchdog remains required for a stalled driver. The caller must
establish canonical provisioning and zero-workload authority; this helper does
not implement those owners, volume formatting, quotas or recovery admission.
The local native lane exercises rejection and records attachment as unexecuted.
`verify:remote-worker:windows-cell-attachment` is the separate administrator-run
attachment/detach lane, with a privilege preflight before any fixture image is
created. Its successful physical attachment path remains unverified on the
current non-elevated host. These helpers do not enable native backend readiness.
The internal Windows `RunVerifiedRuntimeJob` adapter consumes the admitted
`goatcitadel.worker-runtime-bundle.v1` manifest and its expected root identity.
It verifies exact runtime inventory, sizes and content hashes and holds the
verified file/directory handles through the existing AppContainer/job lifecycle.
An entry executable outside that inventory is rejected before process creation.
The job and complete-bundle entrypoints reject input above the explicit allowance
or the internal 1 MiB ceiling before copying request bytes. Empty input remains
the default. A private first-instance pipe gives the child only a read handle;
the controller pumps bounded writes alongside output and cancels and joins any
pending write on termination. Early closure cannot report complete delivery.
Recorded byte counts describe pipe delivery, not tool acceptance or effect
completion; the invocation owner must still verify its result and settlement.
The shared contract owns the domain-separated binary manifest digest. This
adapter does not establish package trust or protected volume authority: the
caller must supply governed publication, immutable root custody, quotas and
assignment authority. The native backend remains unavailable without all its
existing readiness requirements.
The internal `PinnedCellRuntimeBundle::InstallTo` operation copies an already
pinned source into an empty, verified protected runtime root. It creates names
exclusively relative to held parent handles, applies the root's exact security
descriptor, copies from verified source handles, flushes the files and verifies
the installed inventory before returning retained output pins. Cancellation or
failure preserves partial files and exact creation/byte counters; another call
refuses to adopt a nonempty destination. This is a serialized internal copy
operation, not governed publication or recovery authority. Filesystem admission
and job launch share literal drive-root and volume-GUID path validation and
recheck the actual fixed NTFS volume and file identities. Directory index growth
is permitted; alternate streams and unsafe metadata remain rejected. Controlled
native proof launches the installed executable inside the existing AppContainer
and verifies both complete and interrupted copying. Protected volume provisioning,
quotas and installed service/assignment composition remain required.
Native node settlements carry the authenticated worker's exact M3 authority
fence into storage. Both first submission and replay recheck current worker,
credential and mesh admission in the committing transaction. Activation
withdrawal alone still permits an admitted node to report a dispatched outcome;
worker or mesh-authority revocation rejects that node's submission and replay.
The protected Windows listener exposes these owners through the fixed POST
`/api/v1/remote-workers/mesh-capability-exchanges` route (PoP-v2 code 13).
Its closed actions publish/list publications, discover pending deliveries,
read input, report progress and settle. Current M2/M3 authority supplies node
identity; caller-supplied node identity, activation and arbitrary targets are
rejected. Each exchange requires governed-tool scope, exporter-bound proof and
a durable fresh nonce. Read responses recheck admission before disclosure;
publication and settlement retain their canonical transaction fences. This
transport does not grant execution, retry or capability-activation authority.
Recovery requires the retained intent's exact session, turn, run, approval, execution
profile and publication identity; matching tool-run and input hashes alone are
insufficient. Uncertain delivery retains manual-reconciliation truth and is not
presented as a successful tool result. Worker placement requires current mesh
authority, composed effect/approval owners and the worker's governed-tool
capability. Worker effects resolve the exact actor/profile/schema binding before
creating a Chat tool run and carry a fresh private context into the coordinator
and approved continuation. Protected lease and spending checks remain in force.
Gateway dispatch now validates exact published tool input schemas before retaining
an intent or entering its execution fence. The destination validates the same
hash-bound bytes before recording execution, and checks successful tool output
against the published output schema. Invalid post-execution output remains unknown
and cannot authorize a retry. Gateway settlement separately checks the immutable
descriptor, declared byte limit, digest and output schema; missing manifest
authority cannot widen its response limit. Successful node submissions require
output bytes, captured with their settlement metadata before asynchronous work.

The Node-only contracts schema validator uses draft 2020-12 validation in at most
four temporary worker threads, with bounded JSON size/depth, V8 resource limits,
a five-second deadline and joined termination. It does not coerce values, insert
defaults, remove properties or resolve remote schemas. This contains expensive
schema work without claiming a hostile-code sandbox. MCP manifests expose only
native schema digests, so this layer validates their selector names and envelope;
the destination registry owner enforces the actual native tool schema.
The stock worker entrypoint now loads an optional digest-pinned local tool
registry independently of remote publication. Its filesystem reader and Windows
NTFS writer require exact native schemas and permission envelopes, bound file and
response bytes, recheck local configuration/root identity and preserve relative
paths in output. The writer launches only a fixed digest-pinned native helper,
pins directory ancestry, and compares previous contents before replacing a file
through an exclusive handle. Failures after mutation require reconciliation;
replacement is not an atomic rollback transaction. The destination HTTP MCP owner
pins an exact endpoint and native schemas in the local registry, validates fresh
discovery and rechecks Gateway admission/activation plus identical input bytes
immediately before sending a tool call. Its network-only permission and unknown
effect posture grant no worker filesystem or process authority. Lost replies and
invalid output after dispatch require reconciliation. The owner supports
anonymous and bearer-authenticated Streamable HTTP JSON/SSE responses. The bearer
file is independent of Gateway credentials, pinned by exact bytes and rechecked
before every send. An authenticated descriptor binds the endpoint, native schemas
and credential reference through an opaque configuration digest. Changes require
new publication/activation authority. Credentials must remain outside destination
filesystem roots; the operator owns their file permissions. OAuth, stdio and
protected process/custody hosting remain unfinished. Registry content is never executable
code or approval. Omitting the registry still recovers retained mesh work and
refuses unknown outcomes, while never polling for new invocations. Additional
destination tools, native cell/service composition and physical two-machine/live
acceptance remain unfinished. Installed service configuration now uses an
administrator-owned immutable registry and atomic selection, guarded by the
expected prior selection, a writer lock and stopped-service checks. The native
host derives the two registry settings from protected files and pins them for the
child lifetime; the worker cannot change them. This source composition has
temporary-file proof, not installed lifecycle/custody acceptance. Setup is documented in
`testing/REMOTE_WORKER_MESH_TOOLS.md`.

For a native tool already selected with an explicit requester binding, Gateway
dispatch re-reads the durable profile through the branded Chat context and checks
its actor, turn, workspace, catalog, profile hash and binding integrity. The exact
stored server ID identifies the native tool suffix, including dotted names; tool
arguments cannot redirect that mapping. Last-moment Chat policy probes and ordinary
approval replay use the same native policy identity. Approved replay retains one
context for its policy and dispatch checks and preserves the reviewed native
request and uncertain-after-send result. A changed connection mode, missing
binding or substituted runtime owner blocks dispatch. Server tool allowlists,
denies and first-use consent apply to both static and requester-scoped modes.
Chat now enumerates requester-scoped native schemas through the authenticated,
secret-scanning discovery owner. A second connection per server revalidates the
selected descriptors against the final catalog before native schemas enter the
frozen profile. Private policy handles remain outside persistence. Enumeration
is bounded to 16 servers and 256 candidate tools, shared across servers; final
Chat selection retains its existing count and token limits. Both discovery
passes use four concurrent connections and a shared 30-second deadline per pass.
New provider aliases encode the complete SHA-256 identity in 48 characters.

Runtime catalog checks revalidate the native requester/server authority and the
shared MCP capability without adding requester tools to the global catalog.
Missing process-local discovery outcomes can be reconstructed only from the
exact retained profile, binding and provider alias, with current scope, auth and
server checks before fresh credential resolution. Changed schemas cannot replace
that alias. Recovery remains before the existing effect boundary and never
authorizes replay of an uncertain effect. Credentials and discovery outcomes are
not persisted. Requester-scoped worker placement and effect execution use these
same Gateway owners, including approval continuation and current identity checks.
Controlled built-application process restarts now prove discovery reconstruction,
one MCP effect and final Chat materialization, before dispatch and across an
approval wait. The fixture supplies synthetic resolvers through `buildApp` and
the runtime factory to the service constructor. Stock startup keeps the default
empty registry; no environment, route, skill or add-on can register a resolver.
Installed-service custody and physical/live acceptance remain unfinished. See
`docs/testing/COMPARISON_IMPLEMENTATION_STATUS.md` for the exact process and
transport boundaries.

Static native tools use `McpStaticChatService` for bounded, authenticated discovery
and current-configuration checks. Server-supplied metadata is normalized and
secret-scanned before it enters Chat. Generated catalog names are excluded from
connection-material scanning so a public `mcp.` prefix cannot collide with an
endpoint path segment. The immutable binding retains the exact native target,
definition, final catalog, actor/turn scope and opaque configuration identity;
endpoint, environment and credential material stay private. Static and requester
tools share the 256-tool candidate limit and collision rejection.

`McpServerStore` records superseded OAuth and environment references in the
private `McpCredentialRetirementStore` within the publication/removal transaction.
Reconciliation checks all current auth/environment bindings before claiming a
retired slot, performs keychain deletion outside the database transaction, and
retains a permanent tombstone that bars republication of that version. Failed or
unacknowledged deletion remains pending; a lost completion acknowledgement does
not restore authority. A bounded index holds at most 4,096 pending retirements,
while completed tombstones remain individually indexed in storage. Cleanup runs
after critical startup, acknowledged credential publications and maintenance ticks. Its failures
do not make a completed OAuth request retryable, and diagnostics contain counts
rather than credential references or values. Windows deletion requires explicit
absence/removal acknowledgement and rejects other PasswordVault failures.
`McpCredentialStagingStore` registers each fresh immutable OAuth/environment
reference before the synchronous keychain writer runs outside the transaction.
Its private journal stores no credential values or value hashes. An acknowledged
writer becomes ready for ten minutes; canonical publication consumes that
readiness in the same transaction as auth/environment state. Expired ready
versions cannot publish, and bounded reconciliation transfers unreferenced
versions to the retirement owner. An owner-bound write that fails, encounters
an occupied slot, or loses its terminal acknowledgement remains `writing`: it is
unpublishable and is never automatically deleted based on age alone, because a
suspended writer may still resume. The staging index holds at most 4,096 entries;
each pass defaults to 32, permits at most 256 and rotates retained entries to
avoid starvation. Reconciliation checks all current bindings, including corrupt
cross-server aliases. Journals use existing settings transactions on SQLite and
PostgreSQL; no schema change is required.

Version 2 private staging/retirement records preserve an opaque Windows custodian
binding from the original write. The helper derives it from the native registry's
machine identity, current Windows SID and GoatCitadel resource namespace. Only
the domain-separated digest enters the journal. Each Windows mutation checks its
own current identity before constructing PasswordVault. Immutable writes reject
occupied slots and verify the saved value; credentials travel through stdin.
Production cleanup requires a matching original custodian plus an explicit
absence/removal receipt. Unknown or foreign custody stays pending, and retirement
passes rotate retained entries so they cannot starve this host's cleanup.
An unfinished writer supplies no retirement authority even if a corrupt canonical
binding references it. Version 1 records remain readable with unknown custody;
they are never silently rebound to the current host. Other keychain backends
remain usable, but automatic retirement lacks a supported custody owner there.

This is a local OS identity check, not installed service custody, hardware
attestation or clone-resistant identity. Unacknowledged writers, older unindexed
credentials and custodian migration/rebinding still require inventory and recovery
authority. Neither owner discovers or deletes arbitrary secrets.

Static invocation reads fresh `tools/list` metadata on the same connection as
`tools/call` and requires the frozen provider definition to match. A one-use
process-local authority checks the current profile, scope, actor, shared MCP
capability, configuration and captured environment before the effect marker,
then rechecks authority after its asynchronous storage work. Failure after that
marker is conservatively retained for reconciliation, never automatically retried.
Worker placement, inference and approved continuation use the same static owner.
Two stock built-Gateway/Windows-worker cases prove restart before dispatch and
across approval with one MCP call and one Chat reply, using loopback services and
synthetic worker custody. No constructor resolver is needed for the static path.

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
