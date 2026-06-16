# GoatCitadel Product Gap Review - Codex

> **⚠️ SUPERSEDED (2026-05-31).** Top P0/P1 gaps named here shipped within ~24–48h of this review:
> Universal Run Detail + unified Trust & Policy surface (`50b4f1694`), Ops quality dashboard
> (`c6df40fbd`), Code Mode execution-backend registry (`267882b5c`), and semantic memory recall
> (wired into `candidate-ranker.ts`). Truth-reconciliation concerns verified already-truthful in
> code. Historical context, not a live blocker list. Current verdict:
> `~/.claude/plans/please-review-goatcitadel-for-golden-candy.md`.

Date: 2026-05-30  
Reviewer: Codex  
Mode: report-only review. No source changes, refactors, commits, or implementation work were performed.

## Review Basis

This review used three passes:

1. Internal GoatCitadel review: current repo docs, contracts, Mission Control Next route model, gateway routes/services, package contracts, and native route surfaces.
2. External comparison: current public docs and repositories for personal agents, coding agents, MCP, memory systems, browser/computer-use agents, workflow engines, sandboxes, and observability/eval tools.
3. Synthesis: product gaps, architectural opportunities, and a prioritized roadmap.

Key internal evidence reviewed:

- `README.md`
- `AGENTS.md`
- `package.json`
- `docs/1_0_CONTRACT.md`
- `docs/1_0_RELEASE_SURFACE_SCOPE.md`
- `docs/1_0_RELEASE_EVIDENCE.md`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/OPENCLAW_PARITY_STATUS.md`
- `docs/MCP_SKILLS_CURATION.md`
- `docs/SKILL_IMPORT_AND_TRUST_POLICY.md`
- `docs/ADDONS_TRUST_POLICY.md`
- `docs/CAPABILITY_SYSTEM_BACKLOG.md`
- `docs/DESKTOP_AUTOMATION_SAFETY.md`
- `docs/PLUGIN_SDK_CONTRACT.md`
- `apps/mission-control-next/src/app/route-model.ts`
- `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx`
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx`
- `apps/mission-control-next/src/features/native-routes/library/LibraryCapabilitiesSection.tsx`
- `apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.tsx`
- `apps/mission-control-next/src/features/native-routes/library/LibraryArtifactsSection.tsx`
- `apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx`
- `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`
- `apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx`
- `apps/gateway/src/app.ts`
- `apps/gateway/src/routes/capabilities.ts`
- `apps/gateway/src/routes/skills.ts`
- `apps/gateway/src/routes/tasks.ts`
- `apps/gateway/src/services/a2a-bridge-service.ts`
- `apps/gateway/src/services/memory-lifecycle-service.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/policy.ts`
- `packages/contracts/src/tool-grants.ts`
- `packages/extensions-sdk/src/integration-plugins.ts`
- `packages/policy-engine/src/approval-gate.ts`
- `packages/policy-engine/src/browser-tools.ts`
- `packages/orchestration/src/engine.ts`

