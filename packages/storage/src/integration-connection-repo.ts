import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  IntegrationKind,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface IntegrationConnectionRow {
  connection_id: string;
  revision_generation: string;
  catalog_id: string;
  kind: IntegrationKind;
  integration_key: string;
  label: string;
  enabled: number;
  status: IntegrationConnection["status"];
  config_json: string;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  plugin_id: string | null;
  plugin_version: string | null;
  plugin_enabled: number | null;
  plugin_meta_json: string | null;
  workspace_id: string | null;
}

export class IntegrationConnectionRepository {
  private readonly listStmt;
  private readonly listByKindStmt;
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    const select = `SELECT c.*, COALESCE(CAST(r.generation AS TEXT), '0') AS revision_generation
      FROM integration_connections c LEFT JOIN integration_connection_revisions r ON r.connection_id = c.connection_id`;
    this.listStmt = db.prepare(`
      ${select}
      ORDER BY c.updated_at DESC, c.created_at DESC, c.connection_id ASC
      LIMIT ?
    `);
    this.listByKindStmt = db.prepare(`
      ${select}
      WHERE c.kind = ?
      ORDER BY c.updated_at DESC, c.created_at DESC, c.connection_id ASC
      LIMIT ?
    `);
    this.getStmt = db.prepare(`${select} WHERE c.connection_id = ?`);
    this.getForUpdateStmt = db.prepare(`${select} WHERE c.connection_id = ?${db.dialect === "postgres" ? " FOR UPDATE OF c" : ""}`);
    this.insertStmt = db.prepare(`
      INSERT INTO integration_connections (
        connection_id, catalog_id, kind, integration_key, label, enabled, status,
        config_json, plugin_id, plugin_version, plugin_enabled, plugin_meta_json,
        created_at, updated_at, last_sync_at, last_error, workspace_id
      ) VALUES (
        @connectionId, @catalogId, @kind, @integrationKey, @label, @enabled, @status,
        @configJson, @pluginId, @pluginVersion, @pluginEnabled, @pluginMetaJson,
        @createdAt, @updatedAt, @lastSyncAt, @lastError, @workspaceId
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE integration_connections
      SET
        label = @label,
        enabled = @enabled,
        status = @status,
        config_json = @configJson,
        plugin_id = @pluginId,
        plugin_version = @pluginVersion,
        plugin_enabled = @pluginEnabled,
        plugin_meta_json = @pluginMetaJson,
        updated_at = @updatedAt,
        last_sync_at = @lastSyncAt,
        last_error = @lastError,
        workspace_id = @workspaceId
      WHERE connection_id = @connectionId
    `);
    this.deleteStmt = db.prepare("DELETE FROM integration_connections WHERE connection_id = ?");
  }

  public list(kind?: IntegrationKind, limit = 200): IntegrationConnection[] {
    const rows = toIntegrationConnectionRows(kind ? this.listByKindStmt.all(kind, limit) : this.listStmt.all(limit));
    return rows.map(mapRow);
  }

  public get(connectionId: string): IntegrationConnection {
    const row = toIntegrationConnectionRow(this.getStmt.get(connectionId));
    if (!row) {
      throw new NotFoundError({ entity: "Integration connection", id: connectionId });
    }
    return mapRow(row);
  }

  public create(
    input: IntegrationConnectionCreateInput & {
      catalogId: string;
      kind: IntegrationKind;
      key: string;
      label: string;
      /** Internal identity reservation for atomic channel finalization. Public routes do not accept this. */
      connectionId?: string;
      lastSyncAt?: string;
    },
    now = new Date().toISOString(),
  ): IntegrationConnection {
    const connectionId = input.connectionId ?? randomUUID();
    return this.withLock(connectionId, () => {
      this.insertStmt.run({
        connectionId,
        catalogId: input.catalogId,
        kind: input.kind,
        integrationKey: input.key,
        label: input.label,
        enabled: (input.enabled ?? true) ? 1 : 0,
        status: input.status ?? "connected",
        configJson: JSON.stringify(input.config ?? {}),
        pluginId: input.pluginId ?? null,
        pluginVersion: input.pluginVersion ?? null,
        pluginEnabled: input.pluginEnabled ? 1 : 0,
        pluginMetaJson: null,
        createdAt: now,
        updatedAt: now,
        lastSyncAt: input.lastSyncAt ?? null,
        lastError: null,
        workspaceId: input.workspaceId?.trim() || null,
      });
      this.advance(connectionId);
      return this.get(connectionId);
    });
  }

  public update(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
    now = new Date().toISOString(),
  ): IntegrationConnection {
    return this.withLock(connectionId, () => {
      const current = this.readForUpdate(connectionId);
      this.checkRevision(current, input.expectedRevision);
      const previousTime = Date.parse(current.updatedAt);
      const requestedTime = Date.parse(now);
      const updatedAt = new Date(Math.max(Number.isFinite(requestedTime) ? requestedTime : Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      this.updateStmt.run({
        connectionId,
        label: input.label ?? current.label,
        enabled: input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        status: input.status ?? current.status,
        configJson: JSON.stringify(input.config ?? current.config),
        pluginId: input.pluginId ?? current.pluginId ?? null,
        pluginVersion: input.pluginVersion ?? current.pluginVersion ?? null,
        pluginEnabled: input.pluginEnabled === undefined ? (current.pluginEnabled ? 1 : 0) : input.pluginEnabled ? 1 : 0,
        pluginMetaJson: null,
        updatedAt,
        lastSyncAt: input.lastSyncAt ?? current.lastSyncAt ?? null,
        lastError: input.lastError === undefined ? (current.lastError ?? null) : input.lastError,
        workspaceId: input.workspaceId === undefined ? (current.workspaceId ?? null) : input.workspaceId?.trim() || null,
      });
      this.advance(connectionId);
      return this.get(connectionId);
    });
  }

  public delete(connectionId: string, expectedRevision?: string): boolean {
    return this.withLock(connectionId, () => {
      const row = toIntegrationConnectionRow(this.getForUpdateStmt.get(connectionId));
      if (!row) {
        if (expectedRevision !== undefined) throw new NotFoundError({ entity: "Integration connection", id: connectionId });
        return false;
      }
      this.checkRevision(mapRow(row), expectedRevision);
      this.deleteStmt.run(connectionId);
      this.advance(connectionId);
      return true;
    });
  }

  private readForUpdate(connectionId: string): IntegrationConnection {
    const row = toIntegrationConnectionRow(this.getForUpdateStmt.get(connectionId));
    if (!row) throw new NotFoundError({ entity: "Integration connection", id: connectionId });
    return mapRow(row);
  }

  private checkRevision(current: IntegrationConnection, expectedRevision: string | undefined): void {
    if (expectedRevision === undefined) return;
    if (!/^[a-f0-9]{64}$/.test(expectedRevision ?? "")) throw new ValidationError({ message: "Review the integration connection before changing it." });
    if (current.revision !== expectedRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The integration connection changed. Review its current settings before retrying.", details: { reason: "INTEGRATION_CONNECTION_REVISION_CONFLICT" } });
  }

  private withLock<T>(connectionId: string, action: () => T): T {
    return this.db.transaction("immediate", () => {
      if (this.db.dialect === "postgres") this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 542))").get({ lockKey: `integration-connection:${connectionId}` });
      return action();
    });
  }

  private advance(connectionId: string): void {
    this.db.prepare(`INSERT INTO integration_connection_revisions (connection_id, generation) VALUES (@connectionId, 1)
      ON CONFLICT (connection_id) DO UPDATE SET generation = integration_connection_revisions.generation + 1`).run({ connectionId });
  }
}

