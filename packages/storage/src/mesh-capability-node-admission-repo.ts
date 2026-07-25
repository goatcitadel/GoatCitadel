import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  canonicalJsonString,
  type MeshCapabilityNodeAdmissionRecord,
  type MeshCapabilityNodeAdmissionRevocationRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface AdmitMeshCapabilityNodeInput {
  workspaceId: string;
  nodeId: string;
  expectedAdmissionGeneration: number;
  joinTokenSha256: string;
  mtlsRequired: boolean;
  tlsFingerprint?: string;
  admittedByActorId: string;
  idempotencyKey: string;
}

export interface RevokeMeshCapabilityNodeAdmissionInput {
  workspaceId: string;
  nodeId: string;
  admissionGeneration: number;
  reason: string;
  revokedByActorId: string;
  idempotencyKey: string;
}

interface AdmissionRow {
  workspace_id: string;
  node_id: string;
  admission_generation: number | bigint | string;
  join_token_sha256: string;
  mtls_required: number | bigint | string | boolean;
  tls_fingerprint: string | null;
  admitted_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  admitted_at: string;
}

interface RevocationRow {
  workspace_id: string;
  node_id: string;
  admission_generation: number | bigint | string;
  reason: string;
  revoked_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  revoked_at: string;
}

export class MeshCapabilityNodeAdmissionRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public admit(input: AdmitMeshCapabilityNodeInput): MeshCapabilityNodeAdmissionRecord {
    const normalized = normalizeAdmissionInput(input);
    const admissionGeneration = normalized.expectedAdmissionGeneration + 1;
    const request = { ...normalized, admissionGeneration };
    const requestSha256 = sha256(request);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.workspaceId, normalized.nodeId);
      const replay = this.findAdmissionByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return assertReplay(replay, requestSha256, "mesh capability node admission");
      try {
        this.db
          .prepare(
            `
            INSERT INTO mesh_capability_node_admissions (
              workspace_id, node_id, admission_generation, join_token_sha256, mtls_required,
              tls_fingerprint, admitted_by_actor_id, idempotency_key, request_sha256, admitted_at
            ) VALUES (
              @workspaceId, @nodeId, @admissionGeneration, @joinTokenSha256, @mtlsRequired,
              @tlsFingerprint, @admittedByActorId, @idempotencyKey, @requestSha256, @admittedAt
            )
          `,
          )
          .run({
            workspaceId: normalized.workspaceId,
            nodeId: normalized.nodeId,
            admissionGeneration,
            joinTokenSha256: normalized.joinTokenSha256,
            mtlsRequired: normalized.mtlsRequired ? 1 : 0,
            tlsFingerprint: normalized.tlsFingerprint ?? null,
            admittedByActorId: normalized.admittedByActorId,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            admittedAt: this.databaseNow(),
          });
      } catch (error) {
        throw normalizeWriteError(error, "mesh capability node admission");
      }
      return this.get(normalized.workspaceId, normalized.nodeId, admissionGeneration);
    });
  }

  public get(workspaceId: string, nodeId: string, admissionGeneration: number): MeshCapabilityNodeAdmissionRecord {
    const normalized = {
      workspaceId: identifier(workspaceId, "workspaceId"),
      nodeId: identifier(nodeId, "nodeId"),
      admissionGeneration: positiveInteger(admissionGeneration, "admissionGeneration"),
    };
    const row = this.db
      .prepare(
        `
        SELECT * FROM mesh_capability_node_admissions
        WHERE workspace_id = @workspaceId AND node_id = @nodeId
          AND admission_generation = @admissionGeneration
      `,
      )
      .get(normalized) as AdmissionRow | undefined;
    if (!row) {
      throw new NotFoundError({
        entity: "mesh capability node admission",
        id: `${normalized.workspaceId}:${normalized.nodeId}:${normalized.admissionGeneration}`,
      });
    }
    return mapAdmission(row);
  }

  /**
   * Resolves the immutable admission row bound to one exact join-token digest.
   * The digest column is globally unique, so this is the durable lookup an
   * authenticated node-credential check uses to map a presented token onto its
   * admitted workspace/node identity. Read-only; revocation and currency are
   * separate checks the caller must make against `findCurrent`.
   */
  public findByJoinTokenSha256(joinTokenSha256: string): MeshCapabilityNodeAdmissionRecord | undefined {
    const normalized = digest(joinTokenSha256, "joinTokenSha256");
    const row = this.db
      .prepare(
        `
        SELECT * FROM mesh_capability_node_admissions
        WHERE join_token_sha256 = @joinTokenSha256
      `,
      )
      .get({ joinTokenSha256: normalized }) as AdmissionRow | undefined;
    return row ? mapAdmission(row) : undefined;
  }

  public findCurrent(workspaceId: string, nodeId: string): MeshCapabilityNodeAdmissionRecord | undefined {
    const normalized = {
      workspaceId: identifier(workspaceId, "workspaceId"),
      nodeId: identifier(nodeId, "nodeId"),
    };
    const row = this.db
      .prepare(
        `
        SELECT admission.* FROM mesh_capability_node_admissions admission
        WHERE admission.workspace_id = @workspaceId AND admission.node_id = @nodeId
          AND admission.admission_generation = (
            SELECT MAX(current.admission_generation)
            FROM mesh_capability_node_admissions current
            WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM mesh_capability_node_admission_revocations revoked
            WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
              AND revoked.admission_generation = admission.admission_generation
          )
      `,
      )
      .get(normalized) as AdmissionRow | undefined;
    return row ? mapAdmission(row) : undefined;
  }

  public revoke(input: RevokeMeshCapabilityNodeAdmissionInput): MeshCapabilityNodeAdmissionRevocationRecord {
    const normalized = normalizeRevocationInput(input);
    const requestSha256 = sha256(normalized);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.workspaceId, normalized.nodeId);
      const replay = this.findRevocationByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return assertReplay(replay, requestSha256, "mesh capability node admission revocation");
      try {
        this.db
          .prepare(
            `
            INSERT INTO mesh_capability_node_admission_revocations (
              workspace_id, node_id, admission_generation, reason, revoked_by_actor_id,
              idempotency_key, request_sha256, revoked_at
            ) VALUES (
              @workspaceId, @nodeId, @admissionGeneration, @reason, @revokedByActorId,
              @idempotencyKey, @requestSha256, @revokedAt
            )
          `,
          )
          .run({ ...normalized, requestSha256, revokedAt: this.databaseNow() });
      } catch (error) {
        throw normalizeWriteError(error, "mesh capability node admission revocation");
      }
      return this.getRevocation(normalized.workspaceId, normalized.nodeId, normalized.admissionGeneration);
    });
  }

  public getRevocation(
    workspaceId: string,
    nodeId: string,
    admissionGeneration: number,
  ): MeshCapabilityNodeAdmissionRevocationRecord {
    const normalized = {
      workspaceId: identifier(workspaceId, "workspaceId"),
      nodeId: identifier(nodeId, "nodeId"),
      admissionGeneration: positiveInteger(admissionGeneration, "admissionGeneration"),
    };
    const row = this.db
      .prepare(
        `
        SELECT * FROM mesh_capability_node_admission_revocations
        WHERE workspace_id = @workspaceId AND node_id = @nodeId
          AND admission_generation = @admissionGeneration
      `,
      )
      .get(normalized) as RevocationRow | undefined;
    if (!row) {
      throw new NotFoundError({
        entity: "mesh capability node admission revocation",
        id: `${normalized.workspaceId}:${normalized.nodeId}:${normalized.admissionGeneration}`,
      });
    }
    return mapRevocation(row);
  }

  private findAdmissionByIdempotency(workspaceId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        `
        SELECT * FROM mesh_capability_node_admissions
        WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey
      `,
      )
      .get({ workspaceId, idempotencyKey }) as AdmissionRow | undefined;
    return row ? mapAdmission(row) : undefined;
  }

  private findRevocationByIdempotency(workspaceId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        `
        SELECT * FROM mesh_capability_node_admission_revocations
        WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey
      `,
      )
      .get({ workspaceId, idempotencyKey }) as RevocationRow | undefined;
    return row ? mapRevocation(row) : undefined;
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get() as { now?: string } | undefined;
    if (!row?.now) throw new Error("Database clock did not return a timestamp.");
    return row.now;
  }

  private acquirePostgresAdmissionLocks(workspaceId: string, nodeId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId, 411)) AS locked").get({ workspaceId });
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId || ':' || @nodeId, 412)) AS locked")
      .get({ workspaceId, nodeId });
  }
}

