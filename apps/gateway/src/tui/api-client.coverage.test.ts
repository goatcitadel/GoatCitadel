import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiApiClient } from "./api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"delta","delta":"hello"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"message_done","content":"hello"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responseFor(url: string): Response {
  const now = new Date().toISOString();
  if (url.includes("/stream")) {
    return sseResponse();
  }
  if (url.includes("/api/v1/dashboard/state")) {
    return jsonResponse({
      timestamp: now,
      sessions: [],
      pendingApprovals: 0,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    });
  }
  if (url.includes("/api/v1/system/vitals")) {
    return jsonResponse({
      hostname: "coverage",
      platform: "win32",
      release: "test",
      uptimeSeconds: 1,
      loadAverage: [0, 0, 0],
      cpuCount: 1,
      memoryTotalBytes: 1,
      memoryFreeBytes: 1,
      memoryUsedBytes: 0,
      processRssBytes: 1,
      processHeapUsedBytes: 1,
    });
  }
  if (url.includes("/api/v1/memory/qmd/stats")) {
    return jsonResponse({
      from: now,
      to: now,
      totalRuns: 0,
      generatedRuns: 0,
      cacheHitRuns: 0,
      fallbackRuns: 0,
      failedRuns: 0,
      originalTokenEstimate: 0,
      distilledTokenEstimate: 0,
      savingsPercent: 0,
      recent: [],
    });
  }
  if (url.includes("/api/v1/settings")) {
    return jsonResponse({ budgetMode: "balanced", defaultToolProfile: "standard" });
  }
  if (url.includes("/api/v1/onboarding/state")) {
    return jsonResponse({ completed: false, checklist: [] });
  }
  if (url.includes("/api/v1/costs/summary")) {
    return jsonResponse({ scope: "day", from: now, to: now, items: [] });
  }
  if (url.includes("/api/v1/npu/models")) {
    return jsonResponse({ items: [] });
  }
  if (url.includes("/api/v1/npu/")) {
    return jsonResponse({ status: "stopped" });
  }
  if (url.includes("/api/v1/approvals")) {
    return jsonResponse({ items: [] });
  }
  if (url.includes("/api/v1/chat/sessions") && url.includes("/messages")) {
    return jsonResponse({ items: [], nextCursor: undefined });
  }
  if (url.includes("/api/v1/chat/sessions")) {
    return jsonResponse({ items: [], sessionId: "sess-1" });
  }
  if (url.includes("/api/v1/sessions")) {
    return jsonResponse({ items: [] });
  }
  if (url.includes("/api/v1/prompt-packs")) {
    return jsonResponse({ items: [], runId: "run-1", benchmarkRunId: "bench-1" });
  }
  if (url.includes("/api/v1/replay/")) {
    return jsonResponse({});
  }
  return jsonResponse({ items: [] });
}