function mapRow(row: IntegrationConnectionRow): IntegrationConnection {
  return {
    connectionId: row.connection_id,
    revision: createHash("sha256").update(JSON.stringify({ schemaVersion: "integration.connection.v1", connectionId: row.connection_id, generation: row.revision_generation })).digest("hex"),
    catalogId: row.catalog_id,
    kind: row.kind,
    key: row.integration_key,
    label: row.label,
    enabled: Boolean(row.enabled),
    status: row.status,
    config: safeJsonParse<Record<string, unknown>>(row.config_json, {}),
    pluginId: row.plugin_id ?? undefined,
    pluginVersion: row.plugin_version ?? undefined,
    pluginEnabled: Boolean(row.plugin_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncAt: row.last_sync_at ?? undefined,
    lastError: row.last_error ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
  };
}

function toIntegrationConnectionRow(value: unknown): IntegrationConnectionRow | undefined {
  return isIntegrationConnectionRow(value) ? value : undefined;
}

function toIntegrationConnectionRows(value: unknown): IntegrationConnectionRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isIntegrationConnectionRow);
}

function isIntegrationConnectionRow(value: unknown): value is IntegrationConnectionRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.connection_id === "string" &&
    typeof value.catalog_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.integration_key === "string" &&
    typeof value.label === "string" &&
    typeof value.enabled === "number" &&
    typeof value.status === "string" &&
    typeof value.config_json === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.last_sync_at === "string" || value.last_sync_at === null) &&
    (typeof value.last_error === "string" || value.last_error === null) &&
    (typeof value.plugin_id === "string" || value.plugin_id === null) &&
    (typeof value.plugin_version === "string" || value.plugin_version === null) &&
    (typeof value.plugin_enabled === "number" || value.plugin_enabled === null) &&
    (typeof value.plugin_meta_json === "string" || value.plugin_meta_json === null) &&
    (typeof value.workspace_id === "string" || value.workspace_id === null || value.workspace_id === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
