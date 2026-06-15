import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  liveStop: vi.fn(),
  loadResolvedProfile: vi.fn(),
  saveProfile: vi.fn(),
  runDoctor: vi.fn(),
  renderDoctorReport: vi.fn(() => "doctor report"),
  client: undefined as any,
  clientInstances: [] as any[],
  selectQueue: [] as string[],
  inputQueue: [] as string[],
  passwordQueue: [] as string[],
}));

vi.mock("../env-file.js", () => ({
  loadLocalEnvFile: vi.fn(),
}));

vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn(function start() {
      return this;
    }),
    stop: vi.fn(),
    fail: vi.fn(),
  })),
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async () => state.selectQueue.shift() ?? "exit"),
  input: vi.fn(async () => state.inputQueue.shift() ?? "operator"),
  password: vi.fn(async () => state.passwordQueue.shift() ?? "secret-token"),
  confirm: vi.fn(async () => true),
}));

vi.mock("./profile.js", () => ({
  loadResolvedProfile: state.loadResolvedProfile,
  saveProfile: state.saveProfile,
}));

vi.mock("./live-feed.js", () => ({
  TuiLiveFeed: class {
    public async start(): Promise<void> {
      // no-op
    }

    public stop(): void {
      state.liveStop();
    }

    public getState(): string {
      return "connected";
    }

    public getLastEvent(): { timestamp: string } | null {
      return null;
    }

    public getLastError(): string | null {
      return "feed paused";
    }
  },
}));

