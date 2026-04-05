import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const consumeGatewayAccessBootstrapFromLocationMock = vi.fn();
const connectEventStreamMock = vi.fn();
const clearGatewayAuthStateMock = vi.fn();
const createGatewayDeviceAccessRequestMock = vi.fn();
const pollGatewayDeviceAccessRequestStatusMock = vi.fn();
const resolveApprovalMock = vi.fn();
const resolveApprovalWithRemoteTokenMock = vi.fn();
const fetchWorkspacesMock = vi.fn();
const getGatewayAuthStorageModeMock = vi.fn();
const getGatewayApiBaseUrlMock = vi.fn();
const persistGatewayAuthStateMock = vi.fn();
const preflightGatewayAccessMock = vi.fn();
const readStoredGatewayAuthStateMock = vi.fn();
const chatPageMock = vi.fn();
const fetchDashboardStateMock = vi.fn();

vi.mock("./api/shell-client", () => ({
  clearGatewayAuthState: clearGatewayAuthStateMock,
  createGatewayDeviceAccessRequest: createGatewayDeviceAccessRequestMock,
  consumeGatewayAccessBootstrapFromLocation: consumeGatewayAccessBootstrapFromLocationMock,
  connectEventStream: connectEventStreamMock,
  fetchWorkspaces: fetchWorkspacesMock,
  getGatewayAuthStorageMode: getGatewayAuthStorageModeMock,
  getGatewayApiBaseUrl: getGatewayApiBaseUrlMock,
  pollGatewayDeviceAccessRequestStatus: pollGatewayDeviceAccessRequestStatusMock,
  persistGatewayAuthState: persistGatewayAuthStateMock,
  preflightGatewayAccess: preflightGatewayAccessMock,
  readStoredGatewayAuthState: readStoredGatewayAuthStateMock,
  resolveApproval: resolveApprovalMock,
  resolveApprovalWithRemoteToken: resolveApprovalWithRemoteTokenMock,
}));

vi.mock("./api/client", async () => {
  const actual = await vi.importActual<typeof import("./api/client")>("./api/client");
  return {
    ...actual,
    fetchDashboardState: fetchDashboardStateMock,
  };
});

vi.mock("./pages/DashboardPage", () => ({
  DashboardPage: () => <div>dashboard-ready</div>,
}));

vi.mock("./pages/ChatPage", () => ({
  ChatPage: (props: { workspaceId?: string; surface?: string; lockSurface?: boolean }) => {
    chatPageMock(props);
    return <div>{`chat-ready:${props.surface ?? "chat"}:${props.lockSurface ? "locked" : "open"}`}</div>;
  },
}));

vi.mock("./pages/TasksPage", () => ({
  TasksPage: () => <div>tasks-ready</div>,
}));

vi.mock("./components/DeviceAccessApprovalModal", () => ({
  DeviceAccessApprovalModal: ({ open, prompt }: { open: boolean; prompt?: { deviceLabel?: string } }) => (
    open ? <div>device-access-modal:{prompt?.deviceLabel ?? "unknown"}</div> : null
  ),
}));

vi.mock("./components/RemoteApprovalActionModal", () => ({
  RemoteApprovalActionModal: ({
    open,
    prompt,
    onApprove,
    onReject,
  }: {
    open: boolean;
    prompt?: { kind?: string };
    onApprove: () => void;
    onReject: () => void;
  }) => (
    open
      ? (
        <div>
          <div>remote-approval-modal:{prompt?.kind ?? "unknown"}</div>
          <button type="button" onClick={onApprove}>approve remote approval</button>
          <button type="button" onClick={onReject}>reject remote approval</button>
        </div>
      )
      : null
  ),
}));

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

