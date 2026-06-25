# Workspace/Citadel Capability Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Citadel own which skills, plugins, and MCP servers exist within it, let each Workspace inherit and narrow that set, resolve the active workspace's effective capabilities at turn time, and ship a management surface — without breaking any existing single-tenant setup.

**Architecture:** One unified `capability_scope_assignments` table (discriminated by `scope_kind` ∈ {citadel,workspace} and `resource_type` ∈ {skill,integration,mcp_server}). A `CapabilityScopeResolver` composes global → citadel → workspace with the rule "no rows = inherit parent; rows present = allow-list of enabled refs", returning `"ALL"` when both scopes inherit (so unconfigured = today's behavior). Enforcement is asymmetric: MCP = deny-at-invocation, skills = capability-catalog filter, integrations = curation/visibility only. Enforce-by-default, fail-open, with a `GOATCITADEL_CAPABILITY_SCOPING_DISABLED` kill-switch.

**Tech Stack:** TypeScript monorepo (pnpm). `@goatcitadel/contracts` (types), `@goatcitadel/storage` (SQLite via better-sqlite3 + Postgres; **tests use `node:test` via tsx**), `@goatcitadel/gateway` (Fastify; vitest), `@goatcitadel/mission-control-shared` (API client; vitest), `@goatcitadel/mission-control-next` (React UI; vitest).

**Spec:** `docs/superpowers/specs/2026-06-25-workspace-citadel-capability-scoping-design.md`

**Branch/worktree:** already on `worktree-workspace-capability-scoping` (off `main` `230a222e4`) at `F:/code/personal-ai/.claude/worktrees/workspace-capability-scoping`; `pnpm install` already done. Use `git commit --no-verify` (husky cannot spawn here). All `pnpm --filter` commands run from the worktree root.

**Key file:line anchors (verified against `main`):**
- Repo template: `packages/storage/src/workspace-hook-repo.ts`; storage registration `packages/storage/src/index.ts` (import ~83, property ~204, instantiate ~319); SQLite migrations tail `packages/storage/src/sqlite.ts` (last entry v131 ends ~1533, array closes `];` ~1534); Postgres migrations tail `packages/storage/src/postgres/migrations.ts` (last entry v72 closes `];` ~2169).
- Resolver consumers: MCP `apps/gateway/src/services/gateway-service.ts` (`invokeMcpTool` ~7760, `enrichMcpInvokePolicyContext` ~7764, `listMcpServers` ~7723, `DEFAULT_WORKSPACE_ID` ~690, `skillsService` ~794/990, `integrationConnections.list` available via `this.storage.integrationConnections`).
- Skills surfacing: `apps/gateway/src/services/capability-system-service.ts` (`listSkills` ~209, `buildInspectableCatalog`), `CapabilityCatalogEntry.skillId` `packages/contracts/src/capabilities.ts:64`.
- API template: `apps/gateway/src/routes/citadels.ts` (integration-grant routes ~609-653), `apps/gateway/src/services/gateway-route-services.ts` (interface ~191, citadels ~199/342, workspaces ~258/401), route register `apps/gateway/src/app.ts` (~336), error helper `apps/gateway/src/routes/_error-handler.ts` (`sendRouteError`), access `withRouteAccess(fastify,"operator")`.
- UI: `apps/mission-control-next/src/features/native-routes/settings/sections/BudgetSection.tsx`, `.../library/LibrarySkillsSection.tsx`, section switch `.../native-routes/SettingsNativePage.tsx` (~370), props `SettingsShared.tsx` (~46-59), `route-model.ts` (`SettingsSection` ~34-50, `RAIL_ITEMS.settings` ~478-591, `RAIL_GROUPS` ~608-618), client `packages/mission-control-shared/src/api/` (`request()` in `client-core.ts`, barrel `client.ts`).

---

## Phase 1 — Contracts + Storage

### Task 1: Contracts — capability-scope types

**Files:**
- Create: `packages/contracts/src/capability-scope.ts`
- Modify: `packages/contracts/src/index.ts` (add export near other `export * from` lines, e.g. after line 4)

- [ ] **Step 1: Write the contract module**

`packages/contracts/src/capability-scope.ts`:
```ts
export const CAPABILITY_SCOPE_KINDS = ["citadel", "workspace"] as const;
export type CapabilityScopeKind = (typeof CAPABILITY_SCOPE_KINDS)[number];

export const CAPABILITY_RESOURCE_TYPES = ["skill", "integration", "mcp_server"] as const;
export type CapabilityResourceType = (typeof CAPABILITY_RESOURCE_TYPES)[number];

export interface CapabilityScopeAssignment {
  assignmentId: string;
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  resourceRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** "inherit" = no rows for this (scope,type) → inherits the parent set.
 *  "curated" = rows exist → only enabled refs are available (may be empty). */
export type CapabilityScopeMode = "inherit" | "curated";

export interface CapabilityScopeItem {
  resourceRef: string;
  label: string;
  /** Whether this ref is in the scope's effective set. */
  enabled: boolean;
  /** Whether this ref currently exists in the parent-effective / registry set. */
  available: boolean;
  /** True when the scope has no explicit row for this type (value inherited from parent). */
  inherited: boolean;
}

export interface CapabilityScopeView {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  mode: CapabilityScopeMode;
  items: CapabilityScopeItem[];
  effectiveRefs: string[];
}

/** PATCH body: replace the scope's curated set for one resource type. */
export interface CapabilityScopeUpdateInput {
  resourceType: CapabilityResourceType;
  /** Full candidate set with per-ref enabled flags. Empty array = curate-to-empty. */
  assignments: Array<{ resourceRef: string; enabled: boolean }>;
}

export function isCapabilityScopeKind(value: unknown): value is CapabilityScopeKind {
  return typeof value === "string" && (CAPABILITY_SCOPE_KINDS as readonly string[]).includes(value);
}

export function isCapabilityResourceType(value: unknown): value is CapabilityResourceType {
  return typeof value === "string" && (CAPABILITY_RESOURCE_TYPES as readonly string[]).includes(value);
}
```

- [ ] **Step 2: Export from the barrel**

In `packages/contracts/src/index.ts`, add (alphabetical-ish, near the other capability export at line 4):
```ts
export * from "./capability-scope.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @goatcitadel/contracts typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/capability-scope.ts packages/contracts/src/index.ts
git commit --no-verify -m "feat(contracts): capability-scope assignment + view types"
```

---

### Task 2: SQLite migration v132 (create table)

**Files:**
- Modify: `packages/storage/src/sqlite.ts` (append to `SCHEMA_MIGRATIONS` before the closing `];` at ~line 1534)
- Test: `packages/storage/src/sqlite-migration-versioning.test.ts` (add assertions)

- [ ] **Step 1: Write the failing test** — add inside `packages/storage/src/sqlite-migration-versioning.test.ts` (it uses `node:test`; mirror existing structure):
```ts
it("creates the capability_scope_assignments table with unique + lookup indexes", () => {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-capscope-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('capability_scope_assignments') ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.deepEqual(names, [
    "assignment_id",
    "created_at",
    "enabled",
    "resource_ref",
    "resource_type",
    "scope_id",
    "scope_kind",
    "updated_at",
  ]);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='capability_scope_assignments'")
    .all() as Array<{ name: string }>;
  const idxNames = indexes.map((i) => i.name);
  assert.ok(idxNames.includes("idx_capability_scope_assignments_unique"));
  assert.ok(idxNames.includes("idx_capability_scope_assignments_lookup"));
  db.close();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/sqlite-migration-versioning.test.ts`
Expected: FAIL (table `capability_scope_assignments` does not exist → empty column list).

- [ ] **Step 3: Add the migration** — in `packages/storage/src/sqlite.ts`, append this entry to `SCHEMA_MIGRATIONS` immediately before the closing `];`:
```ts
  {
    version: 132,
    name: "capability_scope_assignments",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS capability_scope_assignments (
          assignment_id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_ref TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_scope_assignments_unique
          ON capability_scope_assignments(scope_kind, scope_id, resource_type, resource_ref);

        CREATE INDEX IF NOT EXISTS idx_capability_scope_assignments_lookup
          ON capability_scope_assignments(scope_kind, scope_id, resource_type, enabled);
      `);
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/sqlite-migration-versioning.test.ts`
Expected: PASS, including the existing `"records applied migration versions"` test (it asserts last version === count; the new entry keeps versions contiguous at 132).

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/sqlite.ts packages/storage/src/sqlite-migration-versioning.test.ts
git commit --no-verify -m "feat(storage): add capability_scope_assignments table (sqlite v132)"
```

