# GoatCitadel

> [!IMPORTANT]
> GoatCitadel is in public beta. The current repository ships a working Mission Control UI, gateway, installer path, screenshot pipeline, and verification commands, but the product is still evolving quickly.

Current release line: `0.6.0-beta.2`

GoatCitadel is a local-first AI command center for operating real assistant workflows instead of just chatting with a model. The current product combines a React/Vite browser UI, a Fastify gateway, shared orchestration/policy/memory packages, and optional local runtimes for voice and NPU-backed inference.

![GoatCitadel Mission Control - Live shell](docs/screenshots/mission-control/operate-chat-live.png)

## What exists today

The current browser product is **Mission Control**. Its top-level shell is built around three spaces:

| Space | What is in it now |
| --- | --- |
| **Operate** | `Chat`, `Cowork`, `Code`, `Tasks`, `Approvals` |
| **Observe** | `Activity`, `Sessions`, `Artifacts`, `Costs`, `System`, `Quality` |
| **Configure** | `Settings`, `Integrations`, `Tools`, `Agents` |

Those spaces are not README fiction; they are the current routed structure in `apps/mission-control/src/content/page-registry.ts`.

### Current surfaces inside Mission Control

- **Operate / Chat, Cowork, Code**: one conversation shell with mode-specific posture for lightweight chat, explicit collaboration, or coding-oriented work.
- **Operate / Tasks**: task queue and deliverables view.
- **Operate / Approvals**: review queue for risky or gated actions.
- **Observe / Activity**: live feed, scheduler, and improvement tabs.
- **Observe / Sessions**: recent runs and outcomes.
- **Observe / Artifacts**: memory and file browsing in one place.
- **Observe / Costs**: runtime and provider spend visibility.
- **Observe / System**: machine and runtime health.
- **Observe / Quality**: Prompt Lab and evaluation workflows.
- **Configure / Settings**: general, providers, access, budget, runtime, workspaces, add-ons, onboarding.
- **Configure / Integrations**: overview, channels, and MCP management.
- **Configure / Tools**: tool access and permissions.
- **Configure / Agents**: agent roster, Herd Live, Herd Lab, and Skills.

## Current functionality

- **One shell, three operator modes**: `Chat`, `Cowork`, and `Code` share the same conversation surface but use different posture and defaults.
- **Approval-driven operations**: risky actions can pause for device approval, remote approval actions, or review queue handling instead of executing silently.
- **Tasks, sessions, artifacts, and costs**: Mission Control is designed as an operations console, not a single-thread chat window.
- **Prompt Lab and quality workflows**: evaluate prompts, inspect regressions, and track quality signals from the `Observe / Quality` space.
- **Workspace-aware memory and file context**: browse memory and files from the same artifacts surface and apply workspace-scoped guidance.
- **Native-first provider routing**: configure OpenAI, Anthropic-style, OpenAI-compatible, local, and routed provider endpoints from runtime settings.
- **LLM cost estimation and repair tooling**: runtime usage can be priced in-app, and historical gaps can be repaired with `scripts/backfill-llm-costs.ts`.
- **Tool policy and zero-trust controls**: tool profiles, read scopes, path jails, outbound allowlists, approval gates, and policy-engine ingestion contracts are built into the platform.
- **Integrations and channels**: manage integrations, MCP servers, channel connectors, diagnostics, and message delivery tests from the Configure space.
- **Agent operations**: browse agent roster, herd views, live activity, and skill inventory from one place.
- **Optional local runtimes**: voice runtime support around `whisper.cpp` and an optional Python NPU sidecar live alongside the gateway.
- **Gateway API docs**: interactive API docs are served from `/api/v1/docs`.

## What you can do today

- Start Mission Control and use the access gate for token/basic auth, loopback bypass, and remembered device grants.
- Work in `Chat`, `Cowork`, or `Code` without leaving the shared shell.
- Review risky operations from `Operate / Approvals` and follow approval events surfaced in the UI.
- Monitor scheduler, improvement runs, sessions, artifacts, costs, system state, and prompt quality from the Observe space.
- Configure providers, runtime posture, budgets, workspaces, onboarding, integrations, channels, MCP, tools, and agents from the Configure space.
- Test model/provider wiring directly from settings before routing broader traffic through it.
- Run local screenshot capture, prompt-pack gates, verification lanes, and gateway smoke checks from repo scripts.

## Repository layout

This is a pnpm workspace monorepo.

### Apps

| Path | Purpose |
| --- | --- |
| [apps/gateway](apps/gateway) | Fastify gateway, API routes, auth, orchestration entrypoints, tooling, onboarding, admin, docs |
| [apps/mission-control](apps/mission-control) | React/Vite Mission Control UI |
| [apps/npu-sidecar](apps/npu-sidecar) | Optional Python sidecar for local NPU-backed inference |

### Shared packages

