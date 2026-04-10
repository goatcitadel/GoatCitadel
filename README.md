# GoatCitadel

> Local-first AI operations console for chat, coding, orchestration, memory, tools, and approvals.

[![Release](https://img.shields.io/badge/release-0.9.0--beta.1-1ec8a5?style=for-the-badge)](./CHANGELOG.md)
[![UI](https://img.shields.io/badge/ui-Mission%20Control-0f172a?style=for-the-badge)](./apps/mission-control)
[![Runtime](https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge)](./apps/gateway)
[![Local First](https://img.shields.io/badge/posture-local--first-2dd4bf?style=for-the-badge)](./docs/INSTALL_SETUP_TESTING.md)
[![Monorepo](https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge)](./package.json)

GoatCitadel is a hybrid local/cloud AI workspace built for real operator workflows. It gives you a Mission Control UI, a Fastify gateway, shared orchestration and policy packages, and a local-first runtime model that stays explicit about tools, approvals, and system state.

![GoatCitadel Mission Control](docs/screenshots/mission-control/operate-chat-live.png)

## What it does

- Chat, Cowork, and Code surfaces with different operating posture
- Gateway-owned orchestration, approvals, memory, integrations, and audit trails
- Tool policy enforcement with path jails, allowlists, and approval gates
- Workspace-aware context and memory maintenance flows
- Multi-provider model routing with local-friendly runtime support
- Add-on and integration-plugin scaffolds for extending the system

## What's new on `main`

- **Capability system foundations**: tools, runtime skills, candidate bundles, proposals, and Code Mode runs now live on one GoatCitadel-native capability model with inspectable vs callable catalogs.
- **Governed Code Mode v1**: trusted, operator-approved code can run through a child-process harness with immutable snapshots, persisted artifacts, bounded IPC, and an explicit read-only wrapper allowlist.
- **Sharper Skills Hub and approvals**: Mission Control now surfaces lifecycle/trust metadata, candidate/proposal review queues, and a composer-adjacent approval footer with richer Code Mode inspection details.

## What ships in this repo

### Apps

- [apps/mission-control](./apps/mission-control): React/Vite operator console
- [apps/gateway](./apps/gateway): Fastify control plane and runtime APIs
- [apps/npu-sidecar](./apps/npu-sidecar): optional Python sidecar for local NPU-backed inference

### Shared packages

- [packages/contracts](./packages/contracts): shared contracts and schemas
- [packages/storage](./packages/storage): SQLite/Postgres repositories and persistence helpers
- [packages/policy-engine](./packages/policy-engine): tool policy and runtime guardrails
- [packages/orchestration](./packages/orchestration): agent and workflow primitives
- [packages/memory-core](./packages/memory-core): context and memory composition utilities
- [packages/skills](./packages/skills): skill loading and activation support
- [packages/extensions-sdk](./packages/extensions-sdk): author SDK for add-ons and integration plugins

## Quickstart

Windows note: use the PowerShell installer and setup flow in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md). The shell commands below assume macOS, Linux, WSL, or another bash-compatible shell that can resolve the repo path correctly.

### Clone and boot

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
pnpm dev
```

### Useful commands

```bash
pnpm verify:install
pnpm doctor:deep
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

More setup details live in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

## Docker quickstart

GoatCitadel now ships with a first-party container path for people who want a tighter local or shared-host runtime boundary than a raw host install.

What Docker improves here:

- isolates the GoatCitadel runtime from the host more cleanly
- makes the Postgres-first deployment path repeatable
- gives you safer defaults for non-loopback/shared-host runs

What it does not guarantee:

- it is not a complete hostile-code sandbox for Code Mode
- it does not replace GoatCitadel's own auth, approvals, path jails, or network policy

Primary Postgres-backed compose path:

```bash
docker compose up --build
```

Default container endpoints:

- Mission Control: `http://localhost:4173`
- Gateway health: `http://127.0.0.1:8787/health`

Before exposing GoatCitadel beyond your own machine, replace the compose defaults for:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

If you need a non-local hostname in the Mission Control preview image, rebuild with matching `GOATCITADEL_VITE_ALLOWED_HOSTS` and `VITE_GATEWAY_ALLOWED_HOSTS` build args. Full setup notes live in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

## Current status

GoatCitadel is in late beta. The repo contains a real Mission Control shell, a working gateway, shared policy/orchestration packages, and extension scaffolding. It is already useful for local operator workflows, but the public surface is still being tightened and some contracts may continue to evolve before `1.0`.

This repository intentionally favors truthful product claims over aspirational parity language. If something is still experimental, optional, or only partially proven, the docs should say so plainly.

Safe claims today:

- the capability system now governs tools, runtime skills, generated candidates, proposals, and Code Mode runs on one native path
- Code Mode v1 exists as a governed trusted-code surface with immutable run artifacts and explicit operator approval
- Skills Hub and inline approvals now expose lifecycle, trust, provenance, and richer Code Mode inspection details
- Docker can add a stronger runtime isolation boundary for local/shared-host deployment when paired with auth and policy configuration

Not safe to over-claim yet:

- hostile-code sandboxing for Code Mode
- autonomous tool activation without governance

## Screenshots

Full gallery: [docs/screenshots/mission-control](./docs/screenshots/mission-control)

| Operate Chat | Operate Code |
| --- | --- |
| ![Operate Chat](docs/screenshots/mission-control/operate-chat.png) | ![Operate Code](docs/screenshots/mission-control/operate-code.png) |

| Observe Quality | Configure Integrations |
| --- | --- |
| ![Observe Quality](docs/screenshots/mission-control/observe-quality.png) | ![Configure Integrations](docs/screenshots/mission-control/configure-integrations-overview.png) |

## Public docs

- [CHANGELOG.md](./CHANGELOG.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md)
- [docs/ENGINEERING_HANDBOOK.md](./docs/ENGINEERING_HANDBOOK.md)
- [docs/PLUGIN_SDK_CONTRACT.md](./docs/PLUGIN_SDK_CONTRACT.md)

## Repo layout

```text
apps/                  product runtimes and UI
packages/              shared libraries and runtime modules
scripts/               repo automation and verification
templates/             add-on, integration, companion, and verification templates
config/*.example.json  public config templates
docs/screenshots/      curated Mission Control screenshots
```

## Philosophy

GoatCitadel aims to sit in the useful middle:

- faster than heavy agent platforms
- more capable than a plain chat box
- explicit about what the AI is doing
- local-first where privacy, latency, or cost matter

## License and credits

See [ASSET_LICENSES.md](./ASSET_LICENSES.md) and [CREDITS.md](./CREDITS.md).