---

### Task 3: Postgres migration v73 + parity assertion

**Files:**
- Modify: `packages/storage/src/postgres/migrations.ts` (append to `POSTGRES_MIGRATIONS` before closing `];` ~line 2169)
- Test: `packages/storage/src/postgres-runtime-schema.test.ts` (add assertion)

- [ ] **Step 1: Write the failing test** — add inside `packages/storage/src/postgres-runtime-schema.test.ts` (node:test; place beside the "keeps incremental Postgres migrations aligned…" test):
```ts
it("ships a Postgres migration for capability_scope_assignments", () => {
  const migration = POSTGRES_MIGRATIONS.find((m) => m.name === "capability_scope_assignments");
  assert.ok(migration, "expected Postgres migration for capability_scope_assignments");
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS capability_scope_assignments/);
  assert.match(migration.sql, /idx_capability_scope_assignments_unique/);
  assert.match(migration.sql, /idx_capability_scope_assignments_lookup/);
});

it("auto-derives capability_scope_assignments into the runtime schema", () => {
  const sql = buildPostgresRuntimeSchemaSql();
  assert.match(sql, /capability_scope_assignments/);
});
```
(If `buildPostgresRuntimeSchemaSql` is not already imported in this test file, add it to the imports from `./postgres/runtime-schema.js`.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/postgres-runtime-schema.test.ts`
Expected: FAIL (no migration named `capability_scope_assignments`). The auto-derive assertion may already PASS (table derived from v132); the migration-find assertion fails.

- [ ] **Step 3: Add the Postgres migration** — append to `POSTGRES_MIGRATIONS` before the closing `];` (use `BIGINT` for the integer flag, matching the project's SQLite-INTEGER→PG-BIGINT convention):
```ts
  {
    version: 73,
    name: "capability_scope_assignments",
    sql: `
      CREATE TABLE IF NOT EXISTS capability_scope_assignments (
        assignment_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_scope_assignments_unique
        ON capability_scope_assignments(scope_kind, scope_id, resource_type, resource_ref);

      CREATE INDEX IF NOT EXISTS idx_capability_scope_assignments_lookup
        ON capability_scope_assignments(scope_kind, scope_id, resource_type, enabled);
    `,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/postgres-runtime-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/postgres/migrations.ts packages/storage/src/postgres-runtime-schema.test.ts
git commit --no-verify -m "feat(storage): add capability_scope_assignments Postgres migration (v73)"
```

---

### Task 4: CapabilityScopeRepository

**Files:**
- Create: `packages/storage/src/capability-scope-repo.ts`
- Test: `packages/storage/src/capability-scope-repo.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/storage/src/capability-scope-repo.test.ts`:
```ts
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CapabilityScopeRepository } from "./capability-scope-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): CapabilityScopeRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-capscope-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new CapabilityScopeRepository(createDatabase({ dbPath }));
}