describe("TuiApiClient coverage", () => {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    return responseFor(url);
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes broad API surface and stream handling", async () => {
    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: {
        mode: "token",
        token: "secret",
      },
      readOnly: false,
    });

    const specialArgs: Record<string, unknown[]> = {
      health: [],
      dashboard: [],
      systemVitals: [],
      listApprovals: ["pending"],
      getApprovalReplay: ["approval-1"],
      resolveApproval: ["approval-1", "approve"],
      listSessions: [20],
      listChatSessions: [{ limit: 20 }],
      createChatSession: [{ title: "coverage" }],
      listChatMessages: ["session-1", 25],
      sendChatMessage: ["session-1", { content: "hi" }],
      streamChatMessage: ["session-1", { content: "hi" }],
      getChatPrefs: ["session-1"],
      patchChatPrefs: ["session-1", { mode: "chat" }],
      listCosts: ["day"],
      runCheaper: [],
      listTasks: [],
      createTask: [{ title: "coverage" }],
      updateTask: ["task-1", { status: "done" }],
      listTaskActivities: ["task-1"],
      appendTaskActivity: ["task-1", { message: "ok" }],
      listSkills: [],
      lookupSkillSources: ["browser automation", 10],
      reloadSkills: [],
      resolveSkills: ["help"],
      integrationCatalog: [],
      integrationConnections: [],
      createIntegrationConnection: [
        { catalogId: "x", label: "Coverage", enabled: true, status: "connected", config: {} },
      ],
      updateIntegrationConnection: ["conn-1", { status: "connected" }],
      deleteIntegrationConnection: ["conn-1"],
      meshStatus: [],
      meshNodes: [],
      meshLeases: [],
      meshOwners: [],
      meshReplicationOffsets: [],
      meshAcquireLease: [{ leaseKey: "session:1", holderNodeId: "node-a", ttlSeconds: 30 }],
      meshRenewLease: [{ leaseKey: "session:1", holderNodeId: "node-a", fencingToken: 1, ttlSeconds: 30 }],
      meshReleaseLease: [{ leaseKey: "session:1", holderNodeId: "node-a", fencingToken: 1 }],
      meshClaimSession: ["session-1", { ownerNodeId: "node-a", minEpoch: 0 }],
      npuStatus: [],
      npuModels: [],
      npuStart: [],
      npuStop: [],
      npuRefresh: [],
      onboardingState: [],
      onboardingBootstrap: [
        { defaultToolProfile: "standard", budgetMode: "balanced", markComplete: false, completedBy: "coverage" },
      ],
      onboardingComplete: ["coverage"],
      runtimeSettings: [],
      patchRuntimeSettings: [{ budgetMode: "balanced" }],
      listEvents: [10],
      listMemoryQmdStats: [],
      listMemoryItems: [{ limit: 20 }],
      patchMemoryItem: ["mem-1", { pinned: true }],
      forgetMemoryItem: ["mem-1"],
      listMemoryItemHistory: ["mem-1", 10],
      forgetMemory: [{ namespace: "coverage" }],
      listFiles: [{ dir: ".", limit: 10 }],
      downloadFile: ["README.md"],
      uploadFile: ["coverage.txt", "hello"],
      listCronJobs: [],
      startCronJob: ["job-1"],
      pauseCronJob: ["job-1"],
      runCronJob: ["job-1"],
      deleteCronJob: ["job-1"],
      listCronReviewQueue: [10],
      retryCronReviewItem: ["item-1"],
      getCronRunDiff: ["run-1"],
      listPromptPacks: [10],
      listPromptPackTests: ["pack-1", 10],
      runPromptPackTest: ["pack-1", "test-1", {}],
      runPromptPackBenchmark: ["pack-1", {}],
      getPromptPackBenchmark: ["benchmark-1"],
      getPromptPackReport: ["pack-1"],
      runPromptPackReplayRegression: ["pack-1", {}],
      getPromptPackReplayRegression: ["replay-1"],
      getPromptPackTrends: ["pack-1"],
      listImprovementReports: [10],
      getImprovementReport: ["report-1"],
      runImprovementReplay: [{}],
      listImprovementReplayRuns: [10],
      getImprovementReplayRun: ["run-1"],
      createReplayDraft: ["run-1", []],
      executeReplayOverride: ["run-1", []],
      getReplayDiff: ["run-1"],
      toolsCatalog: [],
      toolsEvaluateAccess: [{ toolName: "session.status", agentId: "agent", sessionId: "session-1", args: {} }],
      toolsListGrants: [{ limit: 10 }],
      toolsCreateGrant: [{ toolPattern: "session.*", decision: "allow", scope: "global" }],
      toolsRevokeGrant: ["grant-1"],
      toolsInvoke: [{ toolName: "session.status", args: {}, agentId: "agent", sessionId: "session-1" }],
      streamHeaders: [],
    };

    const methods = Object.getOwnPropertyNames(TuiApiClient.prototype).filter(
      (name) => !["constructor", "request", "requestStream"].includes(name),
    );

    let called = 0;
    for (const methodName of methods) {
      const method = (client as unknown as Record<string, unknown>)[methodName];
      if (typeof method !== "function") {
        continue;
      }
      const args =
        specialArgs[methodName] ??
        Array.from({ length: (method as (...x: unknown[]) => unknown).length }, () => undefined);
      if (methodName === "streamChatMessage") {
        const events: Array<Record<string, unknown>> = [];
        for await (const event of (method as (...x: unknown[]) => AsyncIterable<Record<string, unknown>>).apply(
          client,
          args,
        )) {
          events.push(event);
        }
        expect(events.some((event) => event.type === "done")).toBe(true);
        called += 1;
        continue;
      }
      await (method as (...x: unknown[]) => Promise<unknown> | unknown).apply(client, args);
      called += 1;
    }

    expect(called).toBeGreaterThanOrEqual(70);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("enforces read-only blocking for mutating calls", async () => {
    const readOnlyClient = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: {
        mode: "none",
      },
      readOnly: true,
    });

    await expect(
      readOnlyClient.toolsEvaluateAccess({
        toolName: "session.status",
        agentId: "agent",
        sessionId: "session-1",
        args: {},
      }),
    ).rejects.toThrow("Read-only mode is enabled");
  });

  it("surfaces malformed SSE payloads instead of silently swallowing them", async () => {
    const encoder = new TextEncoder();
    const fetchMalformed = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"delta"\n\n'));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMalformed as unknown as typeof fetch);

    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: { mode: "none" },
      readOnly: false,
    });

    await expect(
      (async () => {
        for await (const _event of client.streamChatMessage("session-1", { content: "hi" })) {
          // no-op
        }
      })(),
    ).rejects.toThrow(/Malformed SSE event payload/);
  });
});
