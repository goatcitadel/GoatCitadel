# Capabilities Hub Phase 4 (Plugins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Plugins tab to the Capabilities area. A plugin is a bundle of skills, connectors, tool-group presets, observe-only hooks and prompt packs that runs no code of its own. It installs from GoatCitadel's built-in list, a Git repository or a folder, after GoatCitadel has checked every piece, behind one confirmation, and uninstalling removes exactly what it added. Arena, the add-on machinery and integration plugins are removed first.

**Architecture:**
- **Removals come first** (PRs 4a and 4b). They free GatewayService lines, which sit exactly at the limit today, and they clear the word "plugin" for its one new meaning. Add-ons and integration plugins own no database tables: add-ons keep a JSON file outside the database, and integration plugins keep one `system_settings` row, which a migration deletes.
- **The manifest** is `goatcitadel-plugin.json`, a zod schema in `@goatcitadel/contracts` that the extensions SDK re-exports for authors. It replaces the capability-pack manifest. The `addon`, old `plugin` and `runtime_preset` kinds don't exist in it. Five piece kinds exist: `skill`, `connector`, `tool_group_off`, `hook` and `prompt_pack`. Anything that would loosen governance, carry feature flags or steer chats outside a skill is refused at inspection, with a named reason.
- **The Gateway fetches, never the browser.** A Git source is fetched at a pinned commit with the hardened clone the Skill Hub already uses. A folder is copied. A built-in plugin is a folder shipped under `plugins/`. Every source becomes an immutable, content-addressed snapshot under the data folder, and inspection and install read only that snapshot.
- **Inspection** checks every piece with its owner's normal check. Skills go through a Skill Hub review of the skill's folder inside the snapshot, connectors through the shipped connector list, hooks through the hooks address rules, and prompt packs through the prompt-pack parser. Install enables only when every piece passes.
- **Install and uninstall are Change Plans** (`plugin_install`, `plugin_uninstall`) on the Capabilities surface. They follow #572's skip the way Phase 1's `connector_install` does. The install plan adds connectors, tool-group holds, hooks and prompt packs. Skills then go through their own two Skill Hub steps from the panel, exactly as Phase 3's one-step install does, so HX-402 holds.
- **Ownership** is a Gateway-owned record per installed plugin, in `system_settings` (`capability_plugins_v1`), listing every piece and whether the plugin added it. Owners refuse edits to a plugin's pieces. A plugin's "turn a group off" is its own deny-wins hold, not an edit to the operator's switch, so uninstalling releases only that hold.

