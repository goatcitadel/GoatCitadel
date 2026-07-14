import { createHash } from "node:crypto";
import {
  WORKSPACE_PATH_BRIDGE_MAX_LIST_LIMIT,
  WORKSPACE_PATH_BRIDGE_MAX_SNAPSHOT_BYTES,
  NotFoundError,
  assertWorkspacePathBridgeSnapshot,
  canonicalJsonString,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface WorkspacePathBridgeSnapshotRow {
  snapshot_id: string;
  schema_version: string;
  request_hash: string;
  workspace_id: string;
  input_flavor: string;
  target_flavor: string;
  git_identity_required: number | boolean;
  input_path_hash: string;
  allowed_roots_hash: string;
  canonical_host_path: string | null;
  canonical_target_path: string | null;
  distro: string | null;
  round_trip_json: string;
  git_identity_json: string;
  status: string;
  reason_code: string | null;
  callable: number | boolean;
  snapshot_json: string;
  snapshot_sha256: string;
  created_at: string;
}

export type WorkspacePathBridgeSnapshotDraft = Omit<WorkspacePathBridgeSnapshotRecord, "snapshotSha256">;

export class WorkspacePathBridgeSnapshotRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO workspace_path_bridge_snapshots (
        snapshot_id, schema_version, request_hash, workspace_id, input_flavor, target_flavor, git_identity_required,
        input_path_hash, allowed_roots_hash, canonical_host_path, canonical_target_path, distro,
        round_trip_json, git_identity_json, status, reason_code, callable, snapshot_json,
        snapshot_sha256, created_at
      ) VALUES (
        @snapshotId, @schemaVersion, @requestHash, @workspaceId, @inputFlavor, @targetFlavor, @gitIdentityRequired,
        @inputPathHash, @allowedRootsHash, @canonicalHostPath, @canonicalTargetPath, @distro,
        @roundTripJson, @gitIdentityJson, @status, @reasonCode, @callable, @snapshotJson,
        @snapshotSha256, @createdAt
      ) ON CONFLICT(snapshot_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM workspace_path_bridge_snapshots WHERE snapshot_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM workspace_path_bridge_snapshots
      WHERE workspace_id = ?
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT ?
    `);
  }

  public create(input: WorkspacePathBridgeSnapshotRecord): WorkspacePathBridgeSnapshotRecord {
    verifyWorkspacePathBridgeSnapshot(input);
    const snapshotJson = canonicalJsonString(input);
    if (Buffer.byteLength(snapshotJson, "utf8") > WORKSPACE_PATH_BRIDGE_MAX_SNAPSHOT_BYTES) {
      throw new Error(`Workspace path bridge snapshot ${input.snapshotId} exceeds the storage limit.`);
    }
    this.insertStmt.run({
      snapshotId: input.snapshotId,
      schemaVersion: input.schemaVersion,
      requestHash: input.requestHash,
      workspaceId: input.workspaceId,
      inputFlavor: input.inputFlavor,
      targetFlavor: input.targetFlavor,
      gitIdentityRequired:
        this.db.dialect === "sqlite" ? (input.gitIdentityRequired ? 1 : 0) : input.gitIdentityRequired,
      inputPathHash: input.inputPathHash,
      allowedRootsHash: input.allowedRootsHash,
      canonicalHostPath: input.canonicalHostPath ?? null,
      canonicalTargetPath: input.canonicalTargetPath ?? null,
      distro: input.distro ?? null,
      roundTripJson: canonicalJsonString(input.roundTrip),
      gitIdentityJson: canonicalJsonString(input.gitIdentity),
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      callable: this.db.dialect === "sqlite" ? (input.callable ? 1 : 0) : input.callable,
      snapshotJson,
      snapshotSha256: input.snapshotSha256,
      createdAt: input.createdAt,
    });
    const stored = this.get(input.snapshotId);
    if (canonicalJsonString(stored) !== snapshotJson) {
      throw new Error(
        `Workspace path bridge snapshot ${input.snapshotId} conflicts with an existing immutable record.`,
      );
    }
    return stored;
  }

  public get(snapshotId: string): WorkspacePathBridgeSnapshotRecord {
    const row = toRow(this.getStmt.get(snapshotId));
    if (!row) {
      throw new NotFoundError({ entity: "workspace path bridge snapshot", id: snapshotId });
    }
    return mapVerifiedRow(row);
  }

  public find(snapshotId: string): WorkspacePathBridgeSnapshotRecord | undefined {
    const row = toRow(this.getStmt.get(snapshotId));
    return row ? mapVerifiedRow(row) : undefined;
  }

  public listByWorkspace(workspaceId: string, limit = 50): WorkspacePathBridgeSnapshotRecord[] {
    assertBoundedIdentifier(workspaceId, "workspaceId", 256);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_PATH_BRIDGE_MAX_LIST_LIMIT) {
      throw new Error("Workspace path bridge list limit is invalid.");
    }
    return this.listStmt.all(workspaceId, limit).map((value) => mapVerifiedRow(toRequiredRow(value)));
  }
}

export function sealWorkspacePathBridgeSnapshot(
  draft: WorkspacePathBridgeSnapshotDraft,
): WorkspacePathBridgeSnapshotRecord {
  return { ...draft, snapshotSha256: digest(draft) };
}

export function verifyWorkspacePathBridgeSnapshot(input: WorkspacePathBridgeSnapshotRecord): void {
  assertWorkspacePathBridgeSnapshot(input);
  const { snapshotSha256: _snapshotSha256, ...draft } = input;
  if (digest(draft) !== input.snapshotSha256) {
    throw new Error(`Workspace path bridge snapshot ${input.snapshotId} failed hash verification.`);
  }
}

function mapVerifiedRow(row: WorkspacePathBridgeSnapshotRow): WorkspacePathBridgeSnapshotRecord {
  const parsed = safeJsonParse<WorkspacePathBridgeSnapshotRecord | undefined>(row.snapshot_json, undefined);
  if (!parsed) {
    throw new Error(`Workspace path bridge snapshot ${row.snapshot_id} contains invalid JSON.`);
  }
  verifyWorkspacePathBridgeSnapshot(parsed);
  const expected: Partial<WorkspacePathBridgeSnapshotRow> = {
    snapshot_id: parsed.snapshotId,
    schema_version: parsed.schemaVersion,
    request_hash: parsed.requestHash,
    workspace_id: parsed.workspaceId,
    input_flavor: parsed.inputFlavor,
    target_flavor: parsed.targetFlavor,
    input_path_hash: parsed.inputPathHash,
    allowed_roots_hash: parsed.allowedRootsHash,
    canonical_host_path: parsed.canonicalHostPath ?? null,
    canonical_target_path: parsed.canonicalTargetPath ?? null,
    distro: parsed.distro ?? null,
    round_trip_json: canonicalJsonString(parsed.roundTrip),
    git_identity_json: canonicalJsonString(parsed.gitIdentity),
    status: parsed.status,
    reason_code: parsed.reasonCode ?? null,
    snapshot_sha256: parsed.snapshotSha256,
    created_at: parsed.createdAt,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (row[key as keyof WorkspacePathBridgeSnapshotRow] !== value) {
      throw new Error(`Workspace path bridge snapshot ${row.snapshot_id} failed indexed-column verification.`);
    }
  }
  if (Boolean(row.callable) !== parsed.callable) {
    throw new Error(`Workspace path bridge snapshot ${row.snapshot_id} failed callable verification.`);
  }
  if (Boolean(row.git_identity_required) !== parsed.gitIdentityRequired) {
    throw new Error(`Workspace path bridge snapshot ${row.snapshot_id} failed Git posture verification.`);
  }
  return parsed;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertBoundedIdentifier(value: string, field: string, max: number): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > max ||
    containsAsciiControlCharacter(value)
  ) {
    throw new Error(`Workspace path bridge ${field} is invalid.`);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function toRow(value: unknown): WorkspacePathBridgeSnapshotRow | undefined {
  return value && typeof value === "object" ? (value as WorkspacePathBridgeSnapshotRow) : undefined;
}

function toRequiredRow(value: unknown): WorkspacePathBridgeSnapshotRow {
  const row = toRow(value);
  if (!row) {
    throw new Error("Workspace path bridge storage returned a malformed row.");
  }
  return row;
}
