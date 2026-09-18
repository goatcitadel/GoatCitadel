# GoatCitadel improvement implementation plan

## Summary

Deliver the improvements in this order: **first-task usability → reusable skills → working capability packs → primary channels → native Windows workers**, with maintainability and outcome measurement supporting each milestone.

Build on the existing Gateway, Change Plans, capability lifecycle, and durable execution. Integrate the work into the [Master Completion Program](../MASTER_COMPLETION_PROGRAM.md), separating daily-usability delivery from milestones that require remote-worker completion.

The chosen scope is Windows-to-Windows native execution, conversational Telegram/Discord/Slack, and outbound-only Signal. This plan involved inspection only; the working tree remains clean.

## Implementation sequence

### 1. Establish the baseline and reduce maintenance pressure

Reconcile the existing completion ledger against current implementation before adding work. Preserve historical receipts and distinguish implemented foundations from completed user journeys.

Make three focused extractions alongside the features that need them:

- Move provider readiness and verification out of `GatewayService` into a dedicated owner.
- Extract Chat’s tool-result projection and continuation serialization from the large agent runner.
- Extract pure retrieval-quality calculations from `MemoryLifecycleService`, retaining lifecycle ownership there.

Keep behavior unchanged during these extractions. Place new functionality in focused services with narrow dependencies, and retain the architecture-metrics baseline without increasing thresholds to accommodate new growth.

Operator clarification, September 16: review explicit allowances for new
plan-owned services while preserving every existing-owner limit. Record each
reviewed new owner, plan step, rationale, evidence and fixed dependency/callback
caps separately in `scripts/verification/baselines/architecture-new-service-allowances.json`.
This does not authorize baseline changes, blanket exemptions or automatic cap
increases. Unlisted owners and growth above reviewed caps remain regressions.

Additional operator clarification, September 16: allow reviewed dependency-access
caps of **4/4/1** for the pre-existing cross-plan owners
`governed-remediation-approval-authority.ts`, `memory-item-pagination-service.ts`,
and `personality-revisions.test-support.ts`, respectively. Record these as explicit
C0 gate-reconciliation scope exceptions in the same allowance document, each with
zero host callbacks. Every original baseline-owner limit remains unchanged; this
does not exempt other cross-plan owners or permit future growth above these caps.

### 2. Simplify onboarding through the first useful response

Use the existing guided setup and Change Plans to provide one continuous flow:

**Connect provider → confirm recommended model → enter Chat → complete first task.**

- Show one primary action per step. Put effort levels, trust settings, and operational defaults under Advanced.
- Preserve dedicated credential/OAuth handling and the existing provider/default-model confirmations.
- Recover pending setup plans after refresh, restart, or interrupted authentication.
- Separate “model configured” from “model successfully responded.” Current catalog verification must not count as inference proof.
- Use the first ordinary durable Chat turn as response verification, avoiding an extra paid probe.
- Complete the setup marker before entering Chat; record first-task success separately so onboarding cannot redirect the user away from the task.
- Offer starter prompts while allowing the user to type their own task. Show actionable recovery for expired credentials, unavailable models, and provider failures.

**Acceptance:** a fresh installation reaches a real response without requiring effort, policy, or workflow-builder decisions. Returning users retain normal Chat access.

### 3. Add explicit workflow-to-skill capture

Add **Save as skill** to completed Chat work, with a preview and an explicit choice to create a skill or revise a selected existing skill.

- Freeze authorized source-turn references and relevant verified results.
- Generate the draft through the ordinary governed model path, producing usage guidance, inputs, procedure, failure handling, output requirements, and verification steps.
- Preserve provenance: distinguish the operator’s request, source evidence, and generated instructions.
- Redact sensitive material and exclude incidental credentials, personal details, and temporary workspace paths.
- Stage an inactive candidate through the existing skill-mutation and capability lifecycle.
- Reuse existing evaluation, artifact review, approval, activation, revocation, and rollback.
- Invalidate prior approval when reviewed instructions or artifact hashes change.

Explicit capture may start from one successful workflow. Keep the existing three-session threshold for automatic correction-derived learning unchanged. Saving a skill does not create durable memory or make the skill callable.

