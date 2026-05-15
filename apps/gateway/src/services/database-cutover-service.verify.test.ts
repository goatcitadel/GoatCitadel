import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCutoverService } from "./database-cutover-service.js";

const postgresMocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  healthCheck: vi.fn(),
  close: vi.fn(),
  stopBundled: vi.fn(),
  connectionOptions: vi.fn(),
  runPostgresMigrations: vi.fn(),
}));

vi.mock("@goatcitadel/storage", () => ({
  PostgresDatabaseClient: vi.fn(function PostgresDatabaseClient() {
    return {
      query: postgresMocks.query,
      queryOne: postgresMocks.queryOne,
      transaction: postgresMocks.transaction,
      healthCheck: postgresMocks.healthCheck,
      close: postgresMocks.close,
    };
  }),
  runPostgresMigrations: postgresMocks.runPostgresMigrations,
}));

vi.mock("../bundled-postgres-runtime.js", () => ({
  ensureBundledPostgresRuntime: vi.fn(async () => ({ stop: postgresMocks.stopBundled })),
}));

vi.mock("../postgres-runtime-config.js", () => ({
  isBundledPostgresMode: vi.fn(() => true),
  resolveGatewayPostgresConnectionOptions: vi.fn((_config, options) => {
    postgresMocks.connectionOptions(options);
    return { connectionString: options?.connectionStringOverride ?? "postgres://bundled" };
  }),
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  postgresMocks.query.mockResolvedValue(undefined);
  postgresMocks.transaction.mockImplementation(
    async (callback: (client: { query: typeof postgresMocks.query }) => Promise<void>) =>
      callback({ query: postgresMocks.query }),
  );
  postgresMocks.healthCheck.mockResolvedValue({
    reachable: true,
    migrationVersion: 42,
    latencyMs: 12,
    issues: [],
  });
  postgresMocks.runPostgresMigrations.mockResolvedValue({ latestVersion: 42 });
  postgresMocks.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("transcript_events")) {
      return { count: "2" };
    }
    if (sql.includes("audit_events")) {
      return { count: "1" };
    }
    if (sql.includes('"sessions"')) {
      return { count: "1" };
    }
    return { count: "0" };
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("DatabaseCutoverService verify", () => {
  it("verifies an explicit SQLite snapshot against bundled Postgres and stops the temporary runtime", async () => {
    const root = await makeSnapshot();
    const service = new DatabaseCutoverService({
      config: {
        dbPath: path.join(root, "data", "index.db"),
        assistant: {
          database: {
            driver: "postgres",
            postgres: {
              migrationsTable: "schema_migrations",
            },
          },
        },
      } as never,
      createBackup: vi.fn(),
    });

    const report = await service.verify({ source: root });

    expect(report).toEqual(
      expect.objectContaining({
        source: root,
        target: undefined,
        verified: true,
        sourceSessionCount: 1,
        sourceTranscriptEventCount: 2,
        sourceAuditEventCount: 1,
        targetTranscriptEventCount: 2,
        targetAuditEventCount: 1,
        issues: [],
      }),
    );
    expect(postgresMocks.connectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionStringOverride: undefined,
        applicationName: "goatcitadel-cutover",
      }),
    );
    expect(postgresMocks.close).toHaveBeenCalledTimes(1);
    expect(postgresMocks.stopBundled).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit target connection string without starting bundled Postgres", async () => {
    const root = await makeSnapshot();
    const service = new DatabaseCutoverService({
      config: {
        dbPath: path.join(root, "data", "index.db"),
        assistant: {
          database: {
            driver: "postgres",
            postgres: {
              migrationsTable: "schema_migrations",
            },
          },
        },
      } as never,
      createBackup: vi.fn(),
    });

    await service.verify({ source: root, target: "postgres://operator-target" });

    expect(postgresMocks.connectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionStringOverride: "postgres://operator-target",
        applicationName: "goatcitadel-cutover",
      }),
    );
    expect(postgresMocks.stopBundled).not.toHaveBeenCalled();
    expect(postgresMocks.close).toHaveBeenCalledTimes(1);
  });

  it("runs a dry-run cutover through backup, migration, verification, and recording without flipping config", async () => {
    const backupRoot = await makeBackupSnapshot();
    const service = new DatabaseCutoverService({
      config: buildConfig(path.join(backupRoot, "payload", "data", "index.db"), "sqlite"),
      createBackup: vi.fn(async () => ({
        backupId: "backup-dry-run",
        outputPath: backupRoot,
      })),
      persistAssistantConfig: vi.fn(),
    });

    const result = await service.runCutover({ profile: "local", execute: false });

    expect(result).toMatchObject({
      profile: "local",
      mode: "dry_run",
      status: "ready",
      runtimeFlipReady: true,
      summary: {
        sourceSessionCount: 1,
        sourceTranscriptEventCount: 2,
        sourceAuditEventCount: 1,
        targetTranscriptEventCount: 2,
        targetAuditEventCount: 1,
      },
      steps: [
        expect.objectContaining({ id: "backup", status: "completed" }),
        expect.objectContaining({ id: "migrate", status: "completed" }),
        expect.objectContaining({ id: "import", status: "skipped" }),
        expect.objectContaining({ id: "verify", status: "completed" }),
        expect.objectContaining({ id: "flip", status: "skipped" }),
      ],
    });
    expect(postgresMocks.runPostgresMigrations).toHaveBeenCalledTimes(1);
    expect(postgresMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO database_cutover_runs"),
      expect.any(Array),
    );
    expect(postgresMocks.stopBundled).not.toHaveBeenCalled();
    expect(postgresMocks.close).toHaveBeenCalledTimes(1);
  });

  it("blocks execute cutover after successful import when config persistence is unavailable", async () => {
    const backupRoot = await makeBackupSnapshot();
    const config = buildConfig(path.join(backupRoot, "payload", "data", "index.db"), "sqlite");
    const service = new DatabaseCutoverService({
      config,
      createBackup: vi.fn(async () => ({
        backupId: "backup-execute",
        outputPath: backupRoot,
      })),
    });

    const result = await service.runCutover({ profile: "local", execute: true, confirm: true });

    expect(result).toMatchObject({
      mode: "execute",
      status: "blocked",
      runtimeFlipReady: true,
      runtimeFlipBlockedReason: "Gateway service cannot persist assistant.config.json after cutover.",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "import", status: "completed" }),
        expect.objectContaining({ id: "flip", status: "blocked" }),
      ]),
    });
    expect(config.assistant.database.driver).toBe("sqlite");
    expect(postgresMocks.transaction).toHaveBeenCalled();
    expect(postgresMocks.stopBundled).toHaveBeenCalledTimes(1);
    expect(postgresMocks.close).toHaveBeenCalledTimes(1);
  });

  it("reports Postgres health snapshots and closes the probe client", async () => {
    const service = new DatabaseCutoverService({
      config: buildConfig(path.join(await fs.mkdtemp(path.join(os.tmpdir(), "gc-db-health-")), "index.db"), "postgres"),
      createBackup: vi.fn(),
    });

    await expect(service.getHealthSnapshot()).resolves.toEqual({
      driver: "postgres",
      configured: true,
      reachable: true,
      migrationVersion: 42,
      latencyMs: 12,
      issues: [],
    });
    expect(postgresMocks.healthCheck).toHaveBeenCalledTimes(1);
    expect(postgresMocks.close).toHaveBeenCalledTimes(1);
  });
});

