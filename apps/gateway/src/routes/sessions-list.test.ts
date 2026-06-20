import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sessionsListRoute } from "./sessions-list.js";

describe("sessions routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns a runtime lifecycle projection for linked entities", async () => {
    const getRuntimeLifecycle = vi.fn(async () => ({
      query: {
        approvalId: "approval-1",
        sessionId: "session-1",
        runId: "run-1",
        taskId: "task-1",
      },
      linked: {
        sessionIds: ["session-1"],
        turnIds: ["turn-1"],
        runIds: ["run-1"],
        proactiveRunIds: ["proactive-1"],
        approvalIds: ["approval-1"],
        taskIds: ["task-1"],
        workspaceIds: ["workspace-1"],
      },
      approval: {
        approvalId: "approval-1",
        kind: "tool.invoke",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-04-02T00:00:00.000Z",
        explanationStatus: "not_requested",
      },
      turns: [],
      toolRuns: [],
      resolution: {
        sessionIdSource: "approval_linkage",
        runIdSource: "execution_plan",
        fallbackSources: ["fallback_payload", "fallback_preview"],
      },
      executionPlans: [
        {
          planId: "plan-1",
          sessionId: "session-1",
          turnId: "turn-1",
          mode: "cowork",
          planningMode: "advisory",
          status: "running",
          source: "planner",
          advisoryOnly: false,
          objective: "Ship the fix",
          summary: "Delegated plan in progress.",
          startedAt: "2026-04-02T00:00:10.000Z",
          steps: [
            {
              stepId: "plan-step-1",
              index: 0,
              objective: "Design",
              status: "completed",
              delegatedRole: "Architect",
              childRunId: "legacy-run-1",
              durableRunId: "durable-child-1",
              childSessionId: "child-session-1",
              childTurnId: "child-turn-1",
            },
          ],
        },
      ],
      delegationRuns: [
        {
          runId: "delegate-1",
          sessionId: "session-1",
          taskId: "task-1",
          objective: "Ship the fix",
          roles: ["Architect", "Coder"],
          mode: "parallel",
          status: "partial",
          executionPlanId: "plan-1",
          startedAt: "2026-04-02T00:00:11.000Z",
        },
      ],
      delegationSteps: [
        {
          stepId: "delegate-step-1",
          runId: "delegate-1",
          role: "Architect",
          status: "completed",
          index: 0,
          childSessionId: "child-session-1",
          childTurnId: "child-turn-1",
          durableRunId: "durable-child-1",
        },
        {
          stepId: "delegate-step-2",
          runId: "delegate-1",
          role: "Coder",
          status: "skipped",
          index: 1,
          error: "Skipped because dependency failed.",
        },
      ],
    }));

    app = Fastify();
    app.decorate("services", {
      sessionsList: {
        listSessions: vi.fn(() => []),
        getSession: vi.fn(),
        getTranscript: vi.fn(),
        getSessionSummary: vi.fn(),
        listSessionTimeline: vi.fn(),
      },
      runtimeLifecycle: {
        getLifecycle: getRuntimeLifecycle,
        exportLifecycle: vi.fn(),
        exportLifecycleSiemNdjson: vi.fn(),
      },
    } as never);
    await app.register(sessionsListRoute);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/lifecycle?approvalId=approval-1",
    });

    expect(response.statusCode).toBe(200);
    expect(getRuntimeLifecycle).toHaveBeenCalledWith({
      approvalId: "approval-1",
    });
    expect(response.json()).toMatchObject({
      linked: {
        runIds: ["run-1"],
      },
      resolution: {
        runIdSource: "execution_plan",
        fallbackSources: ["fallback_payload", "fallback_preview"],
      },
      executionPlans: [
        {
          planId: "plan-1",
          steps: [
            {
              stepId: "plan-step-1",
              durableRunId: "durable-child-1",
              childSessionId: "child-session-1",
              childTurnId: "child-turn-1",
              childRunId: "legacy-run-1",
            },
          ],
        },
      ],
      delegationRuns: [
        {
          runId: "delegate-1",
          executionPlanId: "plan-1",
        },
      ],
      delegationSteps: [
        {
          stepId: "delegate-step-1",
          durableRunId: "durable-child-1",
        },
        {
          stepId: "delegate-step-2",
          status: "skipped",
        },
      ],
    });
  });

  it("rejects runtime lifecycle requests without an identifier", async () => {
    app = Fastify();
    app.decorate("services", {
      sessionsList: {
        listSessions: vi.fn(() => []),
        getSession: vi.fn(),
        getTranscript: vi.fn(),
        getSessionSummary: vi.fn(),
        listSessionTimeline: vi.fn(),
      },
      runtimeLifecycle: {
        getLifecycle: vi.fn(),
        exportLifecycle: vi.fn(),
        exportLifecycleSiemNdjson: vi.fn(),
      },
    } as never);
    await app.register(sessionsListRoute);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/lifecycle",
    });

    expect(response.statusCode).toBe(400);
  });

  it("exports a runtime lifecycle bundle with transcript and timeline toggles", async () => {
    const exportLifecycle = vi.fn(async () => ({
      export: {
        version: "runtime.lifecycle.export.v1",
        exportedAt: "2026-04-22T00:00:00.000Z",
        includeTranscript: true,
        includeTimeline: true,
        timelineLimit: 80,
      },
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
        approvalIds: [],
        taskIds: [],
        workspaceIds: ["workspace-1"],
      },
      turns: [],
      toolRuns: [],
      transcript: [
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
      ],
      timeline: [
        {
          eventId: "evt-1",
          timestamp: "2026-04-22T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          preview: "hello",
          payload: {},
        },
      ],
      stats: {
        linkedSessionCount: 1,
        linkedTurnCount: 1,
        linkedRunCount: 1,
        linkedApprovalCount: 0,
        linkedTaskCount: 0,
        turnCount: 0,
        toolRunCount: 0,
        executionPlanCount: 0,
        delegationRunCount: 0,
        delegationStepCount: 0,
        proactiveRunCount: 0,
        approvalEffectCount: 0,
        transcriptEventCount: 1,
        timelineEventCount: 1,
      },
    }));

    app = Fastify();
    app.decorate("services", {
      sessionsList: {
        listSessions: vi.fn(() => []),
        getSession: vi.fn(),
        getTranscript: vi.fn(),
        getSessionSummary: vi.fn(),
        listSessionTimeline: vi.fn(),
      },
      runtimeLifecycle: {
        getLifecycle: vi.fn(),
        exportLifecycle,
        exportLifecycleSiemNdjson: vi.fn(),
      },
    } as never);
    await app.register(sessionsListRoute);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/lifecycle/export?sessionId=session-1&turnId=turn-1&includeTranscript=true&includeTimeline=true&timelineLimit=80",
    });

    expect(response.statusCode).toBe(200);
    expect(exportLifecycle).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      includeTranscript: true,
      includeTimeline: true,
      timelineLimit: 80,
    });
    expect(response.json()).toMatchObject({
      export: {
        version: "runtime.lifecycle.export.v1",
        includeTranscript: true,
        includeTimeline: true,
        timelineLimit: 80,
      },
      stats: {
        transcriptEventCount: 1,
        timelineEventCount: 1,
      },
    });
  });

  it("exports SIEM-ready runtime lifecycle NDJSON", async () => {
    const exportLifecycleSiemNdjson = vi.fn(
      async () =>
        [
          JSON.stringify({
            schemaVersion: "goatcitadel.siem.runtime.v1",
            eventType: "runtime.export",
            timestamp: "2026-04-22T00:00:00.000Z",
            payload: { ok: true },
          }),
          "",
        ].join("\n"),
    );

    app = Fastify();
    app.decorate("services", {
      sessionsList: {
        listSessions: vi.fn(() => []),
        getSession: vi.fn(),
        getTranscript: vi.fn(),
        getSessionSummary: vi.fn(),
        listSessionTimeline: vi.fn(),
      },
      runtimeLifecycle: {
        getLifecycle: vi.fn(),
        exportLifecycle: vi.fn(),
        exportLifecycleSiemNdjson,
      },
    } as never);
    await app.register(sessionsListRoute);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/lifecycle/export?sessionId=session-1&format=siem_ndjson",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(exportLifecycleSiemNdjson).toHaveBeenCalledWith({
      sessionId: "session-1",
      format: "siem_ndjson",
    });
    expect(response.body).toContain("\"eventType\":\"runtime.export\"");
  });
});
