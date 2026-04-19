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
    app.decorate("gateway", {
      getRuntimeLifecycle,
      listSessions: vi.fn(() => []),
      getSession: vi.fn(),
      getTranscript: vi.fn(),
      getSessionSummary: vi.fn(),
      listSessionTimeline: vi.fn(),
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
    app.decorate("gateway", {
      getRuntimeLifecycle: vi.fn(),
      listSessions: vi.fn(() => []),
      getSession: vi.fn(),
      getTranscript: vi.fn(),
      getSessionSummary: vi.fn(),
      listSessionTimeline: vi.fn(),
    } as never);
    await app.register(sessionsListRoute);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/lifecycle",
    });

    expect(response.statusCode).toBe(400);
  });
});
