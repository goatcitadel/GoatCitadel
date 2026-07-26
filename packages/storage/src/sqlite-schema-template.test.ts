import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";

/**
 * The schema template is an opt-in test accelerator: replaying the migration
 * registry costs roughly 600ms per database and this suite creates about 1,200 of
 * them. A database seeded from the template has to be indistinguishable from one
 * that migrated normally, and it must never carry another database's rows.
 */
const createdPaths: string[] = [];
const openClients: DatabaseClient[] = [];

after(() => {
  for (const client of openClients) {
    try {
      client.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  for (const dbPath of createdPaths) {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

function openFreshDatabase(): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-schema-template-${randomUUID()}.db`);
  createdPaths.push(dbPath);
  const client = createDatabase({ dbPath });
  openClients.push(client);
  return client;
}

function readLedger(client: DatabaseClient): string[] {
  const rows = client.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as unknown as {
    version: number;
    name: string;
  }[];
  return rows.map((row) => `${row.version}:${row.name}`);
}

function readSchemaObjects(client: DatabaseClient): string[] {
  const rows = client
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC")
    .all() as unknown as { type: string; name: string }[];
  return rows.map((row) => `${row.type}:${row.name}`);
}

describe("sqlite schema template", () => {
  it("produces the same ledger and schema as a fully migrated database", () => {
    const previous = process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
    delete process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
    const migrated = openFreshDatabase();
    const migratedLedger = readLedger(migrated);
    const migratedSchema = readSchemaObjects(migrated);

    process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = "1";
    try {
      // The first call captures the template; the second is seeded from it.
      const captured = openFreshDatabase();
      const seeded = openFreshDatabase();

      assert.deepEqual(readLedger(captured), migratedLedger);
      assert.deepEqual(readLedger(seeded), migratedLedger);
      assert.deepEqual(readSchemaObjects(captured), migratedSchema);
      assert.deepEqual(readSchemaObjects(seeded), migratedSchema);
      assert.ok(migratedLedger.length > 0, "the migration registry should not be empty");
    } finally {
      if (previous === undefined) {
        delete process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
      } else {
        process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = previous;
      }
    }
  });

  it("never copies the file template to SQLite's in-memory or temporary locations", () => {
    const previous = process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
    const previousCwd = process.cwd();
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-schema-template-memory-"));
    process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = "1";
    try {
      process.chdir(scratchDir);
      for (const dbPath of [":memory:", "", `file:goatcitadel-template-${randomUUID()}?cache=shared&mode=memory`]) {
        const client = createDatabase({ dbPath });
        const workspaceIds = (
          client.prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id ASC").all() as unknown as {
            workspace_id: string;
          }[]
        ).map((row) => row.workspace_id);
        assert.deepEqual(workspaceIds, ["default"]);
        client.close();
      }
      assert.deepEqual(
        fs.readdirSync(scratchDir),
        [],
        "ephemeral databases must not create literal SQLite-location files",
      );
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
      } else {
        process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = previous;
      }
    }
  });

  it("never carries one database's rows into the next", () => {
    const previous = process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
    process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = "1";
    try {
      const first = openFreshDatabase();
      first
        .prepare("INSERT INTO workspaces (workspace_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(
          "workspace-template-probe",
          "template probe",
          "template-probe",
          "2026-07-25T00:00:00.000Z",
          "2026-07-25T00:00:00.000Z",
        );

      const second = openFreshDatabase();
      const rows = second.prepare("SELECT workspace_id FROM workspaces").all() as unknown as { workspace_id: string }[];
      const ids = rows.map((row) => row.workspace_id);

      // The migrations seed a default workspace, so a fresh database is not empty.
      // What matters is that nothing the previous caller wrote comes across.
      assert.equal(
        ids.includes("workspace-template-probe"),
        false,
        "a templated database must not inherit the previous database's rows",
      );
      assert.deepEqual(ids, ["default"], "a templated database must hold only what the migrations seed");
    } finally {
      if (previous === undefined) {
        delete process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
      } else {
        process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = previous;
      }
    }
  });

  it("leaves an existing database alone", () => {
    const previous = process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
    process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = "1";
    try {
      const dbPath = path.join(os.tmpdir(), `goatcitadel-schema-template-reopen-${randomUUID()}.db`);
      createdPaths.push(dbPath);
      const first = createDatabase({ dbPath });
      openClients.push(first);
      first
        .prepare("INSERT INTO workspaces (workspace_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("workspace-reopen", "reopen", "workspace-reopen", "2026-07-25T00:00:00.000Z", "2026-07-25T00:00:00.000Z");
      first.close();

      const reopened = createDatabase({ dbPath });
      openClients.push(reopened);
      const rows = reopened.prepare("SELECT workspace_id FROM workspaces").all() as unknown as {
        workspace_id: string;
      }[];

      assert.ok(
        rows.map((row) => row.workspace_id).includes("workspace-reopen"),
        "reopening a database must not overwrite it with the template",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE;
      } else {
        process.env.GOATCITADEL_SQLITE_SCHEMA_TEMPLATE = previous;
      }
    }
  });

  it("removes only its owned schema-template directory when the process exits", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-schema-template-exit-"));
    try {
      const currentModulePath = fileURLToPath(import.meta.url);
      const sqliteModulePath = path.join(path.dirname(currentModulePath), `sqlite${path.extname(currentModulePath)}`);
      const childScript = `
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { createDatabase } = await import(process.env.GC_SQLITE_TEMPLATE_MODULE_URL);
        const root = process.env.GC_SQLITE_TEMPLATE_TEST_ROOT;
        const ephemeral = createDatabase({ dbPath: ":memory:" });
        ephemeral.close();
        const first = createDatabase({ dbPath: path.join(root, "first.db") });
        first.close();
        const ownedDirectories = fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("goatcitadel-schema-template-"));
        if (ownedDirectories.length !== 1) {
          throw new Error("A temporary first database must not disable later disk-template capture");
        }
        const second = createDatabase({ dbPath: path.join(root, "second.db") });
        second.close();
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
        cwd: path.dirname(sqliteModulePath),
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          GOATCITADEL_SQLITE_SCHEMA_TEMPLATE: "1",
          GC_SQLITE_TEMPLATE_MODULE_URL: pathToFileURL(sqliteModulePath).href,
          GC_SQLITE_TEMPLATE_TEST_ROOT: tempRoot,
          TEMP: tempRoot,
          TMP: tempRoot,
          TMPDIR: tempRoot,
        },
      });
      assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
      const leftovers = fs
        .readdirSync(tempRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("goatcitadel-schema-template-"));
      assert.deepEqual(leftovers, [], "the child must remove the exact mkdtemp directory it owned");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
