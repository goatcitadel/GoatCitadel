import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  ChatMode,
  ChatSpecialistCandidateCreateInput,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatSpecialistCandidateRow {
  candidate_id: string;
  workspace_id: string | null;
  session_id: string;
  lead_turn_id: string | null;
  lead_run_id: string | null;
  title: string;
  role: string;
  summary: string;
  reason: string;
  source: ChatSpecialistCandidateRecord["source"];
  status: ChatSpecialistCandidateRecord["status"];
  routing_mode: ChatSpecialistCandidateRecord["routingMode"];
  confidence: number;
  requires_approval: number;
  suggested_tools_json: string | null;
  suggested_skills_json: string | null;
  routing_hints_json: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  retired_at: string | null;
}

export class ChatSpecialistCandidateRepository {
  private readonly getStmt;
  private readonly listBySessionStmt;
  private readonly insertStmt;
  private readonly patchStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_specialist_candidates WHERE candidate_id = ?");
    this.listBySessionStmt = db.prepare(`
      SELECT *
      FROM chat_specialist_candidates
      WHERE session_id = @sessionId
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO chat_specialist_candidates (
        candidate_id, workspace_id, session_id, lead_turn_id, lead_run_id, title, role, summary, reason,
        source, status, routing_mode, confidence, requires_approval, suggested_tools_json,
        suggested_skills_json, routing_hints_json, evidence_json, created_at, updated_at, activated_at, retired_at
      ) VALUES (
        @candidateId, @workspaceId, @sessionId, @leadTurnId, @leadRunId, @title, @role, @summary, @reason,
        @source, @status, @routingMode, @confidence, @requiresApproval, @suggestedToolsJson,
        @suggestedSkillsJson, @routingHintsJson, @evidenceJson, @createdAt, @updatedAt, @activatedAt, @retiredAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_specialist_candidates
      SET
        title = @title,
        summary = @summary,
        reason = @reason,
        status = @status,
        routing_mode = @routingMode,
        confidence = @confidence,
        suggested_tools_json = @suggestedToolsJson,
        suggested_skills_json = @suggestedSkillsJson,
        routing_hints_json = @routingHintsJson,
        evidence_json = @evidenceJson,
        updated_at = @updatedAt,
        activated_at = @activatedAt,
        retired_at = @retiredAt
      WHERE candidate_id = @candidateId
    `);
  }

  public get(candidateId: string): ChatSpecialistCandidateRecord {
    const row = toChatSpecialistCandidateRow(this.getStmt.get(candidateId));
    if (!row) {
      throw new NotFoundError({ entity: "Specialist candidate", id: candidateId });
    }
    return mapRow(row);
  }

  public find(candidateId: string): ChatSpecialistCandidateRecord | undefined {
    const row = toChatSpecialistCandidateRow(this.getStmt.get(candidateId));
    return row ? mapRow(row) : undefined;
  }

  public listBySession(sessionId: string, limit = 100): ChatSpecialistCandidateRecord[] {
    const rows = toChatSpecialistCandidateRows(this.listBySessionStmt.all({
      sessionId: sanitizeRequired(sessionId, "sessionId"),
      limit: Math.max(1, Math.min(limit, 500)),
    }));
    return rows.map(mapRow);
  }

  public create(
    sessionId: string,
    input: ChatSpecialistCandidateCreateInput & { workspaceId?: string },
    now = new Date().toISOString(),
  ): ChatSpecialistCandidateRecord {
    const candidateId = randomUUID();
    const status = input.status ?? "disabled";
    this.insertStmt.run({
      candidateId,
      workspaceId: input.workspaceId?.trim() ? input.workspaceId.trim() : null,
      sessionId: sanitizeRequired(sessionId, "sessionId"),
      leadTurnId: sanitizeOptional(input.leadTurnId),
      leadRunId: sanitizeOptional(input.leadRunId),
      title: sanitizeRequired(input.title, "title"),
      role: sanitizeRequired(input.role, "role"),
      summary: sanitizeRequired(input.summary, "summary"),
      reason: sanitizeRequired(input.reason, "reason"),
      source: input.source,
      status,
      routingMode: input.routingMode ?? "manual_only",
      confidence: clamp01(input.confidence),
      requiresApproval: input.requiresApproval === false ? 0 : 1,
      suggestedToolsJson: input.suggestedTools?.length ? JSON.stringify(dedupeStrings(input.suggestedTools)) : null,
      suggestedSkillsJson: input.suggestedSkills?.length ? JSON.stringify(dedupeStrings(input.suggestedSkills)) : null,
      routingHintsJson: JSON.stringify(input.routingHints),
      evidenceJson: JSON.stringify(input.evidence),
      createdAt: now,
      updatedAt: now,
      activatedAt: status === "active" ? now : null,
      retiredAt: status === "retired" ? now : null,
    });
    return this.get(candidateId);
  }

  public patch(candidateId: string, input: ChatSpecialistCandidatePatchInput, now = new Date().toISOString()): ChatSpecialistCandidateRecord {
    const current = this.get(candidateId);
    const nextStatus = input.status ?? current.status;
    const activatedAt = nextStatus === "active"
      ? (current.activatedAt ?? now)
      : null;
    const retiredAt = nextStatus === "retired"
      ? (current.retiredAt ?? now)
      : null;
    this.patchStmt.run({
      candidateId,
      title: input.title !== undefined ? sanitizeRequired(input.title, "title") : current.title,
      summary: input.summary !== undefined ? sanitizeRequired(input.summary, "summary") : current.summary,
      reason: input.reason !== undefined ? sanitizeRequired(input.reason, "reason") : current.reason,
      status: nextStatus,
      routingMode: input.routingMode ?? current.routingMode,
      confidence: input.confidence !== undefined ? clamp01(input.confidence) : current.confidence,
      suggestedToolsJson: JSON.stringify(input.suggestedTools ?? current.suggestedTools ?? []),
      suggestedSkillsJson: JSON.stringify(input.suggestedSkills ?? current.suggestedSkills ?? []),
      routingHintsJson: JSON.stringify(input.routingHints ?? current.routingHints),
      evidenceJson: JSON.stringify(input.evidence ?? current.evidence),
      updatedAt: now,
      activatedAt,
      retiredAt,
    });
    return this.get(candidateId);
  }

  public listAutoRoutable(sessionId: string, mode: ChatMode, hasProjectBinding: boolean): ChatSpecialistCandidateRecord[] {
    return this.listBySession(sessionId, 200).filter((candidate) => {
      if (candidate.status !== "active" || candidate.routingMode !== "strong_match_only") {
        return false;
      }
      if (!candidate.routingHints.preferredModes.includes(mode)) {
        return false;
      }
      if (candidate.routingHints.requiresProjectBinding && !hasProjectBinding) {
        return false;
      }
      return true;
    });
  }
}

