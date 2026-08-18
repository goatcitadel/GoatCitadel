# AGENTS.md - Gateway

Last updated: 2026-08-15

## Scope and Precedence

This file applies to `apps/gateway/**`. The repository root `AGENTS.md` still applies; this file adds Gateway-specific rules and takes precedence only where it is more specific. A change in `packages/**` remains governed by the root or a closer file there; importing a package from Gateway does not extend this file's scope.

## Runtime Role

The Fastify Gateway is GoatCitadel's control plane and source of operational truth. It owns runtime APIs, orchestration entry points, durable execution coordination, approvals, policy enforcement, providers, memory lifecycle coordination, integrations, audit, realtime publication, and persistence coordination.

- Keep `src/main.ts` focused on process/bootstrap concerns and `src/app.ts` focused on composition, plugins, and route registration.
- Keep routes thin: authenticate, validate, bind server-owned scope, call the owning service, and shape the response.
- Put reusable public shapes in `@goatcitadel/contracts`; do not create route-local copies of shared contracts.
- Use the repositories in `@goatcitadel/storage`. Do not add inline application SQL or bypass repository transaction/locking semantics.
- Use `@goatcitadel/policy-engine`, `@goatcitadel/orchestration`, `@goatcitadel/memory-core`, `@goatcitadel/skills`, and `@goatcitadel/gateway-core` through their intended boundaries instead of cloning their rules in the Gateway.

## Canonical State and Events

