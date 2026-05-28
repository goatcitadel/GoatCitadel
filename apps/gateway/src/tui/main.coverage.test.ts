import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  navigateQueue: [
    "chat",
    "code",
    "approvals",
    "promptlab",
    "memory",
    "files",
    "cron",
    "improvement",
    "sessions",
    "costs",
    "tools",
    "tasks",
    "skills",
    "integrations",
    "mesh",
    "npu",
    "system",
    "onboarding",
    "settings",
    "exit",
  ] as string[],
  liveStop: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async (input: { message?: string; choices?: Array<{ value?: string; name?: string }> }) => {
    const values = (input.choices ?? []).map((choice) => String(choice.value ?? choice.name ?? ""));
    const message = (input.message ?? "").toLowerCase();
    if (message.includes("navigate")) {
      return state.navigateQueue.shift() ?? "exit";
    }
    if (message.includes("status") && values.includes("active")) {
      return "active";
    }
    if (message.includes("mode") && values.includes("chat")) {
      return "chat";
    }
    if (message.includes("web mode") && values.includes("off")) {
      return "off";
    }
    if (message.includes("memory mode") && values.includes("auto")) {
      return "auto";
    }
    if (message.includes("thinking") && values.includes("minimal")) {
      return "minimal";
    }
    const preferred = values.find((value) => value && value !== "back" && value !== "cancel");
    if (preferred) {
      return preferred;
    }
    if (values.includes("back")) {
      return "back";
    }
    return values[0] ?? "";
  }),
  input: vi.fn(async (input: { message?: string }) => {
    const message = (input.message ?? "").toLowerCase();
    if (message.includes("blank to return")) return "coverage message";
    if (message.includes("session id")) return "session-1";
    if (message.includes("pack id")) return "pack-1";
    if (message.includes("test id")) return "test-1";
    if (message.includes("item id")) return "item-1";
    if (message.includes("path")) return "workspace/coverage.txt";
    if (message.includes("job id")) return "job-1";
    if (message.includes("approval id")) return "approval-1";
    if (message.includes("grant id")) return "grant-1";
    if (message.includes("run id")) return "run-1";
    if (message.includes("connection id")) return "conn-1";
    if (message.includes("tool")) return "session.status";
    return "coverage";
  }),
  confirm: vi.fn(async () => true),
  password: vi.fn(async () => "token"),
}));

vi.mock("./profile.js", () => ({
  loadResolvedProfile: vi.fn(async () => ({
    profileName: "coverage",
    filePath: "coverage-profile.json",
    profile: {
      gatewayBaseUrl: "http://127.0.0.1:8787",
      pollIntervalsMs: {
        activity: 2500,
      },
    },
    auth: {
      mode: "none",
      tokenQueryParam: "access_token",
    },
  })),
  saveProfile: vi.fn(async () => undefined),
}));

vi.mock("./live-feed.js", () => ({
  TuiLiveFeed: class {
    public constructor() {
      // no-op
    }
    public async start(): Promise<void> {
      // no-op
    }
    public stop(): void {
      state.liveStop();
    }
    public getState(): string {
      return "connected";
    }
    public getLastEvent(): { timestamp: string } {
      return { timestamp: new Date().toISOString() };
    }
    public getLastError(): string | null {
      return null;
    }
  },
}));