describe("CapabilityScopeRepository", () => {
  it("returns an empty list for an unconfigured scope", () => {
    const repo = createRepo();
    assert.deepEqual(repo.listForScope("citadel", "personal"), []);
    assert.deepEqual(repo.list("workspace", "default", "skill"), []);
  });

  it("setEnabled upserts a single assignment scoped by the unique key", () => {
    const repo = createRepo();
    const created = repo.setEnabled("citadel", "personal", "skill", "skill-a", true);
    assert.equal(created.scopeKind, "citadel");
    assert.equal(created.resourceRef, "skill-a");
    assert.equal(created.enabled, true);

    const updated = repo.setEnabled("citadel", "personal", "skill", "skill-a", false);
    assert.equal(updated.assignmentId, created.assignmentId);
    assert.equal(updated.enabled, false);

    const rows = repo.list("citadel", "personal", "skill");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.enabled, false);
  });

  it("replaceSet replaces all rows for one (scope,type) transactionally", () => {
    const repo = createRepo();
    repo.setEnabled("workspace", "default", "skill", "old", true);
    const result = repo.replaceSet("workspace", "default", "skill", [
      { resourceRef: "a", enabled: true },
      { resourceRef: "b", enabled: false },
    ]);
    assert.equal(result.length, 2);
    const refs = repo.list("workspace", "default", "skill").map((r) => r.resourceRef).sort();
    assert.deepEqual(refs, ["a", "b"]);
  });

  it("replaceSet with an empty array yields curated-to-empty (rows present is false → inherit)", () => {
    const repo = createRepo();
    repo.setEnabled("workspace", "default", "mcp_server", "srv-1", true);
    repo.replaceSet("workspace", "default", "mcp_server", []);
    assert.deepEqual(repo.list("workspace", "default", "mcp_server"), []);
  });

  it("clear removes all rows for one (scope,type) and reports the count", () => {
    const repo = createRepo();
    repo.setEnabled("citadel", "personal", "integration", "conn-1", true);
    repo.setEnabled("citadel", "personal", "integration", "conn-2", true);
    repo.setEnabled("citadel", "personal", "skill", "skill-x", true);
    assert.equal(repo.clear("citadel", "personal", "integration"), 2);
    assert.deepEqual(repo.list("citadel", "personal", "integration"), []);
    assert.equal(repo.list("citadel", "personal", "skill").length, 1);
  });

  it("scopes rows by (scope_kind, scope_id) — no cross-scope leakage", () => {
    const repo = createRepo();
    repo.setEnabled("citadel", "personal", "skill", "shared", true);
    repo.setEnabled("workspace", "default", "skill", "shared", true);
    assert.equal(repo.list("citadel", "personal", "skill").length, 1);
    assert.equal(repo.list("workspace", "default", "skill").length, 1);
    assert.equal(repo.list("workspace", "other", "skill").length, 0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/capability-scope-repo.test.ts`
Expected: FAIL (cannot find module `./capability-scope-repo.js`).

- [ ] **Step 3: Implement the repository** — `packages/storage/src/capability-scope-repo.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  CapabilityResourceType,
  CapabilityScopeAssignment,
  CapabilityScopeKind,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";

interface CapabilityScopeRow {
  assignment_id: string;
  scope_kind: string;
  scope_id: string;
  resource_type: string;
  resource_ref: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CapabilityScopeItemInput {
  resourceRef: string;
  enabled: boolean;
}

function newAssignmentId(): string {
  return `csa_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export class CapabilityScopeRepository {
  private readonly listScopeStmt;
  private readonly listScopeTypeStmt;
  private readonly getStmt;
  private readonly findByKeyStmt;
  private readonly insertStmt;
  private readonly updateEnabledStmt;
  private readonly deleteStmt;
  private readonly deleteScopeTypeStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listScopeStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId
      ORDER BY resource_type ASC, resource_ref ASC
    `);
    this.listScopeTypeStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId AND resource_type = @resourceType
      ORDER BY resource_ref ASC
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments WHERE assignment_id = @assignmentId
    `);
    this.findByKeyStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId
        AND resource_type = @resourceType AND resource_ref = @resourceRef
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO capability_scope_assignments (
        assignment_id, scope_kind, scope_id, resource_type, resource_ref, enabled, created_at, updated_at
      ) VALUES (
        @assignmentId, @scopeKind, @scopeId, @resourceType, @resourceRef, @enabled, @createdAt, @updatedAt
      )
    `);
    this.updateEnabledStmt = db.prepare(`
      UPDATE capability_scope_assignments
      SET enabled = @enabled, updated_at = @updatedAt
      WHERE assignment_id = @assignmentId
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM capability_scope_assignments WHERE assignment_id = @assignmentId
    `);
    this.deleteScopeTypeStmt = db.prepare(`
      DELETE FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId AND resource_type = @resourceType
    `);
  }

  public listForScope(scopeKind: CapabilityScopeKind, scopeId: string): CapabilityScopeAssignment[] {
    return toRows(this.listScopeStmt.all({ scopeKind, scopeId })).map(mapRow);
  }

  public list(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): CapabilityScopeAssignment[] {
    return toRows(this.listScopeTypeStmt.all({ scopeKind, scopeId, resourceType })).map(mapRow);
  }

  public find(assignmentId: string): CapabilityScopeAssignment | undefined {
    const row = toRow(this.getStmt.get({ assignmentId }));
    return row ? mapRow(row) : undefined;
  }

  public setEnabled(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
    resourceRef: string,
    enabled: boolean,
    now = new Date().toISOString(),
  ): CapabilityScopeAssignment {
    const existing = toRow(this.findByKeyStmt.get({ scopeKind, scopeId, resourceType, resourceRef }));
    if (existing) {
      this.updateEnabledStmt.run({ assignmentId: existing.assignment_id, enabled: enabled ? 1 : 0, updatedAt: now });
      return mapRow({ ...existing, enabled: enabled ? 1 : 0, updated_at: now });
    }
    const assignmentId = newAssignmentId();
    this.insertStmt.run({
      assignmentId,
      scopeKind,
      scopeId,
      resourceType,
      resourceRef,
      enabled: enabled ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    return mapRow({
      assignment_id: assignmentId,
      scope_kind: scopeKind,
      scope_id: scopeId,
      resource_type: resourceType,
      resource_ref: resourceRef,
      enabled: enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
  }

  public replaceSet(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
    items: readonly CapabilityScopeItemInput[],
    now = new Date().toISOString(),
  ): CapabilityScopeAssignment[] {
    return this.db.transaction("immediate", () => {
      this.deleteScopeTypeStmt.run({ scopeKind, scopeId, resourceType });
      for (const item of items) {
        if (!item.resourceRef.trim()) {
          throw new ValidationError({ code: "FIELD_REQUIRED", field: "resourceRef" });
        }
        this.insertStmt.run({
          assignmentId: newAssignmentId(),
          scopeKind,
          scopeId,
          resourceType,
          resourceRef: item.resourceRef,
          enabled: item.enabled ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      return this.list(scopeKind, scopeId, resourceType);
    });
  }

  public clear(scopeKind: CapabilityScopeKind, scopeId: string, resourceType: CapabilityResourceType): number {
    return Number(this.deleteScopeTypeStmt.run({ scopeKind, scopeId, resourceType }).changes ?? 0);
  }

  public delete(assignmentId: string): boolean {
    return Number(this.deleteStmt.run({ assignmentId }).changes ?? 0) > 0;
  }
}

function mapRow(row: CapabilityScopeRow): CapabilityScopeAssignment {
  return {
    assignmentId: row.assignment_id,
    scopeKind: row.scope_kind as CapabilityScopeKind,
    scopeId: row.scope_id,
    resourceType: row.resource_type as CapabilityResourceType,
    resourceRef: row.resource_ref,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(value: unknown): CapabilityScopeRow | undefined {
  return isRow(value) ? value : undefined;
}

function toRows(value: unknown): CapabilityScopeRow[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is CapabilityScopeRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.assignment_id === "string" &&
    typeof v.scope_kind === "string" &&
    typeof v.scope_id === "string" &&
    typeof v.resource_type === "string" &&
    typeof v.resource_ref === "string" &&
    typeof v.enabled === "number" &&
    typeof v.created_at === "string" &&
    typeof v.updated_at === "string"
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/capability-scope-repo.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/capability-scope-repo.ts packages/storage/src/capability-scope-repo.test.ts
git commit --no-verify -m "feat(storage): CapabilityScopeRepository (scoped CRUD + replaceSet/clear)"
```

---

### Task 5: Register the repo on the Storage object

**Files:**
- Modify: `packages/storage/src/index.ts` (import ~83, property ~204, instantiate ~319, re-export near other `export * from "./...-repo.js"`)

- [ ] **Step 1: Add the import** (next to `import { WorkspaceHookRepository } ...`):
```ts
import { CapabilityScopeRepository } from "./capability-scope-repo.js";
```

- [ ] **Step 2: Declare the property** (next to `public readonly workspaceHooks: WorkspaceHookRepository;`):
```ts
  public readonly capabilityScope: CapabilityScopeRepository;
```

- [ ] **Step 3: Instantiate in the constructor** (next to `this.workspaceHooks = new WorkspaceHookRepository(this.db);`):
```ts
    this.capabilityScope = new CapabilityScopeRepository(this.db);
```

- [ ] **Step 4: Re-export the module** (with the other repo re-exports):
```ts
export * from "./capability-scope-repo.js";
```

- [ ] **Step 5: Typecheck + full storage test sweep**

Run: `pnpm --filter @goatcitadel/storage typecheck && pnpm --filter @goatcitadel/storage test`
Expected: PASS (typecheck clean; all storage `node:test` files green, including the new ones).

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/index.ts
git commit --no-verify -m "feat(storage): expose storage.capabilityScope"
```

---

## Phase 2 — Resolver + MCP enforcement

### Task 6: CapabilityScopeResolver (pure algebra + service)

**Files:**
- Create: `apps/gateway/src/services/capability-scope-resolver.ts`
- Test: `apps/gateway/src/services/capability-scope-resolver.test.ts`

- [ ] **Step 1: Write the failing test (table-driven)** — `apps/gateway/src/services/capability-scope-resolver.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { CapabilityScopeAssignment } from "@goatcitadel/contracts";
import {
  CapabilityScopeResolver,
  computeEffectiveSet,
  isCapabilityAllowed,
} from "./capability-scope-resolver.js";

function row(
  scopeKind: "citadel" | "workspace",
  resourceType: "skill" | "integration" | "mcp_server",
  resourceRef: string,
  enabled: boolean,
): CapabilityScopeAssignment {
  return {
    assignmentId: `id-${scopeKind}-${resourceRef}`,
    scopeKind,
    scopeId: "x",
    resourceType,
    resourceRef,
    enabled,
    createdAt: "t",
    updatedAt: "t",
  };
}

const ALL = new Set(["a", "b", "c"]);

describe("computeEffectiveSet", () => {
  it("returns ALL when both scopes inherit (non-breaking default)", () => {
    expect(computeEffectiveSet(ALL, [], [])).toBe("ALL");
  });

  it("citadel allow-list narrows; workspace inherits citadel", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "a", true)], []);
    expect(result).not.toBe("ALL");
    expect([...(result as Set<string>)].sort()).toEqual(["a"]);
  });

  it("workspace narrows within citadel (intersection)", () => {
    const result = computeEffectiveSet(
      ALL,
      [row("citadel", "skill", "a", true), row("citadel", "skill", "b", true)],
      [row("workspace", "skill", "b", true), row("workspace", "skill", "c", true)],
    );
    // c is excluded: not in citadel-effective (D4)
    expect([...(result as Set<string>)].sort()).toEqual(["b"]);
  });

  it("curated-to-empty: rows exist but all disabled → empty set", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "a", false)], []);
    expect(result).not.toBe("ALL");
    expect([...(result as Set<string>)]).toEqual([]);
  });

  it("drops dangling refs not present in the live registry", () => {
    const result = computeEffectiveSet(ALL, [row("citadel", "skill", "gone", true)], []);
    expect([...(result as Set<string>)]).toEqual([]);
  });

  it("citadel inherits, workspace curates → workspace ∩ global", () => {
    const result = computeEffectiveSet(ALL, [], [row("workspace", "skill", "a", true)]);
    expect([...(result as Set<string>)].sort()).toEqual(["a"]);
  });
});

describe("isCapabilityAllowed", () => {
  it("allows everything when ALL", () => {
    expect(isCapabilityAllowed("ALL", "anything")).toBe(true);
  });
  it("checks membership otherwise", () => {
    expect(isCapabilityAllowed(new Set(["a"]), "a")).toBe(true);
    expect(isCapabilityAllowed(new Set(["a"]), "b")).toBe(false);
  });
});

describe("CapabilityScopeResolver", () => {
  function makeResolver(rows: CapabilityScopeAssignment[], opts: { disabled?: boolean } = {}) {
    return new CapabilityScopeResolver({
      listAssignmentsForScope: (kind, id) => rows.filter((r) => r.scopeKind === kind && r.scopeId === id),
      listAllSkillIds: () => ["a", "b", "c"],
      listAllIntegrationIds: () => ["i1", "i2"],
      listAllMcpServerIds: () => ["m1", "m2"],
      isDisabled: () => Boolean(opts.disabled),
    });
  }

  it("resolves ALL for every type when unconfigured", () => {
    const r = makeResolver([]).resolve("personal", "default");
    expect(r.skills).toBe("ALL");
    expect(r.integrations).toBe("ALL");
    expect(r.mcpServers).toBe("ALL");
  });

  it("scopes mcpServers by citadel grant", () => {
    const rows: CapabilityScopeAssignment[] = [
      { assignmentId: "1", scopeKind: "citadel", scopeId: "personal", resourceType: "mcp_server", resourceRef: "m1", enabled: true, createdAt: "t", updatedAt: "t" },
    ];
    const r = makeResolver(rows).resolve("personal", "default");
    expect(r.mcpServers).not.toBe("ALL");
    expect([...(r.mcpServers as Set<string>)]).toEqual(["m1"]);
    expect(r.skills).toBe("ALL"); // other types untouched
  });

  it("fail-open: returns ALL when the kill-switch disables scoping", () => {
    const rows: CapabilityScopeAssignment[] = [
      { assignmentId: "1", scopeKind: "citadel", scopeId: "personal", resourceType: "mcp_server", resourceRef: "m1", enabled: true, createdAt: "t", updatedAt: "t" },
    ];
    const r = makeResolver(rows, { disabled: true }).resolve("personal", "default");
    expect(r.mcpServers).toBe("ALL");
  });

  it("fail-open: returns ALL when a dependency throws", () => {
    const resolver = new CapabilityScopeResolver({
      listAssignmentsForScope: () => {
        throw new Error("boom");
      },
      listAllSkillIds: () => [],
      listAllIntegrationIds: () => [],
      listAllMcpServerIds: () => [],
      isDisabled: () => false,
    });
    const r = resolver.resolve("personal", "default");
    expect(r.skills).toBe("ALL");
    expect(r.mcpServers).toBe("ALL");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-scope-resolver.test.ts`
Expected: FAIL (cannot find module `./capability-scope-resolver.js`).

- [ ] **Step 3: Implement the resolver** — `apps/gateway/src/services/capability-scope-resolver.ts`:
```ts
import type { CapabilityResourceType, CapabilityScopeAssignment, CapabilityScopeKind } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";

export const CAPABILITY_SCOPING_DISABLED_ENV = "GOATCITADEL_CAPABILITY_SCOPING_DISABLED";

/** "ALL" = no filtering (every registry resource of this type is allowed). */
export type EffectiveCapabilitySet = "ALL" | ReadonlySet<string>;

export interface ResolvedCapabilities {
  skills: EffectiveCapabilitySet;
  integrations: EffectiveCapabilitySet;
  mcpServers: EffectiveCapabilitySet;
}

export const ALL_CAPABILITIES: ResolvedCapabilities = {
  skills: "ALL",
  integrations: "ALL",
  mcpServers: "ALL",
};

/** Pure resolution algebra. Exported for table-driven tests.
 *  No rows for a scope = inherit the parent; rows present = allow-list of enabled refs.
 *  Returns "ALL" only when BOTH scopes inherit. Workspace is intersected with the
 *  citadel-effective set (a workspace can never exceed its citadel). */
export function computeEffectiveSet(
  allGlobal: ReadonlySet<string>,
  citadelRows: readonly CapabilityScopeAssignment[],
  workspaceRows: readonly CapabilityScopeAssignment[],
): EffectiveCapabilitySet {
  const citadelInherits = citadelRows.length === 0;
  const workspaceInherits = workspaceRows.length === 0;
  if (citadelInherits && workspaceInherits) {
    return "ALL";
  }
  const citadelEffective = citadelInherits
    ? new Set(allGlobal)
    : new Set(
        citadelRows
          .filter((r) => r.enabled)
          .map((r) => r.resourceRef)
          .filter((ref) => allGlobal.has(ref)),
      );
  const workspaceResolved = workspaceInherits
    ? citadelEffective
    : new Set(workspaceRows.filter((r) => r.enabled).map((r) => r.resourceRef));
  const result = new Set<string>();
  for (const ref of workspaceResolved) {
    if (citadelEffective.has(ref)) {
      result.add(ref);
    }
  }
  return result;
}

export function isCapabilityAllowed(set: EffectiveCapabilitySet, ref: string): boolean {
  return set === "ALL" || set.has(ref);
}

export interface CapabilityScopeResolverDeps {
  listAssignmentsForScope: (scopeKind: CapabilityScopeKind, scopeId: string) => readonly CapabilityScopeAssignment[];
  listAllSkillIds: () => readonly string[];
  listAllIntegrationIds: () => readonly string[];
  listAllMcpServerIds: () => readonly string[];
  /** Defaults to reading the kill-switch env var. */
  isDisabled?: () => boolean;
  onError?: (error: unknown) => void;
}

export class CapabilityScopeResolver {
  public constructor(private readonly deps: CapabilityScopeResolverDeps) {}

  public resolve(citadelId: string, workspaceId: string): ResolvedCapabilities {
    try {
      const disabled = this.deps.isDisabled ? this.deps.isDisabled() : readKillSwitch();
      if (disabled) {
        return ALL_CAPABILITIES;
      }
      const citadel = this.deps.listAssignmentsForScope("citadel", citadelId || DEFAULT_CITADEL_ID);
      const workspace = this.deps.listAssignmentsForScope("workspace", workspaceId);
      return {
        skills: this.forType("skill", this.deps.listAllSkillIds(), citadel, workspace),
        integrations: this.forType("integration", this.deps.listAllIntegrationIds(), citadel, workspace),
        mcpServers: this.forType("mcp_server", this.deps.listAllMcpServerIds(), citadel, workspace),
      };
    } catch (error) {
      this.deps.onError?.(error);
      return ALL_CAPABILITIES; // fail-open: never narrow a turn due to a fault
    }
  }

  private forType(
    type: CapabilityResourceType,
    allGlobalIds: readonly string[],
    citadel: readonly CapabilityScopeAssignment[],
    workspace: readonly CapabilityScopeAssignment[],
  ): EffectiveCapabilitySet {
    return computeEffectiveSet(
      new Set(allGlobalIds),
      citadel.filter((r) => r.resourceType === type),
      workspace.filter((r) => r.resourceType === type),
    );
  }
}

function readKillSwitch(): boolean {
  const value = process.env[CAPABILITY_SCOPING_DISABLED_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-scope-resolver.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/capability-scope-resolver.ts apps/gateway/src/services/capability-scope-resolver.test.ts
git commit --no-verify -m "feat(gateway): CapabilityScopeResolver (algebra + fail-open + kill-switch)"
```

---

### Task 7: Construct the resolver in GatewayService + MCP deny-at-invocation

**Files:**
- Modify: `apps/gateway/src/services/gateway-service.ts` (field + construction after `this.skillsService` is assigned ~line 996; `invokeMcpTool` ~7760; add private `assertMcpServerInCapabilityScope`; ensure `PolicyViolationError` is imported from `@goatcitadel/contracts`)

- [ ] **Step 1: Add the field** (near other private service fields, e.g. by `skillsService`):
```ts
  private readonly capabilityScopeResolver: CapabilityScopeResolver;
```
And the import at the top of the file:
```ts
import { CapabilityScopeResolver, isCapabilityAllowed } from "./capability-scope-resolver.js";
```
Confirm `PolicyViolationError` and `DEFAULT_CITADEL_ID` are present in the existing `@goatcitadel/contracts` import (add them if missing). `DEFAULT_WORKSPACE_ID` is already defined locally at line ~690.

- [ ] **Step 2: Construct it** — immediately after `this.skillsService = new SkillsService([...]);` (and after `this.storage` is set), add:
```ts
    this.capabilityScopeResolver = new CapabilityScopeResolver({
      listAssignmentsForScope: (scopeKind, scopeId) => this.storage.capabilityScope.listForScope(scopeKind, scopeId),
      listAllSkillIds: () => this.skillsService.list().map((skill) => skill.skillId),
      listAllIntegrationIds: () => this.storage.integrationConnections.list(undefined, 1000).map((c) => c.connectionId),
      listAllMcpServerIds: () => this.listMcpServers().map((server) => server.serverId),
    });
```

- [ ] **Step 3: Enforce at MCP invocation** — change `invokeMcpTool` (~7760) from:
```ts
  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    return this.toolInvocationCoordinator.invokeMcpTool(this.enrichMcpInvokePolicyContext(input));
  }
```
to:
```ts
  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    const enriched = this.enrichMcpInvokePolicyContext(input);
    this.assertMcpServerInCapabilityScope(enriched);
    return this.toolInvocationCoordinator.invokeMcpTool(enriched);
  }

  private assertMcpServerInCapabilityScope(request: McpInvokeRequest): void {
    const workspaceId = request.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const citadelId = this.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
    const effective = this.capabilityScopeResolver.resolve(citadelId, workspaceId).mcpServers;
    if (!isCapabilityAllowed(effective, request.serverId)) {
      throw new PolicyViolationError({
        code: "POLICY_BLOCKED",
        message: `MCP server ${request.serverId} is not available in this workspace's capability scope.`,
        details: { serverId: request.serverId, workspaceId, citadelId },
      });
    }
  }
```

- [ ] **Step 4: Verify non-breaking + typecheck**

Run: `pnpm --filter @goatcitadel/gateway typecheck`
Expected: PASS.

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-scope-resolver.test.ts` and any existing MCP invoke test (search: `grep -rl "invokeMcpTool" apps/gateway/src --include=*.test.ts`), e.g. `pnpm --filter @goatcitadel/gateway exec vitest run <that-file>`
Expected: PASS — unconfigured installs resolve to `ALL`, so every existing MCP test still allows invocation (non-breaking).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/gateway-service.ts
git commit --no-verify -m "feat(gateway): enforce workspace/citadel MCP scope at invokeMcpTool (fail-open)"
```

---

### Task 8: Gateway MCP enforcement regression test

**Files:**
- Test: `apps/gateway/src/services/capability-scope-mcp-enforcement.test.ts`

This test verifies the decision wiring (resolve → isCapabilityAllowed) without standing up a full `GatewayService`, by exercising the same resolver + decision the private method uses.

- [ ] **Step 1: Write the test**

`apps/gateway/src/services/capability-scope-mcp-enforcement.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { CapabilityScopeAssignment } from "@goatcitadel/contracts";
import { CapabilityScopeResolver, isCapabilityAllowed } from "./capability-scope-resolver.js";

function citadelMcpGrant(serverRef: string): CapabilityScopeAssignment {
  return {
    assignmentId: `g-${serverRef}`,
    scopeKind: "citadel",
    scopeId: "personal",
    resourceType: "mcp_server",
    resourceRef: serverRef,
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
  };
}

function resolver(rows: CapabilityScopeAssignment[], disabled = false): CapabilityScopeResolver {
  return new CapabilityScopeResolver({
    listAssignmentsForScope: (kind, id) => rows.filter((r) => r.scopeKind === kind && r.scopeId === id),
    listAllSkillIds: () => [],
    listAllIntegrationIds: () => [],
    listAllMcpServerIds: () => ["allowed", "denied"],
    isDisabled: () => disabled,
  });
}

describe("MCP capability enforcement decision", () => {
  it("allows any server when the citadel/workspace are unconfigured", () => {
    const effective = resolver([]).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "denied")).toBe(true);
  });

  it("denies a server outside the citadel grant", () => {
    const effective = resolver([citadelMcpGrant("allowed")]).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "allowed")).toBe(true);
    expect(isCapabilityAllowed(effective, "denied")).toBe(false);
  });

  it("allows everything when the kill-switch disables scoping (fail-open)", () => {
    const effective = resolver([citadelMcpGrant("allowed")], true).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "denied")).toBe(true);
  });
});
```

- [ ] **Step 2: Run + expect PASS**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-scope-mcp-enforcement.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/services/capability-scope-mcp-enforcement.test.ts
git commit --no-verify -m "test(gateway): MCP capability-scope enforcement decision"
```

---

## Phase 3 — Skills capability-catalog scoping (§7b)

> Skills surface to the model via `capability-system-service.listSkills()` / the capability catalog (entries carry `skillId`). We add an OPTIONAL effective-skill filter so that when a workspace context is supplied, skill-kind entries outside the effective set are dropped. Built-in tool entries are never touched. Default (no filter / `"ALL"`) = unchanged behavior.

### Task 9: Effective-skill filter helper + listSkills filtering

**Files:**
- Modify: `apps/gateway/src/services/capability-system-service.ts` (`listSkills`)
- Test: `apps/gateway/src/services/capability-system-service.skill-scope.test.ts`

- [ ] **Step 1: Write the failing test** (vitest). Construct the service the same way the existing `capability-system-service.test.ts` does (copy its setup helper), then assert filtering. Skeleton:
```ts
import { describe, expect, it } from "vitest";
// import { makeCapabilitySystemService } from "./capability-system-service.test-helpers.js"; // reuse existing test setup
import { filterSkillItemsByEffectiveSet } from "./capability-system-service.js";

describe("filterSkillItemsByEffectiveSet", () => {
  const items = [
    { skillId: "a", name: "A" },
    { skillId: "b", name: "B" },
  ] as Array<{ skillId: string; name: string }>;

  it("returns all items when the effective set is ALL", () => {
    expect(filterSkillItemsByEffectiveSet(items, "ALL")).toHaveLength(2);
  });

  it("keeps only items in the effective set", () => {
    const result = filterSkillItemsByEffectiveSet(items, new Set(["a"]));
    expect(result.map((i) => i.skillId)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`filterSkillItemsByEffectiveSet` not exported).

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-system-service.skill-scope.test.ts`

- [ ] **Step 3: Implement** — in `capability-system-service.ts`, add and export the helper, and apply it in `listSkills` via an optional argument:
```ts
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";

export function filterSkillItemsByEffectiveSet<T extends { skillId: string }>(
  items: T[],
  effective: EffectiveCapabilitySet,
): T[] {
  if (effective === "ALL") {
    return items;
  }
  return items.filter((item) => effective.has(item.skillId));
}
```
Change `public listSkills(): SkillListItem[]` to accept an optional filter and apply it before returning:
```ts
  public listSkills(effectiveSkills: EffectiveCapabilitySet = "ALL"): SkillListItem[] {
    this.ensureSkillLifecycleBackfill();
    const stateMap = this.options.readSkillStates();
    const all = this.options.listLoadedSkills().map((skill) => {
      /* …existing mapping unchanged… */
    });
    return filterSkillItemsByEffectiveSet(all, effectiveSkills);
  }
```
(The default `"ALL"` keeps every existing caller behavior-identical.)

- [ ] **Step 4: Run → PASS**, then run the existing capability-system test to confirm non-breaking:

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-system-service.skill-scope.test.ts src/services/capability-system-service.test.ts`
Expected: PASS (existing tests unaffected — default `"ALL"`).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/capability-system-service.ts apps/gateway/src/services/capability-system-service.skill-scope.test.ts
git commit --no-verify -m "feat(gateway): optional effective-skill filter on listSkills"
```

### Task 10: Thread workspace context into the skills listing route

**Files:**
- Modify: `apps/gateway/src/services/capabilities-route-service.ts` (forward an optional `workspaceId`)
- Modify: `apps/gateway/src/routes/capabilities.ts` (accept `?workspaceId=`; resolve effective skills via the resolver and pass to `listSkills`)
- Test: extend `apps/gateway/src/routes/capabilities.test.ts` (or create if absent) asserting `?workspaceId` filters skills

- [ ] **Step 1: Write the failing test** asserting that `GET /api/v1/capabilities/skills?workspaceId=ws-scoped` returns only the effective skills (mock the service to capture the effective set passed). Mirror the inject-based route test pattern from `apps/gateway/src/routes/citadels.test.ts`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — the route reads `workspaceId` from the query, the route layer resolves the citadel + effective skills (the gateway exposes the resolver to route services — see Task 13's service wiring, reuse the same `capabilityScopeResolver`), and passes the effective set into `listSkills(effective)`. Where the route currently calls `fastify.services.capabilities.listSkills()`, add the optional workspace resolution. If the capabilities route-service does not yet hold the resolver, add it to its constructor deps (mirroring Task 13).

- [ ] **Step 4: Run → PASS** + `pnpm --filter @goatcitadel/gateway exec vitest run src/routes/capabilities.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/capabilities.ts apps/gateway/src/services/capabilities-route-service.ts apps/gateway/src/routes/capabilities.test.ts
git commit --no-verify -m "feat(gateway): scope skills listing by workspace capability set"
```

> NOTE: Confirm at implementation time whether the agent's tool-discovery path consults this route with a workspace context. If it does not yet, this still scopes the management/UI skill view; full agent-side skill enforcement is the documented residual follow-up (spec §11). MCP (the security-relevant surface) is already enforced in Phase 2.

---

## Phase 4 — Gateway API + client

### Task 11: CapabilityScopeRouteService

**Files:**
- Create: `apps/gateway/src/services/capability-scope-route-service.ts`
- Modify: `apps/gateway/src/services/gateway-route-services.ts` (interface member + construction)
- Test: `apps/gateway/src/services/capability-scope-route-service.test.ts`

The service builds a `CapabilityScopeView` for a `(scopeKind, scopeId, resourceType)` and persists updates. It composes the repo (grant rows) + a registry label/availability provider + the resolver (effective set).

- [ ] **Step 1: Write the failing test** — unit-test `buildView` and `updateScope` against an in-memory repo (`new CapabilityScopeRepository(createDatabase({dbPath}))` is storage-only; here use a small fake repo or the real one via `@goatcitadel/storage`). Assert:
  - unconfigured citadel → `mode:"inherit"`, all registry refs `available:true, inherited:true`, `effectiveRefs` = all;
  - after `updateScope` with `[{ref:"a",enabled:true},{ref:"b",enabled:false}]` → `mode:"curated"`, `effectiveRefs:["a"]`;
  - workspace view candidate set = the citadel-effective set (not all-global).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `apps/gateway/src/services/capability-scope-route-service.ts`:
```ts
import type {
  CapabilityResourceType,
  CapabilityScopeKind,
  CapabilityScopeUpdateInput,
  CapabilityScopeView,
} from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import type { CapabilityScopeRepository } from "@goatcitadel/storage";
import type { CapabilityScopeResolver, EffectiveCapabilitySet } from "./capability-scope-resolver.js";

export interface CapabilityRegistryEntry {
  ref: string;
  label: string;
}

export interface CapabilityScopeRouteServiceDeps {
  repo: CapabilityScopeRepository;
  resolver: CapabilityScopeResolver;
  /** Live registry entries (ref + label) per resource type. */
  listRegistry: (resourceType: CapabilityResourceType) => CapabilityRegistryEntry[];
  /** Resolve a workspace's citadel id (mirrors turn-prep). */
  resolveCitadelId: (workspaceId: string) => string;
}

/** A workspace id guaranteed to have no assignment rows, so the resolver yields the
 *  pure citadel-effective set (workspace inherits citadel). */
const NO_WORKSPACE = "__capability_scope_no_workspace__";

export class CapabilityScopeRouteService {
  public constructor(private readonly deps: CapabilityScopeRouteServiceDeps) {}

  public getView(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): CapabilityScopeView {
    const rows = this.deps.repo.list(scopeKind, scopeId, resourceType);
    const mode = rows.length === 0 ? "inherit" : "curated";
    const effective = this.effectiveFor(scopeKind, scopeId, resourceType);
    const candidates = this.candidateEntries(scopeKind, scopeId, resourceType);
    const enabledByRef = new Map(rows.map((r) => [r.resourceRef, r.enabled]));
    const items = candidates.map((entry) => ({
      resourceRef: entry.ref,
      label: entry.label,
      available: true,
      inherited: mode === "inherit",
      enabled: effective === "ALL" ? true : effective.has(entry.ref),
    }));
    // surface curated rows whose ref no longer exists in the registry (available:false)
    for (const row of rows) {
      if (!candidates.some((c) => c.ref === row.resourceRef)) {
        items.push({
          resourceRef: row.resourceRef,
          label: row.resourceRef,
          available: false,
          inherited: false,
          enabled: false,
        });
      }
    }
    return {
      scopeKind,
      scopeId,
      resourceType,
      mode,
      items,
      effectiveRefs: effective === "ALL" ? candidates.map((c) => c.ref) : [...effective],
    };
  }

  public updateScope(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    input: CapabilityScopeUpdateInput,
  ): CapabilityScopeView {
    this.deps.repo.replaceSet(
      scopeKind,
      scopeId,
      input.resourceType,
      input.assignments.map((a) => ({ resourceRef: a.resourceRef, enabled: a.enabled })),
    );
    return this.getView(scopeKind, scopeId, input.resourceType);
  }

  public resetScope(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): CapabilityScopeView {
    this.deps.repo.clear(scopeKind, scopeId, resourceType);
    return this.getView(scopeKind, scopeId, resourceType);
  }

  /** Candidate set: citadel scope draws from the global registry; workspace scope draws
   *  from the citadel-effective set (D4 — a workspace can only narrow its citadel). */
  private candidateEntries(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): CapabilityRegistryEntry[] {
    const registry = this.deps.listRegistry(resourceType);
    if (scopeKind === "citadel") {
      return registry;
    }
    const citadelId = this.deps.resolveCitadelId(scopeId);
    // Citadel-effective = resolve with a workspace that has no rows (inherits citadel).
    const citadelEffective = this.resolveType(citadelId, NO_WORKSPACE, resourceType);
    return citadelEffective === "ALL" ? registry : registry.filter((e) => citadelEffective.has(e.ref));
  }

  private effectiveFor(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): EffectiveCapabilitySet {
    if (scopeKind === "citadel") {
      return this.resolveType(scopeId, NO_WORKSPACE, resourceType);
    }
    const citadelId = this.deps.resolveCitadelId(scopeId);
    return this.resolveType(citadelId, scopeId, resourceType);
  }

  private resolveType(
    citadelId: string,
    workspaceId: string,
    resourceType: CapabilityResourceType,
  ): EffectiveCapabilitySet {
    const resolved = this.deps.resolver.resolve(citadelId || DEFAULT_CITADEL_ID, workspaceId);
    return resourceType === "skill"
      ? resolved.skills
      : resourceType === "integration"
        ? resolved.integrations
        : resolved.mcpServers;
  }
}
```
> Implementation note: passing `workspaceId:"__none__"` for citadel-only resolution yields the citadel-effective set because that workspace has no rows (inherits citadel). This reuses the resolver without a second code path.

- [ ] **Step 4: Wire into `gateway-route-services.ts`** — add `capabilityScope: CapabilityScopeRouteService;` to `GatewayRouteServices` (~line 191) and construct it (~line 342) from `deps` (the gateway passes `storage.capabilityScope`, the `capabilityScopeResolver`, registry providers `listRegistry`, and `resolveCitadelId`). Mirror the existing `citadels`/`workspaces` member wiring. The gateway composition (`gateway-service.ts`) supplies the deps.

- [ ] **Step 5: Run → PASS** + `pnpm --filter @goatcitadel/gateway typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/capability-scope-route-service.ts apps/gateway/src/services/capability-scope-route-service.test.ts apps/gateway/src/services/gateway-route-services.ts
git commit --no-verify -m "feat(gateway): CapabilityScopeRouteService (view + update + reset)"
```

### Task 12: REST routes

**Files:**
- Create: `apps/gateway/src/routes/capability-scope-routes.ts`
- Modify: `apps/gateway/src/app.ts` (register, near `await app.register(citadelsRoutes);`)
- Test: `apps/gateway/src/routes/capability-scope-routes.test.ts`

- [ ] **Step 1: Write the failing route test** — mirror `citadels.test.ts`: build a Fastify app, `app.decorate("services", { capabilityScope } as never)`, register the plugin, `app.inject(...)`. Assert GET returns the view and PATCH calls `updateScope`. Cover citadel + workspace paths + a 400 on an invalid `resourceType`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `apps/gateway/src/routes/capability-scope-routes.ts`:
```ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITY_RESOURCE_TYPES } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";
import { sendRouteError } from "./_error-handler.js";

const resourceTypeSchema = z.enum(CAPABILITY_RESOURCE_TYPES);
const citadelParams = z.object({ citadelId: z.string().min(1) });
const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const typeQuery = z.object({ type: resourceTypeSchema });
const updateBody = z.object({
  resourceType: resourceTypeSchema,
  assignments: z.array(z.object({ resourceRef: z.string().min(1), enabled: z.boolean() })),
});

export const capabilityScopeRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const svc = fastify.services.capabilityScope;

  // ---- Citadel ----
  fastify.get("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.getView("citadel", params.data.citadelId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const body = updateBody.safeParse(request.body ?? {});
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return reply.send(svc.updateScope("citadel", params.data.citadelId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.resetScope("citadel", params.data.citadelId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // ---- Workspace ----
  fastify.get("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.getView("workspace", params.data.workspaceId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const body = updateBody.safeParse(request.body ?? {});
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return reply.send(svc.updateScope("workspace", params.data.workspaceId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.resetScope("workspace", params.data.workspaceId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
```
And in `apps/gateway/src/app.ts`, alongside `await app.register(citadelsRoutes);` add:
```ts
import { capabilityScopeRoutes } from "./routes/capability-scope-routes.js";
// ...
await app.register(capabilityScopeRoutes);
```
Add `capabilityScope: CapabilityScopeRouteService` to the `FastifyInstance["services"]` type if it is a closed interface (it is `GatewayRouteServices` — already extended in Task 11).

- [ ] **Step 4: Run → PASS** + `pnpm --filter @goatcitadel/gateway typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/capability-scope-routes.ts apps/gateway/src/routes/capability-scope-routes.test.ts apps/gateway/src/app.ts
git commit --no-verify -m "feat(gateway): citadel + workspace capability REST endpoints"
```

### Task 13: mission-control-shared client functions

**Files:**
- Create: `packages/mission-control-shared/src/api/capabilities-scope.ts`
- Modify: the api barrel (`packages/mission-control-shared/src/api/client.ts`) to re-export
- Test: `packages/mission-control-shared/src/api/capabilities-scope.test.ts` (mock `request`)

- [ ] **Step 1: Write the failing test** mirroring an existing api test (mock the `request` helper, assert the URL + method + body for each fn).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `packages/mission-control-shared/src/api/capabilities-scope.ts`:
```ts
import type {
  CapabilityResourceType,
  CapabilityScopeUpdateInput,
  CapabilityScopeView,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchCitadelCapabilities(
  citadelId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`,
  );
}

export async function updateCitadelCapabilities(
  citadelId: string,
  input: CapabilityScopeUpdateInput,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(`/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function resetCitadelCapabilities(
  citadelId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`,
    { method: "DELETE" },
  );
}

export async function fetchWorkspaceCapabilities(
  workspaceId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?type=${type}`,
  );
}

export async function updateWorkspaceCapabilities(
  workspaceId: string,
  input: CapabilityScopeUpdateInput,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function resetWorkspaceCapabilities(
  workspaceId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?type=${type}`,
    { method: "DELETE" },
  );
}
```
Add `export * from "./capabilities-scope.js";` to the api barrel (`client.ts`) next to the other `export *` lines. (Confirm the exact `request` import path/signature against an existing api module, e.g. `settings.ts`.)

- [ ] **Step 4: Run → PASS** + `pnpm --filter @goatcitadel/mission-control-shared typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/api/capabilities-scope.ts packages/mission-control-shared/src/api/capabilities-scope.test.ts packages/mission-control-shared/src/api/client.ts
git commit --no-verify -m "feat(mc-shared): capability-scope API client fns"
```

---

## Phase 5 — Management UI

### Task 14: Shared CapabilityScopePanel component

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/settings/sections/CapabilityScopePanel.tsx`
- Test: `apps/mission-control-next/src/features/native-routes/settings/sections/CapabilityScopePanel.test.tsx`

