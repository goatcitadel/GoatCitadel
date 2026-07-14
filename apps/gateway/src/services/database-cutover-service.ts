import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  BackupCreateResponse,
  DatabaseCutoverProfile,
  DatabaseCutoverRequest,
  DatabaseCutoverResponse,
  DatabaseCutoverStatus,
  DatabaseCutoverStepRecord,
  DatabaseHealthSnapshot,
  DatabaseVerifyIssue,
  DatabaseVerifyResponse,
} from "@goatcitadel/contracts";
import { ConflictError, isGoatError, ValidationError } from "@goatcitadel/contracts";
import { PostgresDatabaseClient, runPostgresMigrations } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { ensureBundledPostgresRuntime } from "../bundled-postgres-runtime.js";
import { isBundledPostgresMode, resolveGatewayPostgresConnectionOptions } from "../postgres-runtime-config.js";

export interface DatabaseCutoverServiceDeps {
  readonly config: GatewayRuntimeConfig;
  readonly createBackup: (input?: { name?: string; outputPath?: string }) => Promise<BackupCreateResponse>;
  /** Revision-fenced public settings read used before any execute side effect. */
  readonly readSettingsRevision: () => number;
  /** Persists the next-start driver through the Gateway config-generation owner. */
  readonly commitDatabaseDriver?: (input: {
    driver: "postgres";
    expectedRevision: number;
  }) => Promise<{ revision: number }>;
}

/** @internal */
export interface SourceSnapshot {
  rootDir: string;
  sqlitePath: string;
  transcriptsDir: string;
  auditDir: string;
}

/** @internal */
export interface SqliteSnapshotColumn {
  name: string;
  type: string;
  primaryKeyPosition: number;
  autoIncrement: boolean;
}

/** @internal */
export interface SqliteSnapshotForeignKey {
  id: number;
  seq: number;
  referencedTable: string;
}

/** @internal */
export interface SqliteSnapshotTable {
  name: string;
  sql: string;
  rowCount: number;
  columns: SqliteSnapshotColumn[];
  foreignKeys: SqliteSnapshotForeignKey[];
}

/** @internal */
export interface SqliteSnapshotSchema {
  tables: SqliteSnapshotTable[];
}

/** @internal */
export interface SourceSummary {
  sessions: number;
  transcriptEvents: number;
  auditEvents: number;
}

const AUDIT_STREAMS = ["tool_invocations", "policy_blocks", "approvals", "hooks"] as const;
const CUTOVER_IMPORT_BATCH_SIZE = 1000;
const SQLITE_IMPORT_EXCLUDED_TABLES = new Set(["schema_migrations"]);

export class DatabaseCutoverService {
  private readonly activeStorageDriver: "sqlite" | "postgres";

  public constructor(private readonly deps: DatabaseCutoverServiceDeps) {
    // Storage is constructed before this service and is not hot-swapped by a
    // cutover. Capture that process truth before canonical config is changed.
    this.activeStorageDriver = deps.config.assistant.database.driver;
  }

