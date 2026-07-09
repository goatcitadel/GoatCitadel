# Orchestration Improvement Map

Last updated: 2026-06-17

This map turns the external orchestration-layer research into GoatCitadel-native work. The important conclusion is that GoatCitadel should strengthen its existing TypeScript/Gateway runtime instead of replacing it with a new orchestration framework.

## Current Owners

- Durable mission-session orchestration: `packages/orchestration` plus `apps/gateway/src/services/orchestration-lifecycle-service.ts`.
- Phase execution: `apps/gateway/src/services/orchestration-phase-execution-service.ts`.
- Per-turn Chat orchestration, including agentic and code-capability posture: `apps/gateway/src/orchestration`.
- Runtime truth and evidence: orchestration runs, checkpoints, durable runs, durable timeline events, realtime events, Prompt Lab, and LLM runtime measurements.
- Operator surface: `apps/mission-control-next`, with Gateway as the API owner.

## Research Finding To Repo Mapping

| Research recommendation | GoatCitadel-native direction |
| --- | --- |
| Durable workflow runtime | Preserve Gateway-owned durable runs and improve typed evidence around each lifecycle decision. |
| Model gateway/router | Reuse provider capability scoring and LLM runtime measurements before introducing any external router dependency. |
| Prompt/version registry | Extract orchestration prompts into typed renderers, record stable prompt ids, versions, and hashes, and keep rendered text behavior unchanged first. |
| Policy engine | Normalize existing hooks, approval gates, permission profiles, and tool policy into a visible policy ladder. |
| Observability spine | Build a read-only orchestration decision trace from checkpoints and events before adding new storage or UI claims. |
| Evaluation/benchmark loop | Use Prompt Lab, fake-provider tests, and existing verification lanes for orchestration quality, routing, recovery, cost, and latency. |

## Near-Term PR Sequence

1. Characterization coverage and this map.
2. Add a typed orchestration decision trace spine using existing events/checkpoints.
3. Version phase and per-turn orchestration prompts with prompt ids and hashes.
4. Add report-only model selection evidence from current capability scores and runtime measurements.
5. Normalize policy gate evidence across pre-input, pre-phase, pre-tool, post-tool, and pre-output moments.
6. Add lightweight orchestration performance and reliability gates.
7. Expose the read-only trace in Mission Control.

## Guardrails

- Keep changes TypeScript-native.
- Do not add Temporal, LangGraph, LiteLLM, OPA, OpenTelemetry, or a Python runtime as a first-pass dependency.
- Do not change public route behavior, CLI behavior, storage durability, or generated outputs without an isolated PR.
- Preserve Code Mode trust language: governed trusted-code surface, not hostile-code sandboxing.
- Keep SQLite durability defaults unchanged.
- Prefer additive evidence and read models over hidden behavior changes.

## Characterization Coverage Added First

The first implementation PR locks in behavior that later PRs will depend on:

- route decisions match generated Cowork step plans and provider selections;
- staged per-turn orchestration waits for all parallel handoffs before synthesis;
- durable orchestration records checkpoints and run events in lifecycle order;
- phase prompts include bounded run/phase/spec metadata while nested orchestration remains disabled.
