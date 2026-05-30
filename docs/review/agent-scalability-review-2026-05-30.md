# Agent Scalability Review - 2026-05-30

## Sources

- OpenAI Agents SDK guide: https://developers.openai.com/api/docs/guides/agents
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- A2A project: https://github.com/a2aproject/A2A
- A2A specification: https://a2aproject.github.io/A2A/latest/specification/

## Review Result

| Track | Operator status | Implementation status | Current truth | Evidence |
|---|---:|---:|---|---|
| OpenAI Agents SDK | `blocked` when OpenAI-family provider paths are visible, otherwise `unavailable` | `partial` when provider primitives are visible | GoatCitadel has OpenAI-family provider support and Responses-style paths, but no `@openai/agents` dependency or gateway adapter. Do not claim SDK-backed agent runtime availability yet. | `apps/gateway/src/services/llm-service.ts`, `packages/contracts/src/provider-templates.ts`, `/api/v1/agentic/availability` scalability track |
| Claude Agent SDK | `blocked` when Claude/Anthropic provider paths are visible, otherwise `unavailable` | `partial` when provider primitives are visible | GoatCitadel has Anthropic Messages / Claude Code provider paths, but no `@anthropic-ai/claude-agent-sdk` dependency or SDK loop integration. Do not claim SDK sessions, hooks, subagents, or allowed-tool policy availability yet. | `apps/gateway/src/services/llm-provider-anthropic.ts`, `packages/contracts/src/provider-templates.ts`, `/api/v1/agentic/availability` scalability track |
| A2A protocol | `unavailable` | `missing` | No A2A protocol surface is implemented. A2A is not MCP and is not a provider template; it needs first-class Agent Card discovery, JSON-RPC task operations, streaming, push notifications, auth scoping, and audit. | Static scan found no A2A contracts/routes/handlers; `/api/v1/agentic/availability` now exposes the gap |

## What Is Now Implemented

- `packages/contracts/src/agentic-runtime.ts` defines `AgenticScalabilityTrackRecord` and capability families for `agent_sdk` and `agent_protocol`.
- `apps/gateway/src/services/agentic-capability-availability.ts` emits three scalability records in the gateway-owned availability response:
  - `openai_agents_sdk`
  - `claude_agent_sdk`
  - `a2a_protocol`
- `packages/mission-control-shared/src/components/AgenticRuntimeVisibilityPanel.tsx` renders the scalability tracks before harness/plugin/provider/channel posture.
- These tracks are also mirrored into `items` as `scalability:*` capability records so catalog consumers can reason over them alongside existing provider and runtime records.

## Claim Boundaries

Allowed now:

- GoatCitadel has OpenAI-family provider support and Responses-style provider paths.
- GoatCitadel has Anthropic Messages / Claude Code provider paths.
- GoatCitadel exposes SDK/protocol scalability availability as operator-visible runtime truth.

Not allowed yet:

- OpenAI Agents SDK is callable.
- Claude Agent SDK is callable.
- A2A interoperability is implemented or callable.
- Remote MCP transport invocation, hostile-code sandboxing, or autonomous high-risk activation is available because of these tracks.

## Scoped Additions Needed

OpenAI Agents SDK:

- Add a gateway-owned adapter around `@openai/agents` instead of replacing existing durable orchestration.
- Route SDK tools, handoffs, guardrails, human review, tracing, approvals, and eval proof through existing policy and durable evidence.
- Add focused adapter tests and eval-loop proof before changing the status to `callable`.

Claude Agent SDK:

- Add a gateway-owned adapter around `@anthropic-ai/claude-agent-sdk`.
- Map SDK sessions, permissions, hooks, MCP wiring, subagent lineage, and cost reporting into policy-governed runtime records.
- Treat `.claude/` configuration as workspace-scoped input with path-jail and approval boundaries.

A2A:

- Add contracts for Agent Cards, authenticated extended cards, messages, task/context IDs, artifacts, streaming events, push notifications, and auth metadata.
- Add gateway route/service layers for A2A server and client operations over JSON-RPC HTTP(S).
- Add SSRF-safe push webhook validation, streaming/cancellation tests, tenant/workspace scoping, and audit records.
- Add storage repositories only where durable replay or external task audit requires persisted state.

## Proof To Maintain

- Static proof: dependency inventory, route inventory, contract/type inventory, and docs claim audit.
- Runtime proof: `pnpm verify:agentic:governance`, `pnpm verify:agentic:proof`, `pnpm verify:durable:recovery`, `pnpm verify:runtime:truth`, `pnpm verify:catalog:parity`, `pnpm verify:api:compat`.
- UI proof when the Mission Control availability surface changes: `pnpm verify:surface:regression` plus practical browser or visual proof.
- Always include `git diff --check` before publishing the review slice.
