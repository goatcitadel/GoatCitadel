# GoatCitadel Runtime Integration Checklist

Last updated: 2026-04-01

Purpose: turn the runtime integration memo into a tracked checklist against the current repo state.

Status policy for this checklist:

- `open`: the target shape from the memo is still mostly unimplemented
- `partial`: meaningful foundation exists, but the target shape is not complete

This checklist intentionally does not use `done` yet. A line only moves to `done` when the runtime memo target is actually satisfied, not when one adjacent subsystem improves.

## Runtime Core

- [ ] Unified headless runtime engine
  Status: `partial`
  Current state: a minimal shared `TurnRuntime` seam now exists and `GatewayService` routes the main send/stream/retry path through it, but the runtime is still backed by gateway-local orchestration and the package-level kernel is not yet the full canonical turn engine.
  Evidence:
  - `apps/gateway/src/services/gateway-service.ts`
  - `apps/gateway/src/services/chat-agent-orchestrator.ts`
  - `packages/orchestration/src/engine.ts`
  - `packages/orchestration/src/turn-runtime.ts`
  - `apps/gateway/src/services/chat-turn-runtime.ts`

- [ ] Surface unification through one turn runtime
  Status: `partial`
  Current state: the main turn path now crosses a shared `TurnRuntime` seam, which applies to mode-based interactive send flows, but the runtime is still not the sole execution path for every surface and background workflow.
  Evidence:
  - `packages/contracts/src/chat.ts`
  - `apps/gateway/src/orchestration/router.ts`
  - `packages/orchestration/src/turn-runtime.ts`
  - `apps/gateway/src/services/gateway-service.ts`

- [ ] Gateway façade only
  Status: `open`
  Current state: `GatewayService` still owns a large amount of execution logic instead of acting as a thin composition root over extracted runtimes.
  Evidence:
  - `apps/gateway/src/services/gateway-service.ts`

## Tooling

- [ ] Tool runtime plus streaming execution traits
  Status: `open`
  Current state: built-in tool policy and execution are strong, but the contract does not yet expose the execution-trait layer from the memo (`stateEffect`, `concurrencyClass`, `streamingMode`, `surfaceExposure`, `evidenceClass`).
  Evidence:
  - `packages/policy-engine/src/tool-registry.ts`
  - `packages/policy-engine/src/tool-executor.ts`

- [ ] Unified tool-pool assembly
  Status: `partial`
  Current state: built-in tools are normalized, MCP tools exist, and skills declare tools, but there is no single audited pool assembler that projects built-ins, MCP, and skills into one runtime-visible capability set.
  Evidence:
  - `packages/policy-engine/src/tool-registry.ts`
  - `apps/gateway/src/services/mcp-runtime.ts`
  - `packages/skills/src/loader.ts`
  - `apps/gateway/src/services/chat-agent-orchestrator.ts`

- [ ] Safe tool batching and concurrency planning
  Status: `open`
  Current state: the chat loop limits tool runs and retries, but there is no shared orchestration-level batch planner that can safely parallelize read-only work and serialize mutating work.
  Evidence:
  - `apps/gateway/src/services/chat-agent-orchestrator.ts`

## MCP

- [ ] MCP projection into the unified runtime tool pool
  Status: `partial`
  Current state: MCP discovery and invocation exist, but projected MCP tools are still adjacent to the main tool path instead of being fully unified under one runtime pool contract.
  Evidence:
  - `apps/gateway/src/services/mcp-runtime.ts`
  - `apps/gateway/src/services/gateway-service.ts`

- [ ] MCP transport abstraction beyond stdio
  Status: `open`
  Current state: runtime invocation explicitly supports `stdio`; non-stdio transports are not yet supported for runtime use.
  Evidence:
  - `apps/gateway/src/services/mcp-runtime.ts`

## Context And Memory

- [ ] Persisted context manifest for every turn
  Status: `partial`
  Current state: a persisted `ContextManifest` foundation now exists in storage and the main chat turn path records per-turn system messages plus memory context packs, but the manifest still does not cover every surface, skill activation, summary artifact, or all prompt-affecting mutations.
  Evidence:
  - `packages/storage/src/context-manifest-repo.ts`
  - `packages/storage/src/index.ts`
  - `packages/storage/src/sqlite.ts`
  - `apps/gateway/src/services/memory-context-service.ts`
  - `apps/gateway/src/services/gateway-service.ts`
  - `apps/gateway/src/routes/chat.ts`
  - `apps/gateway/src/services/chat-agent-orchestrator.ts`
  - `packages/contracts/src/memory.ts`
  - `packages/contracts/src/llm.ts`

- [ ] One inspectable context choke point
  Status: `partial`
  Current state: the main chat completion path now persists system-message and memory-context provenance by turn, but hooks, skills, summaries, and non-chat surfaces are not yet all surfaced through one canonical manifest.
  Evidence:
  - `apps/gateway/src/services/memory-context-service.ts`
  - `apps/gateway/src/services/hooks-service.ts`
  - `apps/gateway/src/routes/chat.ts`
  - `packages/storage/src/context-manifest-repo.ts`
  - `packages/skills/src/loader.ts`

