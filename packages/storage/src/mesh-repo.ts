import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MeshJoinRequest,
  MeshLeaseRecord,
  MeshNodeRecord,
  MeshReplicationIngestRequest,
  MeshReplicationOffset,
  MeshReplicationRecord,
  MeshSessionClaimRequest,
  MeshSessionOwnerRecord,
  MeshStatus,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface MeshNodeRow {
  node_id: string;
  label: string | null;
  advertise_address: string | null;
  transport: MeshNodeRecord["transport"];
  status: MeshNodeRecord["status"];
  capabilities_json: string;
  tls_fingerprint: string | null;
  joined_at: string;
  last_seen_at: string;
}

interface MeshLeaseRow {
  lease_key: string;
  holder_node_id: string;
  fencing_token: number;
  expires_at: string;
  updated_at: string;
}

interface MeshSessionOwnerRow {
  session_id: string;
  owner_node_id: string;
  epoch: number;
  claimed_at: string;
  updated_at: string;
}

interface MeshReplicationRow {
  replication_id: string;
  source_node_id: string;
  event_type: string;
  payload_json: string;
  idempotency_key: string;
  created_at: string;
}

interface MeshReplicationOffsetRow {
  consumer_node_id: string;
  source_node_id: string;
  last_replication_id: string | null;
  updated_at: string;
}

export class MeshRepository {
  private readonly upsertNodeStmt;
  private readonly getNodeStmt;
  private readonly listNodesStmt;
  private readonly getLeaseStmt;
  private readonly listLeasesStmt;
  private readonly insertLeaseStmt;
  private readonly updateLeaseStmt;
  private readonly releaseLeaseStmt;
  private readonly getSessionOwnerStmt;
  private readonly insertSessionOwnerStmt;
  private readonly updateSessionOwnerStmt;
  private readonly listSessionOwnersStmt;
  private readonly appendReplicationStmt;
  private readonly listReplicationStmt;
  private readonly setOffsetStmt;
  private readonly listOffsetsStmt;
  private readonly getOffsetStmt;
  private readonly insertJoinTokenStmt;
  private readonly consumeJoinTokenStmt;
  private readonly statusCountsStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.upsertNodeStmt = db.prepare(`
      INSERT INTO mesh_nodes (
        node_id, label, advertise_address, transport, status, capabilities_json,
        tls_fingerprint, joined_at, last_seen_at
      ) VALUES (
        @nodeId, @label, @advertiseAddress, @transport, @status, @capabilitiesJson,
        @tlsFingerprint, @joinedAt, @lastSeenAt
      )
      ON CONFLICT(node_id) DO UPDATE SET
        label = excluded.label,
        advertise_address = excluded.advertise_address,
        transport = excluded.transport,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        tls_fingerprint = excluded.tls_fingerprint,
        last_seen_at = excluded.last_seen_at
    `);
    this.getNodeStmt = db.prepare("SELECT * FROM mesh_nodes WHERE node_id = ?");
    this.listNodesStmt = db.prepare("SELECT * FROM mesh_nodes ORDER BY last_seen_at DESC LIMIT @limit");

    this.getLeaseStmt = db.prepare("SELECT * FROM mesh_leases WHERE lease_key = ?");
    this.listLeasesStmt = db.prepare(`
      SELECT * FROM mesh_leases
      ORDER BY updated_at DESC
      LIMIT @limit
    `);
    this.insertLeaseStmt = db.prepare(`
      INSERT INTO mesh_leases (
        lease_key, holder_node_id, fencing_token, expires_at, updated_at
      ) VALUES (
        @leaseKey, @holderNodeId, @fencingToken, @expiresAt, @updatedAt
      )
    `);
    this.updateLeaseStmt = db.prepare(`
      UPDATE mesh_leases
      SET holder_node_id = @holderNodeId,
          fencing_token = @fencingToken,
          expires_at = @expiresAt,
          updated_at = @updatedAt
      WHERE lease_key = @leaseKey
    `);
    this.releaseLeaseStmt = db.prepare(`
      DELETE FROM mesh_leases
      WHERE lease_key = @leaseKey
        AND holder_node_id = @holderNodeId
        AND fencing_token = @fencingToken
    `);

