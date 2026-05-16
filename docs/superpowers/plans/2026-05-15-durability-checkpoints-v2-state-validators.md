# Durability: Checkpoints v2 + Auto-Resume + Persisted-State Validators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable-run auto-resume visible at boot, add a checkpoint pruning sweep with a disk budget, and validate the shape of every JSON-backed persisted-state column on read so malformed rows are quarantined for `doctor --fix` instead of poisoning runtime.

**Architecture:** Add a dependency-free `loadAndSanitize` helper in `packages/storage/src/` that pipelines `null|""|undefined → fallback` and `string → JSON.parse → caller-supplied SafeParse → fallback + quarantine` paths. Back the quarantine with a new SQLite/Postgres table and repo. Extend `DurableRunRepository` with a `pruneCheckpoints` method that drops orphans, caps per-run, and respects a disk budget. Wire all three into the gateway boot path so `DurableRunService.startWorker()` emits a single structured "durable runs resumed after restart" log line, surfaces a `lastBootRecovery` shape on diagnostics, and runs the prune.

**Tech Stack:** TypeScript (Node 22 ESM), better-sqlite3 via `node:sqlite` / `DatabaseClient`, Fastify, Pino logger, Vitest (gateway + contracts), `tsx --test` + `node:assert/strict` (storage), Zod (contracts/gateway already; storage stays Zod-free and accepts caller-supplied SafeParse functions).

**Branch:** `feature/durability-checkpoints-v2-state-validators` (already created and on a `docs:` commit with the spec).

**Spec:** [`docs/superpowers/specs/2026-05-15-durability-checkpoints-v2-state-validators-design.md`](../specs/2026-05-15-durability-checkpoints-v2-state-validators-design.md)

---

## File map

**New files:**
- `packages/storage/src/load-and-sanitize.ts` — pure helper, no deps beyond `node:`
- `packages/storage/src/load-and-sanitize.test.ts`
- `packages/storage/src/state-validation-quarantine-repo.ts`
- `packages/storage/src/state-validation-quarantine-repo.test.ts`
- `packages/storage/src/state-validators.ts` — shared `SafeParse` validators used across repos (routing hints object, JSON object, JSON array)
- `packages/storage/src/state-validators.test.ts`

**Modified files:**
- `packages/contracts/src/durable.ts` — extend `DurableDiagnosticsResponse`
- `packages/storage/src/sqlite.ts` — migration version 79 + base-schema entry
- `packages/storage/src/postgres/migrations.ts` — migration version 32
- `packages/storage/src/index.ts` — export new helper + repo, plumb through `Storage`
- `packages/storage/src/durable-run-repo.ts` — `pruneCheckpoints` + sanitize on read
- `packages/storage/src/durable-run-repo.test.ts` — prune tests
- `packages/storage/src/session-repo.ts` — sanitize `routing_hints_json`
- `packages/storage/src/session-repo.test.ts` — corrupt-row test
- `packages/storage/src/task-repo.ts`, `task-repo.test.ts`
- `packages/storage/src/cron-job-repo.ts`, `cron-job-repo.test.ts`
- `packages/storage/src/chat-message-repo.ts`, `chat-message-repo.test.ts`
- `packages/storage/src/transcript-log.ts`, `transcript-log.test.ts`
- `packages/storage/src/realtime-stream-lease-repo.ts`, `realtime-stream-lease-repo.test.ts`
- `packages/storage/src/idempotency-repo.ts`, `idempotency-repo.test.ts`
- `packages/storage/src/pending-approval-action-repo.ts`, `pending-approval-action-repo.test.ts`
- `apps/gateway/src/services/durable-run-service.ts` — boot resume log, pruning, `lastBootRecovery`
- `apps/gateway/src/services/durable-run-service.test.ts` — boot recovery tests
- `apps/gateway/src/doctor/engine.ts` — `state.validation.quarantine` check
- `apps/gateway/src/doctor/engine.test.ts` — quarantine check tests

**Test runner reference (do not forget):**
- `packages/contracts`: vitest. Run `pnpm --filter @goatcitadel/contracts test`.
- `packages/storage`: `node:test` via `tsx --test`. Tests import `describe`, `it`, `afterEach` from `node:test`; assertions from `node:assert/strict`. Run `pnpm --filter @goatcitadel/storage test`.
- `apps/gateway`: vitest. Run `pnpm --filter @goatcitadel/gateway test`.

**Commit convention:** Conventional commits, signed off with the existing project style. The codebase uses subject lines like `Gate durable retry on workflow recoverability` (no Conventional Commits prefix for runtime changes; `docs:` for docs). Match what exists.

---

## Task 1: Contracts — add `lastBootRecovery` to `DurableDiagnosticsResponse`

**Files:**
- Modify: `packages/contracts/src/durable.ts` (around line 188)

- [ ] **Step 1: Read current `DurableDiagnosticsResponse` definition**

Run: open `packages/contracts/src/durable.ts` and locate the interface that ends at line ~188 (the `generatedAt: string;` closing field).

- [ ] **Step 2: Extend the interface**

Edit `packages/contracts/src/durable.ts`. Find the block:

```ts
export interface DurableDiagnosticsResponse {
  enabled: boolean;
  replayFoundationReady: boolean;
  runCount: number;
  queuedCount: number;
  runningCount: number;
  waitingCount: number;
  failedCount: number;
  deadLetterCount: number;
  recentRuns: DurableRunRecord[];
  recentDeadLetters: DurableDeadLetterRecord[];
  eventLoopLag?: {
    lastMs: number;
    lastObservedAt: string;
    leaseAcquisitionPausedUntil?: string;
  };
  generatedAt: string;
}
```

Replace it with:

```ts
export interface DurableDiagnosticsResponse {
  enabled: boolean;
  replayFoundationReady: boolean;
  runCount: number;
  queuedCount: number;
  runningCount: number;
  waitingCount: number;
  failedCount: number;
  deadLetterCount: number;
  recentRuns: DurableRunRecord[];
  recentDeadLetters: DurableDeadLetterRecord[];
  eventLoopLag?: {
    lastMs: number;
    lastObservedAt: string;
    leaseAcquisitionPausedUntil?: string;
  };
  lastBootRecovery?: {
    observedAt: string;
    resumedCount: number;
    prunedOrphanCheckpoints: number;
    prunedAgedCheckpoints: number;
    finalCheckpointBytes: number;
    diskBudgetBytes: number;
  };
  generatedAt: string;
}
```

- [ ] **Step 3: Typecheck contracts**

Run: `pnpm --filter @goatcitadel/contracts typecheck`
Expected: PASS (no diagnostic errors).

- [ ] **Step 4: Run contracts tests**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS (no behavior changes; adding an optional field is structural-only).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/durable.ts
git commit -m "Add lastBootRecovery to durable diagnostics contract"
```

---

## Task 2: Storage — `loadAndSanitize` helper (TDD)

**Files:**
- Create: `packages/storage/src/load-and-sanitize.ts`
- Create: `packages/storage/src/load-and-sanitize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/storage/src/load-and-sanitize.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAndSanitize, type QuarantineEntry, type SafeParse } from "./load-and-sanitize.js";

const okParse: SafeParse<Record<string, unknown>> = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? { success: true, data: value as Record<string, unknown> }
    : { success: false, error: { message: "expected object" } };