function mapRow(row: ChatSpecialistCandidateRow): ChatSpecialistCandidateRecord {
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id ?? undefined,
    sessionId: row.session_id,
    leadTurnId: row.lead_turn_id ?? undefined,
    leadRunId: row.lead_run_id ?? undefined,
    title: row.title,
    role: row.role,
    summary: row.summary,
    reason: row.reason,
    source: row.source,
    status: row.status,
    routingMode: row.routing_mode,
    confidence: Number(row.confidence || 0),
    requiresApproval: row.requires_approval !== 0,
    suggestedTools: parseStringArray(row.suggested_tools_json),
    suggestedSkills: parseStringArray(row.suggested_skills_json),
    routingHints: safeJsonParse<ChatSpecialistCandidateRecord["routingHints"]>(row.routing_hints_json, {
      preferredModes: ["cowork", "code"],
    }),
    evidence: safeJsonParse<ChatSpecialistCandidateRecord["evidence"]>(row.evidence_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at ?? undefined,
    retiredAt: row.retired_at ?? undefined,
  };
}

function parseStringArray(raw: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<string[]>(raw, []).map((value) => value.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeOptional(value?: string): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function toChatSpecialistCandidateRow(value: unknown): ChatSpecialistCandidateRow | undefined {
  return isChatSpecialistCandidateRow(value) ? value : undefined;
}

function toChatSpecialistCandidateRows(value: unknown): ChatSpecialistCandidateRow[] {
  return Array.isArray(value) ? value.filter(isChatSpecialistCandidateRow) : [];
}

function isChatSpecialistCandidateRow(value: unknown): value is ChatSpecialistCandidateRow {
  return isRecord(value)
    && typeof value.candidate_id === "string"
    && (typeof value.workspace_id === "string" || value.workspace_id === null)
    && typeof value.session_id === "string"
    && (typeof value.lead_turn_id === "string" || value.lead_turn_id === null)
    && (typeof value.lead_run_id === "string" || value.lead_run_id === null)
    && typeof value.title === "string"
    && typeof value.role === "string"
    && typeof value.summary === "string"
    && typeof value.reason === "string"
    && typeof value.source === "string"
    && typeof value.status === "string"
    && typeof value.routing_mode === "string"
    && typeof value.confidence === "number"
    && typeof value.requires_approval === "number"
    && (typeof value.suggested_tools_json === "string" || value.suggested_tools_json === null)
    && (typeof value.suggested_skills_json === "string" || value.suggested_skills_json === null)
    && typeof value.routing_hints_json === "string"
    && typeof value.evidence_json === "string"
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && (typeof value.activated_at === "string" || value.activated_at === null)
    && (typeof value.retired_at === "string" || value.retired_at === null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


