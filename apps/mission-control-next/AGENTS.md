# AGENTS.md - Mission Control Next

Last updated: 2026-08-15

## Scope and Precedence

This file applies to `apps/mission-control-next/**`. The repository root `AGENTS.md` still applies; this file adds frontend-specific rules and takes precedence only where it is more specific. Changes in shared packages remain governed by the root or a closer file there; importing them into this app does not extend this file's scope.

## Current Surface Truth

- This is the canonical GoatCitadel `1.0` Mission Control shell.
- Primary navigation is `Work / Projects / Library / Ops / Settings`. `Work` is the single Chat surface for conversation, planning, research, approvals, agentic work, artifacts, and governed code-capability context.
- `cowork` and `code` route or mode values are compatibility inputs. Keep their normalization to Chat or Ops explicit; do not recreate separate primary Cowork or Code products.
- `apps/mission-control` source is archived. Generated residue under that path is not an implementation reference or a parity target.

## Frontend Authority Boundary

Mission Control is an API client and operator projection, not a second backend.

- Read and mutate runtime state through Gateway APIs. Never write runtime files, SQLite/PostgreSQL data, config files, transcripts, audit logs, or skill directories directly from the browser.
- Reuse `@goatcitadel/contracts`, `@goatcitadel/mission-control-shared`, and `@goatcitadel/threaded-surface-core` before creating local protocol types, API wrappers, or duplicate interaction primitives.
- Keep server-owned validation, policy, scope, provider selection, cost accounting, memory admission, and approval authority on the server. Client validation may improve usability but must not be the only enforcement.
- Do not reconstruct canonical authority classes, ownership, freshness, or deep links from browser-side joins. Use Gateway-authored projections such as `RuntimeAuthorityProjectionResponse`.
- Treat Server-Sent Events as retained operator signals and refresh triggers. Use the shared event-stream derivation and topic refresh bus, then re-read the canonical owner API. Missing events or a quiet stream do not prove healthy, complete, or current state.
- Preserve the contract's exact authority classes (`canonical_record`, `derived_projection`, `retained_signal`, `inferred`, `unavailable`) and freshness values (`current`, `stale`, `missing`, `contradictory`, `unknown`). Never turn missing evidence into zero, success, clean, or healthy UI.
- Browser storage is limited to presentation preferences, explicitly documented session-local input, and the existing Gateway access/auth transport state. It is not runtime truth and must not hold new provider secrets, grants, approval authority, durable-run state, or memory records.

## Mutations, Durable Work, and Approvals

- Use the shared API clients and their auth/idempotency conventions for mutations. Do not add raw `fetch` calls when an owner client exists.
- Show optimistic UI only as a clearly transient projection. Reconcile it against canonical IDs and records; never fabricate canonical session, turn, run, approval, branch, or artifact identity.
- Durable runs own pause, retry, recovery, background continuation, cancellation, and approval-resume behavior. The UI may request an action and display its result; it must not advance execution locally.
- Approval linkage and approval-effect settlement are separate truths. Do not present an approval decision alone as proof that its follow-on action ran.
- `approval_wait_runs` is a wait mapping, not canonical run ownership. Prefer explicit approval linkage and Gateway lifecycle projections.
- Keep memory reads/writes, learned-memory promotion, routed-context admission, and document proposal/apply flows explicit and provenance-aware. Display proposal, review, stale-conflict, and immutable-version states instead of silently collapsing them into saved content.
- Dangerous actions require explicit confirmation with clear scope and consequence. Do not hide policy, auth, path-jail, capability, or approval failures behind generic success copy.

## Structure and Implementation

- Keep shell/navigation contracts centralized in `src/app/route-model.ts` and the existing route adapters.
- Put feature behavior with its owner under `src/features/`; use `src/app/` for shell composition and `src/components/` for genuinely shared local components.
- Reuse shared components and hooks before adding a near-duplicate. Extract to `@goatcitadel/mission-control-shared` only when more than this app has a real consumer.
- Keep data loading, error, empty, stale, partial, reconnecting, blocked, and unavailable states distinct.
- Avoid broad page-level state containers when a feature hook or shared API cache already owns the lifecycle.
- Keep large lists and timelines bounded or virtualized. Preserve stable keys, scroll/follow behavior, and reduced-motion expectations.
- Do not make raw JSON, raw event payloads, or unbounded tables the primary operator experience. Expert diagnostics may expose raw data as secondary, clearly non-canonical detail.

## Design and Accessibility

- Reuse the design tokens in `src/styles/mission-control-next-tokens.css` and existing primitives. Do not introduce hard-coded typography sizes or deprecated token aliases.
- Preserve the bright, legible mission-control direction: clear hierarchy, breathable density, purposeful panels, and teal/cool accents without sacrificing contrast.
- Verify desktop and narrow/mobile layouts for meaningful interaction changes. Avoid fixed widths or overlays that clip the composer, navigation, dialogs, tables, or approval controls.
- Use semantic elements, labels, keyboard access, visible focus, predictable dialog focus management, and accessible names for icon-only controls.
- Streaming, loading, success, warning, error, and interruption states must be perceivable without relying only on color. Use restrained live-region announcements that do not repeat on every render.

## Testing and Proof

Use the smallest lane that proves the behavior, then widen according to risk.

- Focused test from the repo root: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/app/route-model.unified-surface.test.ts'` (replace the example path with the relevant test file)
- App tests: `pnpm --filter @goatcitadel/mission-control-next test`
- Typecheck: `pnpm --filter @goatcitadel/mission-control-next typecheck`
- Production build: `pnpm --filter @goatcitadel/mission-control-next build`
- Design contracts: `pnpm --filter @goatcitadel/mission-control-next perf:check`
- API and operator-surface parity: `pnpm verify:ui:parity`
- Cross-surface behavior: `pnpm verify:surface:regression`
- Accessibility-sensitive changes: `pnpm verify:accessibility:smoke`
- Visual changes: run `pnpm verify:visual:regression` when practical. Use `verify:visual:rebaseline` only for an intentional, reviewed baseline change.
- Always run `git diff --check` for the edited slice.

Add or update focused tests for changed behavior. For meaningful UI changes, include browser or visual proof when practical and report any environment-dependent proof that was not run.
