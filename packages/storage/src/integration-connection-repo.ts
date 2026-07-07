import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  IntegrationKind,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface IntegrationConnectionRow {
  connection_id: string;
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
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listStmt = db.prepare(`
      SELECT * FROM integration_connections
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);
    this.listByKindStmt = db.prepare(`
      SELECT * FROM integration_connections
      WHERE kind = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);
    this.getStmt = db.prepare("SELECT * FROM integration_connections WHERE connection_id = ?");
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
    },
    now = new Date().toISOString(),
  ): IntegrationConnection {
    const connectionId = randomUUID();
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
      lastSyncAt: null,
      lastError: null,
      workspaceId: input.workspaceId?.trim() || null,
    });
    return this.get(connectionId);
  }

  public update(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
    now = new Date().toISOString(),
  ): IntegrationConnection {
    const current = this.get(connectionId);
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
      updatedAt: now,
      lastSyncAt: input.lastSyncAt ?? current.lastSyncAt ?? null,
      lastError: input.lastError === undefined ? (current.lastError ?? null) : input.lastError,
      workspaceId: input.workspaceId === undefined ? (current.workspaceId ?? null) : input.workspaceId?.trim() || null,
    });
    return this.get(connectionId);
  }

  public delete(connectionId: string): boolean {
    const current = toIntegrationConnectionRow(this.getStmt.get(connectionId));
    if (!current) {
      return false;
    }
    this.deleteStmt.run(connectionId);
    return true;
  }
}

function mapRow(row: IntegrationConnectionRow): IntegrationConnection {
  return {
    connectionId: row.connection_id,
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
