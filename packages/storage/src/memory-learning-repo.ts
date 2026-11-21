import { createHash } from "node:crypto";
import {
  ConflictError,
  memoryClaimKey,
  normalizeMemoryClaim,
  type MemoryClaim,
  type MemoryLearningRecord,
  type MemoryLearningStatus,
  type TranscriptEvent,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface LearningRow {
  learning_id: string;
  workspace_id: string;
  learning_key: string;
  learning_type: MemoryLearningRecord["type"];
  insight: string;
  confidence: number;
  status: MemoryLearningStatus;
  source_refs_json: string;
  file_refs_json: string;
  authority: MemoryLearningRecord["authority"];
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
  claim_json?: string | null;
}

export function memoryLearningSourceHash(record: MemoryLearningRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        record.learningId,
        record.workspaceId,
        record.key,
        record.type,
        record.insight,
        record.confidence,
        record.status,
        record.authority,
        record.sourceRefs,
        record.fileRefs,
        record.claim ?? null,
        record.supersededById ?? null,
        record.createdAt,
        record.updatedAt,
      ]),
    )
    .digest("hex");
}

export function claimStorageFields(workspaceId: string, claim?: MemoryClaim) {
  if (!claim) return { claimJson: null, claimKey: null, claimScalar: null, claimScopeKind: null, claimScopeId: null };
  const normalized = normalizeMemoryClaim(claim);
  return {
    claimJson: JSON.stringify(normalized),
    claimKey: memoryClaimKey(workspaceId, normalized),
    claimScalar: normalized.identity.cardinality === "scalar" ? 1 : 0,
    claimScopeKind: normalized.identity.scope.kind,
    claimScopeId: normalized.identity.scope.id,
  };
}

export type ConsolidationSourceInspection =
  | { status: "ready"; sourceHash: string; events: TranscriptEvent[] }
  | { status: "excluded"; sourceHash: string; reason: "source_size_limit" }
  | { status: "unavailable" };

export class MemoryLearningRepository {
  public constructor(private readonly db: DatabaseClient) {}

  /** Full canonical bytes bind an automated proposal to its private source window.
   * No ownership is inferred for legacy or machine-origin messages. */
  public readConsolidationSource(input: {
    workspaceId: string;
    sessionId: string;
    turnIds: string[];
  }): { sourceHash: string; events: TranscriptEvent[] } | undefined {
    const inspection = this.inspectConsolidationSource(input);
    return inspection.status === "ready" ? { sourceHash: inspection.sourceHash, events: inspection.events } : undefined;
  }

  public inspectConsolidationSource(input: {
    workspaceId: string;
    sessionId: string;
    turnIds: string[];
  }): ConsolidationSourceInspection {
    if (
      !input.workspaceId ||
      !input.sessionId ||
      !Array.isArray(input.turnIds) ||
      !input.turnIds.length ||
      input.turnIds.length > 500 ||
      input.turnIds.some((id) => typeof id !== "string" || !id || id.length > 300)
    )
      return { status: "unavailable" };
    const ids = [...new Set(input.turnIds)].sort();
    return this.db.transaction("immediate", () => {
      const suffix = this.db.dialect === "postgres" ? " FOR SHARE" : "";
      const meta = this.db
        .prepare(
          `SELECT session_id,lifecycle_intent_id FROM chat_session_meta WHERE session_id=? AND workspace_id=? AND origin='operator' AND lifecycle_status='active' AND deletion_intent_id IS NULL${suffix}`,
        )
        .get<{ session_id: string; lifecycle_intent_id: string | null }>(input.sessionId, input.workspaceId);
      if (!meta) return { status: "unavailable" };
      const prefs = this.db
        .prepare(`SELECT memory_mode FROM chat_session_prefs WHERE session_id=?${suffix}`)
        .get<{ memory_mode: string }>(input.sessionId);
      if (prefs?.memory_mode === "off") return { status: "unavailable" };
      const rows = this.db
        .prepare(
          `SELECT t.turn_id,t.finished_at,t.completion_json,t.reflection_json,u.message_id AS user_id,u.content AS user_text,u.timestamp AS user_at,a.message_id AS assistant_id,a.content AS assistant_text,a.timestamp AS assistant_at
        FROM chat_turn_traces t JOIN sessions s ON s.session_id=t.session_id JOIN chat_messages u ON u.message_id=t.user_message_id AND u.session_id=t.session_id JOIN chat_messages a ON a.message_id=t.assistant_message_id AND a.session_id=t.session_id
        WHERE t.session_id=? AND t.turn_id IN (${ids.map(() => "?").join(",")}) AND t.status='completed' AND t.finished_at IS NOT NULL AND t.memory_mode<>'off' AND s.kind='dm'
          AND u.role='user' AND u.actor_type='user' AND u.source_authority='operator' AND u.parent_delegation_step_id IS NULL
          AND a.role='assistant' AND a.actor_type='agent' AND a.parent_delegation_step_id IS NULL
        ORDER BY t.finished_at,t.turn_id ${this.db.dialect === "postgres" ? "FOR SHARE OF t,s,u,a" : ""}`,
        )
        .all<{
          turn_id: string;
          finished_at: string;
          completion_json: string | null;
          reflection_json: string | null;
          user_id: string;
          user_text: string;
          user_at: string;
          assistant_id: string;
          assistant_text: string;
          assistant_at: string;
        }>(input.sessionId, ...ids);
      if (rows.length !== ids.length || rows.some((row) => !completedConsolidationEvidence(row)))
        return { status: "unavailable" };
      const sourceHash = createHash("sha256")
        .update(JSON.stringify([1, input.workspaceId, input.sessionId, meta.lifecycle_intent_id, ids, rows]))
        .digest("hex");
      if (
        rows.some((row) => row.user_text.length > 65536 || row.assistant_text.length > 65536) ||
        JSON.stringify(rows).length > 256_000
      )
        return { status: "excluded", sourceHash, reason: "source_size_limit" };
      const events: TranscriptEvent[] = rows.flatMap((row) => [
        {
          eventId: row.user_id,
          actionId: row.turn_id,
          idempotencyKey: row.user_id,
          sessionId: input.sessionId,
          sessionKey: input.sessionId,
          timestamp: row.user_at,
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: { content: row.user_text },
        },
        {
          eventId: row.assistant_id,
          actionId: row.turn_id,
          idempotencyKey: row.assistant_id,
          sessionId: input.sessionId,
          sessionKey: input.sessionId,
          timestamp: row.assistant_at,
          type: "message.assistant",
          actorType: "agent",
          actorId: "assistant",
          payload: { content: row.assistant_text },
        },
      ]);
      return { status: "ready", sourceHash, events };
    });
  }

