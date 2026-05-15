import type {
  EvidenceEnvelope,
  EvidenceEnvelopeEventKind,
  EvidenceEnvelopeSignatureStatus,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface EvidenceEnvelopeRow {
  envelope_id: string;
  event_kind: EvidenceEnvelopeEventKind;
  session_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  content_hash: string;
  previous_envelope_hash: string | null;
  payload_hash: string;
  tool_call_hashes_json: string;
  memory_lineage_json: string;
  policy_hash: string | null;
  signature_status: EvidenceEnvelopeSignatureStatus;
  signature: string | null;
  metadata_json: string;
  created_at: string;
}

export interface EvidenceEnvelopeCreateInput {
  envelopeId: string;
  eventKind: EvidenceEnvelopeEventKind;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  contentHash: string;
  previousEnvelopeHash?: string;
  payloadHash: string;
  toolCallHashes?: string[];
  memoryLineage?: string[];
  policyHash?: string;
  signatureStatus: EvidenceEnvelopeSignatureStatus;
  signature?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface EvidenceEnvelopeListInput {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  limit?: number;
}

export class EvidenceEnvelopeRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly latestStmt;

  public constructor(private readonly db: DatabaseClient) {
    const optionalTextFilter = (column: string, param: string) =>
      buildOptionalTextFilterSql(this.db.dialect, column, param);
    this.insertStmt = db.prepare(`
      INSERT INTO runtime_evidence_envelopes (
        envelope_id, event_kind, session_id, turn_id, run_id, approval_id,
        content_hash, previous_envelope_hash, payload_hash, tool_call_hashes_json,
        memory_lineage_json, policy_hash, signature_status, signature, metadata_json, created_at
      ) VALUES (
        @envelopeId, @eventKind, @sessionId, @turnId, @runId, @approvalId,
        @contentHash, @previousEnvelopeHash, @payloadHash, @toolCallHashesJson,
        @memoryLineageJson, @policyHash, @signatureStatus, @signature, @metadataJson, @createdAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM runtime_evidence_envelopes WHERE envelope_id = ?");
    this.latestStmt = db.prepare(`
      SELECT * FROM runtime_evidence_envelopes
      ORDER BY created_at DESC, envelope_id DESC
      LIMIT 1
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM runtime_evidence_envelopes
      WHERE ${optionalTextFilter("session_id", "@sessionId")}
        AND ${optionalTextFilter("turn_id", "@turnId")}
        AND ${optionalTextFilter("run_id", "@runId")}
      ORDER BY created_at DESC, envelope_id DESC
      LIMIT @limit
    `);
  }

  public create(input: EvidenceEnvelopeCreateInput): EvidenceEnvelope {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.insertStmt.run({
      envelopeId: input.envelopeId,
      eventKind: input.eventKind,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      runId: input.runId ?? null,
      approvalId: input.approvalId ?? null,
      contentHash: input.contentHash,
      previousEnvelopeHash: input.previousEnvelopeHash ?? null,
      payloadHash: input.payloadHash,
      toolCallHashesJson: JSON.stringify(input.toolCallHashes ?? []),
      memoryLineageJson: JSON.stringify(input.memoryLineage ?? []),
      policyHash: input.policyHash ?? null,
      signatureStatus: input.signatureStatus,
      signature: input.signature ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt,
    });
    return this.get(input.envelopeId) ?? mapInput(input, createdAt);
  }

  public get(envelopeId: string): EvidenceEnvelope | undefined {
    return mapRow(toRow(this.getStmt.get(envelopeId)));
  }

  public latest(): EvidenceEnvelope | undefined {
    return mapRow(toRow(this.latestStmt.get()));
  }

  public list(input: EvidenceEnvelopeListInput = {}): EvidenceEnvelope[] {
    const rows = toRows(
      this.listStmt.all({
        sessionId: input.sessionId?.trim() || null,
        turnId: input.turnId?.trim() || null,
        runId: input.runId?.trim() || null,
        limit: Math.max(1, Math.min(input.limit ?? 100, 500)),
      }),
    );
    return rows.map((row) => mapRow(row)).filter((item): item is EvidenceEnvelope => Boolean(item));
  }
}

function toRow(value: unknown): EvidenceEnvelopeRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as EvidenceEnvelopeRow;
}

function toRows(value: unknown): EvidenceEnvelopeRow[] {
  return Array.isArray(value) ? (value as EvidenceEnvelopeRow[]) : [];
}

function mapRow(row: EvidenceEnvelopeRow | undefined): EvidenceEnvelope | undefined {
  if (!row) {
    return undefined;
  }
  return {
    envelopeId: row.envelope_id,
    eventKind: row.event_kind,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    runId: row.run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    contentHash: row.content_hash,
    previousEnvelopeHash: row.previous_envelope_hash ?? undefined,
    payloadHash: row.payload_hash,
    toolCallHashes: safeJsonParse<string[]>(row.tool_call_hashes_json, []),
    memoryLineage: safeJsonParse<string[]>(row.memory_lineage_json, []),
    policyHash: row.policy_hash ?? undefined,
    signatureStatus: row.signature_status,
    signature: row.signature ?? undefined,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function mapInput(input: EvidenceEnvelopeCreateInput, createdAt: string): EvidenceEnvelope {
  return {
    envelopeId: input.envelopeId,
    eventKind: input.eventKind,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
    approvalId: input.approvalId,
    contentHash: input.contentHash,
    previousEnvelopeHash: input.previousEnvelopeHash,
    payloadHash: input.payloadHash,
    toolCallHashes: input.toolCallHashes ?? [],
    memoryLineage: input.memoryLineage ?? [],
    policyHash: input.policyHash,
    signatureStatus: input.signatureStatus,
    signature: input.signature,
    metadata: input.metadata ?? {},
    createdAt,
  };
}

function buildOptionalTextFilterSql(dialect: DatabaseClient["dialect"], column: string, param: string): string {
  if (dialect === "postgres") {
    return `(${param}::text IS NULL OR ${column} = ${param}::text)`;
  }
  return `(${param} IS NULL OR ${column} = ${param})`;
}
