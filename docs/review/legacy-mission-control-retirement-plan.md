# Legacy Mission Control retirement plan

**Date:** 2026-05-24
**Source:** Adjudication subagent run during 2026-05-24 ship-readiness review
**Apps in scope:** `apps/mission-control`, `apps/mission-control-desktop`
**Target:** `apps/mission-control-next` as the only Mission Control surface

## Status snapshot

- `apps/mission-control-next` is at full route parity with the legacy app. The audit (`apps/mission-control-next/docs/legacy-audit.md`, 2026-04-22) and parity matrix (`apps/mission-control-next/docs/parity-matrix.md`, 2026-05-18) both record every gateway family as mapped, implemented, and at-least-partially verified. The release-surface manifest (`scripts/verification/lib/release-surface-manifest.mjs`) names 38 next surfaces. **No surface is missing from next.** What remains is "release polish" rather than feature parity.
- `apps/mission-control` is large and self-contained: 141 page files in `src/pages/`, 110 components in `src/components/`. It is not consumed by next or by the shared packages (enforced by `scripts/check-mission-control-next-legacy-usage.mjs`). Its only live references outside its own tree are workspace recursion (`pnpm -r build/test`), the dual release-surface manifest in `scripts/verification/`, governance/coverage tooling that enumerates its paths, and documentation that names it as the compatibility shell.
- `apps/mission-control-desktop` is structurally separate from the legacy web app. It is a Tauri shell that iframes whatever UI the launcher exposes on `targetUrl`. The launcher already resolves to `@goatcitadel/mission-control-next` by default (`scripts/lib/ui-target.mjs`, `scripts/dev.mjs:8`). The desktop wrapper does not import any source from `apps/mission-control` or `apps/mission-control-next`. **Whether `mission-control-desktop` retires with the legacy app is a separate decision** - see open questions.

## Parity matrix

Status keys: `ship` (release polish-ready), `polish` (needs release polish per `NEXT_RELEASE_SURFACE_STATUS_BY_SLUG`), `experimental`, `native` (next-native page already), `threaded` (next renders via `MissionThreadedControllerHost` in `@goatcitadel/threaded-surface-core`), `n/a` (never existed in that app).

| Surface | Legacy (apps/mission-control) | Desktop (Tauri shell) | Next (apps/mission-control-next) | Gap to retire legacy+desktop |
| --- | --- | --- | --- | --- |
| Chat | `pages/ChatPage.tsx` (threaded via shared core) | Iframe to whatever UI launcher exposes | `/chat` threaded, status `ship` | None. Next is the canonical chat surface. |
| Cowork | `pages/AgentsBoardPage`, `pages/TasksPage`, `pages/AssemblyPage` | Same | `/cowork`, `/cowork/tasks`, `/cowork/board`, status `polish` x3 | Polish only. No missing surface. |
| Code | `pages/ChatPage.tsx` (code-mode), `components/CodeWorkbenchPanel.tsx` | Same | `/code` threaded with `CodeWorkbenchPanel` (next-native), status `polish` | Polish only. |
| Projects | n/a (no first-class projects surface in legacy) | Same | `/projects` native, status `polish` | None to retire; this is net-new in next. |
| Library (agents / skills / capabilities / memory / knowledge / files / artifacts / prompt-packs / curator) | `AgentsHubPage`, `AgentsCatalogPage`, `SkillsPage`, `MemoryPage`, `FilesPage`, `ArtifactsPage`, `PromptLabPage` | Same | 9 native routes, statuses mixed (5 ship, 3 polish, 1 experimental) | None for ship-status routes. Library-curator is experimental in next - acceptable since legacy doesn't have it either. |
| Ops (approvals / activity / sessions / schedules / improvement / notifications / costs / runtime / diagnostics / kanban) | `ApprovalsPage`, `TimelinePage`, `SessionsPage`, `CronPage`, `ImprovementPage`, `HealthPage` | Same | 10 native routes, statuses mixed (5 ship, 3 polish, 2 experimental) | None for ship-status routes. |
| Settings (general / providers / personalities / access / permissions / budget / onboarding / runtime / workspaces / addons / integrations / channels / mcp / tools) | `GeneralHubPage`, `SettingsPage`, `RuntimeHubPage`, `WorkspacesHubPage`, `IntegrationsHubPage`, `OnboardingPage`, `McpPage`, `ChannelSetupPage`, `ToolsPage` | Same | 14 native routes, statuses mixed (8 ship, 4 polish, 2 experimental) | Polish only. |
| Office / OfficeLab / LiveFeed / PromptLab / Dashboard / System | `OfficePage`, `OfficeLabPage`, `LiveFeedPage`, `DashboardPage`, `SystemPage`, `LegacyFrontendA` | Same | No direct equivalents in next | **Confirm with owner**: these legacy pages do not appear in `mission-control-next/src/app/route-model.ts`. If they are intentionally dropped (experimental/prototype surfaces not part of the 1.0 product), no gap. If any of them is still needed, port required before legacy retirement. |
| Pixel-office (`apps/mission-control/src/pixel-office/`) | Present | n/a | Not present | Same as above - confirm intent before deleting. |

