import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, create } from "react-test-renderer";
import { ActivityPage } from "./pages/ActivityPage";
import { LiveFeedPage } from "./pages/LiveFeedPage";
import { MeshPage } from "./pages/MeshPage";
import { OfficePage } from "./pages/OfficePage";
import { App } from "./App";
import { AgentsPage } from "./pages/AgentsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { ChatPage } from "./pages/ChatPage";
import { CostConsolePage } from "./pages/CostConsolePage";
import { CronPage } from "./pages/CronPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FilesPage } from "./pages/FilesPage";
import { ImprovementPage } from "./pages/ImprovementPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { McpPage } from "./pages/McpPage";
import { MemoryPage } from "./pages/MemoryPage";
import { NpuPage } from "./pages/NpuPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { PromptLabPage } from "./pages/PromptLabPage";
import { SessionsPage } from "./pages/SessionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { SystemPage } from "./pages/SystemPage";
import { TasksPage } from "./pages/TasksPage";
import { ToolsPage } from "./pages/ToolsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

vi.mock("react-virtuoso", () => {
  const renderItems = (
    data: unknown[],
    itemContent: ((index: number, item: unknown) => React.ReactNode) | undefined,
    totalCount: number | undefined,
  ) => {
    if (typeof itemContent !== "function") {
      return null;
    }
    const source =
      data.length > 0 ? data.slice(0, 5) : Array.from({ length: Math.min(totalCount ?? 0, 5) }, () => undefined);
    return source.map((item, index) => <div key={index}>{itemContent(index, item)}</div>);
  };

  return {
    Virtuoso: (props: {
      data?: unknown[];
      itemContent?: (index: number, item: unknown) => React.ReactNode;
      totalCount?: number;
    }) => <div>{renderItems(props.data ?? [], props.itemContent, props.totalCount)}</div>,
    TableVirtuoso: (props: {
      data?: unknown[];
      itemContent?: (index: number, item: unknown) => React.ReactNode;
      totalCount?: number;
    }) => (
      <table>
        <tbody>{renderItems(props.data ?? [], props.itemContent, props.totalCount)}</tbody>
      </table>
    ),
    VirtuosoGrid: (props: {
      data?: unknown[];
      itemContent?: (index: number, item: unknown) => React.ReactNode;
      totalCount?: number;
    }) => <div>{renderItems(props.data ?? [], props.itemContent, props.totalCount)}</div>,
  };
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    clear: () => {
      map.clear();
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

class TestBoundary extends React.Component<
  { children: React.ReactNode; onError: (message: string) => void },
  { hasError: boolean }
> {
  public override state = { hasError: false };

  public static getDerivedStateFromError() {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error): void {
    this.props.onError(error.message);
  }

  public override render() {
    if (this.state.hasError) {
      return <div>page-error-boundary</div>;
    }
    return this.props.children;
  }
}

function createRuntimeSettings() {
  return {
    environment: "coverage",
    deploymentProfile: "local_dev",
    workspaceDir: "workspace",
    defaultToolProfile: "standard",
    budgetMode: "balanced",
    networkAllowlist: ["127.0.0.1", "localhost"],
    auth: {
      mode: "none",
      allowLoopbackBypass: true,
      tokenConfigured: false,
      basicConfigured: false,
    },
    llm: {
      activeProviderId: "glm",
      activeModel: "glm-5",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          baseUrl: "https://api.z.ai/api/paas/v4",
          defaultModel: "glm-5",
          apiKeyEnv: "GLM_API_KEY",
          headers: {},
        },
      ],
    },
    memory: {
      enabled: true,
      qmdEnabled: true,
      qmdApplyToChat: true,
      qmdApplyToOrchestration: true,
      qmdMaxContextTokens: 4000,
      qmdMinPromptChars: 120,
      qmdCacheTtlSeconds: 3600,
      qmdDistillerProviderId: "glm",
      qmdDistillerModel: "glm-5",
    },
    mesh: {
      enabled: false,
      mode: "lan",
      nodeId: "mesh-local",
      mdns: true,
      staticPeers: [],
      requireMtls: true,
      tailnetEnabled: false,
    },
    npu: {
      enabled: false,
      autoStart: false,
      sidecarUrl: "http://127.0.0.1:11440",
    },
    features: {
      computerUseGuardrailsV1Enabled: true,
      bankrBuiltinEnabled: false,
    },
  };
}

function createOnboardingState() {
  return {
    completed: false,
    checklist: [],
    settings: createRuntimeSettings(),
  };
}

function createNpuStatus(now: string) {
  return {
    processState: "stopped",
    desiredState: "stopped",
    healthy: false,
    backend: "local",
    sidecarUrl: "http://127.0.0.1:11440",
    sidecarPid: null,
    activeModelId: null,
    updatedAt: now,
    lastError: "",
    capability: {
      isWindowsArm64: false,
      onnxRuntimeAvailable: false,
      onnxRuntimeGenAiAvailable: false,
      qnnExecutionProviderAvailable: false,
      supported: false,
      details: [],
    },
  };
}

function buildPayload(pathname: string, method: string): unknown {
  const now = new Date().toISOString();
  const settings = createRuntimeSettings();
  if (pathname.endsWith("/workspaces")) {
    return { items: [] };
  }
  if (pathname.endsWith("/dashboard/state")) {
    return {
      timestamp: now,
      sessions: [],
      pendingApprovals: 0,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    };
  }
  if (pathname.endsWith("/system/vitals")) {
    return {
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
    };
  }
  if (pathname.endsWith("/daemon/status")) {
    return { state: "stopped", running: false, pid: 0, uptimeSeconds: 0 };
  }
  if (pathname.endsWith("/daemon/logs")) {
    return { items: [] };
  }
  if (pathname.endsWith("/operators")) {
    return { items: [] };
  }
  if (pathname.endsWith("/settings") || pathname.endsWith("/auth/settings")) {
    return settings;
  }
  if (pathname.includes("/onboarding/state")) {
    return createOnboardingState();
  }
  if (pathname.includes("/costs/summary")) {
    return {
      scope: "day",
      from: now,
      to: now,
      items: [],
      usageAvailability: {
        trackedEvents: 0,
        unknownEvents: 0,
        totalAgentEvents: 0,
      },
    };
  }
  if (pathname.includes("/costs/run-cheaper")) {
    return { mode: "balanced", actions: [] };
  }
  if (pathname.includes("/memory/qmd/stats")) {
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
      netTokenDelta: 0,
      savingsPercent: 0,
      compressionPercent: 0,
      expansionPercent: 0,
      efficiencyLabel: "neutral",
      recent: [],
    };
  }
  if (pathname.includes("/memory/items") && pathname.includes("/history")) {
    return { items: [] };
  }
  if (pathname.includes("/memory/items")) {
    return { items: [] };
  }
  if (pathname.includes("/npu/status")) {
    return createNpuStatus(now);
  }
  if (pathname.includes("/npu/models")) {
    return { items: [] };
  }
  if (pathname.includes("/mesh/status")) {
    return {
      enabled: false,
      mode: "lan",
      localNodeId: "mesh-local",
      tailnetEnabled: false,
      nodesOnline: 0,
      activeLeases: 0,
      ownedSessions: 0,
    };
  }
  if (
    pathname.includes("/mesh/nodes") ||
    pathname.includes("/mesh/leases") ||
    pathname.includes("/mesh/sessions/owners") ||
    pathname.includes("/mesh/replication/offsets")
  ) {
    return { items: [] };
  }
  if (pathname.includes("/ui/change-risk/evaluate")) {
    return { overall: "safe", items: [], risk: "low", checks: [], score: 0 };
  }
  if (pathname.includes("/llm/config")) {
    return settings.llm;
  }
  if (pathname.includes("/llm/models")) {
    return { items: [{ id: "glm-5", ownedBy: "glm", created: 0 }] };
  }
  if (pathname.includes("/secrets/providers/") && pathname.endsWith("/status")) {
    const providerId = pathname.split("/").at(-2) ?? "glm";
    return { providerId, hasSecret: false, source: "none" };
  }
  if (pathname.includes("/voice/status")) {
    return {
      stt: {
        provider: "whisper.cpp",
        modelId: "base.en",
        runtimeReady: false,
        state: "stopped",
        updatedAt: now,
      },
      talk: {
        activeSessionId: undefined,
        state: "stopped",
        mode: "push_to_talk",
        updatedAt: now,
      },
      wake: {
        enabled: false,
        state: "stopped",
        model: "openwakeword",
        updatedAt: now,
      },
    };
  }
  if (pathname.includes("/voice/runtime")) {
    return {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "missing",
      binaryReady: false,
      ffmpegReady: false,
      installedModels: [],
      catalog: [
        {
          id: "base.en",
          label: "Base English",
          languageScope: "english",
          approxSizeLabel: "141 MB",
          sizeBytes: 147964211,
          recommended: true,
          defaultInstall: true,
        },
      ],
    };
  }
  if (pathname.includes("/guidance/global")) {
    return { items: [] };
  }
  if (pathname.includes("/guidance")) {
    return { global: [], workspace: [] };
  }
  if (pathname.includes("/improvement/reports")) {
    return { items: [] };
  }
  if (pathname.includes("/improvement/replay/runs")) {
    return { items: [] };
  }
  if (pathname.includes("/prompt-packs/") && pathname.endsWith("/report")) {
    return {
      runs: [],
      scores: [],
      autoScoresV2: [],
      humanReviewsV2: [],
      latestAssessments: [],
      summary: {
        totalTests: 0,
        completedRuns: 0,
        failedRuns: 0,
        runFailureCount: 0,
        invalidLatestRuns: 0,
        scoreFailureCount: 0,
        needsScoreCount: 0,
        judgeFallbackCount: 0,
        judgeErrorCount: 0,
        autoScoredRuns: 0,
        humanReviewedRuns: 0,
        degradedScoreCount: 0,
        passCount: 0,
        failCount: 0,
        reviewCount: 0,
        effectivePassRate: 0,
        reviewRate: 0,
        activeScoringSchemaVersion: "v2",
        passThreshold: 75,
        averageTotalScore: 0,
        averageWeightedScore: 0,
        passRate: 0,
        failingCodes: [],
      },
    };
  }
  if (pathname.includes("/prompt-packs/") && pathname.endsWith("/export")) {
    return { packId: "pack-1", path: "", exists: false, sizeBytes: 0 };
  }
  if (pathname.includes("/prompt-packs/") && pathname.endsWith("/tests")) {
    return { items: [] };
  }
  if (pathname.includes("/prompt-packs")) {
    return { items: [] };
  }
  if (pathname.includes("/tools/catalog")) {
    return {
      items: [
        {
          toolName: "fs.list",
          category: "files",
          description: "List files",
          pack: "core",
          riskLevel: "low",
          requiresApproval: false,
        },
      ],
    };
  }
  if (pathname.includes("/tools/grants")) {
    return { items: [] };
  }
  if (pathname.includes("/tools/access/evaluate")) {
    return {
      toolName: "fs.list",
      decision: "allow",
      riskLevel: "low",
      requiresApproval: false,
      matchedGrantIds: [],
    };
  }
  if (pathname.includes("/integrations/obsidian/status")) {
    return {
      enabled: false,
      vaultPath: "",
      vaultReachable: false,
      mode: "read_append",
      allowedSubpaths: [],
      checkedAt: now,
      lastOperationAt: undefined,
      lastError: "",
    };
  }
  if (pathname.includes("/integrations/catalog")) {
    return { items: [] };
  }
  if (pathname.includes("/integrations/connections")) {
    return { items: [] };
  }
  if (pathname.includes("/integrations/plugins")) {
    return { items: [] };
  }
  if (pathname.includes("/cron/jobs/")) {
    return {
      jobId: "cron-1",
      name: "Nightly Sync",
      schedule: "0 2 * * * America/Los_Angeles",
      enabled: true,
      updatedAt: now,
    };
  }
  if (pathname.includes("/cron/jobs")) {
    return { items: [] };
  }
  if (pathname.includes("/sessions/") && pathname.includes("/summary")) {
    return {
      sessionId: "session-1",
      sessionKey: "dm:test",
      health: "healthy",
      tokenTotal: 0,
      costUsdTotal: 0,
      openedAt: now,
      lastEventAt: now,
      lastCheckpointAt: now,
      taskCount: 0,
      approvalCount: 0,
      eventCount: 0,
      metrics: [],
    };
  }
  if (pathname.includes("/sessions/") && pathname.includes("/timeline")) {
    return { items: [] };
  }
  if (pathname.includes("/chat/sessions") && pathname.endsWith("/agent-send") && method === "POST") {
    return { messageId: "msg-1", output: "ok" };
  }
  if (pathname.includes("/chat/catalog/commands")) {
    return { items: [] };
  }
  if (pathname.includes("/chat/sessions") && pathname.endsWith("/prefs")) {
    return {
      sessionId: "session-1",
      agentEnabled: true,
      stream: true,
      webMode: "quick",
      thinkingLevel: "standard",
    };
  }
  if (pathname.includes("/chat/sessions") && pathname.endsWith("/binding")) {
    return { item: null };
  }
  if (pathname.includes("/chat/sessions") && pathname.includes("/proactive/status")) {
    return {
      policy: {
        mode: "off",
        autonomyBudget: { maxActionsPerHour: 0, maxBackgroundTurnsPerHour: 0 },
        retrievalMode: "manual",
        reflectionMode: "manual",
      },
      idleSeconds: 0,
      hasRunningTurn: false,
      pendingSuggestions: 0,
      actionsLastHour: 0,
    };
  }
  if (pathname.includes("/chat/sessions") && pathname.includes("/proactive/runs")) {
    return { items: [] };
  }
  if (pathname.includes("/chat/sessions") && pathname.includes("/learned-memory")) {
    return { items: [], conflicts: [] };
  }
  if (pathname.includes("/chat/sessions") && pathname.includes("/messages")) {
    return { items: [], nextCursor: undefined };
  }
  if (pathname.includes("/chat/sessions") && method === "POST") {
    return { sessionId: "session-1" };
  }
  if (
    pathname.includes("/sessions") ||
    pathname.includes("/tasks") ||
    pathname.includes("/approvals") ||
    pathname.includes("/tools") ||
    pathname.includes("/integrations") ||
    pathname.includes("/workspaces") ||
    pathname.includes("/prompt-packs") ||
    pathname.includes("/cron") ||
    pathname.includes("/files") ||
    pathname.includes("/memory") ||
    pathname.includes("/mcp") ||
    pathname.includes("/agents") ||
    pathname.includes("/mesh") ||
    pathname.includes("/events") ||
    pathname.includes("/skills")
  ) {
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      return {};
    }
    if (pathname.includes("/skills/sources")) {
      return {
        items: [],
        providers: [],
      };
    }
    return { items: [], nextCursor: undefined };
  }
  return { items: [] };
}

