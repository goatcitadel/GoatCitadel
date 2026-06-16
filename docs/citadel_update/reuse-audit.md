# Citadels — Services Reuse Audit

**Status:** Engineering input for the Citadels spec (`spec.md`)
**Purpose:** Map every Citadel concept onto an existing service/package and give a `Reuse / Extend / Build-new` verdict, the current scope key, and the change needed to isolate it per Citadel.
**Grounded in:** the monorepo at HEAD as of 2026-06-15. File paths are reliable; line numbers are indicative and may drift.

> **Decisions this audit assumes** (from the 2026-06-15 spec review):
> 1. **Reuse existing services, isolated per Citadel** — do not rebuild.
> 2. Replacement is the eventual goal; wrap-first behind a flag.
> 3. Beachhead = solo founder / technical operator.
> 4. Vault envelope crypto and the Mason ship **after** the core bet is validated.

---

## 0. The one-paragraph finding

The codebase already has a **`workspaceId` scoping spine** running through policy, approvals, memory, secrets, and scheduling. "Citadels" is mostly **formalizing and *enforcing* that spine**, plus adding a `chamberId` sub-scope beneath it. Roughly **70% of the machinery is Reuse/Extend**; the genuinely net-new work is the **Vault crypto** (envelope keys/rotation) and a thin **Mission wrapper** over the existing orchestration engine. Critically, there are **three live isolation leaks today** (global memory reads, broadcast approvals, plaintext secret fallback) that the Citadel boundary work must close — these are security fixes worth doing regardless of branding.

---

## 1. Verdict at a glance

| Citadel concept | Maps to (existing) | Current scope key | Verdict | Net effort |
|---|---|---|---|---|
| **Citadel** (the boundary) | `WorkspaceRecord` (+ `ChatProjectRecord`) | `workspaceId` | **Extend** | Low |
| **Charter** | — (workspace prefs / project metadata) | — | **Build-new (thin)** | Low |
| **Chamber** (sub-scope) | new sub-scope under workspace | — | **Build-new (thin)** | Med |
| **Gatehouse · Gates/Wards** | `packages/policy-engine` (`engine.ts`) | grant `scope`: global/session/workspace/agent/task | **Reuse + Extend** | Low–Med |
| **Gatehouse · Approvals** | `approval-*` services | `workspaceId` in linkage (optional) | **Extend** | Low |
| **Gatehouse · Audit** | `packages/storage/audit-log.ts` + `postgres-audit-log.ts` | append-only stream (unscoped) | **Extend** | Low |
| **Gatehouse · Secrets** | `secret-store-service.ts` | per-provider (`provider:{id}`) | **Reuse + Extend** | Low |
| **Gatehouse · Integrations** | `integrations.ts` connections | `connectionId` (no tenant) | **Extend** | Low–Med |
| **Council** (agents as identities) | `agents.ts` / `agents-route-service.ts` | none (inherits caller perms) | **Extend** | Med |
| **Missions** | `packages/orchestration` + `durable` + `tasks` | run/plan ids (no checkpoints) | **Extend + Build-new wrapper** | Med–High |
| **Archive / Memory** | `packages/memory-core` + storage | mixed: structured=workspace, `memory_items`=**global** | **Extend (+ leak fix)** | Med |
| **Watchtower** (scheduling) | `cron-job-repo.ts` + `dashboard.ts` cron | global per machine | **Reuse + Extend** | Low |
| **Vault** (envelope crypto) | — (only `crypto-equals`, OS keychain) | n/a | **Build-new (100%)** | High |
| **The Mason** (setup agent) | chat/agent infra | n/a | **Build-new** (defer) | Med |
| **Blueprint** (portable config) | `packages/skills` adjacent | n/a | **Build-new** | Med |
| **Passage** (cross-Citadel bridge) | — | n/a | **Build-new** (post-MVP) | Med |

**Reuse/Extend:** Citadel boundary, Gates/Wards, Approvals, Audit, Secrets, Integrations, Council, Watchtower, Archive. **Build-new:** Vault crypto, Mission wrapper, Charter/Chamber metadata, Mason, Blueprint, Passage.

---

## 2. The unifying move: thread the scope spine

Almost every "Extend" verdict is the same change applied in a different file:

1. Add `citadelId` (and `chamberId`) to the relevant record/request type.
2. Insert them into the existing scope hierarchy / filter at **one choke-point**.
3. Stop falling back to global/unscoped reads unless explicitly allowed.

The choke-points, by subsystem:

