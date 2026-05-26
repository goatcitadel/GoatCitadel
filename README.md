# GoatCitadel

> Local-first AI operations console for chat, coding, orchestration, memory, tools, approvals, and operator-visible runtime truth.

[![Website](https://img.shields.io/badge/website-goatcitadel.app-22d3ee?style=for-the-badge)](https://goatcitadel.app)
[![Release](https://img.shields.io/badge/release-1.0.0-1ec8a5?style=for-the-badge)](./CHANGELOG.md)
[![UI](https://img.shields.io/badge/ui-Mission%20Control%20Next-0f172a?style=for-the-badge)](./apps/mission-control-next)
[![Runtime](https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge)](./apps/gateway)
[![Local First](https://img.shields.io/badge/posture-local--first-2dd4bf?style=for-the-badge)](./docs/INSTALL_SETUP_TESTING.md)
[![Monorepo](https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge)](./package.json)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/goatcitadel/GoatCitadel)

[goatcitadel.app](https://goatcitadel.app) is the public website for GoatCitadel. This repository remains the implementation source of truth for runtime behavior, release evidence, installation details, and supported claims.

GoatCitadel is a hybrid local/cloud AI workspace for real operator workflows. It combines a Mission Control UI, a Fastify gateway, shared orchestration and policy packages, governed code execution, local-first memory/context flows, native desktop packaging, and inspectable runtime evidence.

It is not only a chat UI. GoatCitadel is meant to help users talk with AI, supervise agentic work, implement and review code, manage providers/tools/memory/integrations, and understand what happened when the system used context, tools, approvals, or durable execution.

## Product Surfaces

| Surface | Purpose | Primary feel |
| --- | --- | --- |
| Chat | Fast conversation, questions, drafting, and lightweight help | Simple, direct, low-friction |
| Cowork | Supervised agentic work, planning, research, approvals, and durable multi-step execution | Guided, transparent, powerful |
| Code | Implementation, debugging, review, and governed trusted-code execution | Technical, precise, test-driven |
| Projects | Workspace and project organization | Structured, navigable |
| Library | Skills, memory, files, artifacts, and capability evidence | Inspectable, provenance-aware |
| Ops | Runtime health, activity, cost, diagnostics, backups, and release proof | Operational, high-signal |
| Settings | Providers, models, tools, integrations, channels, auth, and workspace controls | Clear, progressive, safe |

## Mission Control Screenshots

These README-facing screenshots are regenerated from a sanitized Mission Control Next demo runtime. They are useful for a quick product tour; release visual proof still comes from the checked-in visual regression baselines described below.

| Chat | Cowork |
| --- | --- |
| ![Chat surface](./docs/screenshots/mission-control-next/chat.png) | ![Cowork surface](./docs/screenshots/mission-control-next/cowork.png) |

| Code | Projects |
| --- | --- |
| ![Code surface](./docs/screenshots/mission-control-next/code.png) | ![Projects surface](./docs/screenshots/mission-control-next/projects.png) |

| Library capabilities | Ops runtime | Settings providers |
| --- | --- | --- |
| ![Library capability browser](./docs/screenshots/mission-control-next/library-capabilities.png) | ![Ops runtime surface](./docs/screenshots/mission-control-next/ops-runtime.png) | ![Settings providers surface](./docs/screenshots/mission-control-next/settings-providers.png) |

[Open the full generated gallery.](./docs/screenshots/mission-control-next/index.html)

## Current Product Truth

- `apps/mission-control-next` is the canonical `1.0` Mission Control shell.
- `apps/mission-control` was retired in 1.x cleanup; the legacy source is archived from disk and is no longer wired into builds, CI, or the dev launcher.
- The Fastify gateway owns runtime APIs, routing, orchestration entrypoints, approvals, policy enforcement, integrations, audit, realtime events, and persistence coordination.
- Chat, Cowork, and Code are distinct operator surfaces backed by shared runtime foundations.
- Durable execution owns the shipped resumable mission-session Chat / Cowork / Code flow set.
- The capability system governs tools, runtime skills, generated candidates, proposals, and Code Mode runs through inspectable and callable catalogs.
- Code Mode v1 is a governed trusted-code surface with explicit operator approval, recorded artifact hashes, and execution-time hash checks. It is not a hostile-code sandbox claim.
- Native Windows desktop hosting and installer paths are part of the product shape.
- Docker is a supported local/shared-host runtime boundary, but it does not replace auth, approvals, path jails, allowlists, or policy.
- Public claims should stay aligned with [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md), [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./docs/CANONICAL_RUNTIME_STATE_MODEL.md), and the current implementation.

## What's Current On `main`

- **Cowork delegation approvals are more explicit**: threaded surfaces keep approval state and follow-on actions visible in the active composer flow, with regression coverage around delegation policy actions.
- **Cowork artifacts and document tooling are stronger**: PPTX/document artifact execution is represented through the policy/tool registry path, and trace persistence now preserves richer artifact metadata for operator review.
- **Mission Control Next received contrast polish**: Cowork and threaded workflow surfaces have refreshed contrast treatment for denser operator output.
- **Gateway runtime lifecycle work keeps tightening**: orchestration helpers, chat turn streaming, prompt-pack policy, duplicate-run prevention, queued starts, cancellation truth, cost-limit enforcement, worktree release, and durable abort handling are covered by focused regressions.
- **Security and trust boundaries are more explicit**: MCP child env keys, Firecrawl env-name input, Code Mode env passthrough, secrets routes, and high-risk approval behavior use explicit allowlists and route-level regressions instead of broad ambient runtime state.
- **First-run provider setup is clearer**: canonical Settings/onboarding keeps loopback bypass off by default, labels provider setup as `Providers & Models`, and shows key-on-file status without returning saved provider secrets to the browser.
- **Release evidence stays current**: closeout status, release-lane proof, installer posture, visual baselines, and governance checks are tracked in [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md) and [docs/review/backlog-closeout-2026-05-15.md](./docs/review/backlog-closeout-2026-05-15.md).

## Quickstart

### Website

Start with the public site:

- [https://goatcitadel.app](https://goatcitadel.app)

Use the repo docs below when you need implementation-level setup, validation, release proof, or contribution guidance.

### Windows source bootstrap

Power-user one-liner:

```powershell
iwr -useb https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 | iex
```

Safer download-and-run flow:

```powershell
iwr https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This source bootstrap clones or updates the repo and adds the `goatcitadel` and `goat` command launchers. It is not the packaged Windows `.exe` installer. The packaged installer release assets install the native Mission Control desktop host; the source bootstrap opens the local Mission Control web runtime through the launcher.

Full setup, update, uninstall, and troubleshooting guidance lives in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

### Source clone

Use this path for development, contribution, and raw GitHub validation.

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
pnpm dev
```

`pnpm dev` starts the gateway plus `@goatcitadel/mission-control-next`. The legacy `apps/mission-control` shell is retired and no longer reachable through the launcher.

Default source endpoints:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`

### Docker / Compose

Use Docker when you want a stronger local or shared-host runtime boundary than a raw host install.

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

Docker improves runtime isolation and repeatability, especially for Postgres-backed shared-host deployments. It is still not a complete hostile-code sandbox, and it does not replace GoatCitadel auth, approval gates, path jails, or network policy.

Before exposing GoatCitadel beyond your own machine, set long generated values for:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

The compose file binds published ports to `127.0.0.1` by default. Set `GOATCITADEL_DOCKER_BIND_IP` only when you intentionally want another host or interface to reach the stack.

## Useful Commands

```bash
pnpm verify:install
pnpm doctor:deep
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

Focused release and runtime proof lanes:

```bash
pnpm verify:fast
pnpm security:trivy
pnpm verify:auth:matrix
pnpm verify:runtime:truth
pnpm verify:durable:recovery
pnpm verify:code-mode:sandbox
pnpm verify:agentic:governance
pnpm verify:agentic:proof
pnpm verify:operator:proof
pnpm verify:ui:parity
pnpm verify:memory:truth
pnpm verify:realtime:truth
pnpm verify:architecture:metrics
pnpm verify:surface:regression
pnpm verify:visual:regression
pnpm verify:backup:roundtrip
pnpm verify:catalog:parity
pnpm verify:api:compat
pnpm verify:desktop
```

Proof-type shorthand:

- Live end-to-end proof: `verify:runtime:truth`, `verify:durable:recovery`, `verify:operator:proof`, `verify:surface:regression`, `verify:visual:regression`, `verify:backup:roundtrip`, and `verify:desktop` exercise real runtime, UI, recovery, backup, or packaging paths.
- Targeted contract/behavior proof: `verify:auth:matrix`, `verify:code-mode:sandbox`, `verify:agentic:governance`, `verify:agentic:proof`, `verify:memory:truth`, `verify:realtime:truth`, and `verify:api:compat` prove named security, contract, retained-evidence, and event-envelope behaviors.
- Parity sample: `verify:catalog:parity` executes the runtime-backed operator action classes declared in its parity scenario; it is not complete product-wide catalog proof.
- Architecture debt guard: `verify:architecture:metrics` fails on coupling regressions and reports large-service debt; it is not proof broad `GatewayService` decomposition is complete.

Installed launcher basics:

```bash
goatcitadel help
goatcitadel status --json
goatcitadel launch --no-open --json --wait
goatcitadel up
goatcitadel stop --json
```

PowerShell note: prefer `goatcitadel` or `goat`. GoatCitadel does not install `gc` because PowerShell already uses it as the built-in alias for `Get-Content`.

## What Ships In This Repo

### Apps

- [apps/mission-control-next](./apps/mission-control-next): canonical `1.0` React/Vite operator console used by `pnpm dev`
- [apps/mission-control-desktop](./apps/mission-control-desktop): native desktop host for packaged Mission Control (Tauri shell pointing at mission-control-next)
- [apps/gateway](./apps/gateway): Fastify control plane and runtime APIs
- [apps/npu-sidecar](./apps/npu-sidecar): optional experimental Python sidecar for local NPU-backed inference; not part of the current `1.0` readiness bar

### Shared packages

- [packages/contracts](./packages/contracts): shared contracts and schemas
- [packages/storage](./packages/storage): SQLite/Postgres repositories and persistence helpers
- [packages/policy-engine](./packages/policy-engine): tool policy, wrappers, and runtime guardrails
- [packages/orchestration](./packages/orchestration): agent and workflow primitives
- [packages/memory-core](./packages/memory-core): context and memory composition utilities
- [packages/skills](./packages/skills): skill loading and activation support
- [packages/extensions-sdk](./packages/extensions-sdk): author SDK for add-ons and integration plugins
- [packages/threaded-surface-core](./packages/threaded-surface-core): shared Chat/Cowork/Code threaded-surface runtime components
- [packages/mission-control-shared](./packages/mission-control-shared): shared Mission Control API clients, hooks, and UI primitives

## Architecture At A Glance

- **Gateway runtime**: control plane and operational source of truth for runtime APIs, orchestration, approvals, policy, integrations, audit, realtime events, and persistence coordination.
- **Mission Control**: API client surfaces for Chat, Cowork, Code, Projects, Library, Ops, and Settings. It should not bypass gateway-owned runtime state.
- **Provider layer**: shared abstractions for OpenAI, Anthropic, Google, Moonshot, Perplexity, local/OpenAI-compatible runtimes, usage, streaming, metadata, and errors.
- **Durable execution**: authority for resumable mission-session work, approval wait/resume, recovery, retries, cancellation truth, and dead-letter handling.
- **Capability and skills layer**: governed tools, runtime skills, generated candidates, proposals, callable catalogs, inspectable catalogs, and Code Mode run artifacts.
- **Memory and context**: `MemoryLifecycleService` owns operator-facing memory lifecycle behavior, including context composition, learned-memory policy, item list/edit/forget/history, dedupe, scope, and write policy.
- **Policy and security**: deny-wins policy, approval gates, path jails, allowlists, auth boundaries, and tool grants remain authoritative.
- **Storage, audit, and realtime**: canonical state belongs in repositories and durable logs; retained realtime events are operator signals, not the complete historical record.

## Status And Claims

GoatCitadel ships at the `1.0.0` bar defined in [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md). The evidence map for those claims lives in [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md).

Safe public claims today:

- the current shell is Mission Control Next
- Chat, Cowork, and Code are distinct operator surfaces
- the gateway is the control plane for orchestration, approvals, memory, integrations, audit, policy, and runtime APIs
- durable execution owns the shipped mission-session resumable flow set
- the capability system governs tools, runtime skills, generated candidates, proposals, and Code Mode runs
- Code Mode v1 is a trusted-code, approval-gated surface with recorded artifact hashes and execution-time hash checks
- visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers instead of diagnostics-only catalog shells
- backup create/list/verify are shipped, and backup verify reports both archive integrity and `contractVerified` minimum-set truth
- filesystem-backed restore is offline-only for `1.0`; the live admin restore route returns `offline_restore_required` instead of mutating an active runtime
- Postgres backups support create and verify; restore remains an operator-run `pg_restore` workflow
- Docker adds a useful runtime boundary when paired with auth and policy configuration
- `@goatcitadel/extensions-sdk` is the published author boundary for add-ons and integration plugins
- multi-user RBAC is not shipped for `1.0`; gateway auth is deployment-level while permission profiles, tool grants, route access classes, Local Operator Override, and deny-wins policy govern actions inside the authenticated runtime
- provider secrets prefer OS secure-store persistence and may fall back to local env/config storage when secure-store persistence is unavailable or disabled
- `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set: SQLite state, transcripts, audit logs, and every runtime `config/*.json` file
- `verify:catalog:parity` now executes the runtime-backed operator action classes declared in its parity scenario instead of stopping at metadata checks; it is a parity sample, not proof every future visible catalog entry has a live action
- `verify:agentic:proof` is targeted contract/behavior proof for retained agentic evidence, orchestration lineage anchors, and governance/harness proof families; it is not live end-to-end product proof
- `verify:architecture:metrics` reports large-service debt and fails on coupling regressions; it is not proof broad `GatewayService` decomposition is complete
- `verify:api:compat` snapshots REST route/status compatibility and realtime event envelopes; it is not a full response-schema diff

Do not claim without fresh proof:

- hostile-code sandboxing for Code Mode
- autonomous high-risk tool activation without governance
- `packages/mesh-core` as a readiness-bearing `1.0` subsystem while it still has targeted service coverage rather than full release evidence
- NPU sidecar maturity or local-inference completeness as a `1.0` signal
- compatibility shell parity as canonical product readiness
- generic remote MCP transport invocation as a shipped runtime surface
- generated screenshot, release proof, or installer signing that was not actually produced
- backup restore guarantees beyond the documented offline/operator-run paths

## Visual Proof

Current release visual proof is driven by checked-in Mission Control Next shell and route baselines, not by the README gallery. `verify:visual:regression` compares checked-in shell and route baselines for the full current Mission Control Next release-surface footprint (`Chat / Cowork / Code / Projects / Library / Ops / Settings`).

```bash
pnpm verify:visual:regression
```

That lane compares the current Mission Control Next release-surface footprint (`Chat / Cowork / Code / Projects / Library / Ops / Settings`) against maintained visual baselines.

Intentional baseline updates go through:

```bash
pnpm verify:visual:rebaseline
```

Shareable README and gallery screenshots are regenerated from a sanitized demo runtime with:

```bash
pnpm screenshots:capture
```

That command updates the tracked public gallery under [docs/screenshots/mission-control-next](./docs/screenshots/mission-control-next). Keep README embeds limited to current tracked assets from that folder.

## Public Docs

- [goatcitadel.app](https://goatcitadel.app)
- [CHANGELOG.md](./CHANGELOG.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md)
- [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md)
- [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./docs/CANONICAL_RUNTIME_STATE_MODEL.md)
- [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md)
- [docs/ENGINEERING_HANDBOOK.md](./docs/ENGINEERING_HANDBOOK.md)
- [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md)
- [docs/PLUGIN_SDK_CONTRACT.md](./docs/PLUGIN_SDK_CONTRACT.md)

## Repo Layout

```text
apps/                  product runtimes and UI
packages/              shared libraries and runtime modules
scripts/               repo automation and verification
templates/             add-on, integration, companion, and verification templates
config/*.example.json  public config templates
scripts/verification/baselines/visual/  checked-in Mission Control visual baselines
docs/screenshots/mission-control-next/   sanitized public screenshot gallery
artifacts/verification/                 local verification output, regenerated by proof lanes
```

## Development Posture

When changing this repo:

- inspect the current runtime owner before editing
- prefer implementation truth over stale plans or review notes
- keep diffs surgical and avoid unrelated formatting churn
- preserve public truth across docs, UI copy, release notes, and implementation
- do not mutate user data, secrets, generated evidence, or runtime state casually
- validate proportionally to the risk and report what remains uncertain

## Philosophy

GoatCitadel aims to sit in the useful middle:

- faster than heavy agent platforms
- more capable than a plain chat box
- local-first where privacy, latency, or cost matter
- explicit about models, tools, memory, context, approvals, cost, runtime state, and remaining uncertainty

## License And Credits

See [ASSET_LICENSES.md](./ASSET_LICENSES.md) and [CREDITS.md](./CREDITS.md).
