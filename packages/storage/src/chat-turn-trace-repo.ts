import type { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCitationRecord,
  ChatExecutionPlanRecord,
  ChatMode,
  ChatOrchestrationSummary,
  ChatSpecialistCandidateSuggestionRecord,
  ChatThinkingLevel,
  ChatTurnBranchKind,
  ChatTurnTraceRecord,
  ChatWebMode,
  ChatMemoryMode,
} from "@goatcitadel/contracts";

interface ChatTurnTraceRow {
  turn_id: string;
  session_id: string;
  user_message_id: string;
  parent_turn_id: string | null;
  branch_kind: ChatTurnBranchKind;
  source_turn_id: string | null;
  assistant_message_id: string | null;
  execution_plan_id: string | null;
  status: ChatTurnTraceRecord["status"];
  mode: ChatMode;
  model: string | null;
  web_mode: ChatWebMode;
  memory_mode: ChatMemoryMode;
  thinking_level: ChatThinkingLevel;
  routing_json: string;
  retrieval_json: string | null;
  reflection_json: string | null;
  proactive_json: string | null;
  completion_json: string | null;
  durable_json: string | null;
  orchestration_json: string | null;
  guidance_json: string | null;
  citations_json: string | null;
  capability_upgrade_suggestions_json: string | null;
  specialist_candidate_suggestions_json: string | null;
  failure_json: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ChatTurnTraceCreateInput {
  turnId: string;
  sessionId: string;
  userMessageId: string;
  parentTurnId?: string;
  branchKind?: ChatTurnBranchKind;
  sourceTurnId?: string;
  assistantMessageId?: string;
  executionPlanId?: string;
  status?: ChatTurnTraceRecord["status"];
  mode: ChatMode;
  model?: string;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  effectiveToolAutonomy?: ChatTurnTraceRecord["effectiveToolAutonomy"];
  routing?: ChatTurnTraceRecord["routing"];
  retrieval?: ChatTurnTraceRecord["retrieval"];
  reflection?: ChatTurnTraceRecord["reflection"];
  proactive?: ChatTurnTraceRecord["proactive"];
  completion?: ChatTurnTraceRecord["completion"];
  durable?: ChatTurnTraceRecord["durable"];
  orchestration?: ChatOrchestrationSummary;
  guidance?: ChatTurnTraceRecord["guidance"];
  citations?: ChatCitationRecord[];
  capabilityUpgradeSuggestions?: ChatCapabilityUpgradeSuggestion[];
  specialistCandidateSuggestions?: ChatSpecialistCandidateSuggestionRecord[];
  failure?: ChatTurnTraceRecord["failure"];
  startedAt?: string;
  finishedAt?: string;
}

export interface ChatTurnTracePatchInput {
  parentTurnId?: string;
  branchKind?: ChatTurnBranchKind;
  sourceTurnId?: string;
  assistantMessageId?: string;
  executionPlanId?: string;
  status?: ChatTurnTraceRecord["status"];
  model?: string;
  effectiveToolAutonomy?: ChatTurnTraceRecord["effectiveToolAutonomy"];
  routing?: ChatTurnTraceRecord["routing"];
  retrieval?: ChatTurnTraceRecord["retrieval"];
  reflection?: ChatTurnTraceRecord["reflection"];
  proactive?: ChatTurnTraceRecord["proactive"];
  completion?: ChatTurnTraceRecord["completion"];
  durable?: ChatTurnTraceRecord["durable"];
  orchestration?: ChatOrchestrationSummary;
  guidance?: ChatTurnTraceRecord["guidance"];
  citations?: ChatCitationRecord[];
  capabilityUpgradeSuggestions?: ChatCapabilityUpgradeSuggestion[];
  specialistCandidateSuggestions?: ChatSpecialistCandidateSuggestionRecord[];
  failure?: ChatTurnTraceRecord["failure"];
  finishedAt?: string;
}

export class ChatTurnTraceRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listBySessionStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM chat_turn_traces WHERE turn_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_turn_traces (
        turn_id, session_id, user_message_id, parent_turn_id, branch_kind, source_turn_id,
        assistant_message_id, execution_plan_id, status, mode, model, web_mode, memory_mode, thinking_level,
        routing_json, retrieval_json, reflection_json, proactive_json, completion_json, durable_json,
        orchestration_json, guidance_json, citations_json,
        failure_json,
        capability_upgrade_suggestions_json, specialist_candidate_suggestions_json, started_at, finished_at
      ) VALUES (
        @turnId, @sessionId, @userMessageId, @parentTurnId, @branchKind, @sourceTurnId,
        @assistantMessageId, @executionPlanId, @status, @mode, @model, @webMode, @memoryMode, @thinkingLevel,
        @routingJson, @retrievalJson, @reflectionJson, @proactiveJson, @completionJson, @durableJson,
        @orchestrationJson, @guidanceJson, @citationsJson,
        @failureJson,
        @capabilityUpgradeSuggestionsJson, @specialistCandidateSuggestionsJson, @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_turn_traces
      SET
        parent_turn_id = @parentTurnId,
        branch_kind = @branchKind,
        source_turn_id = @sourceTurnId,
        assistant_message_id = @assistantMessageId,
        execution_plan_id = @executionPlanId,
        status = @status,
        model = @model,
        routing_json = @routingJson,
        retrieval_json = @retrievalJson,
        reflection_json = @reflectionJson,
        proactive_json = @proactiveJson,
        completion_json = @completionJson,
        durable_json = @durableJson,
        orchestration_json = @orchestrationJson,
        guidance_json = @guidanceJson,
        citations_json = @citationsJson,
        failure_json = @failureJson,
        capability_upgrade_suggestions_json = @capabilityUpgradeSuggestionsJson,
        specialist_candidate_suggestions_json = @specialistCandidateSuggestionsJson,
        finished_at = @finishedAt
      WHERE turn_id = @turnId
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_turn_traces
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
  }

