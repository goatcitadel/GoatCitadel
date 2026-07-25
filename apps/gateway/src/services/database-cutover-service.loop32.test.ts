import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseCutoverService, __databaseCutoverServiceInternals } from "./database-cutover-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-cutover-loop32-"));
  tempRoots.push(root);
  return root;
}

function createConfig(dbPath: string) {
  return {
    dbPath,
    assistant: {
      database: {
        driver: "sqlite",
        postgres: {
          migrationsTable: "schema_migrations",
        },
      },
    },
  } as never;
}

describe("DatabaseCutoverService loop32 fallback paths", () => {
  it("blocks unconfirmed execute requests before backup or runtime probing begins", async () => {
    const createBackup = vi.fn(async () => {
      throw new Error("backup should not run");
    });
    const service = new DatabaseCutoverService({
      config: createConfig(path.join(await createTempRoot(), "data", "index.db")),
      createBackup,
      readSettingsRevision: () => 1,
    });

    await expect(service.runCutover({ profile: "local", execute: true, confirm: false })).rejects.toThrow(
      "Database cutover execution requires confirm=true.",
    );
    expect(createBackup).not.toHaveBeenCalled();
  });

  it("records backup creation failures on the first pending cutover step", async () => {
    const root = await createTempRoot();
    const service = new DatabaseCutoverService({
      config: createConfig(path.join(root, "data", "index.db")),
      createBackup: vi.fn(async () => {
        throw new Error("backup target unavailable");
      }),
      readSettingsRevision: () => 1,
    });

    const result = await service.runCutover({ profile: "local", execute: false });

    expect(result).toMatchObject({
      profile: "local",
      mode: "dry_run",
      status: "failed",
      runtimeFlipReady: false,
      summary: {
        sourceSessionCount: 0,
        sourceTranscriptEventCount: 0,
        sourceAuditEventCount: 0,
        targetTranscriptEventCount: 0,
        targetAuditEventCount: 0,
      },
    });
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: "backup",
        status: "failed",
        detail: "backup target unavailable",
      }),
      expect.objectContaining({ id: "migrate", status: "pending" }),
      expect.objectContaining({ id: "import", status: "pending" }),
      expect.objectContaining({ id: "verify", status: "pending" }),
      expect.objectContaining({ id: "flip", status: "pending" }),
    ]);
  });

  it("returns zero source counts when snapshot directories and SQLite files are absent", async () => {
    const root = await createTempRoot();
    const snapshot = {
      rootDir: root,
      sqlitePath: path.join(root, "data", "missing.db"),
      transcriptsDir: path.join(root, "data", "missing-transcripts"),
      auditDir: path.join(root, "data", "missing-audit"),
    };

    await expect(__databaseCutoverServiceInternals.summarizeSourceSnapshot(snapshot)).resolves.toEqual({
      sessions: 0,
      transcriptEvents: 0,
      auditEvents: 0,
    });
    await expect(__databaseCutoverServiceInternals.inspectSqliteSnapshot(snapshot.sqlitePath)).resolves.toEqual({
      tables: [],
    });
    await expect(
      __databaseCutoverServiceInternals.importEventLogs({ transaction: vi.fn() } as never, snapshot),
    ).resolves.toEqual({
      transcriptEvents: 0,
      auditEvents: 0,
    });
    await expect(
      __databaseCutoverServiceInternals.importSqliteRuntimeTables(
        { transaction: vi.fn(), query: vi.fn() } as never,
        snapshot,
        {
          tables: [],
        },
      ),
    ).resolves.toEqual({ tables: 0, rows: 0 });
  });

  it("verifies source parity with event-count, table-count, and missing-table diagnostics", async () => {
    const root = await createTempRoot();
    const transcriptsDir = path.join(root, "transcripts");
    const auditDir = path.join(root, "audit");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(transcriptsDir, "session-1.jsonl"), '{"eventId":"a"}\n\n{"eventId":"b"}\n');
    await fs.writeFile(path.join(auditDir, "tool_invocations.jsonl"), '{"eventId":"audit-1"}\n');

    const postgres = {
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes("transcript_events")) {
          return { count: "1" };
        }
        if (sql.includes("audit_events")) {
          return { count: "0" };
        }
        if (sql.includes('"sessions"')) {
          return { count: "1" };
        }
        throw new Error("relation does not exist");
      }),
    };

    const result = await __databaseCutoverServiceInternals.verifyAgainstSource(
      {
        rootDir: root,
        sqlitePath: path.join(root, "missing.db"),
        transcriptsDir,
        auditDir,
      },
      {
        tables: [createTable("sessions", 2), createTable("schema_migrations", 99), createTable("missing_table", 1)],
      },
      postgres as never,
      "snapshot-a",
      "postgres://target",
    );

    expect(result).toMatchObject({
      source: "snapshot-a",
      target: "postgres://target",
      verified: false,
      sourceSessionCount: 0,
      sourceTranscriptEventCount: 2,
      sourceAuditEventCount: 1,
      targetTranscriptEventCount: 1,
      targetAuditEventCount: 0,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "transcript_count_mismatch",
      "audit_count_mismatch",
      "table_row_count_mismatch",
      "target_table_missing",
    ]);
    expect(postgres.queryOne).not.toHaveBeenCalledWith(expect.stringContaining("schema_migrations"));
  });

  it("imports JSONL event logs with legacy defaults and visible malformed-line evidence", async () => {
    const root = await createTempRoot();
    const transcriptsDir = path.join(root, "transcripts");
    const auditDir = path.join(root, "audit");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptsDir, "session-ops.jsonl"),
      [
        JSON.stringify({
          eventId: "evt-1",
          actionId: "action-1",
          idempotencyKey: "idem-1",
          sessionKey: "session-key",
          timestamp: "2026-05-15T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: { text: "hello" },
          tokenInput: 11,
          tokenOutput: Number.NaN,
          costUsd: 0.01,
        }),
        "{bad json",
        JSON.stringify({ payload: { text: "fallbacks" }, tokenInput: "bad" }),
      ].join("\n"),
    );
    await fs.writeFile(path.join(auditDir, "approvals.jsonl"), `${JSON.stringify({ actorId: "qa" })}\n`);

    const query = vi.fn(async () => undefined);
    const postgres = {
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await __databaseCutoverServiceInternals.importEventLogs(postgres as never, {
      rootDir: root,
      sqlitePath: path.join(root, "missing.db"),
      transcriptsDir,
      auditDir,
    });

    expect(result).toEqual({ transcriptEvents: 3, auditEvents: 1 });
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] database cutover skipped malformed JSONL line",
      expect.objectContaining({ lineNumber: 2 }),
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "session-ops",
      "evt-1",
      1,
      1,
      "action-1",
      "idem-1",
      "session-key",
      "2026-05-15T00:00:00.000Z",
      "message.user",
      "user",
      "operator",
      '{"text":"hello"}',
      11,
      null,
      0.01,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "session-ops",
      "session-ops:3",
      3,
      3,
      undefined,
      undefined,
      undefined,
      expect.any(String),
      "message.assistant",
      "system",
      "unknown",
      '{"text":"fallbacks"}',
      null,
      null,
      null,
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      "approvals",
      "approvals:1",
      1,
      1,
      expect.any(String),
      "qa",
      '{"actorId":"qa"}',
    ]);
  });

  it("skips empty JSONL sources and tolerates session-count SQLite schema gaps", async () => {
    const root = await createTempRoot();
    const sqlitePath = path.join(root, "data", "index.db");
    const transcriptsDir = path.join(root, "transcripts");
    const auditDir = path.join(root, "audit");
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(transcriptsDir, "empty-session.jsonl"), "\n  \r\n", "utf8");
    await fs.writeFile(path.join(auditDir, "hooks.jsonl"), "\n", "utf8");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec("CREATE TABLE runtime_rows (id INTEGER PRIMARY KEY, label TEXT)");
    } finally {
      db.close();
    }

    await expect(
      __databaseCutoverServiceInternals.summarizeSourceSnapshot({
        rootDir: root,
        sqlitePath,
        transcriptsDir,
        auditDir,
      }),
    ).resolves.toEqual({
      sessions: 0,
      transcriptEvents: 0,
      auditEvents: 0,
    });
    await expect(
      __databaseCutoverServiceInternals.importEventLogs({ transaction: vi.fn(async () => undefined) } as never, {
        rootDir: root,
        sqlitePath,
        transcriptsDir,
        auditDir,
      }),
    ).resolves.toEqual({ transcriptEvents: 0, auditEvents: 0 });
  });

  it("handles stale SQLite table metadata when runtime table batches are empty", async () => {
    const root = await createTempRoot();
    const sqlitePath = path.join(root, "index.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec("CREATE TABLE runtime_rows (id INTEGER PRIMARY KEY, label TEXT)");
    } finally {
      db.close();
    }
    const query = vi.fn(async () => undefined);
    const postgres = {
      query,
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
    };

    await expect(
      __databaseCutoverServiceInternals.importSqliteRuntimeTables(
        postgres as never,
        {
          rootDir: root,
          sqlitePath,
          transcriptsDir: path.join(root, "transcripts"),
          auditDir: path.join(root, "audit"),
        },
        {
          tables: [
            {
              ...createTable("runtime_rows", 1),
              columns: [
                { name: "id", type: "INTEGER", primaryKeyPosition: 1, autoIncrement: true },
                { name: "label", type: "TEXT", primaryKeyPosition: 0, autoIncrement: false },
              ],
            },
          ],
        },
      ),
    ).resolves.toEqual({ tables: 1, rows: 1 });
    expect(postgres.transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("setval");
  });

  it("builds SQL import statements, sequence resets, cutover records, and step mutations", async () => {
    const table = createTable('odd"table', 0, [
      { name: "id", type: "INTEGER", primaryKeyPosition: 1, autoIncrement: true },
      { name: "value", type: "TEXT", primaryKeyPosition: 0, autoIncrement: false },
    ]);
    const query = vi.fn(async () => undefined);

    await __databaseCutoverServiceInternals.insertRowsIntoPostgresTable({ query }, table, [
      { id: 1, value: "alpha" },
      { id: 2 },
    ]);

    expect(query).toHaveBeenCalledWith(
      'INSERT INTO "odd""table" ("id", "value") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING',
      [1, "alpha", 2, null],
    );

    query.mockClear();
    query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no sequence"));
    await __databaseCutoverServiceInternals.resetPostgresSequences({ query } as never, [
      table,
      {
        ...createTable("no_serial", 0),
        columns: [{ name: "name", type: "TEXT", primaryKeyPosition: 0, autoIncrement: false }],
      },
      {
        ...createTable("second_serial", 0),
        columns: [{ name: "id", type: "INTEGER", primaryKeyPosition: 1, autoIncrement: true }],
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual(['odd"table', "id"]);

    query.mockClear();
    await __databaseCutoverServiceInternals.recordCutoverRun({ query } as never, {
      cutoverId: "cutover-1",
      profile: "local",
      mode: "execute",
      status: "completed",
      startedAt: "2026-05-15T00:00:00.000Z",
      finishedAt: "2026-05-15T00:00:01.000Z",
      runtimeFlipReady: true,
      runtimeFlipBlockedReason: undefined,
      backupId: "backup-1",
      sourceSummary: { sessions: 2 },
      resultJson: { ok: true },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      "cutover-1",
      "local",
      "execute",
      "completed",
      "2026-05-15T00:00:00.000Z",
      "2026-05-15T00:00:01.000Z",
      true,
      undefined,
      "backup-1",
      '{"sessions":2}',
      '{"ok":true}',
    ]);

    const cyclicA = createTable("a", 1, undefined, [{ id: 0, seq: 0, referencedTable: "b" }]);
    const cyclicB = createTable("b", 1, undefined, [{ id: 0, seq: 0, referencedTable: "a" }]);
    expect(
      __databaseCutoverServiceInternals.topologicallySortTables([cyclicB, cyclicA]).map((item) => item.name),
    ).toEqual(["a", "b"]);
    expect(__databaseCutoverServiceInternals.quoteIdentifier('needs"quote')).toBe('"needs""quote"');

    const steps = [
      { id: "backup", label: "Backup", status: "pending" },
      { id: "verify", label: "Verify", status: "pending" },
      { id: "flip", label: "Flip", status: "pending" },
    ] as never;
    __databaseCutoverServiceInternals.completeStep(steps, "backup", "done");
    __databaseCutoverServiceInternals.skipStep(steps, "verify", "dry-run");
    __databaseCutoverServiceInternals.failStep(steps, "missing", "ignored");
    __databaseCutoverServiceInternals.skipStep(steps, "missing", "ignored");
    __databaseCutoverServiceInternals.blockStep(steps, "flip", "manual persistence missing");
    __databaseCutoverServiceInternals.blockStep(steps, "missing", "ignored");
    expect(steps).toEqual([
      { id: "backup", label: "Backup", status: "completed", detail: "done" },
      { id: "verify", label: "Verify", status: "skipped", detail: "dry-run" },
      { id: "flip", label: "Flip", status: "blocked", detail: "manual persistence missing" },
    ]);
  });
});

function createTable(
  name: string,
  rowCount: number,
  columns = [{ name: "id", type: "INTEGER", primaryKeyPosition: 1, autoIncrement: false }],
  foreignKeys: Array<{ id: number; seq: number; referencedTable: string }> = [],
) {
  return {
    name,
    sql: `CREATE TABLE ${name} (id integer primary key)`,
    rowCount,
    columns,
    foreignKeys,
  };
}
