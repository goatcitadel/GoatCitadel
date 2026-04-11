import type {
  ChatTurnTraceRecord,
  DurableRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemoryQmdStatsResponse,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { MemoryContextService } from "./memory-context-service.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";

export interface MemoryLifecycleDependencies {
  readonly context: MemoryContextService;
  readonly learned: ChatLearnedMemoryService;
  readonly maintenance: MemoryMaintenanceService;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
}

/**
 * Canonical coordinator for memory lifecycle policy and operator-facing entry
 * points. Lower-level services remain focused collaborators for context
 * composition, learned-memory persistence, and maintenance execution.
 */
export class MemoryLifecycleService {
  public constructor(private readonly deps: MemoryLifecycleDependencies) {}

  public composeContext(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    return this.deps.context.compose(input);
  }

  public getContext(contextId: string): MemoryContextPack {
    return this.deps.context.get(contextId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.deps.context.listByRun(runId);
  }

  public listRecentContexts(limit = 60): MemoryContextPack[] {
    return this.deps.context.listRecent(limit);
  }

  public getContextStats(from: string, to: string): MemoryQmdStatsResponse {
    return this.deps.context.stats(from, to);
  }

  public extractLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void {
    this.deps.learned.extractAndPersistLearnedMemory(sessionId, content, source);
  }

  public listSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): {
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  } {
    return this.deps.learned.listChatSessionLearnedMemory(sessionId, limit);
  }

  public updateSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): LearnedMemoryItemRecord {
    return this.deps.learned.updateChatSessionLearnedMemory(sessionId, itemId, input);
  }

  public rebuildSessionLearnedMemory(
    sessionId: string,
  ): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    return this.deps.learned.rebuildChatSessionLearnedMemory(sessionId, (sid) => this.deps.readTranscriptOrEmpty(sid));
  }

  public getMaintenancePolicy(workspaceId?: string): MemoryMaintenancePolicyRecord {
    return this.deps.maintenance.getPolicy(workspaceId);
  }

  public patchMaintenancePolicy(
    workspaceId: string | undefined,
    patch: MemoryMaintenancePolicyPatchInput,
  ): MemoryMaintenancePolicyRecord {
    return this.deps.maintenance.patchPolicy(workspaceId, patch);
  }

  public getMaintenanceStatus(workspaceId?: string): MemoryMaintenanceStatusRecord {
    return this.deps.maintenance.getStatus(workspaceId);
  }

  public listMaintenanceRuns(workspaceId?: string, limit = 50): MemoryMaintenanceRunRecord[] {
    return this.deps.maintenance.listRuns(workspaceId, limit);
  }

  public runMaintenanceNow(input: MemoryMaintenanceRunNowInput): MemoryMaintenanceRunRecord {
    return this.deps.maintenance.runNow(input);
  }

  public getMaintenanceRunProvenance(runId: string): MemoryMaintenanceProvenanceRecord {
    return this.deps.maintenance.getRunProvenance(runId);
  }

  public listMaintenanceRecommendations(workspaceId?: string, limit = 50): MemoryMaintenanceRecommendationRecord[] {
    return this.deps.maintenance.listRecommendations(workspaceId, limit);
  }

  public acceptMaintenanceRecommendation(recommendationId: string): {
    recommendation: MemoryMaintenanceRecommendationRecord;
    policy: MemoryMaintenancePolicyRecord;
  } {
    return this.deps.maintenance.acceptRecommendation(recommendationId);
  }

  public rejectMaintenanceRecommendation(recommendationId: string): MemoryMaintenanceRecommendationRecord {
    return this.deps.maintenance.rejectRecommendation(recommendationId);
  }

  public runDueEvaluation(): Promise<void> {
    return this.deps.maintenance.runDueEvaluation();
  }

  public noteSuccessfulRootTurn(sessionId: string): Promise<void> {
    return this.deps.maintenance.noteSuccessfulRootTurn(sessionId);
  }

  public parseMaintenanceWorkflowPayload(run: DurableRunRecord): { workspaceId: string } | undefined {
    const payload = this.deps.maintenance.parseWorkflowPayload(run);
    if (!payload?.workspaceId) {
      return undefined;
    }
    return {
      workspaceId: payload.workspaceId,
    };
  }

  public syncMaintenanceFromDurableRun(run: DurableRunRecord): void {
    this.deps.maintenance.syncFromDurableRun(run);
  }

  public executeMaintenanceDurableRun(run: DurableRunRecord): Promise<Record<string, unknown>> {
    return this.deps.maintenance.executeDurableRun(run);
  }
}