**Tech Stack:** TypeScript, React 19, TanStack Query, Tailwind (cockpit tokens), Fastify, zod 4, Vitest, node:test (storage), SQLite and Postgres storage, the system `git` binary (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md`. The relevant sections are "Plugins tab", "Decided by the operator", "Claude's calls", "Constraints" and "Delivery order" item 4. Phases 1 to 3 (`2026-10-25-capabilities-hub-phase-1.md`, `2026-10-27-capabilities-hub-phase-2.md`, `2026-10-28-capabilities-hub-phase-3.md`) built the area this plan extends.

**Measured facts:** `.superpowers/sdd/2026-10-30-capabilities-hub-phase-4/phase4-facts.md` (gitignored, in the planning worktree), with three survey files beside it holding file:line evidence for every claim below. All were measured on `main` at `12a238ea2`.

## Questions for the operator

Each question has a recommendation. Approving the plan as recommended answers all six.

**Q1. Which plugins ship built in?**
- **Recommended (A):** one, "Browser checks". It holds the Playwright connector and the browser-QA skill, the only pieces of the old `browser-qa-operator` pack that aren't feature flags. The two Cowork-era packs don't come back.
- **Alternative (B):** none at launch. The Plugins tab then offers only Install from Git and Add from folder, and Task 20 is dropped.

**Q2. Which folders can a plugin install from?**
- **Recommended (A):** any folder you type, on the computer GoatCitadel runs on. GoatCitadel copies it first and installs from the copy. It refuses links, oversized trees and the `remote_hardened` profile.
- **Alternative (B):** only folders inside GoatCitadel's own `plugins` folder in its data folder.

**Q3. Which connectors can a plugin add?**
- **Recommended (A):** only connectors from GoatCitadel's own list, named by template id. They install exactly as Phase 1's Install does.
- **Alternative (B):** also a remote MCP server address that the plugin names, with its host allowlisted at install. That adds a connector shape and its checks to Tasks 10 and 16. Local commands stay out either way.

**Q4. What happens to a plugin's skills on uninstall?**
- **Recommended (A):** they are revoked through the Skill Hub, so the AI can never use them again. Their files stay, and the Skills tab shows them as "Removed with <plugin>" until skill removal exists, which is Phase 3's open "Remove" follow-up.
- **Alternative (B):** build real skill removal now: a Skill Hub step that deletes the installed copy, which also gives the Skills tab a Remove button. That adds about two tasks, plus a storage change if the operation kinds are constrained in the database.

**Q5. What should the Citadel and workspace "Plugins" selection be called?** It holds integration connections.
- **Recommended:** "Integrations", the name of the Advanced setup section where those connections are made.
- **Alternative:** "Connected apps".

**Q6. Do hooks ship in Phase 4?**
- **Recommended (A):** yes, as observe-only signed webhooks. The install panel asks you for each hook's signing secret, which goes straight into the key store. Only event details, never message text, go to the plugin's address, and that address is added to the hooks allowlist when you keep one.
- **Alternative (B):** not yet. Inspection refuses hook pieces with "Hooks aren't supported in plugins yet", and the hook parts of Tasks 15, 16 and 18 drop out.

## Decided without asking (check these)

- **Arena's leftovers stay where they are.** The add-on folder (`<GoatCitadel home>/addons/`, with `arena.db`) and a running Arena process are left alone. GoatCitadel doesn't kill a recorded process id, which could belong to something else by now. The release note says where the files are and how to stop Arena.
- **Integration plugin records are deleted by a migration.** It removes the `integration_plugins_v1` setting in both databases. The plugin package files under the data folder stay, and the release note names them. The four `plugin_*` columns on `integration_connections` stay, are never written again, and stay readable for old rows.
- **Author form hints go with integration plugins.** The "extension setup guidance" in channel and integration forms had no other source. `verify:channels:guided` drops its plugin step.
- **The plugin tool-override service is removed.** It sits in the tool path, but nothing ever registered an override. The stored `"plugin"` runtime-owner values stay valid for old chat records.
- **The extensions SDK becomes 2.0.0 in the repo.** It keeps `effective-tools` and gains the plugin manifest validator and a `goatcitadel-plugin-preflight` command. It loses the add-on and integration-plugin helpers. Publishing stays your call; the docs say 1.0.0 is the last published version until you tag 2.0.0.
- **A plugin's "turn a group off" is its own hold.** The Tools row reads "Off · held by <plugin>", and the switch is disabled with that reason. Uninstalling releases only that hold, so a group you switched off yourself stays off.
- **Approval presets apply only to the plugin's own connectors:** "Everything asks" or "Reads free, changes ask" (the default). "Nothing asks" is refused, as the spec says.
- **A piece that is already there stays.** A connector you saved yourself is listed as "Already installed. Stays when you uninstall." The plugin doesn't own it.
- **Git sources use the forges Import from Git trusts:** GitHub, GitLab, Bitbucket and Codeberg. The pin is the exact commit inspected, and an optional field takes a commit, branch or tag. Updating means uninstall then install; an Update button is a follow-up.
- **The pin shows in the panel.** It reads "Pinned to commit `abc1234`" (7 characters), with the full hash in Technical details. This is the one place a commit appears outside Technical details, because the spec asks the panel to show the pin.
- **With the skip setting off, install asks 1 + 2 × (number of skills) times:** once for the plugin, then each skill's install and switch-on. Every approval opens in the panel (the #625 dialog). With the setting on, nothing asks.
- **Plugin hooks join the active workspace,** like every workspace-bound piece on this page (spec, Constraints).
- **Pieces a plugin added can still be switched on and off, and its connectors can still sign in.** Edits and removal of individual pieces are refused, with "From <plugin>. Uninstall it to remove this."
- **A connector host the plugin added stays allowlisted after uninstall,** the same as Remove on the Connectors tab today.
- **No tab counts yet.** No Capabilities tab has a count, and `AreaTab` has no field for one.
- **The Add-ons & packs page, capability-pack staging, the Cowork-era packs and the `capability_pack` adapter go in PR 4e,** once the Plugins tab replaces them. Old `capability_pack` plans stay readable; asking to undo one answers "Capability packs were replaced by plugins".
- **Uninstalling deletes a plugin's prompt packs with their tests, runs and scores.** Left behind, they would point at a pack that no longer exists.

## PR boundaries

Each PR is cut from a freshly fetched `origin/main` in its own worktree (superpowers:using-git-worktrees) and merged before the next one starts.

| PR | Tasks | Ships |
|---|---|---|
| 4a | 1–4 | Arena and the add-on machinery removed across Gateway, contracts, cockpit, Classic, shared client, proof and docs. Settings › Advanced keeps only "Capability packs" until 4e. |
| 4b | 5–9 | Integration plugins, author form hints and the plugin runtime list removed. The never-used tool-override service removed. The `integration_plugins_v1` migration. The SDK trimmed to 2.0.0. The Citadel/workspace selection relabelled. |
| 4c | 10–13 | Gateway only: the plugin manifest, sources and snapshots, Skill Hub review of a plugin's skill, inspection, the plugin store and the read routes. |
| 4d | 14–19 | Gateway only: the two Change Plan kinds and their migration, ownership and read-only enforcement, the install and uninstall plans, skill pieces, prompt-pack deletion and docs. |
| 4e | 20–26 | The built-in plugin, the Plugins tab with its install and plugin panels, "From <plugin>" labels on the other tabs, retiring capability packs and the Add-ons & packs page, and proof. |

## Global Constraints

- Build each PR from a freshly fetched `origin/main`. This plan was written against `12a238ea2`.
- **The Gateway owns every read and write.** The cockpit renders `/api/v1/capabilities/plugins*` and acts through it. It never fetches a source, parses a manifest, decides whether a piece passes or can be installed, or joins plugin records with other catalogs (`apps/mission-control-next/AGENTS.md`, "Frontend Authority Boundary").
- **Plugins run no code inside GoatCitadel.** No piece kind executes, nothing in a snapshot is run, and `managed_package` hooks stay refused.
- **Plugins only add pieces and tighten.** No preset turns a group on, relaxes an approval or selects "Nothing asks". Hooks only observe. No feature flags. No chat instructions outside skills.
- **Every piece goes through its owner's normal checks.** Skills go through the Skill Hub review, `install_inactive` and `activate`, each with its own `skill_hub.lifecycle` approval (HX-402). Connectors go through the shipped template rules and host allowlisting. A skill is never callable before `activate` settles.
- **Operator actions follow #572.** `plugin_install` and `plugin_uninstall` are added on purpose to `isOperatorSavePlan` and to the approval reconciliation's auto-resume. `remote_hardened` always asks. Chat's `change.request` can't create either kind.
- **Every mutation route sits behind the Gateway idempotency plugin** (`apps/gateway/src/plugins/idempotency.ts`). It requires an `Idempotency-Key`, and a replayed key gets the first answer.
- **A count or state is never made up.** A piece whose state can't be read shows "State unknown", never "Added".
- **Visible copy follows DESIGN.md.** Sentence case and plain words. The copy guard bans "posture", "Gateway", "revision", "evidence", "owner", "snapshot", "canonical", "durable", "projection", "replay", "admission" and "readback" (`scripts/check-mission-control-next-cockpit-copy.mjs`); run it in every cockpit task. Say "GoatCitadel's checks", never "Skill Hub". Ids, URLs, paths, full hashes and raw codes appear only inside `TechnicalDetails`; the one exception is the 7-character pin above. Counts use `plural()`.
- **Guard budgets are exact both ways.** Lower live regions, page anatomy, raw values and copy budgets in the same commit that deletes what they counted. Add a ladder line for every new live region.
- **Architecture metrics:**
  - Never run `architecture:baseline:update`.
  - GatewayService must stay at or under 13132 counted lines (`split(/\r?\n/).length`). It is exactly 13132 on `12a238ea2`.
  - `routeFacingServiceCount` must never fall below 70. There are 71 `*-route-service.ts` files today.
  - New Gateway files take plain function readers, as `capability-skills-composition.ts` does. Measure each with `countDependencyMemberAccesses`.
  - A count above 0 in a new file, or a rise in an existing file's count, means stop and ask the operator for a C0 allowance. Expect to ask once, in PR 4d (Task 16).
- **Storage migrations:**
  - Write each migration for both drivers.
  - Run `pnpm update:storage:migration-manifest` and bump the pinned latest versions: `sqlite-migration-versioning.test.ts`, `remote-worker-canonical-bounds-migration.test.ts`, the Postgres latest-version tests listed in the facts file and both `postgres-migrator.test.ts` tripwires.
  - A Postgres CHECK or table change is tested on both lineages, fresh and upgraded.
- No new dependencies.
- After changing `packages/contracts`, `packages/storage`, `packages/extensions-sdk` or `packages/mission-control-shared`, rebuild that package before running its dependents' tests; they resolve these from `dist`.
- Run tests at low priority with `--maxWorkers=2`, one heavy job at a time. Storage tests use `TempSqliteFiles`.
- Never `prettier --write` a directory glob. Never `git stash`. No personal paths in tracked files.
- **Commands:**
  - Contracts: `pnpm --filter @goatcitadel/contracts exec vitest run <path> --maxWorkers=2`
  - SDK: `pnpm --filter @goatcitadel/extensions-sdk exec vitest run <path> --maxWorkers=2`
  - Storage: node:test through `tsx --test`. A Postgres twin is a `*.postgres.test.ts` listed in `test:postgres`.
  - Gateway: `pnpm --filter @goatcitadel/gateway exec vitest run <path relative to apps/gateway> --maxWorkers=2`. Run it from `apps/gateway` if a config ENOENT appears.
  - Shared: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run <path> --maxWorkers=2`
  - Cockpit: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path relative to the app> --maxWorkers=2`

## Review Focus

1. **The repository moves on between inspection and install.** Install uses the inspected snapshot at its pinned commit and never fetches again. Inspecting again shows the new commit. *(Tasks 11, 16)*
2. **You already had one of the plugin's pieces.** For example, the same connector saved earlier, or a group you switched off yourself.
   - The panel says "Already installed. Stays when you uninstall."
   - Uninstall leaves that connector, and never turns on a group you switched off.
   - *(Tasks 13, 15, 18)*
3. **The skip setting is off and the tab closes after the plugin plan applies but before its skills finish.**
   - Reopening shows the plugin as "Install not finished", with "Continue", read from the Gateway.
   - No skill is callable before its `activate` settles.
   - *(Tasks 17, 23)*
4. **A hostile manifest.** Examples:
   - a `../` path, a link in a folder, a tree over the limits
   - an `llm.request.before` mutate hook, a hook to a private address
   - feature flags, "Nothing asks", an `addon` piece
   - a SKILL.md that tries to override GoatCitadel's rules

   Inspection refuses each one with a plain reason, Install never enables, and nothing outside the snapshot folder is written. *(Tasks 10–13)*
5. **Something else edits a plugin's piece.** That covers Advanced setup's MCP editor, Settings › Hooks, a prompt-pack import with a `plugin-` id, and the old `/api/v1/skills/hub/operations` route. Each is refused with "From <plugin>". Switching the piece on or off still works. *(Task 15)*

---

# PR 4a: Arena and add-ons out

### Task 1: Remove the add-ons service and routes (Gateway, contracts)

**Files:**
- Delete:
  - `apps/gateway/src/services/addons-service.ts`, `addons-route-service.ts`, `addon-slot-service.ts`, `addon-launch-contract.ts`, `addon-child-env.ts` and `addon-author-contract.ts`, with their tests
  - `apps/gateway/src/routes/addons.ts` and its test
- Delete: `packages/contracts/src/addons.ts` and `addons.test.ts`, and its export in `packages/contracts/src/index.ts:7` and `domain-modules.coverage.test.ts:6`
- Modify:
  - `gateway-service.ts`: drop the dead type imports `:146-151`, `:512-513`, `:1122-1123`, `:2004-2005`, `:3649-3650`
  - `gateway-route-composition-port.ts`, `gateway-route-composition-system.ts`, `gateway-route-services.ts`
  - `app.ts:79,500`
  - `routes/route-access.ts:88`
- Modify: `routes/trust.ts`: the policy snapshot drops its `addons` sources, field and last-use rows. The shared client's type changes in Task 3, so each commit typechecks.
- Modify: `packages/contracts/src/dev-diagnostics.ts:17`: drop the `addons` category. Dev diagnostics aren't stored, so no old record carries it. Confirm the store is in-memory before dropping it; if it's stored, keep the value.
- Modify the tests that name the wiring:
  - `gateway-route-composition-loop15.test.ts`
  - `gateway-service-host-guard.test.ts:93-96,501`
  - `gateway-service.loop22-facade.test.ts:46-47`
  - `routes/route-access.test.ts:139,163`
  - `routes/trust.test.ts`

**Interfaces:** none produced. Removed: the `/api/v1/addons/*` family and `TrustPolicySnapshot.addons`.

- [ ] **Step 1: Write the failing tests:**
  - `routes/route-access.test.ts`: `it("has no add-ons route family")`, which asserts that `/api/v1/addons/catalog` has no prefix rule.
  - `routes/trust.test.ts`: `it("reads no add-on sources")`, which asserts that the snapshot has no `addons` field and no `addons.*` source.
  - An app-level test, `it("answers 404 for the retired add-on routes")`, covering GET `/api/v1/addons/catalog` and POST `/api/v1/addons/arena/install`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Delete and unwire.** Rebuild contracts and shared.
- [ ] **Step 4: Run the checks (PASS):**
  - these tests, plus `src/get-routes-publish-sweep.test.ts` and the host-guard test
  - the Gateway and shared typechecks
  - `pnpm verify:architecture:metrics`. Expect GatewayService at about 13118, `routeFacingServiceCount` 70 and port members 186, all improvements. Record the numbers in the ledger.
- [ ] **Step 5: Commit:** `refactor(gateway): remove Arena and the add-on service`.

### Task 2: Remove the orphaned extension and parity reports

**Files:**
- Delete:
  - `apps/gateway/src/services/follow-on-parity-report.ts`, `openclaw-parity-report.ts`, `extension-sdk-brief.ts`, `extension-starter-pack.ts` and `follow-on-parity-artifacts.ts`, with their tests and fixtures
  - `templates/addons/reference-separate-repo-addon/`
- Modify: `packages/contracts/src/follow-on-parity.ts` and `shared/api/types.ts:16,350`. Delete the contract if nothing else imports it (`git grep -n "follow-on-parity"`).
- Modify: `templates/verification/extension-sdk-brief.md`. Delete it if only the brief used it.

- [ ] **Step 1:** Run `git grep -n` for each module name and confirm that only its own tests import it. Record the result in the ledger.
- [ ] **Step 2: Delete, then run** the Gateway typecheck, `routes/dashboard.follow-on-parity.test.ts` (it still expects 404) and `pnpm verify:architecture:metrics` (improvements only) **(PASS).**
- [ ] **Step 3: Commit:** `refactor(gateway): remove orphaned extension and parity reports`.

### Task 3: Remove the add-on screens (cockpit, Classic, shared)

**Files:**
- Delete from the cockpit: `cockpit/areas/settings/AddonsSettings.tsx`, `AddonEvidence.tsx` and their tests.
- Modify, in the cockpit:
  - `SettingsArea.tsx:137-145`: `addons` renders only `PortablePacksSettings`
  - `settings-controls.ts:103-126`
  - `settings-destinations.ts:43,64-77,126`
  - `settings-index.ts:44`: the search terms become "capability packs"
  - `TrustPolicySettings.tsx:33`
  - `system/system-vocabulary.ts:123`
  - `data/event-map.ts:214`: drop the `addon_*` rule
  - `route-model.ts:642-648`: the rail item label becomes "Capability packs", with the description "Preview bundled capability packs. Plugins replace them soon."
- Delete from Classic (`native/settings/sections/`): `AddonApplicationsSection.tsx`, `addon-lifecycle.ts`, `addon-owner-binding.ts`, `addon-product-posture.ts`, `use-addon-settings.ts`, and their tests.
- Modify, in Classic:
  - `AddonsSection.tsx`: packs only, no filter and no Arena posture card
  - `GeneralSection.tsx:233-253,296,331,408-410`: drop the add-on count card
  - `SettingsShared.tsx:593,636-637,679-680`: the label becomes "Capability packs"
  - `TrustPolicySection.tsx:48`
  - `trust-policy-rows.ts:129-145,241-243`
- Modify, in shared:
  - Delete the 11 add-on functions from `api/platform-operations.ts:78-144`, and their re-exports in `api/platform.ts` and `api/client.ts`, plus the `wrappers.test.ts` rows.
  - Delete `hooks/useAddonSlots.ts` and its test.
  - `content/copy.ts:78,107,127,180-205`: the page copy becomes "Capability packs", with no Arena mention.
  - `api/http-internal.ts:185-186`.
  - `api/trust.ts:184-203,231`: no `addons` on `TrustPolicySnapshot`.
- Modify: lower the guard budgets by exactly what the deleted files counted:
  - `LIVE_REGION_BUDGET` 907 → 900 (the survey counts 7; recount), with a ladder line
  - `settings-raw-control` 83 → 82
  - the native-routes copy ratchets

- [ ] **Step 1: Write the failing tests:**
  - `SettingsArea.test.tsx`: `it("shows capability packs on Advanced and no add-ons")`.
  - `TrustPolicySettings.test.tsx`: `it("lists no add-on rows")`.
  - `event-map.test.ts`: `it("maps no add-on events")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild shared.
- [ ] **Step 4: Run the checks (PASS):**
  - the `areas/settings`, `native-routes/settings` and `cockpit/data` tests
  - the mc-next typecheck
  - `perf:check`
  - the copy guard
- [ ] **Step 5: Commit:** `refactor(cockpit): remove the add-on screens`.

### Task 4: Proof, docs and checks (PR 4a)

**Files:**
- Delete `scripts/verification/lib/scenarios/cockpit-addons-proof.mjs` and its test. In `ux-budget-owner-proofs.mjs:48,66`, remove its entry. In `ux-budgets-lane.test.mjs`, drop it from the key list and change the count at `:155` from 59 to 58.
- Remove the `ecosystem.addons.arena` scenario (`scenarios.mjs:2963-3000`) and the auth-matrix `addons` row (`scenarios.mjs:3310`).
- Remove the `addon_readiness` mapping in `review.mjs:183-184,208,253-254,299,385`. Keep the contracts enum value in `verification.ts:21` so that old reports still parse.
- Update the Classic `settings-addons` page entries for the packs-only page:
  - `surface-regression-lane.mjs:444-447,495` keeps the packs prefix only
  - `usability-browser-action-registry.mjs:983-989` drops the Arena steps
  - `usability-action-evidence.mjs`, `usability-coverage.mjs:136`
  - `release-surface-manifest.mjs:469-476`: readyText "Capability packs"
- Docs:
  - Delete `docs/ARENA_INTEGRATION_CONTRACT.md` and `docs/ADDONS_TRUST_POLICY.md`.
  - Edit `docs/1_0_CONTRACT.md:154`, `README.md:135`, `docs/ENGINEERING_HANDBOOK.md:159,580-582`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md:643`, `docs/QA_MANUAL_TEST_PLAN.md` (ADDON-01 goes), `docs/MISSION_CONTROL_COCKPIT_SETTINGS_PARITY.md`, `apps/gateway/AGENTS.md:52` and the `docs/1_0_RELEASE_SURFACE_SCOPE.md:59` row text. The route counts are unchanged.
  - Add the release-note lines about Arena's leftovers from "Decided without asking" to `CHANGELOG.md`.

- [ ] **Step 1: Update the proof scripts and run their tests:** `ux-budgets-lane.test.mjs`, the `review.mjs` tests, and `node --test` for any changed scenario test **(PASS)**.
- [ ] **Step 2: Update the docs.** Run `pnpm docs:check` **(PASS)**.
- [ ] **Step 3: Run the PR 4a checks:**
  - typecheck for contracts, gateway and shared, plus mc-next
  - `perf:check`
  - the Gateway tests from Task 1
  - the cockpit `areas/settings` tests
  - `pnpm verify:architecture:metrics`
  - the copy guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 4: Note in the PR body** that the Classic `settings-addons` visual baselines changed and need the manual `visual-rebaseline.yml` run.
- [ ] **Step 5: Commit:** `docs: retire Arena and add-ons`. Then open PR 4a.

---

# PR 4b: Integration plugins out, the SDK trimmed, the selection relabelled

### Task 5: Remove integration plugins, author form hints and the plugin runtime list (Gateway, contracts)

**Files:**
- Delete:
  - `apps/gateway/src/services/integration-plugin-store.ts`, `integration-plugin-author-contract.ts`, `integration-plugin-package-integrity.ts` and `plugin-runtime.ts`
  - `integration-configuration-guidance.ts`, `integration-setup-guidance-port.ts` and `plugin-provider-governance-service.ts`
  - all their tests
- Modify:
  - `routes/integrations-control-routes.ts:479-530`: drop the 4 plugin routes
  - `routes/integrations-shared.ts:193-202`
  - `integration-route-service.ts`: drop the plugin methods. Keep the file, because deleting it would drop `routeFacingServiceCount` to 69.
  - `integration-channel-service.ts:108-119,258-268,870-1027`. At `:470`, stop copying `pluginId` onto new connections.
  - `gateway-route-composition-integrations.ts:41,77,125,180-195,215,220,240-241,293-294,680-690`
  - `coverage-exercise.ts:815,834-839`
  - `gateway-service.ts:267`: the dead import
- Modify: `agentic-capability-availability.ts` and `routes/tasks.ts:560-584`: no `plugins` in the availability answer. Also `packages/contracts/src/agentic-runtime.ts:496,546-547`.
- Modify: `integration-catalog.ts:993-1021`: drop `pluginId` from Google Chat and Teams. Drop the `"plugin"` maturity value (`packages/contracts/src/integrations.ts:58`) and the catalog-parity check that guards it (`catalog-parity-lane.mjs:96-117`).
- Modify: contracts `channels.ts`, which keeps no `IntegrationPluginRecord`; `channel-wizard.ts:266` and `ui-forms.ts:6-11,40`, which drop `configurationGuidance`.
- Modify: contracts `integrations.ts:112-144`. Mark `pluginId`, `pluginVersion` and `pluginEnabled` `@deprecated`: "Read from rows written before Phase 4; never written."
- Leave `scripts/verification/baselines/architecture-new-service-allowances.json` alone. Stale entries are harmless.

- [ ] **Step 1: Write the failing tests:**
  - `it("answers 404 for the retired integration plugin routes")`, covering all four.
  - `it("creates a Google Chat connection with no plugin id")`, in the channel service test.
  - `it("lists no plugins in agentic availability")`, in `routes/tasks.test.ts`.
  - `it("serves channel setup definitions without author guidance")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts.
- [ ] **Step 4: Run the checks (PASS):**
  - these tests, plus the integration and channel route tests
  - the Gateway typecheck
  - `pnpm verify:architecture:metrics`: improvements only, `routeFacingServiceCount` still 70
- [ ] **Step 5: Commit:** `refactor(gateway): remove integration plugins and their form hints`.

### Task 6: Remove the plugin tool-override service

**Files:**
- Delete: `apps/gateway/src/services/plugin-tool-override-service.ts` and its test
- Modify:
  - `tool-invocation-coordinator-service.ts:70-71,690-691,830-858,1265,1688,1926,2042`: the runtime owner is always `{ kind: "builtin" }`
  - `gateway-service.ts:779,1145,1343-1345,2879,7686,7899,9311`
- Keep: `"plugin"` in `chat-feature-references.ts:228`, `chat-capability-profile.ts:106` and `tool-effect-truth.ts`. Add a comment there: "Old records only; nothing produces it since Phase 4."
- Modify: `scripts/verification/agentic-proof.mjs:370`, which names the deleted test.

- [ ] **Step 1: Write the failing test:** `it("parses a stored chat feature reference whose runtime owner is a plugin")`. It is a guard: it must still pass after the change, so write it first and see it pass. Then add `it("binds every tool call to the built-in runtime owner")` in the coordinator test.
- [ ] **Step 2: Remove the service.** Run the coordinator, capability-profile and remote-worker admission tests, plus the Gateway typecheck **(PASS)**.
- [ ] **Step 3: Measure.** GatewayService lines go down, and the tool-invocation coordinator's dependency count must not rise. Run `pnpm verify:architecture:metrics`.
- [ ] **Step 4: Commit:** `refactor(gateway): remove the never-used plugin tool override service`.

### Task 7: Delete stored integration plugin records (storage)

**Files:**
- Modify: `packages/storage/src/sqlite.ts`: add v273 `purge_integration_plugin_records`, which runs `DELETE FROM system_settings WHERE setting_key = 'integration_plugins_v1'`. The precedent is v253.
- Modify: `packages/storage/src/postgres/migrations.ts`: add v222 with the same name and SQL, plus `integritySha256`. The precedent is v199.
- Modify: `scripts/verification/baselines/storage-migrations.json` (via `pnpm update:storage:migration-manifest`), and the pinned-version tests listed in Global Constraints.
- Test:
  - `packages/storage/src/integration-plugin-purge-migration.test.ts`
  - `packages/storage/src/integration-plugin-purge-migration.postgres.test.ts`, listed in `test:postgres`

This changes data only; no shape changes, so the schema-shape gate doesn't see it.

- [ ] **Step 1: Write the failing tests:**
  - `it("deletes the integration plugin setting and keeps every other setting")`, on SQLite.
  - `it("keeps integration connections' plugin columns readable")`.
  - The Postgres twin of the first test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild storage.
- [ ] **Step 4: Run the checks (PASS):**
  - these tests
  - the version tests
  - `pnpm verify:storage:migration-parity`
  - the Postgres twin, if a local Postgres is available. If not, say so in the PR body.
- [ ] **Step 5: Commit:** `feat(storage): delete stored integration plugin records`.

### Task 8: Remove the plugin trust screens and relabel the selection (cockpit, Classic, shared)

**Files:**
- Modify, in the cockpit:
  - `IntegrationManagementSettings.tsx:21,109-110`: no "Plugin trust" view
  - `IntegrationCatalogEvidence.tsx:31-32,151-187`
  - delete `ExtensionConfigurationGuidance.tsx` and its test, and its uses in `ChannelDraftEditor.tsx:21,90` and `IntegrationFormFields.tsx:4,31`
- Modify, in Classic:
  - `IntegrationsSection.tsx:30,367-373,411-412,576-596`
  - `IntegrationsSectionPanels.tsx:88-125`
  - `IntegrationConnectionReview.tsx:18`
  - `integration-settings-snapshot.ts:8-63`
  - `use-integration-settings-state.ts:37,39,204`
  - `integration-connection-mutation.ts:22-24,114-116`
  - `helpers/onboarding-readiness.ts:90-92`
- Modify, in shared:
  - drop the 4 plugin functions (`api/integrations-operations.ts:622-645`) and their re-exports and `wrappers.test.ts` rows
  - `components/AgenticRuntimeVisibilityPanel.tsx:156,179`: no Plugins group
  - `api/types.ts:662,668`
  - `state/realtime-derived.ts:65`
  - `content/copy.ts:612`: drop the "Plugin adapter" term
- **Relabel** (exact copy, per Q5):
  - `CapabilityScopesSettings.tsx:9`: `integration: "Integrations"`
  - Classic `CitadelCapabilitiesSection.tsx` and `WorkspaceCapabilitiesSection.tsx`: `title="Integrations"`
  - `route-model.ts:659,666` and `route-release-scope.ts:459,467`: "Choose which skills, integrations, and MCP servers this workspace uses." and "Govern which skills, integrations, and MCP servers exist in this Citadel."
  - `settings-index.ts:59-60`: the search terms "skills integrations mcp"
- Modify: lower the copy and live-region budgets by exactly what the deleted code counted.

- [ ] **Step 1: Write the failing tests:**
  - `CapabilityScopesSettings.test.tsx`: `it("names the integration selection Integrations")`. It asserts the region "Integrations selection" and the button "Refresh integrations scope".
  - `IntegrationManagementSettings.test.tsx`: `it("offers no plugin trust view")`.
  - `ChannelDraftEditor.test.tsx`: `it("renders a channel draft without author guidance")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild shared. **Step 4: Run** the settings, native-routes settings and shared component tests, the mc-next typecheck, `perf:check` and the copy guard **(PASS)**.
- [ ] **Step 5: Commit:** `refactor(cockpit): remove plugin trust and name the integration selection`.

### Task 9: Trim the SDK; update lanes and docs (PR 4b)

**Files:**
- Modify `packages/extensions-sdk`:
  - delete `src/addons.ts`, `src/integration-plugins.ts`, `src/configuration-form.ts`, `src/author-preflight-cli.ts`, their tests and `templates/integration-plugins/`
  - `src/index.ts` exports only `./effective-tools.js`
  - `package.json`: version `2.0.0`; drop the `goatcitadel-extension-preflight` bin (Task 10 adds `goatcitadel-plugin-preflight`)
  - `README.md`
- Delete: root `templates/integration-plugins/`.
- Modify: `scripts/verify-extension-package-artifacts.mjs`. For now it packs the tarball and checks that the export map resolves; Task 10 adds the reference plugin check. Update its uses in `scripts/release/write-release-certificate.mjs:39` and `release-certificate-proof.test.mjs:176-198` to match.
- Modify the lanes:
  - `channel-guided-setup-lane.mjs:135-148,501`: drop the plugin step and the guidance assertion
  - `cockpit-integration-connections-proof.mjs:10`: no plugin fields
  - `cockpit-settings-tabs-proof.mjs:123-128`: "Integrations"
  - remove `verify:plugins:marketplace` from `package.json:190`, `scripts/verification/run.mjs:144,225,459-460,589`, `scenarios.mjs:543-551,779-786` and `agentic-proof.mjs:464-490`
- Modify the docs:
  - Rewrite `docs/PLUGIN_SDK_CONTRACT.md` as "Extensions SDK contract". It says 2.0.0 holds `effective-tools` and, from PR 4c, the plugin manifest validator, and that `@goatcitadel/extensions-sdk@1.0.0` is the last published version, which still carries the retired helpers.
  - Change `scripts/validate-governance-docs.mjs:389-398` to require both `@goatcitadel/extensions-sdk@2.0.0` and the 1.0.0 line.
  - `docs/1_0_CONTRACT.md:153`; `README.md:480,496,541,577,586`; `docs/ENGINEERING_HANDBOOK.md:86,152`; `docs/1_0_RELEASE_EVIDENCE.md:156-161`, whose links must point at files that still exist; `AGENTS.md:235-237`; `SECURITY.md:7,12`; `CHANGELOG.md`, with the release note about the plugin package files left in the data folder.

- [ ] **Step 1: Write the failing test:** `src/index.test.ts`: `it("exports only the tool directory helpers")`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement it.** Rebuild the SDK.
- [ ] **Step 4: Run the checks (PASS):**
  - the SDK tests
  - `pnpm verify:extensions:package`
  - the release-certificate test
  - `pnpm verify:channels:guided`, if the stack is available; otherwise the lane's unit test
  - `pnpm docs:check`
- [ ] **Step 5: Run the PR 4b checks:**
  - typechecks for contracts, SDK, storage, gateway, shared and mc-next
  - `perf:check`
  - the Gateway tests from Tasks 5–6
  - the storage tests from Task 7
  - the cockpit settings tests
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:storage:migration-parity`
  - the copy guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 6: Commit:** `refactor(sdk): trim the extensions SDK to 2.0.0`. Then open PR 4b.

---

# PR 4c: The plugin model, sources and inspection (Gateway)

### Task 10: Plugin manifest contract and SDK validator

**Files:**
- Create: `packages/contracts/src/plugins.ts`, exported from the index. Test: `plugins.test.ts`.
- Create: `packages/contracts/src/capability-plugins.ts`, for the route types in Task 13 and later. Export it next to `capability-skills`.
- Modify `packages/extensions-sdk`:
  - `src/plugins.ts` re-exports the manifest schema and `parsePluginManifest`, and adds `loadPluginManifest(dir)` with a bounded read
  - `src/plugin-preflight-cli.ts`, with the bin `goatcitadel-plugin-preflight`
  - `templates/plugins/reference-plugin/`, holding the manifest, one skill and one prompt pack
  - `scripts/verify-extension-package-artifacts.mjs`: checks that the reference plugin parses, in the root and packaged copies

**Interfaces:**
- Produces, in contracts `plugins.ts`:

```ts
export const PLUGIN_MANIFEST_FILENAME = "goatcitadel-plugin.json";
export const PLUGIN_LIMITS = {
  maxManifestBytes: 64 * 1024, maxPieces: 32, maxFiles: 256,
  maxTotalBytes: 8 * 1024 * 1024, maxFileBytes: 1024 * 1024,
} as const;
export type PluginTrust = "built_in" | "unverified";
export type PluginPieceKind = "skill" | "connector" | "tool_group_off" | "hook" | "prompt_pack";
export type PluginPiece =
  | { kind: "skill"; id: string; path: string }                  // folder holding SKILL.md
  | { kind: "connector"; id: string; templateId: string; asksFirst?: "everything" | "changes" } // default "changes"
  | { kind: "tool_group_off"; id: string; groupId: string }
  | { kind: "hook"; id: string; trigger: HookTrigger; url: string; mode?: "observe" }
  | { kind: "prompt_pack"; id: string; path: string };           // a .md file
export interface PluginManifest {
  schemaVersion: 1;
  pluginId: string;     // /^[a-z0-9][a-z0-9-]{1,47}$/
  name: string;         // 1..80
  description: string;  // 1..500
  version: string;      // 1..32, /^[0-9A-Za-z.+-]+$/
  author?: string;      // ≤ 120
  homepage?: string;    // https, ≤ 2048
  pieces: readonly PluginPiece[]; // 1..maxPieces, ids /^[a-z0-9-]{1,48}$/ and unique
}
export type PluginManifestRefusalCode =
  | "MANIFEST_MISSING" | "MANIFEST_TOO_LARGE" | "MANIFEST_INVALID" | "DUPLICATE_PIECE_ID"
  | "PIECE_PATH_INVALID" | "UNKNOWN_PIECE_KIND" | "FEATURE_FLAGS_NOT_ALLOWED"
  | "CHAT_INSTRUCTIONS_NOT_ALLOWED" | "HOOK_MUST_ONLY_OBSERVE" | "HOOK_CODE_NOT_ALLOWED"
  | "PRESET_MUST_TIGHTEN";
export type PluginManifestParse =
  | { ok: true; manifest: PluginManifest; manifestSha256: string }
  | { ok: false; code: PluginManifestRefusalCode; message: string; field?: string };
export function parsePluginManifest(raw: string): PluginManifestParse; // raw = file text
export type PluginSource =
  | { kind: "built_in"; pluginId: string }
  | { kind: "git"; url: string; ref?: string }  // ref: 40-hex commit, or a branch or tag
  | { kind: "folder"; path: string };            // absolute, on the GoatCitadel computer
export type PluginPin = { kind: "commit"; commit: string } | { kind: "content"; treeSha256: string };
```

**Refusal rules.** They are checked before the strict schema, in this order. The first match wins, and `field` names the piece:
1. A top-level or piece key in `featureFlags`, `flags` or `runtimePresets`, or a piece kind `runtime_preset`: `FEATURE_FLAGS_NOT_ALLOWED`.
2. A key in `instructions`, `systemPrompt`, `prompt` or `chatInstructions`: `CHAT_INSTRUCTIONS_NOT_ALLOWED`.
3. A hook piece with `mode` other than `"observe"`, or with a key in `patch`, `intercept`, `requiresApproval` or `riskLevel`: `HOOK_MUST_ONLY_OBSERVE`.
4. A hook piece with `action`, `package`, `command` or `script`: `HOOK_CODE_NOT_ALLOWED`.
5. A connector with `asksFirst` `"nothing"`, or a piece kind `tool_group_on`: `PRESET_MUST_TIGHTEN`.
6. Any other kind, including `addon`, `plugin` and `mcp_template`: `UNKNOWN_PIECE_KIND`.
7. A `path` that is absolute, contains `..`, `\` or a NUL, isn't NFC, or (for `prompt_pack`) doesn't end in `.md`: `PIECE_PATH_INVALID`.
8. Then the strict zod schema, which refuses unknown keys: `MANIFEST_INVALID`.

`manifestSha256` is the sha256 of the raw bytes.

**Phase 5 room.** `PluginPiece` is discriminated by `kind`, and a connector's shape is chosen by `templateId`. A Claude Code import can later add a connector variant with an inline server, and fill the inspection's `ignored` list (Task 13) with commands, agents and hooks it can't map, without changing these shapes.

- [ ] **Step 1: Write the failing tests:**
  - `it.each` over each refusal rule, with its code and `field`.
  - `it("accepts the reference plugin")`, reading the SDK template.
  - `it("refuses a manifest over 64 KiB")`.
  - `it("refuses duplicate piece ids")`.
  - `it("gives the same hash for the same bytes")`.
  - SDK: `it("preflight prints the refusal code for a bad manifest and exits 1")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts and the SDK.
- [ ] **Step 4: Run the tests and `pnpm verify:extensions:package` (PASS).**
- [ ] **Step 5: Commit:** `feat(contracts): define the plugin manifest`.

### Task 11: Plugin sources and snapshots (Gateway)

**Files:**
- Create: `apps/gateway/src/services/hardened-git.ts`. Move these into it from `skill-import-service.ts`, with no behaviour change: `hardenedGitConfigArgs`, the sanitized env, `assertSafeGitPositionalArg`, `assertGitSourceHostIsPublic`, the 60-second runner and `materializeBoundedGitTree`. Add `fetchGitTree(input)`. The Skill Hub's existing tests must pass unchanged.
- Create: `apps/gateway/src/services/plugin-snapshot-store.ts`
- Create: `apps/gateway/src/services/plugin-source-service.ts`
- Create: `plugins/README.md`, at the repo root, describing the shipped plugin folder. Task 20 adds the first plugin.
- Test: `hardened-git.test.ts`, `plugin-snapshot-store.test.ts`, `plugin-source-service.test.ts`

**Interfaces:**
- Produces:

```ts
// hardened-git.ts
export function fetchGitTree(input: {
  url: string; ref?: string; destDir: string;
  limits: { maxFiles: number; maxTotalBytes: number; maxFileBytes: number };
}): Promise<{ commit: string }>;
// plugin-snapshot-store.ts
export interface PluginSnapshot { treeSha256: string; dir: string } // dir = <root>/<treeSha256>
export class PluginSnapshotStore {
  constructor(root: string); // <rootDir>/<assistant.dataDir>/plugins/snapshots
  importDirectory(sourceDir: string): Promise<PluginSnapshot>; // copies, hashes, then renames into place
  resolve(treeSha256: string, relativePath?: string): string; // throws on traversal or a missing snapshot
}
// plugin-source-service.ts
export interface FetchedPluginSource {
  snapshot: PluginSnapshot; pin: PluginPin; trust: PluginTrust;
  sourceDisplay: string; // "Ships with GoatCitadel" | "<host>/<name>/<repo>" | "<folder name>"
}
export function fetchPluginSource(
  source: PluginSource,
  deps: { store: PluginSnapshotStore; builtInRoot: string; deploymentProfile: DeploymentProfile; tempRoot: string },
): Promise<FetchedPluginSource>;
```

**Rules:**
- **Git:**
  - The URL must be https on a trusted forge (`isTrustedGitForgeUrl`), with no user or token in it.
  - A 40-hex `ref` runs `git init`, then `git fetch --depth 1 --no-tags origin <sha>` and a checkout. Any other `ref` (`^[A-Za-z0-9._/-]{1,200}$`, no `..`) clones with `--branch <ref>`. With no `ref`, it clones the default branch.
  - The pin is `rev-parse HEAD`.
  - When a forge refuses a commit fetch, the error says: "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag."
- **Folder:**
  - On `remote_hardened`, it is refused with 403 "Folder installs work only when GoatCitadel runs on this computer."
  - The path must be absolute and an existing directory.
  - `lstat` every entry, and refuse symbolic links, junctions and files with `nlink > 1`.
  - The pin is `{ kind: "content", treeSha256 }`.
- **Built in:** `<rootDir>/plugins/<pluginId>`, where `pluginId` must match the manifest regex. No caller path reaches the filesystem. The pin is `content`.
- **Every source:**
  - Apply `PLUGIN_LIMITS`.
  - Refuse paths that aren't NFC and refuse case-insensitive duplicates.
  - The tree hash is the sha256 over the sorted `path\0sha256(content)\n` lines.
  - A snapshot is written once, to a temp dir, then renamed. An existing hash is reused.
  - Nothing in a snapshot is ever executed.

- [ ] **Step 1: Write the failing tests:**
  - `it("fetches a pinned commit and records it")`, using a local bare repo through the `git` runner, with the host check stubbed for tests only.
  - `it("refuses a host that isn't a trusted forge")`.
  - `it("refuses a folder with a link in it")`.
  - `it("refuses a folder install on remote_hardened")`.
  - `it("refuses a tree over the limits")`.
  - `it("gives two copies of the same folder one snapshot")`.
  - `it("refuses a snapshot path that climbs out")`.
  - `it("resolves a built-in plugin only from the shipped folder")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Run the skill-import and Skill Hub tests unchanged.
- [ ] **Step 4: Run them (PASS).** Measure the new files (0 accesses) and `skill-import-service.ts`, whose count must not rise.
- [ ] **Step 5: Commit:** `feat(gateway): fetch plugin sources into pinned snapshots`.

### Task 12: Skill Hub review of a plugin's skill

**Files:**
- Modify: `apps/gateway/src/services/skill-hub-review-service.ts`. The review takes `pluginSkill` and resolves it through a plain function given in its options, the same way `resolveShippedSkillPackSource` resolves packs.
- Modify: contracts, `SkillHubSourceReviewInput` (it gains `pluginSkill`).
- Test: `skill-hub-review-service.test.ts`, plus a guard test in `capability-plugin-guards.test.ts`.

**Interfaces:**
- Produces:

```ts
// added to SkillHubSourceReviewInput (exclusive with packId and sourceRef)
pluginSkill?: {
  snapshotTreeSha256: string; path: string;
  pluginId: string; pieceId: string; trust: PluginTrust; pinLabel: string; // "commit:<sha>" | "content:<sha>"
};
// options
resolvePluginSkillDir?: (treeSha256: string, path: string) => string; // PluginSnapshotStore.resolve
```

**Rules:**
- The review runs every existing check (frontmatter shape, promptware scan, blockers, the 96-file and 4 MiB skill limits) on the skill's folder alone.
- Provenance records:
  - `sourceProvider: "goatcitadel_plugin"`
  - `sourceRef: "plugin:<pluginId>/<pieceId>@<pinLabel>"`
- An `unverified` plugin's skill gets the same trust disposition as a Git import. Only a `built_in` plugin's skill counts as GoatCitadel's own, which also makes its origin read Built in under R13.
- Only `capability-plugin-inspection-service.ts` may pass `pluginSkill`. The guard test scans `apps/gateway/src` for `pluginSkill:`.

- [ ] **Step 1: Write the failing tests:**
  - `it("reviews a plugin's skill folder from its snapshot")`.
  - `it("reviews an unverified plugin's skill like a Git import, never as a shipped pack")`.
  - `it("blocks a plugin skill whose instructions try to override GoatCitadel's rules")`.
  - `it("refuses packId, sourceRef and pluginSkill together")`.
  - The guard test.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild contracts.
- [ ] **Step 4: Run them, the Skill Hub tests and `pnpm verify:skill-hub:lifecycle` (PASS).** The count for `skill-hub-review-service.ts` must not rise; if it does, hoist the options read.
- [ ] **Step 5: Commit:** `feat(skills): review a plugin's skill from its snapshot`.

### Task 13: Inspection, the plugin store and the read routes

**Files:**
- Create: `apps/gateway/src/services/capability-plugin-store.ts`, `capability-plugin-inspection-service.ts` and `capability-plugins-composition.ts`
- Create: `apps/gateway/src/services/capability-plugins-route-service.ts`. It is route-facing with plain readers, which brings the count to 71 so that PR 4e can delete the packs route service.
- Create: `apps/gateway/src/routes/capability-plugins.ts`
- Modify:
  - `gateway-service.ts`: register `capabilityPlugins` once, with ≤3 lines
  - `gateway-route-services.ts`
  - `app.ts`
  - `coverage-exercise.ts`
  - `route-access.ts`: `/api/v1/capabilities/plugins` is operator
- Modify: contracts `capability-plugins.ts`.
- Modify: contracts `hooks.ts` gains `HOOK_TRIGGER_LABELS`, moved from `cockpit/areas/settings/settings-vocabulary.ts:212`, which re-imports it with the same copy.
- Test: `capability-plugin-store.test.ts`, `capability-plugin-inspection-service.test.ts`, `routes/capability-plugins.test.ts` and `capability-plugins.integration.test.ts`

**Interfaces:**
- Produces:

```ts
// contracts/capability-plugins.ts
export type CapabilityPluginPieceCheck =
  | { status: "ready" } | { status: "already_there" }
  | { status: "blocked"; code: string; message: string };
export interface CapabilityPluginPieceView {
  pieceId: string; kind: PluginPieceKind;
  label: string;      // skill name, connector label, group label, trigger label, or prompt pack name
  asksFirst: string;  // a plain line written by the Gateway; see the copy below
  check: CapabilityPluginPieceCheck;
  hosts?: string[];   // hosts that installing allows (connectors, hooks)
  skillSnapshotId?: string;
  needsSecret?: boolean; // hook pieces
}
export interface CapabilityPluginInspection {
  inspectionId: string; workspaceId: string;
  pluginId: string; name: string; description: string; version: string; author?: string;
  trust: PluginTrust; sourceKind: PluginSource["kind"]; sourceDisplay: string; pin: PluginPin;
  manifestSha256: string;
  pieces: CapabilityPluginPieceView[];
  ignored: { path: string; reason: string }[]; // always [] for native manifests
  refusal?: { code: PluginManifestRefusalCode | string; message: string };
  installable: boolean; // no refusal, and every piece ready or already_there
  inspectedAt: string; expiresAt: string;       // + 24 h
}
export type CapabilityPluginState = "available" | "installed" | "install_not_finished" | "uninstalling";
export interface CapabilityPluginListItem {
  pluginId: string; name: string; description: string; version: string;
  trust: PluginTrust; sourceDisplay: string; state: CapabilityPluginState;
  pieceCounts: Partial<Record<PluginPieceKind, number>>;
}
export interface CapabilityPluginListResponse { installed: CapabilityPluginListItem[]; builtIn: CapabilityPluginListItem[] }
// routes
// GET  /api/v1/capabilities/plugins?workspaceId=                          → 200 CapabilityPluginListResponse
// POST /api/v1/capabilities/plugins/inspections { workspaceId, source }    → 201 CapabilityPluginInspection | 422 refusal
// GET  /api/v1/capabilities/plugins/inspections/:inspectionId              → 200 | 404
// gateway store
export interface StoredPluginPiece {
  pieceId: string; kind: PluginPieceKind; owned: boolean;
  ref?: string;  // serverId | groupId | hookId | promptPackId | skillId
  skillSnapshotId?: string;
}
export interface StoredPlugin {
  pluginId: string; name: string; description: string; version: string; trust: PluginTrust;
  sourceKind: PluginSource["kind"]; sourceDisplay: string; pin: PluginPin; manifestSha256: string;
  snapshotTreeSha256: string; workspaceId: string; installPlanId: string;
  state: "installing" | "installed" | "uninstalling"; installedAt: string;
  pieces: StoredPluginPiece[];
}
export class CapabilityPluginStore { // system_settings key "capability_plugins_v1", compareAndSet loop
  list(): Promise<StoredPlugin[]>;
  get(pluginId: string): Promise<StoredPlugin | undefined>;
  update(pluginId: string, change: (current: StoredPlugin | undefined) => StoredPlugin | undefined): Promise<void>;
  saveInspection(inspection: CapabilityPluginInspection, snapshotTreeSha256: string): Promise<void>; // keeps the newest 50, drops expired
  getInspection(inspectionId: string): Promise<{ inspection: CapabilityPluginInspection; snapshotTreeSha256: string } | undefined>;
}
export function findPluginOwning(plugins: readonly StoredPlugin[], kind: PluginPieceKind, ref: string): StoredPlugin | undefined;
```

**Inspection** (`inspect({ workspaceId, source, actorId, idempotencyKey })`):
1. Fetch the source (Task 11).
2. Parse the manifest (Task 10). A refusal answers 422, with the inspection saved so that its `refusal` can be shown.
3. Check each piece:
   - **skill:** the Skill Hub review with `pluginSkill` (Task 12). Its result maps to `ready`, or to `blocked` with the review's first blocker code.
   - **connector:** the template must be shipped, visible, not in `EXCLUDED_CONNECTOR_TEMPLATE_IDS`, not token-auth, and have OAuth endpoints when it uses OAuth. That is `connector-install-change-plan-adapter.ts` `resolve`'s rule; reuse it, don't copy it. A label that is already saved gives `already_there`.
   - **tool_group_off:** the group must exist and be switchable. Core and `mcp.invoke` are refused with "That group can't be switched off." If the operator already has it off, the result is `already_there`.
   - **hook:** `assertWebhookUrlAllowed`'s rules, a public https host, and a trigger in `HOOK_TRIGGER_VALUES`. Metadata scope. `needsSecret: true`.
   - **prompt_pack:** `preparePromptPackImport` on the file, as a dry run. The id `plugin-<pluginId>-<pieceId>` must be free.
4. A `pluginId` that is already installed answers 409: "<name> is already installed."

**`asksFirst` copy** (exact):
- skill: "Follows your tool rules. Added after GoatCitadel's checks, then switched on."
- connector "changes": "Reading runs freely; creating or changing something asks first in Chat."
- connector "everything": "Everything it does asks first in Chat."
- tool_group_off: "Turns <group label> off in every chat while installed."
- hook: "Sends event details, never message text, to <host>: <trigger label>." The labels are `HOOK_TRIGGER_LABELS`, which moves from `cockpit/areas/settings/settings-vocabulary.ts:212` to contracts `hooks.ts` in this task, so the Gateway and the cockpit share one table.
- prompt_pack: "Adds <n> tests to Library › Prompt packs. Nothing runs until you press Run."

**List:**
- Installed records come from the store. `install_not_finished` means `state === "installing"`, or a skill piece whose Skill Hub install hasn't reached `activate`, read through the same Hub list Phase 3's installs read uses.
- `builtIn` lists every folder under `<rootDir>/plugins/` that isn't installed. Its manifest is parsed and its piece counts shown. No fetch happens and nothing is reviewed until Install is pressed.

**Route rules:**
- `.strict()` zod schemas.
- Rate limits: list 60 a minute, inspections 10 a minute, get 60 a minute.
- `markNoStore`.
- A failed fetch answers 422 with a plain message and `details.code`. A server fault answers 503: "Plugins can't be read right now."

- [ ] **Step 1: Write the failing tests:**
  - Store: `it("keeps the newest 50 inspections and drops expired ones")`.
  - Store: `it("retries on a concurrent write")`.
  - Inspection: `it("marks a plugin installable only when every piece passes")`.
  - Inspection: `it("blocks the whole plugin when one skill is blocked")`.
  - Inspection: `it("marks an already saved connector as already there")`.
  - Inspection: `it("refuses a group that can't be switched off")`.
  - Inspection: `it("refuses a hook to a private address")`.
  - Inspection: `it("refuses a prompt pack id that is taken")`.
  - Inspection: `it("answers 409 for a plugin that is already installed")`.
  - Inspection: `it("writes the exact asks-first lines")`.
  - Routes: `it("rejects unknown fields")`.
  - Routes: `it("sets the rate limits")`.
  - Routes: `it("lists built-in plugins without fetching")`.
  - Integration, on a real Gateway with a fixture folder: inspect, then read it back. The snapshot directory is the only new path written.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure GatewayService (≤13132) and the new files (0 each); `routeFacingServiceCount` is 71.
- [ ] **Step 4: Run the checks (PASS):**
  - these tests
  - `src/get-routes-publish-sweep.test.ts`
  - the Gateway typecheck
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:gateway:async-boundary`
- [ ] **Step 5: Commit:** `feat(gateway): inspect plugins and list them`.
- [ ] **Step 6: Docs and the PR 4c checks.** Add a "Plugins" section to `docs/CANONICAL_RUNTIME_STATE_MODEL.md`: the store key, the snapshots, and that inspection installs nothing. Then run:
  - typechecks for contracts, the SDK, gateway and the cockpit (Task 13 moved the trigger labels)
  - the Gateway tests from Tasks 11–13, and the Skill Hub tests
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:extensions:package`
  - `pnpm docs:check`
  - `git diff --check`

  Commit `docs: describe plugin inspection`, then open PR 4c.

---

# PR 4d: Install and uninstall (Gateway)

### Task 14: Change Plan kinds `plugin_install` and `plugin_uninstall` (contracts, storage)

**Files:**
- Modify: `packages/contracts/src/change-plan.ts`:
  - `CHANGE_PLAN_KINDS` gains both kinds
  - add the request types below
  - add the `isChangePlanRequest` cases
- Modify: `packages/storage/src/change-plan-schema.ts`: add both kinds to the kind CHECK. The surface `capabilities` already exists.
  - SQLite v274 rebuilds the table, as v271 does at `:185-217`.
  - Postgres v223 swaps the CHECK constraint, as v220 does at `:250-285`.
- Modify: `sqlite.ts`, `postgres/migrations.ts`, the manifest and the pinned versions.
- Test:
  - `packages/storage/src/change-plan-plugin-migration.test.ts`
  - `change-plan-plugin.postgres.test.ts`, which proves both lineages and is listed in `test:postgres`
  - `packages/contracts/src/change-plan.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ChangePlanPluginInstallRequest {
  readonly kind: "plugin_install"; readonly inspectionId: string; readonly manifestSha256: string;
  readonly workspaceId: string; readonly hookSecretRefs?: Readonly<Record<string, string>>; // pieceId → key-store ref
}
export interface ChangePlanPluginUninstallRequest {
  readonly kind: "plugin_uninstall"; readonly pluginId: string; readonly installPlanId: string;
}
```

**Version numbers.** v274/v223 assume that Task 7's v273/v222 merged first. Take the next free pair at build time.

- [ ] **Step 1: Write the failing tests:**
  - `it("accepts plugin install and uninstall plans and keeps every older plan")`, on SQLite.
  - On Postgres, the same test on a fresh lineage and on an upgraded one (apply ≤v222 from an older v2, then all).
  - Contracts: `it.each` over valid and invalid requests (a missing hash, an extra field, a secret value where a ref belongs).
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild contracts and storage. **Step 4: Run them, plus `pnpm verify:storage:migration-parity` and the version tests (PASS).**
- [ ] **Step 5: Commit:** `feat(storage): plugin install and uninstall plans`.

### Task 15: Ownership and read-only pieces

**Files:**
- Modify: contracts `mcp.ts`. `McpServerRecord` gains `pluginOwner?: { pluginId: string; installPlanId: string }`. Unlike `packChange`, ordinary edits never clear it, because ordinary edits are refused.
- Modify, in `mcp-server-admin-service.ts`:
  - `updateMcpServer`, `updateMcpServerPolicy` and delete refuse a server with `pluginOwner`, unless they are called with the plugin service's owner token (the same handle pattern as `packOwner`).
  - Enable, disable, connect and sign-in stay allowed.
- Modify: `hooks-service.ts`. Updating or deleting a hook listed by an installed plugin is refused. It reads `findPluginOwning` through a plain reader in its deps.
- Modify: `prompt-pack-service.ts` and `routes/prompt-packs.ts`. An import or reset with a `packId` starting `plugin-` is refused unless it comes from the plugin service.
- Modify: `skill-hub-operator-service.ts`. `stage_update_candidate` and `stage_rollback_candidate` for a skill owned by a plugin are refused.
- Modify, for tool-group holds:
  - The runtime settings projection: `switchedOffToolGroups` becomes the union of the operator's `disabledGroups` and every installed plugin's `tool_group_off` piece.
  - `RuntimeSettings` gains `pluginToolGroupHolds: { groupId: string; pluginId: string; pluginName: string }[]`.
  - The policy engine already denies `switchedOffToolGroups` everywhere, so it is unchanged.
  - The holds are read again whenever the plugin store changes.
- Create: `apps/gateway/src/services/plugin-owned-refusal.ts`, holding `PluginOwnedError` (409, `code: "PLUGIN_OWNED"`, message "From <plugin name>. Uninstall it to remove this.", `details.pluginId`).
- Test: the owners' existing test files, plus `capability-plugin-ownership.integration.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `it("refuses editing or removing a plugin's connector, and still switches it and signs it in")`.
  - `it("refuses editing a plugin's hook")`.
  - `it("refuses importing over a plugin's prompt pack")`.
  - `it("refuses staging an update for a plugin's skill")`.
  - `it("denies a held group in every chat even when the operator's switch is on")`. This is a policy-engine test through the runtime settings.
  - `it("keeps a group off after a hold is released if the operator switched it off")`.
  - `it("lists who holds a group off")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure every touched owner; a rise means hoisting in that function, or stopping for C0.
- [ ] **Step 4: Run them, the MCP admin, hooks, prompt-pack, Skill Hub and policy tests, and `pnpm verify:journey:producers` (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): keep a plugin's pieces read-only`.

### Task 16: The install plan

**Files:**
- Create: `apps/gateway/src/services/plugin-install-change-plan-adapter.ts`, with the adapterId `plugin-install` and kind `plugin_install`.
- Create: `apps/gateway/src/services/capability-plugin-actions-service.ts`, which handles install, uninstall and secret custody.
- Modify:
  - `gateway-service.ts`: register the adapter next to `connector_install`, in ≤6 lines
  - `evolution-control-plane-operator-approval-skip.ts:44-47`: add both kinds on `capabilities`
  - `evolution-control-plane-approval-reconciliation.ts:142`: auto-resume both kinds
- Modify: `routes/capability-plugins.ts`. Add `POST /api/v1/capabilities/plugins/install`, with body `{ workspaceId, inspectionId, hookSecrets?: Record<pieceId, string> }`. It answers 202 `{ planId, outcome: "applied" | "waiting", approvalId? }`, at 10 a minute.
- Test: `plugin-install-change-plan-adapter.test.ts`, `capability-plugin-actions-service.test.ts` and `capability-plugins-install.integration.test.ts`

**Interfaces:**
- Consumes:
  - Task 13's store and inspection
  - Task 15's owner handles
  - `createMcpServer` and `updateMcpServerPolicy`
  - `updateSettings`, for the network allowlist and the hooks allowlist
  - `HooksService.createWorkspaceHook`
  - `PromptPackService.importPromptPack` (guarded create-if-absent)
- Produces:

```ts
export interface PluginActionOutcome { planId: string; outcome: "applied" | "waiting"; approvalId?: string }
export class CapabilityPluginActionsService {
  install(input: { workspaceId: string; inspectionId: string; hookSecrets?: Readonly<Record<string, string>>; actorId: string }): Promise<PluginActionOutcome>;
  uninstall(input: { workspaceId: string; pluginId: string; actorId: string }): Promise<PluginActionOutcome>; // Task 18
}
```

**Install rules:**
- **Refusals before any plan is created:**
  - The inspection must exist, be unexpired, be `installable`, and match `manifestSha256`.
  - Every hook piece must have a secret: 1 to 512 characters, with no surrounding whitespace.
  - The plugin must not already be in the store.
- **Secrets:** stored in the key store first (`storeWebhookSecret`). The plan carries only the refs. If the plan ends without applying (declined, expired or failed before the hook step), the service deletes those refs.
- **The plan:** risk `danger`, origin surface `capabilities`. `prepare` binds the inspection, and the target hash is the store's current revision plus the inspection hash. Confirm passes `operatorSettingsSave: true`, so #572's skip applies as it does for `connector_install`.
- **`apply`, in order:**
  1. Write the plugin record with `state: "installing"` and every piece listed. `owned` is false for `already_there`.
  2. Add the missing connector and hook hosts to the network allowlist and the hooks allowlist.
  3. Create each connector, switched off, with `pluginOwner` and the approval setting the piece names ("changes" → `reads_free`, "everything" → `everything_asks`).
  4. Record the tool-group holds.
  5. Create the hooks: observe mode, metadata scope, webhook with the secret ref, in the plan's workspace.
  6. Import the prompt packs as `plugin-<pluginId>-<pieceId>`, with `sourceLabel` "Plugin <name>".
  7. Set `state: "installed"`. Skills follow in Task 17.

  After each step, save the piece's `ref` in the record.
- **A failed step** leaves the record listing what was added, and its `detail` names the step. Uninstall can then remove the added pieces.
- **Every snapshot read goes through the inspected tree.** Nothing is fetched again.
- **`rollback-requests`** on an install plan answer 409: "Uninstall the plugin instead."

- [ ] **Step 1: Write the failing tests:**
  - `it("installs every non-skill piece in order from one confirmation when the setting is on")`.
  - `it("waits for one approval when the setting is off, then applies")`.
  - `it("installs the inspected bytes even when the source changed after inspection")`.
  - `it("keeps an already saved connector and doesn't own it")`.
  - `it("stores hook secrets in the key store and never in the plan")`.
  - `it("deletes the stored secrets when the plan is declined")`.
  - `it("records what was added when a step fails")`.
  - `it("refuses an expired or changed inspection")`.
  - `it("always asks on remote_hardened")`.
  - `it("can't be created from Chat")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Measure the adapter and the actions service. **Expect the adapter to exceed 0, as Phase 1's connector adapter did (14/0). Stop and ask the operator for a C0 allowance with the exact counts** before adding it to `architecture-new-service-allowances.json` and `COMPARISON_APPROVED_PLAN_2026-09-09.md`.
- [ ] **Step 4: Run the checks (PASS):**
  - these tests
  - the evolution control-plane tests
  - `pnpm verify:journey:producers`
  - `pnpm verify:durable:recovery`
  - `pnpm verify:architecture:metrics`
- [ ] **Step 5: Commit:** `feat(gateway): install a plugin's pieces from one confirmation`.

### Task 17: Skill pieces and "From plugin" marks

**Files:**
- Modify: `capability-skill-actions-service.ts`. `requestStep` accepts a snapshot that came from a plugin skill review, as long as the plugin's record lists that piece and is `installing` or `installed`; otherwise it refuses with 409. The #572 rule is unchanged.
- Modify: `capability-plugins-composition.ts`. The plugin detail reads each skill piece's install state from the Skill Hub list by `skillSnapshotId`, and saves the skill id in the record once `activate` settles.
- Modify: contracts `capability-skills.ts`, `capability-connectors.ts` and `capability-tools.ts`, plus their projections. Add `fromPlugin?: { pluginId: string; name: string }` to skill items and connector rows, and `heldOffBy?: { pluginId: string; name: string }[]` to tool groups.
- Modify: `routes/capability-plugins.ts`. Add `GET /api/v1/capabilities/plugins/detail?pluginId=&workspaceId=`, which answers 200 `CapabilityPluginDetail` or 404, at 60 a minute.
- Test: `capability-plugin-detail.test.ts`, plus additions to the three projections' tests.

**Interfaces:**
- Produces:

```ts
export type CapabilityPluginPieceState =
  | "added" | "kept" | "check_passed" | "installing" | "installed_off" | "waiting_for_approval"
  | "removed" | "failed" | "unknown";
export interface CapabilityPluginDetail extends CapabilityPluginListItem {
  author?: string; pin: PluginPin; installPlanId: string; installedAt: string;
  pieces: (CapabilityPluginPieceView & {
    state: CapabilityPluginPieceState; pendingApprovalId?: string;
    href?: string; // Gateway-written link to the piece's own tab item
  })[];
}
```

**Rules:**
- **`href` values:**
  - `/capabilities/skills?item=skill:<skillId>`
  - `/capabilities/connectors?item=<id>`, where `<id>` is the item id the Connectors projection gives that saved server (`connectorItemHref`'s input), not the raw server id
  - `/capabilities/tools?item=group:<groupId>`
  - `/library/prompt-packs?view=pack:<packId>`
  - `/settings/safety#hooks`
- **`state`** is `unknown` when the Skill Hub list can't be read; never `installed`.
- **The plugin reads `installed`** only when every piece is added, kept or installed.

- [ ] **Step 1: Write the failing tests:**
  - `it("accepts a skill step only for a listed piece of an installing plugin")`.
  - `it("shows a skill piece waiting for its install approval")`.
  - `it("marks the plugin not finished until every skill is switched on")`.
  - `it("reads unknown when the skill list fails")`.
  - `it("marks a plugin's skill, connector and held group with the plugin's name")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild contracts. **Step 4: Run them and the Phase 3 skills route tests (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): follow a plugin's skills and mark its pieces`.

### Task 18: The uninstall plan, prompt-pack deletion and skill revokes

**Files:**
- Create: `apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts`, with the adapterId `plugin-uninstall`. It shares helpers with the install adapter. The C0 ask from Task 16 covers both files if both rise.
- Modify: `packages/storage/src/prompt-pack-repo.ts`. Add `deletePackCascade(packId): { deletedRuns: number }`, which in one transaction, on both drivers, deletes the pack's rows in:
  - benchmark items, benchmark runs, the dedup audit
  - human reviews v2, auto scores v2, scores
  - runs, tests and the pack itself
- Modify: `capability-skill-actions-service.ts`. Add `revokeForPluginUninstall({ workspaceId, skillId, pluginId, actorId })`. It requests the Skill Hub `revoke` and resolves the approval as the operator with the reason `plugin_uninstall`, because revoking only takes power away (Phase 3, Q1 A). On `remote_hardened` it answers `waiting`. The guard test's allowed resolver list stays this one file.
- Modify: `routes/capability-plugins.ts`. Add `POST /api/v1/capabilities/plugins/uninstall`, with body `{ workspaceId, pluginId }`. It answers 202 `PluginActionOutcome`, at 10 a minute.
- Modify: the Skills projection. A revoked skill whose plugin was uninstalled reads `removedWithPlugin: { name }` (Q4 A).
- Test: `plugin-uninstall-change-plan-adapter.test.ts`, `prompt-pack-delete-cascade.test.ts`, its Postgres twin and `capability-plugins-uninstall.integration.test.ts`

**Uninstall rules:**
- **The plan:** risk `caution`, origin `capabilities`, with #572's skip.
- **`apply`, in reverse install order, touching only `owned` pieces:**
  1. Delete the hooks and their secret refs.
  2. Delete the prompt packs, with their runs.
  3. Release the tool-group holds.
  4. Disconnect and delete the connectors.
  5. Revoke the skills.
- **Never touched:** `kept` pieces, and hosts in either allowlist.
- **The record:**
  - It reads `uninstalling` until every revoke settles, then it is deleted.
  - A revoke still waiting (`remote_hardened`) keeps it `uninstalling`, with the waiting approval in the detail.
- **Exact copy for the plan's `afterApproval` summary:** "Removed <n> pieces. Hosts it allowed stay in your allowlist."

- [ ] **Step 1: Write the failing tests:**
  - `it("removes exactly the pieces the plugin added")`.
  - `it("leaves a connector it found already saved")`.
  - `it("releases its hold but leaves a group the operator switched off")`.
  - `it("deletes its prompt packs with every run and score")` (storage, both drivers).
  - `it("revokes its skills without asking, except on remote_hardened")`.
  - `it("cleans up after a failed install")`.
  - `it("asks once when the setting is off")`.
  - `it("refuses to uninstall a plugin that isn't installed")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild storage, then measure.
- [ ] **Step 4: Run them, `pnpm verify:skill-hub:lifecycle`, `pnpm verify:journey:producers` and `pnpm verify:architecture:metrics` (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): uninstall exactly what a plugin added`.

### Task 19: Public truth and checks (PR 4d)

- [ ] **Step 1: Docs:**
  - `docs/EVOLUTION_CONTROL_PLANE.md`: the two plan kinds, and that they are the third and fourth Capabilities kinds the skip covers.
  - `docs/CANONICAL_RUNTIME_STATE_MODEL.md` "Plugins": ownership, holds, read-only pieces and uninstall.
  - `docs/HOOKS.md`: plugin hooks are observe-only webhooks in one workspace.
  - `docs/1_0_CONTRACT.md`: a plugins line stating exactly what is implemented; no tab yet.
- [ ] **Step 2: Run the PR 4d checks:**
  - typechecks for contracts, storage, gateway and shared
  - the Gateway tests from Tasks 14–18
  - storage, with the Postgres twins
  - `pnpm verify:journey:producers`
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:durable:recovery`
  - `pnpm verify:gateway:async-boundary`
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:storage:migration-parity`
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Commit:** `docs: describe plugin install and uninstall`. Then open PR 4d.

---

# PR 4e: The Plugins tab

### Task 20: The built-in "Browser checks" plugin (Q1 A)

**Files:**
- Create: `plugins/browser-checks/goatcitadel-plugin.json`:
  - `pluginId` "browser-checks"
  - name "Browser checks"
  - description "Lets the AI open pages in a private browser, read them and take screenshots, with a skill for checking web pages step by step."
  - pieces: a connector with `templateId` "playwright" and `asksFirst` "everything", and a skill at `skills/browser-qa`
- Create: `plugins/browser-checks/skills/browser-qa/SKILL.md`. Move its text from `capability-pack-bindings.ts:23-57`, with frontmatter that the Skill Hub accepts.
- Modify: `skills/catalog-coverage.json` and `SHIPPED_SKILL_CATEGORIES`, if the coverage check scans `plugins/` (check `scripts/check-skill-catalog.mjs`). The category is `coding`.
- Modify: the installer and packaging lists that copy `skills/` (`git grep -n "import-packs"` across `scripts/`, `apps/mission-control-desktop/` and the install scripts) so that they copy `plugins/` too.
- Test: `apps/gateway/src/services/built-in-plugins.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `it("parses every shipped plugin manifest")`.
  - `it("inspects Browser checks as installable on a fresh install")`, on a real Gateway with a scratch root.
  - `it("packages the plugins folder")`, which checks the packaging list.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them and `pnpm verify:skills:catalog` (PASS).**
- [ ] **Step 5: Commit:** `feat(plugins): ship Browser checks as a built-in plugin`.

### Task 21: Shared client, cockpit data and tab wiring

**Files:**
- Create: `packages/mission-control-shared/src/api/capability-plugins.ts`, imported by path. Test: `capability-plugins.test.ts`.
  - Fetchers: `fetchCapabilityPlugins`, `fetchCapabilityPluginDetail`, `fetchCapabilityPluginInspection`
  - Actions: `inspectCapabilityPlugin`, `installCapabilityPlugin`, `uninstallCapabilityPlugin`, each with an `Idempotency-Key`
- Create: `cockpit/data/capability-plugins-query.ts`. Modify `query-keys.ts`, adding a `"plugins"` `RefreshTopic` (`shared/state/refresh-bus.ts`), and `event-map.ts`, with a source rule for the plugin realtime events. The inventory test must pass.
- Modify:
  - `capabilities-tabs.ts`: Plugins second, `/capabilities/plugins`, with the id type widened
  - `CapabilitiesArea.tsx`
  - `cockpit-compatibility.ts:36-37`
- Modify: `cockpit-compatibility.ts:115-143`. Redirect `/settings/addons`, `/settings/advanced#addons` and `/settings/connections#addons` to `/capabilities/plugins`. The section itself, and its route-scope rows and counts, go in Task 26, so the route counts move once.
- Modify the tests that used "plugins" as a missing tab: `CapabilitiesArea.test.tsx:127,203`, `last-tab-preference.test.ts:43` and `cockpit-compatibility.test.ts:90`. Use "extensions" as the example.
- Create: `cockpit/areas/capabilities/plugins/plugin-links.ts`. It holds `PLUGINS_HREF`, `?item=plugin:<id>` and `?item=plugin-install:<inspectionId>`, plus the inspector prefixes `capabilities-plugins:` and `capabilities-plugin-install:`. Neither prefix may start with `capabilities:`.

- [ ] **Step 1: Write the failing tests:**
  - `it("shows Skills, Plugins, Connectors, Tools in that order")`.
  - `it("redirects the old add-ons addresses to Plugins")`.
  - `it("refreshes plugin lists on plugin events")`.
  - `it("builds plugin addresses that never use the Connectors prefix")`.
  - Shared: `it("sends an Idempotency-Key on install and uninstall")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it,** then rebuild shared. **Step 4: Run them, the palette tests and the mc-next typecheck (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the Plugins tab to Capabilities`.

### Task 22: Plugins list

**Files:**
- Create in `cockpit/areas/capabilities/plugins/`: `PluginsTab.tsx`, `PluginRow.tsx`, `use-plugin-filters.ts` and `plugin-view.ts`
- Test: `PluginsTab.test.tsx`, `plugin-view.test.ts`

**Layout:**
- `CapabilitySearch` with the tab label "Plugins". Its actions are "Install from Git" and "Add from folder"; the latter is hidden when the Gateway reports `remote_hardened`. The placeholder suggests a real plugin name from the list (`pluginSearchPlaceholder` in `plugin-view.ts`, like Phase 3's skill suggestion), and "Search plugins" when the list is empty.
- The list paints from cached data and refreshes in the background, as the other tabs do.
- One `CategoryFilter`: "Built in" and "Unverified", shown when both are present.
- Two sections: "Installed", then "Built in" (available).
- Rows use the two-column grid. Each row has:
  - `LetterIcon`
  - the name, with a label "Built in" or "Unverified"
  - the description
  - a state line: "Installed · <pieces summary>", "Install not finished", "Removing…" or "Ready to install"
  - one action: "View", "Continue" or "Install"
- The pieces summary is written by `plugin-view.ts` from `pieceCounts` with `plural()`, for example "2 skills, 1 connector".

**Empty and error states:**
- No plugins installed: "No plugins yet. Install one from the built-in list, a Git repository or a folder."
- A failed read: "Plugins can't be read right now." with "Try again".
- No search matches: "No plugins match." with "Clear filters".

- [ ] **Step 1: Write the failing tests:**
  - `it("lists installed plugins first, then built-in ones")`.
  - `it("labels unverified plugins")`.
  - `it("offers Continue for an install that isn't finished")`.
  - `it("hides Add from folder when remote hardened")`.
  - `it("shows Try again when the list fails, never an empty list")`.
  - `it.each` over the empty and error states.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them, the copy guard and `perf:check` (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): list plugins`.

### Task 23: Install panel and flow

**Files:**
- Create in `plugins/`:
  - `use-plugin-install.ts` and `plugin-install-store.ts`, a module store keyed by inspection id, like Phase 3's
  - `PluginInstallPanel.tsx`, `PluginPieceList.tsx`, `PluginSourceForm.tsx` and `use-plugin-install-panel.tsx`
- Test: `use-plugin-install.test.tsx`, `PluginInstallPanel.test.tsx`, `PluginSourceForm.test.tsx`

**Interfaces:**
- Consumes: Task 21's client, `SettingsApprovalDialog`, and Phase 3's `requestStep` client for skill steps.
- Produces:

```ts
export type PluginInstallState =
  | { phase: "idle" } | { phase: "checking" }
  | { phase: "check_failed"; message: string; code?: string }
  | { phase: "ready"; inspection: CapabilityPluginInspection }
  | { phase: "following"; detail: CapabilityPluginDetail; waitingApprovalId?: string }
  | { phase: "done"; pluginId: string }
  | { phase: "failed"; message: string; detail?: CapabilityPluginDetail };
export function usePluginInstall(key: string): {
  state: PluginInstallState;
  inspect(source: PluginSource): void;
  confirm(hookSecrets: Readonly<Record<string, string>>): void; // install, then each skill's install and switch-on
};
```

**Flow:**
1. `confirm` posts the install.
2. When the plan applies, the flow requests `install_inactive`, then `activate`, for each skill piece in manifest order, as Phase 3's flow does.
3. It follows the plugin detail, with Phase 3's pacing: every second for the first 30 reads while a step applies, then every 3 seconds; every 5 to 30 seconds while a step waits.
4. Each waiting approval opens `SettingsApprovalDialog` in place, titled "Approve installing <name>?" for the plugin, then "Approve installing <skill>?" and "Approve switching on <skill>?".
5. After a reload, the detail is the truth. An install that isn't finished offers "Continue", which carries on from the first piece that isn't done.
6. `done` swaps to the plugin panel (Task 24), with "Takes effect in new chats" when the plugin added skills, connectors or tool rules.

**Panel content:**
- **"What it is":** the name, version, author (if any) and description.
- **"Where it comes from":**
  - "Ships with GoatCitadel"
  - "Git repository on <host>, pinned to commit <short>"
  - "Folder on this computer"

  Plus the trust label. Unverified adds: "GoatCitadel hasn't reviewed this plugin. Its pieces still go through GoatCitadel's checks."
- **"What it adds":** one row per piece, with its kind label (Skill, Connector, Tool rule, Hook, Prompt pack), its `label`, its `asksFirst` line, any hosts ("Allows <hosts>") and its check. A check reads "Passed GoatCitadel's checks", "Already installed. Stays when you uninstall." or the blocked message. Hook rows have a "Signing secret" password field with the hint "The secret your receiver checks. GoatCitadel keeps it and never shows it again."
- **"What happens next":**
  - With the setting on: "Installs everything at once, because your setting to skip approvals for your own changes is on."
  - With the setting off: "Asks you <n> times: once for the plugin and twice for each skill."
  - Both add, when there are connectors: "Connectors that need a sign-in ask you to sign in afterwards."
- **The primary button** reads "Install". It is enabled only when the inspection is `installable` and every hook secret is filled.
- **A refused manifest** shows one plain line per code. The exact copy is in `plugin-check-copy.ts`:
  - FEATURE_FLAGS_NOT_ALLOWED: "Plugins can't change GoatCitadel's feature settings."
  - CHAT_INSTRUCTIONS_NOT_ALLOWED: "Plugins can only add instructions as skills, which GoatCitadel checks."
  - HOOK_MUST_ONLY_OBSERVE: "Its hooks try to change what happens, but plugin hooks can only watch."
  - HOOK_CODE_NOT_ALLOWED: "Its hooks would run code, which plugins can't."
  - PRESET_MUST_TIGHTEN: "It tries to loosen a safety rule, but plugins can only tighten them."
  - UNKNOWN_PIECE_KIND: "It includes a kind of piece GoatCitadel doesn't support."
  - PIECE_PATH_INVALID: "One of its file paths points outside the plugin."
  - MANIFEST_MISSING: "There's no goatcitadel-plugin.json at its top level."
  - anything else: the `describeApiError` wording

  Every refused panel ends with "So it can't be installed."
- **Source form** (Install from Git): "Git repository address" (https only, no user or token, as Phase 3's form) and an optional "Commit, branch or tag". Add from folder: "Folder path", with the hint "A folder on the computer GoatCitadel runs on." The form has a "Check" button.

- [ ] **Step 1: Write the failing tests:**
  - `it("installs every piece from one confirmation when the setting is on")`.
  - `it("opens each approval in place when the setting is off")`.
  - `it("continues an install left unfinished after a reload")`.
  - `it("never shows Installed before every skill is switched on")`.
  - `it("keeps Install disabled until every hook secret is filled")`.
  - `it("explains each refusal in plain words and offers no Install")`.
  - `it("shows the pin and the unverified warning")`.
  - `it("refuses a Git address that isn't https before checking")`.
  - `plugin-check-copy.test.ts`: every refusal code has copy, and none uses a copy-guard word.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run them, the copy guard and `perf:check` (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): install plugins from the built-in list, Git or a folder`.

### Task 24: Plugin panel and "From <plugin>" labels

**Files:**
- Create in `plugins/`: `PluginPanel.tsx`, `PluginUninstall.tsx` and `use-plugin-panel.tsx`
- Modify the other tabs:
  - Skills `SkillRow.tsx` and `SkillPanel.tsx`
  - Connectors' row and Manage panel, which hide Remove and edit for owned connectors
  - Tools' row and group panel, where a held group's switch is disabled with "Off · held by <plugin>"
  - Library `LibraryPromptPacks.tsx`, which hides Reset for owned packs
  - Settings `HooksSettings.tsx`, which disables edit and delete for owned hooks

  Each shows "From <plugin>", linking to `?item=plugin:<id>` on the Plugins tab. A skill with `removedWithPlugin` reads "Removed with <plugin>", with the reason "Its plugin was uninstalled, so the AI can't use it", and offers no switch.
- Test: `PluginPanel.test.tsx`, plus additions to each touched component's test.

**Plugin panel:**
- The header, the source and the pin.
- "What it added": each piece with its state and a link (`href`).
- "Technical details": the ids, the full pin and the manifest hash.
- **Uninstall** is a danger button. Its confirmation lists exactly:
  - "Removes: <owned pieces>"
  - "Stays: <kept pieces>, and the hosts it allowed"
  - for prompt packs: "Deletes <n> prompt-pack runs"
- The flow follows the detail until the plugin disappears, then focus returns to the list.

- [ ] **Step 1: Write the failing tests:**
  - `it("lists what uninstall removes and what stays")`.
  - `it("follows an uninstall until the plugin is gone")`.
  - `it("shows From Browser checks on its skill and connector, with a link")`.
  - `it("disables a held group's switch and says why")`.
  - `it("hides Remove on a plugin's connector")`.
  - `it("hides Reset on a plugin's prompt pack")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the capabilities, library and settings tests, the copy guard and `perf:check` (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): manage and uninstall plugins`.

### Task 25: Retire capability packs (Gateway, contracts)

**Files:**
- Delete:
  - `capability-pack-service.ts`, `capability-packs-route-service.ts` (71 → 70), `routes/capability-packs.ts`
  - `capability-pack-bindings.ts`, `capability-pack-candidate-service.ts`, `capability-pack-change-plan-adapter.ts`, `capability-pack-compensation.ts`, `capability-pack-mcp-owner.ts`
  - all their tests
  - `packages/contracts/src/capability-packs.ts`
- Modify:
  - `gateway-service.ts:1172,1322,3362-3409`
  - the composition files, `gateway-route-services.ts` and `app.ts:80,501`
  - `route-access.ts:89`
  - `evolution-control-plane-governance.ts:17-24`: `change.request` drops `capability_pack`
  - `evolution-control-plane-service.ts:505-509,525-540`
- Keep:
  - the `capability_pack` kind in contracts and storage, so old plans parse
  - `ChangePlanCapabilityPackRequest`
  - candidate `sourceKind: "capability_pack"`
  - `McpServerRecord.packChange`
  - the evidence event kinds
- Modify: `evolution-control-plane-service.ts`. A `capability_pack` plan lists and reads normally. Any action answers 409 `CAPABILITY_PACKS_RETIRED`: "Capability packs were replaced by plugins."
- Measure: `ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_NAMES` names `capabilityPackService`. If removing it from the source alias raises the widening count above 1, stop and ask the operator before editing the metrics script's list.

- [ ] **Step 1: Write the failing tests:**
  - `it("reads an old capability pack plan")`.
  - `it("answers retired for any action on it")`.
  - `it("answers 404 for the retired capability pack routes")`.
  - `it("offers Chat no capability pack plans")`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.** Rebuild contracts. Measure GatewayService (about −50 lines) and `routeFacingServiceCount` (70).
- [ ] **Step 4: Run them, the evolution tests and `pnpm verify:architecture:metrics` (PASS).**
- [ ] **Step 5: Commit:** `refactor(gateway): retire capability packs`.

### Task 26: Retire the packs page; public truth and proof (PR 4e)

**Files:**
- Delete from the cockpit: `PortablePacksSettings.tsx`, `PortablePackSetup.tsx`, `PortablePackEvidence.tsx` and `PackPlanControls.tsx`, with their tests. Also remove the `addons` section from `SettingsArea.tsx` and `settings-controls.ts`.
- Delete from Classic: `AddonsSection.tsx`, `PortablePacksSection.tsx` and `PackExecutionPanel.tsx`, with their `.css` and tests, plus the 7 pack hook and binding files (`use-portable-packs.ts`, `use-pack-execution.ts`, `use-pack-plan-action.ts`, `pack-evidence-binding.ts`, `pack-plan-binding.ts`, `pack-mutation-state.ts`, `pack-plan-presentation.ts`). Remove them from `SettingsNativePage.tsx`, `SettingsShared.tsx` and `legacy-route-adapter.ts`.
- Delete from shared: the 8 capability-pack fetchers and `copy.ts`'s `addons` page and nav item. Keep the "Capability pack" label in `ChatChangePlanCard.tsx:30` for old plans.
- Modify:
  - `route-release-scope.ts` (drop `settings/addons`), `release-surface-manifest.mjs:113,469-476`, `docs/1_0_RELEASE_SURFACE_SCOPE.md`, `docs/1_0_RELEASE_EVIDENCE.md:40` and `README.md:214`: 49 routes, 44 `ship`, 5 `experimental`
  - delete the 8 `visual-regression-settings-addons-*.png` files
  - fix `route-release-scope.projection.test.ts:225-247`, whose fixture moves to another experimental row
- Modify the proof:
  - Delete `cockpit-portable-packs-proof.mjs` and its test (58 → 57 in `ux-budgets-lane.test.mjs`).
  - Remove the `settings-addons` rows from `surface-regression-lane.mjs`, the usability registry, evidence and coverage, and `self-configuration-lane.mjs:78-81`.
  - Extend `cockpit-library-link-proof.mjs`, as Phase 3 did: open `/capabilities/plugins?item=plugin:browser-checks` and assert the panel.
  - Lower the guard budgets by exactly what was deleted (live regions −14 by the survey's count, so recount; plus raw controls and the copy ratchets).
- Docs:
  - `README.md`: the Capabilities paragraph covers plugins; `:135` drops "Add-ons & packs"
  - `PRODUCT.md:35`: Capabilities gains plugins
  - `AGENTS.md`: the Settings row, and "Integrations, Channels, and Extensions" names plugins as bundles that run no code
  - `docs/1_0_CONTRACT.md:153-154`: plugins as implemented, with Built in and Unverified, and no Verified tier
  - `docs/CAPABILITY_SYSTEM_V1.md:18`
  - `docs/ENGINEERING_HANDBOOK.md`
  - `docs/QA_MANUAL_TEST_PLAN.md`: a PLUGIN-01 case
  - `CHANGELOG.md`

- [ ] **Step 1: Delete and update.** Run the settings, native-routes and shared tests, the mc-next typecheck, `perf:check`, the copy guard and `pnpm docs:check` **(PASS)**.
- [ ] **Step 2: Run the PR 4e checks:**
  - typechecks for contracts, gateway, shared and mc-next
  - `perf:check`
  - the Gateway tests from Tasks 20 and 25
  - the cockpit `areas/capabilities/`, `areas/settings/` and `areas/library/` tests
  - `pnpm verify:journey:producers`
  - `pnpm verify:skill-hub:lifecycle`
  - `pnpm verify:architecture:metrics`
  - `pnpm verify:skills:catalog`
  - the copy guard
  - `pnpm docs:check`
  - `git diff --check`
- [ ] **Step 3: Get browser proof** on the testbench sandbox. Show:
  - The Plugins tab at desktop and phone widths, in light and dark themes.
  - Installing Browser checks with the setting on, as one press.
  - Installing it with the setting off: the plugin approval, then the skill's two, in place, with a reload in between that shows "Install not finished" and resumes.
  - The Skills, Connectors and Tools rows saying "From Browser checks".
  - Editing the plugin's connector in Advanced setup, refused.
  - Uninstalling, then checking that the skill reads "Removed with Browser checks", the connector is gone and the Playwright host is still allowed.
  - Install from Git with a public repository holding a test plugin, if the network allows; otherwise a refused host shows its plain line.
  - Add from folder with the SDK's reference plugin.
  - A hostile fixture folder (a link and a mutate hook) refused in plain words.
- [ ] **Step 4: Note in the PR body** the manual `visual-rebaseline.yml` run: Classic Settings lost a page, and no Capabilities baseline exists yet. **Step 5: Commit:** `docs: plugins replace add-ons and capability packs`. Then open PR 4e.

---

## Architecture metrics, PR by PR

| PR | GatewayService lines | Route-facing services | Other counts | Allowance |
|---|---|---|---|---|
| 4a | 13132 → about 13118 | 71 → 70 (baseline) | Port members 188 → 186. Deleted files become improvements. Edit the host-guard test list. | None |
| 4b | about −10 (override service, dead import) | 70; `integration-route-service.ts` stays | integration-channel, composition-integrations and tool-invocation-coordinator counts fall | None |
| 4c | +≤3 (one registration) | 70 → 71 (`capability-plugins-route-service.ts`) | New files 0 each (plain readers). `skill-import-service` and `skill-hub-review-service` must not rise. | None expected |
| 4d | +≤6 (two adapters) | 71 | `mcp-server-admin-service`, `hooks-service`, `prompt-pack-service` and `capability-skill-actions-service` must not rise | **Expected: one C0 ask** for the plugin install and uninstall adapters, with the exact counts (Phase 1 precedent 14/0) |
| 4e | about −50 (pack adapter and service) | 71 → 70 | Removing `capabilityPackService` from the composition alias may move the widening count; stop and ask if it rises | None expected |

Measure with `countDependencyMemberAccesses` and `countHostMemberAccesses` per file while building. Run `pnpm verify:architecture:metrics` once per PR on the whole tree. GatewayService headroom from 4a and 4b covers 4c and 4d. Never refresh the pinned baseline.

## Spec coverage for Phase 4

| Spec requirement | Task |
|---|---|
| A plugin lists skills, connector templates, tool-group and approval presets, hooks and prompt packs; no executable code | 10, 16 |
| Presets only tighten; hooks only observe (and the reject list); no feature flags; no chat instructions | 10, 13, 15 |
| Built on capability packs: renamed to plugin, `addon`, old `plugin` and `runtime_preset` dropped, the Cowork-era packs not shipped | 10 (new manifest), 20, 25 |
| Built in and Unverified labels; the Gateway clones and inspects; the operator can pin a commit | 11, 13, 23 |
| Install panel: every piece, what it asks first, source and pin; inspection before Install; each piece's own checks behind one confirmation | 12, 13, 16, 17, 23 |
| "From plugin X", read-only; uninstall removes exactly what the plugin added | 15, 17, 18, 24 |
| Remove Arena, the add-ons service and routes, dashboard slots, Settings › Add-ons & packs | 1–4, 26 |
| Remove integration plugins: manifest, install route, runtime list, "Installed plugin trust" | 5, 8, 9 |
| `packages/extensions-sdk` keeps only what plugins need | 9, 10 |
| A migration for stored add-on and integration-plugin records | 7 (add-ons have no stored records; their files stay, Task 4 release note) |
| Docs and public claims (`1_0_CONTRACT`, README, AGENTS.md) | 4, 9, 19, 26 |
| Relabel the Citadel/workspace "Plugins" selection | 8 |
| #572's skip covers Capabilities actions; `remote_hardened` always asks; AI actions keep every approval | 16, 18 |
| Claude Code import not precluded | 10 (`kind`-discriminated pieces, the `ignored` list) |

**Deliberate limits, and why:**
- **Git sources come only from the four trusted forges, and the fetch doesn't consult the network allowlist.** It's the same rule and the same hardened fetch as Import from Git, which Phase 3 shipped.
- **Connector pieces name shipped templates (Q3 A),** so a plugin can't add a connector GoatCitadel hasn't listed. A remote MCP address is the first extension if wanted, then Phase 5's import.
- **No Update.** Uninstall then install picks up a new commit. An Update that re-inspects and shows what changed is a follow-up.
- **Snapshots stay on disk after uninstall.** They are content-addressed and small, and a reinstall reuses them. A cleanup sweep is a follow-up.
- **Plugin hooks live in the workspace that was active at install.**
- **No tab counts,** as on the other three tabs.

**Found on the way (follow-ups, not in this plan):**
- `cockpit-visual-manifest.mjs:74` still captures `/settings/connections`, which #655 redirects. The visual lane would wait for a page that no longer exists.
- The SDK 2.0.0 publish (the operator tags `extensions-sdk-v2.0.0`).
- Real skill removal (Q4 B), shared with Phase 3's Remove follow-up.
- Phase 5: Claude Code plugin import, after a spike.
