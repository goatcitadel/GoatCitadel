import type { DatabaseClient } from "./db.js";
import { NotFoundError } from "@goatcitadel/contracts";
import { ChatSessionRevisionRepository } from "./chat-session-revision-repo.js";
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
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatThinkingLevel,
  ChatWebMode,
} from "@goatcitadel/contracts";

interface ChatSessionPrefsRow {
  session_id: string;
  aggregate_revision: number | null | undefined;
  mode: ChatMode;
  planning_mode: ChatPlanningMode;
  provider_id: string | null;
  model: string | null;
  image_provider_id: string | null;
  image_model: string | null;
  web_mode: ChatWebMode;
  memory_mode: ChatMemoryMode;
  thinking_level: ChatThinkingLevel;
  speed_mode: ChatSpeedMode | null;
  subagent_policy: ChatSubagentPolicy | null;
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
  imageProviderId?: string;
  imageModel?: string;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
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

export interface RevisionedChatSessionPrefsRecord extends ChatSessionPrefsRecord {
  revision: number;
}

const DEFAULT_PREFS: Omit<ChatSessionPrefsRecord, "sessionId" | "revision" | "createdAt" | "updatedAt"> = {
  mode: "chat",
  planningMode: "off",
  providerId: undefined,
  model: undefined,
  imageProviderId: undefined,
  imageModel: undefined,
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  speedMode: "standard",
  subagentPolicy: "ask_when_useful",
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
  private readonly revisions;

  public constructor(private readonly db: DatabaseClient) {
    this.revisions = new ChatSessionRevisionRepository(db);
    this.getStmt = db.prepare(`
      SELECT prefs.*, meta.revision AS aggregate_revision
      FROM chat_session_prefs AS prefs
      LEFT JOIN chat_session_meta AS meta ON meta.session_id = prefs.session_id
      WHERE prefs.session_id = ?
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_prefs (
        session_id, mode, planning_mode, provider_id, model, image_provider_id, image_model,
        web_mode, memory_mode, thinking_level, speed_mode, subagent_policy,
        tool_autonomy, vision_fallback_model, orchestration_enabled, orchestration_intensity,
        orchestration_visibility, orchestration_provider_preference, orchestration_review_depth,
        orchestration_parallelism, code_auto_apply, created_at, updated_at
      ) VALUES (
        @sessionId, @mode, @planningMode, @providerId, @model, @imageProviderId, @imageModel,
        @webMode, @memoryMode, @thinkingLevel, @speedMode, @subagentPolicy,
        @toolAutonomy, @visionFallbackModel, @orchestrationEnabled, @orchestrationIntensity,
        @orchestrationVisibility, @orchestrationProviderPreference, @orchestrationReviewDepth,
        @orchestrationParallelism, @codeAutoApply, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        mode = excluded.mode,
        planning_mode = excluded.planning_mode,
        provider_id = excluded.provider_id,
        model = excluded.model,
        image_provider_id = excluded.image_provider_id,
        image_model = excluded.image_model,
        web_mode = excluded.web_mode,
        memory_mode = excluded.memory_mode,
        thinking_level = excluded.thinking_level,
        speed_mode = excluded.speed_mode,
        subagent_policy = excluded.subagent_policy,
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

  public get(sessionId: string): RevisionedChatSessionPrefsRecord | undefined {
    const row = toChatSessionPrefsRow(this.getStmt.get(sessionId));
    if (!row) {
      return undefined;
    }
    return withRevision(mapRow(row), normalizeAggregateRevision(row.aggregate_revision));
  }

  public listBySessionIds(sessionIds: string[]): Map<string, RevisionedChatSessionPrefsRecord> {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return new Map();
    }
    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    const rows = toChatSessionPrefsRows(
      this.db
        .prepare(
          `
          SELECT prefs.*, meta.revision AS aggregate_revision
          FROM chat_session_prefs AS prefs
          LEFT JOIN chat_session_meta AS meta ON meta.session_id = prefs.session_id
          WHERE prefs.session_id IN (${placeholders})
        `,
        )
        .all(...uniqueSessionIds),
    );
    return new Map(
      rows.map((row) => [
        row.session_id,
        withRevision(mapRow(row), normalizeAggregateRevision(row.aggregate_revision)),
      ]),
    );
  }

  public ensure(sessionId: string, now = new Date().toISOString()): RevisionedChatSessionPrefsRecord {
    const revision = this.revisions.ensure(sessionId, now);
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
      imageProviderId: null,
      imageModel: null,
      webMode: DEFAULT_PREFS.webMode,
      memoryMode: DEFAULT_PREFS.memoryMode,
      thinkingLevel: DEFAULT_PREFS.thinkingLevel,
      speedMode: DEFAULT_PREFS.speedMode,
      subagentPolicy: DEFAULT_PREFS.subagentPolicy,
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
    return withRevision(mapRow(this.requireRow(sessionId)), revision.revision);
  }

  public patch(
    sessionId: string,
    input: ChatSessionPrefsPatchInput,
    now = new Date().toISOString(),
  ): RevisionedChatSessionPrefsRecord {
    const current = this.ensure(sessionId, now);
    return this.patchWithRevision(sessionId, input, current.revision, now);
  }

  public patchWithRevision(
    sessionId: string,
    input: ChatSessionPrefsPatchInput,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): RevisionedChatSessionPrefsRecord {
    const result = this.revisions.runWithRevision(
      sessionId,
      expectedRevision,
      () => this.patchWithinAggregate(sessionId, input, expectedRevision, now),
      now,
    );
    return { ...result.value, revision: result.revision };
  }

  /**
   * Transaction-internal child mutation used by aggregate chat-session writes.
   * The caller must already hold the chat-session revision fence and owns the
   * single aggregate revision bump.
   */
  public patchWithinAggregate(
    sessionId: string,
    input: ChatSessionPrefsPatchInput,
    revision: number,
    now = new Date().toISOString(),
  ): { value: RevisionedChatSessionPrefsRecord; changed: boolean } {
    const current = this.get(sessionId) ?? this.createDefaultsUnchecked(sessionId, now, revision);
    const nextProviderId =
      input.providerId !== undefined ? normalizeOptional(input.providerId) : (current.providerId ?? null);
    const providerChanged = input.providerId !== undefined && nextProviderId !== (current.providerId ?? null);
    const nextImageProviderId =
      input.imageProviderId !== undefined
        ? normalizeOptional(input.imageProviderId)
        : (current.imageProviderId ?? null);
    const imageProviderChanged =
      input.imageProviderId !== undefined && nextImageProviderId !== (current.imageProviderId ?? null);
    const next = {
      sessionId,
      mode: "chat",
      planningMode: input.planningMode ?? current.planningMode,
      providerId: nextProviderId,
      model:
        input.model !== undefined ? normalizeOptional(input.model) : providerChanged ? null : (current.model ?? null),
      imageProviderId: nextImageProviderId,
      imageModel:
        input.imageModel !== undefined
          ? normalizeOptional(input.imageModel)
          : imageProviderChanged
            ? null
            : (current.imageModel ?? null),
      webMode: input.webMode ?? current.webMode,
      memoryMode: input.memoryMode ?? current.memoryMode,
      thinkingLevel: input.thinkingLevel ?? current.thinkingLevel,
      speedMode: input.speedMode ?? current.speedMode ?? "standard",
      subagentPolicy: input.subagentPolicy ?? current.subagentPolicy ?? "ask_when_useful",
      toolAutonomy: input.toolAutonomy ?? current.toolAutonomy,
      visionFallbackModel:
        input.visionFallbackModel !== undefined
          ? normalizeOptional(input.visionFallbackModel)
          : (current.visionFallbackModel ?? null),
      orchestrationEnabled:
        input.orchestrationEnabled !== undefined
          ? input.orchestrationEnabled
            ? 1
            : 0
          : current.orchestrationEnabled
            ? 1
            : 0,
      orchestrationIntensity: input.orchestrationIntensity ?? current.orchestrationIntensity,
      orchestrationVisibility: input.orchestrationVisibility ?? current.orchestrationVisibility,
      orchestrationProviderPreference: input.orchestrationProviderPreference ?? current.orchestrationProviderPreference,
      orchestrationReviewDepth: input.orchestrationReviewDepth ?? current.orchestrationReviewDepth,
      orchestrationParallelism: input.orchestrationParallelism ?? current.orchestrationParallelism,
      codeAutoApply: input.codeAutoApply ?? current.codeAutoApply,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    if (isSemanticNoop(current, next)) {
      return { value: { ...current, revision }, changed: false };
    }
    this.upsertStmt.run(next);
    return { value: withRevision(mapRow(this.requireRow(sessionId)), revision), changed: true };
  }

  private createDefaultsUnchecked(sessionId: string, now: string, revision: number): RevisionedChatSessionPrefsRecord {
    this.upsertStmt.run({
      sessionId,
      mode: DEFAULT_PREFS.mode,
      planningMode: DEFAULT_PREFS.planningMode,
      providerId: null,
      model: null,
      imageProviderId: null,
      imageModel: null,
      webMode: DEFAULT_PREFS.webMode,
      memoryMode: DEFAULT_PREFS.memoryMode,
      thinkingLevel: DEFAULT_PREFS.thinkingLevel,
      speedMode: DEFAULT_PREFS.speedMode,
      subagentPolicy: DEFAULT_PREFS.subagentPolicy,
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
    return withRevision(mapRow(this.requireRow(sessionId)), revision);
  }

  private requireRow(sessionId: string): ChatSessionPrefsRow {
    const row = toChatSessionPrefsRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new NotFoundError({ entity: "chat session prefs", id: sessionId });
    }
    return row;
  }
}

function mapRow(row: ChatSessionPrefsRow): ChatSessionPrefsRecord {
  return {
    sessionId: row.session_id,
    revision: normalizeAggregateRevision(row.aggregate_revision),
    mode: "chat",
    planningMode: row.planning_mode,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    imageProviderId: row.image_provider_id ?? undefined,
    imageModel: row.image_model ?? undefined,
    webMode: row.web_mode,
    memoryMode: row.memory_mode,
    thinkingLevel: row.thinking_level,
    speedMode: row.speed_mode ?? "standard",
    subagentPolicy: row.subagent_policy ?? "ask_when_useful",
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

function withRevision(record: ChatSessionPrefsRecord, revision: number): RevisionedChatSessionPrefsRecord {
  return { ...record, revision };
}

function isSemanticNoop(
  current: RevisionedChatSessionPrefsRecord,
  next: {
    planningMode: ChatPlanningMode;
    providerId: string | null;
    model: string | null;
    imageProviderId: string | null;
    imageModel: string | null;
    webMode: ChatWebMode;
    memoryMode: ChatMemoryMode;
    thinkingLevel: ChatThinkingLevel;
    speedMode: ChatSpeedMode;
    subagentPolicy: ChatSubagentPolicy;
    toolAutonomy: "safe_auto" | "manual";
    visionFallbackModel: string | null;
    orchestrationEnabled: number;
    orchestrationIntensity: ChatOrchestrationIntensity;
    orchestrationVisibility: ChatOrchestrationVisibility;
    orchestrationProviderPreference: ChatOrchestrationProviderPreference;
    orchestrationReviewDepth: ChatOrchestrationReviewDepth;
    orchestrationParallelism: ChatOrchestrationParallelism;
    codeAutoApply: ChatCodeAutoApplyPosture;
  },
): boolean {
  return (
    next.planningMode === current.planningMode &&
    next.providerId === (current.providerId ?? null) &&
    next.model === (current.model ?? null) &&
    next.imageProviderId === (current.imageProviderId ?? null) &&
    next.imageModel === (current.imageModel ?? null) &&
    next.webMode === current.webMode &&
    next.memoryMode === current.memoryMode &&
    next.thinkingLevel === current.thinkingLevel &&
    next.speedMode === (current.speedMode ?? "standard") &&
    next.subagentPolicy === (current.subagentPolicy ?? "ask_when_useful") &&
    next.toolAutonomy === current.toolAutonomy &&
    next.visionFallbackModel === (current.visionFallbackModel ?? null) &&
    next.orchestrationEnabled === (current.orchestrationEnabled ? 1 : 0) &&
    next.orchestrationIntensity === current.orchestrationIntensity &&
    next.orchestrationVisibility === current.orchestrationVisibility &&
    next.orchestrationProviderPreference === current.orchestrationProviderPreference &&
    next.orchestrationReviewDepth === current.orchestrationReviewDepth &&
    next.orchestrationParallelism === current.orchestrationParallelism &&
    next.codeAutoApply === current.codeAutoApply
  );
}

function toChatSessionPrefsRow(value: unknown): ChatSessionPrefsRow | undefined {
  return isChatSessionPrefsRow(value) ? value : undefined;
}

function toChatSessionPrefsRows(value: unknown): ChatSessionPrefsRow[] {
  if (!Array.isArray(value) || value.some((row) => !isChatSessionPrefsRow(row))) {
    throw new TypeError("Unexpected chat_session_prefs row shape");
  }
  return value;
}

function isChatSessionPrefsRow(value: unknown): value is ChatSessionPrefsRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.session_id === "string" &&
    (typeof value.aggregate_revision === "number" ||
      value.aggregate_revision === null ||
      value.aggregate_revision === undefined) &&
    typeof value.mode === "string" &&
    typeof value.planning_mode === "string" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.image_provider_id === "string" || value.image_provider_id === null) &&
    (typeof value.image_model === "string" || value.image_model === null) &&
    typeof value.web_mode === "string" &&
    typeof value.memory_mode === "string" &&
    typeof value.thinking_level === "string" &&
    (typeof value.speed_mode === "string" || value.speed_mode === null || value.speed_mode === undefined) &&
    (typeof value.subagent_policy === "string" ||
      value.subagent_policy === null ||
      value.subagent_policy === undefined) &&
    typeof value.tool_autonomy === "string" &&
    (typeof value.vision_fallback_model === "string" || value.vision_fallback_model === null) &&
    typeof value.orchestration_enabled === "number" &&
    typeof value.orchestration_intensity === "string" &&
    typeof value.orchestration_visibility === "string" &&
    typeof value.orchestration_provider_preference === "string" &&
    typeof value.orchestration_review_depth === "string" &&
    typeof value.orchestration_parallelism === "string" &&
    typeof value.code_auto_apply === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAggregateRevision(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}