    this.getSessionOwnerStmt = db.prepare("SELECT * FROM mesh_session_owners WHERE session_id = ?");
    this.insertSessionOwnerStmt = db.prepare(`
      INSERT INTO mesh_session_owners (
        session_id, owner_node_id, epoch, claimed_at, updated_at
      ) VALUES (
        @sessionId, @ownerNodeId, @epoch, @claimedAt, @updatedAt
      )
    `);
    this.updateSessionOwnerStmt = db.prepare(`
      UPDATE mesh_session_owners
      SET owner_node_id = @ownerNodeId,
          epoch = @epoch,
          updated_at = @updatedAt
      WHERE session_id = @sessionId
    `);
    this.listSessionOwnersStmt = db.prepare(`
      SELECT * FROM mesh_session_owners
      ORDER BY updated_at DESC
      LIMIT @limit
    `);

    this.appendReplicationStmt = db.prepare(`
      INSERT OR IGNORE INTO mesh_replication_log (
        replication_id, source_node_id, event_type, payload_json, idempotency_key, created_at
      ) VALUES (
        @replicationId, @sourceNodeId, @eventType, @payloadJson, @idempotencyKey, @createdAt
      )
    `);
    this.listReplicationStmt = db.prepare(`
      SELECT * FROM mesh_replication_log
      WHERE (@cursor IS NULL OR created_at > @cursor)
      ORDER BY created_at ASC
      LIMIT @limit
    `);

    this.setOffsetStmt = db.prepare(`
      INSERT INTO mesh_replication_offsets (
        consumer_node_id, source_node_id, last_replication_id, updated_at
      ) VALUES (
        @consumerNodeId, @sourceNodeId, @lastReplicationId, @updatedAt
      )
      ON CONFLICT(consumer_node_id, source_node_id) DO UPDATE SET
        last_replication_id = excluded.last_replication_id,
        updated_at = excluded.updated_at
    `);
    this.getOffsetStmt = db.prepare(`
      SELECT * FROM mesh_replication_offsets
      WHERE consumer_node_id = @consumerNodeId
        AND source_node_id = @sourceNodeId
    `);
    this.listOffsetsStmt = db.prepare(`
      SELECT * FROM mesh_replication_offsets
      ORDER BY updated_at DESC
      LIMIT @limit
    `);

    this.insertJoinTokenStmt = db.prepare(`
      INSERT OR REPLACE INTO mesh_join_tokens (
        token_hash, created_at, expires_at, used_at, used_by_node_id
      ) VALUES (
        @tokenHash, @createdAt, @expiresAt, NULL, NULL
      )
    `);
    this.consumeJoinTokenStmt = db.prepare(`
      UPDATE mesh_join_tokens
      SET used_at = @usedAt,
          used_by_node_id = @usedByNodeId
      WHERE token_hash = @tokenHash
        AND used_at IS NULL
        AND expires_at > @usedAt
    `);