describe("loadAndSanitize", () => {
  it("returns fallback for null without quarantine", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(null, {
      store: "test",
      rowId: "row-1",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, undefined);
    assert.equal(out, undefined);
    assert.equal(entries.length, 0);
  });

  it("returns fallback for empty string without quarantine", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize("", {
      store: "test",
      rowId: "row-1",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, { fallback: true });
    assert.deepEqual(out, { fallback: true });
    assert.equal(entries.length, 0);
  });

  it("quarantines malformed JSON and returns fallback", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize("{not json", {
      store: "test",
      rowId: "row-2",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, undefined);
    assert.equal(out, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].store, "test");
    assert.equal(entries[0].rowId, "row-2");
    assert.equal(entries[0].rawValue, "{not json");
    assert.match(entries[0].schemaError, /^json_parse:/);
  });

  it("quarantines parses-but-fails-schema rows", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize("[1,2,3]", {
      store: "test",
      rowId: "row-3",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, undefined);
    assert.equal(out, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].rawValue, "[1,2,3]");
    assert.match(entries[0].schemaError, /^schema:/);
  });

  it("returns parsed value when schema accepts", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize('{"a":1}', {
      store: "test",
      rowId: "row-4",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, undefined);
    assert.deepEqual(out, { a: 1 });
    assert.equal(entries.length, 0);
  });

  it("does not throw when onQuarantine throws", () => {
    const out = loadAndSanitize("{not json", {
      store: "test",
      rowId: "row-5",
      parse: okParse,
      onQuarantine: () => {
        throw new Error("sink failed");
      },
    }, undefined);
    assert.equal(out, undefined);
  });

  it("accepts non-string raw and runs the parser directly", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize({ already: "parsed" }, {
      store: "test",
      rowId: "row-6",
      parse: okParse,
      onQuarantine: (e) => entries.push(e),
    }, undefined);
    assert.deepEqual(out, { already: "parsed" });
    assert.equal(entries.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern loadAndSanitize`
Expected: FAIL with module-not-found / `loadAndSanitize` import error.

- [ ] **Step 3: Implement the helper**

Create `packages/storage/src/load-and-sanitize.ts`:

```ts
export interface QuarantineEntry {
  store: string;
  rowId: string;
  rawValue: string | null;
  schemaError: string;
  observedAt: string;
}

export interface SafeParseResult<T> {
  success: boolean;
  data?: T;
  error?: { message: string };
}

export type SafeParse<T> = (value: unknown) => SafeParseResult<T>;

export interface LoadAndSanitizeContext<T> {
  store: string;
  rowId: string;
  parse: SafeParse<T>;
  onQuarantine?: (entry: QuarantineEntry) => void;
  log?: { warn: (data: unknown, message: string) => void };
}

export function loadAndSanitize<T>(
  rawValue: unknown,
  ctx: LoadAndSanitizeContext<T>,
  fallback: T | undefined,
): T | undefined {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return fallback;
  }

  let parsed: unknown;
  if (typeof rawValue === "string") {
    try {
      parsed = JSON.parse(rawValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportQuarantine(ctx, rawValue, `json_parse: ${message}`);
      return fallback;
    }
  } else {
    parsed = rawValue;
  }

  const result = ctx.parse(parsed);
  if (!result.success || result.data === undefined) {
    const message = result.error?.message ?? "unknown schema error";
    const rawForQuarantine = typeof rawValue === "string" ? rawValue : safeStringify(rawValue);
    reportQuarantine(ctx, rawForQuarantine, `schema: ${message}`);
    return fallback;
  }

  return result.data;
}

function reportQuarantine<T>(
  ctx: LoadAndSanitizeContext<T>,
  rawValue: string | null,
  schemaError: string,
): void {
  ctx.log?.warn(
    { store: ctx.store, rowId: ctx.rowId, schemaError },
    "state validation failed; row routed to quarantine",
  );
  if (!ctx.onQuarantine) {
    return;
  }
  try {
    ctx.onQuarantine({
      store: ctx.store,
      rowId: ctx.rowId,
      rawValue,
      schemaError,
      observedAt: new Date().toISOString(),
    });
  } catch (sinkError) {
    ctx.log?.warn(
      { store: ctx.store, rowId: ctx.rowId, sinkError: stringifyError(sinkError) },
      "state validation quarantine sink threw; suppressed",
    );
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern loadAndSanitize`
Expected: all 7 tests PASS.

- [ ] **Step 5: Typecheck storage**

Run: `pnpm --filter @goatcitadel/storage typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/load-and-sanitize.ts packages/storage/src/load-and-sanitize.test.ts
git commit -m "Add loadAndSanitize helper for persisted-state validation"
```

---

## Task 3: Storage — shared validators (TDD)

**Files:**
- Create: `packages/storage/src/state-validators.ts`
- Create: `packages/storage/src/state-validators.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/storage/src/state-validators.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject, parseJsonArray, parseStringRecord } from "./state-validators.js";

describe("state-validators", () => {
  describe("parseJsonObject", () => {
    it("accepts plain objects", () => {
      const result = parseJsonObject({ a: 1, b: "x" });
      assert.equal(result.success, true);
      assert.deepEqual(result.data, { a: 1, b: "x" });
    });

    it("rejects arrays", () => {
      const result = parseJsonObject([1, 2]);
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("rejects null", () => {
      const result = parseJsonObject(null);
      assert.equal(result.success, false);
    });

    it("rejects primitives", () => {
      assert.equal(parseJsonObject(42).success, false);
      assert.equal(parseJsonObject("hi").success, false);
      assert.equal(parseJsonObject(true).success, false);
    });
  });

  describe("parseJsonArray", () => {
    it("accepts arrays", () => {
      const result = parseJsonArray([1, 2, 3]);
      assert.equal(result.success, true);
      assert.deepEqual(result.data, [1, 2, 3]);
    });

    it("rejects objects", () => {
      assert.equal(parseJsonArray({ a: 1 }).success, false);
    });

    it("rejects null", () => {
      assert.equal(parseJsonArray(null).success, false);
    });
  });

  describe("parseStringRecord", () => {
    it("accepts objects of string values", () => {
      const result = parseStringRecord({ a: "1", b: "2" });
      assert.equal(result.success, true);
      assert.deepEqual(result.data, { a: "1", b: "2" });
    });

    it("rejects when any value is non-string", () => {
      const result = parseStringRecord({ a: "1", b: 2 });
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? "", /b/);
    });

    it("accepts empty object", () => {
      const result = parseStringRecord({});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, {});
    });
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern state-validators`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement validators**

Create `packages/storage/src/state-validators.ts`:

```ts
import type { SafeParse, SafeParseResult } from "./load-and-sanitize.js";

export const parseJsonObject: SafeParse<Record<string, unknown>> = (value) => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { success: true, data: value as Record<string, unknown> };
  }
  return { success: false, error: { message: "expected JSON object" } };
};

export const parseJsonArray: SafeParse<unknown[]> = (value) => {
  if (Array.isArray(value)) {
    return { success: true, data: value };
  }
  return { success: false, error: { message: "expected JSON array" } };
};

export const parseStringRecord: SafeParse<Record<string, string>> = (value): SafeParseResult<Record<string, string>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, error: { message: "expected object of string values" } };
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return { success: false, error: { message: `${key}: expected string, got ${typeof v}` } };
    }
    out[key] = v;
  }
  return { success: true, data: out };
};
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern state-validators`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/state-validators.ts packages/storage/src/state-validators.test.ts
git commit -m "Add shared SafeParse validators for persisted JSON columns"
```

---

## Task 4: Storage — `state_validation_quarantine` schema migration

**Files:**
- Modify: `packages/storage/src/sqlite.ts` (around line 774 — end of `SCHEMA_MIGRATIONS` array, latest version is 78)
- Modify: `packages/storage/src/postgres/migrations.ts` (around line 900 — end of `POSTGRES_MIGRATIONS`, latest version is 31)

- [ ] **Step 1: Write the migration parity test**

Storage migrations have an existing test:
`scripts/verify-storage-migration-parity.test.mjs`. Don't add a new test for parity — add a test for the table's existence after migration in storage.

Create or append to `packages/storage/src/state-validation-quarantine-repo.test.ts` (full file content will be filled in Task 5, but for now add only the migration-presence test):

```ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";

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

describe("state_validation_quarantine schema", () => {
  it("creates the quarantine table on first boot", () => {
    const dbPath = path.join(os.tmpdir(), `gc-quarantine-schema-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_validation_quarantine'")
      .get();
    assert.ok(row, "quarantine table should exist after migrate");
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_state_validation_quarantine_store_observed'",
      )
      .get();
    assert.ok(idx, "quarantine index should exist after migrate");
  });
});
```

- [ ] **Step 2: Verify the migration test fails**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "state_validation_quarantine schema"`
Expected: FAIL (`row` is undefined because the table doesn't exist).

- [ ] **Step 3: Add the SQLite migration**

Open `packages/storage/src/sqlite.ts`. Find the last entry in `SCHEMA_MIGRATIONS`:

```ts
  {
    version: 78,
    name: "cron_jobs_action_config",
    up: (db) => {
      addColumnIfMissingIfTableExists(db, "cron_jobs", "action_config_json", "TEXT");
    },
  },
];
```

Insert a new entry **before** the closing `];`:

```ts
  {
    version: 79,
    name: "state_validation_quarantine",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS state_validation_quarantine (
          quarantine_id TEXT PRIMARY KEY,
          store TEXT NOT NULL,
          row_id TEXT NOT NULL,
          raw_value TEXT,
          schema_error TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
          ON state_validation_quarantine(store, observed_at DESC);
      `);
    },
  },
