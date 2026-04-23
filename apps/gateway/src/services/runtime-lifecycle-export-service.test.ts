import { describe, expect, it, vi } from "vitest";
import { RuntimeLifecycleExportService } from "./runtime-lifecycle-export-service.js";

describe("RuntimeLifecycleExportService", () => {
  it("builds a read-only lifecycle bundle with optional transcript and timeline", async () => {
    const getRuntimeLifecycle = vi.fn(async () => ({
      query: {
        sessionId: "session-1",
        turnId: "turn-1",
      },
      canonical: {
        sessionId: "session-1",
        turnId: "turn-1",
      },
      linked: {
        sessionIds: ["session-1"],
        turnIds: ["turn-1"],
        runIds: ["run-1"],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: ["task-1"],
        workspaceIds: ["workspace-1"],
      },
      turns: [{ turnId: "turn-1" }],
      toolRuns: [{ toolRunId: "tool-1" }],
      executionPlans: [{ planId: "plan-1" }],
      delegationRuns: [{ runId: "delegate-1" }],
      delegationSteps: [{ stepId: "step-1" }],
      proactiveRuns: [{ runId: "proactive-1" }],
      approvalEffects: [{ effectId: "effect-1" }],
    }));
    const service = new RuntimeLifecycleExportService({
      getRuntimeLifecycle,
      getTranscript: vi.fn(async () => [
        {
          eventId: "evt-1",
          actionId: "action-1",
          idempotencyKey: "idem-1",
          sessionId: "session-1",
          sessionKey: "key-1",
          timestamp: "2026-04-22T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: {},
        },
      ]),
      listSessionTimeline: vi.fn(async () => [
        {
          eventId: "evt-1",
          timestamp: "2026-04-22T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          preview: "hello",
          payload: {},
        },
      ]),
    });

    const result = await service.exportBundle({
      sessionId: "session-1",
      turnId: "turn-1",
      includeTranscript: true,
      includeTimeline: true,
      timelineLimit: 80,
    });

    expect(getRuntimeLifecycle).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      runId: undefined,
      approvalId: undefined,
      taskId: undefined,
    });
    expect(result.export).toMatchObject({
      version: "runtime.lifecycle.export.v1",
      includeTranscript: true,
      includeTimeline: true,
      timelineLimit: 80,
    });
    expect(result.stats).toMatchObject({
      linkedSessionCount: 1,
      linkedTurnCount: 1,
      linkedRunCount: 1,
      linkedApprovalCount: 1,
      linkedTaskCount: 1,
      turnCount: 1,
      toolRunCount: 1,
      executionPlanCount: 1,
      delegationRunCount: 1,
      delegationStepCount: 1,
      proactiveRunCount: 1,
      approvalEffectCount: 1,
      transcriptEventCount: 1,
      timelineEventCount: 1,
    });
  });
});
