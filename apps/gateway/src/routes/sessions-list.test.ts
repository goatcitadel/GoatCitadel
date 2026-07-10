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

  it("projects legacy session operational responses while preserving raw user-authored transcript payloads", async () => {
    const session = {
      sessionId: "session-secret",
      sessionKey: "mission:operator:secret",
      kind: "dm",
      channel: "mission",
      account: "operator",
      displayName: "Authorization: Bearer display-secret",
      routingHints: {
        authorization: "Bearer routing-secret",
        tokenEnv: "SESSION_ROUTE_TOKEN",
        secretRef: "keychain:session-route-token",
      },
      lastActivityAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
      health: "healthy",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      costUsdTotal: 0.02,
      budgetState: "ok",
    };
    const userEvent = {
      eventId: "event-user",
      actionId: "action-user",
      idempotencyKey: "idem-user",
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      timestamp: "2026-07-09T12:00:01.000Z",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: {
        message: { role: "user", content: "User intentionally supplied Bearer user-message-secret" },
      },
      tokenInput: 11,
    };
    const assistantEvent = {
      ...userEvent,
      eventId: "event-assistant",
      actionId: "action-assistant",
      idempotencyKey: "idem-assistant",
      type: "message.assistant",
      actorType: "agent",
      actorId: "assistant",
      payload: {
        message: { role: "assistant", content: "Assistant repeated Bearer assistant-message-secret" },
        errorMetadata: {
          authorization: "Bearer assistant-error-secret",
          webhookUrl: "https://hooks.example.test/services/team/assistant-path-secret?token=assistant-query-secret",
        },
      },
    };
    const toolEvent = {
      ...assistantEvent,
      eventId: "event-tool",
      type: "tool.result",
      payload: {
        result: {
          DATABASE_PASSWORD: "tool-password-secret",
          tokenEnv: "TOOL_TOKEN",
          secretRef: "keychain:tool-token",
        },
      },
    };
    const approvalEvent = {
      ...assistantEvent,
      eventId: "event-approval",
      type: "approval.required",
      payload: { preview: { authorization: "Bearer approval-secret" } },
    };
    const orchestrationEvent = {
      ...assistantEvent,
      eventId: "event-orchestration",
      type: "orchestration.phase",
      payload: { error: { webhookUrl: "https://example.test/hook?token=orchestration-secret" } },
    };
    const transcript = [userEvent, assistantEvent, toolEvent, approvalEvent, orchestrationEvent];
    const summary = {
      session,
      transcriptEventCount: transcript.length,
      latestEventType: "orchestration.phase",
      lastMessagePreview: "Assistant repeated Bearer summary-secret",
      countsByType: { "message.user": 1, "message.assistant": 1 },
      errorMetadata: { authorization: "Bearer summary-error-secret" },
    };
    const timeline = [
      {
        eventId: userEvent.eventId,
        timestamp: userEvent.timestamp,
        type: userEvent.type,
        actorType: userEvent.actorType,
        actorId: userEvent.actorId,
        preview: "User preview Authorization: Bearer user-preview-secret",
        payload: userEvent.payload,
        tokenInput: 11,
      },
      {
        eventId: assistantEvent.eventId,
        timestamp: assistantEvent.timestamp,
        type: assistantEvent.type,
        actorType: assistantEvent.actorType,
        actorId: assistantEvent.actorId,
        preview: "Assistant preview Bearer timeline-preview-secret",
        payload: assistantEvent.payload,
        tokenOutput: 7,
      },
    ];
    const sessionsList = {
      listSessions: vi.fn(() => [session]),
      getSession: vi.fn(() => session),
      getTranscript: vi.fn(async () => transcript),
      getSessionSummary: vi.fn(async () => summary),
      listSessionTimeline: vi.fn(async () => timeline),
    };
    app = Fastify();
    app.decorate("services", {
      sessionsList,
      runtimeLifecycle: { getLifecycle: vi.fn(), exportLifecycle: vi.fn(), exportLifecycleSiemNdjson: vi.fn() },
    } as never);
    await app.register(sessionsListRoute);

    const listed = await app.inject({ method: "GET", url: "/api/v1/sessions?limit=1" });
    const detail = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.sessionId}` });
    const transcriptResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.sessionId}/transcript`,
    });
    const summaryResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.sessionId}/summary`,
    });
    const timelineResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.sessionId}/timeline?limit=2`,
    });

    for (const response of [listed, detail, transcriptResponse, summaryResponse, timelineResponse]) {
      expect(response.statusCode).toBe(200);
    }
    const listedJson = listed.json();
    const detailJson = detail.json();
    for (const payload of [listedJson, detailJson]) {
      expect(JSON.stringify(payload)).not.toContain("display-secret");
      expect(JSON.stringify(payload)).not.toContain("routing-secret");
      expect(payload.items?.[0]?.tokenInput ?? payload.tokenInput).toBe(11);
      expect(payload.items?.[0]?.routingHints?.tokenEnv ?? payload.routingHints?.tokenEnv).toBe("SESSION_ROUTE_TOKEN");
    }
    const transcriptJson = transcriptResponse.json();
    expect(JSON.stringify(transcriptJson)).toContain("user-message-secret");
    for (const secret of [
      "assistant-message-secret",
      "assistant-error-secret",
      "assistant-path-secret",
      "assistant-query-secret",
      "tool-password-secret",
      "approval-secret",
      "orchestration-secret",
    ]) {
      expect(JSON.stringify(transcriptJson)).not.toContain(secret);
    }
    expect(transcriptJson.items[0].tokenInput).toBe(11);
    expect(transcriptJson.items[2].payload.result.tokenEnv).toBe("TOOL_TOKEN");
    expect(transcriptJson.items[2].payload.result.secretRef).toBe("keychain:tool-token");
    expect(JSON.stringify(summaryResponse.json())).not.toContain("summary-secret");
    expect(JSON.stringify(summaryResponse.json())).not.toContain("summary-error-secret");
    const timelineJson = timelineResponse.json();
    expect(JSON.stringify(timelineJson)).toContain("user-message-secret");
    expect(JSON.stringify(timelineJson)).not.toContain("user-preview-secret");
    expect(JSON.stringify(timelineJson)).not.toContain("timeline-preview-secret");
    expect(JSON.stringify(timelineJson)).not.toContain("assistant-message-secret");
    expect(timelineJson.items[0].tokenInput).toBe(11);
    expect(timelineJson.items[1].tokenOutput).toBe(7);
    expect(session.displayName).toContain("display-secret");
    expect(session.routingHints.authorization).toContain("routing-secret");
    expect(userEvent.payload.message.content).toContain("user-message-secret");
    expect(assistantEvent.payload.message.content).toContain("assistant-message-secret");
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
    const exportLifecycleSiemNdjson = vi.fn(async () =>
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
    expect(response.body).toContain('"eventType":"runtime.export"');
  });
});
