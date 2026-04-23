# GoatCitadel Gateway Decomposition Implementation Planning Prompt

You are creating an implementation-ready, delegation-first extraction plan for GoatCitadel's gateway/runtime layer.

This is not the review pass.
Assume a serious gateway decomposition review already exists, and your job is to turn those findings into a safe execution plan that another engineer or agent can follow.

Repo:

- `https://github.com/goatcitadel/GoatCitadel`
- `F:\code\personal-ai`

Your mission is to produce the safest practical extraction plan that improves architectural clarity, correctness, observability, testability, and feature velocity without destabilizing runtime behavior.

## Starting Assumptions

Ground the plan in the current repo reality:

- `apps/gateway/src/services/gateway-service.ts` is still the dominant runtime owner/facade at roughly 13.4k lines.
- Fastify routes still largely call `fastify.gateway.*`, so route modularity is not the same thing as runtime ownership modularity.
- Several extracted services still type against `GatewayService`, so many "extractions" are body moves or facade moves, not finished boundaries.
- The strongest current candidate seams appear to be:
  - chat-turn dispatch/runtime
  - durable run lifecycle
  - approval lifecycle
  - memory lifecycle
- Some seams are weak or misleading:
  - `provider-runtime-service.ts` is facade-level only
  - any extraction that still requires full `GatewayService` is only partially done

Do not propose a rewrite unless the repo proves there is no safe incremental path.

## Repo File Targeting

You must base the plan on the following file groups.

### Core gateway root

- `apps/gateway/src/app.ts`
- `apps/gateway/src/plugins/storage.ts`
- `apps/gateway/src/services/service-context.ts`
- `apps/gateway/src/services/gateway/build-service-context.ts`
- `apps/gateway/src/services/gateway-service.ts`

### Chat/runtime path

- `apps/gateway/src/routes/chat.messages.ts`
- `apps/gateway/src/services/chat-turn-entry-service.ts`
- `apps/gateway/src/services/chat-turn-dispatch-service.ts`
- `apps/gateway/src/services/chat-turn-stream-service.ts`
- `apps/gateway/src/services/chat-turn-execution-registry.ts`

### Approval/durable path

- `apps/gateway/src/routes/approvals.ts`
- `apps/gateway/src/routes/durable.ts`
- `apps/gateway/src/services/approval-lifecycle-service.ts`
- `apps/gateway/src/services/approval-resolution-effects-service.ts`
- `apps/gateway/src/services/approval-wait-run-service.ts`
- `apps/gateway/src/services/durable-run-service.ts`

### Tool/provider/connector path

- `apps/gateway/src/routes/tools-invoke.ts`
- `apps/gateway/src/routes/comms.ts`
- `apps/gateway/src/routes/connectors.ts`
- `apps/gateway/src/services/mcp-runtime.ts`
- `apps/gateway/src/services/connector-registry.ts`
- `apps/gateway/src/services/llm-service.ts`
- `apps/gateway/src/services/provider-runtime-service.ts`

### Memory/state/observability path

