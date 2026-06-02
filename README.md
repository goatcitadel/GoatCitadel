# GoatCitadel

> Local-first AI operations console for chat, coding, orchestration, memory, tools, approvals, and operator-visible runtime truth.

[![Website](https://img.shields.io/badge/website-goatcitadel.app-22d3ee?style=for-the-badge)](https://goatcitadel.app)
[![Release](https://img.shields.io/badge/release-1.0.0-1ec8a5?style=for-the-badge)](./CHANGELOG.md)
[![UI](https://img.shields.io/badge/ui-Mission%20Control%20Next-0f172a?style=for-the-badge)](./apps/mission-control-next)
[![Runtime](https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge)](./apps/gateway)
[![Local First](https://img.shields.io/badge/posture-local--first-2dd4bf?style=for-the-badge)](./docs/INSTALL_SETUP_TESTING.md)
[![Monorepo](https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge)](./package.json)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/goatcitadel/GoatCitadel)

README last updated: 2026-06-02

[goatcitadel.app](https://goatcitadel.app) is the public product site. This repository remains the implementation source of truth for runtime behavior, release evidence, installation details, and supported technical claims.

GoatCitadel is built for operators who want more leverage than a chat box and more control than a hidden-state agent platform. It combines a Mission Control UI, a Fastify gateway, shared orchestration and policy packages, governed Code Mode, local-first memory/context flows, native Windows desktop packaging, and inspectable runtime evidence.

## Screenshots

The images below are regenerated from a sanitized Mission Control Next demo runtime. They are for a quick product tour; release visual proof is owned by the checked-in visual regression baselines and `pnpm verify:visual:regression`.

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/chat.png" alt="Mission Control Chat surface" /></td>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/cowork.png" alt="Mission Control Cowork surface" /></td>
  </tr>
  <tr>
    <td><strong>Chat</strong><br />Fast conversation with routing, context, citations, and tool visibility nearby.</td>
    <td><strong>Cowork</strong><br />Supervised agentic work with plans, approvals, checkpoints, and run evidence.</td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/code.png" alt="Mission Control Code surface" /></td>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/projects.png" alt="Mission Control Projects surface" /></td>
  </tr>
  <tr>
    <td><strong>Code</strong><br />Implementation, review, debugging, workbench state, and governed Code Mode runs.</td>
    <td><strong>Projects</strong><br />Project containers that bind Chat, Cowork, and Code work together.</td>
  </tr>
  <tr>
    <td width="33%"><img src="./docs/screenshots/mission-control-next/library-capabilities.png" alt="Mission Control Library capability browser" /></td>
    <td width="33%"><img src="./docs/screenshots/mission-control-next/ops-runtime.png" alt="Mission Control Ops runtime surface" /></td>
    <td width="33%"><img src="./docs/screenshots/mission-control-next/settings-providers.png" alt="Mission Control Settings providers surface" /></td>
  </tr>
  <tr>
    <td><strong>Library</strong><br />Skills, memory, files, artifacts, and capability evidence.</td>
    <td><strong>Ops</strong><br />Runtime health, backups, diagnostics, activity, costs, and proof posture.</td>
    <td><strong>Settings</strong><br />Providers, models, integrations, channels, MCP, tools, auth, and workspace controls.</td>
  </tr>
</table>

[Open the generated screenshot gallery.](./docs/screenshots/mission-control-next/index.html)

Regenerate the public gallery from a throwaway sanitized runtime:

```bash
pnpm screenshots:capture
```

## Current Release Truth

| Area | Current truth |
| --- | --- |
| Canonical shell | [apps/mission-control-next](./apps/mission-control-next) is the `1.0` Mission Control shell. |
| Retired shell | `apps/mission-control` source is archived from disk. Generated build/runtime residue may still exist locally, but it is not a shipped compatibility source. |
| Runtime owner | [apps/gateway](./apps/gateway) is the Fastify control plane for runtime APIs, orchestration, approvals, memory, integrations, audit, policy, realtime events, and persistence coordination. |
| Visible IA | Mission Control navigation is `Chat / Cowork / Code / Projects / Library / Ops / Settings`. |
| Route scope | The current visible route surface is 41 routes: 36 `ship`, 0 `needs_release_polish`, and 5 `experimental`. See [docs/1_0_RELEASE_SURFACE_SCOPE.md](./docs/1_0_RELEASE_SURFACE_SCOPE.md). |
| Durable execution | Durable runs own the shipped resumable mission-session Chat, Cowork, and Code flow set. |
| Code Mode | Code Mode v1 is a governed trusted-code surface with explicit approval, recorded artifact hashes, execution-time hash checks, and separate `hostileSandboxClaim` metadata. The Windows AppContainer hostile-sandbox promotion slice now has green adversarial canary proof; the public cross-platform hostile-code claim remains not promoted until Linux, macOS, and Windows proof all pass. |
| Code backends | The trusted-code host runner is the default. Docker is selectable only when explicitly configured. The Aider adapter is Docker-backed and audit-only; no patch replay, candidate promotion, or operator-workspace mutation is claimed. |
| Governed activation | Autonomous high-risk activation is opt-in through expiring operator grants scoped by workspace, surface, risk tier, capability/tool patterns, budget/count, grantor, reason, expiry, and revocation. Activations still pass deny-wins policy, path jails, auth, provenance, and health checks before durable evidence is recorded. |
| Memory | `MemoryLifecycleService` owns operator-facing memory lifecycle behavior, explicit recall, trace-derived memory proposals, feedback, dedupe, scope, and write policy. |
| Mesh | `packages/mesh-core` readiness is evidence-gated by `verify:mesh:readiness`, covering join-token, mTLS/tailnet posture, leases, owner failover, replication offsets, Settings visibility, and Gateway diagnostics. |
| MCP | Local `stdio`, the built-in Approval Inbox path, and governed remote HTTP/SSE servers are runtime-invokable for no-auth, token-env, or OAuth2 records with configured OAuth metadata and ready token refs. OAuth access/refresh tokens resolve through the OS secret store, refresh near expiry, inject `Authorization: Bearer ...` into HTTP/SSE calls, and keep audit/error output redacted; missing tokens surface as `needs_auth`, while expired tokens surface as `expired` and remain blocked until reconnect/refresh. |
| Desktop/installers | Windows x64 and arm64 installer paths are part of the product shape. Public-trust signed EXE distribution requires exact-SHA proof plus a release certificate; unsigned convenience installers must be labeled as unsigned. |
| Docker | Docker is a supported local/shared-host runtime boundary. It does not replace auth, approvals, path jails, allowlists, or policy. |

The authoritative claim set is [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md), [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md), and [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./docs/CANONICAL_RUNTIME_STATE_MODEL.md).

## Product Surfaces

| Surface | Purpose | Primary feel |
| --- | --- | --- |
| Chat | Fast conversation, questions, drafting, lightweight help | Simple, direct, low-friction |
| Cowork | Supervised agentic work, planning, research, approvals, durable multi-step execution | Guided, transparent, powerful |
| Code | Implementation, debugging, review, governed trusted-code execution | Technical, precise, test-driven |
| Projects | Workspace and project organization | Structured, navigable |
| Library | Skills, memory, files, artifacts, capability evidence | Inspectable, provenance-aware |
| Ops | Runtime health, activity, cost, diagnostics, backups, release proof | Operational, high-signal |
| Settings | Providers, models, tools, integrations, channels, auth, workspace controls | Clear, progressive, safe |

## Quickstart

### Windows Source Bootstrap

Power-user one-liner:

```powershell
iwr -useb https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 | iex
```

Safer download-and-run flow:

```powershell
iwr https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The source bootstrap clones or updates the repo and adds the `goatcitadel` and `goat` launchers. It does not create packaged Windows desktop shortcuts. Packaged Windows installer assets install the native Mission Control desktop host.

Full setup, update, uninstall, and troubleshooting guidance lives in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

### Source Clone

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

`pnpm dev` starts the gateway plus `@goatcitadel/mission-control-next`.

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

Before exposing GoatCitadel beyond your own machine, set long generated values for:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

The compose file binds published ports to `127.0.0.1` by default. Set `GOATCITADEL_DOCKER_BIND_IP` only when you intentionally want another host or interface to reach the stack.

## Platform Support

| OS | Arch | Package | Status |
| --- | --- | --- | --- |
| Windows | x64 | `GoatCitadel-Setup-windows-x64.exe` | Supported |
| Windows | arm64 | `GoatCitadel-Setup-windows-arm64.exe` | Supported |
| macOS | x64 / arm64 | source/dev install | Development-only |
| Linux | x64 | source/dev install or Docker | Development-only |
| Linux | arm64 | n/a | Not shipped |

See [docs/supported-platforms.md](./docs/supported-platforms.md) for runtime expectations and installer notes.

## Configuration Basics

Tracked config ships as templates:

- tracked: `config/*.example.json`
- local runtime copies: `config/*.json`

Fresh installs and raw clones materialize local runtime config through `goatcitadel install`, `goatcitadel update`, or `pnpm config:sync`.

Create a local env file for repo-based development or provider setup:

```bash
cp .env.example .env
```

Windows:

```powershell
Copy-Item .env.example .env -Force
```

Set at least one model provider key if you plan to use cloud models:

```env
OPENAI_API_KEY=your_key_here
GLM_API_KEY=your_key_here
MOONSHOT_API_KEY=your_key_here
```

Provider secrets prefer OS secure-store persistence and may fall back to local env/config storage when secure-store persistence is unavailable or disabled.

## Useful Commands

Everyday local commands:

```bash
pnpm dev
pnpm verify:install
pnpm doctor:deep
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

Installed launcher basics:

```bash
goatcitadel help
goatcitadel status --json
goatcitadel launch --no-open --json --wait
goatcitadel up
goatcitadel stop --json
```

PowerShell note: prefer `goatcitadel` or `goat`. GoatCitadel does not install `gc` because PowerShell already uses it as the built-in alias for `Get-Content`.

## Verification

Use the smallest lane that proves your change. Important release and runtime lanes include:

```bash
pnpm verify:fast
pnpm security:trivy
pnpm verify:auth:matrix
pnpm verify:runtime:truth
pnpm verify:durable:recovery
pnpm verify:code-mode:sandbox
pnpm verify:code-mode:hostile-sandbox
pnpm verify:mesh:readiness
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

- Live end-to-end proof: `verify:runtime:truth`, `verify:durable:recovery`, `verify:operator:proof`, `verify:surface:regression`, `verify:visual:regression`, `verify:backup:roundtrip`, and `verify:desktop`.
- Targeted contract/behavior proof: `verify:auth:matrix`, `verify:code-mode:sandbox`, `verify:code-mode:hostile-sandbox`, `verify:mesh:readiness`, `verify:agentic:governance`, `verify:agentic:proof`, `verify:memory:truth`, `verify:realtime:truth`, and `verify:api:compat`. `verify:code-mode:hostile-sandbox` is a promotion gate for native hostile-sandbox claim metadata and adversarial canary coverage; it runs current-platform native canaries when the adapter is available. On Windows, the lane proves AppContainer outside-root read/write denial, network denial, env-secret absence, symlink/path traversal denial, process/job limits, artifact hash integrity, and fail-closed required mode, but it does not allow a public cross-platform hostile-code claim until every Linux, macOS, and Windows proof is green. `verify:agentic:proof` is targeted contract/behavior proof for retained agentic evidence, orchestration lineage anchors, and governance/harness proof families; it is not live end-to-end product proof.
- REST/SSE compatibility proof: `verify:api:compat` snapshots REST route/status compatibility and realtime event envelopes. It is not a full response-schema diff.
- Backup proof: `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set.
- Parity sample: `verify:catalog:parity` now executes the runtime-backed operator action classes declared in its parity scenario; it is a parity sample, not proof every future visible catalog entry has a live action.
- Architecture debt guard: `verify:architecture:metrics` fails on coupling regressions and reports large-service debt. It is not proof broad `GatewayService` decomposition is complete.

For UI changes, include browser or visual proof when practical. `verify:visual:regression` compares checked-in shell and route baselines for the current Mission Control Next surface. Intentional visual baseline updates go through:

```bash
pnpm verify:visual:rebaseline
pnpm verify:visual:regression
```

## What Ships In This Repo

Apps:

- [apps/mission-control-next](./apps/mission-control-next): canonical React/Vite Mission Control shell used by `pnpm dev`
- [apps/mission-control-desktop](./apps/mission-control-desktop): Tauri desktop host for packaged Mission Control
- [apps/gateway](./apps/gateway): Fastify control plane and runtime APIs
- [apps/npu-sidecar](./apps/npu-sidecar): optional experimental Python sidecar for local NPU-backed inference; not part of the current `1.0` readiness bar

Shared packages:

- [packages/contracts](./packages/contracts): shared contracts and schemas
- [packages/gateway-core](./packages/gateway-core): shared gateway runtime primitives
- [packages/storage](./packages/storage): SQLite/Postgres repositories and persistence helpers
- [packages/policy-engine](./packages/policy-engine): tool policy, wrappers, and runtime guardrails
- [packages/orchestration](./packages/orchestration): agent and workflow primitives
- [packages/memory-core](./packages/memory-core): context and memory composition utilities
- [packages/skills](./packages/skills): skill loading and activation support
- [packages/extensions-sdk](./packages/extensions-sdk): author SDK for add-ons and integration plugins
- [packages/threaded-surface-core](./packages/threaded-surface-core): shared Chat/Cowork/Code threaded-surface runtime components
- [packages/mission-control-shared](./packages/mission-control-shared): shared Mission Control API clients, hooks, and UI primitives

## Architecture At A Glance

- Gateway runtime is the operational source of truth for runtime APIs, orchestration, approvals, policy, integrations, audit, realtime events, and persistence coordination.
- Mission Control is an API client for Chat, Cowork, Code, Projects, Library, Ops, and Settings. It should not bypass gateway-owned runtime state.
- Durable execution owns resumable mission-session work, approval wait/resume, recovery, retries, cancellation truth, and dead-letter handling.
- Capability and skills catalogs split inspectable review state from callable runtime state. Inactive candidates and proposals are never callable.
- Memory lifecycle is explicit, scoped, and operator-visible. Trace-derived memory remains proposal-first.
- Deny-wins policy, approval gates, path jails, allowlists, auth boundaries, and tool grants remain authoritative.
- Canonical state belongs in repositories and durable logs. Retained realtime events are operator signals, not the complete historical record.

## Claims Boundaries

Safe public claims today:

- GoatCitadel `1.0.0` is defined by [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md) and backed by [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md).
- Chat, Cowork, and Code are distinct operator surfaces backed by shared runtime foundations.
- Durable execution owns the shipped mission-session resumable flow set.
- The capability system governs tools, runtime skills, generated candidates, proposals, and Code Mode runs.
- Code Mode v1 is trusted-code, approval-gated execution with recorded artifact hashes and execution-time hash checks.
- Windows-native AppContainer hostile-sandbox proof is green as a current-platform promotion slice under `verify:code-mode:hostile-sandbox`; public cross-platform hostile-code sandboxing remains unclaimed.
- High-risk autonomous activation is governed by expiring operator grants, deny-wins policy, path jails, auth, provenance, health checks, durable audit/evidence, and an emergency revoke path.
- Remote MCP HTTP/SSE invocation is Gateway-mediated for supported no-auth, token-env, and OAuth2 records, including OAuth token refs in the OS secret store, refresh near expiry, bearer injection, readiness blockers, and redacted audit/errors.
- `packages/mesh-core` has a named readiness lane, `verify:mesh:readiness`, for release evidence over join tokens, mTLS/tailnet posture, leases, owner failover, replication offsets, Settings, and Gateway diagnostics.
- Visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers instead of diagnostics-only shells.
- Backup create/list/verify are shipped, and backup verify reports both archive integrity and `contractVerified` minimum-set truth.
- `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set: SQLite state, transcripts, audit logs, and every runtime `config/*.json` file.
- Filesystem-backed restore is offline-only for `1.0`; the live admin restore route returns `offline_restore_required` instead of mutating an active runtime.
- `@goatcitadel/extensions-sdk` is the author boundary for add-ons and integration plugins.
- Docker adds a useful runtime boundary when paired with auth and policy configuration.
- Multi-user RBAC is not shipped for `1.0`; gateway auth is deployment-level while permission profiles, tool grants, route access classes, Local Operator Override, and deny-wins policy govern actions inside the authenticated runtime.

Do not claim without fresh proof:

- cross-platform or general hostile-code sandboxing for Code Mode beyond the named Windows-native proof slice
- ungoverned autonomous high-risk tool activation
- NPU sidecar maturity or local-inference completeness as a `1.0` signal
- `packages/mesh-core` readiness without a green `verify:mesh:readiness` evidence lane
- compatibility shell parity as canonical product readiness
- remote MCP invocation that bypasses Gateway policy, approvals, network allowlists, audit, or supported auth
- OAuth-backed remote MCP invocation without OAuth metadata, OS secret-store token refs, ready auth state, and redacted refresh/runtime evidence
- generated screenshot, release proof, installer signing, or backup restore guarantee that was not actually produced

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
- [docs/PLUGIN_SDK_CONTRACT.md](./docs/PLUGIN_SDK_CONTRACT.md)
- [docs/security/findings-triage.md](./docs/security/findings-triage.md)

## Repo Layout

```text
apps/                                      product runtimes and UI
packages/                                  shared libraries and runtime modules
scripts/                                   repo automation and verification
templates/                                 add-on, integration, companion, and verification templates
config/*.example.json                      public config templates
scripts/verification/baselines/visual/     checked-in Mission Control visual baselines
docs/screenshots/mission-control-next/     sanitized public screenshot gallery
artifacts/verification/                    local verification output, regenerated by proof lanes
```

## Development Posture

When changing this repo:

- inspect the current runtime owner before editing
- prefer implementation truth over stale plans or review notes
- keep diffs surgical and avoid unrelated formatting churn
- preserve public truth across docs, UI copy, release notes, and implementation
- do not mutate user data, secrets, generated evidence, or runtime state casually
- validate proportionally to risk and report what remains uncertain

Before acting on a GitHub Security finding, read [docs/security/findings-triage.md](./docs/security/findings-triage.md).

## License And Credits

See [ASSET_LICENSES.md](./ASSET_LICENSES.md) and [CREDITS.md](./CREDITS.md).
