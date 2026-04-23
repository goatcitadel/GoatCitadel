import type {
  RuntimeLifecycleResponse,
  RuntimeLifecycleExportBundle,
  RuntimeLifecycleExportQuery,
  RuntimeLifecycleQuery,
  SessionTimelineItem,
  TranscriptEvent,
} from "@goatcitadel/contracts";

export interface RuntimeLifecycleExportHost {
  getRuntimeLifecycle(input: RuntimeLifecycleQuery): Promise<RuntimeLifecycleResponse>;
  getTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  listSessionTimeline(sessionId: string, limit: number): Promise<SessionTimelineItem[]>;
}

function toRuntimeLifecycleQuery(input: RuntimeLifecycleExportQuery): RuntimeLifecycleQuery {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
    approvalId: input.approvalId,
    taskId: input.taskId,
  };
}

export class RuntimeLifecycleExportService {
  public constructor(private readonly host: RuntimeLifecycleExportHost) {}

  public async exportBundle(input: RuntimeLifecycleExportQuery): Promise<RuntimeLifecycleExportBundle> {
    const includeTranscript = input.includeTranscript ?? false;
    const includeTimeline = input.includeTimeline ?? false;
    const timelineLimit = Math.max(1, Math.min(input.timelineLimit ?? 200, 1000));
    const lifecycle = await this.host.getRuntimeLifecycle(toRuntimeLifecycleQuery(input));
    const sessionId = lifecycle.canonical.sessionId ?? lifecycle.session?.sessionId;

    const transcript = includeTranscript && sessionId ? await this.host.getTranscript(sessionId) : undefined;
    const timeline =
      includeTimeline && sessionId ? await this.host.listSessionTimeline(sessionId, timelineLimit) : undefined;

    return {
      ...lifecycle,
      export: {
        version: "runtime.lifecycle.export.v1",
        exportedAt: new Date().toISOString(),
        includeTranscript,
        includeTimeline,
        timelineLimit,
      },
      transcript,
      timeline,
      stats: {
        linkedSessionCount: lifecycle.linked.sessionIds.length,
        linkedTurnCount: lifecycle.linked.turnIds.length,
        linkedRunCount: lifecycle.linked.runIds.length,
        linkedApprovalCount: lifecycle.linked.approvalIds.length,
        linkedTaskCount: lifecycle.linked.taskIds.length,
        turnCount: lifecycle.turns.length,
        toolRunCount: lifecycle.toolRuns.length,
        executionPlanCount: lifecycle.executionPlans?.length ?? 0,
        delegationRunCount: lifecycle.delegationRuns?.length ?? 0,
        delegationStepCount: lifecycle.delegationSteps?.length ?? 0,
        proactiveRunCount: lifecycle.proactiveRuns?.length ?? 0,
        approvalEffectCount: lifecycle.approvalEffects?.length ?? 0,
        transcriptEventCount: transcript?.length ?? 0,
        timelineEventCount: timeline?.length ?? 0,
      },
    };
  }
}