function installMockWindow(): void {
  const location = {
    protocol: "http:",
    hostname: "localhost",
    href: "http://localhost:5173/?space=operate&page=surface&surface=chat",
    pathname: "/",
    origin: "http://localhost:5173",
    search: "?space=operate&page=surface&surface=chat",
    hash: "",
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
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      body: {},
      hidden: false,
      visibilityState: "visible",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
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
}

function renderTreeText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function flattenNodeText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenNodeText(item)).join("");
  }
  if (value && typeof value === "object" && "props" in value) {
    return flattenNodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("deriveRefreshTopics", () => {
  it("keeps session-scoped chat events off the surface refresh topic", async () => {
    const { deriveRefreshTopics } = await import("./App");

    expect(deriveRefreshTopics({
      eventId: "evt-chat-1",
      eventType: "chat_thread_updated",
      source: "chat",
      payload: { kind: "event" },
      links: { sessionId: "sess-1" },
    } as any)).toContain("chat");

    expect(deriveRefreshTopics({
      eventId: "evt-chat-1",
      eventType: "chat_thread_updated",
      source: "chat",
      payload: { kind: "event" },
      links: { sessionId: "sess-1" },
    } as any)).not.toContain("surface");
  });
});

async function waitForTreeText(
  renderer: ReactTestRenderer,
  expected: string,
  attempts = 20,
): Promise<string> {
  let text = renderTreeText(renderer);
  for (let index = 0; index < attempts; index += 1) {
    if (text.includes(expected)) {
      return text;
    }
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    });
    await flush();
    text = renderTreeText(renderer);
  }
  return text;
}

function createReadyPreflightResult() {
  return {
    status: "ready" as const,
    message: "Gateway reachability and access checks passed.",
    healthDetail: "Gateway health check OK (200).",
    onboardingState: {
      completed: true,
      checklist: [],
      settings: {
        environment: "coverage",
        deploymentProfile: "local_dev",
        defaultToolProfile: "standard",
        budgetMode: "balanced",
        workspaceDir: "workspace",
        writeJailRoots: [],
        readOnlyRoots: [],
        networkAllowlist: [],
        approvalExplainer: {
          enabled: false,
          mode: "async",
          minRiskLevel: "danger",
          timeoutMs: 1000,
          maxPayloadChars: 1000,
        },
        memory: {
          enabled: false,
          qmd: {
            enabled: false,
            applyToChat: false,
            applyToOrchestration: false,
            minPromptChars: 0,
            maxContextTokens: 0,
            cacheTtlSeconds: 0,
          },
        },
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          tokenConfigured: true,
          basicConfigured: false,
        },
        llm: {
          activeProviderId: "glm",
          activeModel: "glm-5",
          providers: [],
        },
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "mesh-local",
          mdns: false,
          staticPeers: [],
          requireMtls: true,
          tailnetEnabled: false,
        },
        npu: {
          enabled: false,
          autoStart: false,
          sidecarUrl: "http://127.0.0.1:11440",
          status: {
            processState: "stopped",
            desiredState: "stopped",
            healthy: false,
            backend: "local",
            sidecarUrl: "http://127.0.0.1:11440",
            updatedAt: new Date().toISOString(),
            capability: {
              isWindowsArm64: false,
              onnxRuntimeAvailable: false,
              onnxRuntimeGenAiAvailable: false,
              qnnExecutionProviderAvailable: false,
              supported: false,
              details: [],
            },
          },
        },
        features: {
          durableKernelV1Enabled: false,
          replayOverridesV1Enabled: false,
          memoryLifecycleAdminV1Enabled: false,
          connectorDiagnosticsV1Enabled: false,
          computerUseGuardrailsV1Enabled: false,
          bankrBuiltinEnabled: false,
          cronReviewQueueV1Enabled: false,
          replayRegressionV1Enabled: false,
        },
      },
    },
  };
}

