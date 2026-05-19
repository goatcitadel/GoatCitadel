# GoatCitadel 1.0 Contract

Last updated: 2026-05-18

This document defines the product promise, visible scope, trust posture, upgrade guarantees, and release gates required before GoatCitadel may describe itself as `1.0`.

For `1.0` governance language:

- `proof` means a named verification lane with a bespoke scenario body or targeted contract/behavior harness; lanes that are not live end-to-end proof must say so explicitly
- `evidence` means the repo-visible code, tests, manifests, and supporting docs that anchor those claims

## Product Promise

GoatCitadel `1.0` is a local-first AI workbench for technical users who need to plan, supervise, and execute AI-assisted work across conversation, structured workflows, and code.

The `1.0` promise is:

- human-in-the-loop approvals for risky actions
- truthful runtime state and replayable operator evidence
- resumable execution for the shipped durable flow set
- multi-provider operation with explicit runtime diagnostics and support truth
- a Mission Control surface that is legible enough for real operator work, not just internal engineering use

## Visible 1.0 Footprint

No visible Mission Control page or catalog entry may remain half-baked, parity-incomplete, or only explainable by internal tribal knowledge.

The current `apps/mission-control-next` operator navigation is `Chat / Cowork / Code / Projects / Library / Ops / Settings`. The older `Work / Observe / Tune` grouping is a legacy release taxonomy only:

- `Work`: maps to current Chat, Cowork, Code, task, and approval workflows
- `Observe`: maps to current Ops, activity, runtime, cost, diagnostics, and Library evidence surfaces
- `Tune`: maps to current Settings, providers, integrations, channels, tools, agents, and workspace controls

Release-target mappings for the current UI:

- `apps/mission-control-next` is the canonical `1.0` operator shell.
- `apps/mission-control` remains a compatibility shell for rollback, comparison, and inbound route continuity; it is compatibility-only and is not allowed to be the only complete implementation of a shipped operator-critical surface.

- `Timeline` corresponds to the current Activity + Sessions story
- `Health` corresponds to the current Costs + System story
- `Artifacts` corresponds to the current Memory + Files story
- `Quality` is centered on Prompt Lab and its adjacent improvement/validation workflows

If a surface or sub-surface remains visible in the shipped UI, it must meet the same `1.0` operator bar as the rest of the product.

## Trust and Security Posture

The repo may make these claims at `1.0`:

- Code Mode is a governed trusted-code surface with explicit operator approval and bounded artifacts.
- Code Mode host isolation is best-effort and fail-closed when required isolation is unavailable.
- Durable execution owns the shipped mission-session Chat / Cowork / Code resumable flow set documented in [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./CANONICAL_RUNTIME_STATE_MODEL.md). External writeback sessions remain visible, but they are explicitly one-shot and non-resumable until durable external envelopes land.
- Approval follow-on work is surfaced through explicit approval effect records rather than inferred from scattered side tables or inline helper effects.
- `MemoryLifecycleService` is the operator-facing memory lifecycle owner for context composition, learned-memory policy, and memory item list/edit/forget/history.
- Provider secrets may persist in local env or config files when secure-store persistence is unavailable or disabled.

The repo must not claim these at `1.0` unless separately proven and documented:

- hostile-code sandboxing
- silent or autonomous high-risk tool activation
- `packages/mesh-core` as a readiness-bearing `1.0` subsystem while it only has targeted service coverage rather than full release evidence
- `apps/npu-sidecar` as a maturity signal for local inference completeness while it remains optional experimental infrastructure
- `GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON` or `no_agent` cron execution as a `1.0` guarantee; that path is experimental, local-only, disabled by default, and outside the 1.0 merge promise unless separately proven and promoted here

## Upgrade and Backup Guarantees

`1.0` must stay explicit about compatibility and recovery:

- REST and SSE contract changes are additive unless a separately documented migration window is announced.
- Config evolution continues to flow through the managed GoatCitadel config sync path.
- Storage migrations are forward-upgrade paths. Rollback across schema changes is not promised; restore from a verified backup is the supported recovery path.
- Backup create, list, and verify are shipped through the admin API/CLI surface.
- For filesystem-backed `1.0` runtimes, restore is offline CLI-only through the shared offline restore entrypoint; operators must stop any gateway serving the same runtime root before invoking it, and the live admin restore route remains additive-compatible by returning `offline_restore_required` with an offline restore hint instead of mutating the active runtime.
- Backup verify must report both archive integrity (`verified`) and minimum-set contract truth (`contractVerified`) for current `1.0` backups.
- Minimum operator backup set remains:
  - `data/index.db`
  - `data/transcripts/*.jsonl`
  - `data/audit/*.jsonl`
  - `config/*.json`
