import { randomUUID } from "node:crypto";
import { canonicalJsonString, ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type ProductSourceUpdateRiskClass = "caution" | "protected_core";

export interface ProductSourceChangedFileRecord {
  readonly path: string;
  readonly changeKind: "added" | "modified" | "deleted" | "renamed";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface ProductSourceValidationRecord {
  readonly proofId: string;
  readonly status: "passed" | "failed" | "timed_out" | "not_run";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly evidenceRef?: string;
}

/**
 * Immutable staging manifest. Artifact paths are private Gateway-owned relative
 * paths and this record must never be projected directly through a public API.
 */
export interface ProductSourceUpdateManifestRecord {
  readonly manifestId: string;
  readonly planId: string;
  readonly installId: string;
  readonly installRevision: number;
  readonly baseSha: string;
  readonly baseTree: string;
  readonly patchSha256: string;
  readonly patchArtifactRelPath: string;
  readonly rollbackSha256: string;
  readonly rollbackArtifactRelPath: string;
  readonly changedFiles: readonly ProductSourceChangedFileRecord[];
  readonly validations: readonly ProductSourceValidationRecord[];
  readonly riskClass: ProductSourceUpdateRiskClass;
  readonly protectedAreas: readonly string[];
  readonly codeModeRunId: string;
  readonly manifestSha256: string;
  readonly createdAt: string;
}

export type ProductSourceUpdateEventType =
  | "staged"
  | "base_approval_requested"
  | "protected_approval_requested"
  | "apply_launched"
  | "apply_succeeded"
  | "smoke_failed"
  | "rollback_started"
  | "rollback_succeeded"
  | "rollback_failed"
  | "manual_required";

export interface ProductSourceUpdateEventRecord {
  readonly eventId: string;
  readonly manifestId: string;
  readonly sequence: number;
  readonly eventType: ProductSourceUpdateEventType;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ProductSourceUpdateManifestCreateInput {
  readonly planId: string;
  readonly installId: string;
  readonly installRevision: number;
  readonly baseSha: string;
  readonly baseTree: string;
  readonly patchSha256: string;
  readonly patchArtifactRelPath: string;
  readonly rollbackSha256: string;
  readonly rollbackArtifactRelPath: string;
  readonly changedFiles: readonly ProductSourceChangedFileRecord[];
  readonly validations: readonly ProductSourceValidationRecord[];
  readonly riskClass: ProductSourceUpdateRiskClass;
  readonly protectedAreas: readonly string[];
  readonly codeModeRunId: string;
  readonly manifestSha256: string;
}

export const PRODUCT_SOURCE_UPDATE_SQLITE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS product_source_update_manifests (
    manifest_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE,
    install_id TEXT NOT NULL,
    install_revision INTEGER NOT NULL CHECK(install_revision >= 1),
    base_sha TEXT NOT NULL,
    base_tree TEXT NOT NULL,
    patch_sha256 TEXT NOT NULL,
    patch_artifact_rel_path TEXT NOT NULL,
    rollback_sha256 TEXT NOT NULL,
    rollback_artifact_rel_path TEXT NOT NULL,
    changed_files_json TEXT NOT NULL CHECK(json_valid(changed_files_json) AND json_type(changed_files_json) = 'array'),
    validations_json TEXT NOT NULL CHECK(json_valid(validations_json) AND json_type(validations_json) = 'array'),
    risk_class TEXT NOT NULL CHECK(risk_class IN ('caution', 'protected_core')),
    protected_areas_json TEXT NOT NULL CHECK(json_valid(protected_areas_json) AND json_type(protected_areas_json) = 'array'),
    code_mode_run_id TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_product_source_update_manifests_install
    ON product_source_update_manifests(install_id, created_at DESC, manifest_id DESC);
  CREATE TABLE IF NOT EXISTS product_source_update_events (
    event_id TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    event_type TEXT NOT NULL CHECK(event_type IN (
      'staged', 'base_approval_requested', 'protected_approval_requested', 'apply_launched',
      'apply_succeeded', 'smoke_failed', 'rollback_started', 'rollback_succeeded',
      'rollback_failed', 'manual_required'
    )),
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
    created_at TEXT NOT NULL,
    UNIQUE(manifest_id, sequence),
    UNIQUE(manifest_id, idempotency_key),
    FOREIGN KEY(manifest_id) REFERENCES product_source_update_manifests(manifest_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_product_source_update_events_manifest
    ON product_source_update_events(manifest_id, sequence ASC);
  CREATE TRIGGER IF NOT EXISTS trg_product_source_update_manifests_immutable_update
    BEFORE UPDATE ON product_source_update_manifests BEGIN
      SELECT RAISE(ABORT, 'product source update manifests are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_product_source_update_manifests_immutable_delete
    BEFORE DELETE ON product_source_update_manifests BEGIN
      SELECT RAISE(ABORT, 'product source update manifests are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_product_source_update_events_immutable_update
    BEFORE UPDATE ON product_source_update_events BEGIN
      SELECT RAISE(ABORT, 'product source update events are append-only');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_product_source_update_events_immutable_delete
    BEFORE DELETE ON product_source_update_events BEGIN
      SELECT RAISE(ABORT, 'product source update events are append-only');
    END;
`;

export const PRODUCT_SOURCE_UPDATE_POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS product_source_update_manifests (
    manifest_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE,
    install_id TEXT NOT NULL,
    install_revision BIGINT NOT NULL CHECK(install_revision >= 1),
    base_sha TEXT NOT NULL,
    base_tree TEXT NOT NULL,
    patch_sha256 TEXT NOT NULL,
    patch_artifact_rel_path TEXT NOT NULL,
    rollback_sha256 TEXT NOT NULL,
    rollback_artifact_rel_path TEXT NOT NULL,
    changed_files_json TEXT NOT NULL CHECK(jsonb_typeof(changed_files_json::jsonb) = 'array'),
    validations_json TEXT NOT NULL CHECK(jsonb_typeof(validations_json::jsonb) = 'array'),
    risk_class TEXT NOT NULL CHECK(risk_class IN ('caution', 'protected_core')),
    protected_areas_json TEXT NOT NULL CHECK(jsonb_typeof(protected_areas_json::jsonb) = 'array'),
    code_mode_run_id TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_product_source_update_manifests_install
    ON product_source_update_manifests(install_id, created_at DESC, manifest_id DESC);
  CREATE TABLE IF NOT EXISTS product_source_update_events (
    event_id TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL REFERENCES product_source_update_manifests(manifest_id) ON DELETE RESTRICT,
    sequence BIGINT NOT NULL CHECK(sequence >= 1),
    event_type TEXT NOT NULL CHECK(event_type IN (
      'staged', 'base_approval_requested', 'protected_approval_requested', 'apply_launched',
      'apply_succeeded', 'smoke_failed', 'rollback_started', 'rollback_succeeded',
      'rollback_failed', 'manual_required'
    )),
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(jsonb_typeof(payload_json::jsonb) = 'object'),
    created_at TEXT NOT NULL,
    UNIQUE(manifest_id, sequence),
    UNIQUE(manifest_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_product_source_update_events_manifest
    ON product_source_update_events(manifest_id, sequence ASC);
  CREATE OR REPLACE FUNCTION gc_reject_product_source_update_mutation()
  RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'product source update evidence is immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_product_source_update_manifests_immutable_update ON product_source_update_manifests;
  CREATE TRIGGER trg_product_source_update_manifests_immutable_update
    BEFORE UPDATE ON product_source_update_manifests
    FOR EACH ROW EXECUTE FUNCTION gc_reject_product_source_update_mutation();
  DROP TRIGGER IF EXISTS trg_product_source_update_manifests_immutable_delete ON product_source_update_manifests;
  CREATE TRIGGER trg_product_source_update_manifests_immutable_delete
    BEFORE DELETE ON product_source_update_manifests
    FOR EACH ROW EXECUTE FUNCTION gc_reject_product_source_update_mutation();
  DROP TRIGGER IF EXISTS trg_product_source_update_events_immutable_update ON product_source_update_events;
  CREATE TRIGGER trg_product_source_update_events_immutable_update
    BEFORE UPDATE ON product_source_update_events
    FOR EACH ROW EXECUTE FUNCTION gc_reject_product_source_update_mutation();
  DROP TRIGGER IF EXISTS trg_product_source_update_events_immutable_delete ON product_source_update_events;
  CREATE TRIGGER trg_product_source_update_events_immutable_delete
    BEFORE DELETE ON product_source_update_events
    FOR EACH ROW EXECUTE FUNCTION gc_reject_product_source_update_mutation();
`;

interface ManifestRow {
  manifest_id: string;
  plan_id: string;
  install_id: string;
  install_revision: number | string;
  base_sha: string;
  base_tree: string;
  patch_sha256: string;
  patch_artifact_rel_path: string;
  rollback_sha256: string;
  rollback_artifact_rel_path: string;
  changed_files_json: string;
  validations_json: string;
  risk_class: ProductSourceUpdateRiskClass;
  protected_areas_json: string;
  code_mode_run_id: string;
  manifest_sha256: string;
  created_at: string;
}

interface EventRow {
  event_id: string;
  manifest_id: string;
  sequence: number | string;
  event_type: ProductSourceUpdateEventType;
  idempotency_key: string;
  payload_json: string;
  created_at: string;
}

export class ProductSourceUpdateRepository {
  private readonly insertManifestStmt;
  private readonly getManifestStmt;
  private readonly findByPlanStmt;
  private readonly getEventByKeyStmt;
  private readonly latestSequenceStmt;
  private readonly insertEventStmt;
  private readonly listEventsStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertManifestStmt = db.prepare(`
      INSERT INTO product_source_update_manifests (
        manifest_id, plan_id, install_id, install_revision, base_sha, base_tree,
        patch_sha256, patch_artifact_rel_path, rollback_sha256, rollback_artifact_rel_path,
        changed_files_json, validations_json, risk_class, protected_areas_json,
        code_mode_run_id, manifest_sha256, created_at
      ) VALUES (
        @manifestId, @planId, @installId, @installRevision, @baseSha, @baseTree,
        @patchSha256, @patchArtifactRelPath, @rollbackSha256, @rollbackArtifactRelPath,
        @changedFilesJson, @validationsJson, @riskClass, @protectedAreasJson,
        @codeModeRunId, @manifestSha256, @createdAt
      )
    `);
    this.getManifestStmt = db.prepare("SELECT * FROM product_source_update_manifests WHERE manifest_id = ?");
    this.findByPlanStmt = db.prepare("SELECT * FROM product_source_update_manifests WHERE plan_id = ?");
    this.getEventByKeyStmt = db.prepare(
      "SELECT * FROM product_source_update_events WHERE manifest_id = @manifestId AND idempotency_key = @idempotencyKey",
    );
    this.latestSequenceStmt = db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM product_source_update_events WHERE manifest_id = ?",
    );
    this.insertEventStmt = db.prepare(`
      INSERT INTO product_source_update_events (
        event_id, manifest_id, sequence, event_type, idempotency_key, payload_json, created_at
      ) VALUES (@eventId, @manifestId, @sequence, @eventType, @idempotencyKey, @payloadJson, @createdAt)
    `);
    this.listEventsStmt = db.prepare(
      "SELECT * FROM product_source_update_events WHERE manifest_id = ? ORDER BY sequence ASC",
    );
  }

  public createManifest(input: ProductSourceUpdateManifestCreateInput): ProductSourceUpdateManifestRecord {
    const normalized = normalizeManifestCreate(input);
    const manifestId = `source-update-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    try {
      this.insertManifestStmt.run({
        manifestId,
        planId: normalized.planId,
        installId: normalized.installId,
        installRevision: normalized.installRevision,
        baseSha: normalized.baseSha,
        baseTree: normalized.baseTree,
        patchSha256: normalized.patchSha256,
        patchArtifactRelPath: normalized.patchArtifactRelPath,
        rollbackSha256: normalized.rollbackSha256,
        rollbackArtifactRelPath: normalized.rollbackArtifactRelPath,
        changedFilesJson: canonicalJsonString(normalized.changedFiles),
        validationsJson: canonicalJsonString(normalized.validations),
        riskClass: normalized.riskClass,
        protectedAreasJson: canonicalJsonString(normalized.protectedAreas),
        codeModeRunId: normalized.codeModeRunId,
        manifestSha256: normalized.manifestSha256,
        createdAt,
      });
    } catch (error) {
      const replay = this.findByPlan(normalized.planId);
      if (replay && replay.manifestSha256 === normalized.manifestSha256) return replay;
      throw error;
    }
    this.appendEvent(manifestId, {
      expectedSequence: 0,
      eventType: "staged",
      idempotencyKey: `staged:${normalized.manifestSha256}`,
      payload: { manifestSha256: normalized.manifestSha256 },
    });
    return this.getManifest(manifestId);
  }

  public getManifest(manifestId: string): ProductSourceUpdateManifestRecord {
    const row = this.getManifestStmt.get(identifier(manifestId, "manifestId")) as ManifestRow | undefined;
    if (!row) throw new NotFoundError({ entity: "Product source update manifest", id: manifestId });
    return mapManifest(row);
  }

  public findByPlan(planId: string): ProductSourceUpdateManifestRecord | undefined {
    const row = this.findByPlanStmt.get(identifier(planId, "planId")) as ManifestRow | undefined;
    return row ? mapManifest(row) : undefined;
  }

  public appendEvent(
    manifestIdInput: string,
    input: {
      expectedSequence: number;
      eventType: ProductSourceUpdateEventType;
      idempotencyKey: string;
      payload?: Readonly<Record<string, unknown>>;
    },
  ): ProductSourceUpdateEventRecord {
    const manifestId = identifier(manifestIdInput, "manifestId");
    this.getManifest(manifestId);
    const idempotencyKey = bounded(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      const replay = this.getEventByKeyStmt.get({ manifestId, idempotencyKey }) as EventRow | undefined;
      if (replay) return mapEvent(replay);
      const sequenceRow = this.latestSequenceStmt.get(manifestId) as { sequence: number | string } | undefined;
      const currentSequence = positiveOrZero(sequenceRow?.sequence ?? 0, "event sequence");
      if (input.expectedSequence !== currentSequence) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Product source update journal changed before this transition.",
          details: { manifestId, expectedSequence: input.expectedSequence, currentSequence },
        });
      }
      const payload = input.payload ?? {};
      const payloadJson = canonicalJsonString(payload);
      if (Buffer.byteLength(payloadJson, "utf8") > 16_384)
        throw new TypeError("Product source update event payload is too large.");
      const eventId = randomUUID();
      this.insertEventStmt.run({
        eventId,
        manifestId,
        sequence: currentSequence + 1,
        eventType: requireEventType(input.eventType),
        idempotencyKey,
        payloadJson,
        createdAt: new Date().toISOString(),
      });
      const created = this.getEventByKeyStmt.get({ manifestId, idempotencyKey }) as EventRow | undefined;
      if (!created) throw new Error("Product source update event insert was not observable.");
      return mapEvent(created);
    });
  }

  public listEvents(manifestId: string): ProductSourceUpdateEventRecord[] {
    this.getManifest(manifestId);
    return (this.listEventsStmt.all(identifier(manifestId, "manifestId")) as EventRow[]).map(mapEvent);
  }
}

function normalizeManifestCreate(
  input: ProductSourceUpdateManifestCreateInput,
): ProductSourceUpdateManifestCreateInput {
  const changedFiles = input.changedFiles.map((entry) => ({
    path: relativePath(entry.path),
    changeKind: entry.changeKind,
    ...(entry.beforeSha256 ? { beforeSha256: sha256(entry.beforeSha256, "beforeSha256") } : {}),
    ...(entry.afterSha256 ? { afterSha256: sha256(entry.afterSha256, "afterSha256") } : {}),
  }));
  if (changedFiles.length < 1 || changedFiles.length > 2_000)
    throw new TypeError("Product source update changed-file inventory is invalid.");
  const validations = input.validations.map((entry) => ({
    proofId: identifier(entry.proofId, "proofId"),
    status: entry.status,
    ...(entry.exitCode !== undefined ? { exitCode: boundedInteger(entry.exitCode, "exitCode", -1, 255) } : {}),
    ...(entry.durationMs !== undefined
      ? { durationMs: boundedInteger(entry.durationMs, "durationMs", 0, 86_400_000) }
      : {}),
    ...(entry.evidenceRef ? { evidenceRef: bounded(entry.evidenceRef, "evidenceRef", 512) } : {}),
  }));
  if (validations.length < 1 || validations.length > 64)
    throw new TypeError("Product source update validation inventory is invalid.");
  if (!validations.every((entry) => ["passed", "failed", "timed_out", "not_run"].includes(entry.status))) {
    throw new TypeError("Product source update validation status is invalid.");
  }
  const protectedAreas = [...new Set(input.protectedAreas.map((item) => identifier(item, "protectedArea")))].sort();
  return {
    planId: identifier(input.planId, "planId"),
    installId: identifier(input.installId, "installId"),
    installRevision: boundedInteger(input.installRevision, "installRevision", 1, Number.MAX_SAFE_INTEGER),
    baseSha: gitObject(input.baseSha, "baseSha"),
    baseTree: gitObject(input.baseTree, "baseTree"),
    patchSha256: sha256(input.patchSha256, "patchSha256"),
    patchArtifactRelPath: relativePath(input.patchArtifactRelPath),
    rollbackSha256: sha256(input.rollbackSha256, "rollbackSha256"),
    rollbackArtifactRelPath: relativePath(input.rollbackArtifactRelPath),
    changedFiles,
    validations,
    riskClass: input.riskClass === "protected_core" ? "protected_core" : "caution",
    protectedAreas,
    codeModeRunId: identifier(input.codeModeRunId, "codeModeRunId"),
    manifestSha256: sha256(input.manifestSha256, "manifestSha256"),
  };
}

function mapManifest(row: ManifestRow): ProductSourceUpdateManifestRecord {
  return {
    manifestId: identifier(row.manifest_id, "manifestId"),
    planId: identifier(row.plan_id, "planId"),
    installId: identifier(row.install_id, "installId"),
    installRevision: boundedInteger(Number(row.install_revision), "installRevision", 1, Number.MAX_SAFE_INTEGER),
    baseSha: gitObject(row.base_sha, "baseSha"),
    baseTree: gitObject(row.base_tree, "baseTree"),
    patchSha256: sha256(row.patch_sha256, "patchSha256"),
    patchArtifactRelPath: relativePath(row.patch_artifact_rel_path),
    rollbackSha256: sha256(row.rollback_sha256, "rollbackSha256"),
    rollbackArtifactRelPath: relativePath(row.rollback_artifact_rel_path),
    changedFiles: parseJsonArray<ProductSourceChangedFileRecord>(row.changed_files_json, "changedFiles"),
    validations: parseJsonArray<ProductSourceValidationRecord>(row.validations_json, "validations"),
    riskClass: row.risk_class,
    protectedAreas: parseJsonArray<string>(row.protected_areas_json, "protectedAreas"),
    codeModeRunId: identifier(row.code_mode_run_id, "codeModeRunId"),
    manifestSha256: sha256(row.manifest_sha256, "manifestSha256"),
    createdAt: timestamp(row.created_at),
  };
}

function mapEvent(row: EventRow): ProductSourceUpdateEventRecord {
  return {
    eventId: identifier(row.event_id, "eventId"),
    manifestId: identifier(row.manifest_id, "manifestId"),
    sequence: boundedInteger(Number(row.sequence), "sequence", 1, Number.MAX_SAFE_INTEGER),
    eventType: requireEventType(row.event_type),
    idempotencyKey: bounded(row.idempotency_key, "idempotencyKey", 512),
    payload: parseObject(row.payload_json, "payload"),
    createdAt: timestamp(row.created_at),
  };
}

const EVENT_TYPES = new Set<ProductSourceUpdateEventType>([
  "staged",
  "base_approval_requested",
  "protected_approval_requested",
  "apply_launched",
  "apply_succeeded",
  "smoke_failed",
  "rollback_started",
  "rollback_succeeded",
  "rollback_failed",
  "manual_required",
]);

function requireEventType(value: string): ProductSourceUpdateEventType {
  if (!EVENT_TYPES.has(value as ProductSourceUpdateEventType))
    throw new TypeError("Product source update event type is invalid.");
  return value as ProductSourceUpdateEventType;
}

function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError(`Product source update ${label} is invalid.`);
  return parsed as T[];
}

function parseObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError(`Product source update ${label} is invalid.`);
  return parsed as Record<string, unknown>;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(normalized) || normalized.includes("..")) {
    throw new TypeError(`Product source update ${label} is invalid.`);
  }
  return normalized;
}

function relativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.length > 2_048 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new TypeError("Product source update artifact/file path is invalid.");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\0\r\n]/u.test(part))) {
    throw new TypeError("Product source update artifact/file path is unsafe.");
  }
  return parts.join("/");
}

function sha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new TypeError(`Product source update ${label} is invalid.`);
  return normalized;
}

function gitObject(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) throw new TypeError(`Product source update ${label} is invalid.`);
  return normalized;
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0\r\n]/u.test(normalized))
    throw new TypeError(`Product source update ${label} is invalid.`);
  return normalized;
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`Product source update ${label} is invalid.`);
  return value;
}

function positiveOrZero(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`Product source update ${label} is invalid.`);
  return parsed;
}

function timestamp(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new TypeError("Product source update timestamp is invalid.");
  return value;
}