function buildConfig(dbPath: string, driver: "sqlite" | "postgres") {
  return {
    dbPath,
    assistant: {
      database: {
        driver,
        postgres: {
          migrationsTable: "schema_migrations",
        },
      },
    },
  } as never;
}

async function makeBackupSnapshot(): Promise<string> {
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-db-cutover-run-"));
  tempDirs.push(backupRoot);
  await populateSnapshot(path.join(backupRoot, "payload"));
  return backupRoot;
}

async function makeSnapshot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-db-cutover-verify-"));
  tempDirs.push(root);
  await populateSnapshot(root);
  return root;
}

async function populateSnapshot(root: string): Promise<void> {
  const sqlitePath = path.join(root, "data", "index.db");
  const transcriptsDir = path.join(root, "data", "transcripts");
  const auditDir = path.join(root, "data", "audit");
  await fs.mkdir(transcriptsDir, { recursive: true });
  await fs.mkdir(auditDir, { recursive: true });

  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      INSERT INTO sessions (session_id) VALUES ('session-1');
    `);
  } finally {
    db.close();
  }

  await fs.writeFile(path.join(transcriptsDir, "session-1.jsonl"), "{}\n{}\n", "utf8");
  await fs.writeFile(path.join(auditDir, "approvals.jsonl"), "{}\n", "utf8");
}