**Acceptance:** an operator captures a workflow, reviews and activates the candidate, then successfully reuses it in a different session. Failed evaluation and revoked versions remain unavailable to runtime selection.

### 4. Turn capability packs into working installations

Extend pack staging with a durable execution coordinator that delegates each asset to its existing owner.

- Add versioned manifests with concrete asset references, pinned versions/hashes, dependencies, required configuration, and supported actions.
- Provide one review showing what will be installed, configured, activated, or already satisfied.
- Track each asset through setup, approval, application, verification, failure, and compensation.
- Delegate skills to capability lifecycle, MCP configuration to its owner, add-ons/plugins to their supported lifecycle, and presets to allowlisted runtime Change Plans.
- Treat immutable policy defaults as verified requirements; do not invent configuration switches for them.
- Resume interrupted operations idempotently. Report partial installation explicitly.
- Compensate only changes owned by the operation and still at the expected revision; preserve pre-existing installations and later operator edits.

Make **Browser QA Operator** the first fully usable pack: an actual workflow skill, a verified browser connection, and an artifact-producing smoke task. Update the Playwright template to Microsoft’s maintained `@playwright/mcp` package and pin the reviewed package artifact. [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)

Preserve existing stage-only endpoint behavior. Unknown assets or unsupported activation paths remain visibly blocked.

**Acceptance:** a fresh workspace can review the pack, satisfy its approvals, run browser QA from Chat, and inspect the resulting evidence. Restart and partial-failure cases do not duplicate installation or activation.

### 5. Complete Telegram, Discord, and Slack journeys

Build on the existing channel adapters and shared durable runtime.

- Support request → progress → approval → resume → final result/artifact → scheduled delivery.
- Distinguish notification-only connections from verified conversational connections.
- Verify Telegram webhook protection, Discord gateway operation, and Slack signed inbound events.
- Bind approval actions to the authorized operator, workspace, assignment, and current approval revision.
- Handle duplicate deliveries, reconnects, expired credentials, attachment limits, and delayed approval actions.
- Keep channel context and memory scoped to their authorized workspace/session.
- Keep Signal outbound-only.

**Acceptance:** each primary channel completes the same representative workflow in a designated test destination, including restart during an approval wait and retry without duplicate external effects.

### 6. Complete native Windows remote execution

Treat this as a separate substantial milestone. Existing worker transport and recovery foundations need both production execution wiring and a native backend.

**Production runtime**

- Add a service loop that polls assignments, claims work, renews leases, executes actual workloads, and emits real transcript events.
- Keep the fixed-transcript connected-worker harness as a protocol test fixture.
- Wire production scheduling, inference governance, approvals, budgets, model routing, artifact settlement, and effect settlement into the existing composition.
- Retain provider credentials on the Gateway. Workers receive scoped assignment authority and approved inputs.
- Project canonical worker state into Chat and Ops, including unavailable, queued, running, awaiting approval, disconnected, recovering, and terminal states.
- Preserve uncertain-effect outcomes for reconciliation instead of automatically replaying them.

**Native execution backend**