  /** Called inside the promotion transaction; PostgreSQL retains these source locks until commit. */
  public readOperatorSource(input: {
    workspaceId: string;
    sessionId: string;
    messageId: string;
  }): { sourceHash: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT m.content FROM chat_messages m
      JOIN chat_session_meta meta ON meta.session_id = m.session_id JOIN sessions s ON s.session_id = m.session_id
      WHERE m.message_id = @messageId AND m.session_id = @sessionId AND meta.workspace_id = @workspaceId
        AND meta.lifecycle_status = 'active' AND meta.origin = 'operator' AND s.kind = 'dm'
        AND m.role = 'user' AND m.actor_type = 'user' AND m.source_authority = 'operator' AND m.parent_delegation_step_id IS NULL
      ${this.db.dialect === "postgres" ? "FOR SHARE OF m, meta, s" : ""}`,
      )
      .get<{ content: string }>(input);
    return row ? { sourceHash: createHash("sha256").update(row.content).digest("hex") } : undefined;
  }

  public get(learningId: string): MemoryLearningRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_learnings WHERE learning_id = ?").get<LearningRow>(learningId);
    return row ? mapLearning(row) : undefined;
  }

  public list(input: {
    workspaceId: string;
    status?: MemoryLearningStatus | "all";
    query?: string;
    key?: string;
    limit?: number;
  }): MemoryLearningRecord[] {
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: input.workspaceId,
      limit: Math.max(1, Math.min(2000, Math.floor(input.limit ?? 200))),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.key) {
      clauses.push("learning_key = @key");
      params.key = input.key;
    }
    if (input.query?.trim()) {
      clauses.push("(LOWER(learning_key) LIKE @query OR LOWER(insight) LIKE @query)");
      params.query = `%${input.query.trim().toLowerCase()}%`;
    }
    return this.db
      .prepare(
        `SELECT * FROM memory_learnings WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, learning_id DESC LIMIT @limit`,
      )
      .all<LearningRow>(params)
      .map(mapLearning);
  }

  public insert(record: MemoryLearningRecord): MemoryLearningRecord {
    return this.db.transaction("immediate", () => this.insertAtomic(record));
  }

  private insertAtomic(record: MemoryLearningRecord): MemoryLearningRecord {
    this.assertClaimScope(record.workspaceId, record.claim);
    const fields = claimStorageFields(record.workspaceId, record.claim);
    this.db
      .prepare(
        `INSERT INTO memory_learnings (
      learning_id, workspace_id, learning_key, learning_type, insight, confidence, status, source_refs_json, file_refs_json,
      authority, superseded_by_id, created_at, updated_at, claim_json, claim_key, claim_scalar, claim_scope_kind, claim_scope_id
    ) VALUES (@learningId, @workspaceId, @key, @type, @insight, @confidence, @status, @sourceRefsJson, @fileRefsJson,
      @authority, @supersededById, @createdAt, @updatedAt, @claimJson, @claimKey, @claimScalar, @claimScopeKind, @claimScopeId)`,
      )
      .run({
        learningId: record.learningId,
        workspaceId: record.workspaceId,
        key: record.key,
        type: record.type,
        insight: record.insight,
        confidence: record.confidence,
        status: record.status,
        authority: record.authority,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        supersededById: record.supersededById ?? null,
        sourceRefsJson: JSON.stringify(record.sourceRefs),
        fileRefsJson: JSON.stringify(record.fileRefs),
        ...fields,
      });
    return this.get(record.learningId)!;
  }

  public findClaim(workspaceId: string, claim: MemoryClaim): MemoryLearningRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM memory_learnings WHERE workspace_id = ? AND claim_key = ? AND status = 'trusted' ORDER BY learning_id LIMIT 2000",
      )
      .all<LearningRow>(workspaceId, memoryClaimKey(workspaceId, claim))
      .map(mapLearning);
  }

  public supersede(input: { learningId: string; expectedSourceHash: string; next: MemoryLearningRecord }): {
    previous: MemoryLearningRecord;
    next: MemoryLearningRecord;
  } {
    return this.db.transaction("immediate", () => {
      const row = this.db
        .prepare(
          `SELECT * FROM memory_learnings WHERE learning_id = ?${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get<LearningRow>(input.learningId);
      const previous = row ? mapLearning(row) : undefined;
      if (
        !previous ||
        !["trusted", "proposed"].includes(previous.status) ||
        previous.sourceHash !== input.expectedSourceHash ||
        previous.workspaceId !== input.next.workspaceId ||
        input.next.authority === "agent_proposed" ||
        input.next.status !== "trusted"
      )
        throw new ConflictError({ message: "The reviewed memory correction changed or is not authorized." });
      if (
        previous.claim &&
        (!input.next.claim ||
          memoryClaimKey(previous.workspaceId, previous.claim) !==
            memoryClaimKey(input.next.workspaceId, input.next.claim))
      )
        throw new ConflictError({ message: "A correction must retain the target claim identity." });
      this.db
        .prepare(
          "UPDATE memory_learnings SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE learning_id = ?",
        )
        .run(input.next.learningId, input.next.updatedAt, previous.learningId);
      const next = this.insert(input.next);
      return { previous: this.get(previous.learningId)!, next };
    });
  }

  public assertClaimScope(workspaceId: string, claim?: MemoryClaim): void {
    if (!claim) return;
    memoryClaimKey(workspaceId, claim);
    const scope = claim.identity.scope;
    if (scope.kind === "workspace") return;
    const row =
      scope.kind === "session"
        ? this.db
            .prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = ?")
            .get<{ workspace_id: string }>(scope.id)
        : this.db
            .prepare("SELECT workspace_id FROM chat_projects WHERE project_id = ? AND lifecycle_status = 'active'")
            .get<{ workspace_id: string }>(scope.id);
    if (row?.workspace_id !== workspaceId)
      throw new ConflictError({ message: "Claim scope does not belong to this workspace." });
  }
}

