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
      decisionTrace: [{ decisionId: "decision-1" }],
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
          payload: {
            webhookUrl: "https://hooks.example.test/events?token=transcript-short",
            tokenEnv: "TRANSCRIPT_TOKEN",
          },
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
          payload: {
            authorization: "Bearer timeline-short",
            tokenBudget: 512,
          },
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
      format: "bundle",
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
      decisionTraceCount: 1,
      transcriptEventCount: 1,
      timelineEventCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("transcript-short");
    expect(JSON.stringify(result)).not.toContain("timeline-short");
    expect(result).toMatchObject({
      transcript: [{ payload: { tokenEnv: "TRANSCRIPT_TOKEN" } }],
      timeline: [{ payload: { tokenBudget: 512 } }],
    });
  });

  it("fetches transcript and timeline concurrently when both are included", async () => {
    const calls: string[] = [];
    let transcriptStarted = (): void => undefined;
    let releaseTranscript = (): void => undefined;
    const transcriptStartedPromise = new Promise<void>((resolve) => {
      transcriptStarted = resolve;
    });
    const transcriptReleasePromise = new Promise<void>((resolve) => {
      releaseTranscript = resolve;
    });
    const service = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: vi.fn(async () => ({
        query: {
          sessionId: "session-1",
        },
        canonical: {
          sessionId: "session-1",
        },
        linked: {
          sessionIds: ["session-1"],
          turnIds: [],
          runIds: [],
          proactiveRunIds: [],
          approvalIds: [],
          taskIds: [],
          workspaceIds: [],
        },
        turns: [],
        toolRuns: [],
        executionPlans: [],
        delegationRuns: [],
        delegationSteps: [],
        proactiveRuns: [],
        approvalEffects: [],
        decisionTrace: [],
      })),
      getTranscript: vi.fn(async () => {
        calls.push("transcript:start");
        transcriptStarted();
        await transcriptReleasePromise;
        calls.push("transcript:end");
        return [];
      }),
      listSessionTimeline: vi.fn(async () => {
        calls.push("timeline:start");
        calls.push("timeline:end");
        return [];
      }),
    });

    const bundlePromise = service.exportBundle({
      sessionId: "session-1",
      includeTranscript: true,
      includeTimeline: true,
    });
    await transcriptStartedPromise;
    await Promise.resolve();
    const timelineStartedBeforeTranscriptRelease = calls.includes("timeline:start");
    releaseTranscript();
    await bundlePromise;

    expect(timelineStartedBeforeTranscriptRelease).toBe(true);
    expect(calls.indexOf("timeline:start")).toBeLessThan(calls.indexOf("transcript:end"));
  });

  it("exports SIEM-ready NDJSON with redacted secret-like fields", async () => {
    const service = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: vi.fn(async () => ({
        query: {
          sessionId: "session-1",
        },
        canonical: {
          sessionId: "session-1",
          turnId: "turn-1",
        },
        linked: {
          sessionIds: ["session-1"],
          turnIds: ["turn-1"],
          runIds: [],
          proactiveRunIds: [],
          approvalIds: [],
          taskIds: [],
          workspaceIds: [],
        },
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            status: "completed",
            mode: "chat",
            startedAt: "2026-04-22T00:00:00.000Z",
          },
        ],
        toolRuns: [
          {
            toolRunId: "tool-1",
            turnId: "turn-1",
            sessionId: "session-1",
            toolName: "connector.send",
            status: "executed",
            startedAt: "2026-04-22T00:00:01.000Z",
          },
        ],
        executionPlans: [],
        delegationRuns: [],
        delegationSteps: [],
        proactiveRuns: [],
        approvalEffects: [],
        decisionTrace: [],
      })),
      getTranscript: vi.fn(async () => [
        {
          eventId: "evt-secret",
          actionId: "action-secret",
          idempotencyKey: "idem-secret",
          sessionId: "session-1",
          sessionKey: "key-1",
          timestamp: "2026-04-22T00:00:02.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: {
            accessToken: "should-not-escape",
            nested: { password: "also-secret", visible: "ok" },
          },
        },
      ]),
      listSessionTimeline: vi.fn(async () => []),
    });

    const ndjson = await service.exportSiemNdjson({ sessionId: "session-1" });
    const lines = ndjson
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toMatchObject({
      schemaVersion: "goatcitadel.siem.runtime.v1",
      eventType: "runtime.export",
      source: { sessionId: "session-1", turnId: "turn-1" },
    });
    expect(lines.map((line) => line.eventType)).toEqual(
      expect.arrayContaining(["runtime.turn", "runtime.tool_run", "runtime.transcript"]),
    );
    expect(ndjson).not.toContain("should-not-escape");
    expect(ndjson).not.toContain("also-secret");
    expect(ndjson).toContain('"accessToken":"[redacted]"');
    expect(ndjson).toContain('"visible":"ok"');
  });

  it("attaches a shareable trust report when requested", async () => {
    const service = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: vi.fn(async () => ({
        query: {
          sessionId: "session-1",
        },
        canonical: {
          sessionId: "session-1",
          turnId: "turn-1",
        },
        session: {
          sessionId: "session-1",
          displayName: "Demo Cowork Run",
        },
        linked: {
          sessionIds: ["session-1"],
          turnIds: ["turn-1"],
          runIds: [],
          proactiveRunIds: [],
          approvalIds: [],
          taskIds: [],
          workspaceIds: [],
        },
        turns: [
          {
            turnId: "turn-1",
            model: "gpt-5.2",
            routing: {
              primaryProviderId: "openai",
              primaryModel: "gpt-5.2",
              effectiveProviderId: "openai",
              effectiveModel: "gpt-5.2",
              fallbackUsed: false,
            },
          },
        ],
        toolRuns: [
          {
            toolRunId: "tool-1",
            toolName: "filesystem.read",
            status: "completed",
          },
        ],
        executionPlans: [],
        delegationRuns: [],
        delegationSteps: [],
        proactiveRuns: [],
        approvalEffects: [],
        decisionTrace: [],
      })),
      getTranscript: vi.fn(async () => []),
      listSessionTimeline: vi.fn(async () => []),
    });

    const result = await service.exportBundle({
      sessionId: "session-1",
      includeTranscript: true,
      includeTimeline: true,
      format: "trust_report",
    });

    expect(result.export.format).toBe("trust_report");
    expect(result.trustReport).toMatchObject({
      version: "runtime.trust_report.v1",
      title: "Demo Cowork Run",
      modelProvider: {
        requestedProviderId: "openai",
        requestedModel: "gpt-5.2",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.2",
        fallbackUsed: false,
      },
      activity: {
        turnCount: 1,
        toolRunCount: 1,
      },
    });
    expect(result.trustReport?.shareableMarkdown).toContain("# Demo Cowork Run Trust Report");
  });
});
