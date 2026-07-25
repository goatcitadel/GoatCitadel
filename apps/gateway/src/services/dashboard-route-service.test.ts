import { describe, expect, it, vi } from "vitest";
import type { OpsDesignQualitySnapshot } from "@goatcitadel/contracts";
import {
  createDashboardRoutePort,
  createDashboardRouteService,
  dashboardRouteMethods,
} from "./dashboard-route-service.js";

describe("dashboard route service", () => {
  it("forwards route methods through the dashboard route service facade", async () => {
    const deps = createDeps();
    const port = createDashboardRoutePort(deps as never);
    const service = createDashboardRouteService(port);

    expect(service).toEqual(
      expect.objectContaining(
        Object.fromEntries(dashboardRouteMethods.map((method) => [method, expect.any(Function)])),
      ),
    );

    expect(await service.costSummary("month", "from", "to")).toEqual([{ costUsd: 1.25 }]);
    expect(await service.costUsageAvailability("from", "to")).toEqual({ available: true });
    expect(await service.getMemoryQmdStats("from", "to")).toEqual({ totalRuns: 2 });
    expect(await service.isFeatureEnabled("connectorDiagnosticsV1Enabled")).toBe(true);
    expect(await service.listBackups(3)).toEqual([{ backupId: "backup-1" }]);
    expect(await service.listMemoryFiles("notes")).toEqual([{ relativePath: "notes/a.md" }]);
    expect(await service.listRealtimeEvents(2, "cursor-1")).toEqual([{ eventId: "event-1" }]);
    expect(await service.listSessions(5, "session-cursor")).toEqual([{ sessionId: "session-1" }]);
    expect(await service.listOperators()).toEqual([{ operatorId: "operator-1" }]);
    expect(await service.getOpsQualitySnapshot({ packLimit: 10, evalLimit: 3 })).toMatchObject({
      version: "ops.quality_snapshot.v1",
      metricScope: {
        scope: "bounded_read",
        promptPackLimit: 10,
        evalRunLimit: 3,
      },
      metrics: {
        promptPackCount: 1,
        promptPackTestCount: 2,
        redTeamPackCount: 1,
        redTeamTestCount: 4,
        evalRunCount: 1,
        paretoModelCount: 1,
        securityGateCount: 1,
        passingSecurityGateCount: 1,
        securityExecutionReadyCount: 1,
        securityExecutionBlockedCount: 0,
        designQualityCheckCount: 2,
        designQualityBlockingCount: 0,
      },
      posture: { readOnly: true, sideEffectPosture: "audit_only" },
      promptPacks: { state: "available" },
      evalProof: { state: "available" },
      securityEvalPacks: { state: "available", warnings: ["Security packs are stored evidence."] },
      securityQualityGates: { state: "available", warnings: ["Security gates are read-only."] },
      securityExecution: {
        state: "available",
        items: [
          {
            packKey: "security",
            state: "passing",
            testCount: 4,
            completedRuns: 4,
            runCoverage: 1,
            scoredCoverage: 1,
            posture: { readOnly: true, sideEffectPosture: "audit_only", callsProviders: false },
          },
        ],
      },
      designQuality: {
        state: "available",
        summary: {
          totalChecks: 2,
          passingCount: 2,
          advisoryCount: 0,
          blockingCount: 0,
        },
      },
    });
    expect(await service.getOpsQualityExport({ packLimit: 10, evalLimit: 3, format: "otel_json" })).toMatchObject({
      version: "ops.quality_export.otel_json.v1",
      format: "otel_json",
      contentType: "application/json",
      sourceEndpoint: "/api/v1/ops/quality",
      posture: { readOnly: true, sideEffectPosture: "audit_only" },
      resource: { serviceName: "goatcitadel", source: "ops_quality" },
      spans: expect.arrayContaining([
        expect.objectContaining({ name: "ops.quality.snapshot" }),
        expect.objectContaining({ name: "ops.quality.prompt_pack" }),
        expect.objectContaining({ name: "ops.quality.eval_proof" }),
        expect.objectContaining({ name: "ops.quality.security_gate" }),
        expect.objectContaining({ name: "ops.quality.design_check" }),
      ]),
    });

    expect(deps.storage.costLedger.summary).toHaveBeenCalledWith("month", "from", "to");
    expect(deps.storage.costLedger.usageAvailability).toHaveBeenCalledWith("from", "to");
    expect(deps.memoryLifecycleService.getContextStats).toHaveBeenCalledWith("from", "to");
    expect(deps.backupRetentionService.listBackups).toHaveBeenCalledWith(3);
    expect(deps.memoryLifecycleService.listMemoryFiles).toHaveBeenCalledWith("notes");
    expect(deps.realtimeEventService.listRealtimeEvents).toHaveBeenCalledWith(2, "cursor-1");
    expect(deps.storage.sessions.list).toHaveBeenCalledWith(5, "session-cursor");
    expect(deps.storage.sessions.listOperatorSummaries).toHaveBeenCalledWith(expect.any(String));
    expect(deps.promptPackService.listPromptPacks).toHaveBeenCalledWith(10);
    expect(deps.storage.llmEvalProofRuns.list).toHaveBeenCalledWith(3);
    expect(deps.readDesignQualityEvidence).toHaveBeenCalledWith(deps.rootDir);
  });

  it("returns partial Ops quality evidence with explicit unknown state when one source fails", async () => {
    const deps = createDeps();
    deps.promptPackService.listSecurityQualityGates.mockImplementation(() => {
      throw new Error("security gate store unavailable");
    });
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const snapshot = await service.getOpsQualitySnapshot({ packLimit: 10, evalLimit: 3 });

    expect(snapshot.promptPacks).toMatchObject({
      state: "available",
      items: [{ packId: "pack-1", name: "Quality pack", testCount: 2 }],
    });
    expect(snapshot.evalProof).toMatchObject({ state: "available" });
    expect(snapshot.securityEvalPacks).toMatchObject({ state: "available" });
    expect(snapshot.securityQualityGates).toMatchObject({
      state: "unknown",
      items: [],
      warnings: [],
      error: "security gate store unavailable",
    });
    expect(snapshot.securityExecution).toMatchObject({
      state: "unknown",
      items: [
        {
          packKey: "security",
          state: "definition_only",
          runCoverage: 0,
          scoredCoverage: 0,
        },
      ],
      error: "security gate store unavailable",
    });
    expect(snapshot.posture).toMatchObject({ readOnly: true, sideEffectPosture: "audit_only" });
  });

  it("projects blocking and advisory design-quality evidence into the Ops quality snapshot", async () => {
    const deps = createDeps();
    deps.readDesignQualityEvidence.mockReturnValueOnce(
      buildDesignQualitySnapshot({
        checks: [
          {
            id: "design-intelligence.modules",
            label: "Design-intelligence module integrity",
            severity: "P0",
            status: "blocking",
            owner: "skills/bundled/design-intelligence",
            evidence: "skills/bundled/design-intelligence",
            nextAction: "Restore missing module.",
          },
          {
            id: "mission-control.anti-slop.scan",
            label: "Calibrated anti-slop scan",
            severity: "P2",
            status: "advisory",
            owner: "mission-control-next",
            evidence: "apps/mission-control-next/src",
            nextAction: "Review token-backed intent.",
          },
        ],
        warnings: ["Design quality advisories are calibrated signals."],
      }),
    );
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const snapshot = await service.getOpsQualitySnapshot({ packLimit: 10, evalLimit: 3 });

    expect(snapshot.metrics.designQualityCheckCount).toBe(2);
    expect(snapshot.metrics.designQualityBlockingCount).toBe(1);
    expect(snapshot.designQuality).toMatchObject({
      state: "available",
      summary: {
        totalChecks: 2,
        advisoryCount: 1,
        blockingCount: 1,
      },
      checks: [
        { id: "design-intelligence.modules", severity: "P0", status: "blocking" },
        { id: "mission-control.anti-slop.scan", severity: "P2", status: "advisory" },
      ],
    });
    expect(snapshot.warnings).toContain("Design quality advisories are calibrated signals.");
  });

  it("keeps Ops quality available when design-quality evidence cannot be read", async () => {
    const deps = createDeps();
    deps.readDesignQualityEvidence.mockImplementationOnce(() => {
      throw new Error("design quality store unavailable");
    });
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const snapshot = await service.getOpsQualitySnapshot({ packLimit: 10, evalLimit: 3 });

    expect(snapshot.promptPacks.state).toBe("available");
    expect(snapshot.designQuality).toMatchObject({
      state: "unknown",
      error: "design quality store unavailable",
      checks: [{ id: "design-quality.snapshot", status: "unknown" }],
    });
    expect(snapshot.metrics.designQualityCheckCount).toBe(1);
    expect(snapshot.metrics.designQualityBlockingCount).toBe(0);
  });

  it("builds dashboard state and system vitals without changing response shape", async () => {
    const deps = createDeps();
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const state = await service.getDashboardState();
    expect(state).toMatchObject({
      sessions: [{ sessionId: "session-1" }],
      pendingApprovals: 1,
      activeSubagents: 4,
      taskStatusCounts: [{ status: "todo", count: 3 }],
      recentEvents: [{ eventId: "recent-1" }],
      dailyCostUsd: 3,
    });
    expect(state.timestamp).toEqual(expect.any(String));
    expect(deps.storage.sessions.list).toHaveBeenCalledWith(200);
    expect(deps.storage.approvals.list).toHaveBeenCalledWith("pending", 10000);
    expect(deps.storage.costLedger.summary).toHaveBeenCalledWith("day", expect.any(String), expect.any(String));

    const vitals = await service.getSystemVitals();
    expect(vitals).toEqual({
      hostname: expect.any(String),
      platform: expect.any(String),
      release: expect.any(String),
      uptimeSeconds: expect.any(Number),
      loadAverage: expect.any(Array),
      cpuCount: expect.any(Number),
      memoryTotalBytes: expect.any(Number),
      memoryFreeBytes: expect.any(Number),
      memoryUsedBytes: expect.any(Number),
      processRssBytes: expect.any(Number),
      processHeapUsedBytes: expect.any(Number),
    });
  });

  it("projects secret-bearing retained realtime events without mutating dashboard storage truth", async () => {
    const deps = createDeps();
    const rawEvent = {
      eventId: "recent-secret-1",
      eventType: "tool_result",
      source: "runtime",
      payload: {
        authorization: "Bearer dashboard-secret",
        tokenEnv: "DASHBOARD_TOKEN",
        tokenId: "dashboard-token-id",
      },
      createdAt: "2026-05-30T00:00:00.000Z",
    };
    deps.storage.realtimeEvents.list.mockReturnValue([rawEvent]);
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const state = await service.getDashboardState();

    expect(state.recentEvents).toEqual([
      expect.objectContaining({
        eventId: "recent-secret-1",
        payload: {
          authorization: "[REDACTED]",
          tokenEnv: "DASHBOARD_TOKEN",
          tokenId: "dashboard-token-id",
        },
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("dashboard-secret");
    expect(rawEvent.payload.authorization).toBe("Bearer dashboard-secret");
  });

  it("builds a universal run trace projection from durable, lifecycle, memory, provider, approval, and artifact truth", async () => {
    const deps = createDeps();
    deps.durableOperatorService.getRun.mockReturnValue({
      runId: "run-1",
      workflowKey: "chat.turn.execute",
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: { sessionId: "session-1", turnId: "turn-1" },
      metadata: {},
      lastError: "provider failed",
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:02:00.000Z",
    });
    deps.durableOperatorService.listRunCheckpoints.mockReturnValue([
      {
        checkpointId: "checkpoint-1",
        runId: "run-1",
        checkpointKind: "manual_replay_requested",
        state: { replayedBy: "operator" },
        createdAt: "2026-05-30T00:01:00.000Z",
      },
    ]);
    deps.durableOperatorService.listRunTimeline.mockReturnValue([
      {
        eventId: "event-1",
        runId: "run-1",
        eventType: "run_failed",
        payload: { error: "timeline failure" },
        createdAt: "2026-05-30T00:02:00.000Z",
      },
    ]);
    deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockResolvedValue({
      query: { runId: "run-1" },
      canonical: { runId: "run-1", sessionId: "session-1", turnId: "turn-1", approvalId: "approval-1" },
      linked: {
        sessionIds: ["session-1"],
        turnIds: ["turn-1"],
        runIds: ["run-1"],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: [],
        workspaceIds: ["workspace-1"],
      },
      session: { sessionId: "session-1", channel: "chat" },
      sessionSummary: { transcriptEventCount: 2 },
      turns: [
        {
          turnId: "turn-1",
          sessionId: "session-1",
          userMessageId: "message-1",
          status: "failed",
          mode: "chat",
          startedAt: "2026-05-30T00:00:00.000Z",
          durableRunId: "run-1",
          routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5" },
          completion: {
            status: "interrupted",
            repaired: false,
            usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, costUsd: 0.04, costSource: "estimated" },
            latencyMs: 1200,
            providerCallCount: 1,
          },
          failure: { failureClass: "unknown", message: "turn failure" },
        },
      ],
      toolRuns: [
        {
          toolRunId: "tool-1",
          turnId: "turn-1",
          sessionId: "session-1",
          toolName: "memory.search",
          status: "executed",
          approvalId: "approval-1",
          startedAt: "2026-05-30T00:00:10.000Z",
        },
      ],
    });
    deps.storage.approvals.get.mockReturnValue({ approvalId: "approval-1", status: "pending" });
    deps.storage.memoryContexts.listByRun.mockReturnValue([{ contextId: "context-1", runId: "run-1" }]);
    deps.storage.chatGeneratedArtifacts.listByTurnIds.mockReturnValue(
      new Map([
        [
          "turn-1",
          [
            {
              artifactId: "artifact-1",
              sessionId: "session-1",
              turnId: "turn-1",
              title: "Trace report",
              kind: "markdown",
              content: "large content not projected",
              sourceSurface: "chat",
              version: 1,
              contentHash: "sha256:abc",
              createdAt: "2026-05-30T00:03:00.000Z",
              updatedAt: "2026-05-30T00:03:00.000Z",
            },
          ],
        ],
      ]),
    );
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const trace = await service.getObserveRunTrace("run-1");

    expect(trace).toMatchObject({
      version: "observe.run_trace.v1",
      runId: "run-1",
      durable: {
        checkpoints: { state: "available" },
        timeline: { state: "available" },
      },
      lifecycle: { state: "available" },
      session: { state: "available" },
      thread: { state: "available" },
      approvals: { state: "available", items: [{ approvalId: "approval-1" }], missingIds: [] },
      toolCalls: { state: "available", items: [{ toolRunId: "tool-1" }] },
      memoryContext: { state: "available", items: [{ contextId: "context-1" }] },
      providerUsage: {
        state: "available",
        totals: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, costUsd: 0.04 },
      },
      artifacts: { state: "available", items: [{ artifactId: "artifact-1", contentHash: "sha256:abc" }] },
      errors: { state: "available" },
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        replay: { state: "available", checkpointIds: ["checkpoint-1"] },
      },
    });
    expect(trace.artifacts.items[0]).not.toHaveProperty("content");
  });

  it("projects the fully assembled Observe trace and export while preserving every canonical backing record", async () => {
    const deps = createDeps();
    const rawRun = {
      runId: "run-secret-projection",
      workflowKey: "chat.turn.execute",
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload: {
        sessionId: "session-secret-projection",
        turnId: "turn-secret-projection",
        DATABASE_PASSWORD: "run-db-secret",
        tokenEnv: "RUN_DATABASE_PASSWORD",
      },
      metadata: {
        authorization: "Bearer run-metadata-secret",
        heartbeatDecisionReceipt: { version: 1, notify: false },
        heartbeatDecisionRawOutput: '{"notify":false}',
        nested: [{ heartbeatDecisionRawOutput: '{"notify":true,"message":"private"}', retained: true }],
      },
      lastError: "password: run-error-secret",
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:01:00.000Z",
    };
    const rawCheckpoint = {
      checkpointId: "checkpoint-secret-projection",
      runId: rawRun.runId,
      checkpointKind: "manual_replay_requested",
      state: {
        webhookUrl: "https://hooks.example.test/checkpoint/secret",
        secretRef: "vault:checkpoint",
        heartbeatDecisionReceipt: { version: 1, notify: false },
        heartbeatDecisionRawOutput: '{"notify":false}',
      },
      createdAt: "2026-05-30T00:00:10.000Z",
    };
    const rawTimeline = {
      eventId: "timeline-secret-projection",
      runId: rawRun.runId,
      eventType: "run_failed",
      payload: { DATABASE_PASSWORD: "timeline-db-secret", tokenId: "timeline-token-id" },
      createdAt: "2026-05-30T00:00:20.000Z",
    };
    const rawLifecycle = {
      query: { runId: rawRun.runId },
      canonical: {
        runId: rawRun.runId,
        sessionId: "session-secret-projection",
        turnId: "turn-secret-projection",
        approvalId: "approval-secret-projection",
      },
      linked: {
        sessionIds: ["session-secret-projection"],
        turnIds: ["turn-secret-projection"],
        runIds: [rawRun.runId],
        proactiveRunIds: [],
        approvalIds: ["approval-secret-projection"],
        taskIds: [],
        workspaceIds: ["workspace-secret-projection"],
      },
      turns: [],
      toolRuns: [
        {
          toolRunId: "tool-secret-projection",
          turnId: "turn-secret-projection",
          sessionId: "session-secret-projection",
          toolName: "http.get",
          status: "executed",
          args: {
            webhookUrl: "https://hooks.example.test/tool/secret",
            tokenEnv: "TOOL_TOKEN",
          },
          result: {
            authorization: "Bearer tool-result-secret",
            tokenId: "tool-token-id",
          },
          startedAt: "2026-05-30T00:00:05.000Z",
        },
      ],
    };
    const rawApproval = {
      approvalId: "approval-secret-projection",
      kind: "tool.invoke",
      riskLevel: "danger",
      reason: "Inspect the tool request.",
      status: "pending",
      payload: {
        DATABASE_PASSWORD: "approval-db-secret",
        secretRef: "vault:approval",
      },
      createdAt: "2026-05-30T00:00:02.000Z",
      expiresAt: "2026-05-30T01:00:02.000Z",
    };
    const rawMemory = {
      contextId: "memory-secret-projection",
      runId: rawRun.runId,
      context: {
        authorization: "Bearer memory-context-secret",
        tokenId: "memory-token-id",
      },
    };
    const rawArtifact = {
      artifactId: "artifact-secret-projection",
      sessionId: "session-secret-projection",
      turnId: "turn-secret-projection",
      title: "password: artifact-title-secret",
      kind: "markdown",
      content: "DATABASE_PASSWORD=artifact-content-secret",
      sourceSurface: "chat",
      version: 1,
      contentHash: "sha256:artifact",
      createdAt: "2026-05-30T00:00:30.000Z",
      updatedAt: "2026-05-30T00:00:30.000Z",
    };
    deps.durableOperatorService.getRun.mockReturnValue(rawRun);
    deps.durableOperatorService.listRunCheckpoints.mockReturnValue([rawCheckpoint]);
    deps.durableOperatorService.listRunTimeline.mockReturnValue([rawTimeline]);
    deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockResolvedValue(rawLifecycle);
    deps.storage.approvals.get.mockReturnValue(rawApproval);
    deps.storage.memoryContexts.listByRun.mockReturnValue([rawMemory]);
    deps.storage.chatGeneratedArtifacts.listByTurnIds.mockReturnValue(
      new Map([["turn-secret-projection", [rawArtifact]]]),
    );
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const trace = await service.getObserveRunTrace(rawRun.runId);
    const exported = await service.getObserveRunTraceExport(rawRun.runId);
    const exportContent = JSON.parse(exported.content);
    const secretValues = [
      "run-db-secret",
      "run-metadata-secret",
      "run-error-secret",
      "https://hooks.example.test/checkpoint/secret",
      "timeline-db-secret",
      "https://hooks.example.test/tool/secret",
      "tool-result-secret",
      "approval-db-secret",
      "memory-context-secret",
      "artifact-title-secret",
      "artifact-content-secret",
    ];
    for (const value of secretValues) {
      expect(JSON.stringify(trace)).not.toContain(value);
      expect(JSON.stringify(exported)).not.toContain(value);
      expect(JSON.stringify(exportContent)).not.toContain(value);
    }
    expect(JSON.stringify(trace)).not.toContain("heartbeatDecisionRawOutput");
    expect(JSON.stringify(exported)).not.toContain("heartbeatDecisionRawOutput");
    expect(JSON.stringify(exportContent)).not.toContain("heartbeatDecisionRawOutput");
    expect(trace).toMatchObject({
      run: {
        runId: rawRun.runId,
        status: "failed",
        payload: { DATABASE_PASSWORD: "[REDACTED]", tokenEnv: "RUN_DATABASE_PASSWORD" },
        metadata: {
          authorization: "[REDACTED]",
          heartbeatDecisionReceipt: { version: 1, notify: false },
          nested: [{ retained: true }],
        },
      },
      durable: {
        checkpoints: {
          items: [
            {
              checkpointId: rawCheckpoint.checkpointId,
              state: {
                webhookUrl: "[REDACTED]",
                secretRef: "vault:checkpoint",
                heartbeatDecisionReceipt: { version: 1, notify: false },
              },
            },
          ],
        },
        timeline: {
          items: [
            {
              eventId: rawTimeline.eventId,
              payload: { DATABASE_PASSWORD: "[REDACTED]", tokenId: "timeline-token-id" },
            },
          ],
        },
      },
      approvals: {
        items: [
          {
            approvalId: rawApproval.approvalId,
            status: "pending",
            payload: { DATABASE_PASSWORD: "[REDACTED]", secretRef: "vault:approval" },
          },
        ],
      },
      toolCalls: {
        items: [
          {
            toolRunId: "tool-secret-projection",
            args: { webhookUrl: "[REDACTED]", tokenEnv: "TOOL_TOKEN" },
            result: { authorization: "[REDACTED]", tokenId: "tool-token-id" },
          },
        ],
      },
      memoryContext: {
        items: [
          {
            contextId: rawMemory.contextId,
            context: { authorization: "[REDACTED]", tokenId: "memory-token-id" },
          },
        ],
      },
      artifacts: {
        items: [{ artifactId: rawArtifact.artifactId, title: "password: [REDACTED]" }],
      },
    });
    expect(exportContent.trace).toEqual(exported.trace);
    expect(rawRun.payload.DATABASE_PASSWORD).toBe("run-db-secret");
    expect(rawRun.metadata.heartbeatDecisionRawOutput).toBe('{"notify":false}');
    expect(rawRun.metadata.nested[0]?.heartbeatDecisionRawOutput).toContain("private");
    expect(rawCheckpoint.state.webhookUrl).toBe("https://hooks.example.test/checkpoint/secret");
    expect(rawCheckpoint.state.heartbeatDecisionRawOutput).toBe('{"notify":false}');
    expect(rawTimeline.payload.DATABASE_PASSWORD).toBe("timeline-db-secret");
    expect(rawLifecycle.toolRuns[0]?.result.authorization).toBe("Bearer tool-result-secret");
    expect(rawApproval.payload.DATABASE_PASSWORD).toBe("approval-db-secret");
    expect(rawMemory.context.authorization).toBe("Bearer memory-context-secret");
    expect(rawArtifact.title).toBe("password: artifact-title-secret");
    expect(rawArtifact.content).toBe("DATABASE_PASSWORD=artifact-content-secret");
  });

  it.each([
    {
      label: "Chat",
      runId: "run-chat",
      workflowKey: "chat.turn.execute",
      mode: "chat",
      surface: "chat",
      payload: buildChatTurnPayload("chat"),
    },
    {
      label: "Cowork",
      runId: "run-cowork",
      workflowKey: "orchestration.plan.execute",
      mode: "cowork",
      surface: "cowork",
      payload: {
        version: "orchestration.plan.execute.v1",
        orchestrationRunId: "orchestration-cowork",
        planId: "plan-cowork",
        workspaceId: "workspace-cowork",
        requestedAt: "2026-05-30T00:00:00.000Z",
      },
    },
    {
      label: "Code Mode",
      runId: "run-code",
      workflowKey: "chat.turn.execute",
      mode: "code",
      surface: "code",
      payload: buildChatTurnPayload("code", "Run the governed code change"),
      approvalIds: ["approval-code-mode"],
      toolRuns: [
        {
          toolRunId: "tool-code-mode",
          turnId: "turn-code",
          sessionId: "session-code",
          toolName: "code_mode.run",
          status: "executed",
          approvalId: "approval-code-mode",
          startedAt: "2026-05-30T00:00:10.000Z",
          finishedAt: "2026-05-30T00:00:50.000Z",
        },
      ],
    },
  ])(
    "preserves $label durable run trace posture and mode evidence",
    async ({ runId, workflowKey, mode, surface, payload, approvalIds = [], toolRuns = [] }) => {
      const deps = createDeps();
      const sessionId = `session-${surface}`;
      const turnId = `turn-${surface}`;
      deps.storage.approvals.get.mockImplementation((approvalId: string) =>
        approvalId === "approval-code-mode"
          ? {
              approvalId: "approval-code-mode",
              kind: "code_mode.run",
              riskLevel: "caution",
              status: "approved",
              payload: { actionType: "code_mode.run", runId: "code-mode-run-1" },
              preview: { actionType: "code_mode.run", runId: "code-mode-run-1" },
              linkage: {
                sessionId: "session-code",
                turnId: "turn-code",
                runId: "code-mode-run-1",
                durableRunId: "run-code",
                originSurface: "code",
                actionType: "code_mode.run",
              },
              createdAt: "2026-05-30T00:00:10.000Z",
              expiresAt: "2026-05-30T00:15:10.000Z",
              resolvedAt: "2026-05-30T00:00:30.000Z",
              resolvedBy: "operator",
              resolutionNote: "Approved governed Code Mode run.",
              explanationStatus: "not_requested",
            }
          : undefined,
      );
      deps.durableOperatorService.getRun.mockReturnValue({
        runId,
        workflowKey,
        status: "completed",
        attemptCount: 1,
        maxAttempts: 3,
        version: 1,
        payload,
        metadata: { surface },
        createdAt: "2026-05-30T00:00:00.000Z",
        updatedAt: "2026-05-30T00:01:00.000Z",
      });
      deps.durableOperatorService.listRunCheckpoints.mockReturnValue([]);
      deps.durableOperatorService.listRunTimeline.mockReturnValue([]);
      deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockResolvedValue({
        query: { runId },
        canonical: { runId, sessionId, turnId },
        linked: {
          sessionIds: [sessionId],
          turnIds: [turnId],
          runIds: [runId],
          proactiveRunIds: [],
          approvalIds,
          taskIds: [],
          workspaceIds: [`workspace-${surface}`],
        },
        session: { sessionId, channel: mode },
        sessionSummary: { transcriptEventCount: 1 },
        turns: [
          {
            turnId,
            sessionId,
            status: "completed",
            mode,
            startedAt: "2026-05-30T00:00:00.000Z",
            durableRunId: runId,
            routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5" },
            completion: {
              status: "completed",
              repaired: false,
              usage: { inputTokens: 7, outputTokens: 11, cachedInputTokens: 2, costUsd: 0.03, costSource: "estimated" },
              latencyMs: 900,
              providerCallCount: 1,
            },
          },
        ],
        toolRuns,
      });
      const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

      const trace = await service.getObserveRunTrace(runId);

      expect(trace).toMatchObject({
        version: "observe.run_trace.v1",
        runId,
        run: { runId, workflowKey, status: "completed" },
        lifecycle: { state: "available" },
        session: { state: "available", item: { sessionId, channel: mode } },
        thread: { state: "available", turns: [{ turnId, mode, durableRunId: runId }] },
        providerUsage: {
          state: "available",
          totals: { inputTokens: 7, outputTokens: 11, cachedInputTokens: 2, costUsd: 0.03 },
        },
        approvals: {
          state: approvalIds.length > 0 ? "available" : "not_available",
          items: approvalIds.length > 0 ? [{ approvalId: "approval-code-mode", kind: "code_mode.run" }] : [],
          missingIds: [],
        },
        toolCalls: {
          state: toolRuns.length > 0 ? "available" : "not_available",
          items: toolRuns.length > 0 ? [{ toolRunId: "tool-code-mode", toolName: "code_mode.run" }] : [],
        },
        artifacts: { state: "not_available", items: [] },
        memoryContext: { state: "not_available", items: [] },
        posture: {
          readOnly: true,
          sideEffectPosture: "audit_only",
          audit: { state: "available" },
        },
      });
      expect(deps.durableOperatorService.getRun).toHaveBeenCalledWith(runId);
    },
  );

  it("returns a partial run trace with explicit unknown and not_available states when optional stores fail", async () => {
    const deps = createDeps();
    deps.durableOperatorService.getRun.mockReturnValue({
      runId: "run-partial",
      workflowKey: "approval.wait",
      status: "waiting",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload: { approvalId: "approval-missing" },
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    });
    deps.durableOperatorService.listRunCheckpoints.mockReturnValue([]);
    deps.durableOperatorService.listRunTimeline.mockReturnValue([]);
    deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockRejectedValue(new Error("linked session missing"));
    deps.storage.approvals.get.mockImplementation(() => {
      throw new Error("approval not found");
    });
    deps.storage.memoryContexts.listByRun.mockImplementation(() => {
      throw new Error("memory context unavailable");
    });

    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));
    const trace = await service.getObserveRunTrace("run-partial");

    expect(trace).toMatchObject({
      runId: "run-partial",
      lifecycle: { state: "unknown", error: "linked session missing" },
      session: { state: "unknown" },
      approvals: { state: "unknown", items: [], missingIds: ["approval-missing"] },
      toolCalls: { state: "unknown", items: [] },
      memoryContext: { state: "unknown", error: "memory context unavailable", items: [] },
      artifacts: { state: "not_available", items: [] },
      durable: {
        checkpoints: { state: "not_available", items: [] },
        timeline: { state: "not_available", items: [] },
      },
    });
  });

  it("keeps trace reads audit-only even when a paused run can be resumed elsewhere", async () => {
    const deps = createDeps();
    deps.durableOperatorService.getRun.mockReturnValue({
      runId: "run-paused",
      workflowKey: "chat.turn.execute",
      status: "paused",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload: {},
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    });
    deps.durableOperatorService.listRunCheckpoints.mockReturnValue([]);
    deps.durableOperatorService.listRunTimeline.mockReturnValue([]);
    deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockResolvedValue({
      query: { runId: "run-paused" },
      canonical: { runId: "run-paused" },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: ["run-paused"],
        proactiveRunIds: [],
        approvalIds: [],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const trace = await service.getObserveRunTrace("run-paused");

    expect(trace.posture).toMatchObject({
      readOnly: true,
      sideEffectPosture: "audit_only",
      audit: { state: "available" },
      resume: {
        state: "available",
        eligible: true,
        endpoint: "/api/v1/durable/runs/run-paused/resume",
      },
    });
    expect(deps.durableOperatorService.getRun).toHaveBeenCalledWith("run-paused");
  });

  it("exports universal run traces as read-only JSON snapshots", async () => {
    const deps = createDeps();
    deps.durableOperatorService.getRun.mockReturnValue({
      runId: "run/export 1",
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload: {},
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:01:00.000Z",
    });
    deps.runtimeLifecycleReadService.getRuntimeLifecycle.mockResolvedValue({
      query: { runId: "run/export 1" },
      canonical: { runId: "run/export 1" },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: ["run/export 1"],
        proactiveRunIds: [],
        approvalIds: [],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const exported = await service.getObserveRunTraceExport("run/export 1");
    const content = JSON.parse(exported.content);

    expect(exported).toMatchObject({
      version: "observe.run_trace_export.v1",
      runId: "run/export 1",
      format: "json",
      contentType: "application/json",
      filename: "goatcitadel-run-trace-run-export-1.json",
      sourceEndpoint: "/api/v1/observe/runs/run%2Fexport%201/trace",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
      },
    });
    expect(content.trace).toMatchObject({
      version: "observe.run_trace.v1",
      runId: "run/export 1",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
      },
    });
    expect(content).not.toHaveProperty("content");
  });
});

function createDeps() {
  return {
    rootDir: "F:/code/personal-ai",
    readDesignQualityEvidence: vi.fn(() => buildDesignQualitySnapshot()),
    backupRetentionService: {
      listBackups: vi.fn(() => [{ backupId: "backup-1" }]),
    },
    durableOperatorService: {
      getRun: vi.fn(),
      listRunCheckpoints: vi.fn(() => []),
      listRunTimeline: vi.fn(() => []),
    },
    memoryLifecycleService: {
      getContextStats: vi.fn(() => ({ totalRuns: 2 })),
      listMemoryFiles: vi.fn(() => [{ relativePath: "notes/a.md" }]),
    },
    operatorSummaryCache: {
      get: vi.fn((loader: () => unknown) => loader()),
    },
    promptPackService: {
      listPromptPacks: vi.fn(() => [{ packId: "pack-1", name: "Quality pack", testCount: 2 }]),
      listSecurityEvalPacks: vi.fn(() => ({
        generatedAt: "2026-05-31T00:00:00.000Z",
        items: [{ packKey: "security", title: "Security", testCount: 4, status: "available" }],
        warnings: ["Security packs are stored evidence."],
      })),
      listSecurityQualityGates: vi.fn(() => ({
        generatedAt: "2026-05-31T00:00:00.000Z",
        items: [
          {
            gateId: "gate-1",
            packKey: "security",
            title: "Gate",
            status: "passed",
            evidence: {
              definitionStatus: "imported",
              testCount: 4,
              completedRuns: 4,
              failedRuns: 0,
              needsScoreCount: 0,
              passCount: 4,
              failCount: 0,
              reviewCount: 0,
              effectivePassRate: 1,
              passThreshold: 75,
              failingCodes: [],
            },
            blockers: [],
            nextActions: ["Keep this stored gate evidence."],
          },
        ],
        warnings: ["Security gates are read-only."],
      })),
    },
    realtimeEventService: {
      listRealtimeEvents: vi.fn(() => [{ eventId: "event-1" }]),
    },
    storage: {
      costLedger: {
        summary: vi.fn((scope: string) => (scope === "day" ? [{ costUsd: 1 }, { costUsd: 2 }] : [{ costUsd: 1.25 }])),
        usageAvailability: vi.fn(() => ({ available: true })),
      },
      sessions: {
        list: vi.fn(() => [{ sessionId: "session-1" }]),
        listOperatorSummaries: vi.fn(() => [{ operatorId: "operator-1" }]),
      },
      approvals: {
        get: vi.fn(),
        list: vi.fn(() => [
          { approvalId: "approval-1", expiresAt: "2999-01-01T00:00:00.000Z" },
          { approvalId: "approval-2", expiresAt: "2000-01-01T00:00:00.000Z" },
        ]),
      },
      taskSubagents: {
        activeCount: vi.fn(() => 4),
      },
      tasks: {
        statusCounts: vi.fn(() => [{ status: "todo", count: 3 }]),
      },
      realtimeEvents: {
        list: vi.fn(() => [{ eventId: "recent-1" }]),
      },
      memoryContexts: {
        listByRun: vi.fn(() => []),
      },
      llmEvalProofRuns: {
        list: vi.fn(() => [
          {
            runId: "eval-1",
            status: "completed",
            results: [
              { providerId: "openai", model: "gpt-5", paretoOptimal: true },
              { providerId: "local", model: "tiny", paretoOptimal: false },
            ],
          },
        ]),
      },
      chatGeneratedArtifacts: {
        listByTurnIds: vi.fn(() => new Map()),
      },
    },
    runtimeLifecycleReadService: {
      getRuntimeLifecycle: vi.fn(),
    },
    isFeatureEnabled: vi.fn(() => true),
  };
}

function buildDesignQualitySnapshot(
  input: {
    checks?: OpsDesignQualitySnapshot["checks"];
    warnings?: string[];
    error?: string;
  } = {},
): OpsDesignQualitySnapshot {
  const checks = input.checks ?? [
    {
      id: "design-intelligence.modules",
      label: "Design-intelligence module integrity",
      severity: "P3",
      status: "passing",
      owner: "skills/bundled/design-intelligence",
      evidence: "skills/bundled/design-intelligence",
    },
    {
      id: "design-quality.proof-lanes",
      label: "Design proof lanes are wired",
      severity: "P3",
      status: "passing",
      owner: "scripts",
      evidence: "package.json",
    },
  ];
  return {
    state: input.error ? "unknown" : "available",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      source: "repo_files",
      callsProviders: false,
      mutationPerformed: false,
      note: "Design quality evidence reads repo files only.",
    },
    summary: {
      totalChecks: checks.length,
      passingCount: checks.filter((item) => item.status === "passing").length,
      advisoryCount: checks.filter((item) => item.status === "advisory").length,
      blockingCount: checks.filter((item) => item.status === "blocking").length,
      unknownCount: checks.filter((item) => item.status === "unknown").length,
      p0Count: checks.filter((item) => item.severity === "P0").length,
      p1Count: checks.filter((item) => item.severity === "P1").length,
      p2Count: checks.filter((item) => item.severity === "P2").length,
      p3Count: checks.filter((item) => item.severity === "P3").length,
    },
    checks,
    warnings: input.warnings ?? [],
    ...(input.error ? { error: input.error } : {}),
  };
}

function buildChatTurnPayload(surface: "chat" | "code", content = "Trace this run") {
  return {
    version: "chat.turn.execute.v1",
    sessionId: `session-${surface}`,
    turnId: `turn-${surface}`,
    userMessageId: `user-${surface}`,
    assistantMessageId: `assistant-${surface}`,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: {
      content,
      mode: surface,
      providerId: "openai",
      model: "gpt-5",
      toolAutonomy: surface === "code" ? "manual" : "safe_auto",
    },
  };
}