| Subsystem | Single choke-point to scope | File (approx) |
|---|---|---|
| Policy/Gates | `buildScopeCandidates()` | `packages/policy-engine/src/engine.ts:~1618` |
| Approvals | `listApprovals()` + `resolveChatToolApproval()` | `apps/gateway/src/services/approval-lifecycle-service.ts:~180,~794` |
| Audit | `AuditLog.append()` base record | `packages/storage/src/audit-log.ts:~30` |
| Memory | `collectMemoryItemSources()` | `apps/gateway/src/services/memory-context-service.ts:~482` |
| Secrets | account-key format | `apps/gateway/src/services/secret-store-service.ts:~272` |
| Scheduling | `CronJobRepository.list()` | `packages/storage/src/cron-job-repo.ts:~113` |
| Agent tool check | `ToolPolicyActorContext` resolution | `apps/gateway/src/services/chat-agent-orchestrator.ts` |

This is why Phase 1 is a **scoping layer, not six new packages**: `citadel-core` mostly owns the Citadel/Chamber identity records and the helper that resolves `citadelId`/`chamberId` from request context and feeds the choke-points above.

---

## 3. Subsystem detail

### 3.1 Citadel boundary → `Workspace` (+ `Project`) — **Extend**

- **Today:** `WorkspaceRecord` (`packages/contracts/src/workspaces.ts`) has a stable `workspaceId`, `slug`, `workspacePrefs`, lifecycle status, and **already partitions chats** (`list(view, limit, workspaceId)`). It even scopes guidance docs as `"global" | "workspace"`. `ChatProjectRecord` (`chat-project-service.ts`) is thinner — `projectId`, optional `workspaceId`, `workspacePath`, color/name.
- **Decision needed — is a Citadel a Workspace or a Project?** The evidence favors **Citadel ≈ Workspace (extended)**: the workspace is already the top-level partition the rest of the system keys off. `Project` is too thin to be the security boundary, but is a natural fit for a **Mission grouping** or a Chamber-ish sub-unit under a Citadel.
  - *Recommendation:* `Citadel = Workspace + Charter`. Add `chamberId` as a new sub-scope. Fold `Project` into "a way to group Missions/work inside a Citadel" later; don't promote it to the boundary.
