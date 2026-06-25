# Workspace/Citadel Capability Scoping — Design

- **Date:** 2026-06-25
- **Status:** Approved (design); pending implementation plan
- **Drives:** [goatcitadel/GoatCitadel#136](https://github.com/goatcitadel/GoatCitadel/issues/136) — "Promote Citadel further"
- **Sibling spec (the other half of #136):** [`2026-06-24-unified-surface-auto-router-design.md`](./2026-06-24-unified-surface-auto-router-design.md) — the unified conversation surface + auto-router (PR #146, Phase 1A merged). That spec explicitly carved THIS work out as a separate spec (its §3 "Out of scope" and §13 "Related work").
- **Author:** design session (brainstorming)

> File/line anchors below come from a read-only exploration of the codebase and are **approximate** — verify at implementation time.

---

## 1. Problem & goal

Per #136 the product hierarchy is **Citadel → Workspace (skills, plugins, MCP servers) → Chat/Cowork/Code**. Today the three resource classes the hierarchy promises a Workspace would own are **global**, not scoped to a Workspace or Citadel:

- **Skills** — `skill_lifecycle` table (PK `skill_id`); the table tracks lifecycle/trust state only, no scoping. Skills themselves are loaded from disk by `SkillsService`. (`packages/storage/src/skill-lifecycle-repo.ts`, schema `packages/storage/src/sqlite.ts:3663-3676`, contract `packages/contracts/src/capabilities.ts:118-131`.)
- **Plugins / integrations** — `integration_connections` table (PK `connection_id`); holds credentials/config (incl. `plugin_*` columns). No scoping. (`packages/storage/src/integration-connection-repo.ts`, schema `sqlite.ts:2136-2154` + `:3259-3262`, contract `packages/contracts/src/integrations.ts:95-111`.)
- **MCP servers** — their **own** `mcp_servers` table (PK `server_id`) + `mcp_server_auth` + `mcp_tools_cache`. (Correction to the issue's framing: MCP servers are *not* rows in `integration_connections`.) No scoping. (Schema `sqlite.ts:3130-3149`.)

The contrast/pattern that already works: `workspace_hooks` is fully workspace-scoped (`workspaceId` is the first argument on every method; every query filters by it). (`packages/storage/src/workspace-hook-repo.ts`.)

**Goal:** make a Citadel **own** which skills, plugins, and MCP servers exist within it, and let each Workspace **inherit and narrow** that set; resolve the active Workspace's effective capabilities at turn time; and provide a management surface to configure both levels — **without breaking any existing single-tenant setup** (unconfigured must behave exactly as today).

### Key insight that shapes this design

This is an **availability-scoping** layer, not a data move. The global registry tables (`skill_lifecycle`, `integration_connections`, `mcp_servers`) stay the source of truth and keep holding credentials/config once. We add a thin **assignment** layer that records, per scope, which registry resources are available — so a resource can be shared across workspaces, no credentials are duplicated, and "unconfigured = everything" makes the feature non-breaking by construction. The turn already knows `citadelId` and `workspaceId` (`apps/gateway/src/services/chat-turn-prep-service.ts:237-238`), and `guidance-service.ts` already demonstrates workspace→global inheritance — so the resolution seam and the inheritance precedent both exist.

---

## 2. Decisions (locked)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Ownership model | **Citadel-owned, Workspace-inherited** | Matches #136's hierarchy and the tenancy boundary (Citadel is top-level). Three-level resolution: global → citadel → workspace. |
| D2 | Mechanism | **Assignment tables, not columns on registry tables** | A column would bind a resource to exactly one scope and duplicate credentials. Assignments allow many-to-many sharing and keep credentials single-sourced. Mirrors `citadel_agent_assignments` / `citadel_members`. |
| D3 | Table shape | **One unified `capability_scope_assignments` table** (discriminated by `scope_kind` + `resource_type`) | Resolution is the heart of the feature; one parameterized code path beats three near-identical ones. Least migration/test surface; trivially extensible. Matches the discriminator-table vocabulary already in the repo (`runtime_decision_traces.kind`, `improvement_signals.class`). |
| D4 | Workspace power | **Narrow-only** | A Workspace may only restrict its Citadel's set, never exceed it. Enforced defensively at resolution by intersecting with the citadel-effective set. To add a resource you grant it at the Citadel. |
| D5 | Backfill / empty semantics | **Unconfigured = inherit; `enabled=0` row = curated-but-off** | No assignment rows for a `(scope, type)` → inherit the parent set (citadel parent = all-global; workspace parent = citadel-effective). Rows present → allow-list of `enabled=1` refs (may be empty). This cleanly separates "unset" from "explicitly empty" with no sentinel row. Out of the box (no rows anywhere) = today's exact behavior. |
| D6 | Rollout posture | **Enforce by default + kill-switch, fail-open** | Resolution filters turns from day one. Non-breaking because unconfigured = inherit-all. Any resolver error OR `GOATCITADEL_CAPABILITY_SCOPING_DISABLED=1` → return "all" (no filtering). A bug can never hide a resource. |

---

## 3. Scope

### In scope
- One unified `capability_scope_assignments` table (SQLite migration **v132**, Postgres migration **v73**) + Postgres-parity test updates.
- A `CapabilityScopeRepository` (storage) for assignment CRUD, scoped by `(scope_kind, scope_id)`.
- Contracts: `CapabilityScopeAssignment`, the `scope_kind` / `resource_type` unions, create/update inputs, and effective-set / resolved-capability DTOs.
- A gateway `CapabilityScopeResolver` service computing the effective `{ skills, integrations, mcpServers }` for `(citadelId, workspaceId)` with the D5 algebra, fail-open + kill-switch (D6).
- Turn-time wiring at the three seams (skills surfaced to the turn; integration/connector exposure; MCP server/tool exposure).
- Gateway API: citadel-level and workspace-level capability read/write endpoints returning both grant state and resolved-effective set (with an inherited indicator).
- UI: a **Workspace capabilities** surface (the issue's "Manage Workspace" — headline) and a **Citadel capabilities** surface (the ownership level), each with Skills / Plugins / MCP panels, mirroring `LibrarySkillsSection.tsx` / `BudgetSection.tsx`.

### Out of scope (deliberately)
- The unified surface + auto-router (the sibling spec / PR #146).
- Any change to how skills are loaded from disk, how credentials are stored, or the MCP transport/auth model. We scope **availability**, not storage of the resources themselves.
- Per-workspace *separate credentials* for the same provider (that would be the rejected "true ownership" / column model). A resource is shared; scoping only governs visibility.
- Reworking the existing `citadel_integration_grants` table (provider/capability/mode authorization). Its relationship to this layer is an explicit open item (§11), to be resolved in planning — default assumption is they remain orthogonal.
- Role/permission gating of *who* may edit assignments beyond the app's existing auth (assignments inherit current API auth).

### Non-breaking guarantee
With zero assignment rows (the state of every existing install immediately after migration), every scope inherits all-global at both levels, so resolution returns "all" for every type and turns behave exactly as today. The kill-switch (`GOATCITADEL_CAPABILITY_SCOPING_DISABLED=1`) is an additional global escape hatch.

---

## 4. Architecture overview

```
                          registry (global, unchanged, single source of credentials/config)
                          skill_lifecycle | integration_connections | mcp_servers
                                                  │  (all-global pool)
                                                  ▼
  capability_scope_assignments ──► CapabilityScopeResolver(citadelId, workspaceId)
   (scope_kind, scope_id,                │   citadelEffective = citadel rows ? allowList : all-global
    resource_type, resource_ref,         │   workspaceEffective = (ws rows ? allowList : citadelEffective)
    enabled)                             │                         ∩ citadelEffective        (D4, D5)
                                         │   fail-open + kill-switch                          (D6)
                                         ▼
   chat-turn-prep-service.ts ── applies effective sets at three seams:
     (citadelId/workspaceId         (a) skills surfaced to the turn
      already resolved :237-238)     (b) integration/connector tool exposure
                                     (c) MCP server / cached-tool exposure
                                         │
                                         ▼  [existing downstream machinery unchanged]

  mc-next ──► GET/PUT  /api/v1/citadels/:id/capabilities      (ownership level)
          ──► GET/PATCH /api/v1/workspaces/:id/capabilities    (narrowing level)
                 returns { assignments, effective[], inherited }
```

A thin new service + one table; downstream turn machinery (orchestration router, tool policy, MCP invocation) is untouched beyond receiving a possibly-smaller input set.

---

## 5. Data model & persistence

### 5.1 `capability_scope_assignments` (new table)

```
capability_scope_assignments (
  assignment_id   TEXT PRIMARY KEY,         -- "csa_<uuid-slice>"
  scope_kind      TEXT NOT NULL,            -- 'citadel' | 'workspace'
  scope_id        TEXT NOT NULL,            -- citadelId or workspaceId
  resource_type   TEXT NOT NULL,            -- 'skill' | 'integration' | 'mcp_server'
  resource_ref    TEXT NOT NULL,            -- skillId | connectionId | serverId (polymorphic; no cross-table FK)
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)
```

- **Unique:** `UNIQUE(scope_kind, scope_id, resource_type, resource_ref)` — one row per resource per scope.
- **Index:** `idx_capability_scope_assignments_lookup ON (scope_kind, scope_id, resource_type, enabled)` — the resolver's hot path.
- **PK strategy:** surrogate `assignment_id` (matches `citadel_agent_assignments`, `citadel_members`).
- **No FK** to registry tables (`resource_ref` is polymorphic; the resolver intersects with the live registry anyway, which naturally drops dangling refs).
- SQLite migration **v132** (`SCHEMA_MIGRATIONS` entry `{ version: 132, name: "capability_scope_assignments", up }` in `sqlite.ts`); Postgres migration **v73** (`POSTGRES_MIGRATIONS` entry in `postgres/migrations.ts`). Parity asserted in `postgres-runtime-schema.test.ts`; versioning asserted in `sqlite-migration-versioning.test.ts`.

### 5.2 `CapabilityScopeRepository` (new — `packages/storage/src/capability-scope-repo.ts`)

Methods (all scope-keyed, mirroring `workspace-hook-repo.ts`):
- `list(scopeKind, scopeId, resourceType?): CapabilityScopeAssignment[]`
- `listForResolution(scopeKind, scopeId): CapabilityScopeAssignment[]` (all types for one scope, one query)
- `get(assignmentId): CapabilityScopeAssignment` / `find(...)`
- `upsert(input): CapabilityScopeAssignment` (by the unique key; sets `enabled`)
- `setEnabled(scopeKind, scopeId, resourceType, resourceRef, enabled): CapabilityScopeAssignment`
- `replaceSet(scopeKind, scopeId, resourceType, refs[]): void` (transactional bulk set used by the "curate" UI action)
- `delete(assignmentId): boolean` and `clear(scopeKind, scopeId, resourceType): number` (deleting all rows for a `(scope,type)` reverts that scope/type to **inherit**, per D5)

### 5.3 Contracts (new — `packages/contracts/src/capability-scope.ts`)

```ts
type CapabilityScopeKind = "citadel" | "workspace";
type CapabilityResourceType = "skill" | "integration" | "mcp_server";

interface CapabilityScopeAssignment {
  assignmentId: string;
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  resourceRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Per-type resolved view returned to the resolver/UI.
interface ResolvedCapabilitySet {
  resourceType: CapabilityResourceType;
  mode: "inherit" | "curated";   // whether rows exist at this scope for this type
  effectiveRefs: string[];        // the resulting allowed set (after intersection)
  // for UI: the parent set + per-ref {enabled, inherited} can be derived from registry + assignments
}
```

---

## 6. Resolution algebra (the core)

Per `(scope, resourceType)`:
- `rows = assignments(scope, resourceType)`
- `rows.length === 0` → **INHERIT** the parent set
- else → allow-list = `{ row.resourceRef : row.enabled === 1 }` (may be empty)

Composition for a turn with `(citadelId, workspaceId)`, per resource type:
```
allGlobal          = live registry ids for the type
citadelEffective   = citadelHasRows ? citadelAllowList            : allGlobal
workspaceEffective = (workspaceHasRows ? workspaceAllowList
                                       : citadelEffective)
                     ∩ citadelEffective            // D4: workspace can never exceed citadel
```
Then intersect each `*Effective` set with `allGlobal` so a deleted/renamed registry resource (a dangling `resource_ref`) is dropped silently.

`CapabilityScopeResolver.resolve(citadelId, workspaceId)` returns `{ skills, integrations, mcpServers }`, each either the sentinel `ALL` (no filtering) or an explicit `Set<string>`. `ALL` is returned for a type when **both** scopes inherit (so callers can skip filtering entirely — important for perf and for the non-breaking guarantee).

**Fail-open (D6):** the resolver wraps resolution in try/catch; on any error, or when `GOATCITADEL_CAPABILITY_SCOPING_DISABLED=1`, it returns `ALL` for all three types and logs once. Resolution **never** blocks or narrows a turn due to a fault.

---

## 7. Turn-time wiring

`citadelId` + `workspaceId` are already resolved at `chat-turn-prep-service.ts:237-238`. We call the resolver once during turn prep and apply the effective sets at the three points where capabilities enter the turn:

- **(a) Skills** — filter the skill set surfaced to the turn (the list assembled via `SkillsService` / capability-system) to `effective.skills` (skip if `ALL`).
- **(b) Integrations / connectors** — the connector registry is built from `integrationConnections.list(...)` (e.g. `gateway-route-composition-integrations.ts:225`). Filter connection-derived tools/connectors to `effective.integrations` before they enter the turn's catalog (skip if `ALL`).
- **(c) MCP servers** — restrict the MCP servers (and their cached tools) exposed/invocable for the turn to `effective.mcpServers` (skip if `ALL`).

**Invariant:** downstream consumers (orchestration router, tool-policy evaluation, MCP invocation coordinator) are unchanged; they simply receive an already-scoped input set. Tool-policy access control remains as-is and runs after this availability filter (defense in depth).

Exact seam functions/signatures (whether to filter the catalog builder vs. thread the set through) are an implementation-plan detail; the plan will pick the narrowest seam that covers all three without reshaping downstream interfaces.

---

## 8. API (gateway)

Two parallel resources, both returning grant state **and** the resolved view:

- `GET /api/v1/citadels/:citadelId/capabilities?type=skill|integration|mcp_server`
  → `{ resourceType, mode, items: [{ ref, label, enabled, available }], effectiveRefs }`
  (`available` = present in the global registry; `enabled` = this citadel's grant.)
- `PUT /api/v1/citadels/:citadelId/capabilities` → body `{ resourceType, refs: string[] }` performs `replaceSet` (curate); a companion `PATCH` toggles a single ref; `DELETE ...?type=` clears (revert to inherit).
- `GET /api/v1/workspaces/:workspaceId/capabilities?type=...`
  → same shape, but `items` is drawn from the **citadel-effective** set (not all-global), each with `{ enabled, inherited }`.
- `PATCH /api/v1/workspaces/:workspaceId/capabilities` → workspace narrowing (`replaceSet` / single toggle / clear).

Handlers resolve `citadelId` for a workspace via `workspaces.find(workspaceId).citadelId ?? DEFAULT_CITADEL_ID` (same as turn prep). Validation: reject unknown `resource_type`/`scope_kind`; refs not in the registry are accepted but reported `available:false` (so the UI can show stale grants) — they're harmless because resolution intersects with the live registry.

---

## 9. UI (mission-control-next)

Two surfaces, both mirroring `LibrarySkillsSection.tsx` (list + toggle) and `BudgetSection.tsx` (fetch/edit/save) and built from `native-routes/primitives` (`NativeCard`, `NativeSelectableList`, `NativeTable`, `NativeButton`). Data via `mission-control-shared` `request()` + new client fns; types from `@goatcitadel/contracts`.

- **Workspace capabilities** (headline; reuses the already-defined `settings/workspaces` section in `route-model.ts`). Three panels — **Skills / Plugins / MCP** — listing the **citadel-effective** resources for the active workspace, each with an enable/disable toggle that writes workspace narrowing. Each panel shows whether the workspace is `inherit` (all citadel resources, nothing curated) or `curated`, with a "Reset to inherited" action (clear).
- **Citadel capabilities** (ownership level). Same three panels over the **global** registry, writing citadel grants; same inherit/curated affordance.

Both surfaces read the active `citadelId`/`workspaceId` from the existing topbar selectors (`MissionControlNextApp.tsx:814-843`). The workspace surface links to the citadel surface for "a resource you want isn't listed → grant it at the Citadel" (reinforces D4).

---

## 10. Error handling, edge cases & testing

### Edge cases
| Case | Behavior |
|------|----------|
| No rows anywhere (fresh install) | Inherit-all at both levels → resolver returns `ALL` → zero filtering (today's behavior). |
| Citadel curated, workspace unconfigured | Workspace inherits citadel-effective. |
| Workspace curated to empty (`enabled=0` all) | Workspace sees no resources of that type (explicit empty, distinct from inherit). |
| Workspace grants a ref the citadel lacks | Dropped by the `∩ citadelEffective` intersect (D4). API may store it but it never resolves. |
| Dangling `resource_ref` (resource deleted) | Dropped by intersect with live registry; UI shows `available:false`. |
| Resolver throws / kill-switch set | Fail-open: `ALL` for all types; logged once. |
| Switching active workspace in UI | Re-fetch; effective set recomputed for the new `(citadel, workspace)`. |

### Testing strategy
- **Storage unit:** repo CRUD scoped by `(scope_kind, scope_id)`; `replaceSet`/`clear` transactions; unique-key upsert.
- **Migration:** `sqlite-migration-versioning.test.ts` (v132 registered, table+index+unique present); `postgres-runtime-schema.test.ts` (v73 parity, unique index preserved).
- **Resolver unit (table-driven, the priority):** inherit vs allow-list vs explicit-empty; citadel-only curation; workspace narrowing; `workspace ⊄ citadel` intersect; dangling-ref drop; `ALL` short-circuit when both inherit; fail-open on thrown error; kill-switch env.
- **Integration (gateway):** unconfigured turn = all capabilities (non-breaking); citadel+workspace curated turn = filtered skills/integrations/MCP at the three seams; API round-trips (grant → resolve → effective).
- **UI:** panels render inherit vs curated; toggle writes + re-resolves; workspace panel sourced from citadel-effective; "reset to inherited" clears.
- Follow existing TDD conventions and per-package setup (gateway vitest, storage tests). `git commit --no-verify` (husky cannot spawn here).

---

## 11. Open questions / risks

- **`citadel_integration_grants` relationship (must resolve in planning).** That table already gates integrations per citadel via provider/account/capability/mode authorization (`sqlite.ts:1214-1226`, routes `GET/POST/DELETE /api/v1/citadels/:id/integrations`). Decide one of: (a) keep orthogonal — grants authorize *provider capabilities/mode*, our layer scopes *which connections are available* (default assumption); or (b) have the integration resolver also consult grants so the two can't disagree. Verify its real usage before finalizing the integration seam (§7b).
- **Narrowest turn-time seam.** Confirm whether to filter the catalog/connector builders directly or thread effective sets through; pick the option that touches the fewest downstream interfaces. (§7)
- **Skill identity mapping.** Confirm the `resource_ref` for skills is the same `skillId` the turn-time skill list is keyed by (vs. a slug/name), so the filter matches. (§7a)
- **Postgres schema derivation.** The Postgres runtime schema is partly auto-derived from the SQLite blueprint (`createSqliteSchemaBlueprint` → `buildPostgresRuntimeSchemaSql`). Verify whether adding the SQLite table auto-propagates to Postgres (making the explicit v73 migration belt-and-suspenders, or risking a double-create) vs. being required; ensure no conflict and that `postgres-runtime-schema.test.ts` passes either way.
- **Effective-set caching.** Resolution runs once per turn; if profiling shows cost, memoize per `(citadelId, workspaceId)` with invalidation on assignment writes. Not in v1 unless measured.

---

## 12. Phasing / build order

- **Phase 1 — storage + contracts:** contracts (`capability-scope.ts`), table + SQLite v132 + Postgres v73 migrations, `CapabilityScopeRepository`, migration/parity tests, repo unit tests. Inert (nothing reads it yet).
- **Phase 2 — resolver + turn-time enforcement:** `CapabilityScopeResolver` (algebra, `ALL` short-circuit, fail-open, kill-switch) + wiring at the three seams; resolver unit tests + gateway integration tests. Ships the enforcing-by-default behavior (non-breaking via inherit-all).
- **Phase 3 — gateway API:** citadel + workspace capability endpoints + client contracts + handler tests.
- **Phase 4 — UI:** Workspace capabilities surface (headline) + Citadel capabilities surface + component tests.

Each phase is its own verified commit(s) on `worktree-workspace-capability-scoping` (off `main` `230a222e4`), per-package green before moving on.

---

## 13. Related work

- **#136** — parent ("Promote Citadel further"); this is the data-model + UI half.
- **Sibling spec** — `2026-06-24-unified-surface-auto-router-design.md` (unified surface + auto-router, PR #146): only *reads* workspace capabilities as a routing signal; this spec makes them real. The two are independent and compose cleanly (the router can later treat the workspace's effective capability set as a stronger routing signal).