function buildResponse(methodName: string): unknown {
  const now = new Date().toISOString();
  switch (methodName) {
    case "dashboard":
      return {
        timestamp: now,
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: 0,
      };
    case "devDiagnostics":
      return { items: [] };
    case "googleMeetPrerequisites":
      return { state: "ready", provider: "coverage", prerequisites: [] };
    case "listChatSessions":
      return {
        items: [
          {
            sessionId: "session-1",
            title: "Coverage session",
            kind: "chat",
            updatedAt: now,
          },
        ],
      };
    case "createChatSession":
      return { sessionId: "session-1" };
    case "listChatMessages":
      return {
        items: [
          {
            messageId: "msg-1",
            role: "assistant",
            createdAt: now,
            content: "coverage",
          },
        ],
      };
    case "patchChatPrefs":
      return { ok: true };
    case "listApprovals":
      return {
        items: [{ approvalId: "approval-1", status: "pending", kind: "tool.invoke", createdAt: now }],
      };
    case "getApprovalReplay":
      return { approval: { approvalId: "approval-1", status: "pending" } };
    case "resolveApproval":
      return { approval: { approvalId: "approval-1", status: "approved" } };
    case "listPromptPacks":
      return {
        items: [
          {
            packId: "pack-1",
            label: "Coverage Pack",
            version: "v1",
            testCount: 1,
            updatedAt: now,
          },
        ],
      };
    case "listPromptPackTests":
      return {
        items: [
          {
            testId: "test-1",
            code: "TEST-01",
            category: "routing",
            title: "Coverage test",
          },
        ],
      };
    case "runPromptPackTest":
      return { runId: "run-1" };
    case "runPromptPackBenchmark":
      return { benchmarkRunId: "bench-1" };
    case "getPromptPackBenchmark":
      return { benchmarkRunId: "bench-1", status: "completed" };
    case "getPromptPackReport":
      return { summary: { totalTests: 1, passRate: 1 }, items: [] };
    case "runPromptPackReplayRegression":
      return { runId: "replay-1" };
    case "getPromptPackReplayRegression":
      return { runId: "replay-1", status: "completed" };
    case "getPromptPackTrends":
      return { capabilitySeries: [] };
    case "listMemoryItems":
      return {
        items: [
          {
            itemId: "item-1",
            namespace: "coverage",
            title: "Coverage item",
            status: "active",
            pinned: false,
            updatedAt: now,
          },
        ],
      };
    case "patchMemoryItem":
    case "forgetMemoryItem":
    case "forgetMemory":
      return { ok: true };
    case "listMemoryItemHistory":
      return { items: [{ changeId: "change-1", changeType: "updated", createdAt: now }] };
    case "listFiles":
      return {
        items: [{ relativePath: "workspace/coverage.txt", kind: "file", sizeBytes: 8, updatedAt: now }],
      };
    case "downloadFile":
      return { fileName: "coverage.txt", content: "coverage", relativePath: "workspace/coverage.txt" };
    case "uploadFile":
      return { relativePath: "workspace/coverage.txt" };
    case "listCronJobs":
      return { items: [{ jobId: "job-1", name: "Coverage cron", schedule: "*/15 * * * *", enabled: true }] };
    case "listCronReviewQueue":
      return { items: [{ itemId: "review-1", status: "pending" }] };
    case "retryCronReviewItem":
      return { ok: true };
    case "getCronRunDiff":
      return { runId: "run-1", changed: true };
    case "runCronJob":
    case "startCronJob":
    case "pauseCronJob":
    case "deleteCronJob":
      return { ok: true };
    case "listImprovementReports":
      return { items: [{ reportId: "report-1", status: "ready" }] };
    case "listImprovementReplayRuns":
      return { items: [{ replayRunId: "replay-1", status: "completed" }] };
    case "runImprovementReplay":
      return { replayRunId: "replay-1" };
    case "createReplayDraft":
    case "executeReplayOverride":
      return { replayRunId: "replay-2" };
    case "getImprovementReport":
      return { reportId: "report-1", summary: {} };
    case "getImprovementReplayRun":
      return { replayRunId: "replay-1", status: "completed" };
    case "getReplayDiff":
      return { before: {}, after: {}, summary: {} };
    case "listSessions":
      return { items: [{ sessionId: "session-1", title: "Coverage session", updatedAt: now }] };
    case "listCosts":
      return { scope: "day", from: now, to: now, items: [] };
    case "listMemoryQmdStats":
      return {
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
      };
    case "runCheaper":
      return { mode: "balanced", actions: [] };
    case "toolsCatalog":
      return { items: [{ toolName: "session.status", riskLevel: "low" }] };
    case "toolsListGrants":
      return { items: [] };
    case "toolsEvaluateAccess":
      return { allowed: true, reasonCodes: [], riskLevel: "low" };
    case "toolsCreateGrant":
      return { grantId: "grant-1" };
    case "toolsRevokeGrant":
    case "toolsInvoke":
      return { outcome: "executed", result: { ok: true } };
    case "listTasks":
      return { items: [{ taskId: "task-1", title: "Coverage task", status: "todo" }] };
    case "createTask":
      return { taskId: "task-1" };
    case "updateTask":
    case "appendTaskActivity":
      return { ok: true };
    case "listSkills":
      return { items: [{ id: "skill-1", title: "Coverage skill", enabled: true }] };
    case "reloadSkills":
      return { ok: true };
    case "resolveSkills":
      return { result: [] };
    case "integrationCatalog":
      return { items: [{ catalogId: "cat-1", label: "Coverage integration" }] };
    case "integrationConnections":
      return { items: [{ connectionId: "conn-1", label: "Coverage connection", enabled: true }] };
    case "createIntegrationConnection":
    case "updateIntegrationConnection":
    case "deleteIntegrationConnection":
      return { ok: true };
    case "meshStatus":
      return { connected: true, now };
    case "meshNodes":
      return { items: [{ nodeId: "node-1", online: true }] };
    case "meshLeases":
      return { items: [{ leaseKey: "lease-1", holderNodeId: "node-1" }] };
    case "meshOwners":
      return { items: [{ sessionId: "session-1", ownerNodeId: "node-1" }] };
    case "meshReplicationOffsets":
      return { offsets: [] };
    case "meshAcquireLease":
    case "meshRenewLease":
    case "meshReleaseLease":
    case "meshClaimSession":
      return { ok: true };
    case "npuStatus":
      return { status: "stopped", available: false };
    case "npuModels":
      return { items: [] };
    case "npuStart":
    case "npuStop":
    case "npuRefresh":
      return { ok: true };
    case "systemVitals":
      return {
        hostname: "coverage",
        platform: "win32",
        release: "10",
        uptimeSeconds: 1,
        loadAverage: [0, 0, 0],
        cpuCount: 1,
        memoryTotalBytes: 1,
        memoryFreeBytes: 1,
        memoryUsedBytes: 0,
        processRssBytes: 1,
        processHeapUsedBytes: 1,
      };
    case "runtimeSettings":
      return {
        budgetMode: "balanced",
        defaultToolProfile: "standard",
        npu: {
          enabled: false,
          autoStart: false,
          sidecarUrl: "http://127.0.0.1:11440",
        },
      };
    case "patchRuntimeSettings":
      return { ok: true };
    case "listEvents":
      return { items: [] };
    case "onboardingState":
      return { completed: false, checklist: [] };
    case "onboardingComplete":
    case "onboardingBootstrap":
      return { ok: true };
    case "streamHeaders":
      return {};
    default:
      return {};
  }
}