A reusable panel that renders one resource type (skills | plugins | mcp) for a given scope: loads the view, shows a toggle list, a Save button (`updateScope`), and a "Reset to inherited" button (`resetScope`). Used by both the workspace and citadel sections.

- [ ] **Step 1: Write the failing test** — `vi.hoisted` mocks for the relevant fetch/update fns (mirror `CitadelMasonRoutePage.test.tsx`), render the panel, assert it renders item labels and an inherited badge for `mode:"inherit"`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — props: `{ scopeKind, scopeId, resourceType, title }` plus the bound `fetch/update/reset` fns (passed in so the same panel serves citadel + workspace). Use `useAsyncLoad`, `NativeCard`, `NativeSelectableList` (or a checkbox list), `NativeButton`, and the `SettingsNotice`/`getErrorMessage` helpers from `SettingsShared`. Toggling builds the full `assignments` array from `view.items` (so first edit materializes the curated set), Save calls `updateScope`, Reset calls `resetScope` then reloads. Render an "Inherited (all from parent)" chip when `view.mode === "inherit"`. Mirror the imports of `BudgetSection.tsx` and `LibrarySkillsSection.tsx` exactly.

- [ ] **Step 4: Run → PASS** + `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings/sections/CapabilityScopePanel.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/settings/sections/CapabilityScopePanel.tsx apps/mission-control-next/src/features/native-routes/settings/sections/CapabilityScopePanel.test.tsx
git commit --no-verify -m "feat(mc-next): reusable CapabilityScopePanel"
```