```

Also add the same `CREATE TABLE` and `CREATE INDEX` to `createBaseSchema` (called by migration version 1) so fresh databases get it without iterating through the migration history. Locate `createBaseSchema` (it's invoked from migration version 1 via `up: createBaseSchema`). After the last `CREATE INDEX` block inside `createBaseSchema`, append the same SQL. Find the last existing `CREATE TABLE` or `CREATE INDEX` inside `createBaseSchema` and append after it:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS state_validation_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    store TEXT NOT NULL,
    row_id TEXT NOT NULL,
    raw_value TEXT,
    schema_error TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
    ON state_validation_quarantine(store, observed_at DESC);
`);
```

> If you can't find `createBaseSchema` easily: search for `function createBaseSchema(db: DatabaseSync): void {` and add the SQL at the end of the function body, before the closing brace.

- [ ] **Step 4: Verify SQLite test passes**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "state_validation_quarantine schema"`
Expected: PASS.

- [ ] **Step 5: Add the Postgres migration**

Open `packages/storage/src/postgres/migrations.ts`. Find the last entry (version 31). Insert a new entry before the closing `];`:

```ts
  {
    version: 32,
    name: "state_validation_quarantine",
    sql: `
      CREATE TABLE IF NOT EXISTS state_validation_quarantine (
        quarantine_id TEXT PRIMARY KEY,
        store TEXT NOT NULL,
        row_id TEXT NOT NULL,
        raw_value TEXT,
        schema_error TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
        ON state_validation_quarantine(store, observed_at DESC);
    `,
  },
```

Also locate the `buildPostgresRuntimeSchemaSql` runtime-schema builder (imported at the top of `migrations.ts`). Open `packages/storage/src/postgres/runtime-schema.ts` and add the same table+index to the schema definitions following the existing pattern (each table is built inside the function via template strings — append a similar block). If unsure about runtime-schema pattern, run:

```bash
git grep -n "CREATE TABLE" packages/storage/src/postgres/runtime-schema.ts | tail -3
```

Mimic the closest neighbour.

- [ ] **Step 6: Run the migration-parity check**

Run: `pnpm verify:storage:migration-parity`
Expected: PASS. If the parity script flags missing rows or columns, reconcile by tightening the Postgres migration to match SQLite (or vice versa).

- [ ] **Step 7: Run all storage tests**

Run: `pnpm --filter @goatcitadel/storage test`
Expected: PASS (no behavior regression elsewhere).

- [ ] **Step 8: Commit**

```bash
git add packages/storage/src/sqlite.ts packages/storage/src/postgres/migrations.ts packages/storage/src/postgres/runtime-schema.ts packages/storage/src/state-validation-quarantine-repo.test.ts
git commit -m "Add state_validation_quarantine schema migration"
```

---

## Task 5: Storage — `StateValidationQuarantineRepository` (TDD)

**Files:**
- Create: `packages/storage/src/state-validation-quarantine-repo.ts`
- Append: `packages/storage/src/state-validation-quarantine-repo.test.ts`

- [ ] **Step 1: Append behaviour tests to existing test file**

Append to `packages/storage/src/state-validation-quarantine-repo.test.ts` (the file already exists from Task 4 with the schema-presence test):

```ts
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

function createRepo(): StateValidationQuarantineRepository {
  const dbPath = path.join(os.tmpdir(), `gc-quarantine-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new StateValidationQuarantineRepository(db);
}

describe("StateValidationQuarantineRepository", () => {
  it("records an entry and lists it back", () => {
    const repo = createRepo();
    repo.record({
      store: "session.routing_hints",
      rowId: "session-1",
      rawValue: "{not json",
      schemaError: "json_parse: Unexpected token",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    const list = repo.list(10);
    assert.equal(list.length, 1);
    assert.equal(list[0].store, "session.routing_hints");
    assert.equal(list[0].rowId, "session-1");
    assert.equal(list[0].schemaError, "json_parse: Unexpected token");
  });

  it("orders entries newest-observed-first", () => {
    const repo = createRepo();
    repo.record({
      store: "a",
      rowId: "r1",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    repo.record({
      store: "a",
      rowId: "r2",
      rawValue: null,
      schemaError: "schema: x",
      observedAt: "2026-05-15T01:00:00.000Z",
    });
    const list = repo.list(10);
    assert.equal(list[0].rowId, "r2");
    assert.equal(list[1].rowId, "r1");
  });

  it("counts entries", () => {
    const repo = createRepo();
    assert.equal(repo.count(), 0);
    repo.record({
      store: "a", rowId: "r1", rawValue: null,
      schemaError: "schema: x", observedAt: "2026-05-15T00:00:00.000Z",
    });
    repo.record({
      store: "a", rowId: "r2", rawValue: null,
      schemaError: "schema: x", observedAt: "2026-05-15T00:00:00.000Z",
    });
    assert.equal(repo.count(), 2);
  });

  it("groups counts by store", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "a", rowId: "r2", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r3", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const grouped = repo.countsByStore();
    assert.deepEqual(
      grouped.sort((l, r) => l.store.localeCompare(r.store)),
      [{ store: "a", count: 2 }, { store: "b", count: 1 }],
    );
  });

  it("clears entries by store", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r2", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const cleared = repo.clear("a");
    assert.equal(cleared, 1);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list(10)[0].store, "b");
  });

  it("clears all entries when no store filter", () => {
    const repo = createRepo();
    repo.record({ store: "a", rowId: "r1", rawValue: null, schemaError: "x", observedAt: "2026-05-15T00:00:00Z" });
    repo.record({ store: "b", rowId: "r2", rawValue: null, schemaError: "y", observedAt: "2026-05-15T00:00:00Z" });
    const cleared = repo.clear();
    assert.equal(cleared, 2);
    assert.equal(repo.count(), 0);
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern StateValidationQuarantineRepository`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the repo**

Create `packages/storage/src/state-validation-quarantine-repo.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { QuarantineEntry } from "./load-and-sanitize.js";

interface QuarantineRow {
  quarantine_id: string;
  store: string;
  row_id: string;
  raw_value: string | null;
  schema_error: string;
  observed_at: string;
}

export interface StoredQuarantineEntry extends QuarantineEntry {
  quarantineId: string;
}

export class StateValidationQuarantineRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly countStmt;
  private readonly countsByStoreStmt;
  private readonly clearAllStmt;
  private readonly clearStoreStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO state_validation_quarantine (
        quarantine_id, store, row_id, raw_value, schema_error, observed_at
      ) VALUES (@quarantineId, @store, @rowId, @rawValue, @schemaError, @observedAt)
    `);
    this.listStmt = db.prepare(`
      SELECT quarantine_id, store, row_id, raw_value, schema_error, observed_at
      FROM state_validation_quarantine
      ORDER BY observed_at DESC, quarantine_id DESC
      LIMIT ?
    `);
    this.countStmt = db.prepare("SELECT COUNT(1) AS count FROM state_validation_quarantine");
    this.countsByStoreStmt = db.prepare(`
      SELECT store, COUNT(1) AS count
      FROM state_validation_quarantine
      GROUP BY store
    `);
    this.clearAllStmt = db.prepare("DELETE FROM state_validation_quarantine");
    this.clearStoreStmt = db.prepare("DELETE FROM state_validation_quarantine WHERE store = ?");
  }

  public record(entry: QuarantineEntry): StoredQuarantineEntry {
    const quarantineId = randomUUID();
    this.insertStmt.run({
      quarantineId,
      store: entry.store,
      rowId: entry.rowId,
      rawValue: entry.rawValue ?? null,
      schemaError: entry.schemaError,
      observedAt: entry.observedAt,
    });
    return { ...entry, quarantineId };
  }

  public list(limit: number): StoredQuarantineEntry[] {
    const rows = this.listStmt.all(Math.max(1, Math.floor(limit))) as QuarantineRow[];
    return rows.map(mapRow);
  }

  public count(): number {
    const row = this.countStmt.get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public countsByStore(): Array<{ store: string; count: number }> {
    const rows = this.countsByStoreStmt.all() as Array<{ store: string; count: number | bigint }>;
    return rows.map((row) => ({ store: row.store, count: Number(row.count) }));
  }

  public clear(store?: string): number {
    if (store === undefined) {
      const result = this.clearAllStmt.run();
      return Number(result.changes ?? 0);
    }
    const result = this.clearStoreStmt.run(store);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: QuarantineRow): StoredQuarantineEntry {
  return {
    quarantineId: row.quarantine_id,
    store: row.store,
    rowId: row.row_id,
    rawValue: row.raw_value,
    schemaError: row.schema_error,
    observedAt: row.observed_at,
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern StateValidationQuarantineRepository`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/state-validation-quarantine-repo.ts packages/storage/src/state-validation-quarantine-repo.test.ts
git commit -m "Add StateValidationQuarantineRepository"
```

---

## Task 6: Storage — plumb quarantine through `Storage` facade

**Files:**
- Modify: `packages/storage/src/index.ts`

- [ ] **Step 1: Add the import and field**

Open `packages/storage/src/index.ts`. Find the imports block near the top. Add (alphabetical placement after `SkillEvaluationRunRepository` or wherever fits):

```ts
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
```

Also re-export the helper and types so callers can use them:

```ts
export { loadAndSanitize } from "./load-and-sanitize.js";
export type { QuarantineEntry, SafeParse, SafeParseResult } from "./load-and-sanitize.js";
export { parseJsonObject, parseJsonArray, parseStringRecord } from "./state-validators.js";
export { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
export type { StoredQuarantineEntry } from "./state-validation-quarantine-repo.js";
```

Find the `Storage` class declaration. Add a public field near the other repo fields:

```ts
public readonly stateValidationQuarantine: StateValidationQuarantineRepository;
```

In the constructor, after the other `new ...Repository(this.db)` lines:

```ts
this.stateValidationQuarantine = new StateValidationQuarantineRepository(this.db);
```

- [ ] **Step 2: Typecheck storage and gateway**

Run: `pnpm --filter @goatcitadel/storage typecheck && pnpm --filter @goatcitadel/gateway typecheck`
Expected: PASS.

- [ ] **Step 3: Run storage tests**

Run: `pnpm --filter @goatcitadel/storage test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/storage/src/index.ts
git commit -m "Expose state-validation quarantine on Storage facade"
```

---

## Task 7: Storage — `DurableRunRepository.pruneCheckpoints` (TDD)

**Files:**
- Modify: `packages/storage/src/durable-run-repo.ts`
- Modify: `packages/storage/src/durable-run-repo.test.ts`

The method drops checkpoints whose parent run doesn't exist (orphans), caps per-run checkpoint count, and respects a disk budget by pruning oldest checkpoints across **terminal** runs. Active (non-terminal) run checkpoints are never pruned even over budget.

- [ ] **Step 1: Write failing tests**

Open `packages/storage/src/durable-run-repo.test.ts`. Append (note the existing `describe("DurableRunRepository", ...)` block — add these inside it after the last existing `it()`):

```ts
  describe("pruneCheckpoints", () => {
    it("removes orphan checkpoints whose run was deleted", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      repo.createCheckpoint({
        runId: run.runId,
        checkpointKind: "run_created",
        state: { step: 1 },
      });
      // Force-orphan: directly write a checkpoint pointing at a non-existent run
      const dbForOrphan = (repo as unknown as { db: { prepare: (sql: string) => { run: (args: Record<string, unknown>) => void } } }).db;
      dbForOrphan
        .prepare(
          "INSERT INTO durable_checkpoints (checkpoint_id, run_id, checkpoint_kind, state_json, created_at) VALUES (@id, @runId, @kind, @state, @at)",
        )
        .run({
          id: "orphan-1",
          runId: "no-such-run",
          kind: "run_created",
          state: "{}",
          at: "2026-05-15T00:00:00.000Z",
        });

      const summary = repo.pruneCheckpoints({ keepPerRun: 50, diskBudgetBytes: 1024 * 1024 });
      assert.equal(summary.prunedOrphans, 1);
      assert.equal(summary.prunedAged, 0);
      assert.equal(repo.listCheckpoints(run.runId, 100).length, 1);
    });

    it("keeps at most keepPerRun checkpoints per terminal run, pruning oldest", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      for (let i = 0; i < 5; i += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: { step: i },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
      }
      repo.updateRun({
        runId: run.runId,
        status: "completed",
        finishedAt: "2026-05-15T00:00:00.000Z",
        expectedVersion: run.version,
      });

      const summary = repo.pruneCheckpoints({ keepPerRun: 2, diskBudgetBytes: 1024 * 1024 });
      assert.equal(summary.prunedAged, 3);
      const remaining = repo.listCheckpoints(run.runId, 100);
      assert.equal(remaining.length, 2);
      // Oldest pruned, newest kept
      assert.equal((remaining[0].state as { step: number }).step, 3);
      assert.equal((remaining[1].state as { step: number }).step, 4);
    });

    it("never prunes active (non-terminal) run checkpoints even when over budget", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      for (let i = 0; i < 10; i += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: { step: i, big: "x".repeat(1024) },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
      }
      // Run stays "queued" — non-terminal

      const summary = repo.pruneCheckpoints({ keepPerRun: 2, diskBudgetBytes: 10 });
      assert.equal(summary.prunedAged, 0);
      assert.equal(repo.listCheckpoints(run.runId, 100).length, 10);
    });

    it("prunes oldest across terminal runs to fit disk budget", () => {
      const repo = createRepo();
      const runA = repo.createRun({ workflowKey: "test.a" });
      const runB = repo.createRun({ workflowKey: "test.b" });
      for (let i = 0; i < 5; i += 1) {
        repo.createCheckpoint({
          runId: runA.runId,
          checkpointKind: "run_started",
          state: { run: "A", step: i, pad: "x".repeat(200) },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
        repo.createCheckpoint({
          runId: runB.runId,
          checkpointKind: "run_started",
          state: { run: "B", step: i, pad: "y".repeat(200) },
          createdAt: new Date(2026, 1, 1, i).toISOString(),
        });
      }
      repo.updateRun({ runId: runA.runId, status: "completed", finishedAt: "2026-05-15T00:00:00.000Z", expectedVersion: runA.version });
      repo.updateRun({ runId: runB.runId, status: "completed", finishedAt: "2026-05-15T00:00:00.000Z", expectedVersion: runB.version });

      const summary = repo.pruneCheckpoints({ keepPerRun: 100, diskBudgetBytes: 1024 });
      assert.ok(summary.prunedAged > 0, "should prune to fit disk budget");
      assert.ok(summary.finalBytes <= 1024 + 250, "final bytes should be at or under budget+headroom");
    });

    it("returns zero counts when nothing to prune", () => {
      const repo = createRepo();
      const summary = repo.pruneCheckpoints({ keepPerRun: 50, diskBudgetBytes: 1024 });
      assert.equal(summary.prunedOrphans, 0);
      assert.equal(summary.prunedAged, 0);
      assert.equal(summary.finalBytes, 0);
    });
  });
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern pruneCheckpoints`
Expected: FAIL (`repo.pruneCheckpoints is not a function`).

- [ ] **Step 3: Implement `pruneCheckpoints`**

Open `packages/storage/src/durable-run-repo.ts`.

Add a return type near the other type interfaces at the top of the file:

```ts
export interface PruneCheckpointsResult {
  prunedOrphans: number;
  prunedAged: number;
  finalBytes: number;
  diskBudgetBytes: number;
}
```

In the `DurableRunRepository` class, add the public method (place it after `listCheckpoints` or near related checkpoint methods). The implementation:

```ts
public pruneCheckpoints(input: { keepPerRun: number; diskBudgetBytes: number }): PruneCheckpointsResult {
  const keepPerRun = Math.max(1, Math.floor(input.keepPerRun));
  const diskBudgetBytes = Math.max(0, Math.floor(input.diskBudgetBytes));

  const orphanRows = this.db
    .prepare(`
      SELECT cp.checkpoint_id AS checkpointId
      FROM durable_checkpoints cp
      LEFT JOIN durable_runs r ON r.run_id = cp.run_id
      WHERE r.run_id IS NULL
    `)
    .all() as Array<{ checkpointId: string }>;

  const deleteByIdStmt = this.db.prepare("DELETE FROM durable_checkpoints WHERE checkpoint_id = ?");
  let prunedOrphans = 0;
  for (const row of orphanRows) {
    const result = deleteByIdStmt.run(row.checkpointId);
    prunedOrphans += Number(result.changes ?? 0);
  }

  const terminalCheckpoints = this.db
    .prepare(`
      SELECT cp.checkpoint_id AS checkpointId,
             cp.run_id AS runId,
             cp.state_json AS stateJson,
             cp.created_at AS createdAt
      FROM durable_checkpoints cp
      INNER JOIN durable_runs r ON r.run_id = cp.run_id
      WHERE r.status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
      ORDER BY cp.run_id ASC, cp.created_at ASC, cp.checkpoint_id ASC
    `)
    .all() as Array<{ checkpointId: string; runId: string; stateJson: string; createdAt: string }>;

  const perRunBuckets = new Map<string, typeof terminalCheckpoints>();
  for (const row of terminalCheckpoints) {
    const bucket = perRunBuckets.get(row.runId) ?? [];
    bucket.push(row);
    perRunBuckets.set(row.runId, bucket);
  }

  let prunedAged = 0;
  const survivingTerminal: typeof terminalCheckpoints = [];
  for (const bucket of perRunBuckets.values()) {
    const overflow = Math.max(0, bucket.length - keepPerRun);
    for (let i = 0; i < overflow; i += 1) {
      const victim = bucket[i];
      const result = deleteByIdStmt.run(victim.checkpointId);
      prunedAged += Number(result.changes ?? 0);
    }
    for (let i = overflow; i < bucket.length; i += 1) {
      survivingTerminal.push(bucket[i]);
    }
  }

  let runningBytes = this.measureCheckpointBytes();
  if (runningBytes > diskBudgetBytes) {
    survivingTerminal.sort((l, r) =>
      l.createdAt === r.createdAt ? l.checkpointId.localeCompare(r.checkpointId) : l.createdAt.localeCompare(r.createdAt),
    );
    for (const victim of survivingTerminal) {
      if (runningBytes <= diskBudgetBytes) {
        break;
      }
      const victimBytes = byteLength(victim.stateJson);
      const result = deleteByIdStmt.run(victim.checkpointId);
      const changes = Number(result.changes ?? 0);
      if (changes > 0) {
        prunedAged += changes;
        runningBytes -= victimBytes;
      }
    }
  }

  return {
    prunedOrphans,
    prunedAged,
    finalBytes: this.measureCheckpointBytes(),
    diskBudgetBytes,
  };
}

private measureCheckpointBytes(): number {
  const row = this.db
    .prepare("SELECT COALESCE(SUM(LENGTH(state_json)), 0) AS bytes FROM durable_checkpoints")
    .get() as { bytes: number | bigint } | undefined;
  return Number(row?.bytes ?? 0);
}
```

Add at the bottom of the file (outside the class) the byte-length helper:

```ts
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
```

- [ ] **Step 4: Verify pruneCheckpoints tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern pruneCheckpoints`
Expected: all 5 cases PASS.

- [ ] **Step 5: Run entire storage suite**

Run: `pnpm --filter @goatcitadel/storage test`
Expected: PASS — no regression in existing durable tests.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/durable-run-repo.ts packages/storage/src/durable-run-repo.test.ts
git commit -m "Add DurableRunRepository.pruneCheckpoints with disk budget"
```

---

## Task 8: Gateway — wire boot resume summary + pruning into `DurableRunService.startWorker`

**Files:**
- Modify: `apps/gateway/src/services/durable-run-service.ts`
- Modify: `apps/gateway/src/services/durable-run-service.test.ts`

`reconcileRecoverableRuns()` already requeues runs with expired leases. We need to (a) count successful reclaims, (b) call `pruneCheckpoints`, (c) populate `lastBootRecovery` state, (d) emit a single boot log line, and (e) expose this state on `getDurableDiagnostics()`.

- [ ] **Step 1: Write failing test for boot summary log + diagnostics**

Append to `apps/gateway/src/services/durable-run-service.test.ts` (inside the existing `describe("DurableRunService", ...)` block):

```ts
  it("emits a boot resume summary and prunes orphan checkpoints on startWorker", async () => {
    const runs = new Map<string, DurableRunRecord>([
      [
        "run-resume-1",
        {
          ...createRun("run-resume-1", "running"),
          leaseOwnerId: "worker-old",
          leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
          leaseExpiresAt: "2026-05-14T23:56:00.000Z",
        },
      ],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const prune = vi.fn(() => ({
      prunedOrphans: 3,
      prunedAged: 5,
      finalBytes: 1024,
      diskBudgetBytes: 67108864,
    }));

    const ctx = createContext(runs, checkpoints, timeline);
    (ctx.storage.durableRuns as unknown as { pruneCheckpoints: typeof prune }).pruneCheckpoints = prune;

    const infoLogs: Array<{ data: unknown; msg: string }> = [];
    (ctx as unknown as { logger?: unknown }).logger = {
      info: (data: unknown, msg: string) => infoLogs.push({ data, msg }),
      warn: () => {},
      debug: () => {},
      error: () => {},
    };

    const service = new DurableRunService(ctx as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {}),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    const diag = service.getDurableDiagnostics();
    assert.ok(diag.lastBootRecovery, "diagnostics should expose lastBootRecovery");
    assert.equal(diag.lastBootRecovery?.resumedCount, 1);
    assert.equal(diag.lastBootRecovery?.prunedOrphanCheckpoints, 3);
    assert.equal(diag.lastBootRecovery?.prunedAgedCheckpoints, 5);
    assert.equal(diag.lastBootRecovery?.finalCheckpointBytes, 1024);
    assert.equal(diag.lastBootRecovery?.diskBudgetBytes, 67108864);

    const resumeLog = infoLogs.find((entry) => entry.msg.includes("resumed after restart"));
    assert.ok(resumeLog, "should emit info log when runs were resumed");
    assert.equal(prune.mock.calls.length, 1);

    service.stopWorker();
  });

  it("emits a debug-level boot log when no runs were resumed", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const prune = vi.fn(() => ({
      prunedOrphans: 0,
      prunedAged: 0,
      finalBytes: 0,
      diskBudgetBytes: 67108864,
    }));

    const ctx = createContext(runs, checkpoints, timeline);
    (ctx.storage.durableRuns as unknown as { pruneCheckpoints: typeof prune }).pruneCheckpoints = prune;
    const infoLogs: string[] = [];
    const debugLogs: string[] = [];
    (ctx as unknown as { logger?: unknown }).logger = {
      info: (_d: unknown, msg: string) => infoLogs.push(msg),
      debug: (_d: unknown, msg: string) => debugLogs.push(msg),
      warn: () => {},
      error: () => {},
    };

    const service = new DurableRunService(ctx as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {}),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    assert.ok(debugLogs.some((m) => m.includes("no durable runs required resume")), "should log debug-only when zero resumed");
    assert.equal(infoLogs.filter((m) => m.includes("resumed after restart")).length, 0);

    service.stopWorker();
  });
```

> Note: this assumes the existing test file has helpers `createContext`, `createRun`. They do — see existing tests at the top of the file. Read them once to confirm the `logger` shape; if `ctx.logger` isn't already used, the test stub above introduces it for this case.

If `createContext` doesn't expose a logger, also extend it (small refactor) to accept an optional logger and pass it through to `DurableRunServiceContext`. The path the production code reads should be `ctx.logger ?? defaultLogger`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @goatcitadel/gateway test -- durable-run-service`
Expected: FAIL — `diag.lastBootRecovery` is undefined; `prune` is never called; no info log emitted.

- [ ] **Step 3: Implement the wiring in `durable-run-service.ts`**

Add near the top of the file (alongside the other constants):

```ts
const DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT = 50;
const DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT = 64 * 1024 * 1024;
```

Add an env-resolved config helper at the bottom of the file:

```ts
function resolveCheckpointPruneConfig(): { keepPerRun: number; diskBudgetBytes: number } {
  const keepRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_KEEP_PER_RUN?.trim();
  const budgetRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_DISK_BUDGET_BYTES?.trim();
  const keepParsed = keepRaw ? Number.parseInt(keepRaw, 10) : Number.NaN;
  const budgetParsed = budgetRaw ? Number.parseInt(budgetRaw, 10) : Number.NaN;
  return {
    keepPerRun: Number.isFinite(keepParsed) && keepParsed > 0 ? keepParsed : DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT,
    diskBudgetBytes: Number.isFinite(budgetParsed) && budgetParsed >= 0
      ? budgetParsed
      : DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT,
  };
}
```

Add a private field on the class for the recovery snapshot:

```ts
private lastBootRecovery: DurableDiagnosticsResponse["lastBootRecovery"];
```

Modify `reconcileRecoverableRuns` to return the number of successful reclaims. The current signature is `private async reconcileRecoverableRuns(): Promise<void>`. Change to `Promise<number>` and accumulate:

```ts
private async reconcileRecoverableRuns(): Promise<number> {
  if (!this.deps) {
    return 0;
  }
  let reclaimedCount = 0;
  const runningRunIds = this.ctx.storage.durableRuns.listExpiredRunningRunIds(new Date().toISOString());
  for (const runId of runningRunIds) {
    const run = this.ctx.storage.durableRuns.getRun(runId);
    this.recordDurableTimelineEvent(run.runId, "run_lease_expired", {
      leaseOwnerId: run.leaseOwnerId,
      leaseExpiresAt: run.leaseExpiresAt,
    });
    const recoverability = this.deps.workflowRegistry.isWorkflowRecoverable(run);
    if (!recoverability.recoverable) {
      await this.failExpiredOrphanedWorkflowRun(
        run,
        recoverability.reason ?? "Run could not be recovered after restart.",
      );
      await this.deps.workflowRegistry.markWorkflowUnrecoverable(
        this.ctx.storage.durableRuns.getRun(run.runId),
        recoverability.reason ?? "Run could not be recovered after restart.",
      );
      continue;
    }
    const reclaimed = this.retryDurableRunUpdate(run.runId, (current) =>
      this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: "queued",
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      }),
    );
    this.recordDurableTimelineEvent(reclaimed.runId, "run_reclaimed", {
      previousLeaseOwnerId: run.leaseOwnerId,
      previousLeaseExpiresAt: run.leaseExpiresAt,
    });
    reclaimedCount += 1;
  }
  return reclaimedCount;
}
```

Update `requestRunProcessing` (which currently calls `await this.reconcileRecoverableRuns();`) — leave it as-is; ignoring the return value during normal worker loop iteration is fine.

Update `startWorker` to capture the boot reclaim count + run pruning:

```ts
startWorker(): void {
  if (!this.isDurableFoundationEnabled() || !this.deps) {
    return;
  }
  this.workerStopped = false;
  void this.performBootRecovery();
  this.ensurePollLoop();
  this.requestRunProcessing();
}

private async performBootRecovery(): Promise<void> {
  if (!this.deps) {
    return;
  }
  const log = this.resolveLogger();
  const resumedCount = await this.reconcileRecoverableRuns();
  const pruneConfig = resolveCheckpointPruneConfig();
  const pruneSummary = this.ctx.storage.durableRuns.pruneCheckpoints(pruneConfig);
  this.lastBootRecovery = {
    observedAt: new Date().toISOString(),
    resumedCount,
    prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
    prunedAgedCheckpoints: pruneSummary.prunedAged,
    finalCheckpointBytes: pruneSummary.finalBytes,
    diskBudgetBytes: pruneSummary.diskBudgetBytes,
  };
  if (resumedCount > 0) {
    log.info(
      {
        resumedCount,
        prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
        prunedAgedCheckpoints: pruneSummary.prunedAged,
        finalCheckpointBytes: pruneSummary.finalBytes,
        diskBudgetBytes: pruneSummary.diskBudgetBytes,
      },
      "durable runs resumed after restart",
    );
  } else {
    log.debug(
      {
        prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
        prunedAgedCheckpoints: pruneSummary.prunedAged,
        finalCheckpointBytes: pruneSummary.finalBytes,
        diskBudgetBytes: pruneSummary.diskBudgetBytes,
      },
      "no durable runs required resume after restart",
    );
  }
}

private resolveLogger(): { info: (data: unknown, msg: string) => void; debug: (data: unknown, msg: string) => void; warn: (data: unknown, msg: string) => void; error: (data: unknown, msg: string) => void } {
  const candidate = (this.ctx as unknown as { logger?: unknown }).logger;
  if (candidate && typeof (candidate as { info?: unknown }).info === "function") {
    return candidate as ReturnType<DurableRunService["resolveLogger"]>;
  }
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  };
}
```

Update `getDurableDiagnostics` to include `lastBootRecovery`:

```ts
getDurableDiagnostics(): DurableDiagnosticsResponse {
  const statusCounts = this.ctx.storage.durableRuns.statusCounts();
  const durableFoundationReady = this.isDurableFoundationEnabled() && Boolean(this.deps?.workflowRegistry);
  return {
    enabled: this.isDurableFoundationEnabled(),
    replayFoundationReady: durableFoundationReady,
    runCount: this.ctx.storage.durableRuns.countRuns(),
    queuedCount: statusCounts.queued ?? 0,
    runningCount: statusCounts.running ?? 0,
    waitingCount: statusCounts.waiting ?? 0,
    failedCount: statusCounts.failed ?? 0,
    deadLetterCount: this.ctx.storage.durableRuns.listDeadLetters(1000).length,
    recentRuns: this.ctx.storage.durableRuns.listRuns(25).map((run) => deriveDurableRunOperationalState(run)),
    recentDeadLetters: this.ctx.storage.durableRuns.listDeadLetters(25),
    ...(this.lastEventLoopLagAt
      ? {
          eventLoopLag: {
            lastMs: this.lastEventLoopLagMs,
            lastObservedAt: this.lastEventLoopLagAt,
            ...(this.leaseAcquisitionPausedUntilMs > Date.now()
              ? { leaseAcquisitionPausedUntil: new Date(this.leaseAcquisitionPausedUntilMs).toISOString() }
              : {}),
          },
        }
      : {}),
    ...(this.lastBootRecovery ? { lastBootRecovery: this.lastBootRecovery } : {}),
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Verify the test passes**

Run: `pnpm --filter @goatcitadel/gateway test -- durable-run-service`
Expected: PASS.

- [ ] **Step 5: Run the full gateway test suite**

Run: `pnpm --filter @goatcitadel/gateway test`
Expected: PASS. If the existing "requeues and resumes recoverable orphaned chat turn runs on worker startup" test asserts a specific call shape that conflicts with the new `performBootRecovery` async flow, adjust the test to `await Promise.all(backgroundTasks)` before assertions if it doesn't already.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/durable-run-service.ts apps/gateway/src/services/durable-run-service.test.ts
git commit -m "Wire boot resume summary + checkpoint pruning into durable-run-service"
```

---

## Task 9: Storage — apply `loadAndSanitize` to `SessionRepository.routing_hints_json`

**Files:**
- Modify: `packages/storage/src/session-repo.ts`
- Modify: `packages/storage/src/session-repo.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/storage/src/session-repo.test.ts` (after the existing tests; if the file doesn't currently set up its own helpers, mirror those in `durable-run-repo.test.ts`):

```ts
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

describe("SessionRepository sanitization", () => {
  it("quarantines a session whose routing_hints_json is malformed and falls back to empty routing hints", () => {
    const dbPath = path.join(os.tmpdir(), `gc-session-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new SessionRepository(db, { quarantine });

    const sessionId = randomUUID();
    // Insert a session, then corrupt its routing_hints_json directly
    repo.upsertSession({
      sessionId,
      sessionKey: `key-${sessionId}`,
      kind: "dm",
      channel: "chat",
      account: "u1",
      timestamp: "2026-05-15T00:00:00.000Z",
    });
    db.prepare("UPDATE sessions SET routing_hints_json = ? WHERE session_id = ?").run("{not json", sessionId);

    const loaded = repo.getById(sessionId);
    assert.equal(loaded?.routingHints, undefined);
    assert.equal(quarantine.count(), 1);
    const entries = quarantine.list(10);
    assert.equal(entries[0].store, "session.routing_hints");
    assert.equal(entries[0].rowId, sessionId);
    assert.match(entries[0].schemaError, /json_parse|schema/);
  });
});
```

> Note: the existing `SessionRepository` constructor probably doesn't accept `{ quarantine }`. The test drives the API: we'll change the constructor to take an options bag.

If `getById` doesn't exist with that name, use the actual method name from `session-repo.ts` (likely `findByKey` or similar — check the file). Adjust assertions to match the actual return shape.

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "SessionRepository sanitization"`
Expected: FAIL (constructor signature mismatch or no quarantine entry recorded).

- [ ] **Step 3: Modify `SessionRepository` to inject quarantine sink + use `loadAndSanitize`**

Open `packages/storage/src/session-repo.ts`.

Add imports at top:

```ts
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseStringRecord } from "./state-validators.js";
```

Change the constructor:

```ts
export interface SessionRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

export class SessionRepository {
  // ...existing prepared-statement fields...

  public constructor(private readonly db: DatabaseClient, private readonly options: SessionRepositoryOptions = {}) {
    // ...existing prepared statements unchanged...
  }
```

Find the `mapSessionRow` or row-mapping helper (likely at the bottom of `session-repo.ts`). The current call is `safeJsonParse<Record<string, string> | undefined>(row.routing_hints_json, undefined)`. Replace with:

```ts
routingHints: loadAndSanitize(row.routing_hints_json, {
  store: "session.routing_hints",
  rowId: row.session_id,
  parse: parseStringRecord,
  onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
  log: this.options.logger,
}, undefined),
```

> Because `mapSessionRow` is currently a free function, you'll either need to convert it to a private method or pass the options through. Simpler: inline the mapping when reading rows in the existing public methods, or accept a `mapper` function passed in. The minimal change is to convert `mapSessionRow` to a method on the class that closes over `this.options`.

- [ ] **Step 4: Update `Storage` facade to construct `SessionRepository` with the quarantine sink**

Open `packages/storage/src/index.ts`. Find `this.sessions = new SessionRepository(this.db);` and change to:

```ts
this.sessions = new SessionRepository(this.db, { quarantine: this.stateValidationQuarantine });
```

(Move this line below the `stateValidationQuarantine` assignment so it's already initialized.)

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "SessionRepository sanitization"`
Expected: PASS.

Run the full session-repo suite:
Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern Session`
Expected: PASS (no regression).

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/session-repo.ts packages/storage/src/session-repo.test.ts packages/storage/src/index.ts
git commit -m "Sanitize session routing_hints_json with loadAndSanitize"
```

---

## Task 10: Storage — apply `loadAndSanitize` in `DurableRunRepository` (payload/metadata/checkpoint state)

**Files:**
- Modify: `packages/storage/src/durable-run-repo.ts`
- Modify: `packages/storage/src/durable-run-repo.test.ts`

The current `DurableRunRepository.mapRunRow` invokes `safeJsonParse` for `payload_json` (falls back to `{}`) and `metadata_json` (falls back to `undefined`). Checkpoint state is similar. Each parse should now route bad rows to quarantine.

- [ ] **Step 1: Write failing tests**

Append to `packages/storage/src/durable-run-repo.test.ts`:

```ts
describe("DurableRunRepository sanitization", () => {
  it("quarantines corrupt payload_json and returns an empty payload", () => {
    const dbPath = path.join(os.tmpdir(), `gc-durable-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new DurableRunRepository(db, { quarantine });

    const run = repo.createRun({ workflowKey: "test.workflow", payload: { ok: true } });
    db.prepare("UPDATE durable_runs SET payload_json = ? WHERE run_id = ?").run("{not json", run.runId);

    const reloaded = repo.getRun(run.runId);
    assert.deepEqual(reloaded.payload, {});
    assert.equal(quarantine.count(), 1);
    assert.equal(quarantine.list(10)[0].store, "durable_run.payload");
    assert.equal(quarantine.list(10)[0].rowId, run.runId);
  });

  it("quarantines corrupt metadata_json and returns undefined metadata", () => {
    const dbPath = path.join(os.tmpdir(), `gc-durable-sanitize-md-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new DurableRunRepository(db, { quarantine });

    const run = repo.createRun({ workflowKey: "test.workflow", metadata: { hint: "x" } });
    db.prepare("UPDATE durable_runs SET metadata_json = ? WHERE run_id = ?").run("[not, json", run.runId);

    const reloaded = repo.getRun(run.runId);
    assert.equal(reloaded.metadata, undefined);
    assert.equal(quarantine.count(), 1);
    assert.equal(quarantine.list(10)[0].store, "durable_run.metadata");
  });

  it("quarantines corrupt checkpoint state_json and yields a placeholder", () => {
    const dbPath = path.join(os.tmpdir(), `gc-checkpoint-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new DurableRunRepository(db, { quarantine });

    const run = repo.createRun({ workflowKey: "test.workflow" });
    const checkpoint = repo.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_started",
      state: { step: 1 },
    });
    db
      .prepare("UPDATE durable_checkpoints SET state_json = ? WHERE checkpoint_id = ?")
      .run("{not json", checkpoint.checkpointId);

    const list = repo.listCheckpoints(run.runId, 10);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].state, {});
    assert.equal(quarantine.count(), 1);
    assert.equal(quarantine.list(10)[0].store, "durable_checkpoint.state");
    assert.equal(quarantine.list(10)[0].rowId, checkpoint.checkpointId);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "DurableRunRepository sanitization"`
Expected: FAIL — constructor signature mismatch, or `payload` returns `undefined` from `safeJsonParse` rather than `{}`, etc.

- [ ] **Step 3: Modify `DurableRunRepository`**

Open `packages/storage/src/durable-run-repo.ts`.

Add imports:

```ts
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";
```

Update the constructor to accept an options bag:

```ts
export interface DurableRunRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

export class DurableRunRepository {
  // ...existing fields...

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: DurableRunRepositoryOptions = {},
  ) {
    // ...existing prepared statements...
  }
```

Find `mapRunRow` (or `toDurableRunRecord` / equivalent). Replace the payload + metadata `safeJsonParse` calls with `loadAndSanitize` calls:

```ts
private mapRunRow(row: DurableRunRow): DurableRunRecord {
  return {
    runId: row.run_id,
    workflowKey: row.workflow_key,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    payload: loadAndSanitize(row.payload_json, {
      store: "durable_run.payload",
      rowId: row.run_id,
      parse: parseJsonObject,
      onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
      log: this.options.logger,
    }, {}) as Record<string, unknown>,
    metadata: loadAndSanitize(row.metadata_json, {
      store: "durable_run.metadata",
      rowId: row.run_id,
      parse: parseJsonObject,
      onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
      log: this.options.logger,
    }, undefined),
    // ...rest of fields unchanged (timestamps, leases, version)...
  };
}
```

If `mapRunRow` is currently a free function: convert it to a private method on the class so it can read `this.options`.

Same change for checkpoint state mapping (find the `mapCheckpointRow` helper or similar). Use `store: "durable_checkpoint.state"`, `rowId: row.checkpoint_id`, `parse: parseJsonObject`, fallback `{}`.

- [ ] **Step 4: Update Storage facade construction**

In `packages/storage/src/index.ts`, find `this.durableRuns = new DurableRunRepository(this.db);` and change to:

```ts
this.durableRuns = new DurableRunRepository(this.db, { quarantine: this.stateValidationQuarantine });
```

Make sure `this.stateValidationQuarantine` is initialized before `this.durableRuns`.

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "DurableRunRepository"`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/durable-run-repo.ts packages/storage/src/durable-run-repo.test.ts packages/storage/src/index.ts
git commit -m "Sanitize durable run payload/metadata/checkpoint state with loadAndSanitize"
```

---

## Task 11: Storage — apply `loadAndSanitize` in `TaskRepository`

**Files:**
- Modify: `packages/storage/src/task-repo.ts`
- Modify: `packages/storage/src/task-repo.test.ts`

Follow the same pattern as Task 10. Identify every JSON column read by `task-repo.ts` (find `safeJsonParse(` calls in the file). For each:

- **store name:** `task.<column>` (e.g. `task.payload`, `task.metadata`)
- **parse:** `parseJsonObject` for objects, `parseJsonArray` for arrays.
- **fallback:** the same fallback the existing `safeJsonParse` call uses (don't change semantics).

- [ ] **Step 1: Inventory the safeJsonParse call sites in task-repo.ts**

Run:
```bash
git grep -n "safeJsonParse" packages/storage/src/task-repo.ts
```

For each call, note: column name, expected shape (object vs array vs scalar), current fallback. Use this to build the schema map.

- [ ] **Step 2: Write a failing test per JSON column**

Append to `packages/storage/src/task-repo.test.ts`:

```ts
describe("TaskRepository sanitization", () => {
  it("quarantines a task whose payload_json is malformed", () => {
    const dbPath = path.join(os.tmpdir(), `gc-task-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new TaskRepository(db, { quarantine });

    // Seed a valid task (use the repo's actual public create method — adjust if name differs)
    const task = repo.create({
      // ...fill required fields per actual TaskRepository.create signature...
    });
    db.prepare("UPDATE tasks SET payload_json = ? WHERE task_id = ?").run("{not json", task.taskId);

    const reloaded = repo.find(task.taskId);
    assert.ok(reloaded, "task should still load with fallback payload");
    assert.equal(quarantine.count(), 1);
    assert.equal(quarantine.list(10)[0].store, "task.payload");
  });
});
```

> Adjust create signature + getter method name to match the actual file. If task has additional JSON columns, repeat the pattern for each.

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "TaskRepository sanitization"`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `packages/storage/src/task-repo.ts`:
- Add the same imports + `TaskRepositoryOptions` pattern from Task 10.
- Replace each `safeJsonParse(row.X_json, fallback)` with the matching `loadAndSanitize(row.X_json, { store: "task.X", rowId: row.task_id, parse: <parser>, onQuarantine: ..., log: ... }, fallback)`.
- Plumb the options into `Storage` facade construction in `index.ts`.

- [ ] **Step 5: Verify tests pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "TaskRepository"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/task-repo.ts packages/storage/src/task-repo.test.ts packages/storage/src/index.ts
git commit -m "Sanitize task repository JSON columns with loadAndSanitize"
```

---

## Task 12: Storage — apply `loadAndSanitize` in `CronJobRepository`

**Files:**
- Modify: `packages/storage/src/cron-job-repo.ts`
- Modify: `packages/storage/src/cron-job-repo.test.ts`

Same TDD pattern as Task 11. Cron jobs notably store `payload_json`, `result_json`, possibly `action_config_json` (added in migration 78).

- [ ] **Step 1: Inventory safeJsonParse calls**

Run: `git grep -n "safeJsonParse" packages/storage/src/cron-job-repo.ts`

- [ ] **Step 2: Write tests, one per JSON column**

Each test:
- Insert a valid cron job through the repo
- Corrupt the JSON column directly via SQL
- Read it back; assert the column falls back to its default value AND quarantine has one entry with `store: "cron_job.<column>"`, `rowId: <cronJobId>`.

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "CronJobRepository sanitization"`
Expected: FAIL.

- [ ] **Step 4: Implement**

Apply the same pattern: imports + options bag + replace each `safeJsonParse` call with `loadAndSanitize`. Plumb the quarantine sink through `index.ts`.

- [ ] **Step 5: Verify pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "CronJobRepository"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/cron-job-repo.ts packages/storage/src/cron-job-repo.test.ts packages/storage/src/index.ts
git commit -m "Sanitize cron job repository JSON columns with loadAndSanitize"
```

---

## Task 13: Storage — apply `loadAndSanitize` in `ChatMessageRepository`

**Files:**
- Modify: `packages/storage/src/chat-message-repo.ts`
- Modify: `packages/storage/src/chat-message-repo.test.ts`

Chat messages typically have a JSON array of content blocks plus tool args.

- [ ] **Step 1: Inventory**

Run: `git grep -n "safeJsonParse" packages/storage/src/chat-message-repo.ts`

- [ ] **Step 2: Write failing tests** for each JSON column. Use `parseJsonArray` for array columns, `parseJsonObject` for object columns.

- [ ] **Step 3: Verify failure**

- [ ] **Step 4: Implement** following the established pattern.

- [ ] **Step 5: Verify pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "ChatMessageRepository"`

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/chat-message-repo.ts packages/storage/src/chat-message-repo.test.ts packages/storage/src/index.ts
git commit -m "Sanitize chat message repository JSON columns with loadAndSanitize"
```

---

## Task 14: Storage — apply `loadAndSanitize` in `TranscriptLog` (JSONL row skip)

**Files:**
- Modify: `packages/storage/src/transcript-log.ts`
- Modify: `packages/storage/src/transcript-log.test.ts`

`transcript-log` is the only repo in the named list that's JSONL-backed (line-oriented), not column-oriented. The behavior change: when reading a transcript file, a row that fails to parse should be **skipped + quarantined**, not crash the read.

- [ ] **Step 1: Locate the transcript read path**

Run: `git grep -n "JSON.parse\|safeJsonParse" packages/storage/src/transcript-log.ts`

Identify where each JSONL line is parsed.

- [ ] **Step 2: Write a failing test**

Append to `packages/storage/src/transcript-log.test.ts`:

```ts
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

describe("TranscriptLog sanitization", () => {
  it("skips and quarantines a malformed JSONL row instead of crashing", async () => {
    const transcriptsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gc-transcript-sanitize-"));
    createdFiles.push(transcriptsDir);
    const dbPath = path.join(transcriptsDir, "db.sqlite");
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const log = new TranscriptLog({ transcriptsDir, quarantine });

    // Write a transcript file with one valid line, one malformed line, one valid line
    const sessionId = "session-sanitize";
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.jsonl`);
    await fs.promises.writeFile(
      transcriptPath,
      [
        JSON.stringify({ eventId: "e1", actor: { type: "user", id: "u" }, occurredAt: "2026-05-15T00:00:00Z" }),
        "{not json",
        JSON.stringify({ eventId: "e2", actor: { type: "assistant", id: "a" }, occurredAt: "2026-05-15T00:00:01Z" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = await log.readSession(sessionId);
    assert.equal(events.length, 2);
    assert.equal(events[0].eventId, "e1");
    assert.equal(events[1].eventId, "e2");
    assert.equal(quarantine.count(), 1);
    assert.equal(quarantine.list(10)[0].store, "transcript.jsonl");
    assert.match(quarantine.list(10)[0].rowId, new RegExp(sessionId));
  });
});
```

> If `TranscriptLog` constructor doesn't accept `{ quarantine }`, the test drives that change. If the public read method has a different name than `readSession`, replace.

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "TranscriptLog sanitization"`
Expected: FAIL.

- [ ] **Step 4: Implement**

Modify `TranscriptLog`:
- Add `quarantine?: { record(entry): unknown }` to constructor options.
- In the line-parsing loop, replace direct `JSON.parse(line)` with try/catch. On catch, call `quarantine?.record(...)` with `store: "transcript.jsonl"`, `rowId: \`${sessionId}:line-${lineNumber}\``, `rawValue: line`, `schemaError: error.message`, `observedAt: now()`. Continue to the next line.

- [ ] **Step 5: Verify pass**

Run: `pnpm --filter @goatcitadel/storage test --test-name-pattern "TranscriptLog"`
Expected: PASS.

- [ ] **Step 6: Plumb quarantine through `Storage` constructor**

In `index.ts`, when `transcripts` is constructed (likely inside the `Storage` constructor's transcript-log section), pass `{ quarantine: this.stateValidationQuarantine }`.

- [ ] **Step 7: Commit**

```bash
git add packages/storage/src/transcript-log.ts packages/storage/src/transcript-log.test.ts packages/storage/src/index.ts
git commit -m "Skip and quarantine malformed transcript JSONL rows"
```

---

## Task 15: Storage — apply `loadAndSanitize` in remaining repos (batched)

**Repos to update:**
- `realtime-stream-lease-repo.ts` (state_json) — use `parseJsonObject`, fallback `{}`
- `idempotency-repo.ts` (response_json) — use `parseJsonObject`, fallback `null` (this repo can legitimately store `null` responses, so accept anything that's not a structural failure)
- `pending-approval-action-repo.ts` (payload_json) — use `parseJsonObject`, fallback `{}`

For each repo, repeat the same TDD cycle as Tasks 11-13:

- [ ] **Step 1: Inventory `safeJsonParse` calls** in each file.
- [ ] **Step 2: Write a corrupt-row test** that:
  - Inserts a row
  - Corrupts the JSON column via SQL
  - Reads back and asserts fallback + quarantine entry with appropriate `store` name (`realtime_stream_lease.state`, `idempotency.response`, `pending_approval_action.payload`)
- [ ] **Step 3: Verify each test fails**.
- [ ] **Step 4: Implement** options bag + `loadAndSanitize` swap.
- [ ] **Step 5: Plumb quarantine through `Storage` facade** in `index.ts`.
- [ ] **Step 6: Verify each test passes**.

Suggested single commit for the batch:

```bash
git add packages/storage/src/realtime-stream-lease-repo.ts packages/storage/src/realtime-stream-lease-repo.test.ts \
       packages/storage/src/idempotency-repo.ts packages/storage/src/idempotency-repo.test.ts \
       packages/storage/src/pending-approval-action-repo.ts packages/storage/src/pending-approval-action-repo.test.ts \
       packages/storage/src/index.ts
git commit -m "Sanitize realtime-lease, idempotency, pending-approval JSON columns"
```

After this commit run the full storage suite once:

Run: `pnpm --filter @goatcitadel/storage test`
Expected: PASS.

---

## Task 16: Doctor — `state.validation.quarantine` check

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts`
- Modify: `apps/gateway/src/doctor/engine.test.ts`

Doctor needs a check that surfaces quarantine activity at warn (>0, <100 entries) and fail (>=100). The check must reach the gateway's storage via the existing health probe path.

- [ ] **Step 1: Locate doctor probe pattern**

Run: `git grep -n "gatewayBaseUrl\|gatewayHealth" apps/gateway/src/doctor/engine.ts | head -20`

The doctor uses an HTTP probe pattern (`fetch` to `gatewayBaseUrl`). We need a route that returns quarantine counts. The simplest path: extend the existing `/api/v1/durable/diagnostics` or `/api/v1/dev/diagnostics` route to include `stateValidationQuarantine: { totalCount, countsByStore }`. If a dedicated diagnostics route doesn't already exist for this, the doctor can fall back to a SQLite read via `runOptions.rootDir`. Pick the route-based approach for parity with other deep checks; the doctor lives in `apps/gateway`, so it can import storage directly via `runtime-schema` or just open a read-only SQLite handle. Look at `checkDeepRuntime` for the existing pattern.

For the minimum-viable path: open the SQLite database directly in the doctor check (it's already in the gateway codebase). Pattern after `checkStoragePaths`.

- [ ] **Step 2: Write failing test**

Append to `apps/gateway/src/doctor/engine.test.ts`:

```ts
describe("state validation quarantine check", () => {
  it("passes when quarantine is empty", async () => {
    const rootDir = await createDoctorFixture();
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    assert.ok(check);
    expect(check?.status).toBe("pass");
  });

  it("warns when 1-99 quarantine entries exist", async () => {
    const rootDir = await createDoctorFixture();
    await seedQuarantine(rootDir, 5);
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("5");
  });

  it("fails when 100+ entries exist", async () => {
    const rootDir = await createDoctorFixture();
    await seedQuarantine(rootDir, 105);
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    expect(check?.status).toBe("fail");
  });
});

async function seedQuarantine(rootDir: string, count: number): Promise<void> {
  // Open the SQLite db that runDoctor will read and insert `count` rows
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(rootDir, "data", "goatcitadel.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_validation_quarantine (
      quarantine_id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      row_id TEXT NOT NULL,
      raw_value TEXT,
      schema_error TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )
  `);
  const stmt = db.prepare(
    "INSERT INTO state_validation_quarantine (quarantine_id, store, row_id, raw_value, schema_error, observed_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < count; i += 1) {
    stmt.run(`q-${i}`, "test", `r-${i}`, null, "schema: x", "2026-05-15T00:00:00.000Z");
  }
  db.close();
}
```

> If the doctor reads the DB from a different path than `data/goatcitadel.db`, update accordingly. Inspect `assistant.config.json`'s `dataDir` field used by `createDoctorFixture`.

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @goatcitadel/gateway test -- doctor/engine`
Expected: FAIL (check not found / wrong status).

- [ ] **Step 4: Implement the check**

In `apps/gateway/src/doctor/engine.ts`, after `checkStoragePaths` (line ~99 area), add a new check:

```ts
checks.push(await checkStateValidationQuarantine(context));
```

Add the function body:

```ts
async function checkStateValidationQuarantine(context: DoctorRuntimeContext): Promise<DoctorCheckResult> {
  const id = "state.validation.quarantine";
  const assistantPath = path.join(context.configDir, "assistant.config.json");
  const assistantState = await readJsonFile<{ dataDir?: string }>(assistantPath);
  const dataDir = (assistantState.valid && asString(assistantState.value?.dataDir)) || path.join(context.rootDir, "data");
  const dbPath = path.join(dataDir, "goatcitadel.db");

  if (!existsSync(dbPath)) {
    return {
      id,
      group: "storage",
      title: "Persisted-state validation quarantine",
      status: "pass",
      severity: "info",
      detail: "Storage database not initialized; no quarantine to inspect.",
      repairable: false,
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_validation_quarantine'")
      .get();
    if (!tableRow) {
      return {
        id,
        group: "storage",
        title: "Persisted-state validation quarantine",
        status: "pass",
        severity: "info",
        detail: "Quarantine table not yet present.",
        repairable: false,
      };
    }

    const totalRow = db.prepare("SELECT COUNT(1) AS count FROM state_validation_quarantine").get() as { count: number | bigint } | undefined;
    const total = Number(totalRow?.count ?? 0);
    const byStoreRows = db
      .prepare("SELECT store, COUNT(1) AS count FROM state_validation_quarantine GROUP BY store ORDER BY count DESC LIMIT 5")
      .all() as Array<{ store: string; count: number | bigint }>;

    if (total === 0) {
      return {
        id,
        group: "storage",
        title: "Persisted-state validation quarantine",
        status: "pass",
        severity: "info",
        detail: "No persisted-state shape failures recorded.",
        repairable: false,
      };
    }

    const topStores = byStoreRows.map((r) => `${r.store}=${Number(r.count)}`).join(", ");
    const severity: DoctorSeverity = total >= 100 ? "error" : "warning";
    const status: DoctorStatus = total >= 100 ? "fail" : "warn";
    return {
      id,
      group: "storage",
      title: "Persisted-state validation quarantine",
      status,
      severity,
      detail: `${total} persisted rows quarantined for shape failures (top: ${topStores}). Run 'doctor --fix' after review.`,
      repairable: false,
    };
  } finally {
    db.close();
  }
}
```

> `DoctorStatus` and `DoctorSeverity` are imported at the top of the file; confirm by reading the existing imports.

- [ ] **Step 5: Verify pass**

Run: `pnpm --filter @goatcitadel/gateway test -- doctor/engine`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.test.ts
git commit -m "Surface state-validation quarantine in doctor"
```

---

## Task 17: Integration — end-to-end boot recovery test

**Files:**
- Create: `apps/gateway/src/services/durable-run-service.boot-recovery.integration.test.ts`

This single integration test exercises the upstream "Verification" stanza from the task spec: pre-seed an interrupted run + an orphan checkpoint + a corrupt session row, call `startWorker`, assert all three signals.

- [ ] **Step 1: Write the integration test**

Create `apps/gateway/src/services/durable-run-service.boot-recovery.integration.test.ts`:

```ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("DurableRunService boot recovery integration", () => {
  it("resumes interrupted runs, prunes orphan checkpoints, and skips corrupt session rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-boot-recovery-"));
    createdRoots.push(root);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const transcriptsDir = path.join(dataDir, "transcripts");
    const auditDir = path.join(dataDir, "audit");
    fs.mkdirSync(transcriptsDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });
    const dbPath = path.join(dataDir, "goatcitadel.db");

    const storage = new Storage({ dbPath, transcriptsDir, auditDir });

    // 1) Seed an interrupted run with an expired lease (simulates SIGTERM mid-execution)
    const interruptedRun = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
      leaseOwnerId: "worker-old",
      leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
      leaseExpiresAt: "2026-05-14T23:56:00.000Z",
    });

    // 2) Insert an orphan checkpoint (run_id does not exist)
    (storage as unknown as { db: { prepare: (sql: string) => { run: (args: Record<string, unknown>) => void } } }).db
      .prepare(
        "INSERT INTO durable_checkpoints (checkpoint_id, run_id, checkpoint_kind, state_json, created_at) VALUES (@id, @runId, @kind, @state, @at)",
      )
      .run({
        id: "orphan-cp-1",
        runId: "no-such-run",
        kind: "run_created",
        state: "{}",
        at: "2026-05-15T00:00:00.000Z",
      });

    // 3) Seed a session with a corrupt routing_hints_json
    storage.sessions.upsertSession({
      sessionId: "session-corrupt",
      sessionKey: "key-corrupt",
      kind: "dm",
      channel: "chat",
      account: "user",
      timestamp: "2026-05-15T00:00:00.000Z",
    });
    (storage as unknown as { db: { prepare: (sql: string) => { run: (args: unknown[]) => void } } }).db
      .prepare("UPDATE sessions SET routing_hints_json = ? WHERE session_id = ?")
      .run(["{not json", "session-corrupt"]);

    // Build the service against this storage
    const infoLogs: Array<{ data: unknown; msg: string }> = [];
    const ctx = buildIntegrationCtx(storage, infoLogs);
    const service = new DurableRunService(ctx, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {}),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    // 4) Boot the worker (this is what startup does)
    service.startWorker();
    // Wait for the boot recovery promise to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 5) Assert the resume log
    const resumeLog = infoLogs.find((entry) => entry.msg.includes("resumed after restart"));
    expect(resumeLog).toBeDefined();

    // 6) Assert the diagnostics shape
    const diag = service.getDurableDiagnostics();
    expect(diag.lastBootRecovery?.resumedCount).toBe(1);
    expect(diag.lastBootRecovery?.prunedOrphanCheckpoints).toBeGreaterThanOrEqual(1);

    // 7) Assert the corrupt session was quarantined
    expect(storage.stateValidationQuarantine.count()).toBeGreaterThanOrEqual(1);

    // 8) Assert the interrupted run is back in queued state
    const reclaimed = storage.durableRuns.getRun(interruptedRun.runId);
    expect(reclaimed.status).toBe("queued");

    service.stopWorker();
    storage.close();
  });
});

function buildIntegrationCtx(storage: Storage, infoLogs: Array<{ data: unknown; msg: string }>): ServiceContext {
  return {
    storage,
    config: {
      assistant: {
        durable: { enabled: true, workflowTimeoutMs: 30_000 },
        mesh: { nodeId: "test-node" },
      },
    },
    publishRealtime: () => {},
    requireFeatureEnabled: () => {},
    logger: {
      info: (data: unknown, msg: string) => infoLogs.push({ data, msg }),
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as ServiceContext;
}
```

> If `Storage.close()` doesn't exist, omit it. If the `Storage` constructor signature differs from `{ dbPath, transcriptsDir, auditDir }`, check `index.ts` `StorageOptions` and adjust.

- [ ] **Step 2: Verify pass**

Run: `pnpm --filter @goatcitadel/gateway test -- boot-recovery.integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/services/durable-run-service.boot-recovery.integration.test.ts
git commit -m "Add end-to-end boot recovery integration test"
```

---

## Task 18: Final verification

- [ ] **Step 1: Full workspace typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Full workspace tests**

Run: `pnpm test`
Expected: PASS across all packages.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS (no new errors).

- [ ] **Step 4: Migration parity**

Run: `pnpm verify:storage:migration-parity`
Expected: PASS.

- [ ] **Step 5: Push branch**

```bash
git push -u origin feature/durability-checkpoints-v2-state-validators
```

- [ ] **Step 6: Open PR**

Use `gh pr create --title "..." --body "..."` with:
- **Title** (≤ 70 chars): `Ship checkpoints v2 + persisted-state validators`
- **Body** linking the spec file and listing the three verification scenarios from the spec.

---

## Notes for the implementer

- **Don't refactor opportunistically.** Each repo's edits should be the minimum: imports, options bag, swap `safeJsonParse` for `loadAndSanitize`. Leave the surrounding mapper functions untouched.
- **If `mapXxxRow` is a free function**, the minimal conversion is to inline it as a private method. Don't introduce a `MapperContext` parameter pattern across the file unless it's already there.
- **Watch for `Storage` facade ordering.** Repos that need `stateValidationQuarantine` must be constructed after `this.stateValidationQuarantine = new ...`. Move lines if necessary.
- **Postgres tests run separately** (`test:postgres`). For this PR we don't need to wire quarantine into the Postgres-backed paths beyond the migration. If a real-postgres test fails in CI, gate the helper behind a Postgres-aware repo construction in a follow-up.
- **Don't add `console.log`.** Use the injected logger or skip logging.
- **`safeJsonParse` stays.** Don't delete it; it's still valid for callers that don't have a meaningful shape to validate. Most callsites get migrated; the helper is the right tool when shape doesn't matter.
- **If the existing `requeues and resumes` durable-run-service test breaks** because boot recovery is now async, await the `backgroundTasks` set in the test, or use `service["performBootRecovery"]?.()` directly to assert behavior synchronously.
- **Config file readers (`doctor/engine.ts`, `config.ts`) are not migrated** in this PR. The existing `readJsonFile` already returns `{ valid: false, error }` on parse failure, so config files don't poison runtime state — they just produce reportable warnings. Tightening their shape validation against zod schemas is a follow-up. The spec lists them under "what changes" but the high-value gap is in DB-backed columns, which this PR closes.