    this.statusCountsStmt = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online_count,
        (SELECT COUNT(*) FROM mesh_leases WHERE expires_at > @now) AS lease_count,
        (SELECT COUNT(*) FROM mesh_session_owners) AS owner_count
      FROM mesh_nodes
    `);
  }

  public upsertNode(node: MeshNodeRecord): MeshNodeRecord {
    this.upsertNodeStmt.run({
      nodeId: node.nodeId,
      label: node.label ?? null,
      advertiseAddress: node.advertiseAddress ?? null,
      transport: node.transport,
      status: node.status,
      capabilitiesJson: JSON.stringify(node.capabilities),
      tlsFingerprint: node.tlsFingerprint ?? null,
      joinedAt: node.joinedAt,
      lastSeenAt: node.lastSeenAt,
    });
    return this.getNode(node.nodeId);
  }

  public listNodes(limit = 200): MeshNodeRecord[] {
    const rows = toMeshNodeRows(this.listNodesStmt.all({ limit }));
    return rows.map(mapNodeRow);
  }

  public getNode(nodeId: string): MeshNodeRecord {
    const row = toMeshNodeRow(this.getNodeStmt.get(nodeId));
    if (!row) {
      throw new NotFoundError({ entity: "Mesh node", id: nodeId });
    }
    return mapNodeRow(row);
  }

  public issueJoinToken(rawToken: string, expiresAt: string): void {
    this.insertJoinTokenStmt.run({
      tokenHash: hashJoinToken(rawToken),
      createdAt: new Date().toISOString(),
      expiresAt,
    });
  }

  public consumeJoinToken(rawToken: string, usedByNodeId: string, now = new Date().toISOString()): boolean {
    const changes = this.consumeJoinTokenStmt.run({
      tokenHash: hashJoinToken(rawToken),
      usedAt: now,
      usedByNodeId,
    }).changes;
    return changes > 0;
  }

  public acquireLease(
    leaseKey: string,
    holderNodeId: string,
    ttlSeconds: number,
    now = new Date().toISOString(),
  ): MeshLeaseRecord {
    const current = toMeshLeaseRow(this.getLeaseStmt.get(leaseKey));
    const expiresAt = addSeconds(now, ttlSeconds);

    if (!current) {
      this.insertLeaseStmt.run({
        leaseKey,
        holderNodeId,
        fencingToken: 1,
        expiresAt,
        updatedAt: now,
      });
      return this.getLease(leaseKey);
    }

    if (current.holder_node_id !== holderNodeId && Date.parse(current.expires_at) > Date.parse(now)) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Lease ${leaseKey} is currently held by ${current.holder_node_id}` });
    }

    const nextToken = current.holder_node_id === holderNodeId
      ? current.fencing_token
      : current.fencing_token + 1;

    this.updateLeaseStmt.run({
      leaseKey,
      holderNodeId,
      fencingToken: nextToken,
      expiresAt,
      updatedAt: now,
    });
    return this.getLease(leaseKey);
  }

  public renewLease(
    leaseKey: string,
    holderNodeId: string,
    fencingToken: number,
    ttlSeconds: number,
    now = new Date().toISOString(),
  ): MeshLeaseRecord {
    const current = this.getLease(leaseKey);
    if (current.holderNodeId !== holderNodeId || current.fencingToken !== fencingToken) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Lease ${leaseKey} fencing token mismatch` });
    }
    if (Date.parse(current.expiresAt) <= Date.parse(now)) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Lease ${leaseKey} is expired` });
    }

    this.updateLeaseStmt.run({
      leaseKey,
      holderNodeId,
      fencingToken,
      expiresAt: addSeconds(now, ttlSeconds),
      updatedAt: now,
    });
    return this.getLease(leaseKey);
  }

  public releaseLease(leaseKey: string, holderNodeId: string, fencingToken: number): boolean {
    const changes = this.releaseLeaseStmt.run({
      leaseKey,
      holderNodeId,
      fencingToken,
    }).changes;
    return changes > 0;
  }

  public getLease(leaseKey: string): MeshLeaseRecord {
    const row = toMeshLeaseRow(this.getLeaseStmt.get(leaseKey));
    if (!row) {
      throw new NotFoundError({ entity: "Lease", id: leaseKey });
    }
    return mapLeaseRow(row);
  }

  public listLeases(limit = 200): MeshLeaseRecord[] {
    const rows = toMeshLeaseRows(this.listLeasesStmt.all({ limit }));
    return rows.map(mapLeaseRow);
  }

  public claimSessionOwner(
    sessionId: string,
    input: MeshSessionClaimRequest,
    now = new Date().toISOString(),
  ): MeshSessionOwnerRecord {
    const current = toMeshSessionOwnerRow(this.getSessionOwnerStmt.get(sessionId));

    if (!current) {
      this.insertSessionOwnerStmt.run({
        sessionId,
        ownerNodeId: input.ownerNodeId,
        epoch: 1,
        claimedAt: now,
        updatedAt: now,
      });
      return this.getSessionOwner(sessionId);
    }

    const canTakeOver = input.force
      || current.owner_node_id === input.ownerNodeId
      || (input.expectedEpoch !== undefined && input.expectedEpoch === current.epoch);

    if (!canTakeOver) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Session ${sessionId} is owned by ${current.owner_node_id} at epoch ${current.epoch}` });
    }

    this.updateSessionOwnerStmt.run({
      sessionId,
      ownerNodeId: input.ownerNodeId,
      epoch: current.epoch + 1,
      updatedAt: now,
    });
    return this.getSessionOwner(sessionId);
  }

  public getSessionOwner(sessionId: string): MeshSessionOwnerRecord {
    const row = toMeshSessionOwnerRow(this.getSessionOwnerStmt.get(sessionId));
    if (!row) {
      throw new NotFoundError({ entity: "Session owner", id: sessionId });
    }
    return mapSessionOwnerRow(row);
  }

  public listSessionOwners(limit = 500): MeshSessionOwnerRecord[] {
    const rows = toMeshSessionOwnerRows(this.listSessionOwnersStmt.all({ limit }));
    return rows.map(mapSessionOwnerRow);
  }

  public appendReplicationEvent(input: MeshReplicationIngestRequest): MeshReplicationRecord {
    const now = new Date().toISOString();
    const replicationId = randomUUID();
    this.appendReplicationStmt.run({
      replicationId,
      sourceNodeId: input.sourceNodeId,
      eventType: input.eventType,
      payloadJson: JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });

    const row = toMeshReplicationRow(this.db.prepare(`
      SELECT * FROM mesh_replication_log
      WHERE source_node_id = @sourceNodeId AND idempotency_key = @idempotencyKey
    `).get({
      sourceNodeId: input.sourceNodeId,
      idempotencyKey: input.idempotencyKey,
    }));

    if (!row) {
      throw new NotFoundError("Unable to persist replication event");
    }
    return mapReplicationRow(row);
  }

  public listReplicationEvents(limit = 200, cursor?: string): MeshReplicationRecord[] {
    const rows = toMeshReplicationRows(this.listReplicationStmt.all({
      limit,
      cursor: cursor ?? null,
    }));
    return rows.map(mapReplicationRow);
  }

  public setReplicationOffset(
    consumerNodeId: string,
    sourceNodeId: string,
    lastReplicationId?: string,
    now = new Date().toISOString(),
  ): MeshReplicationOffset {
    this.setOffsetStmt.run({
      consumerNodeId,
      sourceNodeId,
      lastReplicationId: lastReplicationId ?? null,
      updatedAt: now,
    });
    return this.getReplicationOffset(consumerNodeId, sourceNodeId);
  }

  public getReplicationOffset(consumerNodeId: string, sourceNodeId: string): MeshReplicationOffset {
    const row = toMeshReplicationOffsetRow(this.getOffsetStmt.get({
      consumerNodeId,
      sourceNodeId,
    }));
    if (!row) {
      throw new NotFoundError(`Replication offset not found for ${consumerNodeId} <= ${sourceNodeId}`);
    }
    return mapOffsetRow(row);
  }

  public listReplicationOffsets(limit = 500): MeshReplicationOffset[] {
    const rows = toMeshReplicationOffsetRows(this.listOffsetsStmt.all({ limit }));
    return rows.map(mapOffsetRow);
  }

  public buildStatus(enabled: boolean, mode: MeshStatus["mode"], localNodeId: string): MeshStatus {
    const row = this.statusCountsStmt.get({ now: new Date().toISOString() }) as
      | { online_count: number | null; lease_count: number | null; owner_count: number | null }
      | undefined;

    return {
      enabled,
      mode,
      localNodeId,
      tailnetEnabled: mode === "tailnet",
      nodesOnline: Number(row?.online_count ?? 0),
      activeLeases: Number(row?.lease_count ?? 0),
      ownedSessions: Number(row?.owner_count ?? 0),
    };
  }

  public join(input: MeshJoinRequest, now = new Date().toISOString()): MeshNodeRecord {
    const accepted = this.consumeJoinToken(input.token, input.nodeId, now);
    if (!accepted) {
      throw new ValidationError({ message: "Join token is invalid, expired, or already used" });
    }

    return this.upsertNode({
      nodeId: input.nodeId,
      label: input.label,
      advertiseAddress: input.advertiseAddress,
      transport: input.transport ?? "lan",
      status: "online",
      capabilities: input.capabilities ?? [],
      tlsFingerprint: input.tlsFingerprint,
      joinedAt: now,
      lastSeenAt: now,
    });
  }
}

function mapNodeRow(row: MeshNodeRow): MeshNodeRecord {
  return {
    nodeId: row.node_id,
    label: row.label ?? undefined,
    advertiseAddress: row.advertise_address ?? undefined,
    transport: row.transport,
    status: row.status,
    capabilities: parseMeshCapabilities(row.capabilities_json),
    tlsFingerprint: row.tls_fingerprint ?? undefined,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapLeaseRow(row: MeshLeaseRow): MeshLeaseRecord {
  return {
    leaseKey: row.lease_key,
    holderNodeId: row.holder_node_id,
    fencingToken: Number(row.fencing_token),
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionOwnerRow(row: MeshSessionOwnerRow): MeshSessionOwnerRecord {
  return {
    sessionId: row.session_id,
    ownerNodeId: row.owner_node_id,
    epoch: Number(row.epoch),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

function mapReplicationRow(row: MeshReplicationRow): MeshReplicationRecord {
  return {
    replicationId: row.replication_id,
    sourceNodeId: row.source_node_id,
    eventType: row.event_type,
    payload: parseMeshPayload(row.payload_json),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function mapOffsetRow(row: MeshReplicationOffsetRow): MeshReplicationOffset {
  return {
    consumerNodeId: row.consumer_node_id,
    sourceNodeId: row.source_node_id,
    lastReplicationId: row.last_replication_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(Date.parse(isoTimestamp) + (seconds * 1000)).toISOString();
}

function hashJoinToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function parseMeshCapabilities(value: string): string[] {
  const parsed = safeJsonParse<unknown>(value, []);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
}

function parseMeshPayload(value: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, {});
  return isRecord(parsed) ? parsed : {};
}

function toMeshNodeRow(value: unknown): MeshNodeRow | undefined {
  return isMeshNodeRow(value) ? value : undefined;
}

function toMeshNodeRows(value: unknown): MeshNodeRow[] {
  return Array.isArray(value) ? value.filter(isMeshNodeRow) : [];
}

function toMeshLeaseRow(value: unknown): MeshLeaseRow | undefined {
  return isMeshLeaseRow(value) ? value : undefined;
}

function toMeshLeaseRows(value: unknown): MeshLeaseRow[] {
  return Array.isArray(value) ? value.filter(isMeshLeaseRow) : [];
}

function toMeshSessionOwnerRow(value: unknown): MeshSessionOwnerRow | undefined {
  return isMeshSessionOwnerRow(value) ? value : undefined;
}

function toMeshSessionOwnerRows(value: unknown): MeshSessionOwnerRow[] {
  return Array.isArray(value) ? value.filter(isMeshSessionOwnerRow) : [];
}

function toMeshReplicationRow(value: unknown): MeshReplicationRow | undefined {
  return isMeshReplicationRow(value) ? value : undefined;
}

function toMeshReplicationRows(value: unknown): MeshReplicationRow[] {
  return Array.isArray(value) ? value.filter(isMeshReplicationRow) : [];
}

function toMeshReplicationOffsetRow(value: unknown): MeshReplicationOffsetRow | undefined {
  return isMeshReplicationOffsetRow(value) ? value : undefined;
}

function toMeshReplicationOffsetRows(value: unknown): MeshReplicationOffsetRow[] {
  return Array.isArray(value) ? value.filter(isMeshReplicationOffsetRow) : [];
}

function isMeshNodeRow(value: unknown): value is MeshNodeRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.node_id === "string"
    && (typeof value.label === "string" || value.label === null)
    && (typeof value.advertise_address === "string" || value.advertise_address === null)
    && typeof value.transport === "string"
    && typeof value.status === "string"
    && typeof value.capabilities_json === "string"
    && (typeof value.tls_fingerprint === "string" || value.tls_fingerprint === null)
    && typeof value.joined_at === "string"
    && typeof value.last_seen_at === "string";
}

function isMeshLeaseRow(value: unknown): value is MeshLeaseRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.lease_key === "string"
    && typeof value.holder_node_id === "string"
    && typeof value.fencing_token === "number"
    && typeof value.expires_at === "string"
    && typeof value.updated_at === "string";
}

function isMeshSessionOwnerRow(value: unknown): value is MeshSessionOwnerRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.session_id === "string"
    && typeof value.owner_node_id === "string"
    && typeof value.epoch === "number"
    && typeof value.claimed_at === "string"
    && typeof value.updated_at === "string";
}

function isMeshReplicationRow(value: unknown): value is MeshReplicationRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.replication_id === "string"
    && typeof value.source_node_id === "string"
    && typeof value.event_type === "string"
    && typeof value.payload_json === "string"
    && typeof value.idempotency_key === "string"
    && typeof value.created_at === "string";
}

function isMeshReplicationOffsetRow(value: unknown): value is MeshReplicationOffsetRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.consumer_node_id === "string"
    && typeof value.source_node_id === "string"
    && (typeof value.last_replication_id === "string" || value.last_replication_id === null)
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
