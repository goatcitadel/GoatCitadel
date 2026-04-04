import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFailureCategory,
  ChannelSetupLifecycleMode,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChannelSetupDraftRow {
  draft_id: string;
  catalog_id: string;
  connection_id: string | null;
  lifecycle_mode: ChannelSetupLifecycleMode;
  label: string | null;
  enabled: number;
  draft_json: string;
  hydration_json: string | null;
  content_version: string;
  adapter_version: string;
  validation_version: string;
  test_version: string;
  last_validated_at: string | null;
  last_tested_at: string | null;
  last_failure_category: ChannelSetupFailureCategory | null;
  created_at: string;
  updated_at: string;
}

export class ChannelSetupDraftRepository {
  private readonly getStmt;
  private readonly listByCatalogStmt;
  private readonly listByConnectionStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM channel_setup_drafts WHERE draft_id = ?");
    this.listByCatalogStmt = db.prepare(`
      SELECT * FROM channel_setup_drafts
      WHERE catalog_id = @catalogId
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `);
    this.listByConnectionStmt = db.prepare(`
      SELECT * FROM channel_setup_drafts
      WHERE connection_id = @connectionId
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO channel_setup_drafts (
        draft_id, catalog_id, connection_id, lifecycle_mode, label, enabled, draft_json, hydration_json,
        content_version, adapter_version, validation_version, test_version,
        last_validated_at, last_tested_at, last_failure_category, created_at, updated_at
      ) VALUES (
        @draftId, @catalogId, @connectionId, @lifecycleMode, @label, @enabled, @draftJson, @hydrationJson,
        @contentVersion, @adapterVersion, @validationVersion, @testVersion,
        @lastValidatedAt, @lastTestedAt, @lastFailureCategory, @createdAt, @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE channel_setup_drafts
      SET
        label = @label,
        enabled = @enabled,
        draft_json = @draftJson,
        hydration_json = @hydrationJson,
        content_version = @contentVersion,
        adapter_version = @adapterVersion,
        validation_version = @validationVersion,
        test_version = @testVersion,
        last_validated_at = @lastValidatedAt,
        last_tested_at = @lastTestedAt,
        last_failure_category = @lastFailureCategory,
        updated_at = @updatedAt
      WHERE draft_id = @draftId
    `);
    this.deleteStmt = db.prepare("DELETE FROM channel_setup_drafts WHERE draft_id = ?");
  }

  public get(draftId: string): ChannelSetupDraft {
    const row = this.getStmt.get(draftId) as ChannelSetupDraftRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Channel setup draft", id: draftId });
    }
    return mapRow(row);
  }

  public listByCatalog(catalogId: string, limit = 50): ChannelSetupDraft[] {
    const rows = this.listByCatalogStmt.all({ catalogId, limit });
    assertChannelSetupDraftRows(rows);
    return rows.map(mapRow);
  }

  public listByConnection(connectionId: string, limit = 50): ChannelSetupDraft[] {
    const rows = this.listByConnectionStmt.all({ connectionId, limit });
    assertChannelSetupDraftRows(rows);
    return rows.map(mapRow);
  }

  public create(
    input: ChannelSetupDraftCreateInput & {
      lifecycleMode: ChannelSetupLifecycleMode;
      enabled: boolean;
      label?: string;
      draft?: Record<string, unknown>;
      hydration?: ChannelSetupDraft["hydration"];
      contentVersion: string;
      adapterVersion: string;
      validationVersion: string;
      testVersion: string;
    },
    now = new Date().toISOString(),
  ): ChannelSetupDraft {
    const draftId = randomUUID();
    this.insertStmt.run({
      draftId,
      catalogId: input.catalogId,
      connectionId: input.connectionId ?? null,
      lifecycleMode: input.lifecycleMode,
      label: input.label ?? null,
      enabled: input.enabled ? 1 : 0,
      draftJson: JSON.stringify(input.draft ?? {}),
      hydrationJson: input.hydration ? JSON.stringify(input.hydration) : null,
      contentVersion: input.contentVersion,
      adapterVersion: input.adapterVersion,
      validationVersion: input.validationVersion,
      testVersion: input.testVersion,
      lastValidatedAt: null,
      lastTestedAt: null,
      lastFailureCategory: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(draftId);
  }

  public update(
    draftId: string,
    input: ChannelSetupDraftUpdateInput & {
      hydration?: ChannelSetupDraft["hydration"];
      contentVersion?: string;
      adapterVersion?: string;
      validationVersion?: string;
      testVersion?: string;
      lastValidatedAt?: string;
      lastTestedAt?: string;
    },
    now = new Date().toISOString(),
  ): ChannelSetupDraft {
    const current = this.get(draftId);
    this.updateStmt.run({
      draftId,
      label: input.label === undefined ? (current.label ?? null) : input.label ?? null,
      enabled: input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
      draftJson: JSON.stringify(input.draft ?? current.draft),
      hydrationJson: JSON.stringify(input.hydration ?? current.hydration ?? null),
      contentVersion: input.contentVersion ?? current.contentVersion,
      adapterVersion: input.adapterVersion ?? current.adapterVersion,
      validationVersion: input.validationVersion ?? current.validationVersion,
      testVersion: input.testVersion ?? current.testVersion,
      lastValidatedAt: input.lastValidatedAt ?? current.lastValidatedAt ?? null,
      lastTestedAt: input.lastTestedAt ?? current.lastTestedAt ?? null,
      lastFailureCategory: input.lastFailureCategory === undefined
        ? (current.lastFailureCategory ?? null)
        : input.lastFailureCategory,
      updatedAt: now,
    });
    return this.get(draftId);
  }

  public delete(draftId: string): boolean {
    const row = this.getStmt.get(draftId) as ChannelSetupDraftRow | undefined;
    if (!row) {
      return false;
    }
    this.deleteStmt.run(draftId);
    return true;
  }
}

function mapRow(row: ChannelSetupDraftRow): ChannelSetupDraft {
  return {
    draftId: row.draft_id,
    catalogId: row.catalog_id,
    connectionId: row.connection_id ?? undefined,
    lifecycleMode: row.lifecycle_mode,
    label: row.label ?? undefined,
    enabled: Boolean(row.enabled),
    draft: safeJsonParse<Record<string, unknown>>(row.draft_json, {}),
    hydration: row.hydration_json
      ? safeJsonParse<ChannelSetupDraft["hydration"] | undefined>(row.hydration_json, undefined)
      : undefined,
    contentVersion: row.content_version,
    adapterVersion: row.adapter_version,
    validationVersion: row.validation_version,
    testVersion: row.test_version,
    lastValidatedAt: row.last_validated_at ?? undefined,
    lastTestedAt: row.last_tested_at ?? undefined,
    lastFailureCategory: row.last_failure_category ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertChannelSetupDraftRows(rows: unknown): asserts rows is ChannelSetupDraftRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isChannelSetupDraftRow(row))) {
    throw new TypeError("Unexpected channel setup draft row shape");
  }
}

function isChannelSetupDraftRow(value: unknown): value is ChannelSetupDraftRow {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.draft_id === "string"
    && typeof value.catalog_id === "string"
    && (typeof value.connection_id === "string" || value.connection_id === null)
    && typeof value.lifecycle_mode === "string"
    && (typeof value.label === "string" || value.label === null)
    && typeof value.enabled === "number"
    && typeof value.draft_json === "string"
    && (typeof value.hydration_json === "string" || value.hydration_json === null)
    && typeof value.content_version === "string"
    && typeof value.adapter_version === "string"
    && typeof value.validation_version === "string"
    && typeof value.test_version === "string"
    && (typeof value.last_validated_at === "string" || value.last_validated_at === null)
    && (typeof value.last_tested_at === "string" || value.last_tested_at === null)
    && (typeof value.last_failure_category === "string" || value.last_failure_category === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