- **Scoping change:** add `purpose/charter`, `kind`, `defaultChamberId`, `vaultRef` to the workspace (or a `citadel_meta` row keyed by `workspaceId`). No new top-level partition is invented — you're naming and enriching the one that exists.
- **Landmine:** the optional-ness of `workspaceId` in several places (it's `workspaceId?`) is exactly what lets data leak across boundaries (see §4). Citadel work should make the scope **required and enforced**, not best-effort.

### 3.2 Gatehouse · Gates & Wards → `policy-engine` — **Reuse + Extend**

- **Today:** the engine produces `allow / deny / require_approval` with `riskLevel`, `reasonCodes`, and a real **grant model** (`ToolGrantRecord`: tool pattern, decision, scope, scopeRef, TTL/one-time/persistent, constraints like allowedHosts/allowedPaths/maxWritesPerHour, revocation). Grants are evaluated per-scope in priority order **task > agent > session > workspace > global** via `buildScopeCandidates()`.
- **This is the Citadel "Gate" and "Ward" model, already built.** A Citadel Gate ≈ a `ToolGrantRecord`; a Ward ≈ a grant/deny rule.
- **Scoping change:** add `"citadel"` and `"chamber"` to `ToolGrantScope`; add `citadelId?`/`chamberId?` to `ToolAccessEvaluateRequest`; insert them into `buildScopeCandidates()` above `global`. Isolation is then automatic — a request without `citadelId` can't match a citadel-scoped grant.
- **Partial Build-new — Ward effects:** the engine emits only allow/deny/require_approval. The spec's `require_dry_run` exists conceptually (there are dry-run approval paths), but **`redact` and `route_local` are new decision outputs** that need logic in the policy-resolver / tool-executor layer.
- **Landmines:** sandbox write/read roots, network allowlist, and Firecrawl endpoint are **process-wide config**, not per-Citadel; and the **global-scope fallback is always included** — Citadels should *not* silently inherit global grants. Parameterize these per-Citadel or the boundary is porous.

### 3.3 Gatehouse · Approvals → `approval-*` services — **Extend (non-breaking)**

- **Today:** clean lifecycle (`pending → approved/rejected/edited`), rich records (kind, riskLevel, payload/preview, expiry, cost, rollback note), and linkage that **already carries `workspaceId`** alongside session/turn/task/run/connector ids.
- **Scoping change:** add `citadelId` to `ApprovalLinkage` (peer of `workspaceId`), filter `listApprovals()` by it, and validate it in `resolveChatToolApproval()` before resolving.
- **🔴 Live leak (fix during Citadel work):** `listApprovals()` returns **all** pending approvals with only a status filter — any operator can currently see/resolve approvals across all workspaces. The citadelId filter closes this.

### 3.4 Gatehouse · Audit → `storage/audit-log` — **Extend (non-breaking)**

- **Today:** durable append-only audit (JSONL + Postgres `audit_events`), streams for tool_invocations/policy_blocks/approvals/hooks, **secret-sanitized on write**, auto-attributed (actor/correlation/trace/origin).
- **Scoping change:** add optional `citadelId` to the base record in `AuditLog.append()`; add a `(stream, citadelId, timestamp)` index; inject at call sites from approval linkage / request context.
- **Gap vs. spec:** the spec asks for **tamper-evident** audit (hash chain / Merkle). Today it's append-only but **not cryptographically tamper-evident**. That's a small Build-new add-on if/when the security claim needs it — not required for MVP.

### 3.5 Gatehouse · Secrets → `secret-store-service` — **Reuse + Extend**

- **Today:** OS keychain (Windows PasswordVault / macOS security / Linux secret-tool), account key `provider:{providerId}`, **server-side only — never exposed to the model/agent** (matches spec Rule on capability wrappers). Retrieved at call time in `llm-service` / `integration-action-service`.
- **Scoping change:** account key → `citadel:{citadelId}:provider:{providerId}`; add `citadelId?` to set/get/delete.
- **🔴 Landmine:** there is a **plaintext `.env` fallback** (`provider-secret-persistence.ts`) when the keychain is unavailable. For a product whose pitch is "protected," this fallback needs to be explicit, opt-in, and clearly surfaced — not silent.

### 3.6 Gatehouse · Integrations → `integrations.ts` — **Extend**

- **Today:** `IntegrationConnection` (connectionId, catalogId, kind, config, pluginId, status). Capabilities are declared at the **catalog** level, not per-connection — a connection can't be scoped *narrower* than its catalog.
- **Scoping change:** add `citadelId` to the connection + create input, and a per-connection `grants: { capabilityId, scopes[] }[]` so a Gate can grant, e.g., GitHub *read+draft only*. Filter `listConnections()` by citadelId; check requested capability against granted scopes at invoke time.
- **Wedge note:** for the founder/operator beachhead the first connections to wire are **GitHub (issues/PR read+draft), Stripe (read), Google Calendar (read)** — all Tier-1 read-only, which keeps the first Gates low-risk.

### 3.7 Council → `agents` — **Extend**

- **Today:** `AgentProfileRecord` has a static `defaultTools[]` but **no per-agent grants** — an agent runs with the **caller's** `ToolPolicyActorContext`. This directly violates spec **Rule 6 (agents are identities, not extensions of humans)**.
- **Scoping change:** add `citadelId`, `grantedCapabilities[]` (+ expiry), and an optional `permissionProfileId` to the agent; add an `agent_capability_grants` table keyed by `(agentId, citadelId)`; in the tool check, resolve **agent grants ∩ Citadel policy ∩ operator perms** instead of just operator perms.
- **Landmine:** the per-turn tool-policy cache key must include `agentId`/grant version once agents have their own grants.

### 3.8 Missions → `orchestration` + `durable` + `tasks` — **Extend + Build-new wrapper**

- **Today:** `OrchestrationPlan`/`OrchestrationRun` give waves/phases, status (queued/running/paused/failed/completed), cost/iteration/runtime caps, and durable runs with retry/lease/recovery. `TaskActivityRecord` gives an append-only event log. The Assembly service is a rich multi-round consensus engine. **Missing:** run-level checkpoints, structured steps, evidence, and artifact linking; and the spec's 10-state machine.
- **Scoping change:** add `citadelId` to `OrchestrationRun` (and the durable workflow payload, so recovery keeps scope). **Build a thin `Mission` record** that wraps a run and adds `state` (the 10 states), `steps[]`, `checkpoints[]`, `artifacts[]`, `evidence[]` — keyed by `(citadelId, missionId)`.
- This is the one place real net-new modeling is justified — but it *wraps*, not replaces, the durable engine you already have.

### 3.9 Archive / Memory → `memory-core` + storage — **Extend (+ the critical leak fix)**

- **Today (split):** *structured* entity memory **requires `workspaceId`** (good), but the **`memory_items` maintenance store has no workspace column** and `listActiveMemoryItems()` returns **all** items across all workspaces. Retrieval funnels through a **single choke-point**, `collectMemoryItemSources()`. Embeddings are ad-hoc in a `metadata_json` field — **there is no separate vector DB**, which makes per-Chamber scoping (and later encryption) far more tractable.
- **Scoping change:** add `workspace_id` (+ `chamber`) column + index to `memory_items`; thread `workspaceId`/`chamberId` through `collectMemoryItemSources()` and `listActiveMemoryItems()`. Ranking/composition stages are scope-agnostic and need no change (filtering happens upstream).
- **🔴 Live leak (highest priority):** unscoped global memory reads are the clearest cross-boundary leak in the codebase and the §27.3 "agent cannot access ungranted Chamber" security test maps directly onto fixing it.

### 3.10 Watchtower → `cron-job-repo` + dashboard cron — **Reuse + Extend**

- **Today:** `CronJobRecord` already persists scheduled actions (task / improvement / curator / backup / memory_flush / cost_report / update_review / watchdog / no_agent) with cron schedules, enable flags, next-run, last-run output. Triggerable via routes + CLI.
- **Scoping change:** add `citadelId` column + filter `list()`; the automation **risk modes** (Observe/Draft/Stage/Execute-with-approval/Autopilot) layer on top via the policy engine — mostly reuse.

### 3.11 Vault crypto → **Build-new (100%)**

- **Today:** only `crypto-equals` (constant-time compare), `session-key` (SHA-256 hashing), and OS-keychain delegation. **Zero** envelope encryption, key hierarchy, key grants, or rotation.
- **Scope:** this is the entire spec §13 (User root → KEK → Citadel → Chamber → object keys, rotation, re-wrapping, key grants). It is the single largest net-new subsystem and the only one with no existing foundation.
- **Recommendation (unchanged):** **defer.** MVP ships "encrypted at rest, one Citadel key, OS keychain." Build the envelope hierarchy after the core bet is validated. Don't let it block Phase 1.

---

## 4. Isolation leaks that exist *today* (fix as part of the boundary work)

These are real and independent of branding — closing them is the security substance behind "Citadel as a boundary":

1. **Global memory reads** — `listActiveMemoryItems()` ignores workspace; agents can retrieve any workspace's memory. *(§3.9)*
2. **Broadcast approvals** — `listApprovals()` returns all pending approvals to any operator. *(§3.3)*
3. **Plaintext secret fallback** — `.env` fallback when keychain is unavailable, silent. *(§3.5)*
4. **Agents inherit caller permissions** — no per-agent grant ceiling (violates Rule 6). *(§3.7)*
5. **Always-on global grant fallback** — citadel-scoped requests still match global grants. *(§3.2)*

The §27.3 security tests in the spec are, in effect, the regression suite for these five fixes.

---

## 5. What Phase 1 actually is

Not "build `citadel-core`, `citadel-blueprints`, `citadel-security`, `citadel-templates`, `citadel-runtime`, `citadel-skills`." Phase 1 is:

1. `citadel-core`: Citadel + Chamber identity records (extending Workspace), a Charter, and a `resolveCitadelScope(request)` helper.
2. Add `citadelId`/`chamberId` to the 7 choke-points in §2 and make the scope **enforced, not optional**.
3. Close the 5 leaks in §4 (this *is* the isolation work, and it's testable).
4. 1–2 templates (Company Co-Founder, Project Command) + a Charter + a "nothing connected yet" review screen.
5. Encrypted-at-rest, single key. **No** Vault hierarchy, **no** Mason, **no** Blueprint marketplace yet.

Everything else in the spec is a validation-gated phase on top of this spine.

---

## 6. Open engineering decisions (need a product call)

1. **Citadel = Workspace or Project?** Recommendation: **Workspace** (it's already the partition). Confirm so the schema work doesn't fork.
2. **Chamber = new sub-scope vs. namespace-prefix convention** on existing tables? Affects whether `chamberId` is a column or an encoding.
3. **Tamper-evident audit** — needed for MVP claim, or defer the hash-chain? Recommendation: defer; keep append-only + sanitized for now.
4. **Global-grant inheritance** — should a new Citadel inherit *any* global grants, or start fully empty? Recommendation: empty by default (least privilege).
5. **`.env` secret fallback** — keep (with loud disclosure) or disable for Citadel-scoped secrets? Recommendation: disable for anything in a sealed Chamber.
