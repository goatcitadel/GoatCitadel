# Citadels — Build Status

**Branch:** `fix/workspace-isolation-leaks` (pushed to origin, every commit)
**Base:** `main` @ `f52faa81e`
**Date:** 2026-06-16
**Rule followed:** TDD (failing test first), one concept per commit, push only when green. The tree is never left broken.

---

## TL;DR

The **structural MVP data model is complete** end-to-end (storage + gateway routes), fully tested and pushed, plus the standalone isolation-leak fixes. 20 feature commits. What remains is the *experiential* and *hard-crypto* spec — the **Mason** conversational agent, the **Vault** envelope encryption, the **mission-control UI**, sharing/Passages, model routing, and the consumer-wiring that flips the scoping mechanisms from "built" to "enforced." Those are large, multi-session, and several are big new surfaces (a conversational agent; an entire React UI; cryptography). They are **not** done.

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
| **Gatehouse** (§20) | `summarizeCitadelGatehouse` | `GET /api/v1/citadels/:id/gatehouse` |
| **Watchtower** (§19) | `cron_jobs.citadel_id` (v112) + `listByCitadel` | (scheduler wiring pending) |
| **Scope spine** | `resolveCitadelScope` / `isWithinCitadelScope` | enforced in repo isolation tests |

All routes operator-gated + zod-validated. Citadel = Workspace (`citadelId` aliases `workspaceId`).

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

## Commits (20 feature + docs)
`54d834aa8` archive routes · `0b6eb344f` archive storage · `75265e75b` mission routes · `e9f32f021` mission storage · `26ab31f79` council routes · `f98b411d7` council storage · `6cc7765ce` watchtower scope · `b34855fc1` gatehouse · `40309778a` blueprints · `845a790d5` templates · `e530d84d1` citadel routes · `bdedc0408` citadel repo · `819197208` #1 memory · `19784b245` scope helpers · `31eb58d1f` #2 approvals · `1836381f9` #3 secrets · (+ docs).

## NOT done — the large remaining spec
- **The Mason** (§9) — conversational setup agent (built on existing chat/agent infra). Large.
- **Vault** (§13) — envelope crypto + key hierarchy. Genuinely net-new; defer per plan.
- **UI** (§6) — Citadel list/overview/charter/chambers/council/missions/archive/Mason/blueprint surfaces in `mission-control-next`. Large new surface.
- **Consumer wiring** — thread `resolveCitadelScope(request)` into the approval-list callers + memory compose + cron scheduler so #1/#2/Watchtower enforce end-to-end. (#4 agent grants, #5 policy global-grant fallback also live here — see policy-engine `buildScopeCandidates`.)
- **Council as scoped agent identities** (§16) — current Council is membership records; binding to real agents + grants is the #4 work.
- **Missions as orchestration** (§17) — current Missions are records + state; wrapping the durable/orchestration engine (steps/checkpoints/evidence) remains.
- **Archive ↔ memory** (§18) — current Archive is its own store; unifying with `memory-core` retrieval remains.
- **Sharing/Passages** (§12), **model routing** (§14), **secrets/integrations per Citadel** (§15) — later.

## Suggested next session
1. **Consumer wiring** — biggest leverage: thread the scope into requests → #1/#2/Watchtower go live; then #4/#5 in the policy engine.
2. **The Mason** as an MCP/skill that emits Blueprints (the export/validate/import plumbing already exists).
3. **UI** — wire the gateway routes (all built) into mission-control-next surfaces.

Review: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.
