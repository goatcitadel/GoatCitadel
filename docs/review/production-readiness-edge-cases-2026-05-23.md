# Production Readiness Edge Cases - 2026-05-23

This note captures lower-priority edge cases found during the broad production-readiness pass. These were not blocking enough to hold the current fixes, but they are worth tightening before a final release candidate.

The final closeout proof intentionally excluded visual regression/rebaseline lanes after the operator asked to keep visual work out of this pass.

## Visual Verification Runtime

- The full `verify:visual:regression` matrix can run longer than 10 minutes on Windows. The lane completed successfully with a longer timeout, but the default automation wrapper can report a timeout before the verifier writes its final status.
- In sandboxed agent runs, standalone `verify:visual:regression` can fail before scenario execution if the process cannot create `artifacts/verification/<run-id>`. The same visual matrix passed inside `verify:all` once artifact creation was available, so this is an environment-permission issue rather than a screenshot diff.

## Verification Cold Starts

- `verify:ui:parity` can hit a cold Vite dependency re-optimization path after lockfile changes. The route navigation timeout has been raised so the lane remains useful on fresh worktrees, but slow cold starts should still be watched because they can hide true compatibility-shell load problems.
- Mobile shell checks can be slower inside the full `verify:all` sweep than in isolated `verify:surface:regression` runs because they execute after several browser-heavy lanes. The mobile route-ready timeout now matches the visual route-ready ceiling, but repeated long waits would still be a signal to profile Mission Control Next startup/hydration on mobile viewports.

## Workspace Verification Concurrency

- The default `pnpm typecheck` gate now runs workspace package typechecks serially because the parallel recursive run produced a transient `@goatcitadel/mission-control-next` declaration mismatch while the same package passed in isolation and the serial recursive run passed. Future cleanup should remove shared declaration build races so parallel workspace typechecking is reliable again.

## Mode-Specific Fixture Drift

- Chat, Cowork, and Code visual baselines now depend on mode-specific seeded sessions. Future changes to session filtering, active-session selection, or fixture seeding should update the visual manifest and fixture together so Cowork/Code do not silently fall back to empty states.

## Notification Host Behavior

- Browser notification display and permission prompts are host-controlled. The UI now tolerates those calls failing without tripping the empty-catch guard, but embedded hosts still do not expose a user-facing remediation path when notification APIs reject at runtime.

## Provider Smoke Coverage

- The final local `verify:all` pass reported 19 provider scenarios as `not_configured`. Runtime/provider abstractions were typechecked and local contract checks passed, but release-candidate signoff should still include configured-provider smoke for the providers expected to ship in the target environment.

## Package Ownership Metadata

- `pnpm dependency:risk` still reports missing owner metadata across workspace package manifests. The dependency/native-risk report itself completed successfully, but release packaging would benefit from explicit owner/support metadata before public package publication.
