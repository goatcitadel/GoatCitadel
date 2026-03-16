import type { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatCodeAutoApplyPosture,
  ChatMode,
  ChatMemoryMode,
  ChatOrchestrationIntensity,
  ChatOrchestrationParallelism,
  ChatOrchestrationProviderPreference,
  ChatOrchestrationReviewDepth,
  ChatOrchestrationVisibility,
  ChatPlanningMode,
  ChatSessionPrefsRecord,
  ChatThinkingLevel,
  ChatWebMode,
} from "@goatcitadel/contracts";

interface ChatSessionPrefsRow {
  session_id: string;
  mode: ChatMode;
  planning_mode: ChatPlanningMode;
  provider_id: string | null;
  model: string | null;
  web_mode: ChatWebMode;
  memory_mode: ChatMemoryMode;
  thinking_level: ChatThinkingLevel;
  tool_autonomy: "safe_auto" | "manual";
  vision_fallback_model: string | null;
  orchestration_enabled: number;
  orchestration_intensity: ChatOrchestrationIntensity;
  orchestration_visibility: ChatOrchestrationVisibility;
  orchestration_provider_preference: ChatOrchestrationProviderPreference;
  orchestration_review_depth: ChatOrchestrationReviewDepth;
  orchestration_parallelism: ChatOrchestrationParallelism;
  code_auto_apply: ChatCodeAutoApplyPosture;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionPrefsPatchInput {
  mode?: ChatMode;
  planningMode?: ChatPlanningMode;
  providerId?: string;
  model?: string;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  toolAutonomy?: "safe_auto" | "manual";
  visionFallbackModel?: string;
  orchestrationEnabled?: boolean;
  orchestrationIntensity?: ChatOrchestrationIntensity;
  orchestrationVisibility?: ChatOrchestrationVisibility;
  orchestrationProviderPreference?: ChatOrchestrationProviderPreference;
  orchestrationReviewDepth?: ChatOrchestrationReviewDepth;
  orchestrationParallelism?: ChatOrchestrationParallelism;
  codeAutoApply?: ChatCodeAutoApplyPosture;
}

const DEFAULT_PREFS: Omit<ChatSessionPrefsRecord, "sessionId" | "createdAt" | "updatedAt"> = {
  mode: "chat",
  planningMode: "off",
  providerId: undefined,
  model: undefined,
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  toolAutonomy: "safe_auto",
  visionFallbackModel: undefined,
  orchestrationEnabled: true,
  orchestrationIntensity: "balanced",
  orchestrationVisibility: "summarized",
  orchestrationProviderPreference: "balanced",
  orchestrationReviewDepth: "standard",
  orchestrationParallelism: "auto",
  codeAutoApply: "aggressive_auto",
};

export class ChatSessionPrefsRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_prefs WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_prefs (
        session_id, mode, planning_mode, provider_id, model, web_mode, memory_mode, thinking_level,
        tool_autonomy, vision_fallback_model, orchestration_enabled, orchestration_intensity,
        orchestration_visibility, orchestration_provider_preference, orchestration_review_depth,
        orchestration_parallelism, code_auto_apply, created_at, updated_at
      ) VALUES (
        @sessionId, @mode, @planningMode, @providerId, @model, @webMode, @memoryMode, @thinkingLevel,
        @toolAutonomy, @visionFallbackModel, @orchestrationEnabled, @orchestrationIntensity,
        @orchestrationVisibility, @orchestrationProviderPreference, @orchestrationReviewDepth,
        @orchestrationParallelism, @codeAutoApply, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        mode = excluded.mode,
        planning_mode = excluded.planning_mode,
        provider_id = excluded.provider_id,
        model = excluded.model,
        web_mode = excluded.web_mode,
        memory_mode = excluded.memory_mode,
        thinking_level = excluded.thinking_level,
        tool_autonomy = excluded.tool_autonomy,
        vision_fallback_model = excluded.vision_fallback_model,
        orchestration_enabled = excluded.orchestration_enabled,
        orchestration_intensity = excluded.orchestration_intensity,
        orchestration_visibility = excluded.orchestration_visibility,
        orchestration_provider_preference = excluded.orchestration_provider_preference,
        orchestration_review_depth = excluded.orchestration_review_depth,
        orchestration_parallelism = excluded.orchestration_parallelism,
        code_auto_apply = excluded.code_auto_apply,
        updated_at = excluded.updated_at
    `);
  }

  public get(sessionId: string): ChatSessionPrefsRecord | undefined {
    const row = this.getStmt.get(sessionId) as unknown as ChatSessionPrefsRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public ensure(sessionId: string, now = new Date().toISOString()): ChatSessionPrefsRecord {
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }
    this.upsertStmt.run({
      sessionId,
      mode: DEFAULT_PREFS.mode,
      planningMode: DEFAULT_PREFS.planningMode,
      providerId: null,
      model: null,
      webMode: DEFAULT_PREFS.webMode,
      memoryMode: DEFAULT_PREFS.memoryMode,
      thinkingLevel: DEFAULT_PREFS.thinkingLevel,
      toolAutonomy: DEFAULT_PREFS.toolAutonomy,
      visionFallbackModel: null,
      orchestrationEnabled: DEFAULT_PREFS.orchestrationEnabled ? 1 : 0,
      orchestrationIntensity: DEFAULT_PREFS.orchestrationIntensity,
      orchestrationVisibility: DEFAULT_PREFS.orchestrationVisibility,
      orchestrationProviderPreference: DEFAULT_PREFS.orchestrationProviderPreference,
      orchestrationReviewDepth: DEFAULT_PREFS.orchestrationReviewDepth,
      orchestrationParallelism: DEFAULT_PREFS.orchestrationParallelism,
      codeAutoApply: DEFAULT_PREFS.codeAutoApply,
      createdAt: now,
      updatedAt: now,
    });
    return mapRow(this.requireRow(sessionId));
  }

  public patch(sessionId: string, input: ChatSessionPrefsPatchInput, now = new Date().toISOString()): ChatSessionPrefsRecord {
    const current = this.ensure(sessionId, now);
    this.upsertStmt.run({
      sessionId,
      mode: input.mode ?? current.mode,
      planningMode: input.planningMode ?? current.planningMode,
      providerId: input.providerId !== undefined ? normalizeOptional(input.providerId) : (current.providerId ?? null),
      model: input.model !== undefined ? normalizeOptional(input.model) : (current.model ?? null),
      webMode: input.webMode ?? current.webMode,
      memoryMode: input.memoryMode ?? current.memoryMode,
      thinkingLevel: input.thinkingLevel ?? current.thinkingLevel,
      toolAutonomy: input.toolAutonomy ?? current.toolAutonomy,
      visionFallbackModel: input.visionFallbackModel !== undefined
        ? normalizeOptional(input.visionFallbackModel)
        : (current.visionFallbackModel ?? null),
      orchestrationEnabled: input.orchestrationEnabled !== undefined
        ? (input.orchestrationEnabled ? 1 : 0)
        : (current.orchestrationEnabled ? 1 : 0),
      orchestrationIntensity: input.orchestrationIntensity ?? current.orchestrationIntensity,
      orchestrationVisibility: input.orchestrationVisibility ?? current.orchestrationVisibility,
      orchestrationProviderPreference: input.orchestrationProviderPreference ?? current.orchestrationProviderPreference,
      orchestrationReviewDepth: input.orchestrationReviewDepth ?? current.orchestrationReviewDepth,
      orchestrationParallelism: input.orchestrationParallelism ?? current.orchestrationParallelism,
      codeAutoApply: input.codeAutoApply ?? current.codeAutoApply,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    return mapRow(this.requireRow(sessionId));
  }

  private requireRow(sessionId: string): ChatSessionPrefsRow {
    const row = this.getStmt.get(sessionId) as unknown as ChatSessionPrefsRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "chat session prefs", id: sessionId });
    }
    return row;
  }
}

function mapRow(row: ChatSessionPrefsRow): ChatSessionPrefsRecord {
  return {
    sessionId: row.session_id,
    mode: row.mode,
    planningMode: row.planning_mode,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    webMode: row.web_mode,
    memoryMode: row.memory_mode,
    thinkingLevel: row.thinking_level,
    toolAutonomy: row.tool_autonomy,
    visionFallbackModel: row.vision_fallback_model ?? undefined,
    orchestrationEnabled: row.orchestration_enabled !== 0,
    orchestrationIntensity: row.orchestration_intensity,
    orchestrationVisibility: row.orchestration_visibility,
    orchestrationProviderPreference: row.orchestration_provider_preference,
    orchestrationReviewDepth: row.orchestration_review_depth,
    orchestrationParallelism: row.orchestration_parallelism,
    codeAutoApply: row.code_auto_apply,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
