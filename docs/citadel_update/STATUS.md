# Citadels — Build Status

**Branch:** `fix/workspace-isolation-leaks` (pushed to origin, every commit)
**Base:** `main` @ `f52faa81e`
**Date:** 2026-06-16
**Rule followed:** TDD (failing test first), one concept per commit, push only when green. The tree is never left broken.

---

## TL;DR

The **structural MVP data model is complete** end-to-end (contracts logic + storage + 34 gateway routes), fully tested and pushed, plus the standalone isolation-leak fixes. 40 commits. Since then two of the three large remaining surfaces have been **completed this session**:

1. **The Mason's conversational layer (§9)** — `POST /api/v1/mason/sessions/:id/message` interprets a freeform message with the **real configured model** (`llmService.chatCompletions`), strictly parses the output (hallucinated/injected fields can't poison setup), and merges only valid answers. Degrades gracefully to the structured-answers path when no model is configured. End-to-end wired through composition.
2. **The UI data layer (§6)** — typed citadel/Mason API client in `mission-control-shared` over the existing `request()` transport, covering all 22 citadel + Mason endpoints, barrel-exported for the React screens.

The **mission-control UI (§6) is now complete across all five Citadel surfaces** — Mason (stage), Overview (manage), Wards (policy), Council, and Blueprint (portability) — all built on the proven pattern, all typecheck/lint/test green. What genuinely **remains** is just two surfaces, both held back for principled reasons: the **engine.ts request-path enforcement surgery** (threading citadel Wards/roles + scope into the policy engine that gates *every* privileged action — security-critical, a request-path threading job, must not be done unsupervised) and the **Vault** hard-crypto key hierarchy (**deferred by the operator's own 2026-06-15 product decision** — ship after the core bet is validated, not an omission).

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

All routes operator-gated + zod-validated. Citadel = Workspace (`citadelId` aliases `workspaceId`).

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
47 commits on the branch. The early parallel-table commits for Council/Missions/Archive were
reverted (`20380f087`) and rebuilt the reuse-correct way (see "Reuse correction"). Latest:
`fdea79259` Mason LLM message step · `076048332` UI API client · `6d973246b` Mason screen ·
`ec3b80945` overview screen · `86c23760d` Wards + Council + Blueprint screens.
Full history: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.

## Completed this session (2026-06-16)
- **Mason LLM conversational layer (§9)** — `interpretSessionMessage` in `citadels-route-service.ts`: builds the interpret prompt (`buildMasonInterpretPrompt`), calls an injected `MasonInterpret`, **strict-parses** with `parseMasonInterpretResponse` (only well-typed known fields with valid enums survive — defense against model hallucination/injection), merges the patch into the session. Wired in composition to `gateway.llmService.chatCompletions`; `503 no_interpreter` / structured-answers fallback when unconfigured. Route `POST .../mason/sessions/:id/message`. Service + route + composition tests green (48 gateway tests). Commit `fdea79259`.
- **UI data layer (§6)** — `packages/mission-control-shared/src/api/citadels.ts`: typed wrappers over `request()` for every citadel + Mason endpoint, barrel-exported via `client.ts`. Each path cross-checked against the registered routes; 10 wrapper tests assert path/method/body/id-encoding. Package typecheck clean. Commit `076048332`.
- **Mason setup screen (§6/§9)** — `mission-control-next/.../library/CitadelMasonRoutePage.tsx`: the first Citadel React surface. Setup questions → session → freeform message (interpreted by the real model via the message endpoint) → captured answers → drafted Blueprint + review-before-activation summary. Registered as the experimental `library/citadel` route. App typecheck + lint clean; 4 component tests (incl. the freeform-message → interpreted-answers flow). Commit `6d973246b`.
- **Citadel overview screen (§2/§20)** — `.../library/CitadelOverviewRoutePage.tsx`: reads the active workspace *as* a Citadel — Charter (purpose/kind/posture/goals/boundaries), Chambers (sealed/sensitivity markers), Gatehouse posture (risk, model policy, sharing, external-writes, ward count). 404 → "not a Citadel yet → open the Mason" (distinguished from real errors via `isApiRequestError`). Experimental `library/citadel-overview` route. Commit `ec3b80945`.
- **Wards editor (§20)** — `.../library/CitadelWardsRoutePage.tsx`: list + add Gatehouse Wards (name/pattern/effect across the 6 `WardEffect`s) and test an action against them (deny-wins, via the gatehouse-evaluate endpoint). Experimental `library/citadel-wards` route. 4 component tests. Commit `86c23760d`.
- **Council (§16)** — `.../library/CitadelCouncilRoutePage.tsx`: agents seated in the Citadel by reference to the existing catalog (read-only; per-seat grant ceilings are the engine work). Experimental `library/citadel-council` route. 3 tests. Commit `86c23760d`.
- **Blueprint import/export (§8)** — `.../library/CitadelBlueprintRoutePage.tsx`: export the active Citadel as a secret-free Blueprint; paste → validate (schema + secret-scan) → import. Experimental `library/citadel-blueprint` route. 4 tests. Commit `86c23760d`.

**The §6 UI is now complete across all five Citadel surfaces** (stage, manage, policy, council, portability), all on the proven pattern, all typecheck/lint/test green; route-model parity holds.

## NOT done — and why (only two surfaces, both for principled reasons)
- **engine.ts enforcement surgery** — thread citadel **Wards** (`evaluateWards`) and **roles** (`roleCan`) into the policy engine that gates every privileged action, and `resolveCitadelScope(request)` into the approval-list callers + memory compose + cron scheduler so #1/#2/Watchtower go live (#4 agent grants, #5 policy global-grant fallback live here too — see policy-engine `buildScopeCandidates`). This is **not a localized edit**: in the single-user local app nothing yet *puts* a citadel scope on the request, so it is a request-path threading job (gateway resolve+attach → clients send → engine consult) across ~7 chokepoints. **Security-critical: a subtle error opens a hole or bricks all actions. The reuse-audit + project memory record this as a deliberate do-NOT-do-unsupervised decision — pair with the operator, drive TDD with a "no citadel scope → behavior byte-identical to today" invariant test FIRST.**
- **Vault hard crypto** (§13) — envelope crypto + key hierarchy. The MVP `sealValue`/`openValue` primitives exist; the full key hierarchy is **deferred by the operator's own product decision** (2026-06-15 review: ship Vault crypto + the Mason *after* the core bet is validated). This is following the user's instruction, not an omission.

## Suggested next session
1. **engine.ts enforcement** (with a human in the loop) — Wards + roles into the policy engine; thread the scope into requests so #1/#2/Watchtower enforce end-to-end. Drive it TDD with a "no citadel scope → behavior byte-identical to today" invariant test FIRST.
2. **Wire the screens into navigation** — they are URL/palette-reachable as experimental routes today; promote to rail items + flip release status when the operator wants them in the primary nav.

Review: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.