### Task 15: Workspace + Citadel capability sections

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/settings/sections/WorkspaceCapabilitiesSection.tsx`
- Create: `apps/mission-control-next/src/features/native-routes/settings/sections/CitadelCapabilitiesSection.tsx`

- [ ] **Step 1: Implement WorkspaceCapabilitiesSection** — a `SettingsSectionProps` component that renders three `CapabilityScopePanel`s (Skills / Plugins / MCP) bound to `scopeKind="workspace"`, `scopeId={activeWorkspaceId}`, and the `fetchWorkspaceCapabilities`/`updateWorkspaceCapabilities`/`resetWorkspaceCapabilities` client fns. Wrap in `SettingsPageFrame` + `SettingsGrid`. Include a one-line link to the Citadel capabilities section ("Need a capability that isn't listed? Grant it at the Citadel.").

- [ ] **Step 2: Implement CitadelCapabilitiesSection** — same, bound to `scopeKind="citadel"`, `scopeId={activeCitadelId ?? DEFAULT_CITADEL_ID}`, and the `fetchCitadelCapabilities`/… fns.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/settings/sections/WorkspaceCapabilitiesSection.tsx apps/mission-control-next/src/features/native-routes/settings/sections/CitadelCapabilitiesSection.tsx
git commit --no-verify -m "feat(mc-next): workspace + citadel capability sections"
```