  public get(turnId: string): ChatTurnTraceRecord {
    const row = this.getStmt.get(turnId) as ChatTurnTraceRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat turn trace", id: turnId });
    }
    return mapRow(row);
  }

  public create(input: ChatTurnTraceCreateInput): ChatTurnTraceRecord {
    this.insertStmt.run({
      turnId: input.turnId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      parentTurnId: input.parentTurnId ?? null,
      branchKind: input.branchKind ?? "append",
      sourceTurnId: input.sourceTurnId ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      executionPlanId: input.executionPlanId ?? null,
      status: input.status ?? "running",
      mode: input.mode,
      model: input.model ?? null,
      webMode: input.webMode,
      memoryMode: input.memoryMode,
      thinkingLevel: input.thinkingLevel,
      routingJson: serializeRoutingJson(input.routing ?? {}, input.effectiveToolAutonomy),
      retrievalJson: input.retrieval ? JSON.stringify(input.retrieval) : null,
      reflectionJson: input.reflection ? JSON.stringify(input.reflection) : null,
      proactiveJson: input.proactive ? JSON.stringify(input.proactive) : null,
      completionJson: input.completion ? JSON.stringify(input.completion) : null,
      durableJson: input.durable ? JSON.stringify(input.durable) : null,
      orchestrationJson: input.orchestration ? JSON.stringify(input.orchestration) : null,
      guidanceJson: input.guidance ? JSON.stringify(input.guidance) : null,
      citationsJson: input.citations ? JSON.stringify(input.citations) : null,
      failureJson: input.failure ? JSON.stringify(input.failure) : null,
      capabilityUpgradeSuggestionsJson: input.capabilityUpgradeSuggestions
        ? JSON.stringify(input.capabilityUpgradeSuggestions)
        : null,
      specialistCandidateSuggestionsJson: input.specialistCandidateSuggestions
        ? JSON.stringify(input.specialistCandidateSuggestions)
        : null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.turnId);
  }

  public patch(turnId: string, input: ChatTurnTracePatchInput): ChatTurnTraceRecord {
    const current = this.get(turnId);
    const hasFailure = Object.prototype.hasOwnProperty.call(input, "failure");
    this.patchStmt.run({
      turnId,
      parentTurnId: input.parentTurnId !== undefined ? input.parentTurnId : (current.parentTurnId ?? null),
      branchKind: input.branchKind ?? current.branchKind,
      sourceTurnId: input.sourceTurnId !== undefined ? input.sourceTurnId : (current.sourceTurnId ?? null),
      assistantMessageId: input.assistantMessageId !== undefined
        ? input.assistantMessageId
        : (current.assistantMessageId ?? null),
      executionPlanId: input.executionPlanId !== undefined
        ? input.executionPlanId
        : (current.executionPlanId ?? null),
      status: input.status ?? current.status,
      model: input.model !== undefined ? input.model : (current.model ?? null),
      routingJson: serializeRoutingJson(
        input.routing ?? current.routing,
        input.effectiveToolAutonomy ?? current.effectiveToolAutonomy,
      ),
      retrievalJson: JSON.stringify(input.retrieval ?? current.retrieval ?? null),
      reflectionJson: JSON.stringify(input.reflection ?? current.reflection ?? null),
      proactiveJson: JSON.stringify(input.proactive ?? current.proactive ?? null),
      completionJson: JSON.stringify(input.completion ?? current.completion ?? null),
      durableJson: JSON.stringify(input.durable ?? current.durable ?? null),
      orchestrationJson: JSON.stringify(input.orchestration ?? current.orchestration ?? null),
      guidanceJson: JSON.stringify(input.guidance ?? current.guidance ?? null),
      citationsJson: JSON.stringify(input.citations ?? current.citations ?? []),
      failureJson: JSON.stringify(hasFailure ? input.failure ?? null : current.failure ?? null),
      capabilityUpgradeSuggestionsJson: JSON.stringify(
        input.capabilityUpgradeSuggestions ?? current.capabilityUpgradeSuggestions ?? [],
      ),
      specialistCandidateSuggestionsJson: JSON.stringify(
        input.specialistCandidateSuggestions ?? current.specialistCandidateSuggestions ?? [],
      ),
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
    });
    return this.get(turnId);
  }

  public listBySession(sessionId: string, limit = 100): ChatTurnTraceRecord[] {
    const rows = this.listBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 1000)),
    }) as unknown as ChatTurnTraceRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: ChatTurnTraceRow): ChatTurnTraceRecord {
  const { routing, effectiveToolAutonomy } = parseRoutingJson(row.routing_json);
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    parentTurnId: row.parent_turn_id ?? undefined,
    branchKind: row.branch_kind,
    sourceTurnId: row.source_turn_id ?? undefined,
    assistantMessageId: row.assistant_message_id ?? undefined,
    executionPlanId: row.execution_plan_id ?? undefined,
    status: row.status,
    mode: row.mode,
    model: row.model ?? undefined,
    webMode: row.web_mode,
    memoryMode: row.memory_mode,
    thinkingLevel: row.thinking_level,
    effectiveToolAutonomy,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    toolRuns: [],
    citations: safeJsonParse<ChatCitationRecord[]>(row.citations_json ?? "", []),
    failure: safeJsonParse<ChatTurnTraceRecord["failure"] | undefined>(row.failure_json ?? "", undefined),
    routing,
    retrieval: safeJsonParse<ChatTurnTraceRecord["retrieval"] | undefined>(row.retrieval_json ?? "", undefined),
    reflection: safeJsonParse<ChatTurnTraceRecord["reflection"] | undefined>(row.reflection_json ?? "", undefined),
    proactive: safeJsonParse<ChatTurnTraceRecord["proactive"] | undefined>(row.proactive_json ?? "", undefined),
    completion: safeJsonParse<ChatTurnTraceRecord["completion"] | undefined>(row.completion_json ?? "", undefined),
    durable: safeJsonParse<ChatTurnTraceRecord["durable"] | undefined>(row.durable_json ?? "", undefined),
    orchestration: safeJsonParse<ChatOrchestrationSummary | undefined>(row.orchestration_json ?? "", undefined),
    guidance: safeJsonParse<ChatTurnTraceRecord["guidance"] | undefined>(row.guidance_json ?? "", undefined),
    capabilityUpgradeSuggestions: safeJsonParse<ChatCapabilityUpgradeSuggestion[] | undefined>(
      row.capability_upgrade_suggestions_json ?? "",
      undefined,
    ),
    specialistCandidateSuggestions: safeJsonParse<ChatSpecialistCandidateSuggestionRecord[] | undefined>(
      row.specialist_candidate_suggestions_json ?? "",
      undefined,
    ),
  };
}