  public async runCutover(input: DatabaseCutoverRequest): Promise<DatabaseCutoverResponse> {
    if (input.execute && !input.confirm) {
      throw new ValidationError({ message: "Database cutover execution requires confirm=true." });
    }

    const initialRevision = this.deps.readSettingsRevision();
    if (input.execute) {
      if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision ?? 0) <= 0) {
        throw new ValidationError({ message: "expectedRevision is required for database cutover execution." });
      }
      if (input.expectedRevision !== initialRevision) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Settings changed after this database cutover client loaded them.",
          details: {
            expectedRevision: input.expectedRevision,
            currentRevision: initialRevision,
          },
        });
      }
    }

    if (input.execute && this.deps.config.assistant.database.driver === "postgres") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message:
          "Database cutover already applied; configured driver is postgres. Use the verify command to check parity instead of re-running cutover.",
      });
    }

    const cutoverId = randomUUID();
    const startedAt = new Date().toISOString();
    const steps: DatabaseCutoverStepRecord[] = [
      { id: "backup", label: "Create preflight backup", status: "pending" },
      { id: "migrate", label: "Run Postgres migrations", status: "pending" },
      { id: "import", label: "Import SQLite runtime data and event history", status: "pending" },
      { id: "verify", label: "Verify source vs target parity", status: "pending" },
      { id: "flip", label: "Persist next-start Postgres driver", status: "pending" },
    ];

    let backup: BackupCreateResponse | undefined;
    let summary: SourceSummary = { sessions: 0, transcriptEvents: 0, auditEvents: 0 };
    let targetTranscriptEvents = 0;
    let targetAuditEvents = 0;
    let status: DatabaseCutoverStatus;
    let revision = initialRevision;
    let runtimeFlipReady = false;
    let runtimeFlipBlockedReason: string | undefined;

    try {
      backup = await this.deps.createBackup({
        name: `db-cutover-${startedAt.slice(0, 10)}`,
      });
      completeStep(steps, "backup", `Backup created at ${backup.outputPath}`);

      const source = await resolveSnapshotFromBackup(backup.outputPath);
      const sourceSchema = await inspectSqliteSnapshot(source.sqlitePath);
      summary = await summarizeSourceSnapshot(source);
      const bundledRuntime =
        !input.execute || !isBundledPostgresMode(this.deps.config)
          ? undefined
          : await ensureBundledPostgresRuntime(this.deps.config);

      const postgres = new PostgresDatabaseClient(
        resolveGatewayPostgresConnectionOptions(this.deps.config, {
          applicationName: "goatcitadel-cutover",
        }),
        {
          migrationsTable: this.deps.config.assistant.database.postgres.migrationsTable,
        },
      );
      try {
        const migrationRun = await runPostgresMigrations(postgres);
        completeStep(steps, "migrate", `Latest Postgres migration version ${migrationRun.latestVersion}`);

        if (input.execute) {
          const importedTables = await importSqliteRuntimeTables(postgres, source, sourceSchema);
          const imported = await importEventLogs(postgres, source);
          targetTranscriptEvents = imported.transcriptEvents;
          targetAuditEvents = imported.auditEvents;
          completeStep(
            steps,
            "import",
            `Imported ${importedTables.rows} runtime rows across ${importedTables.tables} tables, ${imported.transcriptEvents} transcript events, and ${imported.auditEvents} audit events.`,
          );
        } else {
          skipStep(steps, "import", "Dry-run mode skipped the import stage.");
        }

        const verification = await verifyAgainstSource(
          source,
          sourceSchema,
          postgres,
          backup.outputPath,
          undefined,
          !input.execute,
        );
        targetTranscriptEvents = verification.targetTranscriptEventCount ?? targetTranscriptEvents;
        targetAuditEvents = verification.targetAuditEventCount ?? targetAuditEvents;
        if (!verification.verified) {
          failStep(steps, "verify", verification.issues.map((issue) => issue.message).join(" "));
          status = "failed";
        } else {
          completeStep(
            steps,
            "verify",
            `Verified runtime table counts plus ${verification.targetTranscriptEventCount ?? 0} transcript events and ${verification.targetAuditEventCount ?? 0} audit events.`,
          );
          runtimeFlipReady = true;
          status = input.execute ? "completed" : "ready";
        }

        if (status === "failed") {
          skipStep(steps, "flip", "Skipped because verification failed.");
        } else if (!input.execute) {
          skipStep(steps, "flip", "Dry-run completed; rerun with --execute --confirm to persist the Postgres runtime.");
        } else if (!this.deps.commitDatabaseDriver) {
          status = "blocked";
          runtimeFlipBlockedReason = "Gateway config-generation commit is unavailable after cutover.";
          blockStep(steps, "flip", runtimeFlipBlockedReason);
        } else {
          const committed = await this.deps.commitDatabaseDriver({
            driver: "postgres",
            expectedRevision: input.expectedRevision!,
          });
          revision = committed.revision;
          completeStep(
            steps,
            "flip",
            "Persisted assistant.database.driver=postgres for the next Gateway start; the active Storage instance remains unchanged until restart.",
          );
        }

        await recordCutoverRun(postgres, {
          cutoverId,
          profile: input.profile,
          mode: input.execute ? "execute" : "dry_run",
          status,
          startedAt,
          finishedAt: new Date().toISOString(),
          runtimeFlipReady,
          runtimeFlipBlockedReason,
          backupId: backup.backupId,
          sourceSummary: {
            sessions: summary.sessions,
            transcriptEvents: summary.transcriptEvents,
            auditEvents: summary.auditEvents,
            targetTranscriptEvents,
            targetAuditEvents,
          },
          resultJson: { steps },
        });
      } finally {
        await postgres.close();
        await bundledRuntime?.stop();
      }
    } catch (error) {
      if (isGoatError(error)) {
        throw error;
      }
      status = "failed";
      const message = error instanceof Error ? error.message : String(error);
      const firstPending = steps.find((step) => step.status === "pending");
      if (firstPending) {
        failStep(steps, firstPending.id, message);
      }
      try {
        revision = this.deps.readSettingsRevision();
      } catch {
        // Preserve the last confirmed revision when another generation is
        // actively fenced; the failure response must not force an unsafe read.
      }
    }

    const configuredDriver = this.deps.config.assistant.database.driver;

    return {
      cutoverId,
      profile: input.profile,
      mode: input.execute ? "execute" : "dry_run",
      status,
      revision,
      configuredDriver,
      activeStorageDriver: this.activeStorageDriver,
      restartRequired: configuredDriver !== this.activeStorageDriver,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup,
      runtimeFlipReady,
      runtimeFlipBlockedReason,
      summary: {
        sourceSessionCount: summary.sessions,
        sourceTranscriptEventCount: summary.transcriptEvents,
        sourceAuditEventCount: summary.auditEvents,
        targetTranscriptEventCount: targetTranscriptEvents,
        targetAuditEventCount: targetAuditEvents,
      },
      steps,
    };
  }

  public async verify(input: { source: string; target?: string }): Promise<DatabaseVerifyResponse> {
    const source = await resolveExplicitSnapshot(input.source);
    const sourceSchema = await inspectSqliteSnapshot(source.sqlitePath);
    const bundledRuntime =
      !input.target && isBundledPostgresMode(this.deps.config)
        ? await ensureBundledPostgresRuntime(this.deps.config)
        : undefined;
    const postgres = new PostgresDatabaseClient(
      resolveGatewayPostgresConnectionOptions(this.deps.config, {
        connectionStringOverride: input.target,
        applicationName: "goatcitadel-cutover",
      }),
      {
        migrationsTable: this.deps.config.assistant.database.postgres.migrationsTable,
      },
    );
    try {
      return await verifyAgainstSource(source, sourceSchema, postgres, input.source, input.target);
    } finally {
      await postgres.close();
      await bundledRuntime?.stop();
    }
  }

  public async getHealthSnapshot(): Promise<DatabaseHealthSnapshot> {
    // Health describes the already-created Storage owner, not merely the
    // next-start driver persisted by a completed cutover.
    const driver = this.activeStorageDriver;
    if (driver === "sqlite") {
      const startedAt = Date.now();
      const databasePath = this.deps.config.dbPath.trim();
      if (!databasePath) {
        return {
          driver,
          configured: false,
          reachable: false,
          latencyMs: Date.now() - startedAt,
          issues: ["SQLite database is not configured."],
        };
      }

      let database: DatabaseSync | undefined;
      let migrationVersion: number | undefined;
      let issue: string | undefined;
      try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        const probe = database.prepare("SELECT 1 AS ok").get() as { ok?: unknown } | undefined;
        if (probe?.ok !== 1) {
          throw new Error("SQLite readiness probe returned an unexpected result");
        }
        const migrationTable = database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1")
          .get();
        if (migrationTable) {
          const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
            | { version?: number | bigint | null }
            | undefined;
          if (row?.version !== null && row?.version !== undefined) {
            const normalizedVersion = Number(row.version);
            if (!Number.isSafeInteger(normalizedVersion) || normalizedVersion < 0) {
              throw new Error("SQLite migration version is invalid");
            }
            migrationVersion = normalizedVersion;
          }
        }
      } catch {
        issue = "SQLite database readiness probe failed.";
      } finally {
        try {
          database?.close();
        } catch {
          issue = "SQLite database readiness probe failed.";
        }
      }
      return {
        driver,
        configured: true,
        reachable: issue === undefined,
        migrationVersion,
        latencyMs: Date.now() - startedAt,
        issues: issue ? [issue] : [],
      };
    }

    const postgres = new PostgresDatabaseClient(
      resolveGatewayPostgresConnectionOptions(this.deps.config, {
        applicationName: "goatcitadel-cutover",
      }),
      {
        migrationsTable: this.deps.config.assistant.database.postgres.migrationsTable,
      },
    );
    try {
      const health = await postgres.healthCheck();
      return {
        driver,
        configured: true,
        reachable: health.reachable,
        migrationVersion: health.migrationVersion,
        latencyMs: health.latencyMs,
        issues: health.issues,
      };
    } finally {
      await postgres.close();
    }
  }
}

