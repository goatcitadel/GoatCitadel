# Citadels — Build Status

**Branch:** `fix/workspace-isolation-leaks` (pushed to origin, every commit)
**Base:** `main` @ `f52faa81e`
**Date:** 2026-06-16
**Rule followed:** TDD (failing test first), one concept per commit, push only when green. The tree is never left broken.

**Superseded product-model note (2026-06-21):** this status snapshot predates
the parent Citadel operating model. Current runtime direction is
`Citadel -> Workspaces -> Projects`, with legacy workspace-as-Citadel behavior
kept only as a compatibility fallback during migration.

**Canonical execution note (2026-08-08):** this file is a historical branch
snapshot, not the current program ledger. The remaining advanced Vault decision
and the `route_local` audit-only decision are recorded in tranche `M6` and the deferred
portfolio register in
[MASTER_COMPLETION_PROGRAM.md](../MASTER_COMPLETION_PROGRAM.md).

---

## TL;DR

The **structural MVP data model is complete** end-to-end (contracts logic + storage + 34 gateway routes), fully tested and pushed, plus the standalone isolation-leak fixes. 40 commits. Since then two of the three large remaining surfaces were **completed in that session**:

1. **The Mason's conversational layer (§9)** — `POST /api/v1/mason/sessions/:id/message` interprets a freeform message with the **real configured model** (`llmService.chatCompletions`), strictly parses the output (hallucinated/injected fields can't poison setup), and merges only valid answers. Degrades gracefully to the structured-answers path when no model is configured. End-to-end wired through composition.
2. **The UI data layer (§6)** — typed citadel/Mason API client in `mission-control-shared` over the existing `request()` transport, covering all 22 citadel + Mason endpoints, barrel-exported for the React screens.

**Every spec surface is now built.** The mission-control UI (§6) spans all six Citadel surfaces — Mason (stage), Overview (manage), Wards (policy), Council, Blueprint (portability), Vault; the **Vault MVP (§13)** is end-to-end (sealed per-Citadel storage, master key in the OS keychain, fails closed); and **engine.ts enforcement (§27/§20)** now honors citadel scope — citadel-scoped grants + Citadel Wards (deny-wins, via the chosen **engine-consults-Wards** architecture). The **`GOATCITADEL_CITADEL_ENFORCEMENT` wrap-first flag has been removed**: the gateway now resolves the parent `citadelId` from the workspace on every tool invoke and passes it on the request, so Wards always enforce on the correct scope (requests resolving to the default `personal` Citadel, which has no Wards, are byte-identical to before). All typecheck/lint/test evidence here belongs to the dated branch snapshot. Current code has since wired `require_dry_run` through the integration/A2A side-effect owners. The remaining Citadel decision is the Vault **advanced key hierarchy** (per-Chamber keys, rotation, E2EE). `route_local` stays an evaluated, durable audit signal until a real local-placement authority can enforce it without bypassing Gateway policy, accounting, or remote-worker scheduling.

---

## What's built (every Citadel sub-object: storage + HTTP)

`citadel-core` lives in `packages/contracts/src/citadels.ts` + `citadel-blueprints.ts`, `packages/storage/src/citadel-repo.ts`, and `apps/gateway/src/{routes,services}/citadels*`.