vi.mock("./api-client.js", () => ({
  TuiApiClient: class {
    public baseUrl: string;
    public readOnly: boolean;
    public auth: unknown;

    public constructor(input: { baseUrl: string; readOnly: boolean; auth: unknown }) {
      this.baseUrl = input.baseUrl;
      this.readOnly = input.readOnly;
      this.auth = input.auth;
      state.clientInstances.push(this);
    }

    public dashboard(...args: unknown[]) {
      return state.client.dashboard(...args);
    }

    public devDiagnostics(...args: unknown[]) {
      return state.client.devDiagnostics(...args);
    }

    public googleMeetPrerequisites(...args: unknown[]) {
      return state.client.googleMeetPrerequisites(...args);
    }

    public listChatSessions(...args: unknown[]) {
      return state.client.listChatSessions(...args);
    }

    public fetchLlmConfig(...args: unknown[]) {
      return state.client.fetchLlmConfig(...args);
    }

    public createChatSession(...args: unknown[]) {
      return state.client.createChatSession(...args);
    }

    public listChatMessages(...args: unknown[]) {
      return state.client.listChatMessages(...args);
    }

    public streamChatMessage(...args: unknown[]) {
      return state.client.streamChatMessage(...args);
    }

    public patchChatPrefs(...args: unknown[]) {
      return state.client.patchChatPrefs(...args);
    }

    public getChatWorkbench(...args: unknown[]) {
      return state.client.getChatWorkbench(...args);
    }

    public getChatWorkbenchDiff(...args: unknown[]) {
      return state.client.getChatWorkbenchDiff(...args);
    }

    public getChatWorkbenchOutput(...args: unknown[]) {
      return state.client.getChatWorkbenchOutput(...args);
    }

    public listCodeModeRuns(...args: unknown[]) {
      return state.client.listCodeModeRuns(...args);
    }

    public updateSkillState(...args: unknown[]) {
      return state.client.updateSkillState(...args);
    }

    public installSkillImport(...args: unknown[]) {
      return state.client.installSkillImport(...args);
    }

    public fetchMcpTemplates(...args: unknown[]) {
      return state.client.fetchMcpTemplates(...args);
    }

    public createMcpServer(...args: unknown[]) {
      return state.client.createMcpServer(...args);
    }

    public listApprovals(...args: unknown[]) {
      return state.client.listApprovals(...args);
    }

    public getApprovalReplay(...args: unknown[]) {
      return state.client.getApprovalReplay(...args);
    }

    public resolveApproval(...args: unknown[]) {
      return state.client.resolveApproval(...args);
    }

    public runtimeSettings(...args: unknown[]) {
      return state.client.runtimeSettings(...args);
    }

    public patchRuntimeSettings(...args: unknown[]) {
      return state.client.patchRuntimeSettings(...args);
    }

    private forward(method: string, ...args: unknown[]) {
      return state.client[method](...args);
    }

    public listMemoryItems(...args: unknown[]) {
      return this.forward("listMemoryItems", ...args);
    }

    public patchMemoryItem(...args: unknown[]) {
      return this.forward("patchMemoryItem", ...args);
    }

    public forgetMemoryItem(...args: unknown[]) {
      return this.forward("forgetMemoryItem", ...args);
    }

    public forgetMemory(...args: unknown[]) {
      return this.forward("forgetMemory", ...args);
    }

    public listMemoryItemHistory(...args: unknown[]) {
      return this.forward("listMemoryItemHistory", ...args);
    }

    public listFiles(...args: unknown[]) {
      return this.forward("listFiles", ...args);
    }

    public downloadFile(...args: unknown[]) {
      return this.forward("downloadFile", ...args);
    }

    public uploadFile(...args: unknown[]) {
      return this.forward("uploadFile", ...args);
    }

    public listCronJobs(...args: unknown[]) {
      return this.forward("listCronJobs", ...args);
    }

    public listCronReviewQueue(...args: unknown[]) {
      return this.forward("listCronReviewQueue", ...args);
    }

    public retryCronReviewItem(...args: unknown[]) {
      return this.forward("retryCronReviewItem", ...args);
    }

    public getCronRunDiff(...args: unknown[]) {
      return this.forward("getCronRunDiff", ...args);
    }

    public runCronJob(...args: unknown[]) {
      return this.forward("runCronJob", ...args);
    }

    public startCronJob(...args: unknown[]) {
      return this.forward("startCronJob", ...args);
    }

    public pauseCronJob(...args: unknown[]) {
      return this.forward("pauseCronJob", ...args);
    }

    public deleteCronJob(...args: unknown[]) {
      return this.forward("deleteCronJob", ...args);
    }

    public toolsCatalog(...args: unknown[]) {
      return this.forward("toolsCatalog", ...args);
    }

    public toolsListGrants(...args: unknown[]) {
      return this.forward("toolsListGrants", ...args);
    }

    public toolsEvaluateAccess(...args: unknown[]) {
      return this.forward("toolsEvaluateAccess", ...args);
    }

    public toolsCreateGrant(...args: unknown[]) {
      return this.forward("toolsCreateGrant", ...args);
    }

    public toolsRevokeGrant(...args: unknown[]) {
      return this.forward("toolsRevokeGrant", ...args);
    }

    public toolsInvoke(...args: unknown[]) {
      return this.forward("toolsInvoke", ...args);
    }

    public listTasks(...args: unknown[]) {
      return this.forward("listTasks", ...args);
    }

    public createTask(...args: unknown[]) {
      return this.forward("createTask", ...args);
    }

    public updateTask(...args: unknown[]) {
      return this.forward("updateTask", ...args);
    }

    public appendTaskActivity(...args: unknown[]) {
      return this.forward("appendTaskActivity", ...args);
    }

    public integrationCatalog(...args: unknown[]) {
      return this.forward("integrationCatalog", ...args);
    }

    public integrationConnections(...args: unknown[]) {
      return this.forward("integrationConnections", ...args);
    }

    public createIntegrationConnection(...args: unknown[]) {
      return this.forward("createIntegrationConnection", ...args);
    }

    public updateIntegrationConnection(...args: unknown[]) {
      return this.forward("updateIntegrationConnection", ...args);
    }

    public deleteIntegrationConnection(...args: unknown[]) {
      return this.forward("deleteIntegrationConnection", ...args);
    }

    public meshStatus(...args: unknown[]) {
      return this.forward("meshStatus", ...args);
    }

    public meshNodes(...args: unknown[]) {
      return this.forward("meshNodes", ...args);
    }

    public meshLeases(...args: unknown[]) {
      return this.forward("meshLeases", ...args);
    }

    public meshOwners(...args: unknown[]) {
      return this.forward("meshOwners", ...args);
    }

    public meshReplicationOffsets(...args: unknown[]) {
      return this.forward("meshReplicationOffsets", ...args);
    }

    public meshAcquireLease(...args: unknown[]) {
      return this.forward("meshAcquireLease", ...args);
    }

    public meshRenewLease(...args: unknown[]) {
      return this.forward("meshRenewLease", ...args);
    }

    public meshReleaseLease(...args: unknown[]) {
      return this.forward("meshReleaseLease", ...args);
    }

    public meshClaimSession(...args: unknown[]) {
      return this.forward("meshClaimSession", ...args);
    }

    public npuStatus(...args: unknown[]) {
      return this.forward("npuStatus", ...args);
    }

    public npuModels(...args: unknown[]) {
      return this.forward("npuModels", ...args);
    }

    public npuStart(...args: unknown[]) {
      return this.forward("npuStart", ...args);
    }

    public npuStop(...args: unknown[]) {
      return this.forward("npuStop", ...args);
    }

    public npuRefresh(...args: unknown[]) {
      return this.forward("npuRefresh", ...args);
    }

    public onboardingState(...args: unknown[]) {
      return this.forward("onboardingState", ...args);
    }

    public listLlmModels(...args: unknown[]) {
      return this.forward("listLlmModels", ...args);
    }

    public onboardingComplete(...args: unknown[]) {
      return this.forward("onboardingComplete", ...args);
    }

    public onboardingBootstrap(...args: unknown[]) {
      return this.forward("onboardingBootstrap", ...args);
    }

    public listPromptPacks(...args: unknown[]) {
      return this.forward("listPromptPacks", ...args);
    }

    public getPromptPackBenchmark(...args: unknown[]) {
      return this.forward("getPromptPackBenchmark", ...args);
    }

    public getPromptPackReplayRegression(...args: unknown[]) {
      return this.forward("getPromptPackReplayRegression", ...args);
    }

    public listPromptPackTests(...args: unknown[]) {
      return this.forward("listPromptPackTests", ...args);
    }

    public runPromptPackTest(...args: unknown[]) {
      return this.forward("runPromptPackTest", ...args);
    }

    public runPromptPackBenchmark(...args: unknown[]) {
      return this.forward("runPromptPackBenchmark", ...args);
    }

    public getPromptPackReport(...args: unknown[]) {
      return this.forward("getPromptPackReport", ...args);
    }

    public runPromptPackReplayRegression(...args: unknown[]) {
      return this.forward("runPromptPackReplayRegression", ...args);
    }

    public getPromptPackTrends(...args: unknown[]) {
      return this.forward("getPromptPackTrends", ...args);
    }

    public listImprovementReports(...args: unknown[]) {
      return this.forward("listImprovementReports", ...args);
    }

    public listImprovementReplayRuns(...args: unknown[]) {
      return this.forward("listImprovementReplayRuns", ...args);
    }

    public runImprovementReplay(...args: unknown[]) {
      return this.forward("runImprovementReplay", ...args);
    }

    public getImprovementReport(...args: unknown[]) {
      return this.forward("getImprovementReport", ...args);
    }

    public getImprovementReplayRun(...args: unknown[]) {
      return this.forward("getImprovementReplayRun", ...args);
    }

    public createReplayDraft(...args: unknown[]) {
      return this.forward("createReplayDraft", ...args);
    }

    public executeReplayOverride(...args: unknown[]) {
      return this.forward("executeReplayOverride", ...args);
    }

    public getReplayDiff(...args: unknown[]) {
      return this.forward("getReplayDiff", ...args);
    }

    public listSessions(...args: unknown[]) {
      return this.forward("listSessions", ...args);
    }

    public listCosts(...args: unknown[]) {
      return this.forward("listCosts", ...args);
    }

    public listMemoryQmdStats(...args: unknown[]) {
      return this.forward("listMemoryQmdStats", ...args);
    }

    public runCheaper(...args: unknown[]) {
      return this.forward("runCheaper", ...args);
    }

    public listSkills(...args: unknown[]) {
      return this.forward("listSkills", ...args);
    }

    public reloadSkills(...args: unknown[]) {
      return this.forward("reloadSkills", ...args);
    }

    public resolveSkills(...args: unknown[]) {
      return this.forward("resolveSkills", ...args);
    }

    public systemVitals(...args: unknown[]) {
      return this.forward("systemVitals", ...args);
    }

    public listEvents(...args: unknown[]) {
      return this.forward("listEvents", ...args);
    }
  },
}));

