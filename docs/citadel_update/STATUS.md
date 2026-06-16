# Citadels — Overnight Work Status

**Branch:** `fix/workspace-isolation-leaks` (pushed to origin, every commit)
**Base:** `main` @ `f52faa81e`
**Date:** 2026-06-16 (overnight autonomous session)
**Rule followed:** TDD (failing test first), one concept per commit, push only when green. The tree is never left broken.

---

## TL;DR

The **floor is done and the safe stretch is done.** Four green, committed, pushed increments:

1. **Leak #3 — silent `.env` secret fallback** → fixed (real behavior change).
2. **Leak #2 — approval listing broadcast** → workspace scope filter (enforced + tested).
3. **citadel-core foundation** → Citadel identity types + scope helpers.
4. **Leak #1 — global `memory_items` store** → workspace_id column + scoped read (enforced + tested).

I **deliberately stopped short of leak #5** (policy engine) — reasoning below. Nothing is half-built.

---

## What landed (commits, newest first)

| Commit | What |
|---|---|
| `819197208` | feat(memory): workspace-scope the `memory_items` store (#1) |
| `19784b245` | feat(citadel-core): Citadel identity types + scope helpers |
| `31eb58d1f` | feat(approvals): optional workspace scope filter on approval listing (#2) |
| `1836381f9` | fix(secrets): require explicit opt-in before plaintext `.env` secret fallback (#3) |
| `e0e4b9dfa` | docs(citadel): spec + reuse audit |

### 1. Leak #3 — plaintext secret fallback (DONE — real fix)
`persistProviderApiKeyWithFallback` silently wrote the provider API key to a plaintext `.env` when the OS keychain was unavailable. Now it **throws** unless explicitly opted in via `allowEnvFallback` or `GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1`. Keychain-less hosts keep a documented path; the silent downgrade is gone. (`provider-secret-persistence.ts`, 6/6 tests, all caller suites green.)

### 2. Leak #2 — approval broadcast (DONE — mechanism enforced)
`listApprovals` returned every workspace's approvals. Added an optional `workspaceId` filter threaded route→runtime→lifecycle→`ApprovalRepository.list`, filtering in memory on `linkage.workspaceId` (over-fetch when scoped). No `workspaceId` = global operator inbox (unchanged). Repo isolation test + route wiring test. *Enforcement activates when citadel-core supplies the viewer's scope.*

### 3. citadel-core foundation (DONE)
`packages/contracts/src/citadels.ts`: `Charter`, `Chamber` (sensitivity/sealed), `CitadelKind`, risk/model-policy enums, and the reusable scope primitives **`resolveCitadelScope()`** and **`isWithinCitadelScope()`** (encodes the isolation rules: hard cross-Citadel boundary; chamber-scoped viewers see their chamber + citadel-general items). 9/9 tests.
> Placed in `contracts` (not a new `citadel-core` package) to avoid build-graph/tsconfig-reference risk overnight. Extracting to a dedicated package later is a pure move — no contract changes.

### 4. Leak #1 — global memory_items (DONE — mechanism enforced)
`memory_items` had no workspace scope and `listActiveMemoryItems` returned everything. Added `workspace_id` column (sqlite CREATE + migration **v110**, postgres parity) and an optional `workspaceId` filter returning the workspace's items **plus** global (NULL) items. Repo isolation test. *Consumer (`memory-context-service`) not yet wired — see deferred.*

---

## Verification

- **storage**: full suite **559 pass / 0 fail**, typecheck clean.
- **contracts**: **163 pass / 2 fail**, typecheck clean. ⚠️ The 2 failures are **pre-existing and unrelated** — `follow-on-parity.alignment` (a `docs/FOLLOW_ON_PARITY_REGISTER.md` vs constant drift) and `provider-templates`. The branch never touched those files (`git diff --name-only f52faa81e HEAD` confirms). Not introduced by this work; left alone as out of scope.
- **gateway**: typecheck clean; approval + memory-context + secret suites green.

---

## Deliberately deferred (and why) — these are citadel-core work, not standalone patches

| Item | Why deferred | Where it lands |
|---|---|---|
| **Leak #5 — policy-engine global-grant fallback** | Entirely latent (no citadel-scoped policy requests exist yet → pure no-op plumbing tonight), but lives in the most security-sensitive, most-tested subsystem and the `ToolGrantScope` union ripples into storage/validation. Not worth touching the security core unsupervised for zero practical gain. | Choke-point: `buildScopeCandidates()` ~`packages/policy-engine/src/engine.ts:1618`. Add `"citadel"`/`"chamber"` to `ToolGrantScope` (`packages/contracts/src/tool-grants.ts`), push citadel/chamber candidates before `global`, and make the global fallback conditional for citadel requests. |
| **Leak #4 — agent grant ceiling** | `defaultTools` is catalog/loadout metadata, not an enforced ceiling. The real fix is scoped agent grants via the **existing** policy engine — building a parallel gate would violate the reuse directive. | citadel-core agent identity: `agent_capability_grants` keyed by `(agentId, citadelId)`; blend into the tool-policy check in `chat-agent-orchestrator.ts`. |
| **#1/#2 consumer wiring** | The mechanisms are built + tested at the storage layer. Activating them needs a *real* `workspaceId`/citadel scope on the request. `MemoryContextComposeRequest.workspace` is a path, not an id; the approvals route accepts `?workspaceId=` but nothing sends it yet. | citadel-core threads `resolveCitadelScope(request)` into the compose request and the approval-list callers. |
| **Citadel storage repo** (charters/chambers tables + CRUD) | Lower-risk (new tables) but it's enablement, not leak-closing; stopped to keep the night's output finished-and-clean rather than cram another feature. | `packages/storage/src/citadel-repo.ts` + `citadel_charters` / `citadel_chambers` tables. |

---

## Open §6 decisions still needing your call (from reuse-audit.md)

1. **Chamber = column vs namespace-prefix** on scoped tables. (I used a real `workspace_id` column for memory; chambers will want a `chamber_id` column to match.)
2. **Tamper-evident audit** now or defer the hash chain. (Recommend defer.)
3. **Global-grant inheritance** — should a new Citadel inherit *any* global grants? (Recommend empty/least-privilege; this is the #5 enforcement decision.)
4. **`.env` fallback** — keep the opt-in (done) or hard-disable for sealed Chambers later.

---

## Suggested next session

1. Pick up **citadel-core** as the home for #4, #5, and the #1/#2 consumer wiring — they're one coherent scope-spine, not separate patches.
2. First slice: thread `resolveCitadelScope(request)` into the approval-list route + the memory compose request → flips #1 and #2 from "mechanism built" to "enforced end-to-end."
3. Then the citadel storage repo (charters/chambers) so Citadels are persistable.
4. Resolve the 4 open decisions above before the schema for chambers/grants is written (hard to reverse).

To review: `git log --oneline f52faa81e..fix/workspace-isolation-leaks` and open a PR when you're happy.
