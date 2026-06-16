# Citadels — Build Status

**Branch:** `fix/workspace-isolation-leaks` (pushed to origin, every commit)
**Base:** `main` @ `f52faa81e`
**Date:** 2026-06-16
**Rule followed:** TDD (failing test first), one concept per commit, push only when green. The tree is never left broken.

---

## TL;DR

A coherent, fully-tested **citadel-core MVP foundation** is built, committed, and pushed — plus the standalone isolation-leak fixes. Ten green commits. The spec is not "complete" (the Mason agent, Vault crypto, Council/Missions/Archive/Watchtower wiring, and the mission-control UI are each large, multi-session efforts), but a large slice of §25 (MVP) and §26 (tickets) is done end-to-end.

---

## Commits (newest first)

| Commit | What |
|---|---|
| `40309778a` | feat: Blueprint export, validate, import (§8) |
| `845a790d5` | feat: launch templates + create-from-template (§7) |
| `e530d84d1` | feat: gateway routes for Citadel charter + chambers (§22, ticket 5) |
| `bdedc0408` | feat: persist Citadel charters + chambers — CitadelRepository (ticket 4) |
| `819197208` | feat: workspace-scope the memory_items store (#1) |
| `19784b245` | feat: citadel-core identity types + scope helpers |
| `31eb58d1f` | feat: optional workspace scope filter on approval listing (#2) |
| `1836381f9` | fix: require explicit opt-in before plaintext `.env` secret fallback (#3) |
| `e0e4b9dfa` | docs: spec + reuse audit |
| (this) | docs: status |

## What's built (spec mapping)

**citadel-core (the scope/identity spine):**
- `packages/contracts/src/citadels.ts` — `Charter`, `Chamber`, `CitadelKind`, sensitivity/risk/model-policy enums; scope primitives `resolveCitadelScope()` + `isWithinCitadelScope()` (hard cross-Citadel boundary; chamber-scoped viewers see their chamber + citadel-general items). **A Citadel IS a workspace** (citadelId aliases workspaceId).
- `packages/storage/src/citadel-repo.ts` — `CitadelRepository` (charter upsert/get, chamber create/list/get, getCitadel) over `citadel_charters` + `citadel_chambers` (sqlite migration v111; auto-rendered to Postgres). Wired as `storage.citadels`.
- Gateway routes (`apps/gateway/src/routes/citadels.ts`, operator-gated, zod-validated):
  - `GET /api/v1/citadels/:id`, `PUT /api/v1/citadels/:id/charter`
  - `GET|POST /api/v1/citadels/:id/chambers`
  - `GET /api/v1/citadel-templates`, `POST /api/v1/citadels/:id/from-template`
  - `GET /api/v1/citadels/:id/blueprint`, `POST /api/v1/blueprints/validate`, `POST /api/v1/citadels/:id/from-blueprint`

**Templates (§7):** 3 built-in templates (Personal Chief of Staff, Company Co-Founder, Project Command) as data + pure `applyCitadelTemplate`.

**Blueprints (§8):** `exportCitadelBlueprint` (structure only — strips ids/timestamps/secrets), `validateCitadelBlueprint` (schema + secret-shaped-content scan), `applyCitadelBlueprint` (import validates before applying).

**Isolation leaks:** #3 fixed (real); #1 + #2 storage-layer mechanisms enforced + tested (activate when a real scope is threaded into requests — see below).

### §25 MVP must-haves status
Done: Citadel creation (routes) · templates · Blueprint generation · Blueprint import/export · Charter · lightweight Chambers · review-before-activation primitive (validate-before-apply). Not yet: Mason setup flow · basic Council · basic Missions · basic Archive · basic Watchtower · Gatehouse summary · UI surfaces.

## Verification
Every increment: package test suite + typecheck green before commit. Storage full suite 564 pass. Gateway typecheck clean across all route wiring. Contracts citadel suites 18 pass. (Contracts has 2 **pre-existing** failures — `follow-on-parity.alignment`, `provider-templates` — untouched by this branch; `git diff --name-only f52faa81e HEAD` confirms.)

## Deliberately deferred (citadel-core scope-spine work, not standalone patches)
- **#4 agent grant ceiling** — scoped agent grants via the existing policy engine (don't build a parallel gate). Choke-point: `chat-agent-orchestrator.ts` tool-policy check.
- **#5 policy global-grant fallback** — latent + lives in the security core; add `"citadel"`/`"chamber"` to `ToolGrantScope` and `buildScopeCandidates()` (`policy-engine/src/engine.ts:~1618`), make global fallback conditional.
- **#1/#2 consumer wiring** — thread `resolveCitadelScope(request)` into the memory compose request + approval-list callers to flip the mechanisms from "built" to "enforced end-to-end."

## Remaining spec (large, multi-session)
- **The Mason** (§9) — conversational setup agent producing/validating Blueprints (built on existing chat/agent infra).
- **Council** (§16) — agents as scoped identities (extend existing agents + grants).
- **Missions** (§17) — thin Mission wrapper over the existing orchestration/durable engine.
- **Archive** (§18) — extend memory-core/Library with Citadel scope.
- **Watchtower** (§19) — extend the existing cron_jobs scheduler with citadelId.
- **Gatehouse** (§20) — summary over existing policy/approvals/secrets, scoped per Citadel.
- **Vault** (§13) — envelope crypto + key hierarchy (genuinely net-new; defer per plan).
- **UI** (§6, mission-control-next) — Citadel list/overview/charter/chambers/Mason/blueprint surfaces.
- **Sharing/Passages** (§12), **model routing** (§14) — later.

## Open §6 decisions (recommended defaults applied so far)
Citadel = Workspace ✓ · Chamber = real column ✓ · global-grant inheritance = empty (pending #5) · audit append-only (defer tamper-evident) · `.env` fallback opt-in ✓.

Review: `git log --oneline f52faa81e..fix/workspace-isolation-leaks`.