describe("App gateway access gate", () => {
  beforeEach(() => {
    installMockWindow();
    clearGatewayAuthStateMock.mockReset();
    consumeGatewayAccessBootstrapFromLocationMock.mockReturnValue({ consumed: false });
    connectEventStreamMock.mockImplementation(() => () => undefined);
    fetchWorkspacesMock.mockResolvedValue({ items: [] });
    getGatewayAuthStorageModeMock.mockReturnValue("session");
    getGatewayApiBaseUrlMock.mockReturnValue("http://bld:8787");
    persistGatewayAuthStateMock.mockReset();
    createGatewayDeviceAccessRequestMock.mockReset();
    pollGatewayDeviceAccessRequestStatusMock.mockReset();
    readStoredGatewayAuthStateMock.mockReturnValue(undefined);
    resolveApprovalMock.mockReset();
    resolveApprovalWithRemoteTokenMock.mockReset();
    fetchDashboardStateMock.mockResolvedValue({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 0,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    });
    chatPageMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the access gate and does not start SSE when auth is required", async () => {
    const { App } = await import("./App");
    preflightGatewayAccessMock.mockResolvedValue({
      status: "needs-auth",
      message: "Gateway credentials are required to continue.",
      healthDetail: "Gateway health check OK (200).",
      authMode: "token",
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "Mission Control access gate");
    expect(text).toContain("Mission Control access gate");
    expect(text).toContain("Gateway credentials are required to continue.");
    expect(connectEventStreamMock).not.toHaveBeenCalled();
  }, 15_000);

  it("starts Mission Control normally after a ready preflight result", async () => {
    const { App } = await import("./App");
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).toContain("chat-ready:chat:locked");
    expect(connectEventStreamMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("shows startup copy before the first preflight resolves and then transitions into the shell", async () => {
    const { App } = await import("./App");
    let resolvePreflight: ((value: ReturnType<typeof createReadyPreflightResult>) => void) | undefined;
    preflightGatewayAccessMock.mockImplementation(() => new Promise((resolve) => {
      resolvePreflight = resolve as (value: ReturnType<typeof createReadyPreflightResult>) => void;
    }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    let text = renderTreeText(renderer!);
    expect(text).toContain("Starting Mission Control");
    expect(text).toContain("Mission Control startup");
    expect(text).not.toContain("Mission Control access gate");

    await act(async () => {
      resolvePreflight?.(createReadyPreflightResult());
      await Promise.resolve();
    });
    await flush();

    text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).toContain("chat-ready:chat:locked");
  }, 15_000);

  it("automatically retries startup preflight while the gateway is temporarily unreachable", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout.bind(globalThis);
      window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
      const { App } = await import("./App");
      preflightGatewayAccessMock
        .mockResolvedValueOnce({
          status: "unreachable",
          message: "Mission Control cannot reach the gateway yet.",
          healthDetail: "Gateway health probe failed: connect ECONNREFUSED 127.0.0.1:8787",
        })
        .mockResolvedValueOnce(createReadyPreflightResult());

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<App />);
      });
      await flush();

      expect(renderTreeText(renderer!)).toContain("Mission Control access gate");
      expect(preflightGatewayAccessMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await flush();

      expect(preflightGatewayAccessMock).toHaveBeenCalledTimes(2);
      expect(renderTreeText(renderer!)).toContain("chat-ready:chat:locked");
      expect(connectEventStreamMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds backend pending approvals to unresolved local approval prompts", async () => {
    const { deriveShellApprovalCount } = await import("./App");

    expect(deriveShellApprovalCount(null, 0)).toBe(0);
    expect(deriveShellApprovalCount({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 3,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    }, 0)).toBe(3);
    expect(deriveShellApprovalCount({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 3,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    }, 2)).toBe(5);
  });

  it("marks shell status stale after refresh failures or long gaps", async () => {
    const { deriveOperateStatusFreshness } = await import("./App");

    expect(deriveOperateStatusFreshness(null, null, 0)).toMatchObject({
      state: "stale",
    });
    expect(deriveOperateStatusFreshness(10_000, "gateway timeout", 20_000)).toMatchObject({
      state: "stale",
    });
    expect(deriveOperateStatusFreshness(10_000, null, 70_000)).toMatchObject({
      state: "stale",
    });
    expect(deriveOperateStatusFreshness(10_000, null, 20_000)).toMatchObject({
      state: "live",
    });
  });

  it("renders the new three-space shell without the old overflow navigation", async () => {
    const { App } = await import("./App");
    const { UiPreferencesProvider } = await import("./state/ui-preferences");
    window.localStorage.setItem("goatcitadel.ui.mode.v1", "advanced");
    window.location.search = "?space=operate&page=surface&surface=chat";
    window.location.href = "http://localhost:5173/?space=operate&page=surface&surface=chat";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:chat:locked");
    expect(text).toContain("Operate");
    expect(text).toContain("Observe");
    expect(text).toContain("Configure");
    expect(text).toContain("Cowork");
    expect(text).toContain("Code");
    expect(text).not.toContain("More");
  });

  it("reads the work surface from a legacy URL and passes it to the shared Chat page", async () => {
    const { App } = await import("./App");
    window.location.search = "?tab=chat&surface=code";
    window.location.href = "http://localhost:5173/?tab=chat&surface=code";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:code:locked");
    expect(chatPageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      surface: "code",
      lockSurface: true,
    }));
  });

  it("routes into the shared Chat page when a surface tab is selected from another page", async () => {
    const { App } = await import("./App");
    window.location.search = "?space=operate&page=tasks";
    window.location.href = "http://localhost:5173/?space=operate&page=tasks";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    const coworkButton = renderer!.root.findAll((node) => (
      node.type === "button" && flattenNodeText(node.props.children).includes("Cowork")
    ))[0];

    await act(async () => {
      coworkButton?.props.onClick();
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:cowork:locked");
  });

  it("enters a waiting state after requesting device approval from the access gate", async () => {
    const { App } = await import("./App");
    preflightGatewayAccessMock.mockResolvedValue({
      status: "needs-auth",
      message: "Gateway credentials are required to continue.",
      healthDetail: "Gateway health check OK (200).",
      authMode: "token",
    });
    createGatewayDeviceAccessRequestMock.mockResolvedValue({
      requestId: "request-device-1",
      requestSecret: "request-secret-1",
      approvalId: "approval-device-1",
      status: "pending",
      expiresAt: "2026-03-10T12:00:00.000Z",
      pollAfterMs: 2500,
      message: "Waiting for approval from another authenticated Mission Control session.",
    });
    pollGatewayDeviceAccessRequestStatusMock.mockResolvedValue({
      requestId: "request-device-1",
      approvalId: "approval-device-1",
      status: "pending",
      expiresAt: "2026-03-10T12:00:00.000Z",
      message: "Waiting for approval from another authenticated Mission Control session.",
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    const requestButton = renderer!.root.findAll((node) => (
      node.type === "button"
      && flattenNodeText(node.props.children).includes("Request approval from another device")
    ))[0];

    await act(async () => {
      requestButton?.props.onClick();
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("Waiting for approval from another authenticated Mission Control session.");
  });

  it("surfaces device approval prompts from realtime events", async () => {
    const { App } = await import("./App");
    let onEvent: ((event: {
      eventId: string;
      sequence: number;
      eventType: string;
      source: string;
      timestamp: string;
      payload: Record<string, unknown>;
    }) => void) | undefined;
    connectEventStreamMock.mockImplementation((handler: typeof onEvent) => {
      onEvent = handler;
      return () => undefined;
    });
    preflightGatewayAccessMock.mockResolvedValue({
      status: "ready",
      message: "Gateway reachability and access checks passed.",
      healthDetail: "Gateway health check OK (200).",
      onboardingState: {
        completed: true,
        checklist: [],
        settings: {
          environment: "coverage",
          deploymentProfile: "local_dev",
          defaultToolProfile: "standard",
          budgetMode: "balanced",
          workspaceDir: "workspace",
          writeJailRoots: [],
          readOnlyRoots: [],
          networkAllowlist: [],
          approvalExplainer: {
            enabled: false,
            mode: "async",
            minRiskLevel: "danger",
            timeoutMs: 1000,
            maxPayloadChars: 1000,
          },
          memory: {
            enabled: false,
            qmd: {
              enabled: false,
              applyToChat: false,
              applyToOrchestration: false,
              minPromptChars: 0,
              maxContextTokens: 0,
              cacheTtlSeconds: 0,
            },
          },
          auth: {
            mode: "token",
            allowLoopbackBypass: false,
            tokenConfigured: true,
            basicConfigured: false,
          },
          llm: {
            activeProviderId: "glm",
            activeModel: "glm-5",
            providers: [],
          },
          mesh: {
            enabled: false,
            mode: "lan",
            nodeId: "mesh-local",
            mdns: false,
            staticPeers: [],
            requireMtls: true,
            tailnetEnabled: false,
          },
          npu: {
            enabled: false,
            autoStart: false,
            sidecarUrl: "http://127.0.0.1:11440",
            status: {
              processState: "stopped",
              desiredState: "stopped",
              healthy: false,
              backend: "local",
              sidecarUrl: "http://127.0.0.1:11440",
              updatedAt: new Date().toISOString(),
              capability: {
                isWindowsArm64: false,
                onnxRuntimeAvailable: false,
                onnxRuntimeGenAiAvailable: false,
                qnnExecutionProviderAvailable: false,
                supported: false,
                details: [],
              },
            },
          },
          features: {
            durableKernelV1Enabled: false,
            replayOverridesV1Enabled: false,
            memoryLifecycleAdminV1Enabled: false,
            connectorDiagnosticsV1Enabled: false,
            computerUseGuardrailsV1Enabled: false,
            bankrBuiltinEnabled: false,
            cronReviewQueueV1Enabled: false,
            replayRegressionV1Enabled: false,
          },
        },
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    await act(async () => {
      onEvent?.({
        eventId: "evt-device-1",
        sequence: 101,
        eventType: "auth_device_request_created",
        source: "auth",
        timestamp: new Date().toISOString(),
        payload: {
          approvalId: "approval-device-1",
          requestId: "request-device-1",
          deviceLabel: "iPhone Safari",
          requestedIp: "192.168.1.44",
        },
      });
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("device-access-modal");
    expect(text).toContain("iPhone Safari");
  });

  it("surfaces remote approval action prompts from realtime events and resolves them with the delivered token", async () => {
    const { App } = await import("./App");
    let onEvent: ((event: {
      eventId: string;
      sequence: number;
      eventType: string;
      source: string;
      timestamp: string;
      payload: Record<string, unknown>;
    }) => void) | undefined;
    connectEventStreamMock.mockImplementation((handler: typeof onEvent) => {
      onEvent = handler;
      return () => undefined;
    });
    preflightGatewayAccessMock.mockResolvedValue({
      status: "ready",
      message: "Gateway reachability and access checks passed.",
      healthDetail: "Gateway health check OK (200).",
      onboardingState: {
        completed: true,
        checklist: [],
        settings: {
          environment: "coverage",
          deploymentProfile: "local_dev",
          defaultToolProfile: "standard",
          budgetMode: "balanced",
          workspaceDir: "workspace",
          writeJailRoots: [],
          readOnlyRoots: [],
          networkAllowlist: [],
          approvalExplainer: {
            enabled: false,
            mode: "async",
            minRiskLevel: "danger",
            timeoutMs: 1000,
            maxPayloadChars: 1000,
          },
          memory: {
            enabled: false,
            qmd: {
              enabled: false,
              applyToChat: false,
              applyToOrchestration: false,
              minPromptChars: 0,
              maxContextTokens: 0,
              cacheTtlSeconds: 0,
            },
          },
          auth: {
            mode: "token",
            allowLoopbackBypass: false,
            tokenConfigured: true,
            basicConfigured: false,
          },
          llm: {
            activeProviderId: "glm",
            activeModel: "glm-5",
            providers: [],
          },
          mesh: {
            enabled: false,
            mode: "lan",
            nodeId: "mesh-local",
            mdns: false,
            staticPeers: [],
            requireMtls: true,
            tailnetEnabled: false,
          },
          npu: {
            enabled: false,
            autoStart: false,
            sidecarUrl: "http://127.0.0.1:11440",
            status: {
              processState: "stopped",
              desiredState: "stopped",
              healthy: false,
              backend: "local",
              sidecarUrl: "http://127.0.0.1:11440",
              updatedAt: new Date().toISOString(),
              capability: {
                isWindowsArm64: false,
                onnxRuntimeAvailable: false,
                onnxRuntimeGenAiAvailable: false,
                qnnExecutionProviderAvailable: false,
                supported: false,
                details: [],
              },
            },
          },
          features: {
            durableKernelV1Enabled: true,
            replayOverridesV1Enabled: false,
            memoryLifecycleAdminV1Enabled: false,
            connectorDiagnosticsV1Enabled: false,
            computerUseGuardrailsV1Enabled: false,
            bankrBuiltinEnabled: false,
            cronReviewQueueV1Enabled: false,
            replayRegressionV1Enabled: false,
          },
        },
      },
    });
    resolveApprovalWithRemoteTokenMock.mockResolvedValue({
      approval: {
        approvalId: "apr-remote-1",
        kind: "tool.invoke",
        status: "approved",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: new Date().toISOString(),
        explanationStatus: "not_requested",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    await flush();

    await act(async () => {
      onEvent?.({
        eventId: "evt-remote-approval-1",
        sequence: 201,
        eventType: "approval_remote_action_ready",
        source: "approvals",
        timestamp: new Date().toISOString(),
        payload: {
          payload: {
            approvalId: "apr-remote-1",
            tokenId: "rat-remote-1",
            token: "grat_remote_token",
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "pending",
            preview: {
              summary: "Write a file",
            },
            expiresAt: "2026-03-10T12:00:00.000Z",
          },
        },
      });
    });
    await flush();

    const remoteApprovalModal = renderer!.root.findAll(
      (node) => flattenNodeText(node).includes("remote-approval-modal:tool.invoke"),
    )[0];
    expect(remoteApprovalModal).toBeDefined();

    const approveButton = renderer!.root.findAll(
      (node) => node.type === "button" && flattenNodeText(node).includes("approve remote approval"),
    )[0];
    expect(approveButton).toBeDefined();

    await act(async () => {
      approveButton?.props.onClick();
    });
    await flush();

    expect(resolveApprovalWithRemoteTokenMock).toHaveBeenCalledWith("grat_remote_token", "approve");
  });
});
