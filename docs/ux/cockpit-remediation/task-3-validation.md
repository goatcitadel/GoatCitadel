# Task 3: native onboarding and guided provider setup

Source and focused tests passed on 2026-10-05 in the isolated cockpit-remediation worktree. The controller supplied bounded browser evidence on frozen source (below). Independent review remains pending; this document does not certify installed-host, provider-response, Ubuntu, release, or subview parity.

## Implemented behavior and owners

- `apps/mission-control-next/src/cockpit/areas/settings/SettingsArea.tsx` mounts the existing `FirstRunArea` for onboarding. `/settings/onboarding`, `/settings/models#onboarding`, and `/settings/first-run` render native setup. `/settings/models` retains its Providers default; activating Get started selects `#onboarding`. The centralized compatibility resolver already accepts these routes, so no alias/URL rewriting was added.
- `.../settings/ModelsSettings.tsx` renders `CockpitGuidedModelSetup` before expert controls. Advanced provider configuration mounts the five existing owners only when expanded. Closing dirty expert controls uses `useDraftLeave` and `McpDraftLeave`; Cancel preserves the open editor, discard closes it, and unrelated dirty keys do not intercept this local disclosure.
- Audited real draft registrations: `features/native-routes/settings/sections/use-provider-profile-editor.ts` uses `provider:system:<id/new>`; `use-provider-credentials.ts` uses `provider-secret:system:<id>`; `cockpit/areas/settings/use-provider-connection-editor.ts` uses `provider-endpoint:system:<id>`; `features/native-routes/settings/sections/use-provider-routing.ts` uses `provider-routing:system`. Catalog/advice have no form draft owner. The collapse filter and four parameterized cases cover these actual key forms.
- `.../settings/use-first-run-setup.ts`, `FirstRunArea.tsx`, and `FirstRunModelStep.tsx` explain current Finish eligibility and expose Continue for an existing ready default. Continue independently rereads model readiness before entering safety and ignores stale installation/scope/lifecycle results. Existing safe-rule review, fresh completion rechecks, pending/uncertain locks, and approval-owned mutation flows remain authoritative.
- `.../settings/FirstRunAdvanced.tsx` exposes Explore sample records separately from optional bootstrap defaults. The existing `FirstRunDemo` owner performs review/confirmation; opening or cancelling sample controls performs no mutation. Installation defaults remain secondary and retain their exact revision/auth consequence review.
- `.../system/SystemDiagnostics.tsx` renders the unchanged `FirstRunVerification` owner. Release, installed/provider smoke, recent run and envelope evidence stays available with its existing unavailable/unknown semantics. Setup links to `/system/diagnostics`; the primary connection sentence projects current readiness without copying release-engineering prose. A probe or catalog never proves a completed Chat response.

## Owned finding recheck

Historical imported IDs, titles, status, notes, workstream, qualifications and references are preserved. Only Task 3 implementation status and additive evidence change.

| ID | Source/test evidence |
| --- | --- |
| FR-01 | Existing guided add-key owner and unchanged-plan guards retained; Models is guided-first and experts lazy. `ModelsSettings.test.tsx`, `GuidedModelSetup.test.tsx`, `guided-model-setup-support.test.ts`. |
| FR-04 | Primary first-answer readiness wording; release evidence relocated unchanged to System diagnostics. `FirstRunArea.test.tsx`, `FirstRunAdvanced.test.tsx`, `SystemDiagnostics.test.tsx`. |
| FR-05 | Visible sample disclosure independent of defaults; cancel proves zero bootstrap writes. `FirstRunAdvanced.test.tsx`. |
| ST-11 | Models Get started mounts existing first-run content. `SettingsArea.test.tsx`. |
| FR-03 | Existing-model Continue rechecks readiness; disabled Finish exposes current prerequisites; pending/unknown completion and dirty/safety gates retained. `FirstRunArea.test.tsx`, approval-control tests, `use-onboarding-completion.test.tsx`. |
| N-03 | Native onboarding aliases and Models tab mount the same setup owner with supported model/safety/Chat steps. `SettingsArea.test.tsx`. |

## Validation

RED: initial focused SettingsArea/ModelsSettings/FirstRunArea run failed four expected assertions: two blank onboarding destinations, expert catalog mounted initially, absent Finish prerequisite. Separate existing-model Continue test failed because the button was absent. Presentation changes use proportional owner-composition tests. An exploratory `/settings/models` assertion was corrected after confirming the intentional Providers default, then covered default-plus-Get-started activation instead.

Final GREEN command (repo root):

```powershell
& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/settings/SettingsArea.test.tsx src/cockpit/areas/settings/ModelsSettings.test.tsx src/cockpit/areas/settings/FirstRunArea.test.tsx src/cockpit/areas/settings/FirstRunAdvanced.test.tsx src/cockpit/areas/system/SystemDiagnostics.test.tsx src/cockpit/areas/settings/ApprovalModeControl.test.tsx src/cockpit/areas/settings/use-approval-mode-control.test.tsx src/features/native-routes/settings/sections/GuidedModelSetup.test.tsx src/features/native-routes/settings/sections/guided-model-setup-support.test.ts src/features/native-routes/settings/use-onboarding-completion.test.tsx
```

Result: 10 files, 105 tests passed; no stderr warnings (22:11:41 local test runner time). Covers no-key saved default, add-key custody owner, unchanged plans, fresh-read failures, pending/unknown approval/completion locks, remount uncertainty, scope/lifecycle guards, demo cancellation, and relocated evidence failure states.