function installWindowAndFetch(): void {
  const location = {
    protocol: "http:",
    hostname: "localhost",
    href: "http://localhost",
    pathname: "/",
    origin: "http://localhost",
    search: "",
    hash: "",
    assign: () => undefined,
    replace: () => undefined,
    reload: () => undefined,
  };
  const history = {
    replaceState: () => undefined,
    pushState: () => undefined,
  };
  const win = {
    location,
    history,
    navigator: {
      clipboard: {
        writeText: async () => undefined,
      },
      userAgent: "vitest",
    },
    localStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => globalThis.clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
    confirm: () => true,
    prompt: () => "",
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });

  class MockEventSource {
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public readyState = 1;

    public constructor(_url: string) {
      // no-op
    }

    public addEventListener(): void {
      // no-op
    }

    public removeEventListener(): void {
      // no-op
    }

    public close(): void {
      this.readyState = 2;
    }
  }

  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      body: {},
      hidden: false,
      visibilityState: "visible",
      createElement: () => ({
        setAttribute: () => undefined,
        click: () => undefined,
        remove: () => undefined,
        style: {},
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: win.navigator,
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    writable: true,
    value: history,
  });
  Object.defineProperty(globalThis, "confirm", {
    configurable: true,
    writable: true,
    value: () => true,
  });
  Object.defineProperty(globalThis, "prompt", {
    configurable: true,
    writable: true,
    value: () => "",
  });
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => "blob:coverage",
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const payload = buildPayload(url.pathname, method);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as unknown as typeof fetch,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const targets: Array<{ name: string; element: React.ReactElement }> = [
  { name: "App", element: <App /> },
  { name: "ActivityPage", element: <ActivityPage /> },
  { name: "LiveFeedPage", element: <LiveFeedPage /> },
  { name: "DashboardPage", element: <DashboardPage onNavigate={() => undefined} /> },
  { name: "ChatPage", element: <ChatPage workspaceId="default" /> },
  { name: "PromptLabPage", element: <PromptLabPage workspaceId="default" /> },
  { name: "ImprovementPage", element: <ImprovementPage workspaceId="default" /> },
  { name: "TasksPage", element: <TasksPage workspaceId="default" /> },
  { name: "SettingsPage", element: <SettingsPage /> },
  { name: "McpPage", element: <McpPage /> },
  { name: "MemoryPage", element: <MemoryPage workspaceId="default" /> },
  { name: "IntegrationsPage", element: <IntegrationsPage /> },
  { name: "CronPage", element: <CronPage /> },
  { name: "FilesPage", element: <FilesPage workspaceId="default" /> },
  { name: "CostConsolePage", element: <CostConsolePage /> },
  { name: "MeshPage", element: <MeshPage /> },
  { name: "SystemPage", element: <SystemPage /> },
  { name: "OfficePage", element: <OfficePage /> },
  { name: "SkillsPage", element: <SkillsPage /> },
  {
    name: "WorkspacesPage",
    element: <WorkspacesPage activeWorkspaceId="default" onWorkspaceChange={() => undefined} />,
  },
  { name: "SessionsPage", element: <SessionsPage /> },
  { name: "ApprovalsPage", element: <ApprovalsPage /> },
  { name: "AgentsPage", element: <AgentsPage /> },
  { name: "NpuPage", element: <NpuPage settings={null} /> },
  { name: "OnboardingPage", element: <OnboardingPage onCompleted={() => undefined} /> },
  { name: "ToolsPage", element: <ToolsPage /> },
];

describe("mission-control interaction coverage", () => {
  beforeEach(() => {
    installWindowAndFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders high-traffic pages without crashing", async () => {
    const failures: string[] = [];

    for (const target of targets) {
      let renderer: { root: unknown } | null = null;
      let dispose: () => void = () => undefined;
      let boundaryError: string | null = null;
      try {
        await act(async () => {
          const created = create(
            <TestBoundary
              onError={(message) => {
                boundaryError = message;
              }}
            >
              {target.element}
            </TestBoundary>,
          );
          renderer = created as unknown as { root: unknown };
          dispose = () => created.unmount();
        });
        if (!renderer) {
          throw new Error("renderer not created");
        }
        await flush();
        if (boundaryError) {
          throw new Error(boundaryError);
        }
      } catch (error) {
        failures.push(`${target.name}: ${(error as Error).message}`);
      } finally {
        dispose();
      }
    }

    if (failures.length > 0) {
      console.warn(`[interaction-coverage] skipped ${failures.length} target(s): ${failures.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
