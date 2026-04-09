import type { CapabilityProposalEventRecord, CapabilityProposalRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
import { safeJsonParse } from "./safe-json.js";

interface CapabilityProposalRow {
  proposal_id: string;
  proposal_kind: CapabilityProposalRecord["proposalKind"];
  status: CapabilityProposalRecord["status"];
  title: string;
  summary: string;
  candidate_id: string | null;
  activation_target_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface CapabilityProposalEventRow {
  event_id: string;
  proposal_id: string;
  event_type: CapabilityProposalEventRecord["eventType"];
  actor_id: string;
  payload_json: string;
  created_at: string;
}

export class CapabilityProposalRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO capability_proposals (
        proposal_id, proposal_kind, status, title, summary, candidate_id, activation_target_id, payload_json, created_at, updated_at
      ) VALUES (
        @proposalId, @proposalKind, @status, @title, @summary, @candidateId, @activationTargetId, @payloadJson, @createdAt, @updatedAt
      )
      ON CONFLICT(proposal_id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        candidate_id = excluded.candidate_id,
        activation_target_id = excluded.activation_target_id,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare("SELECT * FROM capability_proposals WHERE proposal_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM capability_proposals
      ORDER BY updated_at DESC, proposal_id DESC
      LIMIT @limit
    `);
  }

  public upsert(input: CapabilityProposalRecord): CapabilityProposalRecord {
    this.upsertStmt.run({
      proposalId: input.proposalId,
      proposalKind: input.proposalKind,
      status: input.status,
      title: input.title,
      summary: input.summary,
      candidateId: input.candidateId ?? null,
      activationTargetId: input.activationTargetId ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return this.get(input.proposalId);
  }

  public get(proposalId: string): CapabilityProposalRecord {
    const row = this.getStmt.get(proposalId) as CapabilityProposalRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "capability proposal", id: proposalId });
    }
    return mapCapabilityProposalRow(row);
  }

  public find(proposalId: string): CapabilityProposalRecord | undefined {
    const row = this.getStmt.get(proposalId) as CapabilityProposalRow | undefined;
    return row ? mapCapabilityProposalRow(row) : undefined;
  }

  public list(limit = 100): CapabilityProposalRecord[] {
    return (this.listStmt.all({ limit }) as unknown as CapabilityProposalRow[]).map(mapCapabilityProposalRow);
  }
}

export class CapabilityProposalEventRepository {
  private readonly insertStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO capability_proposal_events (
        event_id, proposal_id, event_type, actor_id, payload_json, created_at
      ) VALUES (
        @eventId, @proposalId, @eventType, @actorId, @payloadJson, @createdAt
      )
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM capability_proposal_events
      WHERE proposal_id = @proposalId
      ORDER BY created_at ASC, event_id ASC
    `);
  }

  public append(input: CapabilityProposalEventRecord): CapabilityProposalEventRecord {
    this.insertStmt.run({
      eventId: input.eventId,
      proposalId: input.proposalId,
      eventType: input.eventType,
      actorId: input.actorId,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
    });
    return input;
  }

  public listByProposalId(proposalId: string): CapabilityProposalEventRecord[] {
    return (this.listStmt.all({ proposalId }) as unknown as CapabilityProposalEventRow[]).map((row) => ({
      eventId: row.event_id,
      proposalId: row.proposal_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      payload: safeJsonParse(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }
}

function mapCapabilityProposalRow(row: CapabilityProposalRow): CapabilityProposalRecord {
  return {
    proposalId: row.proposal_id,
    proposalKind: row.proposal_kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    candidateId: row.candidate_id ?? undefined,
    activationTargetId: row.activation_target_id ?? undefined,
    payload: safeJsonParse(row.payload_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
