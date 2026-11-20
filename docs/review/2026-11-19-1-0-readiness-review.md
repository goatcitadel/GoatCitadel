# GoatCitadel 1.0 Readiness Review

Date: 2026-11-19
Reviewed commit: `56f81fafd` (`main`, "Fix Calendar read approvals and grant reuse in Chat (#809)")
Out of scope: the signed (Authenticode) Windows installer, tag protection, the protected `release` environment, and every other public-trust signing control.

Evidence corrections were recorded on 2026-11-20. The run outcomes below apply to the reviewed revisions. [Current release-candidate checklist](../1_0_RELEASE_EVIDENCE.md#release-candidate-acceptance)

## 1. Verdict

GoatCitadel still needs release-candidate acceptance. On scheduled revision `acd0709e4`, 21 of 23 release-proof matrix jobs passed, plus the separate Trivy job, for 22 of 24 jobs overall. The passing jobs included durable recovery, runtime truth, backup round trip, mesh readiness, Windows hostile-sandbox proof, desktop and A2A. The checked security triage document listed no open item marked as a must-fix before 1.0. [Scheduled release-proof run](https://github.com/goatcitadel/GoatCitadel/actions/runs/44565653532)

The gaps fall into five groups:

1. **CI is red.** Two release-proof lanes and the UX budgets nightly have failed on `main` for several days.
2. **The gates don't protect `main`.** Almost no 1.0 gate runs on pull requests, so regressions land unnoticed.
3. **The formal release scope omits Cockpit-specific routes.** The status table describes Classic, and the default Cockpit shell already has partial surface and visual regression coverage.
4. **Some screens claim more than production does.** Citadel Vault and Ward "Require approval" are the clear cases; a few connector entries and labels are smaller ones.
5. **Version and release bookkeeping is inconsistent.** Package version, changelog, README, tags and the docs checker disagree.

None of these needs new architecture. Most items are small. The two larger ones are owner decisions: the held keys, and how Cockpit enters the release scope.

## 2. How this review was done

- The review ran on a fresh worktree at `origin/main`. Nothing was edited apart from this report, and no build, test or server was run locally.
- I read `docs/1_0_CONTRACT.md`, `docs/1_0_RELEASE_EVIDENCE.md` and `docs/1_0_RELEASE_SURFACE_SCOPE.md`, then checked them against the code.
- I read CI state with `gh`. I took the release-proof failure causes from the lane artifacts of run 44565653532 (scheduled, `main`, commit `acd0709e4`) and confirmed the auth-matrix cause still holds at `56f81fafd`.
- Three read-only reviewers swept the visible surface, security and governance, and release hygiene. I spot-checked their key file references, and one claim needed correcting (see 4.7).
- **Not done:** I rendered no UI and ran no installer, real provider, channel or sign-in. Every finding comes from source code and CI records.

## 3. What is already in good shape

These were passing hosted checks and source observations at the reviewed revisions.

- **Release-proof lanes passing on `acd0709e4`:** operator proof, durable recovery, runtime truth, surface regression, catalog parity, backup round trip, API compatibility, memory truth, realtime truth, UI parity, agentic governance and proof, mesh readiness, Code Mode sandbox, Windows hostile sandbox, desktop and A2A.
- **PR checks** (Verification Fast, CodeQL, Code Quality, Trivy, Code Mode canary) are green on the last six `main` commits.
- **Provider secrets:**
  - A key is never stored in plain text without an explicit choice. The env-file option requires that choice or `GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1`; otherwise the save fails (`apps/gateway/src/services/provider-secret-persistence.ts:329-346`, `:540-558`).
  - The UI labels that option "plaintext" (`apps/mission-control-next/src/cockpit/areas/settings/ProviderConnectionSettings.tsx:152`, `:239-246`).
- **Auth defaults:**
  - The default auth mode is `none`.
  - In that mode the Gateway refuses to start on a non-loopback address, with non-loopback or tailnet origins, or with any deployment profile except `local_dev` (`apps/gateway/src/deployment-profile-guard.ts:46-78`).
  - Docker uses token auth (`docker-compose.yaml:61`, `:74`).
- **Security triage:** `docs/security/findings-triage.md` lists no open item marked as a must-fix before 1.0. The GitHub security finding queues were outside the review.
- **No raw-JSON primary surfaces.** Every pretty-printed JSON block found sits inside a collapsed "Technical details" or `<details>` disclosure.
- **No leftover placeholder text.** There are no "coming soon", "not implemented", TODO or FIXME strings in `apps/mission-control-next/src`, `packages/mission-control-shared/src` or `packages/threaded-surface-core/src`.
- **Experimental labels are present and honest** on Journey, Improvement, Personalities, the Claude CLI tool bridge and plugin import.
- **Mesh** status in Settings shows the live readiness result and blocker count, not a fixed "ready" label.
- **Channels:** all 14 have guided setup definitions; none is `planned`.

## 4. Release blockers

### 4.1 Release proof has been red on `main` since 2026-11-17

The last green nightly ran on 2026-11-16. The last three scheduled runs failed (44129215961, 44345171140, 44565653532). In the latest one, two lanes fail.

**`verify:auth:matrix`.** The route manifest has three unclassified routes:

- `GET /api/v1/scripts`
- `PATCH /api/v1/scripts/retention`
- `GET /api/v1/scripts/:id/preview`

These came in with #806 (`apps/gateway/src/routes/scripts.ts:23`, `:32`, `:43`) and are absent from `apps/gateway/src/routes/route-access.ts`. The reviewed request path falls back to the enforced `operator` access class (`route-access.ts:556-559`) and the Scripts route also checks for a direct local connection (`scripts.ts:19-22`). The matrix failed on missing explicit classifications.

- **Fix:** add the three routes to `route-access.ts` and its test.

**`verify:visual:regression`.** One scenario fails: `cockpit-chat.mobile-dark` differs by 0.0662, over the 0.04 threshold. Every other route and theme passes.

- **Fix:** inspect the diff images in `verification-release-proof-visual-regression-artifacts` before deciding whether the change warrants a rebaseline or a product or harness fix. The tutorial in #810 landed after `acd0709e4`, so it cannot explain this capture.

The preview tag `preview-0.9.2-beta.2` also failed `verify:architecture:metrics` at `627c83d8a`. The reviewed main revision had passing architecture metrics through Verification Fast.

### 4.2 UX budgets nightly has been red for four nights

It last passed on 2026-11-15 at `ae2e5959b` and has failed since 2026-11-16 at `084af7787`.

- The job log shows a 30-second `page.waitForResponse` timeout after "Open in Work" while waiting for `GET /api/v1/observe/runs/<id>/trace` (`ux-budget-inbox-waits.mjs:202`). The timeout alone leaves the handoff cause undetermined. A later output-lock error was also logged. [UX budgets job](https://github.com/goatcitadel/GoatCitadel/actions/runs/44572111734/job/135729712743)
- The run artifact records two further failures. `ux-budgets.cockpit-inbox-question.desktop` and `ux-budgets.cockpit-inbox-question.mobile` wait on an "Open in Inbox" link, while the current question owner opens in Chat.
- `ux-budgets.cockpit.work-schedules` reports a serious axe `link-in-text-block` violation. [UX budgets artifact](https://github.com/goatcitadel/GoatCitadel/actions/runs/44572111734/artifacts/14554913225)

The nightly reports performance, interaction and accessibility regressions. Reproduce the Inbox-to-Work interaction before attributing its timeout to the product or test.

### 4.3 The 1.0 gates don't run on pull requests

Nearly every gate lane runs only in `.github/workflows/verification-1-0-release-proof.yml`. That workflow runs on a nightly schedule, manual dispatch and tags, with no `pull_request` trigger (`:1-14`).

- **Never run on a PR:** `auth:matrix`, `visual:regression`, `durable:recovery`, `runtime:truth`, `operator:proof`, `surface:regression`, `catalog:parity`, `backup:roundtrip`, `ui:parity`, `memory:truth`, `realtime:truth`, `mesh:readiness`, `agentic:governance`, `agentic:proof` and `api:compat`.
- **The exceptions:** `verify:architecture:metrics` runs on PRs inside Verification Fast (`.github/workflows/verification-fast.yml:71`), and the Code Mode sandbox lanes run in `code-mode-sandbox-canary.yml`.
- **Absent from the reviewed main workflow:** `verify:chat-evolution` was a contract gate but had no job on main at the reviewed revision. The same lane passed on preview tag `preview-0.9.2-beta.2` at `627c83d8a`. That foundation proof still held the real provider, browser secure input, Windows restart and rollback, and signed promotion rows. [Preview Chat Evolution job](https://github.com/goatcitadel/GoatCitadel/actions/runs/44678921380/job/136097346051)

This breaks the contract's own gate at `docs/1_0_CONTRACT.md:194` ("repo-visible PR workflows exist for the blocking release-gate lanes"). It is also how #806 reached `main` with auth-matrix red.

**Suggested fix:**

- Run the cheap, deterministic lanes on every PR. `auth:matrix` takes about 40 seconds, and `api:compat` and `surface:regression` are similar.
- Run `visual:regression` on PRs that touch `apps/mission-control-next/**`, `packages/mission-control-shared/**`, `packages/threaded-surface-core/**` or the visual baselines.
- Keep the long stack lanes nightly.
- Add the deterministic `verify:chat-evolution` foundation gate to main release proof and retain the separate live acceptance rows.
- Mark the PR-run lanes as required checks in branch protection. That step is outside the repo.

### 4.4 The release scope doesn't cover the default Cockpit shell

Cockpit is the default shell. At the reviewed revision, the scope table and the route release-status registry represented Classic paths. The release-surface manifest already included the default Cockpit boot and a subset of Cockpit routes from its visual manifest. The contract says every visible surface must meet the 1.0 bar.

Cockpit main navigation (`apps/mission-control-next/src/cockpit/app/routes.ts:13-24`) is Chat, Inbox, Work, Capabilities, Library, Scripts, System, plus Settings. These Cockpit pages have no ship or experimental status in the scope:

| Area | Tabs or pages without a scope row |
|---|---|
| Inbox | the whole area |
| Capabilities | Skills, Plugins, Connectors, Tools (`capabilities-tabs.ts:6-11`) |
| Work | Board, History, Schedules, Archive, Automation (`work-views.ts:2-8`) |
| System | Health, Runtime, Spend, Quality, Diagnostics, Activity, Sessions, Dashboards, Browser sessions (`system-views.ts:2-12`), `/system/runtime/workers` |
| Scripts | the whole area (#806) |
| Settings | Cockpit's General, Models, Safety, Citadel, Access, Advanced and first-run tabs |
| First run | the optional tutorial (#810; `cockpit/app/CockpitApp.tsx:22`, `:45`; `areas/settings/FirstRunArea.tsx:39`) |

The Cockpit visual manifest already exercises Chat, Inbox, Work Board, History and Schedules, several Library and System views, six Settings pages and first run. Its gaps include Capabilities tabs, Scripts, Work Archive, Automation and Kanban, System Sessions, Browser sessions and Workers, and Library Knowledge, Communications, Journey, Curator and Citadel.

The contract also omits Scripts: its navigation lists at `docs/1_0_CONTRACT.md:32` and `:36` still read `Chat / Inbox / Work / Capabilities / Library / System / Settings`.

Some Classic paths have Cockpit destinations of their own. Cockpit opens integrations in Capabilities, channels in Chat Messaging, boards in `/system/dashboards`, and projects in `/chat/projects`. Classic still serves the originals. [Cockpit route adapter](../../apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts)

**Suggested fix:**

- Record Cockpit release status against its current route owners and preserve Classic rollback coverage.
- Add deterministic behavior checks for missing launch paths. Keep existing visual scenarios and review intentional baseline changes individually.
- Update the navigation lists in the contract.

This is the largest single piece of work in the review, mostly because of the visual baselines.

### 4.5 Citadel Vault doesn't work in production but is marked ship

- **No key in production.** `vaultKey` returns `undefined` unless the dev-verification surface is on (`apps/gateway/src/services/gateway-route-composition-runtime.ts:266`). The comment reads "Keychain-held per-Citadel master keys wait for the operator's approval".
- **Marked ship anyway.** The scope marks the route `ship`, with the action "Store, reveal, and delete Citadel secrets sealed at rest under a per-Citadel keychain key." (`apps/mission-control-next/src/app/route-release-scope.ts:196-199`).
- **The UI blames the user's machine.** It says "Vault unavailable — your OS keychain could not provide a key." (`apps/mission-control-next/src/features/native-routes/library/useCitadelVaultReview.ts:223`). The real cause is a hold.
- **Undisclosed.** The contract doesn't mention the Vault.
- **Not built either:** per-Chamber Vault keys (#443). Migrations exist (`packages/storage/src/sqlite.ts:7502`, `packages/storage/src/postgres/migrations.ts:15249`, `:15257`), but no Gateway code uses them, and `docs/superpowers/plans/2026-10-19-vault-chamber-keys.md` has every step unticked.

**Decision needed:** this is one of the four open decisions from #651 (guard the Vault, guard the evidence key, count Ward approvals in the replay guard, keep the notification narrowing). Either wire the OS-keychain master key and ship, or mark the route experimental or hidden, fix the message, and disclose it in the contract.

### 4.6 Ward "Require approval" says the action will pause, but production blocks it

- **What the editor says:** "Pause for an operator decision before execution." (`apps/mission-control-next/src/features/native-routes/library/citadel-ward-model.ts:13`).
- **What production does:** for integration operator actions and outbound A2A sends, it opens no approval and blocks the action. The replay key store is hard-coded off: `const HELD_REPLAY_KEY_STORE = undefined;` (`apps/gateway/src/services/gateway-route-composition-integrations.ts:730`, used at `:752` and `:769`). That constant is the only construction site, and nothing else supplies the key.
- **Same root cause, same decision as 4.5:** Gmail send, Trello card create and local-bridge writes can't be replayed or reconciled.
- **Disclosure:** the contract does disclose the behaviour, but only inside one very long paragraph (`docs/1_0_CONTRACT.md:80`).

**Fix:** follow the #651 decision. Until the key is wired, the Ward editor should say that "Require approval" blocks integration actions and outbound A2A in this release, and the contract should list the replay gap as its own known-limits bullet.

### 4.7 The version doesn't say 1.0 and the history is inconsistent

| Place | Says |
|---|---|
| Root `package.json:4` | `0.1.0-rc.1` |
| App and package `package.json` files | `1.0.0` (extensions-sdk `2.0.0`) |
| `CHANGELOG.md` | `[Unreleased]`, then `[0.1.0-rc.1] - 2026-07-04`, then `[1.0.0] - 2026-04-11`, then older betas. No 0.9.x entries. |
| GitHub releases and tags | `0.9.0-beta.1`, `preview-0.9.0-beta.1`, `preview-0.9.1-beta.1`, `preview-0.9.2-beta.1`, `preview-0.9.2-beta.2` (2026-11-18 to 11-20), all pre-releases |
| `README.md` | `0.1.0-rc.1` badge (`:11`), RC named as the published line (`:226`, `:526`) |
| `docs/1_0_RELEASE_EVIDENCE.md:16`, `:56` | talks about attaching assets to "the `v1.0.0` GitHub release" |
| `scripts/validate-governance-docs.mjs` | requires the rc.1 badge and rejects v1.0.0 as current (`:299-312`); pins `package.json` to `0.1.0-rc.1` (`:729`); requires both `[0.1.0-rc.1]` and `[1.0.0]` headings in the changelog (`:41`) |

Correction to my earlier summary: the changelog does have version sections. The problem is that an old `[1.0.0]` entry from April sits below a later `[0.1.0-rc.1]`, while the real releases are 0.9.x betas the changelog doesn't mention.

**Decision needed:** pick the public version for the real 1.0. The April entry already uses the name `1.0.0`, so either renumber or annotate that historical section, or ship the release as `1.0.0` and explain the old entry in the changelog.

**Then make one coordinated change:**

- bump the root `package.json`
- add 0.9.x and 1.0 changelog sections
- update the README badge and release lines
- change the `validate-governance-docs.mjs` rules at `:41`, `:299-312` and `:729`
- fix the evidence doc's wording
- tag the release

I found no About or version display in the UI. Consider adding one, so users can tell which build they're on.

## 5. Should fix before 1.0

### 5.1 Connector entries that do nothing

The Cockpit connector add form (Capabilities › Connectors › Advanced) lists every productivity, automation and platform entry, labelled "(beta)" (`use-integration-settings-state.ts:103-110`, `integration-catalog-order.ts:12-17`).

These five have no operator actions in `integration-action-registry.ts`:

- `automation.voice-wake-talk`
- `automation.canvas-a2ui`
- `automation.browser-chrome-control`
- `platform.android-canvas-camera-screen`
- `platform.windows-wsl2`

Their catalog entries are at `integration-catalog.ts:1224-1346`. When an entry has no actions, the details panel renders nothing (`IntegrationConnectionDetails.tsx:118`). The contract (`:150`, and the integrations row of the scope) requires real actions or explicit blocked copy.

- **Fix:** hide these entries, or show a clear "not available yet" note. Across the catalog, 39 entries are `beta`; check that each one has actions.

### 5.2 Pages with a missing or mismatched status label

- **Workers page.** The scope marks it hidden and says it isn't counted (`route-release-scope.ts:235-242`; scope doc `:70`). Yet System › Health links to it (`areas/system/HealthOverview.tsx:100`), and it is routed at `cockpit-compatibility.ts:81`, `:272-278` and `SystemArea.tsx:53`. The page does carry blocked copy. Owner decision from the usability review (#770): hide it or label it.
- **Older Kanban view.** `/ops/kanban` is experimental (`route-release-scope.ts:300`), but in Cockpit it is offered as "Older Kanban view" (`WorkMoreViews.tsx:6`) with no Experimental label.
- **Automation designer** (`WorkAutomation.tsx:142`) has no scope status.
- **"Explore workspace"** (Classic). The palette offers it as a "Read-only delegated scope" (`composer-palette-source-builders.ts:62-73`). Choosing it only says it's temporarily unavailable (`useChatComposerPaletteActions.ts:124-125`). Hide it or show it disabled.

### 5.3 Contract text on Council and Snapshot is half stale

The contract (`docs/1_0_CONTRACT.md:85-86`) says the Chat composer doesn't offer model council or workspace snapshot yet. Classic's composer does offer both, gated on `chatFeatureAvailability`. The default Cockpit composer offers neither. The contract should say which shell it means. Separately, decide whether Cockpit needs these at 1.0.

### 5.4 Cron copy and warning

- **False copy.** Schedule › Advanced says "Path, capability and approval rules still apply." (`apps/mission-control-next/src/cockpit/areas/work/ScheduleAdvancedFields.tsx:82`). That is false for `no_agent` jobs, which run an executable with the Gateway's own privileges and environment, with no allowlist, no working-folder jail and no per-run approval (`docs/1_0_CONTRACT.md:77`).
- **No warning.** The Cockpit create form can't make `no_agent` jobs (`WorkScheduleCreateForm.tsx:7-15`); they come from the API or `cron-jobs.json`. But nothing warns about them where they are listed or switched on.

### 5.5 Stale release docs, and a checker that doesn't notice

- `docs/1_0_RELEASE_EVIDENCE.md`:
  - It says "Last updated 2026-06-01" (`:3`).
  - It describes the current navigation as `Work / Projects / Library / Ops / Settings` (`:20`), which is only Classic now.
  - It calls the Tauri host "rollback code during the Windows migration" (`:49`).
  - Its route count (49: 44 ship, 5 experimental) does match `route-release-scope.ts`, but see 4.4.
- `docs/1_0_RELEASE_SURFACE_SCOPE.md` was last updated 2026-08-14.
- At the reviewed revision, the governance checker pinned the evidence date to 2026-06-01. It checked the contract's freshness floor and the Classic route status counts. It omitted a freshness check for the scope doc and a Cockpit status comparison.
- **Contract line 107** says provider secrets "may persist in local env or config files when secure-store persistence is unavailable or disabled". The code is stricter: that only happens by opt-in. The line could say so.

### 5.6 No whole-database upgrade test from an older release

- **Today's coverage:** per-migration tests (for example `packages/storage/src/change-plan-plugin-migration.test.ts` and the `*.postgres.test.ts` files) plus `verify:storage:migration-parity`.
- **What's missing:** a fixture database from a previous release (for example the 0.9.x betas) upgraded to the current schema and then exercised. Neither SQLite nor Postgres has one.
- **Backup round trip** (`scripts/verification/lib/scenarios.mjs:2478` onward) covers only the SQLite/filesystem minimum set. Postgres backup create and verify ship, and Postgres restore is documented as an operator-run `pg_restore`, but no round trip proves them.
- **Why it matters:** the contract (`:127`) promises forward upgrades, and the PG dual-lineage schema trap has bitten before. Upgrades from earlier betas deserve a real test.

### 5.7 First run without a provider key

`FirstRunModelStep.tsx:13-16` offers "Use a cloud provider" or "Try the demo". The only local path is a pointer to llama.cpp under Models › Local AI (`:71-75`). A new user without a key can't get a real first answer from the wizard alone. Consider a guided local option (Ollama, LM Studio or llama.cpp) in that step.

### 5.8 Install and desktop pipelines aren't being run

- `desktop-preview.yml` is disabled (`disabled_manually`); its last runs on 2026-11-17 were a mix of failed and skipped.
- `release-installers.yml` last succeeded on 2026-07-04. The 2026-11-10 run was cancelled and the 2026-09-20 run failed.
- `code-mode-seatbelt-macos` last ran on 2026-09-22.
- Only the `verify:desktop` lane inside release proof is green.

Windows acceptance requires the unsigned x64 and arm64 installers built from the exact release-candidate SHA. On each architecture, save clean install and first-launch evidence, run an unattended upgrade from a supported beta with representative data and settings preserved, and exercise uninstall. Record the source and candidate versions, installer digests, outcome and any retained-data behavior.

### 5.9 Live checks still owed

From recent work, these were merged but never checked in a running app:

- the whole usability-review fix program (217 findings; report #737), including the installer, desktop host, real sign-ins and channels
- the local voice runtime on by default at install (#794): a real Windows install and upgrade never ran
- the per-channel messaging tests, the Google Desktop-app sign-in, vendor MCP, Firecrawl self-hosted settings and the "Review answer" flow in Chat
- the sidebar health line now reads "Core checks passing" in the baselines where it used to read "1 check needs review"; the cause was never established

On the installed candidate, complete first run, send a real provider turn and inspect its model and result, deliver and receive a real message through a supported test channel, and resolve a governed approval while checking the resulting effect or denial. Record outcomes and held rows separately in the release-candidate evidence.

## 6. Nice to have

- **Pin the Node version.**
  - There is no `engines` field in the root `package.json`, and no `.nvmrc` or `.node-version`.
  - Verification workflows use Node 22; release and desktop pin `22.23.4`; the remote-worker package pins `24.19.0` (`scripts/packaging/lib/remote-worker-package-files.mjs:7`).
  - `scripts/packaging/build-bundle.mjs:55` defaults the bundled runtime to `process.version`, so a local bundle built on a Node 26 machine would ship Node 26, which CI never tests.
  - **Fix:** add `engines`, add `.nvmrc` with `22.23.4`, and make the bundle build use the pinned version.
  - The open "Node 24 baseline" decision belongs here too.
- **Route classification test.** No full-app test asserts that `listMissingTrackedRouteAccessClasses` is empty; only fixture tests and the dev-verification route use it. A unit test over the real app's routes would catch 4.1-type mistakes in Verification Fast, even before the auth-matrix lane runs on PRs.
- **Loose route prefix.** `/api/v1/evidence-receipts` matches the `/api/v1/evidence` access policy only because it starts with the same text. Give it an explicit entry.
- **Security header check.** It reads only `GATEWAY_HOST` (`apps/gateway/src/app.ts:226`).
- **Missing data in Approvals.** Prior verdicts show "—" because the contract doesn't expose them yet (`ApprovalsRoutePage.tsx:931`).
- **Ward coverage gaps already disclosed** at `docs/1_0_CONTRACT.md:97`. These are post-1.0, but keep them in the release notes:
  - Utility calls without a session, embeddings, image generation and `model.tool.*` aren't ward-gated (`citadel-ward-gate.ts:20-29`).
  - A loopback proxy to a remote provider passes `route_local`.
  - Remote Chat placement isn't ward-gated at admission (`chat-feature-admission-service.ts:240-252`). It is off by default.
- **Workflow tidy-up.** `visual-rebaseline-manual.yml` is disabled while `visual-rebaseline.yml` is active. Remove the disabled one.

## 7. Owner decisions that block or shape 1.0

1. **The #651 key decisions:** guard the Vault, guard the evidence key, count Ward approvals in the replay guard, keep the notification narrowing. These decide 4.5 and 4.6.
2. **Version name and number** for the release (4.7).
3. **Cockpit's place in the release scope:** which Cockpit pages ship, which are experimental, which are hidden (4.4, 5.2).
4. **The Workers page:** hide it or label it (#770).
5. **Danger approvals:** one click or two steps in the in-place dialogs (usability review).
6. **Whether Cockpit Chat needs model council and workspace snapshot at 1.0** (5.3).
7. **Node baseline:** 22 or 24 (6).
8. **The rest of the usability-review list:** U-LB-005 and U-IN-004 need Cockpit pages; the announced-region budget is full; the webhook secret endpoint isn't built; #752 partly reverses #565; #782's questions.

## 8. Suggested order

1. **Get `main` green** (small, one PR each):
   - classify the `/api/v1/scripts` routes
   - resolve the Chat mobile-dark visual diff
   - reproduce the Inbox → Work timeout and close the two Inbox question locator failures and Work Schedules accessibility failure
2. **Stop it happening again:** run `auth:matrix`, `api:compat` and `surface:regression` on every PR, and `visual:regression` on UI PRs. Add `verify:chat-evolution` to a workflow and add a full-app route classification unit test.
3. **Make the #651 decision**, then either wire the keys or fix the Vault and Ward copy and the contract.
4. **Bring Cockpit into the release scope:**
   - add the scope rows
   - extend the manifests and baselines
   - fix the labels (Kanban, Workers, Automation)
   - handle the five dead connector entries and the "Explore workspace" entry
5. **Fix the copy and docs:** cron copy and warning, the evidence doc, the scope doc, the contract's navigation and Council/Snapshot text, and the freshness checks.
6. **Add an upgrade test** from a 0.9.x database (SQLite and Postgres) and a Postgres backup round trip.
7. **Release-candidate acceptance:**
   - settle the version and changelog, then run release proof on the exact candidate SHA
   - run clean install, first launch, unattended beta upgrade with data preserved, and uninstall using the candidate's unsigned x64 and arm64 installers
   - capture installed-candidate proof of one real provider turn, one real channel and one governed approval, including its resulting effect or denial

## Appendix A. CI evidence

| Workflow | Branch | Latest result | Notes |
|---|---|---|---|
| Verification 1.0 Release Proof | `main` (schedule) | [44565653532](https://github.com/goatcitadel/GoatCitadel/actions/runs/44565653532) failed on `acd0709e4` | 21 of 23 matrix jobs and Trivy passed. Auth-matrix and visual-regression failed. Earlier failure runs were 44345171140 and 44129215961. |
| Verification 1.0 Release Proof | `preview-0.9.2-beta.2` | [44678921380](https://github.com/goatcitadel/GoatCitadel/actions/runs/44678921380) failed on `627c83d8a` | Auth-matrix, architecture-metrics and visual-regression failed. Chat Evolution foundation job passed. |
| Verification UX Budgets Nightly | `main` | [44572111734](https://github.com/goatcitadel/GoatCitadel/actions/runs/44572111734) failed | Inbox → Work trace wait timed out. The artifact also records two Inbox question locator failures and a Work Schedules accessibility failure. |
| Verification Fast | `main` | success on the last six commits | a failure on `7935d1e5f` was not repeated |
| CodeQL, Code Quality, Trivy, Code Mode canary | `main` | success | |
| desktop-preview | — | disabled | |
| release-installers | — | last success 2026-07-04 | |

The auth-matrix failure detail comes from `diagnostics/auth-matrix.route-access-principals-*-failure.json` in the `verification-release-proof-auth-matrix-artifacts` artifact of run 44565653532. The visual failure detail comes from `review.json` in that run's `verification-release-proof-visual-regression-artifacts`.

## Appendix B. Not checked

- No UI was rendered; layout, focus and motion weren't inspected.
- No installer, desktop host, real provider, channel or sign-in was exercised.
- Not inspected:
  - the visual diff images
  - each guided channel's live auth and send
  - Cockpit Settings tabs beyond the manifest list
  - Chat › Messaging
  - the command-palette entries
  - routes registered through computed paths, beyond spot checks
- Whether Classic navigation still reaches hidden routes (`workspace-capabilities`, `citadel-capabilities`, `ops/workers`).
- The GitHub code-scanning queue beyond `docs/security/findings-triage.md`.