async function resolveSnapshotFromBackup(backupPath: string): Promise<SourceSnapshot> {
  const payloadDir = path.join(backupPath, "payload");
  const sqlitePath = path.join(payloadDir, "data", "index.db");
  const transcriptsDir = path.join(payloadDir, "data", "transcripts");
  const auditDir = path.join(payloadDir, "data", "audit");
  return {
    rootDir: payloadDir,
    sqlitePath,
    transcriptsDir,
    auditDir,
  };
}

async function resolveExplicitSnapshot(source: string): Promise<SourceSnapshot> {
  const absolute = path.resolve(source);
  const stats = await fs.stat(absolute);
  if (stats.isDirectory()) {
    const payloadDir = path.join(absolute, "payload");
    const payloadStats = await statIfExists(payloadDir);
    if (payloadStats?.isDirectory()) {
      return resolveSnapshotFromBackup(absolute);
    }
    return {
      rootDir: absolute,
      sqlitePath: path.join(absolute, "data", "index.db"),
      transcriptsDir: path.join(absolute, "data", "transcripts"),
      auditDir: path.join(absolute, "data", "audit"),
    };
  }

  return {
    rootDir: path.dirname(absolute),
    sqlitePath: absolute,
    transcriptsDir: path.join(path.dirname(absolute), "transcripts"),
    auditDir: path.join(path.dirname(absolute), "audit"),
  };
}

