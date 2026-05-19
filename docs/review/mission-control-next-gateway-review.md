# Mission Control Next + Gateway Review

Review date: 2026-05-17
Reviewed HEAD: `d466ab7f4e7061bc59cd95b7d023344700887d5f`
Change-map baseline: `claude-code-baseline-2026-05-16..HEAD`
Scope: broad repo-grounded review of current `main`; the baseline was used only to focus navigation, not to limit scope.

## Executive Summary

This review found several release-relevant issues across orchestration, gateway trust boundaries, approval visibility, Code Mode truth, and provider/runtime explanations.

The highest priority failures are:

1. OpenAI Responses streaming can collapse multiple parallel tool calls into one corrupted call.
2. The historical generic channel inbound route finding is resolved/superseded by the connection-scoped inbound route; keep future channel reviews focused on verifier/idempotency coverage for `POST /api/v1/integrations/connections/:connectionId/:channel/inbound`.
3. Task artifact verification can probe raw file paths and URLs before task existence or workspace ownership is established.
4. Code Mode approval recovery, artifact hash validation, and run-ledger surfacing were previously identified gaps; as of the 2026-05-17 permission/Code Mode hardening pass, the current implementation preserves `originSurface: "code"`, revalidates frozen artifacts before execution, and surfaces governed run detail in Code.

The Mission Control Next shape is otherwise directionally right: Chat, Cowork, and Code are distinct surfaces, Ops has a real approval queue with replay/recovery details, Cowork exposes run-map/checkpoint posture, and Code has a repo-first workbench. Governed Code Mode run truth is now visible from the Code surface; remaining gaps in this review should be read against the current implementation, not this document's original finding state.

## Findings

### P1 - Responses Streaming Can Collapse Parallel Tool Calls

Impact: parallel tool orchestration can lose or corrupt tool calls. A model that emits two function calls in one Responses stream can have both calls merged under the same index, so downstream execution may run one malformed call instead of the intended set.

Affected surface: gateway provider runtime, Chat/Cowork/Code agentic tool execution, OpenAI/Codex Responses streaming.

Evidence:

- `apps/gateway/src/services/llm-service.ts:1014` handles `response.output_item.done`.
- `apps/gateway/src/services/llm-service.ts:1025` emits every streamed function call as `index: 0`.
- `apps/gateway/src/services/chat-agent-completion-adapters.ts:259` aggregates streamed tool calls by `toolCall.index`.
- `apps/gateway/src/services/chat-agent-completion-adapters.ts:292` builds the final tool call list from that index map.
- `apps/gateway/src/services/llm-service.ts:2224` enables `parallel_tool_calls` by default for Codex GPT-5 Responses payloads when the request did not set it.

Source-of-truth conflict: the runtime is configured to allow parallel tool calls, but the stream adapter serializes all completed function calls into one index.

Validation status: confirmed by static trace. A regression test is still needed.

Fix plan:

1. In `executeOpenAiResponsesStream`, keep a stable per-response function-call index map keyed by `item.call_id`, `item.id`, or `event.item_id`.
2. Emit that stable index instead of hard-coded `0`.
3. Add a gateway test that feeds two `response.output_item.done` function calls in one stream and asserts the aggregate completion contains two distinct tool calls with separate ids, names, and arguments.
4. Include a variant where one call arrives before any text delta.

### P1 - Generic Channel Inbound Allows Spoofing and Empty-Key DoS in the Checked Profile - Resolved/Superseded

Impact at the time of the original review: in the checked local/shared-host profile, any caller that could reach the gateway could inject one arbitrary generic channel message into runtime history/realtime state. After that first message, all generic inbound channel messages could dedupe against the same empty idempotency key, creating a persistent generic-inbound denial of service.

Affected surface: gateway integrations/channels, Chat/Cowork runtime history, Mission Control channel setup truth.

Historical evidence:

- `config/goatcitadel.json:12` sets `assistant.auth.mode` to `none`.
- `apps/gateway/src/plugins/auth.ts:113` returns early for auth-none and marks the actor as `auth:none`.
- The retired generic route classified a channel-level inbound path as `webhook`.
- `apps/gateway/src/routes/route-access.ts:100` does not enforce a pre-handler for `webhook`.
- The retired generic route registered generic inbound channel handling outside a connection identity.
- `apps/gateway/src/routes/integration-webhook-schemas.ts:13` accepts caller-supplied `account`, `actorId`, `role`, and `content`.
- `apps/gateway/src/plugins/idempotency.ts:30` skips webhook/inbound paths before assigning an idempotency header value.
- `apps/gateway/src/plugins/idempotency.ts:27` initializes `request.idempotencyKey` to the empty string.
- `packages/gateway-core/src/event-ingest.ts:31` stores the supplied idempotency key in the inbound index.
- `packages/gateway-core/src/event-ingest.ts:60` dedupes future inbound events by endpoint plus idempotency key.

Current source of truth: generic channel ingress now routes through `POST /api/v1/integrations/connections/:connectionId/:channel/inbound`, so reviews should verify connection identity, route-specific verification, and non-empty idempotency there rather than looking for the retired channel-level route.

Validation status: historical finding kept for provenance; current docs and route references use the connection-scoped route.

Fix plan:

1. Remove the generic inbound route, or gate it behind a configured channel connection identity and HMAC/shared-secret verification.
2. Require a non-empty idempotency key for generic channel ingress, derived from `eventId`, connection id, channel, and external event id.
3. If `eventId` is absent, reject the request rather than using the decorated empty key.
4. Align auth-plugin bypass and route-access semantics so `webhook` never means unauthenticated unless a route-specific verifier has already run.
5. Add tests for auth-none and token modes, absent `eventId`, duplicate `eventId`, and spoofed channel identity.

### P1 - Task Artifact Verification Probes Untrusted Files and URLs Before Task Ownership Is Known

Impact: an operator-reachable request can trigger filesystem existence probes, arbitrary outbound `HEAD` requests, and `git cat-file` calls before the task id is even known to exist. In auth-none or shared-host deployments this becomes a local file existence oracle, SSRF-style probe primitive, and resource exhaustion vector.

Affected surface: gateway tasks/Kanban, Cowork task board, artifact verification, integrations that consume task status.

Evidence:

- `apps/gateway/src/routes/tasks.ts:194` accepts `file`, `url`, and `commit_sha` claims.
- `apps/gateway/src/routes/tasks.ts:200` allows an unbounded `claims` array.
- `apps/gateway/src/routes/tasks.ts:521` exposes `POST /api/v1/tasks/:taskId/verify-artifacts`.
- `apps/gateway/src/services/task-lifecycle-service.ts:237` enters `verifyTaskArtifacts`.
- `apps/gateway/src/services/task-lifecycle-service.ts:241` calls `verifyClaimedArtifacts` before `storage.tasks.get(taskId)` at line 242.
- `apps/gateway/src/services/task-artifact-verifier.ts:15` runs all probes through `Promise.all`.
- `apps/gateway/src/services/task-artifact-verifier.ts:32` dispatches raw claim values to probers.
- `apps/gateway/src/services/gateway-kanban-wiring.ts:9` calls `fs.stat` on raw file paths.
- `apps/gateway/src/services/gateway-kanban-wiring.ts:19` calls `fetch(url, { method: "HEAD" })`.
- `apps/gateway/src/services/gateway-kanban-wiring.ts:29` runs `git cat-file -e` without a timeout.

Source-of-truth conflict: the repo guidance says path jails, allowlists, and policy boundaries are non-overridable, but this route probes before any task/workspace check or URL/path policy.

Validation status: confirmed by static trace. Route tests should prove nonexistent-task probes do not fire after the fix.

Fix plan:

1. Load the task first and authorize expected workspace before any artifact probe.
2. Cap `claims` length and payload size.
3. Path-jail file claims to the task/project workspace or declared artifact roots.
4. Validate URL protocol and host through the existing network guard; block private, link-local, loopback, and metadata targets unless explicitly allowlisted.
5. Add `AbortController` timeouts for HTTP probes and non-blocking bounded-time git checks instead of `execFileSync`.
6. Use bounded concurrency.
7. Add regression tests for nonexistent task id, wrong workspace, outside-root file path, private URL, oversized batch, and timeout.

