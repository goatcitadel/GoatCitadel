import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { ChannelOAuthAttempt, ChannelOAuthAttemptStatus } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

/** Private Gateway record. Never return this shape from an operator API. */
export interface ChannelOAuthAttemptRecord extends ChannelOAuthAttempt {
  installationId: string;
  actorId: string;
  connectionRevision?: string;
  stateHash: string;
  origin?: string;
  secretRefs: Record<string, string>;
}
export type ChannelOAuthAttemptCreate = Omit<ChannelOAuthAttemptRecord, "revision" | "createdAt" | "updatedAt">;
export interface ChannelOAuthAttemptPatch {
  expectedRevision: number;
  status: ChannelOAuthAttemptStatus;
  install?: ChannelOAuthAttempt["install"];
  secretRefs?: Record<string, string>;
  adoptedDraftRevision?: number;
  failureCode?: ChannelOAuthAttempt["failureCode"];
}
interface Row {
  attempt_id: string; revision: number; provider: "slack"; installation_id: string;
  workspace_id: string; actor_id: string; draft_id: string; draft_revision: number;
  connection_id: string | null; connection_revision: string | null; state_hash: string;
  origin: string | null; status: ChannelOAuthAttemptStatus; expires_at: string;
  install_json: string | null; secret_refs_json: string; adopted_draft_revision: number | null;
  failure_code: ChannelOAuthAttempt["failureCode"] | null; created_at: string; updated_at: string;
}
const transitions: Record<ChannelOAuthAttemptStatus, readonly ChannelOAuthAttemptStatus[]> = {
  pending: ["exchanging", "failed", "expired", "cancelled"],
  exchanging: ["ready", "failed", "expired", "cancelled"],
  ready: ["adopted", "failed", "expired", "cancelled"],
  adopted: [], failed: ["failed"], expired: ["expired"], cancelled: ["cancelled"],
};
export class ChannelOAuthAttemptRepository {
  private readonly getStmt;
  private readonly stateStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly expiringStmt;
  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM channel_oauth_attempts WHERE attempt_id = ?");
    this.stateStmt = db.prepare("SELECT * FROM channel_oauth_attempts WHERE state_hash = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO channel_oauth_attempts (attempt_id,revision,provider,installation_id,workspace_id,actor_id,
        draft_id,draft_revision,connection_id,connection_revision,state_hash,origin,status,expires_at,
        install_json,secret_refs_json,adopted_draft_revision,failure_code,created_at,updated_at)
      VALUES (@attemptId,1,@provider,@installationId,@workspaceId,@actorId,@draftId,@draftRevision,
        @connectionId,@connectionRevision,@stateHash,@origin,@status,@expiresAt,@installJson,@secretRefsJson,
        @adoptedDraftRevision,@failureCode,@now,@now)`);
    this.updateStmt = db.prepare(`
      UPDATE channel_oauth_attempts SET revision=revision+1,status=@status,install_json=@installJson,
        secret_refs_json=@secretRefsJson,adopted_draft_revision=@adoptedDraftRevision,failure_code=@failureCode,
        updated_at=@now WHERE attempt_id=@attemptId AND revision=@expectedRevision`);
    this.expiringStmt = db.prepare(`
      SELECT * FROM channel_oauth_attempts WHERE
        (expires_at <= @now AND status IN ('pending','exchanging','ready'))
        OR (status IN ('failed','expired','cancelled') AND secret_refs_json <> '{}')
      ORDER BY expires_at,attempt_id LIMIT @limit`);
  }
  public create(input: ChannelOAuthAttemptCreate, now = new Date().toISOString()): ChannelOAuthAttemptRecord {
    if (input.status !== "pending" || input.provider !== "slack" || !/^[a-f0-9]{64}$/.test(input.stateHash)) {
      throw new ValidationError({ message: "Invalid channel OAuth attempt." });
    }
    assertRefs(input.secretRefs);
    this.insertStmt.run({
      attemptId: input.attemptId, provider: input.provider, installationId: input.installationId,
      workspaceId: input.workspaceId, actorId: input.actorId, draftId: input.draftId, draftRevision: input.draftRevision,
      stateHash: input.stateHash, status: input.status, expiresAt: input.expiresAt,
      connectionId: input.connectionId ?? null, connectionRevision: input.connectionRevision ?? null,
      origin: input.origin ?? null, installJson: input.install ? JSON.stringify(input.install) : null,
      secretRefsJson: JSON.stringify(input.secretRefs), adoptedDraftRevision: input.adoptedDraftRevision ?? null,
      failureCode: input.failureCode ?? null, now,
    });
    return this.get(input.attemptId);
  }
  public get(attemptId: string): ChannelOAuthAttemptRecord {
    const row = this.getStmt.get(attemptId) as Row | undefined;
    if (!row) throw new NotFoundError({ entity: "Channel OAuth attempt", id: attemptId });
    return mapRow(row);
  }
  public findByStateHash(stateHash: string): ChannelOAuthAttemptRecord | undefined {
    const row = this.stateStmt.get(stateHash) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }
  public listExpiring(now = new Date().toISOString(), limit = 100): ChannelOAuthAttemptRecord[] {
    return (this.expiringStmt.all({ now, limit: Math.min(1000, Math.max(1, limit)) }) as Row[]).map(mapRow);
  }
  public listByDraft(draftId: string): ChannelOAuthAttemptRecord[] {
    return (this.db.prepare("SELECT * FROM channel_oauth_attempts WHERE draft_id = @draftId AND status IN ('pending','exchanging','ready','failed','expired','cancelled') ORDER BY created_at LIMIT 1000").all({ draftId }) as Row[]).map(mapRow);
  }
  public listInterruptedExchanges(): ChannelOAuthAttemptRecord[] {
    return (this.db.prepare("SELECT * FROM channel_oauth_attempts WHERE status = 'exchanging' ORDER BY created_at LIMIT 1000").all() as Row[]).map(mapRow);
  }
  public update(attemptId: string, patch: ChannelOAuthAttemptPatch, now = new Date().toISOString()): ChannelOAuthAttemptRecord {
    return this.db.transaction("immediate", () => {
      // CAS is the authority even across competing Gateway processes.
      const current = this.get(attemptId);
      if (current.revision !== patch.expectedRevision || !transitions[current.status].includes(patch.status)) {
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "The channel OAuth attempt changed. Review its current status." });
      }
      const refs = patch.secretRefs ?? current.secretRefs;
      assertRefs(refs);
      const changed = this.updateStmt.run({
        attemptId, expectedRevision: patch.expectedRevision, status: patch.status,
        installJson: patch.install ? JSON.stringify(patch.install) : current.install ? JSON.stringify(current.install) : null,
        secretRefsJson: JSON.stringify(refs), adoptedDraftRevision: patch.adoptedDraftRevision ?? current.adoptedDraftRevision ?? null,
        failureCode: patch.failureCode ?? current.failureCode ?? null, now,
      });
      if (changed.changes !== 1) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The channel OAuth attempt changed." });
      return this.get(attemptId);
    });
  }
}
function assertRefs(refs: Record<string, string>): void {
  if (Object.entries(refs).some(([key, value]) => !["botToken", "webhookUrl"].includes(key) ||
      !value.startsWith("keychain:goatcitadel:channel-draft:"))) {
    throw new ValidationError({ message: "Only draft credential references can be persisted in an OAuth attempt." });
  }
}
function mapRow(row: Row): ChannelOAuthAttemptRecord {
  return {
    attemptId: row.attempt_id, revision: row.revision, provider: row.provider, installationId: row.installation_id,
    workspaceId: row.workspace_id, actorId: row.actor_id, draftId: row.draft_id, draftRevision: row.draft_revision,
    connectionId: row.connection_id ?? undefined, connectionRevision: row.connection_revision ?? undefined,
    stateHash: row.state_hash, origin: row.origin ?? undefined, status: row.status, expiresAt: row.expires_at,
    install: row.install_json ? safeJsonParse<ChannelOAuthAttempt["install"]>(row.install_json, undefined) : undefined,
    secretRefs: safeJsonParse<Record<string, string>>(row.secret_refs_json, {}),
    adoptedDraftRevision: row.adopted_draft_revision ?? undefined, failureCode: row.failure_code ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}