async function summarizeSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSummary> {
  const sessions = await countSessions(snapshot.sqlitePath);
  const transcriptEvents = await countTranscriptEvents(snapshot.transcriptsDir);
  const auditEvents = await countAuditEvents(snapshot.auditDir);
  return {
    sessions,
    transcriptEvents,
    auditEvents,
  };
}

async function verifyAgainstSource(
  source: SourceSnapshot,
  sourceSchema: SqliteSnapshotSchema,
  postgres: PostgresDatabaseClient,
  sourceLabel: string,
  target?: string,
  dryRun = false,
): Promise<DatabaseVerifyResponse> {
  const issues: DatabaseVerifyIssue[] = [];
  const sourceSummary = await summarizeSourceSnapshot(source);
  const transcriptTarget = await postgres.queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM transcript_events",
  );
  const auditTarget = await postgres.queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM audit_events");
  const targetTranscriptEventCount = Number(transcriptTarget?.count ?? 0);
  const targetAuditEventCount = Number(auditTarget?.count ?? 0);

  if (targetTranscriptEventCount < sourceSummary.transcriptEvents) {
    issues.push({
      code: "transcript_count_mismatch",
      message: `Target transcript_events has ${targetTranscriptEventCount} rows but source JSONL has ${sourceSummary.transcriptEvents}.`,
    });
  }
  if (targetAuditEventCount < sourceSummary.auditEvents) {
    issues.push({
      code: "audit_count_mismatch",
      message: `Target audit_events has ${targetAuditEventCount} rows but source JSONL has ${sourceSummary.auditEvents}.`,
    });
  }

  for (const table of sourceSchema.tables.filter((candidate) => !SQLITE_IMPORT_EXCLUDED_TABLES.has(candidate.name))) {
    try {
      const targetRow = await postgres.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table.name)}`,
      );
      const targetCount = Number(targetRow?.count ?? 0);
      if (targetCount !== table.rowCount) {
        issues.push({
          code: "table_row_count_mismatch",
          message: `Target ${table.name} has ${targetCount} rows but source SQLite has ${table.rowCount}.`,
          path: table.name,
        });
      }
    } catch (error) {
      issues.push({
        code: "target_table_missing",
        message: `Target Postgres table ${table.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        path: table.name,
      });
    }
  }

  // In dry-run the import stage is skipped, so the freshly-migrated target is intentionally
  // empty: row-count mismatches are expected and must NOT block (otherwise a dry run against
  // any populated source always reports "failed" and never reaches the "ready" preview verdict).
  // Only structural/connectivity problems block a dry run; execute mode enforces strict parity.
  const blockingIssues = dryRun ? issues.filter((issue) => issue.code === "target_table_missing") : issues;
  return {
    source: sourceLabel,
    target,
    verified: blockingIssues.length === 0,
    sourceSessionCount: sourceSummary.sessions,
    sourceTranscriptEventCount: sourceSummary.transcriptEvents,
    sourceAuditEventCount: sourceSummary.auditEvents,
    targetTranscriptEventCount,
    targetAuditEventCount,
    issues,
  };
}