### Resolved - Code Mode Approval Recovery Preserves the Code Surface

Status update: current Code Mode approval recovery preserves `originSurface: "code"` and keeps the operator in Code context at the approval checkpoint.

Affected surface: Code, Ops approvals, approval recovery, Code Mode.

Evidence:

- `packages/contracts/src/approvals.ts:4` supports `ApprovalLinkage.originSurface`.
- `apps/gateway/src/services/capability-system-service.ts` now creates Code Mode approvals with `ApprovalLinkage.originSurface`.
- `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx` preserves `cowork` and `code` origins for live-lane recovery.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx` exposes Code Mode run detail, sandbox posture, source/input/wrapper/policy hashes, and artifact paths in Code.

Source-of-truth conflict: resolved. Code Mode remains a governed trusted-code surface, and approval recovery now carries the surface identity needed to return to Code.

Validation status: covered by focused gateway and Mission Control Next tests. Keep this section as historical review context, not an active bug.

Follow-up: keep Code Mode ledger fields in sync with the runtime contract whenever new hash-verified artifacts or hashes are added.

### P2 - Direct Task, Kanban, Deliverable, and Subagent Routes Bypass Workspace Scoping

Impact: list/create paths normalize workspace, but direct task item and task-child routes operate by `taskId` only. In any multi-workspace or shared gateway mode, a caller who knows a task id can read or mutate task state without the same workspace constraint used by list/create.

Affected surface: gateway tasks, Cowork task board, Kanban, subagent evidence, deliverables.

Evidence:

- `apps/gateway/src/services/task-lifecycle-service.ts:65` filters `listTasks` by normalized `workspaceId`.
- `apps/gateway/src/services/task-lifecycle-service.ts:81` reads a task by id only.
- `apps/gateway/src/services/task-lifecycle-service.ts:94` updates a task by id only.
- `apps/gateway/src/services/task-lifecycle-service.ts:109` mutates distress state by id only.
- `apps/gateway/src/services/task-lifecycle-service.ts:140` mutates retry budget by id only.
- `apps/gateway/src/services/task-lifecycle-service.ts:731` through `760` list and append activities, deliverables, and subagents by task id only.
- `apps/gateway/src/routes/tasks.ts:327`, `336`, `351`, `391`, `400`, `423`, `446`, `455`, `485`, `497`, `509`, and `521` expose direct item/child mutations without a workspace parameter or check.

Source-of-truth conflict: Mission Control treats projects/workspaces as a first-class organizational boundary, but task item routes do not enforce that boundary.

Validation status: confirmed by static trace. Needs route tests with two workspaces.

Fix plan:

1. Mirror orchestration's workspace-access pattern for tasks.
2. Require or derive expected workspace on item routes.
3. Check `task.workspaceId` before returning or mutating.
4. Return 404 or 403 consistently on mismatch.
5. Cover get, patch, delete, restore, deliverables, subagents, Kanban mutations, and artifact verification.

### Resolved - Code Mode Artifact Hashes Are Revalidated Before Execution

Status update: current execution recomputes and compares source, wrapper manifest, policy snapshot, and input hashes before starting; mismatch fails closed instead of running a mutated artifact.

Affected surface: Code Mode, capability system, approval truth, audit evidence.

Evidence:

- `apps/gateway/src/services/capability-system-service.ts:383` computes `codeHash`, `wrapperManifestHash`, and `policySnapshotHash`.
- `apps/gateway/src/services/capability-system-service.ts:396` and `402` persist wrapper and policy artifacts.
- `apps/gateway/src/services/capability-system-service.ts:438` stores the hashes in the run record.
- `apps/gateway/src/services/capability-system-service.ts:523` loads the existing run before execution.
- `apps/gateway/src/services/capability-system-service.ts:527` marks the run `running`.
- `apps/gateway/src/services/capability-system-service.ts:540` reads the source artifact.
- `apps/gateway/src/services/capability-system-service.ts:541` reads and parses the wrapper manifest artifact.
- `apps/gateway/src/config.ts:856` defaults Code Mode artifacts under `./data/code-mode-artifacts`.
- `config/goatcitadel.json:280` includes `./data` in `sandbox.writeJailRoots`.

Historical finding: this was the original source-of-truth conflict. Current execution now revalidates the source,
wrapper manifest, policy snapshot, and input snapshot before marking a run `running`; keep this entry as context, not
as an open fix plan.

### Resolved - Code Mode Run Ledger Is Surfaced in Mission Control Next

Status update: the Code surface now renders governed run detail, including approval id, sandbox posture, hashes, policy snapshot, wrapper manifest, and hash-verified artifacts.

Affected surface: Code, Library/capability evidence, Ops approval recovery.

Evidence:

- `packages/mission-control-shared/src/api/capabilities.ts:80` exposes `fetchCodeModeRuns`.
- `packages/mission-control-shared/src/api/capabilities.ts:84` exposes `fetchCodeModeRun`.
- `packages/mission-control-shared/src/api/capabilities.ts:88` exposes `createCodeModeRun`.
- `packages/contracts/src/capabilities.ts:140` defines the detailed `CodeModeRunRecord`.
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx:1740` creates Code Mode runs for helper snippets.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:1301` renders Code Mode run detail with approval status, sandbox posture, source/input/wrapper/policy hashes, artifacts, and output previews.
- `apps/mission-control-next/src/app/route-model.ts:85` describes Code as including "runs, and code-mode control."

Source-of-truth conflict: resolved. The route model, gateway contract, and visible Code UI now agree that governed Code Mode run truth is inspectable from Code.

Validation status: covered by the current threaded workflow panel tests and surface regression lanes; keep the ledger fields synced with the runtime contract.

Follow-up: keep tests rendering approval id, sandbox required/available/fail-closed reason, hashes, artifact links, and timestamps whenever the run record contract changes.

### P2 - Responses Stream Failures Lose Provider Error Truth

Impact: runtime and UI failure explanations collapse upstream Responses failures into a generic message. Operators lose provider error code/message/status, making model-access, quota, invalid-request, or provider outage diagnosis harder.

Affected surface: gateway provider runtime, Chat/Cowork/Code trace explanations, Ops diagnostics.

Evidence:

- `apps/gateway/src/services/llm-service.ts:1065` throws `responses stream failed` for streamed Responses failures.
- `apps/gateway/src/services/llm-service.ts:2267` throws the same generic message while collecting Responses stream completion.

Source-of-truth conflict: the product promises operator-visible runtime truth, but provider error details are discarded at the adapter boundary.

Validation status: confirmed by static trace.

Fix plan:

1. Parse `event.response?.error`, `event.error`, response id/status, and any provider error code.
2. Throw an error with a concise upstream summary and preserve structured detail in `cause`.
3. Store the provider failure code/message in turn trace failure metadata.
4. Add tests for `response.failed` events with provider code/message.

### P2 - Per-Turn Trace Does Not Explain Cost, Tokens, or Provider Latency

Impact: Mission Control can show aggregate cost posture, but an operator inspecting a specific run trace cannot see per-turn token/cost/latency evidence. This weakens provider/runtime truth at the exact point where the operator asks "what did this run use and why?"

Affected surface: Chat, Cowork, Code trace cards, Ops costs.

Evidence:

- `apps/gateway/src/services/chat-turn-stream-service.ts:1475` ingests `assistantUsage`.
- `packages/gateway-core/src/event-ingest.ts:55` persists token input/output to transcript events.
- `packages/gateway-core/src/event-ingest.ts:99` applies usage to session/cost accounting.
- `packages/contracts/src/chat.ts:1035` defines `ChatTurnTraceRecord`.
- `packages/contracts/src/chat.ts:1062` includes routing fields but no usage/cost/latency block.
- `packages/mission-control-shared/src/components/ChatTraceCard.tsx:89` renders status and runtime settings.
- `packages/mission-control-shared/src/components/ChatTraceCard.tsx:138` renders routing but no tokens, cost, or latency.

Source-of-truth conflict: usage exists in event/cost ledgers, but the trace surface does not carry or render it.

Validation status: confirmed by static trace.

Fix plan:

1. Add `usage` and `latencyMs` to `ChatTurnTraceRecord.completion` or a new `runtime` block.
2. Patch the trace when completion finishes.
3. Render input/output/cached tokens, cost, provider latency, and whether cost is provider-reported or estimated.
4. Add trace-card tests for present, absent, and estimated usage.

### P2 - Provider Detail Overclaims Model Truth

Impact: Settings can tell users model counts are "Known to the runtime" even when models were not probed, the probe failed, or the provider returned an empty model list.

Affected surface: Settings providers, provider/model explanation truth.

Evidence:

- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:2266` shows the provider probe state.
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:2271` renders "Provider models".
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:2274` only treats `fallback` as unverified.
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:2276` labels all other states "Known to the runtime."

Source-of-truth conflict: provider probes distinguish checked, fallback, error, and not-checked states, but the copy flattens most states into a stronger truth claim.

Validation status: confirmed by static trace.

Fix plan:

1. Branch provider model meta by `modelProbeState` and `modelProbeSource`.
2. Use copy such as "Live verified", "Suggested, not account-verified", "Not probed", "No verified model list", and "Probe failed".
3. Add snapshot/unit tests for each probe state.

### P2 - Approved Plugin Tool Overrides Can Bypass Normal Policy Invocation

Impact: if override registration is reachable through plugin installation/runtime paths, an approved or compromised plugin can replace a built-in tool implementation without the normal policy-engine invocation path for that call.

Affected surface: tool invocation, plugin/extensions, policy enforcement, approvals/path/network controls.

Evidence:

- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:218` validates the original tool name.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:230` evaluates deployment guards before hooks.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:239` runs `tool.call.before`.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:265` allows the hook patch to change `toolName` and `args`.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:273` resolves an active plugin override for the patched tool name.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts:292` calls the override handler directly instead of `policyEngine.invoke`.
- `apps/gateway/src/services/plugin-tool-override-service.ts:59` requires owner approval for override claims.
- `apps/gateway/src/services/plugin-tool-override-service.ts:130` resolves the active approved handler.

Source-of-truth conflict: deny-wins policy and path/network controls are supposed to remain authoritative, but override handlers do not go back through the same invocation policy path.

Validation status: validation-needed risk. Owner approval is a mitigating control, but policy re-evaluation after hook patches is missing.

Fix plan:

1. Re-run tool-name validation and deployment guards after hook patches.
2. Require override handlers to pass policy evaluation for the final tool/action.
3. For high-risk tool families, prohibit plugin overrides or require a narrower signed capability grant.
4. Add tests where a hook patches a safe tool into a dangerous tool and where an approved override attempts a denied filesystem/network action.

### P3 - Settings Shows Configured API Style Without Execution API Style

Impact: Settings can show the configured API style while the gateway will execute with a different resolved API style. This makes provider explanations less precise for OpenAI-compatible and Codex-style providers.

Affected surface: Settings providers, provider/runtime truth.

Evidence:

- `apps/gateway/src/services/llm-service.ts:1447` resolves execution API style separately from configured style.
- `apps/gateway/src/services/llm-service.ts:1452` uses OpenAI Responses only for preferred OpenAI models unless chat completions is explicitly configured.
- `apps/gateway/src/services/llm-service.ts:1463` maps non-Codex providers configured as Responses/Codex Responses back to chat completions.
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:188` offers `openai-codex-responses` in the global settings option list.
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:2240` displays only `selectedProvider.apiStyle`.

Source-of-truth conflict: the runtime knows configured vs resolved API style, but Settings shows only configured style.

Validation status: confirmed by static trace.

Fix plan:

1. Display "Configured API" and "Execution API" separately.
2. Surface `resolvedApiStyle` from provider list/detail responses if it is not already present.
3. Gate or warn on `openai-codex-responses` unless `providerId === "openai-codex"`.
4. Add tests for OpenAI GPT-5, OpenAI non-preferred models, Codex OAuth, and OpenAI-compatible providers.

### P3 - Companion Sessions Are Authenticated But Cannot Read SSE Truth

Impact: approved companion clients can authenticate as `companion`, but `/api/v1/events/stream` rejects that actor source when auth is enabled. Remote companion operators may miss retained runtime/approval updates and drift toward stale state.

Affected surface: remote/companion clients, approval visibility, realtime truth.

Evidence:

- `apps/gateway/src/plugins/auth.ts:200` validates companion bearer tokens.
- `apps/gateway/src/routes/route-access.ts:51` marks `/api/v1/events/stream` as `sse-read`.
- `apps/gateway/src/routes/route-access.ts:128` handles `sse-read`.
- `apps/gateway/src/routes/route-access.ts:133` allows only `sse`, `token`, `basic`, and `loopback`.

Source-of-truth conflict: companion sessions are valid authenticated clients, but they cannot subscribe to the retained truth stream that approval surfaces depend on.

Validation status: static risk. Needs auth-enabled integration tests.

Fix plan:

1. Either allow approved companion sessions to mint scoped SSE bridge tokens, or add `companion` to `sse-read` only for active approved sessions.
2. Scope the stream to the companion device/session where possible.
3. Add tests for companion event-stream access and approval-state updates.

### P3 - Subagent Depth Budget Is Enforced After Creating Child Evidence

Impact: a max-depth-rejected delegation can still leave a child chat session and task-subagent record behind. That pollutes operator-visible lineage with work that should not have started.

Affected surface: Cowork orchestration, subagent policy, task lineage.

Evidence:

- `apps/gateway/src/services/chat-delegation-service.ts:296` creates the child chat session.
- `apps/gateway/src/services/chat-delegation-service.ts:337` registers the task subagent.
- `apps/gateway/src/services/chat-delegation-service.ts:348` enforces max depth after those side effects.

Source-of-truth conflict: subagent policy should bound delegation before new child runtime state exists.

Validation status: confirmed by static trace.

Fix plan:

1. Compute child depth and enforce max depth before `createChatSession`, grant inheritance, prefs updates, and `registerTaskSubagent`.
2. Keep later budget handling only for execution-time failures.
3. Add a regression that max-depth rejection creates no child session or subagent record.

### P3 - Child Timeout Does Not Observe or Contain Non-Cooperative Child Work

Impact: timeout marks the parent step failed/blocked and aborts a signal, but if provider/tool code ignores abort, the child promise can continue after the parent has moved on.

Affected surface: Cowork orchestration, subagent policy, durable work truth.

Evidence:

- `apps/gateway/src/services/subagent-budget-enforcer.ts:39` runs `runWithChildTimeout`.
- `apps/gateway/src/services/subagent-budget-enforcer.ts:58` returns `Promise.race([input.run(signal), timeoutPromise])`.
- `apps/gateway/src/services/chat-delegation-service.ts:356` passes that signal into `agentSendChatMessage`.

Source-of-truth conflict: operator-visible state can say the child timed out while work continues outside the recorded lifecycle.

Validation status: confirmed static risk; runtime impact depends on non-cooperative child/provider paths.

Fix plan:

1. Hold the child promise.
2. Abort on timeout.
3. Attach a catch/finalizer to record late completion/late failure.
4. Optionally wait a bounded grace period before returning the timeout result.
5. Add a test with a child promise that ignores abort and resolves later.

## Missing or Partial Mission Control Surfacing

| Gateway capability | Current UI surface | Status | User impact | Proposed surface |
|---|---|---:|---|---|
| `/api/v1/code-mode/runs` and `/api/v1/code-mode/runs/:runId` | Code workbench helper run rows plus run detail | Covered | Operator can inspect Code Mode approval, sandbox posture, source/input/wrapper/policy hashes, and artifact truth from Code. | Keep ledger parity tests current. |
| Code Mode approval origin (`ApprovalLinkage.originSurface`) | Ops approvals "Open live session" | Covered | Code approvals recover into the Code surface when origin metadata is present. | Keep fallback-to-Chat behavior only for truly unknown/legacy approvals. |
| Per-turn usage/cost/latency | Chat trace card plus Ops aggregate costs | Partial | Operator can see aggregate cost, not why a specific turn cost what it did. | Add trace runtime/usage block and render it in `ChatTraceCard`. |
| Provider model probe truth | Settings provider detail | Misleading | "Known to the runtime" can appear for not-probed/error/empty states. | Branch copy by probe state/source. |
| Configured vs resolved API style | Settings provider detail | Partial | Settings can imply an API mode that execution will not use. | Show configured and execution API styles side by side. |
| Generic channel inbound trust | Settings channels and integration diagnostics | Partial | Generic route does not communicate or enforce channel identity/idempotency requirements. | Require configured connection/HMAC/idempotency and surface diagnostics per channel setup. |
| Companion realtime truth | Companion auth plus SSE stream | Partial | Approved companion clients may miss approval/runtime updates. | Scoped companion SSE bridge token or `sse-read` support for approved companion sessions. |

## Approval Visibility

| Surface | Current visibility | Status | Notes / fix |
|---|---|---:|---|
| Chat | Inline `ChatPendingApprovalPanel` renders approval summary, risk, technical details when present, and approve/deny controls. | Covered | Link to persisted approval uses legacy query shape, but MC Next's legacy adapter canonicalizes it on load. No blocker found. |
| Cowork | Cowork mission brief shows pending approval summary; run map/checkpoint panels expose blockers and next action; shared inline approval panel is used for blocked chat turns. | Covered | Orchestration approval-resume path looked sound in static review. |
| Code | Code workbench can create Code Mode helper runs; inline approval details include code hash/wrapper/capability data; run detail exposes sandbox posture, source/input/wrapper/policy hashes, artifacts, and output previews. | Covered | Keep copy truthful: this is trusted-code Code Mode with governed approval and hash-verified evidence, not hostile-code sandboxing. |
| Ops | Native Approvals route shows pending/history/recovery, risk counts, evidence, replay trail, durable status, trace linkage, approval effects, and resume controls. | Covered | Strongest approval surface; Code origin recovery is covered when approval linkage is present. |

## Surface Variation Notes

| Surface | Verified differentiation |
|---|---|
| Chat | Route model and threaded surface keep Chat as the low-friction conversational path with artifacts/attachments close by. |
| Cowork | `NextCoworkPanel` exposes mission brief, phase, active agents, blockers, approvals, evidence, run map, timeline, and agentic controls. |
| Code | Code workbench exposes project binding, worktree status, files, diffs, validation, snippets, patch apply/export/revert, generated artifacts, and agentic runtime visibility. |
| Ops | Runtime/approval routes are native pages, not raw JSON tables. Approvals are particularly strong with replay/recovery/runtime-linkage panels. |

## No Finding / Verified

- Orchestration approval resume: no confirmed bug found. The checked path records `paused_for_approval`, pauses the durable run, validates workspace/run/phase/gate state on approval, writes `resume_requested`, updates durable metadata, resumes the durable run, and re-enters durable execution.
- Generic approval resolution: expiry is rejected before resolution, resolution event/effects are queued transactionally, pending actions enqueue only on approve plus pending, and execution rechecks pending-action state before marking executed/failed.
- Provider routing truth: gateway records requested/effective/fallback routing, and `ChatTraceCard` renders requested/effective/fallback/API-style fields.
- Provider-specific webhooks: Slack, LINE, Telegram, WhatsApp, and Nextcloud Talk routes use connection-specific verification/idempotency patterns. The old generic channel-level inbound finding is resolved/superseded; current review should target `POST /api/v1/integrations/connections/:connectionId/:channel/inbound`.
- Workspace file routes/path jail: no broad traversal issue was confirmed in this pass.
- Code Mode sandbox truth: default config requires sandbox availability and fails closed when unavailable. This review does not claim hostile-code sandboxing is shipped.
- Mission Control Next canonical shell: inspected routes use `apps/mission-control-next`; legacy `apps/mission-control` was not treated as canonical.

## Implementation-Ready Fix Order

1. Fix Responses streaming tool-call indexing and add multi-tool stream regression.
2. Recheck the connection-scoped inbound channel route for verifier and idempotency regressions.
3. Reorder and harden task artifact verification: task/workspace first, path jail, network guard, bounded probes.
4. Persist Code Mode `originSurface: "code"` and add Ops live-lane regression. Done in the 2026-05-17 hardening pass.
5. Add workspace scoping to task item/Kanban/deliverable/subagent routes.
6. Revalidate Code Mode artifact hashes before execution and fail closed on mismatch. Done in the 2026-05-17 hardening pass.
7. Add Code Mode run list/detail UI to the Code surface. Done in the 2026-05-17 hardening pass.
8. Preserve Responses provider failure details in trace/failure metadata.
9. Add per-turn cost/token/latency trace fields and UI.
10. Correct provider probe/API-style copy in Settings.
11. Re-run policy/deployment checks after tool hook patches and before plugin override execution.
12. Add companion SSE bridge support or explicit scoped companion `sse-read`.
13. Move subagent max-depth enforcement before child side effects and add late-child timeout diagnostics.

## Validation

Status: complete for the requested static-review gate set.

Focused commands:

| Command | Result | Notes |
|---|---:|---|
| `pnpm --filter @goatcitadel/mission-control-next test` | Passed on rerun | Initial run failed in `ApprovalsRoutePage.test.tsx` with `TypeError: explainShellCommand is not a function`; rerun in the same workspace passed 46 files / 286 tests with no tracked generated-file diffs. Treat as a validation cache/generated-resolution warning, not a confirmed current-HEAD product bug. |
| `pnpm --filter @goatcitadel/threaded-surface-core test` | Passed | 47 files / 270 tests. |
| `pnpm --filter @goatcitadel/mission-control-shared test` | Passed | 91 files / 443 tests. |
| `pnpm --filter @goatcitadel/gateway typecheck` | Passed | `tsc -b tsconfig.json`. |
| Focused gateway Vitest | Passed | 14 files / 104 tests across approvals, orchestration lifecycle, chat messages, route access, tools invoke, capabilities, and integration webhooks. |

Named gates:

| Command | Result | Artifact |
|---|---:|---|
| `pnpm verify:surface:regression` | Passed | `artifacts/verification/2026-05-17T04-01-40-806Z-surface-regression-a0816a93` |
| `pnpm verify:runtime:truth` | Passed | `artifacts/verification/2026-05-17T04-02-57-679Z-runtime-truth-11bc884e` |
| `pnpm verify:durable:recovery` | Passed | `artifacts/verification/2026-05-17T04-03-20-342Z-durable-recovery-ab924bf4` |
| `pnpm verify:realtime:truth` | Passed | `artifacts/verification/2026-05-17T04-03-45-952Z-realtime-truth-c2a2b40f` |
| `pnpm verify:auth:matrix` | Passed | `artifacts/verification/2026-05-17T04-04-04-937Z-auth-matrix-a8aaa5ce` |
| `pnpm verify:catalog:parity` | Passed | `artifacts/verification/2026-05-17T04-04-27-662Z-catalog-parity-7aa08b54` |
| `pnpm verify:api:compat` | Passed | `artifacts/verification/2026-05-17T04-04-42-144Z-api-compat-731a0b72` |
| `pnpm verify:agentic:contracts` | Passed | `artifacts/verification/2026-05-17T04-04-58-296Z-agentic-contracts-a184cb0a` |
| `pnpm verify:code-mode:sandbox` | Passed | `artifacts/verification/2026-05-17T04-06-47-877Z-code-mode-sandbox-5dd5567f` |
| `pnpm verify:code:workbench-loop` | Passed | `artifacts/verification/2026-05-17T04-06-54-135Z-agentic-workbench-loop-e8eddcee` |
| `pnpm verify:fast` | Passed | `artifacts/verification/2026-05-17T04-07-10-662Z-fast-60b59233` |
| `pnpm docs:check` | Passed | Governance docs, button types, inline SQL allowlist, memory ownership, launcher UI target, Docker secret docs, and Docker secret tests passed. |
| `git diff --check` | Passed | No whitespace errors. |

Validation notes:

- No `@goatcitadel/extensions-sdk/dist/index.js` failure occurred, so no extension-sdk rebuild was needed.
- Mission Control Next tests still emit React test warnings about multiple renderers sharing a context provider and one missing list key warning in `ThreadedSurfacePage`; these warnings did not fail the suite but are worth cleaning up in a future UI-test hygiene pass.