**Rollup:** 5 of 9 main surface families are at ship-quality parity in next (Chat, Library subset, Ops subset, Settings subset, plus Projects which is net-new). 3 surface families have polish gaps that are tracked in `NEXT_RELEASE_SURFACE_STATUS_BY_SLUG` but not blocking. 1 group (Office/OfficeLab/LiveFeed/Dashboard/System/Pixel-office) is unmapped and needs an owner decision before deletion.

## Shared code disposition

`packages/mission-control-shared` and `packages/threaded-surface-core` are NOT slated for retirement. They are how next and legacy share code, and next will continue to consume them after legacy is gone. Specific findings:

- **Owned by shared, used only by legacy (candidates for cleanup AFTER legacy retires):** `packages/mission-control-shared/src/components/CoworkCanvasPanel.tsx`, `packages/mission-control-shared/src/components/CodeWorkbenchPanel.tsx` (next has its own `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.tsx` and `CoworkPanel.tsx` - the shared copies may be unused once legacy is gone, but this needs a grep pass at retirement time, not now). `packages/mission-control-shared/src/components/ConfigureHubLayout.tsx`, `EmbeddedPageChrome.tsx`, `LegacyFrontendA` etc. would be similar.
- **Owned by shared, used by both legacy and next (KEEP):** `state/ui-preferences`, `state/effects-mode`, `state/event-stream-status-store`, `state/refresh-bus`, `api/*`, `hooks/*`, `components/chat/*` (consumed by next's `ThreadedTimeline.tsx` and others), `components/ConfirmModal`, `components/StatusChip`, `components/WorkbenchFileTree`, `components/WorkbenchMonacoEditor`, `components/GeneratedArtifactViewer`, `components/MonacoDiffEditor`, `components/AgenticRuntimeVisibilityPanel`, `content/shell-command-explainer`, `pages/prompt-lab/*` (next's `PromptPacksWorkbenchPage` imports from here), `pages/chat/*` (helpers only - no React component imports remain after the April pass).
- **`@goatcitadel/threaded-surface-core` (KEEP):** Imported by next in 10 files, by legacy in 3 (`ChatPage.tsx`, `ChatComposerShell.tsx`, `MissionControlActiveSessionSurface.tsx`). The legacy app's imports go away when the legacy app retires, but the package stays because next is the primary consumer.
- **Verification step at retirement time:** after archiving `apps/mission-control/`, run a dead-code sweep against `packages/mission-control-shared/src/` to find components whose only remaining importers are tests inside the shared package itself or no importers at all. Candidates from a quick scan: `CoworkCanvasPanel.tsx`, the duplicate `CodeWorkbenchPanel.tsx` in shared (next has its own), `ConfigureHubLayout.tsx`, `EmbeddedPageChrome.tsx`. **Do not delete these proactively** - they may still be referenced by something else.

