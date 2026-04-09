# GoatCitadel

> [!IMPORTANT]
> GoatCitadel is in public beta. This repo ships a working Mission Control UI, a Fastify gateway, a shared runtime/tooling stack, and verification workflows. It is not feature-complete, and parity claims are tracked explicitly instead of being implied.

[![Beta Line](https://img.shields.io/badge/release-0.6.0--beta.2-1ec8a5?style=for-the-badge)](./CHANGELOG.md)
[![Mission Control](https://img.shields.io/badge/ui-Mission%20Control-0f172a?style=for-the-badge)](./apps/mission-control)
[![Gateway](https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge)](./apps/gateway)
[![Local First](https://img.shields.io/badge/posture-local--first-2dd4bf?style=for-the-badge)](./docs/INSTALL_SETUP_TESTING.md)
[![pnpm Workspace](https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge)](./package.json)

GoatCitadel is a local-first AI operations console for people who need more than a chat box and less than an unreadable agent control panel. It combines:

- a React/Vite operator UI called **Mission Control**
- a Fastify **gateway** for auth, orchestration, tools, memory, integrations, approvals, and durable workflows
- shared contracts, storage, policy, orchestration, and skills packages
- optional local runtimes for voice and NPU-backed inference

![GoatCitadel Mission Control - Live shell](docs/screenshots/mission-control/operate-chat-live.png)

## Why this repo exists

Most AI products force a tradeoff:

1. fast but shallow chat
2. powerful but chaotic agent platforms

GoatCitadel is trying to sit in the useful middle:

- conversational when you need speed
- explicit when you need trust
- agentic when the task actually deserves orchestration
- local-first where privacy, latency, or cost matter

## What ships today

### Mission Control spaces

The current browser product is Mission Control. Its live routed shell is organized into three spaces:

| Space | Current areas |
| --- | --- |
| **Operate** | `Chat`, `Cowork`, `Code`, `Tasks`, `Approvals` |
| **Observe** | `Activity`, `Sessions`, `Artifacts`, `Costs`, `System`, `Quality` |
| **Configure** | `Settings`, `Integrations`, `Tools`, `Agents` |

That structure is real, not aspirational. It is driven by the current page registry in [page-registry.ts](./apps/mission-control/src/content/page-registry.ts).

### Current product capabilities

| Area | What exists now |
| --- | --- |
| **Conversation surfaces** | Shared `Chat`, `Cowork`, and `Code` shell with different operating posture and runtime defaults |
| **Approvals and safety** | Approval queue, device-grant flows, remote approval actions, replayable audit, risky tool gating |
| **Tasks and observability** | Activity feed, sessions, artifacts, costs, system state, Prompt Lab and quality views |
| **Memory and context** | Workspace-aware context composition, memory browsing, write/forget/history flows, and memory-maintenance controls |
| **Providers and runtime** | Multi-provider routing, provider smoke tests, active-model switching, local-compatible runtime endpoints |
| **Tool policy** | Read scopes, path jails, outbound allowlists, approval gates, policy-engine enforcement |
| **Integrations and channels** | Integrations overview, channel management, MCP management, channel diagnostics and delivery tests |
| **Durable workflows** | Durable run lifecycle, retries, cancellation, wake/resume, workflow recovery handling |
| **Voice and local runtimes** | `whisper.cpp`-oriented voice runtime support and optional Python NPU sidecar |
| **Authoring surface** | Add-on / integration-plugin reference scaffolds plus a workspace-local extensions SDK package |

## What is new in the current beta line

### Memory maintenance

The repo now includes a first-class memory-maintenance lane:

- workspace policy, status, run history, provenance, and recommendations APIs
- dedicated maintenance commands in chat sessions
- durable-run backed maintenance execution
- Mission Control memory controls for policy editing, run-now, recommendation review, and provenance inspection
- SQLite-backed persistence for maintenance policy/state/runs/changes/recommendations

### Signed inbound channel runtime for WhatsApp and LINE

The gateway now supports signed inbound webhook ingress for:

- **WhatsApp Cloud API**
- **LINE Messaging API**

That includes:

- route-level signature verification
- webhook challenge handling for WhatsApp
- inbound normalization and idempotency keys
- middleware exemptions so signed webhook routes can reach their own verification logic
- guided setup coverage and capability reporting that stays truthful about parity state

### Parity reporting got sharper

The repo now exposes stronger parity truth instead of vague status:

- a live parity completion-program report
- proof artifact freshness and deployment-profile matching for browser, packaging, A2UI, voice, companion, and extensions lanes
- stronger follow-on parity guidance in System
- explicit unsafe-claim boundaries in docs and runtime reporting

### Extensions SDK release path is prepared

The workspace SDK package now has a one-command publication workflow once GitHub Packages auth exists:

- repo-level dry-run and publish wrappers
- package-level prepublish gate
- automatic prerelease tag derivation such as `beta`
- tarball cleanup so runtime output ships without compiled test noise

### Mission Control and gateway stabilization landed on main

The current `main` line also includes a large post-refactor stabilization pass:

- Mission Control browser and shell transport paths now converge on a shared transport core instead of carrying separate request, retry, and diagnostics behavior
- chat execution, approvals, dock state, and session controls were split into narrower typed hooks and panels so the operator shell stays reviewable without changing its surface model
- gateway webhook ingress now runs through a shared handler factory, and the recently extracted runtime services use narrower contracts instead of reaching through the full gateway service object
- targeted route, contract, chat, lint, and type validation was added so the risky seams from the decomposition work are protected by behavior-level checks

## Truth in advertising

> [!NOTE]
> GoatCitadel is intentionally tracking shipped capability separately from proof-complete parity.

Safe claims today:

- Mission Control is a real operator console, not a mock dashboard
- the gateway already exposes broad runtime, admin, integrations, memory, and workflow surfaces
- memory-maintenance plumbing now exists end to end in-repo
- WhatsApp and LINE now have signed inbound runtime paths in the gateway
- the extensions SDK can be dry-run published cleanly
- the current `main` line has completed a transport and runtime stabilization pass for Mission Control and gateway ingress without widening public route contracts

Not safe to over-claim yet:

- full parity across every tracked lane
- public release completeness for all planned channels
- mobile companion proof as complete from this repo alone
- published SDK breadth as complete before real package publication

Use these as the source of truth:

- [CHANGELOG.md](./CHANGELOG.md)
- parity status and completion documentation in [docs](./docs)
- follow-on parity tracking in [docs](./docs)

## Screenshots

The screenshots below reflect the current Mission Control shell rather than the older dashboard-era layout.

Full gallery: [docs/screenshots/mission-control](./docs/screenshots/mission-control)

### Current shell

| Live shell | Code surface |
| --- | --- |
| ![Mission Control live shell](docs/screenshots/mission-control/operate-chat-live.png) | ![Operate Code](docs/screenshots/mission-control/operate-code.png) |

### Operate

| Chat | Cowork |
| --- | --- |
| ![Operate Chat](docs/screenshots/mission-control/operate-chat.png) | ![Operate Cowork](docs/screenshots/mission-control/operate-cowork.png) |

| Tasks | Approvals |
| --- | --- |
| ![Operate Tasks](docs/screenshots/mission-control/operate-tasks.png) | ![Operate Approvals](docs/screenshots/mission-control/operate-approvals.png) |

### Observe

| Activity / Live feed | Quality / Prompt Lab |
| --- | --- |
| ![Observe Activity Live feed](docs/screenshots/mission-control/observe-activity-live-feed.png) | ![Observe Quality](docs/screenshots/mission-control/observe-quality.png) |

| Sessions | Costs |
| --- | --- |
| ![Observe Sessions](docs/screenshots/mission-control/observe-sessions.png) | ![Observe Costs](docs/screenshots/mission-control/observe-costs.png) |

| Artifacts / Memory | System |
| --- | --- |
| ![Observe Artifacts Memory](docs/screenshots/mission-control/observe-artifacts-memory.png) | ![Observe System](docs/screenshots/mission-control/observe-system.png) |

### Configure

| Settings / General | Integrations / Overview |
| --- | --- |
| ![Configure Settings General](docs/screenshots/mission-control/configure-settings-general.png) | ![Configure Integrations Overview](docs/screenshots/mission-control/configure-integrations-overview.png) |

| Integrations / MCP | Settings / Workspaces |
| --- | --- |
| ![Configure Integrations MCP](docs/screenshots/mission-control/configure-integrations-mcp.png) | ![Configure Settings Workspaces](docs/screenshots/mission-control/configure-settings-workspaces.png) |

| Agents / Herd Live | Agents / Skills |
| --- | --- |
| ![Configure Agents Herd Live](docs/screenshots/mission-control/configure-agents-herd-live.png) | ![Configure Agents Skills](docs/screenshots/mission-control/configure-agents-skills.png) |

## Repository layout

This is a pnpm workspace monorepo.

### Apps

| Path | Purpose |
| --- | --- |
| [apps/gateway](./apps/gateway) | Fastify gateway, auth, orchestration entrypoints, integrations, memory, approvals, docs, admin APIs |
| [apps/mission-control](./apps/mission-control) | React/Vite Mission Control UI |
| [apps/npu-sidecar](./apps/npu-sidecar) | Optional Python sidecar for local NPU-backed inference |

### Shared packages

| Path | Purpose |
| --- | --- |
| [packages/contracts](./packages/contracts) | Shared schemas and API contracts |
| [packages/extensions-sdk](./packages/extensions-sdk) | Author-facing SDK helpers for add-ons and integration plugins |
| [packages/gateway-core](./packages/gateway-core) | Gateway support utilities and channel capability logic |
| [packages/memory-core](./packages/memory-core) | Memory and context primitives |
| [packages/mesh-core](./packages/mesh-core) | Mesh coordination support |
| [packages/orchestration](./packages/orchestration) | Agent/workflow orchestration and turn-runtime interfaces |
| [packages/policy-engine](./packages/policy-engine) | Tool policy, screenshot capture, and runtime guardrails |
| [packages/skills](./packages/skills) | Skill metadata and loading support |
| [packages/storage](./packages/storage) | SQLite-backed persistence and storage helpers |

## Install and run

There are two supported paths:

1. installer-first for beta users
2. manual clone / contributor setup

### Prerequisites

- Git
- Node.js `22+`
- Corepack
- Optional: Python `3.10+` for [apps/npu-sidecar](./apps/npu-sidecar)

### Installer-first

Windows:

```powershell
iwr https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.sh -o install.sh
bash install.sh
```

After install:

```bash
goatcitadel verify install
goatcitadel up
goatcitadel onboard
goatcitadel doctor --deep
goatcitadel uninstall --force
```

Short alias:

```bash
goat verify install
goat up
goat onboard
goat doctor --deep
goat uninstall --force
```

PowerShell note:

- use `goatcitadel` or `goat`
- do not use `gc` because PowerShell already reserves it for `Get-Content`

### Manual contributor setup

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
```

`pnpm config:sync` materializes local `config/*.json` files from the tracked `config/*.example.json` templates and rebuilds `config/goatcitadel.json` for the clone.

Optional local env file:

```bash
cp .env.example .env
```

Windows:

```powershell
Copy-Item .env.example .env -Force
```

Common provider keys:

```env
OPENAI_API_KEY=
GLM_API_KEY=
MOONSHOT_API_KEY=
```

Start the app:

```bash
pnpm dev
```

Split UI and gateway if you prefer:

```bash
pnpm dev:gateway
pnpm dev:ui
```

Default endpoints:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`
- Gateway API docs: `http://127.0.0.1:8787/api/v1/docs`

## Runtime notes

- tracked config templates live under [config](./config) as `*.example.json`
- real local runtime config is materialized into `config/*.json` during install/setup and is kept out of Git
- `.env.example` includes gateway host/port, provider keys, auth overrides, mesh toggles, and advanced voice runtime overrides
- the gateway enforces explicit auth posture for non-loopback exposure
- the default config catalog includes remote providers plus local-compatible endpoints such as Ollama, LM Studio, LocalAI, and the optional NPU sidecar
- Mission Control settings expose provider API styles, active model selection, auth storage mode, allowlist presets, workspace controls, and device access grants

## Architecture overview

| Layer | Where it lives | What it does |
| --- | --- | --- |
| UI | [apps/mission-control](./apps/mission-control) | Mission Control shell, routing, pages, operator workflows |
| Gateway | [apps/gateway](./apps/gateway) | API routes, auth, sessions, approvals, tasks, memory, integrations, durable workflows, docs |
| Contracts | [packages/contracts](./packages/contracts) | Shared schemas, config validation, parity/report contracts, API payloads |
| Orchestration and policy | [packages/orchestration](./packages/orchestration), [packages/policy-engine](./packages/policy-engine) | Agent coordination, turn runtime, tool policy, runtime controls |
| Memory and storage | [packages/memory-core](./packages/memory-core), [packages/storage](./packages/storage) | Context composition, maintenance storage, and SQLite-backed persistence |
| Optional local runtimes | [apps/npu-sidecar](./apps/npu-sidecar) | Local NPU and voice-adjacent support |

### Gateway route coverage

The current gateway registers route groups for:

- auth
- chat
- tasks
- approvals
- sessions
- dashboard/system state
- memory/context
- files
- integrations
- MCP
- skills
- agents
- durable/daemon/admin utilities
- onboarding
- voice/media
- docs

That breadth is why this repo should be understood as a control plane, not just a chat frontend.

## Verification commands

Useful repo-level commands:

```bash
pnpm test
pnpm smoke
pnpm -r typecheck
pnpm -r build
pnpm doctor:deep
pnpm verify:install
pnpm screenshots:capture
pnpm verify:fast
pnpm verify:deep:core
pnpm prompt:gates
pnpm docs:check
```

SDK publication helpers:

```bash
pnpm release:extensions-sdk:dry-run
pnpm release:extensions-sdk
```

## Related docs

- [CHANGELOG.md](./CHANGELOG.md)
- [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md)
- [docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md](./docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md)
- [docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md)
- [docs/FOLLOW_ON_PARITY_REGISTER.md](./docs/FOLLOW_ON_PARITY_REGISTER.md)
- [docs](./docs)