| Path | Purpose |
| --- | --- |
| [packages/contracts](packages/contracts) | Shared schemas and API contracts |
| [packages/extensions-sdk](packages/extensions-sdk) | Author-facing SDK helpers for add-on and integration-plugin manifests |
| [packages/gateway-core](packages/gateway-core) | Gateway support utilities |
| [packages/memory-core](packages/memory-core) | Memory and context primitives |
| [packages/mesh-core](packages/mesh-core) | Mesh coordination support |
| [packages/orchestration](packages/orchestration) | Agent/workflow orchestration logic |
| [packages/policy-engine](packages/policy-engine) | Tool policy, screenshot capture, and policy-related runtime logic |
| [packages/skills](packages/skills) | Skill metadata and loading support |
| [packages/storage](packages/storage) | SQLite-backed persistence and storage helpers |

## Install and run

The repository currently supports two real paths:

1. **Installer-first** for beta users.
2. **Manual clone / dev setup** for contributors.

### Prerequisites

- Git
- Node.js `22+`
- Corepack
- Optional: Python `3.10+` for `apps/npu-sidecar`

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
goatcitadel up
goatcitadel onboard
goatcitadel doctor --deep
```

Short alias:

```bash
goat up
goat onboard
goat doctor --deep
```

PowerShell note:

- use `goatcitadel` or `goat`
- do not use `gc` because PowerShell already reserves it for `Get-Content`

### Manual clone / contributor setup

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
```

Create a local env file if you want cloud providers configured from the shell:

```bash
cp .env.example .env
```

Windows:

```powershell
Copy-Item .env.example .env -Force
```

At minimum, set whichever provider keys you actually plan to use:

```env
OPENAI_API_KEY=
GLM_API_KEY=
MOONSHOT_API_KEY=
```

Start the app:

```bash
pnpm dev
```

Split terminals if you want the gateway and UI separately:

```bash
pnpm dev:gateway
pnpm dev:ui
```

Default local endpoints:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`
- Gateway API docs: `http://127.0.0.1:8787/api/v1/docs`

## Runtime and configuration notes

- Shipped config lives under [config](config).
- `.env.example` currently includes gateway host/port, provider keys, auth overrides, mesh toggles, and advanced voice runtime overrides.
- The gateway enforces explicit auth posture for non-loopback exposure; the repo does not currently ship a Docker or Compose deployment path.
- The default config catalog includes remote providers plus local/compatible endpoints such as Ollama, LM Studio, LocalAI, and the optional NPU sidecar.
- Mission Control settings expose provider API styles, active model selection, auth storage mode, allowlist presets, and device access grant management.
- Integrations currently cover overview, channel operations, and MCP administration in one routed surface.

## Architecture overview

GoatCitadel currently resolves into these major layers:

| Layer | Where it lives | What it does |
| --- | --- | --- |
| UI | [apps/mission-control](apps/mission-control) | Mission Control shell, routing, pages, page tabs, visual operator workflows |
| Gateway | [apps/gateway](apps/gateway) | API routes, auth, sessions, approvals, tasks, memory, integrations, admin, docs |
| Contracts | [packages/contracts](packages/contracts) | Shared schemas, config validation, API payload contracts |
| Orchestration and policy | [packages/orchestration](packages/orchestration), [packages/policy-engine](packages/policy-engine) | Agent coordination, tool policy, runtime controls |
| Memory and storage | [packages/memory-core](packages/memory-core), [packages/storage](packages/storage) | Context composition, memory support, SQLite-backed persistence |
| Optional local runtimes | [apps/npu-sidecar](apps/npu-sidecar), gateway voice runtime commands | Local NPU and voice support |

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

That route breadth is why the product should be described as a control plane, not just a chat UI.

## Screenshots

The screenshots below were refreshed for the current app state on **March 29, 2026**. The gallery mixes the tracked Mission Control capture set with a current shell screenshot from the latest UI pass.

```bash
pnpm screenshots:capture
```

They reflect the current `Operate / Observe / Configure` shell, not the older dashboard-era layout.

Full gallery: [docs/screenshots/mission-control](docs/screenshots/mission-control)

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

## Verification commands

Useful repo-level commands that exist today:

```bash
pnpm test
pnpm smoke
pnpm -r typecheck
pnpm -r build
pnpm doctor -- --deep
pnpm screenshots:capture
pnpm verify:fast
pnpm verify:deep:core
pnpm prompt:gates
pnpm docs:check
```

Package publication workflows that exist today:

- `contracts-v*` tags publish `@goatcitadel/contracts`
- `extensions-sdk-v*` tags publish `@goatcitadel/extensions-sdk`

For coding workflow expectations, see [docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md](docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md).

For install/setup details beyond this summary, see [docs/INSTALL_SETUP_TESTING.md](docs/INSTALL_SETUP_TESTING.md).