## Desktop-specific concerns

- The Tauri desktop wrapper (`apps/mission-control-desktop`) is structurally decoupled from the legacy web app. It:
  - Loads `index.html` containing an `<iframe id="mission-control-frame">` pointing at `targetUrl`
  - Calls the launcher (`bin/goatcitadel.mjs`) via `launch_runtime` / `read_runtime_status` Tauri commands
  - The launcher resolves the UI target via `scripts/lib/ui-target.mjs` which defaults to `@goatcitadel/mission-control-next`
  - Adds Tauri-only features: native tray (`menu`, `TrayIconBuilder`), single-instance plugin, notification plugin (with browser-Notification fallback), approval watcher streaming from the gateway, deep-link routing into the iframe via `frame.src = ${uiUrl}/ops/approvals?approvalId=...`
- **If next is the desktop target too (likely):** the Tauri shell SHOULD KEEP LIVING. It is the desktop packaging path. What should change is the framing - it's currently named "mission-control-desktop" alongside the legacy "mission-control" app, which reads like a legacy companion. Consider renaming or scoping the README to make clear it wraps next.
- **If next is web-only (no native desktop target):** the entire `apps/mission-control-desktop/` tree retires along with legacy. This kills `pnpm desktop:dev`, `pnpm desktop:build`, `pnpm package:desktop`, `pnpm package:windows*`, `scripts/verify-desktop.mjs`, `.github/workflows/release-installers.yml` (or strips its Tauri steps), and `scripts/packaging/build-windows-*.mjs`. The Rust crate (`src-tauri/`) is the largest single artifact to delete.
- **Capability gaps in next if desktop dies:** approval native notifications, system tray, deep-link routing on notification click, single-instance enforcement. If next is browser-only, operators lose these. If next ships under a PWA + service worker model with the Web Notifications API + Push, partial replacement is possible but not equivalent. **This is the question for the owner.**

## Kill order (phased)

Each phase has prerequisites and a verification step. Do not advance to the next phase until the prior phase verifies green.

### Phase 0 - Decisions (BEFORE any code change)

- Owner answers: does desktop wrapper survive? (See open questions.)
- Owner confirms: are Office / OfficeLab / LiveFeed / Dashboard / System / Pixel-office intentionally dropped from 1.0? If any survive, port to next FIRST.
- Owner confirms: are the 16 `needs_release_polish` next surfaces acceptable for shipping next as sole Mission Control, or must they reach `ship` status first?
- **Verification:** decisions captured in this doc as updates; no code touched.

### Phase 1 - Quiet the build pipeline

Goal: stop running CI/build/test/lint on the legacy app without removing source yet, so we can validate that nothing breaks.

1. Remove the legacy app from workspace recursion targets:
   - In `apps/mission-control/package.json`, set `"private": true` (already private by default in pnpm if not explicitly set, but verify), and either add a no-op `build` and `test` or use `pnpm-workspace.yaml` exclusion. Cleaner approach: keep workspace inclusion but stop calling its build/test scripts from `pnpm -r build` / `pnpm -r test` - this requires either an explicit filter list in the root scripts, or moving the package to a filterable category.
   - Alternative (recommended for first move): change root `build` to `pnpm --filter "!@goatcitadel/mission-control" -r build` and same for `test`. This is one-line and reversible.
2. Mark in `package.json` that `dev:ui:legacy` is deprecated (or remove it after announcing).
3. Confirm CI workflows already pin `@goatcitadel/mission-control-next` for the surface/visual/operator-proof lanes (they do - see `verification-surface-regression.yml:68`, `verification-visual-regression.yml:68`, `verification-1-0-release-proof.yml:75`, `verification-agentic-code-mode.yml:92`).
4. Update `scripts/coverage-collect.mjs` to drop `"apps/mission-control/src/"` and `scripts/typescript/run-ts7-workspace.mjs` to drop `apps/mission-control/tsconfig*.json` from the workspace list.
5. Drop `apps/mission-control` from `scripts/verification/lib/review.mjs` surfaces set.

