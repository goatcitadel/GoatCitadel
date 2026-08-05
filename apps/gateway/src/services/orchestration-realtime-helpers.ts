import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { DurableWorkflowExecutionContext } from "./durable-execution-service.js";

interface OrchestrationRealtimePublisher {
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
}

function buildOrchestrationRealtimeLinks(input: {
  runId: string;
  workspaceId?: string;
}): NonNullable<RealtimeEvent["links"]> {
  return {
    runId: input.runId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

export async function publishOrchestrationRealtime(
  host: OrchestrationRealtimePublisher,
  payload: {
    runId: string;
    planId?: string;
    durableRunId?: string;
    workspaceId?: string;
    event: string;
    status: string;
    executionState?: string;
    worktreeStatus?: string;
    worktreePath?: string;
    waveId?: string;
    phaseId?: string;
    approvedBy?: string;
    nextWaveId?: string;
    nextPhaseId?: string;
    error?: string;
  },
): Promise<void> {
  await host.publishRealtime("orchestration_event", "orchestration", payload, {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: buildOrchestrationRealtimeLinks({
      runId: payload.runId,
      workspaceId: payload.workspaceId,
    }),
  });
}

export function throwIfWorkflowAborted(context?: DurableWorkflowExecutionContext): void {
  if (!context?.signal?.aborted) {
    return;
  }
  throw context.signal.reason instanceof Error
    ? context.signal.reason
    : new Error("Durable orchestration workflow aborted.");
}