Preserve the authority model in `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.

- A session is a durable conversation container; a turn is an execution trace within a session; neither is a durable run.
- Durable-run contract and persistence live in `packages/contracts/src/durable.ts` and `packages/storage/src/durable-run-repo.ts`; `DurableExecutionService` coordinates the shipped resumable Chat flow.
- Approval truth lives in the approval, approval-event, and approval-effect repositories. Explicit linkage wins over payload inference or side-table guesses.
- Realtime events are retained, pruned operator signals. Commit canonical domain state, plus an outbox record where that owner uses one, before live emission; never emit success for uncommitted state or use realtime retention as the sole historical record.
- Protected approval, run, session, task, orchestration, and auth-device events must carry explicit `eventClass`, `eventAuthority`, and `links`. Do not recover required relationships by scraping payload strings.
- Server-authored runtime authority fields cannot be supplied or promoted by callers. If an owner or record cannot be read, return `unavailable` or a truthful partial projection rather than inventing healthy state.
- Maintain revision, generation, lease, hash, scope, and compare-and-swap guards around concurrent work. A convenient last-write-wins update is not acceptable for governed state.

## Mutations, Idempotency, and External Effects

- Operator-facing JSON mutations under `/api/v1/**` use the Gateway idempotency plugin unless the route has a documented owner-specific dedupe boundary.
- Bind idempotency to the canonical actor/scope and a secret-safe payload identity. Do not persist credentials, tokens, or sensitive input through generic request hashes or error details.
- Mark a mutation committed only at the canonical transaction boundary. A response, projection, or realtime failure after commit must not make the side effect retryable.
- External effects must cross the shared side-effect/idempotency boundary and record explicit pre-boundary, completed, failed-before-boundary, or unknown-after-send truth. Never auto-retry an ambiguous post-boundary effect.
- Keep response bodies, logs, audit records, metrics, and realtime payloads bounded and secret-redacted.

## Durable Execution and Approvals

- Mission-session Chat send, retry, resume, approval wait/resume, proactive wake, recovery, and dead-letter behavior must stay on the durable execution path.
- Approval-gated resume re-enters the linked durable run. Updating an approval, UI projection, wait mapping, or orchestration side table alone must not advance execution.
- Validate the applicable workspace, session, turn, run, tool/action, dispatch generation, scope/hash, and expiry bindings before resolving or resuming governed work. Stale or mismatched authority fails closed.
- Approval explainers and UI summaries are informational. They never decide policy or replace the operator decision.
- Keep cancellation, background-attention state, steering, recovery, and execution state distinct. Presentation state must not mutate runtime authority.
- Code Mode is governed trusted-code execution with approval and immutable evidence. Preserve fail-closed isolation checks and never claim hostile-code sandboxing without fresh named proof.

## Policy, Auth, and Capability Boundaries

- Deny-wins policy, tool grants, risk gates, path jails, realpath/symlink checks, network allowlists, auth classes, and approval gates are cumulative and non-bypassable.
- Bind workspace, actor, session, project, and capability scope on the server. Do not trust caller-provided ownership or broaden scope through a convenience fallback.
- Inactive skills, candidates, proposals, add-ons, connectors, and capabilities remain inspectable-only until their governed activation path succeeds.
- Secrets belong in dedicated credential/OAuth/keychain owner flows. Keep them out of transcripts, model context, ordinary settings projections, change plans, logs, URLs, and generic persistence.
- New or changed routes must preserve auth, rate-limit, schema-validation, bounded-read, idempotency, audit, and error-redaction posture appropriate to the route class.

## Providers

- Route all model calls through `LlmService` and the existing provider abstractions. Do not let a feature call provider endpoints directly.
- Normalize messages, streaming deltas, tool calls, reasoning/control events, model metadata, usage, cost signals, cancellation, and errors at the provider boundary.
- Preserve explicit provider/model selection and diagnostics. A provider-specific capability must be capability-detected and fail truthfully; do not silently fall back to a different API style or model.
- Keep network targets allowlisted/validated and provider secrets in their owner path. Do not expose upstream raw errors when they may contain credentials, URLs, request bodies, or provider-private metadata.
- Add provider-specific branches only where wire behavior genuinely differs, and cover them with focused fake-provider/contract tests plus usage and streaming assertions.

## Memory, Context, and Provenance

- `MemoryLifecycleService` is the operator-facing owner for composition, recall, trace-candidate proposals, quality feedback, maintenance policy, learned-memory entry points, list/edit/forget/history, dedupe, scope, and write policy.
- Keep `MemoryContextService`, `ChatLearnedMemoryService`, and maintenance services as collaborators behind that owner. Do not reintroduce parallel lifecycle writes in routes or unrelated services.
- Derive memory access from canonical session truth. A `group` or `thread` session, or missing/inconsistent session truth, fails to session-only access; it never falls back to private workspace memory.
- Trace-derived or model-authored memory is proposal-only until the governed promotion/write path succeeds. Reject raw logs, raw tool output, untrusted external content, and secret-like payloads from automatic durable memory.
- Preserve source authority, citations, retrieval strategy, scope, revision/hash, quality metadata, and immutable routed-context snapshot bindings. Replay uses the frozen snapshot rather than silently re-reading changed live sources.
- Compaction must preserve decisions, constraints, approvals, effects, provenance, and unresolved uncertainty, not merely shorten text.

## Implementation and Testing

- Keep TypeScript strict and follow the repository formatter/linter. Avoid broad refactors in large composition or service files unless an owner extraction is required by the change.
- Co-locate focused tests with the changed route/service. Include negative tests for auth, scope, stale binding, duplicate delivery, redaction, and failure-before/after-commit behavior when relevant.
- For public API changes, review contracts, storage, shared clients, UI consumers, docs, migrations, and compatibility, then update every layer the change actually affects. Do not patch only the route shape or churn unaffected layers.
- Schema or repository changes require both SQLite and PostgreSQL parity where the owner supports both, migration integrity, rollback/upgrade consideration, and no mutation of user data during ordinary tests.
- Do not swallow errors. Map expected domain errors explicitly and leave enough bounded, redacted evidence to diagnose unexpected failures.

Use the smallest proof lane that establishes the change, then widen according to risk:

- Focused Vitest from the repo root: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' 'src/services/durable-execution-service.test.ts'` (replace the example path with the relevant test file)
- Gateway suite: `pnpm --filter @goatcitadel/gateway test`
- Gateway typecheck: `pnpm --filter @goatcitadel/gateway typecheck`
- Gateway smoke: `pnpm --filter @goatcitadel/gateway smoke`
- Runtime authority/state changes: `pnpm verify:runtime:truth`
- Realtime producer/read-model changes: `pnpm verify:realtime:truth`
- Durable execution or approval-resume changes: `pnpm verify:durable:recovery`
- Memory changes: `pnpm verify:memory:truth`
- Routed-context or frozen-provenance changes: `pnpm verify:routed-context:snapshots`
- Storage schema/migration changes: `pnpm verify:storage:migration-parity`
- Auth changes: `pnpm verify:auth:matrix`
- Agentic governance changes: `pnpm verify:agentic:governance`
- Public truth or owner-boundary changes: `pnpm docs:check`
- Always run `git diff --check` for the edited slice.

Report exactly which focused and named lanes ran, which did not, and any environmental or pre-existing failure separately from the changed behavior.