**Verification for Phase 1:**
- `pnpm install --frozen-lockfile && pnpm build && pnpm test` succeeds without building/testing legacy.
- `pnpm verify:fast` succeeds.
- `pnpm verify:visual:regression` succeeds against next.
- `pnpm dev` boots only next.
- Manual: hit a few next routes (chat, cowork, code, settings) - they render normally.

### Phase 2 - Remove route discoverability

Goal: ensure no marketing / docs / launcher path can land users on legacy.

1. Remove `dev:ui:legacy` script from root `package.json`. Remove `LEGACY_UI_PACKAGE` constant and the override branch from `scripts/lib/ui-target.mjs` (force-resolve to next).
2. Remove `GOATCITADEL_UI_PACKAGE=@goatcitadel/mission-control` fallback paths from `bin/goatcitadel.mjs` and `scripts/dev.mjs` (currently they accept any env value; close that door or whitelist next only).
3. Update README:
   - `## Current Product Truth` line `apps/mission-control is compatibility-only` -> remove the line or replace with "retired in 1.x".
   - `pnpm dev` paragraph: remove the `pnpm dev:ui:legacy` mention.
4. Update `docs/1_0_RELEASE_EVIDENCE.md` to drop the "compatibility-only" framing - this file's governance script (`scripts/validate-governance-docs.mjs:439`) explicitly polices the wording, so the governance script needs a paired update.
5. Drop `RELEASE_SURFACE_MANIFEST` (legacy 15-surface manifest) from `scripts/verification/lib/release-surface-manifest.mjs`. Update `scripts/validate-governance-docs.mjs:474` (`if (RELEASE_SURFACE_MANIFEST.length !== 15)`) and the scenarios test (`scripts/verification/lib/scenarios.test.mjs`) accordingly.

**Verification for Phase 2:**
- `pnpm docs:check` passes (this runs governance validators including `validate-governance-docs.mjs`).
- `pnpm verify:fast` passes.
- Manual: `pnpm dev` boots, only next is reachable; trying `GOATCITADEL_UI_PACKAGE=@goatcitadel/mission-control` no longer works.
- README + `docs/1_0_RELEASE_EVIDENCE.md` no longer cite the legacy app as a live surface.

### Phase 3 - Archive the source

Goal: remove the legacy app from the working tree.

1. Move `apps/mission-control/` somewhere archival. Options (owner pick):
   - Delete outright. Cleanest; git history is the archive. Recommended.
   - Move to `archive/apps/mission-control/` with a `.gitignore`d exclusion from workspace globs. Adds noise.
   - Tag a `legacy-retired` release commit before delete, then delete. Recommended companion to option (a).
