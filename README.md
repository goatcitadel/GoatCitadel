# GoatCitadel

> Local-first AI operations console for chat, coding, orchestration, memory, tools, and approvals.

[![Release](https://img.shields.io/badge/release-1.0.0-1ec8a5?style=for-the-badge)](./CHANGELOG.md)
[![UI](https://img.shields.io/badge/ui-Mission%20Control%20Next-0f172a?style=for-the-badge)](./apps/mission-control-next)
[![Runtime](https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge)](./apps/gateway)
[![Local First](https://img.shields.io/badge/posture-local--first-2dd4bf?style=for-the-badge)](./docs/INSTALL_SETUP_TESTING.md)
[![Monorepo](https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge)](./package.json)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/goatcitadel/GoatCitadel)

GoatCitadel is a hybrid local/cloud AI workspace built for real operator workflows. It gives you a Mission Control UI, a Fastify gateway, shared orchestration and policy packages, and a local-first runtime model that stays explicit about tools, approvals, and system state.

![GoatCitadel Mission Control](docs/screenshots/mission-control/operate-chat.png)

## What it does

- Chat, Cowork, and Code surfaces with different operating posture
- Gateway-owned orchestration, approvals, memory, integrations, and audit trails
- Tool policy enforcement with path jails, allowlists, and approval gates
- Workspace-aware context and memory maintenance flows
- Multi-provider model routing with local-friendly runtime support
- Add-on and integration-plugin scaffolds plus the published `@goatcitadel/extensions-sdk` package for extending the system

## What's new on `main`

- **Guided `llama.cpp` setup**: Mission Control now includes richer local-runtime setup, diagnostics, and provider handoff for `llama.cpp`, with the operator rollout notes captured in [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md).
- **Approval delivery auth clarified**: remote approval delivery now keeps connector delivery auth boundaries explicit, making channel-backed approval routing easier to reason about during setup and testing.
- **Windows installers refreshed**: the published Windows x64 and arm64 installer artifacts were regenerated after the `1.0.0` cut so the public install path stays aligned with the current branch.

## What ships in this repo

### Apps

- [apps/mission-control-next](./apps/mission-control-next): canonical `1.0` React/Vite operator console used by `pnpm dev`
- [apps/mission-control](./apps/mission-control): compatibility-only React/Vite operator console retained for rollback, comparison, and inbound route continuity
- [apps/gateway](./apps/gateway): Fastify control plane and runtime APIs
- [apps/npu-sidecar](./apps/npu-sidecar): optional experimental Python sidecar for local NPU-backed inference; not part of the current `1.0` readiness bar

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

`pnpm dev` now starts the gateway plus `@goatcitadel/mission-control-next` by default. Use `pnpm dev:ui:legacy` only when you need the compatibility shell for rollback, comparison, or route-continuity checks.

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

```powershell
pnpm secrets:docker | Tee-Object -FilePath .env
docker compose up --build
```

Or, from a packaged/source launcher:

```powershell
goatcitadel secrets generate --docker-env | Tee-Object -FilePath .env
docker compose up --build
```

Default container endpoints:

- Mission Control: `http://localhost:4173`
- Gateway health: `http://127.0.0.1:8787/health`

The compose file binds published ports to `127.0.0.1` by default. To expose it on another interface, set `GOATCITADEL_DOCKER_BIND_IP` intentionally and keep auth/origin controls tight.

Before exposing GoatCitadel beyond your own machine, keep long generated values for:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

If you need a non-local hostname in the Mission Control preview image, rebuild with matching `GOATCITADEL_VITE_ALLOWED_HOSTS` and `VITE_GATEWAY_ALLOWED_HOSTS` build args. Full setup notes live in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

## Current status

GoatCitadel now ships at the `1.0.0` bar defined in [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md). The repo contains the canonical `mission-control-next` shell, the Fastify gateway, shared policy/orchestration packages, the published extensions SDK, and the blocking release lanes required to keep the visible product contract honest.

This repository intentionally favors truthful product claims over aspirational parity language. If something is still experimental, optional, or only partially proven, the docs should say so plainly.

The current `1.0` promise, visible scope, trust posture, additive API posture, backup guarantees, and release gates are defined in [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md). The evidence map for those claims lives in [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md).

For public `1.0` wording:

- `mission-control-next` is the canonical shell
- `apps/mission-control` is compatibility-only
- `proof` means a named end-to-end verification lane with a bespoke scenario body
- supporting code paths, tests, manifests, and docs are `evidence`

Safe claims today:

- the capability system now governs tools, runtime skills, generated candidates, proposals, and Code Mode runs on one native path
- Code Mode v1 exists as a governed trusted-code surface with immutable run artifacts and explicit operator approval
- Code Mode host isolation is best-effort and fail-closed when required isolation is unavailable; it is still a trusted-code/manual-governed surface
- Skills Hub and inline approvals now expose lifecycle, trust, provenance, and richer Code Mode inspection details
- visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers instead of diagnostics-only catalog shells
- durable execution owns the mission-session LLM flow set, while external writeback sessions stay visible and explicitly non-resumable until durable external envelopes land
- filesystem-backed restore is offline-only for `1.0`; operators must stop any gateway serving that runtime root before running the CLI restore, and the live admin restore route preserves compatibility by returning `offline_restore_required` instead of mutating an active runtime
- Postgres backups support create and verify in the shipped `1.0` surface, while restore remains an operator-run `pg_restore` workflow instead of the SQLite file-copy restore path
- Docker can add a stronger runtime isolation boundary for local/shared-host deployment when paired with auth and policy configuration
- provider secrets may be stored in local env/config files when secure-store persistence is disabled or unavailable
- visible MCP authoring stays on local `stdio` plus the built-in Approval Inbox template until broader remote transport invocation is implemented
- `verify:visual:regression` compares checked-in shell and primary-surface baselines for the full visible `Work / Observe / Tune` footprint derived from the canonical release-surface manifest
- backup verify now reports both archive integrity and `contractVerified` coverage for the `1.0` minimum backup set
- `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set: SQLite state, transcripts, audit logs, and every runtime `config/*.json` file
- `verify:catalog:parity` now executes real operator actions for visible runtime-backed non-channel entries instead of stopping at metadata checks
- `verify:api:compat` snapshots REST schemas and realtime event envelopes and fails on breaking diffs

Not safe to over-claim yet:

- hostile-code sandboxing for Code Mode
- autonomous tool activation without governance
- `packages/mesh-core` as a readiness-bearing `1.0` subsystem while it still has targeted service coverage rather than full release evidence
- NPU sidecar maturity or local-inference completeness as a `1.0` signal

## Screenshots

Refreshed on April 12, 2026 from the sanitized Mission Control demo runtime used for public-share docs.

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
- [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md)
- [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md)
- [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md)
- [docs/ENGINEERING_HANDBOOK.md](./docs/ENGINEERING_HANDBOOK.md)
- [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md)
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