function completedConsolidationEvidence(row: {
  completion_json: string | null;
  reflection_json: string | null;
}): boolean {
  const completion = safeJsonParse<Record<string, unknown> | null>(row.completion_json ?? "null", null);
  const reflection = safeJsonParse<Record<string, unknown> | null>(row.reflection_json ?? "null", null);
  return (
    completion?.status === "complete" &&
    typeof completion.providerCallCount === "number" &&
    Number.isFinite(completion.providerCallCount) &&
    completion.providerCallCount > 0 &&
    reflection?.outcome !== "still_failed" &&
    (typeof reflection?.attemptCount !== "number" || reflection.attemptCount <= 1)
  );
}

export function mapLearning(row: LearningRow): MemoryLearningRecord {
  const parsed = row.claim_json ? safeJsonParse<MemoryClaim | undefined>(row.claim_json, undefined) : undefined;
  if (row.claim_json && !parsed) throw new TypeError("Invalid stored memory claim.");
  const record: MemoryLearningRecord = {
    learningId: row.learning_id,
    workspaceId: row.workspace_id,
    key: row.learning_key,
    type: row.learning_type,
    insight: row.insight,
    confidence: Number(row.confidence),
    status: row.status,
    sourceRefs: safeJsonParse(row.source_refs_json, []),
    fileRefs: safeJsonParse(row.file_refs_json, []),
    authority: row.authority,
    supersededById: row.superseded_by_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(parsed ? { claim: normalizeMemoryClaim(parsed) } : {}),
  };
  return { ...record, sourceHash: memoryLearningSourceHash(record) };
}