async function inspectSqliteSnapshot(sqlitePath: string): Promise<SqliteSnapshotSchema> {
  const stats = await statIfExists(sqlitePath);
  if (!stats?.isFile()) {
    return { tables: [] };
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const tableRows = db
      .prepare(
        `
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `,
      )
      .all() as Array<{ name: string; sql: string }>;

    const tables = tableRows.map((row) => inspectSqliteTable(db, row.name, row.sql));
    return { tables };
  } finally {
    db.close();
  }
}

function inspectSqliteTable(db: DatabaseSync, tableName: string, sql: string): SqliteSnapshotTable {
  const autoIncrementColumns = new Set(
    [...sql.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string"),
  );
  const quotedTableName = quoteIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${quotedTableName})`).all() as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quotedTableName})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
  }>;
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ${quotedTableName}`).get() as
    | { count?: number }
    | undefined;
  return {
    name: tableName,
    sql,
    rowCount: Number(countRow?.count ?? 0),
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      primaryKeyPosition: column.pk,
      autoIncrement: autoIncrementColumns.has(column.name),
    })),
    foreignKeys: foreignKeys.map((foreignKey) => ({
      id: foreignKey.id,
      seq: foreignKey.seq,
      referencedTable: foreignKey.table,
    })),
  };
}

async function importSqliteRuntimeTables(
  postgres: PostgresDatabaseClient,
  source: SourceSnapshot,
  sourceSchema: SqliteSnapshotSchema,
): Promise<{ tables: number; rows: number }> {
  const stats = await statIfExists(source.sqlitePath);
  if (!stats?.isFile()) {
    return { tables: 0, rows: 0 };
  }

  const sourceDb = new DatabaseSync(source.sqlitePath, { readOnly: true });
  let importedTables = 0;
  let importedRows = 0;
  try {
    const orderedTables = topologicallySortTables(
      sourceSchema.tables.filter((table) => !SQLITE_IMPORT_EXCLUDED_TABLES.has(table.name)),
    );
    for (const table of orderedTables) {
      if (table.columns.length === 0 || table.rowCount === 0) {
        continue;
      }
      await postgres.transaction(async (client) => {
        for (let offset = 0; offset < table.rowCount; offset += CUTOVER_IMPORT_BATCH_SIZE) {
          const rows = sourceDb
            .prepare(`SELECT * FROM ${quoteIdentifier(table.name)} LIMIT ? OFFSET ?`)
            .all(CUTOVER_IMPORT_BATCH_SIZE, offset) as Record<string, unknown>[];
          if (rows.length === 0) {
            continue;
          }
          await insertRowsIntoPostgresTable(client, table, rows);
        }
      });
      importedTables += 1;
      importedRows += table.rowCount;
    }
  } finally {
    sourceDb.close();
  }

  await resetPostgresSequences(postgres, sourceSchema.tables);
  return {
    tables: importedTables,
    rows: importedRows,
  };
}