- Target Windows 11 x64 first, using packaged Node workflows and explicitly supported PowerShell tool actions.
- Introduce a versioned `windows_native` backend alongside the existing container backend.
- Use a signed native helper, AppContainer access controls, and Job Objects. Create workloads suspended, establish and verify limits, assign the process to its job, then resume it. Check every launch and limit-setting result. [AppContainer guidance](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Use a preallocated per-cell virtual disk for bounded working storage, with separately accounted staging, artifacts, diagnostics, and retained evidence. [Windows virtual-disk allocation](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-create_virtual_disk_flag)
- Add native no-follow filesystem inspection and resource enforcement adapters. Reject assignments whose required limits cannot be enforced.
- Deny direct workload network access; route approved network/tool operations through the governed broker path.
- Keep privileged provisioning separate from workload requests, with authenticated caller checks and narrow operations.
- Preserve lease fencing, process-tree termination, artifact hashes, settlement idempotency, and quarantine when process liveness cannot be established.

**Acceptance:** two physical Windows machines complete a real task with Gateway inference, native execution, approval, artifact return, and recovery after worker termination. Installation, service restart, credential revocation, resource-limit failure, and uninstall receive packaged-process proof.

### 7. Measure task outcomes against OpenClaw and Hermes

Extend the existing verification system with a comparative outcome harness; retain current lifecycle and synthetic checks.

Use five shared scenarios:

1. Cited research.
2. Code repair with meaningful tests.
3. Document/artifact generation.
4. Workflow capture and subsequent reuse.
5. Scheduled delivery.

Report approval/restart recovery and remote execution separately when product capabilities or deployment requirements differ.

- Pin product revisions, fixtures, effective model, reasoning settings, available tools, and permission profiles.
- Run three trials per shared scenario and product.
- Score completion against predeclared rubrics; record time to useful output, total duration, tokens/cost, operator interventions, repeated corrections, and recovery behavior.
- Record unsupported scenarios and unavailable measurements explicitly.
- Require request and spending limits before live dispatch, counting retries and child calls.
- Produce machine-readable results and a concise comparison report tied to the tested revisions.

**Acceptance:** the report demonstrates where GoatCitadel improved and where gaps remain, without treating feature presence or mock success as outcome superiority.

## Interfaces and compatibility

| Area | Required change |
|---|---|
| Onboarding | Add first-successful-task evidence separately from setup completion; preserve existing setup-marker behavior. |
| Skill capture | Add a typed capture request containing authorized source references, optional operator guidance, and an optional existing-skill target. Return existing draft/candidate/artifact references. |
| Capability packs | Add versioned asset bindings and durable execution/status APIs. Keep staging endpoints non-executing. |
| Channels | Extend readiness and workflow projections through existing shared channel contracts. |
| Remote workers | Introduce versioned backend-discriminated profiles, platform identity, and capability negotiation. Preserve v1 container records and reject unsupported backend versions explicitly. |
| Benchmarking | Add a versioned scenario/result format with budgets, environment identity, rubric results, and evidence references. |

Persist new lifecycle records through repository owners. Add SQLite/PostgreSQL migrations and upgrade coverage wherever storage changes; never reinterpret previously hashed records.

## Verification and delivery gates

| Milestone | Required proof |
|---|---|
| Onboarding | Fresh and existing profiles; OAuth/API-key/local-provider paths; interrupted setup; first real response; expired-auth recovery. |
| Skill capture | Source authorization, redaction, inactive candidate, evaluation failure, approval invalidation, activation/reuse, revocation and rollback. |
| Packs | Fresh install, already-installed assets, missing configuration, denied approval, stale versions, restart, partial failure and safe compensation. |
| Channels | Real Telegram/Discord/Slack journeys, deduplication, approval authorization, restart/reconnect, scheduled delivery and attachment handling. |
| Native workers | Two-machine admission, real inference/execution, worker death, lease takeover, cancellation, resource limits, denied paths/network, artifact tampering and settlement recovery. |
| Maintainability | Existing owner tests plus async-boundary, memory-ownership and architecture-metrics checks. |

Run focused tests and touched-package typechecks within each slice. At milestone closure, run the relevant named lanes: self-configuration/usability, runtime truth, durable recovery, channel runtime/parity, remote workers, Windows provisioner, and desktop verification. Run consolidated browser/accessibility/visual proof after the UI changes settle.

Use the master program’s exact-revision release certification once all included milestone gates pass. Missing credentials, test destinations, or a second machine remain explicit external acceptance requirements.

## Rollout and defaults

- Deliver onboarding, skills, and packs before remote-worker completion.
- Release new activation and native-worker paths behind explicit operator opt-in until their acceptance gates pass.
- Default the first native-worker release to one active assignment per worker; retain container compatibility.
- Keep Chat as the single primary conversation surface and preserve existing policy, approval, memory, and artifact authority.
- Update public contracts and readiness labels with each delivered milestone.
- Keep live benchmarks manually invoked. This plan creates no scheduled automation and authorizes no publication or deployment.

---

Provenance: approved in task `01a083cf-17f2-73e0-9ba3-3a0047d9dbc6` on September 9, 2026, followed by the operator instruction "Implement the plan." This preserves the original plan; current execution status and the September 15 scope correction are in [the fixed checklist](COMPARISON_COMPLETION_CHECKLIST.md).