### Task 16: Register the sections (routes + dispatch)

**Files:**
- Modify: `apps/mission-control-next/src/app/route-model.ts` (`SettingsSection` union ~34-50, `RAIL_ITEMS.settings` ~478-591, `RAIL_GROUPS.settings` ~608-618)
- Modify: `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx` (switch ~370)

- [ ] **Step 1: Add the section ids** — extend the `SettingsSection` union:
```ts
  | "workspace-capabilities"
  | "citadel-capabilities"
```

- [ ] **Step 2: Add rail items** — in `RAIL_ITEMS.settings`:
```ts
    {
      id: "settings-workspace-capabilities",
      label: "Workspace capabilities",
      description: "Choose which skills, plugins, and MCP servers this workspace uses.",
      area: "settings",
      section: "workspace-capabilities",
    },
    {
      id: "settings-citadel-capabilities",
      label: "Citadel capabilities",
      description: "Govern which skills, plugins, and MCP servers exist in this Citadel.",
      area: "settings",
      section: "citadel-capabilities",
    },
```
And add both section strings to a `RAIL_GROUPS.settings` group (e.g. the `settings-surfaces` group, or `settings-foundations` for the workspace one).

- [ ] **Step 3: Add the switch cases** — in `renderSettingsSection` (SettingsNativePage.tsx):
```ts
    case "workspace-capabilities":
      return <WorkspaceCapabilitiesSection {...props} />;
    case "citadel-capabilities":
      return <CitadelCapabilitiesSection {...props} />;
```
(plus the two imports at the top.)