function normalizeAdmissionInput(input: AdmitMeshCapabilityNodeInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    nodeId: identifier(input.nodeId, "nodeId"),
    expectedAdmissionGeneration: nonNegativeInteger(input.expectedAdmissionGeneration, "expectedAdmissionGeneration"),
    joinTokenSha256: digest(input.joinTokenSha256, "joinTokenSha256"),
    mtlsRequired: booleanValue(input.mtlsRequired, "mtlsRequired"),
    tlsFingerprint: optionalIdentifier(input.tlsFingerprint, "tlsFingerprint", 512),
    admittedByActorId: identifier(input.admittedByActorId, "admittedByActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeRevocationInput(input: RevokeMeshCapabilityNodeAdmissionInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    nodeId: identifier(input.nodeId, "nodeId"),
    admissionGeneration: positiveInteger(input.admissionGeneration, "admissionGeneration"),
    reason: text(input.reason, "reason", 2_000),
    revokedByActorId: identifier(input.revokedByActorId, "revokedByActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function mapAdmission(row: AdmissionRow): MeshCapabilityNodeAdmissionRecord {
  return {
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    admissionGeneration: positiveInteger(Number(row.admission_generation), "admissionGeneration"),
    joinTokenSha256: digest(row.join_token_sha256, "joinTokenSha256"),
    mtlsRequired: Boolean(Number(row.mtls_required)),
    tlsFingerprint: row.tls_fingerprint ?? undefined,
    admittedByActorId: row.admitted_by_actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: digest(row.request_sha256, "requestSha256"),
    admittedAt: row.admitted_at,
  };
}

function mapRevocation(row: RevocationRow): MeshCapabilityNodeAdmissionRevocationRecord {
  return {
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    admissionGeneration: positiveInteger(Number(row.admission_generation), "admissionGeneration"),
    reason: row.reason,
    revokedByActorId: row.revoked_by_actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: digest(row.request_sha256, "requestSha256"),
    revokedAt: row.revoked_at,
  };
}

function assertReplay<T extends { requestSha256: string }>(record: T, requestSha256: string, label: string): T {
  if (record.requestSha256 !== requestSha256) {
    throw new ConflictError({ message: `${label} idempotency key is bound to different request bytes.` });
  }
  return record;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `${field} is not a canonical identifier.` });
  }
  return value;
}

function optionalIdentifier(value: string | undefined, field: string, max = 256): string | undefined {
  return value === undefined ? undefined : identifier(value, field, max);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError({ field, message: `${field} must be a positive safe integer.` });
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError({ field, message: `${field} must be a non-negative safe integer.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({ field, message: `${field} must be a lower-case SHA-256 digest.` });
  }
  return value;
}

function booleanValue(value: boolean, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError({ field, message: `${field} must be a boolean.` });
  return value;
}

function text(value: string, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `${field} is invalid.` });
  }
  return value;
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError) return error;
  return new ConflictError({
    message: `${label} violated a durable admission invariant.`,
    details: { reason: "durable_admission_invariant_conflict" },
  });
}