- `apps/gateway/src/routes/memory.ts`
- `apps/gateway/src/services/memory-lifecycle-service.ts`
- `apps/gateway/src/services/memory-context-service.ts`
- `packages/storage/src/realtime-event-repo.ts`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`

### Secondary files to pull in when needed

- `apps/gateway/src/services/chat-turn-prep-service.ts`
- `apps/gateway/src/services/chat-turn-runtime.ts`
- `apps/gateway/src/services/orchestration-lifecycle-service.ts`
- `apps/gateway/src/routes/orchestration.ts`
- `apps/gateway/src/services/settings-auth-service.ts`
- `apps/gateway/src/services/durable-execution-service.ts`
- `packages/contracts/src/runtime-lifecycle.ts`

## Planning Mode

You are not implementing code in this response.
You are designing the safest execution program for later implementation.

That means:

- no fantasy folder-tree redesigns
- no "rewrite the gateway into microservices"
- no extraction steps that depend on unstable or undefined contracts
- no recommending that the team split code merely because a file is large

You must plan around preserving behavior.

## Delegation-First Extraction Principle

This repo is already being chipped away incrementally. Match that strategy.

Your plan must be delegation-first:

- prefer narrowing contracts before moving more code
- prefer introducing explicit host interfaces over passing full `GatewayService`
- prefer extracting one real ownership seam at a time
- prefer façade replacement with contract-backed delegation rather than wholesale relocation
- prefer stabilizing a canonical owner before creating more files around it

For each extraction step, say whether it is:

- contract narrowing only
- delegation extraction
- state ownership clarification
- route rewiring
- observability normalization
- test harness expansion

## Dangerous False Decompositions

You must explicitly protect the plan against the following failure modes:

- splitting `gateway-service.ts` by route or filename while keeping `GatewayService` as the real owner
- extracting services that still depend on full `GatewayService` instead of narrowed contracts
- treating façade wrappers as completed architecture
- splitting connector code per vendor before stabilizing a connector runtime contract
- extracting tool runtime before separating policy, execution, approval, and observability responsibilities
- breaking out memory admin/UI flows before canonical memory ownership is explicit
- moving event publishing code without deciding what is canonical history vs retained signal
- creating abstractions around unstable state ownership
- moving route handlers to new files without changing underlying control flow or testability

Call out which tempting extractions should wait and why.

## What the Plan Must Decide

Your implementation plan must be decision-complete on the following:

### 1. What gets extracted first

Name the first safe moves.
Explain why they are safe.
Name the exact files/modules most likely involved.

### 2. What interfaces/contracts must exist

For each proposed module boundary, define:

- who owns it
- who calls it
- what minimal host contract or dependency bag it should receive
- what it must not reach into directly anymore

### 3. Where canonical state belongs

Be explicit about:

- run ownership
- approval ownership
- tool execution state ownership
- memory lifecycle ownership
- retained stream vs durable history

If state semantics need to be clarified before extraction, say so and sequence that work first.

### 4. What remains in the gateway

Do not assume the end state is a "thin gateway" unless the repo justifies it.
For each stage, say what the gateway should still own or coordinate.

### 5. What test coverage must gate each step

For each extraction step, specify:

- the behavior that must remain unchanged
- the regression most likely to slip through
- the exact test class needed before and after extraction

### 6. What should not move yet

You must explicitly identify:

- ugly-but-correct centralization to keep for now
- evolving areas not ready for extraction
- fake seams that should not be treated as module boundaries yet

### 7. What the founder should do now vs later

Separate:

- extract now
- stabilize semantics first
- defer until post-1.0

## Required Output Format

Your output must use the following section order:

1. Executive Summary
2. Starting Conditions in the Repo
3. Extraction Principles and Non-Negotiable Invariants
4. Delegation-First Extraction Program
5. Target Module Contracts and Ownership Boundaries
6. Test and Verification Gates by Extraction Step
7. Dangerous False Decompositions to Avoid
8. What Should Not Be Extracted Yet
9. Founder Now vs Later Recommendation

## Section Requirements

### 1. Executive Summary

State:

- the overall safest extraction posture
- the 3-6 highest leverage moves
- the biggest risks if the team extracts in the wrong order

### 2. Starting Conditions in the Repo

Summarize the current runtime shape from actual code, including:

- where `GatewayService` still dominates
- where route-level dependency on `fastify.gateway.*` still matters
- which extractions are already credible
- which extractions are only partial

### 3. Extraction Principles and Non-Negotiable Invariants

State hard rules such as:

- preserve runtime behavior
- preserve durable-run and approval semantics
- preserve event/linkage observability
- avoid changing canonical state ownership accidentally
- do not widen use of full `GatewayService` while "extracting"

### 4. Delegation-First Extraction Program

This is the heart of the plan.

For each step include:

- step number and title
- goal
- why it belongs in this order
- exact likely files/modules
- dependency or contract stabilization required first
- what should move
- what should explicitly stay put
- what could silently break

This section must be concrete enough that an implementation agent can start work from it.

### 5. Target Module Contracts and Ownership Boundaries

For each major seam, define:

- the intended module/service
- whether gateway should coordinate, own, or call through an interface
- the minimal contract to inject
- what persistence/state it is allowed to mutate
- what observability hooks it should emit or call

### 6. Test and Verification Gates by Extraction Step

Tie tests directly to extraction risk.
Include:

- route-level behavior tests
- service/integration tests
- approval-flow regression tests
- durable wake/retry/resume tests
- tool execution and policy tests
- connector dispatch tests
- memory lifecycle tests
- realtime event/replay linkage tests where relevant

### 7. Dangerous False Decompositions to Avoid

Name the tempting splits that should not happen.
Explain why each one would worsen ownership, state clarity, or observability.

### 8. What Should Not Be Extracted Yet

Be willing to say:

- leave this ugly for now
- this needs semantic cleanup first
- this file is large but not the next seam
- this boundary is not real yet

### 9. Founder Now vs Later Recommendation

Produce a founder-facing summary:

- what to extract immediately
- what to stabilize first
- what can wait until after 1.0
- what would get more expensive if delayed

## Additional Requirements

- Ground every major planning decision in the current repo, not generic architecture advice.
- Be explicit about where the gateway should coordinate, own, or merely call through interfaces.
- If the real problem is canonical state ownership, say so.
- If the real problem is unclear execution boundaries, say so.
- If decomposition alone will not solve the issue, say so.
- If a proposed extraction depends on a doc-claimed authority model that code does not enforce yet, call that out as a prerequisite.
- Judge extraction readiness by dependency narrowing, state ownership, and testability, not by file count.

## Current Guardrails

Preserve these implementation guardrails while continuing gateway decomposition:

- provider mutation belongs in Settings via `patchSettings.llm.upsertProvider`; do not add new chat-command or gateway-only provider registration paths
- runtime lifecycle export is a read-only bundle built from current lifecycle truth; do not invent a second trajectory or replay authority to support export
- new runtime-facing route capabilities should prefer dedicated route services with narrow collaborators over widening `GatewayService`
- route rewiring only counts as progress when ownership actually moves behind a narrower contract or service-context-backed host
- trust and operator affordances should surface through existing Mission Control surfaces before any new control-plane pages are introduced

## Deliverable Goal

Produce an implementation-planning prompt that is good enough to drive:

- a Codex execution pass
- a human engineering breakdown
- a phased founder decision on what to extract now versus later
- a safe refactor sequence that preserves runtime behavior

This should read like a serious pre-implementation architecture plan, not a wishlist.