vi.mock("../doctor/engine.js", () => ({
  runDoctor: state.runDoctor,
  renderDoctorReport: state.renderDoctorReport,
}));

describe("tui main loop28 entry coverage", () => {
  const priorArgv = process.argv;
  const priorExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    state.liveStop.mockClear();
    state.loadResolvedProfile.mockReset();
    state.saveProfile.mockReset();
    state.runDoctor.mockReset();
    state.renderDoctorReport.mockClear();
    state.client = createMockTuiClient();
    state.clientInstances = [];
    state.selectQueue = [];
    state.inputQueue = [];
    state.passwordQueue = [];
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.argv = priorArgv;
    process.exitCode = priorExitCode;
    vi.restoreAllMocks();
  });

  it("runs doctor mode with prompted token auth and JSON output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.passwordQueue = ["typed-token"];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "token",
        token: "",
      },
    });
    state.runDoctor.mockResolvedValue({
      summary: {
        exitCode: 1,
      },
    });
    process.argv = [
      "node",
      "main.ts",
      "--profile",
      "ops",
      "--gateway",
      "http://127.0.0.1:8788",
      "--read-only",
      "doctor",
      "--deep",
      "--yes",
      "--json",
      "--audit-only",
      "--no-repair",
    ];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.loadResolvedProfile).toHaveBeenCalledWith({
      profileName: "ops",
      gatewayOverride: "http://127.0.0.1:8788",
    });
    expect(state.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayBaseUrl: "http://127.0.0.1:8787",
        profileName: "ops",
        profilePath: "profile.json",
        readOnly: true,
        deep: true,
        yes: true,
        auditOnly: true,
        noRepair: true,
        authToken: "typed-token",
        authMode: "token",
      }),
    );
    await expect(state.runDoctor.mock.calls[0][0].promptConfirm("Repair gateway profile?")).resolves.toBe(true);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ summary: { exitCode: 1 } }, null, 2));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prompts for missing basic auth credentials before exiting the home menu", async () => {
    const clearSpy = vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.inputQueue = ["typed-user"];
    state.passwordQueue = ["typed-password"];
    state.selectQueue = ["exit"];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "basic",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
      },
      auth: {
        mode: "basic",
        username: "  ",
        password: "",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(clearSpy).toHaveBeenCalled();
    expect(state.runDoctor).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("drives dashboard, configured chat send, approval resolution, and local settings save", async () => {
    const clearSpy = vi.spyOn(console, "clear").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tableSpy = vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.selectQueue = [
      "chat",
      "create",
      "configure",
      "cowork",
      "deep",
      "on",
      "extended",
      "fast",
      "auto_when_useful",
      "0",
      "enable",
      "approvals",
      "pending",
      "approve",
      "settings",
      "save-local",
      "token",
      "exit",
    ];
    state.inputQueue = [
      "",
      "Loop 38 chat",
      "Summarize runtime health",
      "",
      "approval-1",
      "",
      "http://127.0.0.1:8789",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(clearSpy).toHaveBeenCalled();
    expect(state.client.dashboard).toHaveBeenCalledTimes(1);
    expect(state.client.devDiagnostics).toHaveBeenCalledWith(6);
    expect(state.client.googleMeetPrerequisites).toHaveBeenCalledTimes(1);
    expect(state.client.listChatSessions).toHaveBeenCalledWith({ limit: 60, view: "active" });
    expect(state.client.createChatSession).toHaveBeenCalledWith({ title: "Loop 38 chat" });
    expect(state.client.streamChatMessage).toHaveBeenCalledWith("session-created", {
      content: "Summarize runtime health",
      mode: "cowork",
      webMode: "deep",
      memoryMode: "on",
      thinkingLevel: "extended",
      speedMode: "fast",
      subagentPolicy: "auto_when_useful",
      agentMode: true,
    });
    expect(state.client.updateSkillState).toHaveBeenCalledWith("skill-browser-research", {
      state: "enabled",
      note: "Enabled from TUI capability suggestion.",
    });
    expect(state.client.listApprovals).toHaveBeenCalledWith("pending");
    expect(state.client.getApprovalReplay).toHaveBeenCalledWith("approval-1");
    expect(state.client.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
    expect(state.client.runtimeSettings).toHaveBeenCalledTimes(1);
    expect(state.saveProfile).toHaveBeenCalledWith("profile.json", {
      gatewayBaseUrl: "http://127.0.0.1:8789",
      authMode: "token",
      tokenQueryParam: "access_token",
      defaultScope: "operator",
      pollIntervalsMs: {
        dashboard: 5000,
        activity: 2500,
        approvals: 5000,
      },
      ui: {
        denseMode: false,
        confirmRiskyWrites: true,
        colorLevel: "auto",
      },
    });
    expect(writeSpy).toHaveBeenCalledWith("Hello");
    expect(tableSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Capability upgrade available"));
    expect(process.exitCode).toBeUndefined();
  });

  it("drives memory, files, cron, tools, and task write paths from the home menu", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "memory",
      "active",
      "patch",
      "files",
      "read",
      "cron",
      "retry-review",
      "tools",
      "create-grant",
      "allow",
      "session",
      "ttl",
      "tasks",
      "activity",
      "comment",
      "exit",
    ];
    state.inputQueue = [
      "",
      "ops",
      "runtime",
      "memory-1",
      "Updated title",
      "Updated content",
      "",
      "logs",
      "logs/runtime.log",
      "",
      "review-1",
      "",
      "browser.search",
      "session-1",
      "2026-05-16T00:00:00.000Z",
      "",
      "task-1",
      "Checked runtime",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.listMemoryItems).toHaveBeenCalledWith({
      namespace: "ops",
      query: "runtime",
      status: "active",
      limit: 120,
    });
    expect(state.client.patchMemoryItem).toHaveBeenCalledWith("memory-1", {
      title: "Updated title",
      content: "Updated content",
      pinned: true,
      ttlOverrideSeconds: null,
    });
    expect(state.client.listFiles).toHaveBeenCalledWith({ dir: "logs", limit: 250 });
    expect(state.client.downloadFile).toHaveBeenCalledWith("logs/runtime.log");
    expect(state.client.retryCronReviewItem).toHaveBeenCalledWith("review-1");
    expect(state.client.toolsCreateGrant).toHaveBeenCalledWith({
      toolPattern: "browser.search",
      decision: "allow",
      scope: "session",
      scopeRef: "session-1",
      grantType: "ttl",
      expiresAt: "2026-05-16T00:00:00.000Z",
    });
    expect(state.client.appendTaskActivity).toHaveBeenCalledWith("task-1", {
      activityType: "comment",
      message: "Checked runtime",
      agentId: "tui-operator",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("drives integration, mesh, npu, onboarding, and runtime budget updates", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "integrations",
      "create",
      "mesh",
      "acquire",
      "npu",
      "refresh",
      "onboarding",
      "bootstrap",
      "approve_risky",
      "power",
      "settings",
      "budget",
      "power",
      "exit",
    ];
    state.inputQueue = ["", "discord", "Discord Ops", "", "lease-1", "node-1", "45", "", "", "", ""];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.createIntegrationConnection).toHaveBeenCalledWith({
      catalogId: "discord",
      label: "Discord Ops",
      enabled: true,
      status: "connected",
      config: {},
    });
    expect(state.client.meshAcquireLease).toHaveBeenCalledWith({
      leaseKey: "lease-1",
      holderNodeId: "node-1",
      ttlSeconds: 45,
    });
    expect(state.client.npuRefresh).toHaveBeenCalledTimes(1);
    expect(state.client.onboardingBootstrap).toHaveBeenCalledWith({
      toolApprovalMode: "approve_risky",
      budgetMode: "power",
      markComplete: false,
      completedBy: "tui-operator",
    });
    expect(state.client.patchRuntimeSettings).toHaveBeenCalledWith({ budgetMode: "power" });
    expect(process.exitCode).toBeUndefined();
  });

  it("drives prompt lab, improvement, sessions, costs, skills, and system views", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "promptlab",
      "run-test",
      "improvement",
      "draft",
      "sessions",
      "costs",
      "day",
      "skills",
      "resolve",
      "system",
      "exit",
    ];
    state.inputQueue = [
      "",
      "pack-1",
      "test-1",
      "session-1",
      "",
      "run-1",
      '[{"field":"mode","value":"safe"}]',
      "",
      "",
      "",
      "Find browser skill",
      "",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.listPromptPacks).toHaveBeenCalledWith(80);
    expect(state.client.listPromptPackTests).toHaveBeenCalledWith("pack-1", 200);
    expect(state.client.runPromptPackTest).toHaveBeenCalledWith("pack-1", "test-1", {
      sessionId: "session-1",
    });
    expect(state.client.createReplayDraft).toHaveBeenCalledWith("run-1", [
      {
        field: "mode",
        value: "safe",
      },
    ]);
    expect(state.client.listSessions).toHaveBeenCalledWith(100);
    expect(state.client.listCosts).toHaveBeenCalledWith("day");
    expect(state.client.runCheaper).toHaveBeenCalledTimes(1);
    expect(state.client.resolveSkills).toHaveBeenCalledWith("Find browser skill");
    expect(state.client.systemVitals).toHaveBeenCalledTimes(1);
    expect(state.client.listEvents).toHaveBeenCalledWith(20);
    expect(process.exitCode).toBeUndefined();
  });

  it("drives alternate write and control actions across ops menu surfaces", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "memory",
      "forgotten",
      "forget-one",
      "files",
      "write",
      "cron",
      "run-diff",
      "tools",
      "evaluate",
      "tasks",
      "create",
      "urgent",
      "integrations",
      "toggle",
      "paused",
      "mesh",
      "renew",
      "npu",
      "refresh",
      "onboarding",
      "complete",
      "settings",
      "profile",
      "bypass",
      "exit",
    ];
    state.inputQueue = [
      "",
      "ops",
      "",
      "memory-1",
      "",
      ".",
      "notes/ops.txt",
      "ops note",
      "",
      "run-1",
      "",
      "fs.list",
      "agent-1",
      "session-1",
      "task-1",
      "",
      "New task",
      "Desc",
      "",
      "connection-1",
      "",
      "lease-1",
      "node-1",
      "7",
      "60",
      "",
      "",
      "",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.forgetMemoryItem).toHaveBeenCalledWith("memory-1");
    expect(state.client.uploadFile).toHaveBeenCalledWith("notes/ops.txt", "ops note");
    expect(state.client.getCronRunDiff).toHaveBeenCalledWith("run-1");
    expect(state.client.toolsEvaluateAccess).toHaveBeenCalledWith({
      toolName: "fs.list",
      agentId: "agent-1",
      sessionId: "session-1",
      taskId: "task-1",
    });
    expect(state.client.createTask).toHaveBeenCalledWith({
      title: "New task",
      description: "Desc",
      priority: "urgent",
    });
    expect(state.client.updateIntegrationConnection).toHaveBeenCalledWith("connection-1", {
      status: "paused",
      enabled: true,
    });
    expect(state.client.meshRenewLease).toHaveBeenCalledWith({
      leaseKey: "lease-1",
      holderNodeId: "node-1",
      fencingToken: 7,
      ttlSeconds: 60,
    });
    expect(state.client.npuStart).not.toHaveBeenCalled();
    expect(state.client.npuRefresh).toHaveBeenCalledTimes(1);
    expect(state.client.onboardingComplete).toHaveBeenCalledWith("tui-operator");
    expect(state.client.patchRuntimeSettings).toHaveBeenCalledWith({ toolApprovalMode: "bypass" });
    expect(process.exitCode).toBeUndefined();
  });

  it("drives batch memory, cron, tools, task, and skill alternates", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "memory",
      "active",
      "forget-many",
      "memory",
      "all",
      "history",
      "cron",
      "run",
      "cron",
      "start",
      "tools",
      "dry-run",
      "tasks",
      "update",
      "done",
      "skills",
      "reload",
      "exit",
    ];
    state.inputQueue = [
      "",
      "ops",
      "runtime",
      "memory-1, memory-2",
      "ops",
      "old",
      "",
      "",
      "",
      "memory-1",
      "",
      "job-1",
      "",
      "job-1",
      "",
      "fs.list",
      '{"path":"./workspace"}',
      "agent-1",
      "session-1",
      "",
      "",
      "task-1",
      "",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.forgetMemory).toHaveBeenCalledWith({
      itemIds: ["memory-1", "memory-2"],
      namespace: "ops",
      query: "old",
    });
    expect(state.client.listMemoryItemHistory).toHaveBeenCalledWith("memory-1", 80);
    expect(state.client.runCronJob).toHaveBeenCalledWith("job-1");
    expect(state.client.startCronJob).toHaveBeenCalledWith("job-1");
    expect(state.client.toolsInvoke).toHaveBeenCalledWith({
      toolName: "fs.list",
      args: {
        path: "./workspace",
      },
      agentId: "agent-1",
      sessionId: "session-1",
      taskId: undefined,
      dryRun: true,
      consentContext: {
        source: "tui",
        reason: "tools dry-run",
      },
    });
    expect(state.client.updateTask).toHaveBeenCalledWith("task-1", { status: "done" });
    expect(state.client.reloadSkills).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("drives prompt lab, improvement, mesh, integration, and NPU status alternates", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = [
      "promptlab",
      "benchmark-status",
      "promptlab",
      "replay-status",
      "promptlab",
      "benchmark",
      "promptlab",
      "report",
      "improvement",
      "manual-run",
      "improvement",
      "report",
      "improvement",
      "run",
      "improvement",
      "diff",
      "integrations",
      "delete",
      "mesh",
      "release",
      "mesh",
      "claim",
      "npu",
      "refresh",
      "npu",
      "refresh",
      "exit",
    ];
    state.inputQueue = [
      "",
      "benchmark-1",
      "",
      "replay-1",
      "",
      "pack-1",
      "runtime-health, routing",
      "",
      "pack-1",
      "",
      "5",
      "",
      "report-1",
      "",
      "run-1",
      "",
      "run-1",
      "",
      "connection-1",
      "",
      "lease-1",
      "node-1",
      "7",
      "",
      "session-1",
      "node-2",
      "2",
      "",
      "",
      "",
    ];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.getPromptPackBenchmark).toHaveBeenCalledWith("benchmark-1");
    expect(state.client.getPromptPackReplayRegression).toHaveBeenCalledWith("replay-1");
    expect(state.client.runPromptPackBenchmark).toHaveBeenCalledWith("pack-1", {
      testCodes: ["runtime-health", "routing"],
    });
    expect(state.client.getPromptPackReport).toHaveBeenCalledWith("pack-1");
    expect(state.client.runImprovementReplay).toHaveBeenCalledWith({ sampleSize: 5 });
    expect(state.client.getImprovementReport).toHaveBeenCalledWith("report-1");
    expect(state.client.getImprovementReplayRun).toHaveBeenCalledWith("run-1");
    expect(state.client.getReplayDiff).toHaveBeenCalledWith("run-1");
    expect(state.client.deleteIntegrationConnection).toHaveBeenCalledWith("connection-1");
    expect(state.client.meshReleaseLease).toHaveBeenCalledWith({
      leaseKey: "lease-1",
      holderNodeId: "node-1",
      fencingToken: 7,
    });
    expect(state.client.meshClaimSession).toHaveBeenCalledWith("session-1", {
      ownerNodeId: "node-2",
      minEpoch: 2,
    });
    expect(state.client.npuStop).not.toHaveBeenCalled();
    expect(state.client.npuRefresh).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it("opens an existing chat with quick send and patches session prefs", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.selectQueue = [
      "chat",
      "open",
      "session-existing",
      "quick",
      "skip",
      "chat",
      "prefs",
      "session-existing",
      "code",
      "off",
      "off",
      "deep",
      "fast",
      "off",
      "exit",
    ];
    state.inputQueue = ["", "Quick hello", "", ""];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.listChatMessages).toHaveBeenCalledWith("session-existing", 30);
    expect(state.client.streamChatMessage).toHaveBeenCalledWith("session-existing", {
      content: "Quick hello",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      agentMode: true,
    });
    expect(state.client.patchChatPrefs).toHaveBeenCalledWith("session-existing", {
      mode: "code",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "deep",
      speedMode: "fast",
      subagentPolicy: "off",
    });
    expect(writeSpy).toHaveBeenCalledWith("Hello");
    expect(process.exitCode).toBeUndefined();
  });

  it("opens the Code workspace inspector without mutating workbench state", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.selectQueue = ["code", "open", "session-existing", "exit"];
    state.inputQueue = [""];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts", "--read-only"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.listChatSessions).toHaveBeenCalledWith({ limit: 80, scope: "mission", view: "active" });
    expect(state.client.getChatWorkbench).toHaveBeenCalledWith("session-existing");
    expect(state.client.getChatWorkbenchDiff).toHaveBeenCalledWith("session-existing");
    expect(state.client.getChatWorkbenchOutput).toHaveBeenCalledWith("session-existing");
    expect(state.client.listCodeModeRuns).toHaveBeenCalledWith({
      sessionId: "session-existing",
      workspaceId: "workspace-code",
      limit: 10,
    });
    expect(state.client.createChatSession).not.toHaveBeenCalled();
    expect(state.client.patchChatPrefs).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("applies capability install and MCP template follow-ups from chat traces", async () => {
    vi.spyOn(console, "clear").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.selectQueue = [
      "chat",
      "open",
      "session-existing",
      "quick",
      "1",
      "install",
      "chat",
      "open",
      "session-existing",
      "quick",
      "2",
      "mcp",
      "exit",
    ];
    state.inputQueue = ["", "Install the filesystem helper", "", "Add the mcp template", ""];
    state.loadResolvedProfile.mockResolvedValue({
      profileName: "ops",
      filePath: "profile.json",
      profile: {
        gatewayBaseUrl: "http://127.0.0.1:8787",
        pollIntervalsMs: { activity: 10 },
      },
      auth: {
        mode: "none",
      },
    });
    process.argv = ["node", "main.ts"];

    await import("./main.js");
    await waitFor(() => state.liveStop.mock.calls.length === 1);

    expect(state.client.installSkillImport).toHaveBeenCalledWith({
      sourceRef: "local:fs-review",
      sourceProvider: "local",
      confirmHighRisk: true,
    });
    expect(state.client.fetchMcpTemplates).toHaveBeenCalledTimes(1);
    expect(state.client.createMcpServer).toHaveBeenCalledWith({
      label: "Filesystem Review",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      url: undefined,
      authType: "none",
      enabled: false,
      category: "filesystem",
      trustTier: "medium",
      costTier: "free",
      policy: {
        requiresApproval: true,
      },
    });
    expect(process.exitCode).toBeUndefined();
  });
});