vi.mock("./api-client.js", () => ({
  TuiApiClient: class {
    public baseUrl: string;
    public readOnly: boolean;

    public constructor(input: { baseUrl: string; readOnly: boolean }) {
      this.baseUrl = input.baseUrl;
      this.readOnly = input.readOnly;
      return new Proxy(this, {
        get: (target, prop, receiver) => {
          if (typeof prop !== "string") {
            return Reflect.get(target, prop, receiver);
          }
          if (prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return async () => buildResponse(prop);
        },
      });
    }

    public async *streamChatMessage(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "delta", delta: "coverage" };
      yield { type: "tool_start", toolRun: { toolName: "session.status", status: "started" } };
      yield { type: "trace_update", trace: { routing: { fallbackReason: "none" } } };
      yield { type: "message_done", content: "coverage" };
      yield { type: "done" };
    }

    public streamHeaders(): Record<string, string> {
      return {};
    }
  },
}));

vi.mock("../doctor/engine.js", () => ({
  runDoctor: vi.fn(async () => ({ summary: { exitCode: 0 } })),
  renderDoctorReport: vi.fn(() => "ok"),
}));

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describe("tui main coverage", () => {
  it("walks all views and executes non-back actions", async () => {
    const priorArgv = process.argv;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "main.ts"];
    try {
      await import("./main.js");
      await waitFor(() => state.liveStop.mock.calls.length > 0);
      expect(state.liveStop).toHaveBeenCalled();
      expect(state.navigateQueue.length).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      process.argv = priorArgv;
    }
  });
});