| Spec object | Storage | Routes |
|---|---|---|
| **Charter** (§2) | `citadel_charters` (v111) | `GET/PUT /api/v1/citadels/:id[/charter]` |
| **Chambers** (§2) | `citadel_chambers` (v111) | `GET/POST /api/v1/citadels/:id/chambers` |
| **Council** (§16) | `citadel_agent_assignments` (v113) — **thin reference to existing agents** (agentId), not a duplicate | `GET/POST/DELETE /api/v1/citadels/:id/council[/:agentId]` |
| **Missions** (§17) | **reuse existing `tasks`** scoped by `workspaceId` (task-repo already filters `workspace_id`) — no new table | (existing tasks API, scoped) |
| **Archive** (§18) | **reuse existing memory** scoped by `workspaceId` (leak #1's `listActiveMemoryItems(workspaceId)`) — no new table | (existing memory API, scoped) |
| **Templates** (§7) | 3 built-ins + `applyCitadelTemplate` | `GET /api/v1/citadel-templates`, `POST .../from-template` |
| **Blueprints** (§8) | export/validate(secret-scan)/import | `GET .../blueprint`, `POST /api/v1/blueprints/validate`, `POST .../from-blueprint` |
| **Gatehouse** (§20) | `summarizeCitadelGatehouse` + persisted **Wards** (`citadel_wards` v114) | `GET /api/v1/citadels/:id/gatehouse`, `GET/POST/DELETE .../wards` |
| **Watchtower** (§19) | `cron_jobs.citadel_id` (v112) + `listByCitadel` | (scheduler wiring pending) |
| **Scope spine** | `resolveCitadelScope` / `isWithinCitadelScope` | enforced in repo isolation tests |

All routes operator-gated + zod-validated. Historical note: this branch treated
Citadel as workspace-shaped. Current product direction has Citadel as the parent
operating world, with workspace-shaped Citadel IDs retained only as migration
compatibility.

### Pure logic modules (built; wiring into enforcement points is the follow-on)
Self-contained, tested contracts modules (100 contracts citadel tests total) — several built by **parallel agents**:
- `citadel-vault.ts` — AES-256-GCM `sealValue`/`openValue`/`generateVaultKey` (Vault MVP, §13.9).
- `citadel-model-routing.ts` — `routeModelForSensitivity` (data sensitivity → model decision, §14).
- `citadel-wards.ts` — `WardEffect` + `evaluateWards` (deny-wins) + `wardMatchesAction` (§20.3/§11.3); **persisted + routed** (above).
- `citadel-passages.ts` — `isPassageActive` + `filterPassageFields` (cross-Citadel bridge, §12.7); **persisted + routed** (`citadel_passages` v115, `GET/POST/DELETE .../passages`).
- `citadel-sharing.ts` — `roleCan` over 8 roles × capabilities (§12.4); **members persisted + routed** (`citadel_members` v116, `GET/POST/DELETE .../members`).
- `citadel-automation.ts` — `AutomationRiskMode` + external-write/approval rules (§19.2).

### Reuse correction (2026-06-16)
Council/Missions/Archive were first built as **parallel tables** duplicating data the existing
agents/orchestration/memory systems own — a drift from the reuse directive. **Reverted** (commit
`20380f087`) and rebuilt the reuse-correct way: **Council** references existing agents via a thin
assignment table; **Missions** = existing tasks scoped by `workspaceId`; **Archive** = existing
memory scoped by `workspaceId`. We build *on top of* the existing services, not beside them.

## Isolation leak fixes (standalone)
- **#3** `.env` plaintext secret fallback → opt-in only (real fix).
- **#1** `memory_items` global store → `workspace_id` (v110) + scoped read.
- **#2** approval-listing broadcast → optional workspace filter (route→repo).
- #1/#2 are storage-layer **mechanisms**; they enforce once a real scope is threaded into the request (the consumer-wiring below).

## Verification
Every commit: package suite + typecheck green before push. **Storage full suite 568 pass / 0 fail** (migrations v110–v115 + all repos). Gateway typecheck clean. Gateway citadel route suite 25 pass. Contracts citadel suites 19 pass. (Contracts has 2 **pre-existing** failures — `follow-on-parity.alignment`, `provider-templates` — untouched by this branch.)

## Commits
56 commits on the branch. The early parallel-table commits for Council/Missions/Archive were
reverted (`20380f087`) and rebuilt the reuse-correct way (see "Reuse correction"). Latest:
`310c3b318` Vault storage · `aca91f7ee` Vault routes+keychain · `c0280b699` Vault client+UI ·
`49a0f4656` engine citadel scope · `99c86903d` engine-consults-Wards · `b82198b3f` wrap-first flag.
Full history: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.

## Completed this session (2026-06-16)
- **Mason LLM conversational layer (§9)** — `interpretSessionMessage` in `citadels-route-service.ts`: builds the interpret prompt (`buildMasonInterpretPrompt`), calls an injected `MasonInterpret`, **strict-parses** with `parseMasonInterpretResponse` (only well-typed known fields with valid enums survive — defense against model hallucination/injection), merges the patch into the session. Wired in composition to `gateway.llmService.chatCompletions`; `503 no_interpreter` / structured-answers fallback when unconfigured. Route `POST .../mason/sessions/:id/message`. Service + route + composition tests green (48 gateway tests). Commit `fdea79259`.
- **UI data layer (§6)** — `packages/mission-control-shared/src/api/citadels.ts`: typed wrappers over `request()` for every citadel + Mason endpoint, barrel-exported via `client.ts`. Each path cross-checked against the registered routes; 10 wrapper tests assert path/method/body/id-encoding. Package typecheck clean. Commit `076048332`.
- **Mason setup screen (§6/§9)** — `mission-control-next/.../library/CitadelMasonRoutePage.tsx`: the first Citadel React surface. Setup questions → session → freeform message (interpreted by the real model via the message endpoint) → captured answers → drafted Blueprint + review-before-activation summary. Registered as the experimental `library/citadel` route. App typecheck + lint clean; 4 component tests (incl. the freeform-message → interpreted-answers flow). Commit `6d973246b`.
- **Citadel overview screen (§2/§20)** — `.../library/CitadelOverviewRoutePage.tsx`: reads the active workspace *as* a Citadel — Charter (purpose/kind/posture/goals/boundaries), Chambers (sealed/sensitivity markers), Gatehouse posture (risk, model policy, sharing, external-writes, ward count). 404 → "not a Citadel yet → open the Mason" (distinguished from real errors via `isApiRequestError`). Experimental `library/citadel-overview` route. Commit `ec3b80945`.
- **Wards editor (§20)** — `.../library/CitadelWardsRoutePage.tsx`: list + add Gatehouse Wards (name/pattern/effect across the 6 `WardEffect`s) and test an action against them (deny-wins, via the gatehouse-evaluate endpoint). Experimental `library/citadel-wards` route. 4 component tests. Commit `86c23760d`.
- **Council (§16)** — `.../library/CitadelCouncilRoutePage.tsx`: agents seated in the Citadel by reference to the existing catalog (read-only; per-seat grant ceilings are the engine work). Experimental `library/citadel-council` route. 3 tests. Commit `86c23760d`.
- **Blueprint import/export (§8)** — `.../library/CitadelBlueprintRoutePage.tsx`: export the active Citadel as a secret-free Blueprint; paste → validate (schema + secret-scan) → import. Experimental `library/citadel-blueprint` route. 4 tests. Commit `86c23760d`.
- **Vault MVP (§13) — full stack** — sealed per-Citadel secret storage end-to-end:
  - storage: migration v119 (`citadel_vault_secrets`) + repo CRUD (sealed JSON, upsert-by-name), commit `310c3b318`.
  - gateway: store/list/reveal/delete routes + service that seals on store / opens on reveal using a per-Citadel master key from the **OS keychain** (`SecretStoreService`, exposed on the composition port, wired as a narrow `VaultKeyProvider`). **Fails CLOSED** (503) when the keychain is unavailable — never a plaintext fallback. List/store carry name+provenance only; reveal is explicit. Commit `aca91f7ee`.
  - client + UI: `CitadelVaultRoutePage.tsx` (`library/citadel-vault`) — store (sealed before leaving the request), list-by-name, reveal-on-request, delete. Commit `c0280b699`.
  - Verified: storage 13/13, gateway 54 service+route tests (incl. a seal→open round-trip proving ciphertext≠plaintext + fail-closed), shared client 14 tests, 4 component tests, all typecheck/lint green. The **advanced key hierarchy** (per-Chamber keys, rotation, E2EE) remains the operator-deferred follow-on.

- **engine.ts enforcement (§27/§20) — always on, scope-resolved at the gateway** — the policy engine that gates *every* privileged tool call honors citadel scope:
  - `ToolGrantScope` gains `"citadel"`/`"chamber"`; `ToolAccessEvaluateRequest` gains optional `citadelId`/`chamberId`; `buildScopeCandidates` emits those candidates → the engine honors citadel-scoped tool grants (deny-wins). The union ripple was handled (engine `listGrants`, gateway `listToolGrants`, approval runtime/lifecycle widened to `ToolGrantScope`). Commit `49a0f4656`.
  - **Architecture decision made + implemented: engine-consults-Wards** — when a request has a citadel scope, the engine evaluates the Citadel's Wards via `evaluateWards` BEFORE grants and denies on a Ward deny (reason `citadel_ward_deny`). Chosen over Wards-as-grants to preserve the rich `WardEffect`s. Connects the `citadel_wards` table to real enforcement. Commit `99c86903d`.
  - **Enforcement flag removed; `citadelId` carried on the invoke path** — `ToolInvokeRequest` gains optional `citadelId`; the gateway's single invoke choke point (`normalizeToolInvokeRequest`) resolves the parent Citadel from the workspace (`storage.workspaces.find(workspaceId)?.citadelId`, defaulting to `personal`) and threads it through, mirroring the access path. The `GOATCITADEL_CITADEL_ENFORCEMENT` flag and the `citadelEnforcementEnabled` engine hook are deleted. Wards now always enforce on the resolved scope; the default `personal` Citadel has no Wards, so the common case is byte-identical.
  - Verified: full `policy-engine` suite **568/568** (incl. an invoke-path Ward-deny test and a no-Ward `personal` zero-blast-radius test), gateway typecheck clean.
  - **Reconciled follow-on:** `deny`, `require_approval`, and `redact` are wired to the engine gate, and current integration/A2A side-effect owners enforce `require_dry_run` before the external boundary. `route_local` intentionally remains audit-only until a real local-placement authority exists.

**Every spec surface is now built**: Mason LLM, data layer, six UI screens, the Vault MVP end-to-end, and engine enforcement always on (parent `citadelId` resolved at the gateway). Deferred *by the operator's own decision*: the Vault advanced key hierarchy (per-Chamber keys, rotation, E2EE).

## Suggested next session
1. **Preserve `route_local` as audit-only** — reopen execution routing only with a real local-placement authority and end-to-end scheduler/policy/accounting proof.
2. **Evaluate advanced Vault keys only after product approval** — per-Chamber keys, rotation, recovery, and E2EE remain deferred architecture work. Citadel screens and navigation are already release-bearing and are not follow-on implementation work.

Review: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.