- Postgres backups are part of the shipped create/verify surface, but restore remains an operator-run `pg_restore` workflow rather than the SQLite file-copy restore path.
- Replay/import rebuild from logs is not part of the shipped `1.0` backup guarantee unless separately documented here.

## Ecosystem Contract

Before `1.0`, any visible provider, channel, MCP transport, or extension/SDK path must either:

- pass the same operator-ready parity bar as the rest of the product, or
- be removed from the visible `1.0` surface and public claims

That means:

- no visible provider may skip runtime connectivity, model discovery, readable auth/proxy/TLS errors, or usage reporting expectations without being called out here
- no visible built-in channel may remain `planned` or parity-incomplete
- no visible `beta` or `native` non-channel integration may advertise read/write/search/capture capabilities without matching operator actions in the shipped runtime
- no visible MCP transport may remain unsupported for runtime invocation
- the public extension author story must stay aligned to the published `@goatcitadel/extensions-sdk` package contract, the reference scaffolds, and the tested starter-pack export path

## Release Gates

GoatCitadel may not claim `1.0` until all of these are true:

- `verify:operator:proof` is green
- `verify:durable:recovery` is green and includes stack-backed restart/recovery proof
- `verify:surface:regression` is green across the current Mission Control Next release-surface manifest; governance/docs checks compare that manifest with the canonical route model so newly promoted routes do not silently fall out of release coverage
- `verify:catalog:parity` is green and executes the runtime-backed operator action classes declared in its parity scenario; it is not a proof that every future visible catalog entry has a live action
- `verify:visual:regression` is green and compares checked-in dark/light desktop/mobile baselines for every current Mission Control Next release-surface route declared in the canonical release-surface manifest; it stays read-only and any intentional baseline maintenance goes through `verify:visual:rebaseline`
- `verify:backup:roundtrip` is green and restores the full minimum operator backup set (`data/index.db`, `data/transcripts/*.jsonl`, `data/audit/*.jsonl`, `config/*.json`)
- `verify:api:compat` is green and fails on removed REST routes, removed methods/statuses, or realtime event-envelope regressions covered by its captured compatibility scenario; it is not a full response-schema diff
- `verify:runtime:truth` is green as a bespoke end-to-end proof lane for the canonical wait/resume/restart/recovery operator story in the current shell
- `verify:auth:matrix` is green as a bespoke end-to-end proof lane for the privileged control-plane route set
- `verify:code-mode:sandbox` is green and proves Code Mode sandbox metadata and fail-closed posture remain truthful; wrapper/artifact integrity stays covered by the focused Code Mode service and storage tests cited in release evidence
- `verify:agentic:governance` is green as targeted contract and behavior proof for policy/profile/override governance anchors across Chat, Cowork, Code, tools, approvals, and durable ownership
- `verify:agentic:proof` is green as aggregate targeted contract and behavior proof for retained agentic evidence, orchestration lineage anchors, and the governance/harness proof families; it is not a live end-to-end product proof
- `verify:ui:parity` is green as current-shell seeded-fact proof plus legacy compatibility-surface smoke while the legacy compatibility shell remains shipped
- `verify:memory:truth` is green as a bespoke end-to-end proof lane for TTL/lifecycle truth
- `verify:realtime:truth` is green as a bespoke end-to-end proof lane for replay-gap, compatibility-fallback, and explicit-event-envelope behavior
- `verify:architecture:metrics` is green and does not show coupling regressions relative to the accepted baseline
- governance docs pass freshness validation against this contract
- no visible primary surface still relies on raw JSON-only or raw table-only treatment as its main operator UI
- Cowork and Code are visibly and functionally distinct from Chat
- visible runtime and catalog surfaces expose readable health, diagnostics, and recovery actions
- provider, channel, MCP, backup/restore, and extension/SDK claims for the visible catalog are backed by the evidence map in [docs/1_0_RELEASE_EVIDENCE.md](./1_0_RELEASE_EVIDENCE.md) and its cited green proof lanes/supporting tests
- repo-visible PR workflows exist for the blocking release-gate lanes; branch protection still must mark them as required outside the repo

## Source of Truth Order

When claims conflict, resolve them in this order:

1. current implementation under `apps/` and `packages/`
2. [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./CANONICAL_RUNTIME_STATE_MODEL.md) for runtime ownership
3. this contract for `1.0` promise and release-scope truth
4. [docs/ENGINEERING_HANDBOOK.md](./ENGINEERING_HANDBOOK.md) for broader subsystem orientation