External sources consulted included:

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [QwenPaw](https://github.com/agentscope-ai/QwenPaw)
- [Agent Zero docs](https://www.agent-zero.ai/p/docs/)
- [Goose docs](https://goose-docs.ai/)
- [OpenHands docs](https://docs.openhands.dev/openhands/usage/sandboxes/overview)
- [SWE-agent](https://github.com/SWE-agent/SWE-agent)
- [Aider](https://github.com/Aider-AI/aider)
- [Open SWE](https://github.com/langchain-ai/open-swe)
- [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview)
- [MCP latest specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools/resources/prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Letta docs](https://docs.letta.com/)
- [Honcho](https://github.com/plastic-labs/honcho)
- [Mem0](https://github.com/mem0ai/mem0)
- [Graphiti](https://github.com/getzep/graphiti)
- [Stagehand](https://www.browserbase.com/stagehand/)
- [Skyvern](https://www.skyvern.com/docs/developers/getting-started/introduction)
- [browser-use](https://github.com/browser-use/browser-use)
- [BrowserOS](https://github.com/browseros-ai/BrowserOS)
- [Agent S](https://github.com/simular-ai/Agent-S)
- [Bytebot](https://github.com/bytebot-ai/bytebot)
- [E2B](https://www.e2b.dev/docs)
- [Daytona](https://www.daytona.io/docs/)
- [Sandbox0](https://github.com/sandbox0-ai/sandbox0)
- [AIO Sandbox](https://sandbox.agent-infra.com/)
- [n8n AI docs](https://n8n.io/ai/)
- [Activepieces docs](https://www.activepieces.com/docs/overview/welcome)
- [Dify](https://dify.ai/)
- [Flowise docs](https://docs.flowiseai.com/)
- [Langfuse docs](https://langfuse.com/docs)
- [Arize Phoenix docs](https://arize.com/docs/phoenix/)
- [Opik docs](https://www.comet.com/docs/opik/)
- [Promptfoo docs](https://www.promptfoo.dev/docs/intro/)

## Executive Summary

GoatCitadel is not best understood as another personal assistant, coding agent, or workflow builder. Its most defensible product lane is a governed local-first AI operations console: a control plane where a human can supervise Chat, Cowork, Code, memory, skills, tools, providers, approvals, runtime health, and evidence.

The repo already has unusually strong bones for that lane. The current product truth says `apps/mission-control-next` is the canonical shell, the Fastify gateway owns runtime APIs and policy, durable execution owns shipped mission-session Chat/Cowork/Code flows, Code Mode is trusted-code rather than hostile-code sandboxing, and public claims must align with `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, and implementation. The release evidence is also unusually explicit: 39 visible Mission Control routes, 34 ship routes, 5 experimental routes, and named verification lanes for surface, visual, runtime, durable, catalog, governance, memory, realtime, desktop, and docs proof.

The gap is not that GoatCitadel lacks features. The gap is that it has so many foundations that the product risks feeling like a map of the backend instead of a crisp operator experience. The strongest 1.0 story should be: "Give GoatCitadel a serious AI task, watch exactly what it can do, approve the risky steps, inspect the evidence, and keep the useful memory without surrendering control."

Highest priority gaps:

1. A universal Run Detail / Trace Explorer that answers "what happened, why, with what tools, under which approvals, using which memory, at what cost, and what artifact resulted?"
2. A first-run path that produces one successful governed job quickly, not a tour of every subsystem.
3. A unified Capability Firewall across skills, MCP, tools, integrations, add-ons, browser automation, Code Mode, and external agents.
4. A pluggable execution substrate story for local process, Docker, remote sandbox, SSH, Daytona/E2B-like environments, and future Windows-native desktop boundaries.
5. A sharper integration strategy: orchestrate Aider/OpenHands/Goose/Open SWE/n8n/Stagehand/etc. where they are strong instead of cloning every layer.
6. Memory UX that explains why context was used, how it changed, what is stale, and how the operator can undo or correct it.
7. Observability and evals that graduate from release proof lanes into an operator-facing quality dashboard.

My strongest recommendation: stop competing feature-for-feature with OpenClaw, Hermes, QwenPaw, Agent Zero, Goose, n8n, or OpenHands. GoatCitadel should be the place where those kinds of capabilities become governable.

## What GoatCitadel Appears To Be

GoatCitadel appears to be a local-first, operator-supervised AI workspace with three primary work modes:

- Chat: fast conversation, drafting, lightweight help.
- Cowork: long-running agentic orchestration with checkpoints and approvals.
- Code: governed implementation, debugging, review, validation, and artifact evidence.

The broader shell includes Projects, Library, Ops, and Settings. The Library and Ops surfaces are not secondary decoration; they are central to the product thesis. They expose skills, memory, capabilities, artifacts, approvals, costs, runtime health, diagnostics, schedules, integrations, MCP, channels, and permission posture.

Evidence:

- `README.md` positions GoatCitadel as a hybrid local/cloud AI workspace with Mission Control, Fastify gateway, orchestration and policy packages, governed code execution, local-first memory/context, desktop packaging, and runtime evidence.
- `AGENTS.md` and `docs/1_0_CONTRACT.md` say `apps/mission-control-next` is canonical and the older compatibility shell is not the product center.
- `docs/1_0_RELEASE_SURFACE_SCOPE.md` freezes a 39-route visible release surface with route-level release status.
- `apps/mission-control-next/src/app/route-model.ts` encodes the route taxonomy, rail metadata, release status, release action, verification expectations, and notes.
- `apps/gateway/src/app.ts` registers broad runtime APIs for approvals, browser sessions, skills, tasks, capabilities, integrations, memory, secrets, MCP, workspaces, durable state, and policy.
- `packages/contracts/src/memory.ts`, `packages/contracts/src/mcp.ts`, `packages/contracts/src/policy.ts`, and `packages/contracts/src/tool-grants.ts` show that memory scope, MCP trust, permission profiles, filesystem modes, network policy, and tool grants are typed product concepts rather than copy-only docs.

The product thesis is stronger than the current positioning might make obvious. The real wedge is not "AI assistant that does things." OpenClaw, Hermes, QwenPaw, Agent Zero, Goose, BrowserOS, and similar projects already claim that. GoatCitadel's differentiated promise is "AI work you can govern, inspect, resume, constrain, and prove."

## Competitive Landscape

### Direct Local/Personal Agent Peers

OpenClaw is the most direct reference point. Its current README positions it as a personal AI assistant that runs on your devices, answers through many channels, uses a gateway as control plane, supports broad messaging surfaces, and emphasizes an always-on single-user assistant. It is product-forward and channel-forward.

Hermes Agent is memory/self-improvement-forward. Its README highlights a built-in learning loop, skill creation from experience, cross-session recall, Honcho memory, scheduled automations, subagents, and multiple terminal backends including local, Docker, SSH, Singularity, Modal, and Daytona.

QwenPaw is also personal-agent-forward, with local/cloud deployment, memory and personalization under user control, skills, scheduling, multi-agent collaboration, multiple chat apps, and explicit security mechanisms such as tool guards, file access guards, and skill security scanning.

Agent Zero is broad and end-user-friendly: Web UI, first-run onboarding, host terminal/files/browser connector, browser surface, Linux desktop canvas, plugins, skills, projects, MCP/A2A, subagents, and a memory dashboard.

Goose is local-agent and developer-workflow-forward. Current docs describe desktop, CLI, API, MCP extensions, recipes, MCP Apps, subagents, sandbox mode, and ACP support. It is very relevant because it turns MCP and recipes into a practical local workflow surface.

DeerFlow appears to be a multi-agent/deep-research/sandbox-oriented reference point, but I found stronger secondary sources than primary documentation during this review. Treat any DeerFlow-specific claims as lower confidence unless independently verified against `bytedance/deer-flow`.

CowAgent did not surface enough reliable current public information in the quick scan to support confident claims. If it is important to the roadmap, it deserves a separate source-confirmation pass.

### Coding Agent Peers

OpenHands is the clearest end-to-end open coding-agent platform comparator. Its docs describe sandbox providers for Docker, unsafe local process, and remote environments. That is a useful product pattern for GoatCitadel: make execution substrate a first-class operator choice.

SWE-agent is a benchmark and research-oriented issue-fixing agent with an execution backend story through SWE-ReX. The important lesson is not its UI; it is that coding agents need reproducible environments and trajectories.

Aider is a practical terminal pair programmer with strong git ergonomics, repo map context, broad model support, and a simple mental model. GoatCitadel should consider it a candidate delegated engine, not a UI competitor.

OpenCode and Open SWE matter because they represent the direction of coding agents as asynchronous, triggerable, repository-aware services. Open SWE in particular is interesting because it composes on LangGraph and external trigger surfaces instead of trying to make a giant desktop IDE.

### Orchestration Frameworks

LangGraph is the main architectural benchmark for durable, stateful agent execution with human-in-the-loop and persistence. Its docs explicitly foreground durable execution, streaming, human-in-the-loop, and stateful long-running agents. GoatCitadel already shares much of that philosophy, but with a more productized operator surface.

Agno, CrewAI, AG2, CAMEL/OWL, and OpenManus all compete on developer-facing agent/team/workflow primitives. GoatCitadel should not try to out-framework them. The opportunity is to expose governed runtime truth for workflows regardless of the underlying agent engine.

### MCP and Agent Interop

The latest MCP specification is important because it makes clear that MCP is not just "tools." It defines stdio and Streamable HTTP transports, authorization for HTTP-based transports, model-controlled tools, application-driven resources, and user-controlled prompts. It also warns about HTTP transport security, origin validation, localhost binding, authentication, and session handling.

GoatCitadel is wise to keep remote MCP transports blocked/experimental in 1.0. The opportunity is not to rush remote MCP; it is to build the best governed MCP client/proxy/admin surface.

A2A is visible in GoatCitadel only as preview/status-style infrastructure. `apps/gateway/src/services/a2a-bridge-service.ts` states that a replay-safe external side-effect runner is still needed before A2A is callable. That is the right posture.

### Browser and Computer-Use Agents

Stagehand is a good benchmark for browser automation primitives: act, extract, observe, and agent. Its positioning is developer-readable browser automation, not black-box control.

Skyvern and browser-use are closer to browser RPA. They show demand for natural-language browser work but also the risk of brittle selectors, hidden state, auth sessions, CAPTCHAs, and unclear side effects.

BrowserOS puts the agent inside the browser and is a strong user-experience comparator for local browser automation, MCP app integrations, local memory, scheduled tasks, and folder-scoped filesystem access.

Agent S and Bytebot represent full computer-use / GUI automation. They are powerful but raise a much higher trust bar. GoatCitadel's `docs/DESKTOP_AUTOMATION_SAFETY.md` is directionally correct: desktop automation needs visible session boundaries, foreground control, approval-gated side effects, and durable audit logs.

### Memory Systems

Letta is notable for agent memory as a git-backed filesystem/context repository in coding-agent workflows.

Honcho is notable for peer-centric, stateful, background-reasoned memory: peers, sessions, messages, representations, conclusions, and self-hosting.

Mem0 is the broad "universal memory layer" reference point.

Graphiti/Zep is the strongest graph-memory reference. Graphiti focuses on temporal context graphs, evolving facts, provenance, hybrid retrieval, and historical queries.

GoatCitadel already has scoped memory, lifecycle ownership, maintenance, provenance, QMD/context posture, and edit/forget controls. The gap is less data model than operator explanation: why was this memory selected, what changed, what is stale, and what would happen if the operator rejects it?

### Workflow Engines

n8n, Activepieces, Dify, and Flowise prove there is demand for visual workflow automation plus AI. n8n is especially important because it is a mature integration/workflow engine with human-in-the-loop and AI-agent support.

GoatCitadel should integrate with workflow engines rather than build a sprawling visual automation builder. Mission Control can author governed recipes, approval gates, and run traces; n8n/Activepieces can own commodity app-to-app plumbing.

### Sandboxes and Execution Substrates

E2B, Daytona, Sandbox0, AIO Sandbox, OpenHands sandboxes, and SWE-ReX show the direction: agents need named execution substrates with explicit isolation, persistence, files, network, process controls, browser/desktop options, and snapshots.

GoatCitadel currently has Docker as a supported boundary, Code Mode as trusted-code with approval and hash checks, and docs that avoid hostile-code sandbox claims. That honesty is a strength. The missing product layer is a substrate abstraction the operator can understand and select.

### Observability and Evals

Langfuse, Phoenix, Opik, and Promptfoo are table stakes references for tracing, prompt management, evaluations, red teaming, datasets, experiments, and LLM-as-judge workflows.

GoatCitadel has release proof lanes and runtime evidence, but that is mostly internal engineering proof. A 1.0+ product should expose quality signals to the operator: regressions, repeated failures, tool latency, cost anomalies, memory retrieval mistakes, approval churn, and "this run diverged from successful similar runs."

## Parity Matrix

| Capability | GoatCitadel Current Evidence | Peer Expectation | Gap | Priority |
|---|---|---|---|---|
| Canonical operator console | `apps/mission-control-next`, `route-model.ts`, `docs/1_0_RELEASE_SURFACE_SCOPE.md` | Goose desktop, Agent Zero Web UI, OpenClaw onboarding | Strong architecture, but route breadth risks cognitive overload | P0 |
| Local-first gateway/control plane | `README.md`, `apps/gateway/src/app.ts` | OpenClaw gateway, Hermes gateway, Goose local runtime | Strong; should be marketed as governed control plane, not generic backend | P0 |
| Chat/Cowork/Code modes | `docs/1_0_CONTRACT.md`, durable mission-session docs | OpenClaw all-channel assistant, OpenHands coding focus, LangGraph workflows | Strong conceptual split; needs one universal run trace across modes | P0 |
| Durable execution | `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/1_0_RELEASE_EVIDENCE.md`, gateway durable routes | LangGraph persistence/HITL, workflow engines | Strong for shipped mission sessions; external side effects still audit-only/non-resumable | P0 |
| Approvals | `ApprovalsRoutePage.tsx`, policy engine, contract docs | LangGraph HITL, n8n HITL, MCP safety expectations | Strong; needs less raw JSON and more action-oriented risk explanation | P0 |
| Capability catalogs | `LibraryCapabilitiesSection.tsx`, `apps/gateway/src/routes/capabilities.ts`, `docs/CAPABILITY_SYSTEM_BACKLOG.md` | Goose MCP extensions, MCP registries, QwenPaw skills | Strong inspectable/callable split; missing last-run evidence/caller history in Library UI | P0 |
| Skills lifecycle | `LibrarySkillsSection.tsx`, `docs/SKILL_IMPORT_AND_TRUST_POLICY.md`, `docs/MCP_SKILLS_CURATION.md` | Hermes skills, OpenClaw skills, Agent Zero skills | Strong trust posture; needs clearer skill eval score and activation diff as product UX | P1 |
| Add-ons/plugins | `docs/ADDONS_TRUST_POLICY.md`, `docs/PLUGIN_SDK_CONTRACT.md` | Goose extensions, Agent Zero plugins, OpenClaw marketplace | Correctly experimental; do not promote before permission manifests and rollback are first-class | P2 |
| MCP local stdio | `docs/1_0_RELEASE_EVIDENCE.md`, `SettingsNativePage.tsx`, `mcp-runtime.ts` | MCP clients with stdio and HTTP | Good honest 1.0 scope | P0 |
| Remote MCP | Blocked/experimental per release evidence | MCP Streamable HTTP + OAuth | Missing but should remain governed until origin/auth/audit/session handling are proven | P1 |
| A2A | Preview/status in `tasks.ts` and `a2a-bridge-service.ts` | Emerging agent interop | Not callable; needs replay-safe side-effect runner, auth, audit, and task lifecycle | P2 |
| Browser automation | `packages/policy-engine/src/browser-tools.ts`, desktop safety docs | Stagehand, Skyvern, browser-use, BrowserOS | Needs dedicated browser session viewer, replay, permission model, and failure taxonomy | P1 |
| Full desktop automation | Explicitly constrained in `docs/DESKTOP_AUTOMATION_SAFETY.md` | Agent S, Bytebot, CUA frameworks | Intentionally not shipped; keep it that way until visible foreground session and audit model exist | P2 |
| Coding agent execution | Code Mode trusted-code docs, Code route, artifacts | Aider, OpenHands, SWE-agent, Open SWE | Strong governance; weaker substrate/delegation story than peers | P1 |
| Sandboxed execution | Docker boundary, Code Mode fail-closed truth | E2B, Daytona, Sandbox0, OpenHands providers | Missing named execution substrate abstraction | P1 |
| Memory lifecycle | `MemoryLifecycleService`, `MemoryRoutePage.tsx`, typed memory contracts | Letta, Honcho, Mem0, Graphiti/Zep | Strong governance; needs temporal conflict UX and "why this memory" explanations | P1 |
| Artifacts/provenance | `LibraryArtifactsSection.tsx`, release evidence | OpenHands trajectories, Langfuse traces | Good artifact metadata; needs unified trace-to-artifact narrative | P0 |
| Runtime/Ops | `RuntimeRoutePage.tsx`, release evidence, verification scripts | Langfuse/Phoenix/Opik, platform dashboards | Strong operational posture; needs product-facing eval/quality dashboards | P1 |
| Integrations/channels | Settings integrations/channels, channel docs | OpenClaw/QwenPaw many channels, n8n many connectors | Breadth exists; UX should emphasize verified working connectors over logos | P1 |
| Scheduling | Ops schedules, `no_agent` experimental note | OpenClaw/Hermes cron, n8n schedules | Good caution; need durable schedule trace, dry run, and human approval profiles | P1 |
| First-run onboarding | `/settings/onboarding`, provider setup, model probes | Agent Zero wizard, OpenClaw onboard, QwenPaw installers | Needs one outcome-based path, not subsystem checklist | P0 |
| Public claims discipline | `docs/1_0_CONTRACT.md`, claims-not-to-make lists | Many peers overclaim autonomy/sandboxing | Major strength; make it visible product trust, not just docs hygiene | P0 |

## Product Gaps

### P0 - Make the Operator Experience Coherent

1. Universal Run Detail / Trace Explorer.

   GoatCitadel has durable runs, approvals, artifacts, memory context, costs, runtime events, and diagnostics, but the product needs one canonical screen that reconstructs a run from start to finish. This should work across Chat, Cowork, and Code.

   Acceptance shape:
   - Timeline of user request, model/provider choice, memory/context used, tool/capability discovery, tool calls, approvals, retries, errors, artifacts, cost/latency, and final result.
   - Links to source session, durable run, approval record, artifact hash, memory items, capability entries, and logs.
   - Clear "replayable", "audit-only", "one-shot", "blocked", and "experimental" labels.

   Evidence: `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/1_0_RELEASE_EVIDENCE.md`, `ApprovalsRoutePage.tsx`, `RuntimeRoutePage.tsx`, `LibraryArtifactsSection.tsx`, `MemoryRoutePage.tsx`.

2. First-run "one successful governed job."

   The route surface is rich but too broad for a first impression. The first-run experience should get the operator to one useful task quickly: configure provider, run a simple Chat/Cowork/Code task, approve one safe action, inspect one artifact, and see one trace.

   Evidence: `/settings/onboarding` is a ship route in `docs/1_0_RELEASE_SURFACE_SCOPE.md`, but the surrounding surface includes 39 visible routes. That is a lot before the user has felt the product's promise.

3. Capability Firewall.

   Today capabilities, skills, MCP, tool grants, integrations, add-ons, Code Mode, browser tools, and local operator overrides are related but spread across Library, Settings, Ops, docs, and policy packages. Productize a unified "what can AI do right now?" screen.

   Acceptance shape:
   - One matrix for tool/skill/MCP/add-on/integration/code/browser capabilities.
   - Columns for inspectable, callable, activation state, trust tier, permission profile, workspace/session scope, last used, last failed, last approved, and last blocked.
   - Diffs before activation changes.

   Evidence: `LibraryCapabilitiesSection.tsx` explicitly says the capability catalog does not currently attach last-run evidence or recent caller history in that UI.

4. Human-readable approval risk.

   Approvals are structurally strong, but approvals should read like operational decisions, not only event payloads. The operator needs "why this is risky", "what will change", "what can be undone", "which policy allowed it to request approval", and "what happens if I reject."

   Evidence: `ApprovalsRoutePage.tsx` includes replay, recovery, risk strip, shell explanations, raw details, and history. That is a good base, but raw details should be secondary to a decision card.

5. Product story compression.

   GoatCitadel currently has the pieces of at least six products: personal assistant, coding agent, orchestration dashboard, workflow engine, skill marketplace, and ops console. The product story should be narrower:

   "A local-first operations console for governed AI work."

   Everything else should be subordinate to that.

### P1 - Fill the Platform Gaps That Peers Are Training Users To Expect

1. Pluggable execution substrate.

   OpenHands exposes Docker/process/remote sandboxes. Hermes advertises local, Docker, SSH, Singularity, Modal, and Daytona terminal backends. E2B, Daytona, Sandbox0, and AIO Sandbox are making execution substrate a product category.

   GoatCitadel should define an execution backend contract:
   - host-local trusted
   - Docker local
   - remote SSH
   - cloud sandbox
   - Windows-native desktop host
   - browser-only controlled session

   Each backend needs filesystem scope, network scope, secret injection, process limits, snapshot/replay posture, artifact capture, and trust label.

   Evidence: `README.md`, `docs/1_0_CONTRACT.md`, and `docs/1_0_RELEASE_EVIDENCE.md` are honest that Docker is not hostile-code sandboxing and Code Mode is trusted-code. That honesty should become a selectable product surface.

2. External coding-agent delegation.

   Do not rebuild Aider, OpenHands, SWE-agent, OpenCode, Goose, and Open SWE. Build governed adapters:
   - Create workspace/worktree.
   - Launch external agent in selected substrate.
   - Feed scoped task and repo context.
   - Capture trajectory, diff, tests, cost, and artifacts.
   - Require approval before applying changes or pushing.

   Evidence: Code Mode already has a governed trusted-code story. The missing layer is "delegate to engine X under GoatCitadel policy."

3. Browser automation product slice.

   GoatCitadel should ship browser automation before desktop automation. Browser work can be more easily scoped, recorded, replayed, and permissioned than full OS GUI control.

   Product shape:
   - Browser session list in Ops.
   - Per-session screenshot/replay/event stream.
   - Natural language plan plus deterministic fallback selectors where possible.
   - State-changing actions require approval.
   - Credentials and cookies are scoped and visible.
   - Results persist as artifacts.

   Evidence: `packages/policy-engine/src/browser-tools.ts` and `docs/DESKTOP_AUTOMATION_SAFETY.md`.

4. Remote MCP governed preview.

   MCP's latest spec supports stdio and Streamable HTTP, with HTTP auth built around OAuth-style discovery, protected resource metadata, session IDs, origin validation, and authentication. GoatCitadel should keep local stdio as the release path but add a clear remote-MCP preview with a hard trust envelope.

   Needed:
   - Origin validation.
   - Localhost binding checks for local HTTP MCP.
   - OAuth and token audience handling.
   - Tool/resource/prompt separation in UI.
   - Per-tool approval profile.
   - Tool-name collision and lookalike warnings.
   - Session lifecycle and revocation.

   Evidence: `docs/1_0_RELEASE_EVIDENCE.md` says generic non-stdio runtime invocation is still rejected and remote MCP creation is gated by experimental env flags.

5. Memory explanation and temporal conflict UX.

   GoatCitadel's memory foundations are strong: `MemoryLifecycleService`, scoped contracts, maintenance, provenance coverage, edit/forget, and QMD/context posture. But the product needs to answer:
   - Why was this memory included?
   - What source produced it?
   - Is it current?
   - What contradicts it?
   - Who can see it?
   - What happens if I edit or forget it?

   Graphiti/Zep's temporal graph posture is a strong reference; Honcho's peer/session/conclusion model is a strong reference; Letta's git-backed memory is a strong inspectability reference.

6. Observability and evals as product, not just proof.

   GoatCitadel already has named proof lanes. The product gap is continuous operator-facing quality:
   - Run success rate by mode.
   - Tool failure clusters.
   - Approval churn.
   - Memory retrieval mistakes.
   - Cost anomalies.
   - Latency hotspots.
   - Regression after prompt/skill/tool changes.
   - Golden tasks.
   - Red-team results for risky tools.

   Reference products: Langfuse, Phoenix, Opik, Promptfoo.

7. Integration/channel depth over logo breadth.

   OpenClaw and QwenPaw compete heavily on "every channel." GoatCitadel should not chase channel count until each visible channel has setup truth, auth diagnostics, inbound/outbound proof, delivery failure posture, and approval rendering.

   Evidence: `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`, Settings channel/integration routes, and release-scope guidance already require real operator paths or blocked/incomplete copy.

### P2 - Bigger Bets After the Control Plane Is Sharp

1. A2A interoperability.

   A2A should remain preview until it has task lifecycle, auth, audit, push/streaming, replay boundaries, and a side-effect runner.

   Evidence: `apps/gateway/src/services/a2a-bridge-service.ts` and `docs/review/agent-scalability-review-2026-05-30.md`.

2. Marketplace.

   Do not ship a marketplace before trust manifests, provenance, rollback, signing, permission diffing, vulnerability review, and user-visible runtime blast radius.

   Evidence: `docs/ADDONS_TRUST_POLICY.md`, `docs/SKILL_IMPORT_AND_TRUST_POLICY.md`, `docs/PLUGIN_SDK_CONTRACT.md`.

3. Mobile/voice.

   Voice and mobile are compelling, but they change the trust model. A mobile approval surface is more important than a mobile chat surface if GoatCitadel's differentiation is governed work.

4. Local inference/NPU.

   Keep optional local inference and NPU support honest. Do not make it a primary product promise until model quality, latency, fallback, privacy, and cost are provable.

## Mission Control Review

### Strengths

Mission Control Next has a serious, mature information architecture. `route-model.ts` centralizes the canonical shell areas and release metadata. `docs/1_0_RELEASE_SURFACE_SCOPE.md` and `docs/1_0_RELEASE_EVIDENCE.md` keep visible product claims tied to verification. That is rare and valuable.

The surface also has strong native-route depth:

- Library Capabilities distinguishes inspectable and callable truth.
- Library Skills exposes activation posture, lifecycle evidence, imports, sources, guarded auto behavior, and evaluations.
- Library Memory exposes item lifecycle, edit/forget, evidence/write gate, provenance, maintenance, QMD/context, and related routes.
- Library Artifacts exposes generated artifact records, validation status, content hash, source session/thread links, and provenance.
- Ops Approvals exposes pending/history/recovery, replay effects, durable status, decision context, and details.
- Ops Runtime exposes activity, sessions, schedules, automation drafts, release proof, review readiness, diagnostics, daemon/backup/spend posture, and needs-attention signals.
- Settings includes providers, access, permissions, runtime, workspaces, integrations, channels, MCP, tools, add-ons, and many live API-backed operations.

This is not a thin UI over a demo backend. It is a real operator shell.

### Weaknesses

The biggest Mission Control weakness is the same as its strength: it exposes too much product surface before the user's core mental model is secure.

Risks:

- The operator can see 39 routes before they understand the primary loop.
- Library/Ops/Settings have strong details but not enough "what should I do next?"
- Some UI areas still rely on raw JSON/detail payloads as drill-in proof. That is acceptable for experts but should not be the primary comprehension path.
- Experimental labels are honest, but the product needs a stronger visual hierarchy between "ready", "preview", "blocked", and "not configured."
- There is no single page that answers "what can GoatCitadel safely do right now?"
- There is no single page that answers "what happened in this run?"

### Mission Control Opportunities

1. Add a Command Center home.

   This should not be a marketing page. It should be an operational first screen:
   - current runtime health
   - provider status
   - active runs
   - pending approvals
   - recent artifacts
   - memory write queue
   - capability changes
   - top issues
   - one primary "start work" action

2. Add Universal Run Detail.

   This should become the most important page in the app after Chat/Cowork/Code. It is the product proof surface.

3. Add Capability Firewall.

   Library Capabilities and Settings Tools/Permissions should converge into an operator-facing safety surface.

4. Simplify onboarding around one outcome.

   "Start here" should produce an artifact and trace, not merely complete setup checks.

5. Make status labels more semantic.

   Use consistent visible labels:
   - Ready
   - Needs setup
   - Approval required
   - Blocked by policy
   - Experimental
   - Audit-only
   - Not replayable
   - Trusted-code only

6. Keep raw JSON as expert detail.

   Raw payloads are useful, but the default UI should provide interpreted summaries first.

## Architecture and Platform Opportunities

### Keep the Gateway as the Product Control Plane

The Fastify gateway owning orchestration, approvals, memory, integrations, audit, policy enforcement, durable execution, and runtime APIs is the correct architecture. Mission Control should remain an API client. Do not let UI convenience create a second backend.

Recommended next architecture moves:

- Define a `RunTrace` projection that composes durable run state, approvals, tool events, memory context, provider usage, artifacts, and errors.
- Define a `CapabilityFirewallSnapshot` that joins inspectable/callable catalogs, permission profiles, MCP servers, tool grants, skills, add-ons, browser tools, integrations, and last-use evidence.
- Define an `ExecutionBackend` abstraction with local, Docker, SSH, remote sandbox, and browser-only implementations.
- Define a `SideEffectRunner` for external writebacks that can make external actions resumable or explicitly non-resumable with audit-only evidence.
- Define `ExternalAgentAdapter` for Aider/OpenHands/Goose/Open SWE/SWE-agent style delegates.

### Treat MCP as Three Products, Not One

MCP should become:

1. MCP client: connect GoatCitadel to external tools/resources/prompts.
2. MCP proxy/firewall: mediate trust, scopes, approvals, tool discovery, and invocation.
3. MCP server: expose GoatCitadel resources, prompts, and governed actions outward.

Do not blur tools, resources, and prompts. MCP itself distinguishes model-controlled tools, application-driven resources, and user-controlled prompts. GoatCitadel should expose those differences visibly.

### Make Trust State a First-Class Data Model

Trust state should attach to:

- skills
- tools
- MCP servers
- MCP tools/resources/prompts
- add-ons
- provider credentials
- integrations
- channel connections
- browser sessions
- code runs
- external agent adapters
- execution backends
- memory sources

This is the platform moat. The repo already has many pieces. The next step is one shared product vocabulary and one shared UI.

### Use Existing Coding and Workflow Engines

GoatCitadel should not try to beat Aider at terminal pair programming, OpenHands at autonomous code-agent UI, LangGraph at developer orchestration primitives, n8n at workflow integration, Stagehand at browser primitives, or Graphiti at temporal graph research.

The winning architecture is adapters plus governance:

- Let best-of-breed engines do specialized work.
- Run them under GoatCitadel policy.
- Capture their traces and artifacts.
- Present them through Mission Control.

## Security, Permissions, and Trust as Product Features

GoatCitadel's security posture is more honest than many peers. Keep that.

Current strengths:

- Code Mode is described as trusted-code, approval-gated, with artifact hashes and execution-time hash checks. It does not claim hostile-code sandboxing.
- Docker is described as a useful boundary but not a substitute for auth, approvals, path jails, allowlists, or policy.
- Remote MCP transports are blocked/experimental for 1.0.
- Add-ons and third-party skills are treated as untrusted until reviewed.
- The policy engine has deny-wins concepts, approval gates, permission profiles, tool grants, filesystem modes, network allowlists, and audit events.
- Desktop automation is explicitly constrained before shipment.

Productize this as:

- "Why blocked?" explanations.
- "What changed?" permission diffs.
- "What can this access?" trust manifests.
- "What did it actually do?" audit timelines.
- "What can I undo?" rollback posture.
- "What requires approval?" policy previews.
- "What used a secret?" secret-use log.
- "What reached the network?" egress log.
- "What memory was injected?" memory context explanation.

Important warnings:

- Prompt text is not a security boundary.
- Tool allowlists inside the same process are not hostile-code containment.
- Memory is data at write time but executable context at read time.
- Remote MCP without origin/auth/session discipline is a local-network attack surface.
- Skill marketplaces are supply-chain systems, not content libraries.
- Browser automation is external side effects wearing a web UI.
- Desktop automation is host control and should be treated as a high-risk capability.

## Recommended Roadmap

### 0-30 Days: Make the Product Legible

1. Build Universal Run Detail / Trace Explorer.
2. Build Capability Firewall MVP with inspectable/callable, trust tier, permission profile, and last-use evidence.
3. Tighten onboarding to one successful governed job with artifact and trace.
4. Add capability last-run evidence and recent caller history to Library Capabilities.
5. Make approval cards explain risk, blast radius, reversibility, and policy reason.
6. Add a Command Center first screen for active runs, approvals, runtime, artifacts, and top issues.
7. Update public-facing copy to emphasize governed AI operations console.

### 30-60 Days: Integrate the Ecosystem

1. Add external coding-agent adapter spike for Aider or OpenHands.
2. Add browser automation run type with session capture and approval-gated state changes.
3. Add execution backend interface with local trusted and Docker implementations first.
4. Add memory "why used" and "what changed" explanations.
5. Add Langfuse/Phoenix/OpenTelemetry-style trace export or mapping.
6. Add golden-run/eval dashboard MVP for repeated tasks and surface regression.
7. Add remote MCP preview behind explicit trust profile and origin/auth checks.

### 60-120 Days: Turn Governance Into Platform

1. Add side-effect runner for replay-safe external actions.
2. Promote a narrow A2A preview only after auth, audit, and task lifecycle are real.
3. Add remote sandbox backends such as E2B/Daytona-style adapters if the abstraction holds.
4. Add workflow-engine bridge to n8n or Activepieces for commodity integrations.
5. Add signed trust manifests for skills/add-ons.
6. Add memory temporal conflict view inspired by Graphiti/Honcho patterns.
7. Add team/share features only if the single-operator trust model remains clear.

### Later

1. Marketplace after trust manifests and rollback are mature.
2. Mobile approval companion.
3. Voice control only with explicit confirmation UX for state changes.
4. Local inference as a provider option, not a headline promise.
5. Full desktop automation only with foreground session, scoped app model, durable audit, and emergency stop.

## Things Not To Copy

1. Do not copy OpenClaw-style channel maximalism before GoatCitadel has channel-level proof and operator diagnostics.
2. Do not copy "self-improving agent" claims unless every learned skill/memory has provenance, review, rollback, and evaluation.
3. Do not copy workflow-builder sprawl from n8n/Dify/Flowise. Integrate with workflow engines; keep GoatCitadel focused on governed agent work.
4. Do not copy browser-agent hype where success is a video of clicking. Ship browser automation as traceable, approved, replayable work.
5. Do not copy LangGraph as a visible product concept. Users should see work state, not graph theory.
6. Do not copy marketplace-first extension ecosystems. Marketplace without trust is a supply-chain liability.
7. Do not copy silent memory. Memory must be inspectable, scoped, reversible, and explainable.
8. Do not copy "AI employee" positioning. GoatCitadel is stronger as an operator console than as a simulated coworker with inflated autonomy.
9. Do not copy generic "supports MCP" marketing. Say exactly which transports, which primitives, which trust profile, and which actions are callable.
10. Do not copy hostile-code sandbox claims from weaker products. Keep the current honest posture until a real isolation boundary exists.

## Suggested First 10 Tickets

1. Universal Run Detail MVP
   - Files likely touched: gateway durable/session services, `apps/mission-control-next/src/features/native-routes/ops`, shared API client.
   - Acceptance: a run detail page shows timeline, approvals, memory context, tool calls, artifacts, provider/cost, replay posture, and errors for one Chat/Cowork/Code run.

2. Capability Firewall Snapshot API
   - Files likely touched: `apps/gateway/src/routes/capabilities.ts`, capability services, policy/tool-grant services.
   - Acceptance: one endpoint returns capability id, source, inspectable/callable, trust tier, permission profile, workspace scope, last used, last failed, last approved, and blocker reason.

3. Capability Last-Use UI
   - Files likely touched: `LibraryCapabilitiesSection.tsx`.
   - Acceptance: the existing "no last-run evidence/recent caller history" gap is closed for supported capabilities.

4. Approval Decision Card
   - Files likely touched: `ApprovalsRoutePage.tsx`, approval contracts/services.
   - Acceptance: each approval shows action, target, policy reason, blast radius, reversibility, required trust state, and reject consequence before raw details.

5. One-Job Onboarding Flow
   - Files likely touched: `SettingsNativePage.tsx`, onboarding APIs, route model copy.
   - Acceptance: first-run flow creates one traceable outcome and links to its artifact/run detail.

6. ExecutionBackend Contract RFC and Local/Docker Implementations
   - Files likely touched: docs plus gateway Code/Cowork execution boundaries.
   - Acceptance: local trusted and Docker backends expose consistent metadata: filesystem scope, network scope, secret policy, artifact capture, and trust label.

7. External Coding Agent Adapter Spike
   - Candidate: Aider first because it has simple git ergonomics and low UI overlap.
   - Acceptance: GoatCitadel launches an adapter in a scoped workspace, captures diff/test output/artifacts, and requires approval before applying.

8. Browser Automation Run MVP
   - Candidate model: Stagehand-style observe/act/extract primitives with approval before state changes.
   - Acceptance: one browser run records plan, screenshots/events, actions, result, and artifact.

9. Memory Why-Used Panel
   - Files likely touched: `MemoryRoutePage.tsx`, `MemoryLifecycleService`, context composition contracts.
   - Acceptance: a context pack explains selected memory items, scoring/provenance, stale/conflict indicators, and edit/forget links.

10. Evals and Trace Export MVP
   - Candidate integrations: OpenTelemetry/OpenInference shape, Langfuse/Phoenix-compatible export, or internal JSONL first.
   - Acceptance: a run can export spans for model calls, tool calls, approvals, memory retrieval, artifacts, cost, and errors; one golden task can be replayed/evaluated.

## Open Questions

1. Who is the first ideal user: solo developer, technical founder, local-first power user, security-conscious team, or AI operations hobbyist?
2. Should the default first-run task be Chat, Cowork, or Code?
3. Is GoatCitadel primarily a product people use directly, or a control plane that supervises other agents?
4. Which external coding agent should be the first delegated backend: Aider, OpenHands, Goose, OpenCode, or Open SWE?
5. What is the minimum acceptable sandbox boundary for untrusted code before public claims change?
6. Should GoatCitadel expose itself as an MCP server in 1.0.x, or wait until the MCP client/proxy story is stronger?
7. How much route surface should be visible before setup is complete?
8. Should memory default to conservative operator-confirmed writes, or allow agent-proposed pending memories by default?
9. What is the durable side-effect model for outbound integrations and channels?
10. Should workflow automation be native, delegated to n8n/Activepieces, or split by use case?
11. What is the product promise for Windows-native hosting beyond "supported path"?
12. Which proof lanes become product dashboards, not just CI gates?

## Contrarian Takes

1. GoatCitadel should stop trying to look like a complete personal assistant. That market is crowded and demo-driven. Its better lane is a serious operator console for people who care what the AI actually did.

2. The 39-route surface is a liability until the first-run loop is excellent. A powerful shell is good; a powerful shell before a clear first win feels like homework.

3. The capability system is more important than the chat UI. If GoatCitadel can make tools, skills, MCP, add-ons, and code execution governable, the chat surface can be ordinary and the product still wins.

4. Do not build a general visual workflow builder. It will dilute the product and still be worse than n8n/Activepieces. Build governed handoff, approval, trace, and artifact layers around workflow engines instead.

5. Browser automation should be treated as a security feature, not a wow feature. The key question is not "can the agent click?" It is "can the operator inspect and constrain every state-changing click?"

6. Memory is not a moat unless it is governable. Better recall without provenance, scope, expiry, conflict handling, and deletion is just a more confident way to be wrong.

7. GoatCitadel should not claim "autonomy" as a product goal. The better product word is "delegation." Delegation implies boundaries, accountability, and review.

8. External agent adapters are a better use of time than building another coding agent loop. Aider, OpenHands, Goose, Open SWE, and SWE-agent will move faster in their niches; GoatCitadel can make their work safer and more inspectable.

9. Remote MCP is not a checkbox. It is a remote tool execution surface with auth, origin, session, and prompt-injection risk. A boring, well-governed MCP proxy would be more valuable than a flashy remote transport toggle.

10. The release-proof discipline is a product differentiator. Most agent tools overclaim. GoatCitadel should make its honesty visible and attractive instead of hiding it in docs.

## Confidence Notes

High confidence:

- GoatCitadel's internal architecture and product truth are strongly represented in current repo docs and code.
- Mission Control Next is the canonical shell and route model.
- Gateway ownership, durable execution, capability catalogs, memory lifecycle, and Code Mode trust posture are real current implementation concepts.
- Remote MCP and A2A are intentionally constrained/experimental rather than fully shipped callable surfaces.
- GoatCitadel's highest-leverage product opportunity is governed runtime truth, not feature-count parity.

Medium confidence:

- External peer positioning, because public project docs and READMEs are current but change quickly.
- The recommendation to delegate coding-agent execution to external tools; this needs a spike to validate adapter complexity.
- The recommendation to integrate with workflow engines rather than build native workflow authoring; this depends on how much GoatCitadel wants to own non-agent automation.

Low confidence:

- CowAgent comparison. I did not find enough reliable current public information in this pass.
- DeerFlow details beyond broad multi-agent/deep-research/sandbox positioning. Verify against the current primary repo before acting on specific parity claims.
- Exact adoption/star/community numbers for external projects. I used them only as directional market signals, not as roadmap evidence.

Not validated in this report:

- I did not run the GoatCitadel app.
- I did not run tests or verification lanes.
- I did not inspect every route implementation in full.
- I did not perform a security audit.
- I did not compare live screenshots.
- I did not modify source files.