type PersistedRoutingJson = ChatTurnTraceRecord["routing"] & {
  __effectiveToolAutonomy?: ChatTurnTraceRecord["effectiveToolAutonomy"];
};

function serializeRoutingJson(
  routing: ChatTurnTraceRecord["routing"],
  effectiveToolAutonomy?: ChatTurnTraceRecord["effectiveToolAutonomy"],
): string {
  return JSON.stringify({
    ...routing,
    ...(effectiveToolAutonomy ? { __effectiveToolAutonomy: effectiveToolAutonomy } : {}),
  } satisfies PersistedRoutingJson);
}

function parseRoutingJson(raw: string): {
  routing: ChatTurnTraceRecord["routing"];
  effectiveToolAutonomy?: ChatTurnTraceRecord["effectiveToolAutonomy"];
} {
  const parsed = safeJsonParse<PersistedRoutingJson>(raw, {});
  const { __effectiveToolAutonomy: effectiveToolAutonomy, ...routing } = parsed;
  return {
    routing,
    effectiveToolAutonomy,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function attachTurnTraceDetails(
  trace: ChatTurnTraceRecord,
  details: {
    toolRuns?: ChatTurnTraceRecord["toolRuns"];
    citations?: ChatCitationRecord[];
    executionPlan?: ChatExecutionPlanRecord;
    capabilityUpgradeSuggestions?: ChatCapabilityUpgradeSuggestion[];
  },
): ChatTurnTraceRecord {
  return {
    ...trace,
    toolRuns: details.toolRuns ?? trace.toolRuns,
    citations: details.citations ?? trace.citations,
    executionPlan: details.executionPlan ?? trace.executionPlan,
    capabilityUpgradeSuggestions: details.capabilityUpgradeSuggestions ?? trace.capabilityUpgradeSuggestions,
  };
}
