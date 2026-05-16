# Backlog Closeout Status - 2026-05-15

This note supersedes older review backlog line counts and open-item summaries for the closeout work landed on May 15, 2026. Treat the live commits and verification lanes as the source of truth before reopening any finding from [docs/review/code-review-2026-05-12.md](./code-review-2026-05-12.md).

## Closed in this pass

- Gateway route composition, chat turn host wiring, Prompt Lab routing, chat tool loop, orchestration lifecycle, env policy, Settings first-run trust copy, targeted architecture collaborators, threaded citations, streaming accessibility status, and model picker metadata were implemented and validated in the closeout commits.
- The old duplicate-run and queued-start orchestration findings are closed by repository-level active-run lookup, queued-only start checks, cancellation routes, realtime/checkpoint cancellation truth, worktree release, and durable abort handling.
- The MCP, Firecrawl, Code Mode env, secrets route rate-limit, and nuclear approval-bypass findings are closed by explicit allowlists or route regressions. Do not treat the older review text as proof that those holes remain open without rerunning the current tests.
- The canonical first-run Settings path now defaults loopback bypass off, labels the provider area as `Providers & Models`, marks saved provider keys as key-on-file, and aligns `.env.example` with UI-exposed provider options.
- Threaded Chat/Cowork now has citation rendering and an `aria-live` streaming status path. Broader accessibility and focus-visible polish can continue, but the original "no citation surface" and "no streaming live status" statements are stale.

## Cleanup decisions

- `packages/threaded-surface-core/src/cowork-view-model.ts` now re-exports the shared Cowork view-model implementation instead of carrying a second source copy. The remaining `apps/mission-control/src/components/cowork-view-model.ts` copy is intentionally compatibility-only until the legacy shell is retired.
- React Three dependencies are still real runtime dependencies through `OfficeCanvas` in `packages/mission-control-shared` and the legacy compatibility shell. The direct duplicate declarations in `apps/mission-control-next` were removed because the canonical app consumes that code through the shared package.
- README release proof now points at checked-in visual baselines and local verification artifacts instead of claiming `docs/screenshots/` as generated release output.
- Commit `7f131371` is a binary-only visual rebaseline for `ops-approvals` desktop dark mode. It should be referenced in release/review notes as baseline maintenance only; it is not evidence of a product behavior change by itself.

## Still not claimed

- GoatCitadel still does not claim hostile-code sandboxing for Code Mode.
- The legacy `apps/mission-control` shell remains compatibility-only, not a second canonical implementation target.
- Broad gateway decomposition is improved but not "done forever"; future changes should keep moving large services behind focused collaborators while preserving the current architecture metrics gate.
- Prompt-pack execution and scoring are partially decomposed through policy extraction; further split work should be test-first and targeted rather than a single rewrite.

## Validation contract

For this closeout, prefer the following proof stack over stale review line numbers:

- focused tests for the touched runtime/UI module
- `pnpm --filter @goatcitadel/gateway test`
- `pnpm --filter @goatcitadel/gateway typecheck`
- relevant app/package tests and typechecks
- `pnpm docs:check`
- `pnpm typecheck`
- `pnpm verify:architecture:metrics`
- `pnpm verify:runtime:truth`
- `pnpm verify:durable:recovery`
- `git diff --check`