```powershell
node scripts/run-with-worktree-output-lock.mjs --label=task-3-final-frontend-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
node scripts/check-mission-control-next-cockpit-classes.mjs
node scripts/check-mission-control-next-cockpit-copy.mjs
node scripts/check-mission-control-next-typography.mjs
node scripts/check-mission-control-next-buttons.mjs
git diff --check
```

All exit 0. Typecheck uses the worktree output lock and existing dependency builds. Classes/copy: 301 files; typography: 68 CSS files, zero hardcoded font sizes; buttons: 484 TSX files, zero raw button-class usages. No full package suite was rerun; the controller owns the later program lane.

## Remaining evidence gates

- Controller browser proof passed for setup/provider flows and the System verification destination below. The corrected first-send wording awaits post-fix controller visual/review confirmation.
- No live provider credential writes, setup completion, demo creation, or completed Chat turn was executed. Unit mutations use fixtures only.
- Windows installed runtime, Ubuntu, external/provider, installer and release verification were not run.
- `?view=llamacpp` is preserved on native onboarding, which offers Configure llama.cpp. Automatic subview opening/parity is not certified; Task 12 owns the remaining Local AI/view-query continuity.
- No dependencies, commits, staging, publication, primary checkout, runtime profile/data/secret changes, or process cleanup. Pre-existing work is preserved.

## Controller-attributed browser evidence

Controller message after source freeze: `/settings/onboarding` dark 1440×900 renders actual setup; `/settings/first-run` light 390×844 renders setup; `/settings/models` light 1440×900 displays guided setup first with experts absent while collapsed. Actual endpoint edit → collapse review → Cancel preserved the fake draft; review → Discard closed the panel. Controller reports zero provider/settings configuration write requests, zero page errors, no horizontal body overflow, and performed visual inspection.

Artifacts in `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/`: `task-3-onboarding-desktop.png`, `task-3-first-run-phone.png`, `task-3-models-desktop.png`, `task-3-provider-collapse.png`, `task-3-provider-flow.json`. Browser fixture already has setup completed and First response Not yet. Disabled Finish on incomplete fresh setup is unit proof, not this browser scenario. This implementer did not independently execute the browser flow.

Controller subsequently verified the System diagnostics destination: `task-3-system-verification.json` and `.png` preserve full verification evidence and first response not observed. The phone entry harness timeout was a locator error (Get started is a tab, not a button), with no product defect. Corrected flow passed: Models `#onboarding` shows actual setup; Continue independently rereads then reaches safety; Connect provider returns guided Models; sample controls open without configuration writes. The sample explanation describes records that may be prepared; no Prepare call was made. Proof: `.superpowers/sdd/2026-10-05-cockpit-remediation/task-3-entry-flow.mjs`, `browser-proof/task-3-entry-flow.json`, and `browser-proof/task-3-sample-phone.png`, attributed to the controller.

## Review correction round 1

The review identified one Important truth defect: the primary model step claimed Connection verified from `setupReadiness.provider.status=ready`. Fresh source inspection of `apps/gateway/src/services/onboarding-state-service.ts:105` and `:273` confirms that readiness represents selected provider/model plus key/local endpoint configuration, without executing a probe. `FirstRunModelStep.tsx` now says Provider and model: Configured for a first send and retains the completed-Chat-answer caveat. Continue/Finish eligibility and all owner gates are unchanged; no runtime proof gate was introduced. The existing release-copy projection test also withholds Connection verified, and existing render/error assertions follow configured-state wording; no extra copy-only test was added.

Post-fix command: `& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/settings/FirstRunArea.test.tsx src/cockpit/areas/settings/FirstRunAdvanced.test.tsx src/cockpit/areas/settings/SettingsArea.test.tsx src/cockpit/areas/system/SystemDiagnostics.test.tsx` — exit 0, four files / 29 tests, pristine output at 22:15:25. `node scripts/run-with-worktree-output-lock.mjs --label=task-3-fix-1-frontend-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck` and `git diff --check` exit 0. No full package suite rerun. Source frozen again for independent re-review; earlier browser setup screenshots predate this wording correction.

## Validation correction round 2

Controller `pnpm --filter @goatcitadel/mission-control-next perf:check` initially stopped at the line-based refetch guard on `use-first-run-setup.ts:95`: `query.isFetching || checking ? "Wait for the current setup checks to finish."`. The guard interprets a fetching-dependent string branch as potentially hiding a record. This branch changes prerequisite explanation only; `state` and the existing setup record stay visible during refetch. Added the documented trailing `refetch-guard: allow` annotation on this exact line, explaining that distinction. No guard pattern, runtime eligibility, data visibility, other source, or test behavior changed.

`& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/settings/FirstRunArea.test.tsx` — exit 0, one file / 12 tests, pristine at 22:33:41. `pnpm --filter @goatcitadel/mission-control-next perf:check` — exit 0: classes/copy/refetch checks pass on 301 cockpit files; legacy imports, token drift, typography, breakpoints, buttons, scroll contracts, icon sizing, contrast and built-asset budgets all pass. Budget output reports entry JS 6720 bytes, initial CSS 0 bytes, 321 lazy JS chunks checked; these checks inspect existing built assets and are not a new production-build claim. `git diff --check` — exit 0. No other owner guard failure occurred. Source frozen again; Task 4 and other owners left untouched.