2. Delete `apps/mission-control/` from `pnpm-workspace.yaml` if it was explicitly listed (it's covered by `apps/*` glob today - so deleting the directory is sufficient).
3. Remove all path references in build/scripts:
   - `scripts/trivy-scan.mjs`: drop `apps/mission-control/coverage`, `apps/mission-control/dist`, `apps/mission-control/dist-node`
   - `scripts/validate-governance-docs.mjs`: drop `apps/mission-control/package.json` from `requiredFiles`; drop the line-439 wording check
   - `scripts/coverage-collect.mjs` (already handled in Phase 1)
   - `.github/workflows/security-trivy.yml`: drop legacy paths from the skip list
   - `.github/workflows/verification-1-0-release-proof.yml`: same
   - `.github/workflows/verification-catalog-parity.yml`: already excludes legacy from triggers; no change
4. Remove the IF check in `packages/orchestration/src/engine.test.ts:131-146` if its fixture references `apps/mission-control` paths in a way that would mislead future readers; it's only test-data strings, but worth scrubbing for cleanliness.

**Verification for Phase 3:**
- `pnpm install` succeeds with no missing-workspace errors.
- `pnpm build && pnpm test` clean.
- `pnpm docs:check && pnpm verify:fast && pnpm verify:visual:regression && pnpm verify:surface:regression` all green.
- `git grep "apps/mission-control[^-]"` returns only history-only mentions (docs/superpowers/plans archive, release notes, etc.) - none in live scripts/configs/source.

### Phase 4 - Extract or kill leftover shared code uniquely owned by legacy

Goal: only run AFTER Phase 3 ships. With legacy gone, identify shared code that now has zero importers.

1. Run `grep` (or a ts-prune-style tool) against `packages/mission-control-shared/src/` for unused exports.
2. Expected candidates from current scan: `components/CoworkCanvasPanel.tsx`, `components/CodeWorkbenchPanel.tsx` (next has its own version under `features/threaded-surface/workflow/`), `components/ConfigureHubLayout.tsx`, `components/EmbeddedPageChrome.tsx`. **None of these should be deleted by inspection - run the importer scan first.** Some may still be referenced from tests or stories.
3. Run the same check against `packages/threaded-surface-core/src/`. This package is much smaller; expected to have no dead code.
4. For each genuinely-dead file: delete, run `pnpm --filter @goatcitadel/mission-control-shared typecheck && pnpm --filter @goatcitadel/mission-control-shared test`, repeat.

**Verification for Phase 4:**
- Shared package builds and tests stay green after each deletion.
- `pnpm verify:fast` stays green.
- Final commit is a small dead-code cleanup, not a feature change.

### Phase 5 - Desktop disposition (in parallel with or after Phase 3, depending on owner answer)

**If owner decides desktop stays alive as a next wrapper:**
1. No code change to `apps/mission-control-desktop/`. It already targets next via the launcher.
2. Update `scripts/verify-desktop.mjs` to assert the launcher's `uiUrl` resolves to the next app.
3. Update README / desktop docs to make clear desktop wraps next, not legacy. Consider renaming the npm package from `@goatcitadel/mission-control-desktop` to something neutral (or leave it; the name is fine if the docs are clear).

**If owner decides desktop is dropped entirely:**
1. Remove `apps/mission-control-desktop/` directory.
2. Remove `pnpm desktop:dev`, `pnpm desktop:build`, `pnpm package:desktop`, `pnpm package:windows`, `pnpm package:windows:bootstrap` from root `package.json`.
3. Remove `scripts/packaging/build-desktop.mjs`, `scripts/packaging/build-windows-native-installer.mjs`, `scripts/packaging/build-windows-bootstrap.mjs`.
4. Remove `scripts/verify-desktop.mjs`.
5. Remove `.github/workflows/release-installers.yml` or strip its Tauri job; leave web build path if any.
6. Update README quickstart to drop desktop references.
7. Notify operators: native tray + native notifications go away with this; recommend running next in browser.

**Verification for Phase 5 (stays-alive path):**
- `pnpm desktop:dev` boots and the Tauri window iframes the next dev server.
- `pnpm verify:desktop` (cargo check, cargo test, launcher status JSON) passes.
- Manual: trigger an approval; native notification fires; clicking the notification deep-links into the next `/ops/approvals` route.

**Verification for Phase 5 (drop path):**
- `pnpm install && pnpm build && pnpm test && pnpm docs:check && pnpm verify:fast` all green with desktop gone.
- No lingering references to `apps/mission-control-desktop` anywhere except history.

## Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| 1 | The 16 next surfaces marked `needs_release_polish` are in fact regression-quality - removing legacy strands operators on a UI that has visible-but-incomplete surfaces. | High | Phase 0 gate: owner explicitly accepts the polish backlog before Phase 1. Capture the polish backlog in a separate doc with owners and dates. |
| 2 | Legacy "Office", "OfficeLab", "LiveFeed", "Dashboard", "System" pages, and the `pixel-office/` directory have no next equivalent. If any of these are still in use (even by a single internal operator), removing legacy is destructive. | High | Phase 0 owner sign-off. Search internal docs/messaging for any "use the office page" guidance; ask owner. If anything is in use, port to next FIRST. |
| 3 | Desktop wrapper might be retiring or not - the answer changes the work substantially. If we retire legacy assuming desktop stays, but desktop also retires, we waste a phase. If we retire legacy and keep desktop, but desktop is actually expected to die in 1.0 ship, we ship dead code. | High | Phase 0 question to owner. No code change until answered. |
| 4 | `scripts/packaging/build-bundle.mjs` hardcodes the packaged path as `app/mission-control/dist`. This path is just a packaging alias, not a legacy reference - but the directory name `mission-control` reads like the legacy app's name. After legacy retires, future engineers will be confused. | Low | Optional cleanup in Phase 3: rename the packaged dir to `app/ui/dist` or `app/mission-control-next/dist` to remove the alias drift. Or document the alias clearly in the bundle script. |
| 5 | `packages/mission-control-shared` contains chunks that look duplicated with next code (e.g. `CodeWorkbenchPanel.tsx`, `CoworkCanvasPanel.tsx`). If shared's copies are still imported by legacy AND next via different import paths, retiring legacy could leave dead duplicates that confuse maintenance. | Medium | Phase 4 dead-code sweep. Do not preemptively delete. |
| 6 | Visual baselines under `scripts/verification/visual-baselines/` may still include legacy-app captures. After retirement these can be rebuild-out-of-sync until the next visual baseline is regenerated. | Medium | After Phase 3, run `pnpm verify:visual:rebaseline` to regenerate from the next-only manifest. |
| 7 | `pnpm-lock.yaml` will lose entries for legacy-only deps (react-reflex, three, @react-three/*, react-arborist if not used by next). Net positive (smaller lockfile), but a noisy diff. | Low | Expected; commit cleanly in Phase 3. |
| 8 | `scripts/verification/lib/release-surface-manifest.mjs` `RELEASE_SURFACE_MANIFEST` (legacy 15-surface) is referenced by `validate-governance-docs.mjs:474` which asserts `length !== 15`. Removing the manifest without updating the validator breaks docs:check. | Medium | Update both together in Phase 2. |
| 9 | The legacy `apps/mission-control/src/api/client.ts` is what `scripts/verification/lib/review.mjs:116` adds to the review surfaces. If any review/proof generator pulls that file's metadata, it'll break. | Low | Verify in Phase 1: drop the line and run `pnpm verify:review`. |
| 10 | `scripts/validate-governance-docs.mjs:439` polices that docs cite `apps/mission-control` only with "compatibility-only" labeling. After retirement this rule must invert (cite as "retired") or be deleted. | Medium | Update in Phase 2 alongside the doc text changes. |

## Open questions for owner

1. **Desktop wrapper disposition.** Is `apps/mission-control-desktop` (the Tauri shell) part of the 1.0 ship surface as the native packaging path for `mission-control-next`, or is it retiring alongside the legacy web app? The two retirements are independent code-wise (desktop has no source coupling to the legacy web app), but they share product context.
2. **Legacy-only surfaces.** Are `OfficePage`, `OfficeLabPage`, `LiveFeedPage`, `DashboardPage`, `SystemPage`, `LegacyFrontendA`, and the `pixel-office/` tree intentionally dropped from 1.0? If any operator workflow still depends on them, they must be ported to next BEFORE legacy can retire.
3. **Polish vs ship.** The next manifest tags 16 of 38 routes as `needs_release_polish` and 5 as `experimental`. Are you okay shipping next as the sole Mission Control with that posture, or must polish-tagged routes reach `ship` first? This is the gate between Phase 0 and Phase 1.
4. **Archive vs delete.** When `apps/mission-control` retires, do you want it deleted outright (git history is the archive) or moved to `archive/apps/mission-control/`? The delete-outright path is recommended.
5. **Public-facing comms.** Do users / docs / changelog entries need a "legacy compatibility shell retired in version X" notice, or is this a quiet internal cleanup?
