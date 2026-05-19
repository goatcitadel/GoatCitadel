# GoatCitadel Gateway Decomposition Review Prompt

You are performing a full gateway decomposition review and extraction planning pass for GoatCitadel.

This is not a generic code review.
This is not a broad repo audit.
This is a targeted architecture and refactor-planning exercise focused on the gateway/runtime layer.

Repo:

- `https://github.com/goatcitadel/GoatCitadel`
- Local checkout path, when available: `F:\code\personal-ai`. For external reviewers, use the cloned repo root instead.

Your mission is to determine how GoatCitadel's gateway should be decomposed into a cleaner, more modular, more testable, more observable architecture without breaking runtime behavior.

## Repo Reality Check

Ground yourself in the repo before writing anything. Treat the following as facts or active suspicions to confirm:

- `apps/gateway/src/services/gateway-service.ts` is still the dominant runtime owner/facade at roughly 13.4k lines.
- The Fastify route layer still overwhelmingly calls `fastify.gateway.*`, which means route splitting is not the same thing as ownership separation.
- Several extracted services still type themselves against `GatewayService`, so moved files are not proof of narrowed authority.
- The most credible seams that appear to be emerging in the code are chat-turn dispatch/runtime, durable runs, approval lifecycle, and memory lifecycle.
- Some extractions are weak or facade-only. For example, `apps/gateway/src/services/provider-runtime-service.ts` is not evidence of a real provider runtime boundary by itself.
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md` and `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md` are useful, but code wins if docs and implementation disagree.

Do not confuse:

- code organization problems
- ownership problems
- runtime/state problems
- observability problems

Those may overlap, but they are not the same issue.

## Review Mode

Review this like an adversarial staff engineer brought in to prepare a safe extraction plan before 1.0.

That means:

- do not praise size or complexity as sophistication
- do not suggest a rewrite unless absolutely necessary
- do not recommend splitting things just because they are large
- do not assume existing module boundaries are good
- do not assume existing naming reflects true responsibility
- do not confuse "moved code" with "improved architecture"
- do distinguish between:
  - orchestration
  - policy
  - execution
  - transport/API
  - state ownership
  - persistence
  - side effects
  - observability

Your job is to discover the real architectural seams.

## Repo File Targeting

You must explicitly inspect, compare, and cross-reference the following files and modules. Do not claim the review is complete if you skip these.

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

### Useful secondary files if the primary path points at them

- `apps/gateway/src/services/chat-turn-prep-service.ts`
- `apps/gateway/src/services/chat-turn-runtime.ts`
- `apps/gateway/src/services/orchestration-lifecycle-service.ts`
- `apps/gateway/src/routes/orchestration.ts`
- `apps/gateway/src/services/settings-auth-service.ts`
- `apps/gateway/src/services/durable-execution-service.ts`
- `apps/gateway/src/services/chat-agent-orchestrator.ts`
- `packages/contracts/src/runtime-lifecycle.ts`

## Dangerous False Decompositions

You must explicitly look for decompositions that appear clean but would make the architecture worse.

Treat the following as dangerous false decompositions unless the code strongly proves otherwise:

- splitting `gateway-service.ts` by route or filename while keeping `GatewayService` as the real owner
- extracting services that still depend on full `GatewayService` instead of narrowed host contracts
- treating facade wrappers as completed architecture
- splitting connector code per vendor before stabilizing a connector runtime contract
- extracting tool runtime before separating policy, execution, approval, and observability responsibilities
- breaking out memory admin/UI flows before canonical memory ownership is explicit
- moving event publishing code without deciding what is canonical history vs retained signal
- declaring `service-context` or "Phase 2 facade pattern" sufficient evidence that ownership is solved
- equating "uses storage repos" with "storage is the only real owner" when routes/services still reconstruct semantics above the repos

Your review must call these out by name where relevant, not just imply them.

## Delegation-First Refactor Lens

This repo is already mid-decomposition. The review should not recommend a big-bang rewrite. Assume the safest path is delegation-first extraction:

- keep behavior stable
- preserve public runtime APIs unless the review proves an API boundary is itself the problem
- narrow host contracts before moving more code
- prefer extracting one real ownership seam at a time
- favor "Gateway coordinates through explicit interfaces" over "Gateway still owns everything but in more files"
- prefer test-backed delegation refactors over folder-tree redesign theater

When proposing extraction seams, explicitly say whether the right next move is:

- keep in place for now
- narrow the host interface first
- extract behind delegation now
- extract later after state ownership is clarified

## Core Questions

Your review must answer all of the following from actual repo evidence.

### 1. Identify the true responsibilities of the gateway

Inspect the relevant gateway/runtime code and determine what responsibilities the gateway actually owns today.

Do not stop at file/module names.
Infer actual responsibilities from code behavior.

For each responsibility, determine whether it is acting as:

- coordinator
- owner
- executor
- adapter
- validator
- policy engine
- state machine
- side-effect dispatcher
- logging/trace wrapper
- fallback/error boundary

Call out cases where one part of the gateway is doing multiple of these at once.

### 2. Build a responsibility map

Produce a responsibility map of the gateway layer, including:

- inbound request handling
- routing decisions
- run/session lifecycle
- execution orchestration
- tool selection and tool execution
- approval state transitions
- memory retrieval/write triggers
- provider/model selection
- connector/integration dispatch
- error handling
- retry/fallback behavior
- persistence/state mutation
- trace/event/log emission
- user-facing response assembly

For each area, answer:

- what currently owns it
- whether ownership is correct
- whether it should remain centralized
- whether it should move into a dedicated service/module
- what hidden coupling exists

### 3. Find the real decomposition seams

Identify the best extraction seams.

Do not give superficial advice like "split by feature" unless that is actually correct.

You must identify where the code naturally wants to separate into modules such as:

- transport/API layer
- run orchestration
- execution engine
- tool runtime
- approval runtime
- state manager
- memory coordination
- connector dispatch
- provider/model routing
- observability/replay/eventing
- response shaping
- policy/guardrail enforcement

But only recommend these if justified by the code.

For each proposed seam:

- explain why it is a real seam
- explain what should move out
- explain what should stay in the gateway
- explain the interface/contract that should exist after extraction
- explain the likely risks of extracting it incorrectly

### 4. Distinguish coordination from ownership

For every major subsystem the gateway touches, determine:

- should the gateway coordinate it?
- should the gateway own it?
- should the gateway merely call it through an interface?

Examples of the kind of distinction you should make:

- gateway should coordinate approvals, but approval rules/state may belong elsewhere
- gateway should initiate tool execution, but tool runtime should likely own execution details
- gateway may receive requests, but should not necessarily own canonical run state
- gateway may emit traces, but should not be the observability system

Be explicit and opinionated.

### 5. Identify architectural smells

Specifically look for:

- god-object behavior
- hidden state ownership
- mixed transport/business logic
- duplicated decision logic
- switch/case sprawl
- branch-heavy orchestration
- mutation-happy flow
- unclear state transition boundaries
- side effects embedded in routing logic
- logging/observability mixed with control flow
- approval/tool/memory logic intertwined in the same path
- hard-to-test code paths
- pseudo-modularity where methods were moved but not actually decoupled

For each smell:

- explain why it is a problem
- explain what failure mode it creates
- explain whether it blocks 1.0 or is just cleanup debt

### 6. Design a safe decomposition target architecture

Propose a target architecture for the gateway/runtime layer.

This should include:

- major modules/services
- what each owns
- what each explicitly does not own
- key interfaces/contracts between them
- where canonical state should live
- where side effects should happen
- where approval transitions should happen
- where tool execution should happen
- where memory coordination should happen
- where observability/replay hooks should happen

Do not just provide a folder tree.
Provide an architecture that reflects real responsibilities.

### 7. Produce a safe extraction order

Create an extraction order that minimizes breakage and preserves behavior.

For each step:

- what to extract
- why this should happen in this order
- what dependencies need to be stabilized first
- what tests should exist before extraction
- what invariants must be preserved
- what could silently break

Prefer incremental delegation-based refactors over rewrite-style plans.

Call out:

- safest first moves
- dangerous extractions
- extractions that look tempting but should wait
- things that should remain centralized until later

### 8. Define required test coverage for decomposition

Before and during extraction, define what test coverage is required.

Include:

- route-level behavior tests
- integration tests
- approval-flow tests
- tool execution tests
- connector dispatch tests
- error/fallback tests
- state transition tests
- replay/observability tests if relevant

Do not be vague.
Tie tests to decomposition risk.

For each high-risk extraction, specify:

- what behavior must remain unchanged
- what regression would be easy to miss
- what test should catch it

### 9. Identify what should not be decomposed yet

Not everything should be split right now.

Identify:

- logic that is ugly but still correctly centralized
- areas where decomposition would create premature abstraction
- areas where behavior is still evolving too fast
- areas where the interface is not stable enough yet
- areas where first fixing ownership or state semantics matters more than file splitting

Be willing to say:

- "leave this ugly for now"
- "this should be clarified before extracted"
- "this is not a real module boundary yet"

### 10. Connect the findings to 1.0 risk

For each major problem or proposed extraction area, classify it as:

- blocks 1.0 reliability
- threatens maintainability post-1.0
- creates observability/debugging pain
- slows future feature work
- mostly cleanup / debt, not urgent

Then answer:

- what gateway issues are true 1.0 blockers?
- what can wait until after 1.0?
- what should be done immediately because more features will only make it worse?

## Additional Requirements

- Ground your review in the actual GoatCitadel repo, not generic architecture advice.
- Be direct and somewhat adversarial where needed.
- Prefer practical incremental refactoring over fantasy rewrites.
- Explicitly separate:
  - code organization problems
  - ownership problems
  - runtime/state problems
  - observability problems
- If the gateway is serving as a substitute for missing architecture elsewhere, say so.
- If the real problem is canonical state ownership, say so.
- If the real problem is unclear execution boundaries, say so.
- If decomposition alone will not solve the underlying issue, say so.
- If docs and code disagree, code wins. Call the disagreement out explicitly.
- Do not treat extracted files, comments about decomposition phases, or `ServiceContext` usage as evidence that the architecture is already clean.

## Output Format

Your output must be structured exactly like this:

1. Executive Summary
2. Gateway Responsibility Map
3. Ownership vs Coordination Analysis
4. Architectural Smells and Failure Modes
5. Real Decomposition Seams
6. Recommended Target Architecture
7. Safe Extraction Order
8. Required Test Coverage Before/During Extraction
9. What Should Not Be Decomposed Yet
10. 1.0 Risk Classification
11. Final Recommendation to the Founder

Within that output:

- keep the numbered section order exactly
- use subsections where useful
- in section 5 or section 9, explicitly call out dangerous false decompositions
- in section 7, make the plan delegation-first
- in section 7, name likely files/modules to touch first rather than keeping the plan purely conceptual

## Deliverable Goal

Produce a decomposition review that is good enough to drive:

- a stronger follow-up planning prompt
- an implementation plan
- a Codex execution pass
- a founder-level decision on what to extract now versus later

Depth matters more than brevity.
This should feel like a serious pre-refactor architecture review, not a lightweight summary.