function createMockTuiClient() {
  return {
    dashboard: vi.fn(async () => ({
      timestamp: "2026-05-15T12:00:00.000Z",
      pendingApprovals: 1,
      activeSubagents: 2,
      dailyCostUsd: 1.23456,
      sessions: [{ sessionId: "session-existing", title: "Existing chat" }],
      taskStatusCounts: [{ status: "running", count: 2 }],
      recentEvents: [
        {
          timestamp: "2026-05-15T12:00:00.000Z",
          eventType: "chat_thread_updated",
          source: "chat",
        },
      ],
    })),
    devDiagnostics: vi.fn(async () => ({
      items: [
        {
          runtimeKind: "discord",
          runtimeStatus: "healthy",
          message: "Discord bridge ready",
        },
      ],
    })),
    googleMeetPrerequisites: vi.fn(async () => ({
      state: "ready",
      provider: "google",
      prerequisites: [{ id: "oauth", ready: true, message: "Connected" }],
    })),
    listChatSessions: vi.fn(async () => ({
      items: [
        {
          sessionId: "session-existing",
          workspaceId: "workspace-code",
          title: "Existing chat",
          updatedAt: "2026-05-15T12:00:00.000Z",
          messageCount: 4,
        },
      ],
    })),
    fetchLlmConfig: vi.fn(async () => ({
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
    })),
    createChatSession: vi.fn(async () => ({
      sessionId: "session-created",
    })),
    listChatMessages: vi.fn(async () => ({
      items: [
        {
          role: "assistant",
          createdAt: "2026-05-15T12:00:00.000Z",
          content: "Prior answer",
        },
      ],
    })),
    streamChatMessage: vi.fn(async function* () {
      yield { type: "delta", delta: "Hello" };
      yield {
        type: "tool_start",
        toolRun: {
          toolName: "browser.search",
          status: "running",
        },
      };
      yield {
        type: "tool_result",
        toolRun: {
          toolName: "browser.search",
          status: "completed",
        },
      };
      yield {
        type: "trace_update",
        trace: {
          routing: {
            fallbackReason: "Provider fallback used.",
          },
          capabilityUpgradeSuggestions: [
            {
              title: "Browser research skill",
              summary: "Use a dedicated browser research skill.",
              reason: "The request used search-heavy routing.",
              recommendedAction: "enable_skill",
              riskLevel: "medium",
              candidateId: "skill-browser-research",
            },
            {
              title: "Filesystem review skill",
              summary: "Install a disabled local filesystem review skill.",
              reason: "The request needs structured file review.",
              recommendedAction: "install_skill_disabled",
              riskLevel: "high",
              sourceProvider: "local",
              sourceRef: "local:fs-review",
            },
            {
              title: "Filesystem MCP template",
              summary: "Add a disabled MCP template for filesystem review.",
              reason: "The request can use a local MCP server after approval.",
              recommendedAction: "add_mcp_template",
              riskLevel: "medium",
              sourceProvider: "mcp_template",
              candidateId: "mcp-fs-review",
            },
            {
              title: "Tool profile update",
              summary: "Open tool access before retrying.",
              reason: "The current profile blocks the requested tool.",
              recommendedAction: "switch_tool_profile",
              riskLevel: "low",
            },
          ],
        },
      };
      yield {
        type: "approval_required",
        approval: {
          approvalId: "approval-1",
          toolName: "browser.search",
          reason: "Needs review.",
        },
      };
      yield { type: "done" };
    }),
    patchChatPrefs: vi.fn(async (_sessionId: string, input: Record<string, unknown>) => input),
    getChatWorkbench: vi.fn(async () => ({
      state: {
        sessionId: "session-existing",
        baseRef: "main",
        worktreePath: "F:\\code\\personal-ai\\.worktrees\\session-existing",
        worktreeStatus: "ready",
        validationStatus: "passed",
      },
    })),
    getChatWorkbenchDiff: vi.fn(async () => ({
      changedFiles: ["src/app.ts"],
      summary: { changedFiles: 1, additions: 3, deletions: 1 },
      diff: "diff --git a/src/app.ts b/src/app.ts",
    })),
    getChatWorkbenchOutput: vi.fn(async () => ({
      output: "pnpm test passed",
      helperRuns: [{ runId: "run-1", status: "completed", language: "typescript" }],
    })),
    listCodeModeRuns: vi.fn(async () => ({
      items: [{ runId: "code-run-1", status: "completed", language: "typescript" }],
    })),
    updateSkillState: vi.fn(async (skillId: string) => ({ skillId })),
    installSkillImport: vi.fn(async () => ({ installedSkillId: "skill-fs-review" })),
    fetchMcpTemplates: vi.fn(async () => ({
      items: [
        {
          templateId: "mcp-fs-review",
          label: "Filesystem Review",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          authType: "none",
          enabledByDefault: false,
          category: "filesystem",
          trustTier: "medium",
          costTier: "free",
          policy: {
            requiresApproval: true,
          },
          installed: false,
        },
      ],
    })),
    createMcpServer: vi.fn(async (input: Record<string, unknown>) => ({ serverId: "mcp-server-1", ...input })),
    listApprovals: vi.fn(async () => ({
      items: [
        {
          approvalId: "approval-1",
          kind: "tool",
          riskLevel: "medium",
          status: "pending",
          explanationStatus: "ready",
          createdAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    getApprovalReplay: vi.fn(async () => ({
      approval: {
        approvalId: "approval-1",
        status: "pending",
      },
      events: [
        {
          timestamp: "2026-05-15T12:00:00.000Z",
          eventType: "created",
          actorId: "operator",
        },
      ],
    })),
    resolveApproval: vi.fn(async () => ({
      approval: {
        approvalId: "approval-1",
        status: "approved",
      },
    })),
    listMemoryItems: vi.fn(async () => ({
      items: [
        {
          itemId: "memory-1",
          namespace: "ops",
          title: "Runtime handoff",
          pinned: false,
          status: "active",
          updatedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    patchMemoryItem: vi.fn(async (itemId: string, patch: Record<string, unknown>) => ({
      itemId,
      ...patch,
    })),
    forgetMemoryItem: vi.fn(async (itemId: string) => ({ itemId, forgotten: true })),
    forgetMemory: vi.fn(async () => ({ forgotten: 2 })),
    listMemoryItemHistory: vi.fn(async () => ({
      items: [
        {
          eventId: "event-1",
          action: "created",
          actorId: "operator",
          createdAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    listFiles: vi.fn(async () => ({
      items: [
        {
          relativePath: "logs/runtime.log",
          size: 128,
          modifiedAt: "2026-05-15T12:00:00.000Z",
          directory: false,
        },
      ],
    })),
    downloadFile: vi.fn(async (relativePath: string) => ({
      relativePath,
      contentType: "text/plain",
      content: "runtime ready",
    })),
    uploadFile: vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      bytes: content.length,
    })),
    listCronJobs: vi.fn(async () => ({
      items: [
        {
          jobId: "job-1",
          name: "Daily review",
          schedule: "daily",
          enabled: true,
          lastRunAt: "2026-05-15T12:00:00.000Z",
          lastStatus: "ok",
        },
      ],
    })),
    listCronReviewQueue: vi.fn(async () => ({
      items: [
        {
          itemId: "review-1",
          status: "failed",
          severity: "warning",
          createdAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    retryCronReviewItem: vi.fn(async (itemId: string) => ({ itemId, status: "queued" })),
    getCronRunDiff: vi.fn(async (runId: string) => ({ runId, changes: [] })),
    runCronJob: vi.fn(async (jobId: string) => ({ jobId, status: "running" })),
    startCronJob: vi.fn(async (jobId: string) => ({ jobId, enabled: true })),
    pauseCronJob: vi.fn(async (jobId: string) => ({ jobId, enabled: false })),
    deleteCronJob: vi.fn(async (jobId: string) => ({ jobId, deleted: true })),
    toolsCatalog: vi.fn(async () => ({
      items: [
        {
          toolName: "browser.search",
          category: "browser",
          riskLevel: "medium",
          requiresApproval: true,
          pack: "core",
        },
      ],
    })),
    toolsListGrants: vi.fn(async () => ({
      items: [
        {
          grantId: "grant-1",
          toolPattern: "fs.list",
          decision: "allow",
          scope: "global",
          scopeRef: "",
          grantType: "persistent",
        },
      ],
    })),
    toolsEvaluateAccess: vi.fn(async () => ({ decision: "allow" })),
    toolsCreateGrant: vi.fn(async (grant: Record<string, unknown>) => ({ grantId: "grant-created", ...grant })),
    toolsRevokeGrant: vi.fn(async (grantId: string) => ({ grantId, revokedAt: "2026-05-15T12:00:00.000Z" })),
    toolsInvoke: vi.fn(async () => ({ dryRun: true, status: "ok" })),
    listTasks: vi.fn(async () => ({
      items: [
        {
          taskId: "task-1",
          status: "in_progress",
          priority: "high",
          title: "Ops review",
          assignedAgentId: "worker-gateway",
          updatedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    createTask: vi.fn(async () => ({ taskId: "task-created" })),
    updateTask: vi.fn(async () => ({ taskId: "task-1", status: "done" })),
    appendTaskActivity: vi.fn(async () => ({ activityId: "activity-1" })),
    integrationCatalog: vi.fn(async () => ({
      items: [
        {
          catalogId: "discord",
          kind: "channel",
          key: "discord",
          maturity: "stable",
        },
      ],
    })),
    integrationConnections: vi.fn(async () => ({
      items: [
        {
          connectionId: "connection-1",
          catalogId: "discord",
          label: "Discord Ops",
          status: "connected",
          enabled: true,
        },
      ],
    })),
    createIntegrationConnection: vi.fn(async (connection: Record<string, unknown>) => ({
      connectionId: "connection-created",
      ...connection,
    })),
    updateIntegrationConnection: vi.fn(async () => ({ connectionId: "connection-1", status: "paused" })),
    deleteIntegrationConnection: vi.fn(async (connectionId: string) => ({ connectionId, deleted: true })),
    meshStatus: vi.fn(async () => ({ nodeId: "node-1", role: "leader", healthy: true })),
    meshNodes: vi.fn(async () => ({ items: [{ nodeId: "node-1", status: "online" }] })),
    meshLeases: vi.fn(async () => ({ items: [{ leaseKey: "lease-1", holderNodeId: "node-1" }] })),
    meshOwners: vi.fn(async () => ({ items: [{ sessionId: "session-1", ownerNodeId: "node-1" }] })),
    meshReplicationOffsets: vi.fn(async () => ({ items: [{ stream: "events", offset: 42 }] })),
    meshAcquireLease: vi.fn(async (lease: Record<string, unknown>) => ({ acquired: true, ...lease })),
    meshRenewLease: vi.fn(async (lease: Record<string, unknown>) => ({ renewed: true, ...lease })),
    meshReleaseLease: vi.fn(async (lease: Record<string, unknown>) => ({ released: true, ...lease })),
    meshClaimSession: vi.fn(async (sessionId: string, claim: Record<string, unknown>) => ({ sessionId, ...claim })),
    npuStatus: vi.fn(async () => ({ state: "stopped", sidecarUrl: "http://127.0.0.1:11440" })),
    npuModels: vi.fn(async () => ({
      items: [
        {
          modelId: "retired-npu-sidecar",
          family: "other",
          source: "custom",
          default: false,
          enabled: false,
          requiresQnn: false,
        },
      ],
    })),
    npuStart: vi.fn(async () => ({ state: "running" })),
    npuStop: vi.fn(async () => ({ state: "stopped" })),
    npuRefresh: vi.fn(async () => ({ state: "refreshed" })),
    onboardingState: vi.fn(async () => ({
      completed: false,
      settings: {
        llm: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4-mini",
        },
        toolApprovalMode: "approve_risky",
        budgetMode: "balanced",
      },
      checklist: [
        {
          label: "Provider",
          status: "ready",
          detail: "OpenAI configured",
        },
      ],
    })),
    listLlmModels: vi.fn(async () => ({ items: [{ id: "gpt-5.4-mini" }] })),
    onboardingComplete: vi.fn(async () => ({
      state: {
        completed: true,
      },
    })),
    onboardingBootstrap: vi.fn(async () => ({ appliedAt: "2026-05-15T12:00:00.000Z" })),
    listPromptPacks: vi.fn(async () => ({
      items: [
        {
          packId: "pack-1",
          label: "Ops Pack",
          version: "1.0.0",
          testCount: 2,
          updatedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    getPromptPackBenchmark: vi.fn(async (benchmarkRunId: string) => ({ benchmarkRunId, status: "completed" })),
    getPromptPackReplayRegression: vi.fn(async (runId: string) => ({ runId, status: "completed" })),
    listPromptPackTests: vi.fn(async () => ({
      items: [
        {
          testId: "test-1",
          code: "runtime-health",
          category: "ops",
          title: "Runtime health",
        },
      ],
    })),
    runPromptPackTest: vi.fn(async (packId: string, testId: string) => ({ packId, testId, status: "queued" })),
    runPromptPackBenchmark: vi.fn(async (packId: string) => ({ packId, benchmarkRunId: "benchmark-1" })),
    getPromptPackReport: vi.fn(async (packId: string) => ({ packId, summary: "ready" })),
    runPromptPackReplayRegression: vi.fn(async (packId: string) => ({ packId, runId: "replay-1" })),
    getPromptPackTrends: vi.fn(async (packId: string) => ({ packId, trends: [] })),
    listImprovementReports: vi.fn(async () => ({
      items: [
        {
          reportId: "report-1",
          status: "ready",
          createdAt: "2026-05-15T12:00:00.000Z",
          summary: "Runtime stable",
        },
      ],
    })),
    listImprovementReplayRuns: vi.fn(async () => ({
      items: [
        {
          runId: "run-1",
          status: "completed",
          startedAt: "2026-05-15T12:00:00.000Z",
          score: 0.9,
        },
      ],
    })),
    runImprovementReplay: vi.fn(async () => ({ runId: "run-manual", status: "queued" })),
    getImprovementReport: vi.fn(async (reportId: string) => ({ reportId, status: "ready" })),
    getImprovementReplayRun: vi.fn(async (runId: string) => ({ runId, status: "completed" })),
    createReplayDraft: vi.fn(async (runId: string, overrides: Array<Record<string, unknown>>) => ({
      runId,
      overrides,
      draftId: "draft-1",
    })),
    executeReplayOverride: vi.fn(async (runId: string, overrides: Array<Record<string, unknown>>) => ({
      runId,
      overrides,
      executed: true,
    })),
    getReplayDiff: vi.fn(async (runId: string) => ({ runId, diff: [] })),
    listSessions: vi.fn(async () => ({
      items: [
        {
          sessionId: "session-1",
          kind: "chat",
          health: "healthy",
          tokenTotal: 100,
          costUsdTotal: 0.25,
          updatedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
    })),
    listCosts: vi.fn(async () => ({ items: [{ key: "2026-05-15", tokenTotal: 100, costUsd: 0.25 }] })),
    listMemoryQmdStats: vi.fn(async () => ({
      totalRuns: 3,
      savingsPercent: 12.5,
      originalTokenEstimate: 1000,
      distilledTokenEstimate: 875,
    })),
    runCheaper: vi.fn(async () => ({ mode: "saver", actions: ["reduced default model"] })),
    listSkills: vi.fn(async () => ({
      items: [
        {
          skillId: "skill-browser-research",
          name: "Browser Research",
          source: "local",
          declaredTools: ["browser.search"],
        },
      ],
    })),
    reloadSkills: vi.fn(async () => ({ items: [{ skillId: "skill-browser-research" }] })),
    resolveSkills: vi.fn(async (text: string) => ({ text, activated: ["skill-browser-research"] })),
    systemVitals: vi.fn(async () => ({
      uptimeSeconds: 123,
      memoryRssBytes: 1024,
      activeHandles: 2,
    })),
    listEvents: vi.fn(async () => ({
      items: [
        {
          timestamp: "2026-05-15T12:00:00.000Z",
          eventType: "runtime.ready",
          source: "gateway",
        },
      ],
    })),
    runtimeSettings: vi.fn(async () => ({
      budgetMode: "balanced",
      toolApprovalMode: "approve_risky",
      npu: {
        enabled: false,
        autoStart: false,
        sidecarUrl: "http://127.0.0.1:11440",
      },
    })),
    patchRuntimeSettings: vi.fn(async () => ({ ok: true })),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for TUI main import to settle");
}