- [ ] Mode-aware compaction and summary pipeline
  Status: `partial`
  Current state: conversation summaries and memory maintenance exist, but not yet as one operator-visible, mode-aware compaction pipeline across Chat, Cowork, and Code.
  Evidence:
  - `packages/contracts/src/chat.ts`
  - `apps/gateway/src/services/gateway-service.ts`
  - `apps/gateway/src/services/memory-maintenance-service.ts`

## Delegation, Tasks, And Durable Runs

- [ ] Unified delegated lifecycle graph
  Status: `open`
  Current state: delegated work, tasks, and durable runs all persist, but they still live in separate semantic lanes rather than one canonical run graph.
  Evidence:
  - `packages/storage/src/index.ts`
  - `apps/gateway/src/services/durable-run-service.ts`
  - `apps/gateway/src/services/gateway-service.ts`

- [ ] Chat delegation as a view over canonical durable runs
  Status: `open`
  Current state: `chatDelegationRuns` and `chatDelegationSteps` are still first-class storage concepts rather than lightweight views over a unified runtime graph.
  Evidence:
  - `packages/storage/src/index.ts`
  - `packages/contracts/src/chat.ts`

- [ ] Cowork driven from persisted run truth
  Status: `partial`
  Current state: Cowork already has orchestration concepts and durable state nearby, but it does not yet read from one unified operator-visible run graph.
  Evidence:
  - `packages/contracts/src/chat.ts`
  - `apps/gateway/src/services/gateway-service.ts`

## Skills

- [ ] Skills as first-class runtime manifests
  Status: `partial`
  Current state: skills load, resolve activation, and declare tools, but they are not yet persisted per turn as canonical runtime artifacts with activation reason and injected instruction provenance.
  Evidence:
  - `packages/skills/src/loader.ts`
  - `packages/contracts/src/skills.ts`
  - `apps/gateway/src/services/gateway-service.ts`

- [ ] Skill activation traceability in turn records
  Status: `open`
  Current state: skills influence runtime behavior, but turn traces do not yet expose a dedicated skill activation manifest.
  Evidence:
  - `packages/contracts/src/chat.ts`
  - `apps/gateway/src/services/gateway-service.ts`

## Providers

- [ ] Provider capability contract extracted into shared runtime policy
  Status: `partial`
  Current state: provider capability scoring exists and is better than ad hoc vendor branching, but it is still largely gateway-local orchestration logic rather than part of a unified runtime kernel contract.
  Evidence:
  - `apps/gateway/src/orchestration/providers/capability-registry.ts`
  - `apps/gateway/src/orchestration/router.ts`

- [ ] Capability-first provider routing across all surfaces
  Status: `open`
  Current state: orchestration provider routing exists for some delegated workflows, but not as the single routing mechanism for all turn execution paths.
  Evidence:
  - `apps/gateway/src/orchestration/router.ts`
  - `apps/gateway/src/services/chat-agent-orchestrator.ts`
  - `apps/gateway/src/services/gateway-service.ts`

## Storage And Operator Truth

- [ ] One persistence authority with no UI-side shadow state
  Status: `partial`
  Current state: this is one of the stronger parts of the repo already, but the runtime still has semantic duplication across run types, which keeps this out of `done`.
  Evidence:
  - `packages/storage/src/index.ts`

- [ ] Mission Control as a view over persisted runtime truth
  Status: `partial`
  Current state: Mission Control already uses one gateway API surface, but some operator views are still inferred from split runtime records instead of one unified runtime truth model.
  Evidence:
  - `apps/mission-control/src/pages`
  - `apps/gateway/src/services/gateway-service.ts`

## Recent Progress That Does Not Yet Close The Program

- [ ] Dream memory-maintenance model selection and status visibility
  Status: `partial`
  Current state: provider/model pinning, overnight-local presets, richer `/dream status`, and scheduler coverage are now materially better, but this only closes one subsystem gap inside the larger runtime program.
  Evidence:
  - `apps/gateway/src/services/memory-maintenance-service.ts`
  - `apps/gateway/src/services/gateway-service.ts`
  - `apps/mission-control/src/pages/MemoryPage.tsx`
  - `apps/gateway/src/services/memory-maintenance-service.test.ts`
  - `apps/gateway/src/services/gateway-service.dream-command.test.ts`

## Suggested Execution Order

- [ ] Phase 1: define runtime contracts
  Status: `partial`
  Target: add the minimal shared runtime contracts needed to extract one turn path cleanly.

- [ ] Phase 2: extract and adopt a minimal `TurnRuntime`
  Status: `partial`
  Target: route one standard chat send/retry path through the extracted runtime before touching Cowork and Code.

- [ ] Phase 3: add context manifest persistence
  Status: `partial`
  Target: make every injected context block inspectable before expanding MCP and delegation work.

- [ ] Phase 4: unify tool-pool assembly and MCP projection
  Status: `open`
  Target: make built-ins, MCP, and skill-declared capabilities flow through one audited runtime pool.

- [ ] Phase 5: unify delegated run graph
  Status: `open`
  Target: collapse `chatDelegationRuns`, task subagents, and durable runs into one operator-visible lifecycle graph.