- [ ] **Step 4: Typecheck + UI test sweep**

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck && pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/app/route-model.ts apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx
git commit --no-verify -m "feat(mc-next): register workspace + citadel capability sections"
```

---

## Final verification (after all phases)

- [ ] **Per-package green:**
```bash
pnpm --filter @goatcitadel/contracts typecheck
pnpm --filter @goatcitadel/storage typecheck && pnpm --filter @goatcitadel/storage test
pnpm --filter @goatcitadel/gateway typecheck && pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-scope-resolver.test.ts src/services/capability-scope-mcp-enforcement.test.ts src/services/capability-scope-route-service.test.ts src/routes/capability-scope-routes.test.ts
pnpm --filter @goatcitadel/mission-control-shared typecheck && pnpm --filter @goatcitadel/mission-control-shared test
pnpm --filter @goatcitadel/mission-control-next typecheck
```
- [ ] **Non-breaking check:** confirm the broader gateway suite still passes for touched files (MCP invoke + capability-system). Run the relevant existing suites and confirm green.
- [ ] **Spec parity:** re-read the spec §6 (algebra), §7 (seams), §10 (edge cases) and confirm each has a covering test.

---

## Notes for the implementer

- **Storage tests use `node:test`/`tsx`, every other package uses vitest.** Don't import `vitest` in `packages/storage`.
- **Fail-open is load-bearing:** the resolver must never throw out of `resolve()`. Every enforcement site treats `"ALL"` as "allow".
- **Non-breaking invariant:** unconfigured scopes resolve to `"ALL"`. If any existing test starts failing because a capability was hidden, that is a bug in the resolver/wiring, not the test.
- **Husky:** commit with `git commit --no-verify` (the pre-commit hook cannot spawn in this environment). Run the per-package typecheck/test commands manually before each commit instead.
- **Worktree:** stay in `F:/code/personal-ai/.claude/worktrees/workspace-capability-scoping` on `worktree-workspace-capability-scoping`. Do not switch to any `codex/*` branch.