async function importEventLogs(
  postgres: PostgresDatabaseClient,
  source: SourceSnapshot,
): Promise<{ transcriptEvents: number; auditEvents: number }> {
  let transcriptEvents = 0;
  let auditEvents = 0;

  const transcriptFiles = await listFilesWithExtension(source.transcriptsDir, ".jsonl");
  for (const filePath of transcriptFiles) {
    const sessionId = path.basename(filePath, ".jsonl");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    await postgres.transaction(async (client) => {
      for (const [index, line] of lines.entries()) {
        const payload = parseJsonLine(line, filePath, index + 1);
        if (!payload) {
          continue;
        }
        await client.query(
          `
            INSERT INTO transcript_events (
              session_id,
              event_id,
              event_sequence,
              legacy_offset,
              action_id,
              idempotency_key,
              session_key,
              occurred_at,
              event_type,
              actor_type,
              actor_id,
              payload,
              token_input,
              token_output,
              cost_usd
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15
            )
            ON CONFLICT (session_id, event_id) DO NOTHING
          `,
          [
            sessionId,
            asString(payload.eventId) ?? `${sessionId}:${index + 1}`,
            index + 1,
            index + 1,
            asString(payload.actionId),
            asString(payload.idempotencyKey),
            asString(payload.sessionKey),
            asString(payload.timestamp) ?? new Date().toISOString(),
            asString(payload.type) ?? "message.assistant",
            asString(payload.actorType) ?? "system",
            asString(payload.actorId) ?? "unknown",
            JSON.stringify(payload.payload ?? payload),
            asNullableNumber(payload.tokenInput),
            asNullableNumber(payload.tokenOutput),
            asNullableNumber(payload.costUsd),
          ],
        );
      }
    });
    transcriptEvents += lines.length;
  }

  for (const stream of AUDIT_STREAMS) {
    const filePath = path.join(source.auditDir, `${stream}.jsonl`);
    const stats = await statIfExists(filePath);
    if (!stats?.isFile()) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    await postgres.transaction(async (client) => {
      for (const [index, line] of lines.entries()) {
        const payload = parseJsonLine(line, filePath, index + 1);
        if (!payload) {
          continue;
        }
        await client.query(
          `
            INSERT INTO audit_events (
              stream_name,
              event_id,
              event_sequence,
              legacy_offset,
              occurred_at,
              actor_id,
              payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            ON CONFLICT (stream_name, event_id) DO NOTHING
          `,
          [
            stream,
            asString(payload.eventId) ?? `${stream}:${index + 1}`,
            index + 1,
            index + 1,
            asString(payload.timestamp) ?? new Date().toISOString(),
            asString(payload.actorId),
            JSON.stringify(payload),
          ],
        );
      }
    });
    auditEvents += lines.length;
  }

  return { transcriptEvents, auditEvents };
}

