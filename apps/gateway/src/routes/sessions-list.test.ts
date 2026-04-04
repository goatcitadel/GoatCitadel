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
    expect(response.json().linked.runIds).toEqual(["run-1"]);
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
