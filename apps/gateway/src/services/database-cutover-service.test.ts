import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseCutoverService, __databaseCutoverServiceInternals } from "./database-cutover-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-db-cutover-"));
  tempDirs.push(dir);
  return dir;
}

function buildSqliteConfig(dbPath: string): never {
  return {
    dbPath,
    assistant: {
      database: {
        driver: "sqlite",
      },
    },
  } as never;
}

describe("DatabaseCutoverService", () => {
  it("blocks execute cutover when the runtime has already been flipped to Postgres", async () => {
    const createBackup = vi.fn();
    const service = new DatabaseCutoverService({
      config: {
        assistant: {
          database: {
            driver: "postgres",
          },
        },
      } as never,
      createBackup,
    });

    await expect(service.runCutover({ profile: "local", execute: true, confirm: true })).rejects.toThrow(
      "Database cutover already applied",
    );
    expect(createBackup).not.toHaveBeenCalled();
  });

  it("reports a reachable SQLite health snapshot when the configured database file exists", async () => {
    const rootDir = await makeTempDir();
    const dbPath = path.join(rootDir, "data", "index.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "", "utf8");
    const service = new DatabaseCutoverService({
      config: buildSqliteConfig(dbPath),
      createBackup: vi.fn(),
    });

    await expect(service.getHealthSnapshot()).resolves.toEqual({
      driver: "sqlite",
      configured: true,
      reachable: true,
      issues: [],
    });
  });

  it("reports an explicit SQLite health issue when the configured database file is missing", async () => {
    const rootDir = await makeTempDir();
    const dbPath = path.join(rootDir, "data", "missing.db");
    const service = new DatabaseCutoverService({
      config: buildSqliteConfig(dbPath),
      createBackup: vi.fn(),
    });

    await expect(service.getHealthSnapshot()).resolves.toEqual({
      driver: "sqlite",
      configured: true,
      reachable: false,
      issues: [`SQLite database is missing at ${dbPath}`],
    });
  });
});

describe("database cutover internal helpers", () => {
  it("resolves backup, directory, and direct SQLite snapshot shapes", async () => {
    const rootDir = await makeTempDir();
    const backupDir = path.join(rootDir, "backup");
    const explicitDir = path.join(rootDir, "explicit");
    const directSqlite = path.join(rootDir, "direct.db");
    await fs.mkdir(path.join(backupDir, "payload", "data"), { recursive: true });
    await fs.mkdir(path.join(explicitDir, "data"), { recursive: true });
    await fs.writeFile(directSqlite, "", "utf8");

    await expect(__databaseCutoverServiceInternals.resolveSnapshotFromBackup(backupDir)).resolves.toEqual({
      rootDir: path.join(backupDir, "payload"),
      sqlitePath: path.join(backupDir, "payload", "data", "index.db"),
      transcriptsDir: path.join(backupDir, "payload", "data", "transcripts"),
      auditDir: path.join(backupDir, "payload", "data", "audit"),
    });
    await expect(__databaseCutoverServiceInternals.resolveExplicitSnapshot(backupDir)).resolves.toMatchObject({
      rootDir: path.join(backupDir, "payload"),
    });
    await expect(__databaseCutoverServiceInternals.resolveExplicitSnapshot(explicitDir)).resolves.toEqual({
      rootDir: explicitDir,
      sqlitePath: path.join(explicitDir, "data", "index.db"),
      transcriptsDir: path.join(explicitDir, "data", "transcripts"),
      auditDir: path.join(explicitDir, "data", "audit"),
    });
    await expect(__databaseCutoverServiceInternals.resolveExplicitSnapshot(directSqlite)).resolves.toEqual({
      rootDir,
      sqlitePath: directSqlite,
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    });
  });

  it("summarizes source snapshots and reports parity mismatches against Postgres", async () => {
    const rootDir = await makeTempDir();
    const sqlitePath = path.join(rootDir, "data", "index.db");
    const transcriptsDir = path.join(rootDir, "data", "transcripts");
    const auditDir = path.join(rootDir, "data", "audit");
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });

    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
        CREATE TABLE runtime_rows (id INTEGER PRIMARY KEY, label TEXT);
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO sessions (session_id) VALUES ('s1'), ('s2');
        INSERT INTO runtime_rows (id, label) VALUES (1, 'one'), (2, 'two');
        INSERT INTO schema_migrations (version) VALUES (1);
      `);
    } finally {
      db.close();
    }

    await fs.writeFile(path.join(transcriptsDir, "s1.jsonl"), "{}\n{}\n", "utf8");
    await fs.writeFile(path.join(auditDir, "hooks.jsonl"), "{}\n", "utf8");

    const source = { rootDir, sqlitePath, transcriptsDir, auditDir };
    const sourceSchema = await __databaseCutoverServiceInternals.inspectSqliteSnapshot(sqlitePath);
    await expect(__databaseCutoverServiceInternals.summarizeSourceSnapshot(source)).resolves.toEqual({
      sessions: 2,
      transcriptEvents: 2,
      auditEvents: 1,
    });

    const postgres = {
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes("transcript_events")) {
          return { count: "1" };
        }
        if (sql.includes("audit_events")) {
          return { count: "1" };
        }
        if (sql.includes('"runtime_rows"')) {
          return { count: "0" };
        }
        if (sql.includes('"sessions"')) {
          throw new Error("relation does not exist");
        }
        return { count: "999" };
      }),
    };

    const report = await __databaseCutoverServiceInternals.verifyAgainstSource(
      source,
      sourceSchema,
      postgres as never,
      "snapshot-A",
      "postgres://target",
    );

    expect(report).toMatchObject({
      source: "snapshot-A",
      target: "postgres://target",
      verified: false,
      sourceSessionCount: 2,
      sourceTranscriptEventCount: 2,
      sourceAuditEventCount: 1,
      targetTranscriptEventCount: 1,
      targetAuditEventCount: 1,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "transcript_count_mismatch" }),
        expect.objectContaining({ code: "target_table_missing", path: "sessions" }),
        expect.objectContaining({ code: "table_row_count_mismatch", path: "runtime_rows" }),
      ]),
    );
    expect(report.issues.some((issue) => issue.path === "schema_migrations")).toBe(false);
  });

  it("imports SQLite runtime rows, resets sequences, and records cutover run summaries", async () => {
    const rootDir = await makeTempDir();
    const sqlitePath = path.join(rootDir, "data", "index.db");
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE parent (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT
        );
        CREATE TABLE empty_child (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES parent(id)
        );
        INSERT INTO parent (name) VALUES ('one'), ('two');
      `);
    } finally {
      db.close();
    }

    const source = {
      rootDir,
      sqlitePath,
      transcriptsDir: path.join(rootDir, "data", "transcripts"),
      auditDir: path.join(rootDir, "data", "audit"),
    };
    const schema = await __databaseCutoverServiceInternals.inspectSqliteSnapshot(sqlitePath);
    const query = vi.fn(async () => undefined);
    const postgres = {
      query,
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
    };

    await expect(
      __databaseCutoverServiceInternals.importSqliteRuntimeTables(postgres as never, source, schema),
    ).resolves.toEqual({ tables: 1, rows: 2 });

    expect(postgres.transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO "parent"'))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes("setval"))).toBe(true);

    const sequenceFailurePostgres = {
      query: vi.fn(async () => {
        throw new Error("sequence missing");
      }),
    };
    await expect(
      __databaseCutoverServiceInternals.resetPostgresSequences(sequenceFailurePostgres as never, schema.tables),
    ).resolves.toBeUndefined();

    await __databaseCutoverServiceInternals.recordCutoverRun(postgres as never, {
      cutoverId: "cutover-1",
      profile: "local",
      mode: "dry_run",
      status: "ready",
      startedAt: "2026-05-14T20:00:00.000Z",
      finishedAt: "2026-05-14T20:01:00.000Z",
      runtimeFlipReady: true,
      backupId: "backup-1",
      sourceSummary: { sessions: 2 },
      resultJson: { steps: [] },
    });
    expect(query.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(["cutover-1", "local", "dry_run", "ready", true, undefined, "backup-1"]),
    );
  });

  it("builds quoted Postgres inserts from SQLite rows with null fallbacks", async () => {
    const query = vi.fn(async () => undefined);
    await __databaseCutoverServiceInternals.insertRowsIntoPostgresTable(
      { query },
      {
        name: 'runtime"events',
        sql: "",
        rowCount: 2,
        columns: [
          { name: "id", type: "INTEGER", primaryKeyPosition: 1, autoIncrement: true },
          { name: "label", type: "TEXT", primaryKeyPosition: 0, autoIncrement: false },
        ],
        foreignKeys: [],
      },
      [{ id: 1, label: "one" }, { id: 2 }],
    );

    expect(query).toHaveBeenCalledWith(
      'INSERT INTO "runtime""events" ("id", "label") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING',
      [1, "one", 2, null],
    );
  });

  it("inspects SQLite table metadata, counts source event logs, and preserves dependency order", async () => {
    const rootDir = await makeTempDir();
    const sqlitePath = path.join(rootDir, "data", "index.db");
    const transcriptsDir = path.join(rootDir, "data", "transcripts");
    const auditDir = path.join(rootDir, "data", "audit");
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });

    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE parent (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        );
        CREATE TABLE child (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER NOT NULL REFERENCES parent(id),
          note TEXT
        );
        INSERT INTO parent (name) VALUES ('root');
        INSERT INTO child (parent_id, note) VALUES (1, 'leaf');
      `);
    } finally {
      db.close();
    }

    await fs.writeFile(
      path.join(transcriptsDir, "session-1.jsonl"),
      [
        JSON.stringify({ eventId: "evt-1", type: "message.user", payload: { content: "hello" } }),
        JSON.stringify({ eventId: "evt-2", type: "message.assistant", tokenInput: 4, costUsd: 0.01 }),
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(auditDir, "tool_invocations.jsonl"),
      `${JSON.stringify({ eventId: "audit-1", actorId: "operator:test" })}\n`,
      "utf8",
    );

    const schema = await __databaseCutoverServiceInternals.inspectSqliteSnapshot(sqlitePath);
    expect(schema.tables.map((table) => table.name)).toEqual(["child", "parent"]);
    expect(schema.tables.find((table) => table.name === "parent")?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "id",
          primaryKeyPosition: 1,
          autoIncrement: true,
        }),
      ]),
    );
    expect(schema.tables.find((table) => table.name === "child")?.foreignKeys).toEqual([
      expect.objectContaining({ referencedTable: "parent" }),
    ]);

    expect(await __databaseCutoverServiceInternals.countTranscriptEvents(transcriptsDir)).toBe(2);
    expect(await __databaseCutoverServiceInternals.countAuditEvents(auditDir)).toBe(1);
    expect(__databaseCutoverServiceInternals.topologicallySortTables(schema.tables).map((table) => table.name)).toEqual(
      ["parent", "child"],
    );
  });

  it("imports transcript and audit JSONL events through Postgres transactions", async () => {
    const rootDir = await makeTempDir();
    const transcriptsDir = path.join(rootDir, "transcripts");
    const auditDir = path.join(rootDir, "audit");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptsDir, "chat-1.jsonl"),
      [
        JSON.stringify({
          eventId: "msg-1",
          actionId: "act-1",
          idempotencyKey: "idem-1",
          timestamp: "2026-05-14T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: { content: "Hi" },
          tokenInput: 3,
          tokenOutput: 0,
          costUsd: 0,
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(auditDir, "approvals.jsonl"),
      `${JSON.stringify({ eventId: "approval-1", timestamp: "2026-05-14T00:00:01.000Z" })}\n`,
      "utf8",
    );
    const query = vi.fn(async () => undefined);
    const postgres = {
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
    };

    await expect(
      __databaseCutoverServiceInternals.importEventLogs(postgres as never, {
        rootDir,
        sqlitePath: path.join(rootDir, "index.db"),
        transcriptsDir,
        auditDir,
      }),
    ).resolves.toEqual({ transcriptEvents: 1, auditEvents: 1 });

    expect(postgres.transaction).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["chat-1", "msg-1", 1, "act-1", "idem-1", "message.user", "user", "operator"]),
    );
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["approvals", "approval-1", 1, "2026-05-14T00:00:01.000Z"]),
    );
  });

  it("keeps malformed JSONL lines visible while returning undefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        __databaseCutoverServiceInternals.parseJsonLine("{not-json", "audit/tool_invocations.jsonl", 7),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[goatcitadel] database cutover skipped malformed JSONL line", {
        filePath: "audit/tool_invocations.jsonl",
        lineNumber: 7,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("mutates cutover step records through explicit terminal states", () => {
    const steps = [
      { id: "backup", label: "Backup", status: "pending" as const },
      { id: "verify", label: "Verify", status: "pending" as const },
      { id: "flip", label: "Flip", status: "pending" as const },
      { id: "import", label: "Import", status: "pending" as const },
    ];

    __databaseCutoverServiceInternals.completeStep(steps, "backup", "done");
    __databaseCutoverServiceInternals.skipStep(steps, "verify", "dry run");
    __databaseCutoverServiceInternals.failStep(steps, "flip", "no target");
    __databaseCutoverServiceInternals.blockStep(steps, "import", "operator review");
    __databaseCutoverServiceInternals.completeStep(steps, "missing", "ignored");

    expect(steps).toEqual([
      { id: "backup", label: "Backup", status: "completed", detail: "done" },
      { id: "verify", label: "Verify", status: "skipped", detail: "dry run" },
      { id: "flip", label: "Flip", status: "failed", detail: "no target" },
      { id: "import", label: "Import", status: "blocked", detail: "operator review" },
    ]);
    expect(__databaseCutoverServiceInternals.countNonEmptyLines(" a \n\n b \r\n ")).toBe(2);
    expect(__databaseCutoverServiceInternals.quoteIdentifier('odd"name')).toBe('"odd""name"');
  });
});