async function insertRowsIntoPostgresTable(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  table: SqliteSnapshotTable,
  rows: Record<string, unknown>[],
): Promise<void> {
  const columnNames = table.columns.map((column) => column.name);
  const quotedColumns = columnNames.map((column) => quoteIdentifier(column)).join(", ");
  const values: unknown[] = [];
  const valueGroups = rows.map((row, rowIndex) => {
    const placeholders = columnNames.map((column, columnIndex) => {
      values.push(row[column] ?? null);
      return `$${rowIndex * columnNames.length + columnIndex + 1}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  await client.query(
    `INSERT INTO ${quoteIdentifier(table.name)} (${quotedColumns}) VALUES ${valueGroups.join(", ")} ON CONFLICT DO NOTHING`,
    values,
  );
}

async function resetPostgresSequences(
  postgres: PostgresDatabaseClient,
  tables: readonly SqliteSnapshotTable[],
): Promise<void> {
  for (const table of tables) {
    for (const column of table.columns.filter((candidate) => candidate.autoIncrement)) {
      try {
        await postgres.query(
          `
            SELECT setval(
              pg_get_serial_sequence($1, $2),
              COALESCE((SELECT MAX(${quoteIdentifier(column.name)}) FROM ${quoteIdentifier(table.name)}), 1),
              EXISTS (SELECT 1 FROM ${quoteIdentifier(table.name)} LIMIT 1)
            )
          `,
          [table.name, column.name],
        );
      } catch {
        // Keep cutover moving if a sequence is absent; parity verification will still catch missing rows.
      }
    }
  }
}

async function recordCutoverRun(
  postgres: PostgresDatabaseClient,
  input: {
    cutoverId: string;
    profile: DatabaseCutoverProfile;
    mode: "dry_run" | "execute";
    status: DatabaseCutoverStatus;
    startedAt: string;
    finishedAt: string;
    runtimeFlipReady: boolean;
    runtimeFlipBlockedReason?: string;
    backupId?: string;
    sourceSummary: Record<string, unknown>;
    resultJson: Record<string, unknown>;
  },
): Promise<void> {
  await postgres.query(
    `
      INSERT INTO database_cutover_runs (
        cutover_id,
        profile,
        mode,
        status,
        started_at,
        finished_at,
        runtime_flip_ready,
        runtime_flip_blocked_reason,
        backup_id,
        source_summary,
        result_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
      ON CONFLICT (cutover_id) DO UPDATE SET
        status = EXCLUDED.status,
        finished_at = EXCLUDED.finished_at,
        runtime_flip_ready = EXCLUDED.runtime_flip_ready,
        runtime_flip_blocked_reason = EXCLUDED.runtime_flip_blocked_reason,
        backup_id = EXCLUDED.backup_id,
        source_summary = EXCLUDED.source_summary,
        result_json = EXCLUDED.result_json
    `,
    [
      input.cutoverId,
      input.profile,
      input.mode,
      input.status,
      input.startedAt,
      input.finishedAt,
      input.runtimeFlipReady,
      input.runtimeFlipBlockedReason,
      input.backupId,
      JSON.stringify(input.sourceSummary),
      JSON.stringify(input.resultJson),
    ],
  );
}

async function countSessions(sqlitePath: string): Promise<number> {
  const stats = await statIfExists(sqlitePath);
  if (!stats?.isFile()) {
    return 0;
  }
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

async function countTranscriptEvents(transcriptsDir: string): Promise<number> {
  const files = await listFilesWithExtension(transcriptsDir, ".jsonl");
  let total = 0;
  for (const filePath of files) {
    total += countNonEmptyLines(await fs.readFile(filePath, "utf8"));
  }
  return total;
}

async function countAuditEvents(auditDir: string): Promise<number> {
  let total = 0;
  for (const stream of AUDIT_STREAMS) {
    const filePath = path.join(auditDir, `${stream}.jsonl`);
    const stats = await statIfExists(filePath);
    if (!stats?.isFile()) {
      continue;
    }
    total += countNonEmptyLines(await fs.readFile(filePath, "utf8"));
  }
  return total;
}

async function listFilesWithExtension(dir: string, extension: string): Promise<string[]> {
  const stats = await statIfExists(dir);
  if (!stats?.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function countNonEmptyLines(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  // eslint-disable-next-line no-console -- malformed legacy lines should be visible while rehearsing cutover imports.
  console.warn("[goatcitadel] database cutover skipped malformed JSONL line", {
    filePath,
    lineNumber,
  });
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function topologicallySortTables(tables: readonly SqliteSnapshotTable[]): SqliteSnapshotTable[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const remaining = new Set(tables.map((table) => table.name));
  const sorted: SqliteSnapshotTable[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((name) => byName.get(name))
      .filter((table): table is SqliteSnapshotTable => Boolean(table))
      .filter((table) =>
        table.foreignKeys.every(
          (foreignKey) => !remaining.has(foreignKey.referencedTable) || foreignKey.referencedTable === table.name,
        ),
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    if (ready.length === 0) {
      sorted.push(
        ...[...remaining]
          .map((name) => byName.get(name))
          .filter((table): table is SqliteSnapshotTable => Boolean(table))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
      break;
    }

    for (const table of ready) {
      remaining.delete(table.name);
      sorted.push(table);
    }
  }

  return sorted;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function statIfExists(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return undefined;
  }
}

function completeStep(steps: DatabaseCutoverStepRecord[], id: string, detail: string): void {
  const step = steps.find((item) => item.id === id);
  if (!step) {
    return;
  }
  step.status = "completed";
  step.detail = detail;
}

function skipStep(steps: DatabaseCutoverStepRecord[], id: string, detail: string): void {
  const step = steps.find((item) => item.id === id);
  if (!step) {
    return;
  }
  step.status = "skipped";
  step.detail = detail;
}

function failStep(steps: DatabaseCutoverStepRecord[], id: string, detail: string): void {
  const step = steps.find((item) => item.id === id);
  if (!step) {
    return;
  }
  step.status = "failed";
  step.detail = detail;
}

function blockStep(steps: DatabaseCutoverStepRecord[], id: string, detail: string): void {
  const step = steps.find((item) => item.id === id);
  if (!step) {
    return;
  }
  step.status = "blocked";
  step.detail = detail;
}

export const __databaseCutoverServiceInternals = {
  countAuditEvents,
  countNonEmptyLines,
  countTranscriptEvents,
  importSqliteRuntimeTables,
  importEventLogs,
  inspectSqliteSnapshot,
  insertRowsIntoPostgresTable,
  parseJsonLine,
  quoteIdentifier,
  recordCutoverRun,
  resetPostgresSequences,
  resolveExplicitSnapshot,
  resolveSnapshotFromBackup,
  summarizeSourceSnapshot,
  topologicallySortTables,
  verifyAgainstSource,
  completeStep,
  skipStep,
  failStep,
  blockStep,
};
