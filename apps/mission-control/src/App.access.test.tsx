import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useShellDetailPanel } from "./components/ShellDetailPanelContext";

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

const appPageBehavior = vi.hoisted(() => ({
  promptLabShouldThrow: false,
}));

const refreshSubscriptionMocks = vi.hoisted(() => ({
  callbacks: new Map<string, (signal?: unknown) => Promise<void> | void>(),
  options: new Map<string, unknown>(),
}));

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

vi.mock("./hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (topic: string, callback: (signal?: unknown) => Promise<void> | void, options?: unknown) => {
    refreshSubscriptionMocks.callbacks.set(topic, callback);
    refreshSubscriptionMocks.options.set(topic, options);
  },
}));

vi.mock("./pages/DashboardPage", () => ({
  DashboardPage: () => <div>dashboard-ready</div>,
}));

vi.mock("./pages/ChatPage", () => ({
  ChatPage: (props: {
    workspaceId?: string;
    surface?: string;
    lockSurface?: boolean;
    onWorkTrustSummaryChange?: (summary: string | null) => void;
    onOpenCowork?: () => void;
    onOpenCode?: () => void;
    onOpenTasks?: () => void;
    onOpenApprovals?: () => void;
    onNavigateSurface?: (
      surface: "chat" | "cowork" | "code",
      options?: { sessionId?: string; turnId?: string; artifactId?: string },
    ) => void;
  }) => {
    const {
      lockSurface,
      onNavigateSurface,
      onOpenApprovals,
      onOpenCode,
      onOpenCowork,
      onOpenTasks,
      onWorkTrustSummaryChange,
      surface,
    } = props;
    chatPageMock(props);
    React.useEffect(() => {
      onWorkTrustSummaryChange?.("OpenAI / gpt-5.4");
      return () => onWorkTrustSummaryChange?.(null);
    }, [onWorkTrustSummaryChange]);
    const { closePanel, openPanel, registerEntry } = useShellDetailPanel();
    React.useEffect(
      () =>
        registerEntry({
          id: "mock-chat-detail",
          kicker: "Mock detail",
          title: "Mock Chat Detail",
          subtitle: "Registered by the active chat surface.",
          body: <div>mock-chat-detail-body</div>,
          actions: <button type="button">mock-detail-action</button>,
        }),
      [registerEntry],
    );
    return (
      <div>
        {`chat-ready:${surface ?? "chat"}:${lockSurface ? "locked" : "open"}`}
        <button type="button" onClick={openPanel}>
          mock-open-detail-panel
        </button>
        <button type="button" onClick={closePanel}>
          mock-close-detail-panel
        </button>
        <button type="button" onClick={onOpenCowork}>
          mock-open-cowork
        </button>
        <button type="button" onClick={onOpenCode}>
          mock-open-code
        </button>
        <button type="button" onClick={onOpenTasks}>
          mock-open-tasks
        </button>
        <button type="button" onClick={onOpenApprovals}>
          mock-open-approvals
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateSurface?.("code", {
              sessionId: "session-shell-1",
              turnId: "turn-shell-1",
              artifactId: "artifact-shell-1",
            })
          }
        >
          mock-navigate-surface
        </button>
      </div>
    );
  },
}));

vi.mock("./pages/TasksPage", () => ({
  TasksPage: () => <div>tasks-ready</div>,
}));

vi.mock("./pages/AgentsHubPage", () => ({
  AgentsHubPage: ({
    activeTab,
    onTabChange,
  }: {
    activeTab?: string;
    onTabChange?: (tab: "overview" | "catalog" | "board") => void;
  }) => (
    <div>
      {`agents-hub-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("catalog")}>
        mock-agents-catalog
      </button>
    </div>
  ),
}));

vi.mock("./pages/ApprovalsPage", () => ({
  ApprovalsPage: () => <div>approvals-ready</div>,
}));

vi.mock("./pages/ArtifactsPage", () => ({
  ArtifactsPage: ({
    activeTab,
    onOpenGeneratedArtifact,
    onTabChange,
  }: {
    activeTab?: string;
    onOpenGeneratedArtifact?: (artifact: {
      sourceSurface: "chat" | "cowork" | "code";
      sessionId: string;
      turnId: string;
      artifactId: string;
    }) => void;
    onTabChange?: (tab: "runs" | "artifacts") => void;
  }) => (
    <div>
      {`artifacts-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("artifacts")}>
        mock-artifacts-tab
      </button>
      <button
        type="button"
        onClick={() =>
          onOpenGeneratedArtifact?.({
            sourceSurface: "cowork",
            sessionId: "session-artifact",
            turnId: "turn-artifact",
            artifactId: "artifact-1",
          })
        }
      >
        mock-open-artifact
      </button>
    </div>
  ),
}));

vi.mock("./components/CommandPalette", () => ({
  CommandPalette: ({
    items,
    onClose,
    open,
  }: {
    items?: Array<{ id?: string; label: string; run: () => void }>;
    onClose: () => void;
    open: boolean;
  }) =>
    open ? (
      <div>
        command-palette-open
        <button
          type="button"
          onClick={() => {
            items?.[0]?.run();
            onClose();
          }}
        >
          Run first command
        </button>
        {items?.map((item) => (
          <button key={item.id ?? item.label} type="button" onClick={item.run}>
            {item.label}
          </button>
        ))}
      </div>
    ) : null,
}));

vi.mock("./components/DevDiagnosticsPanel", () => ({
  DevDiagnosticsPanel: ({ onClose, open }: { onClose?: () => void; open: boolean }) =>
    open ? (
      <div>
        dev-diagnostics-ready
        <button type="button" onClick={onClose}>
          mock-close-dev-diagnostics
        </button>
      </div>
    ) : null,
}));

vi.mock("./pages/GeneralHubPage", () => ({
  GeneralHubPage: ({
    activeTab,
    onOnboardingCompleted,
    onTabChange,
  }: {
    activeTab?: string;
    onOnboardingCompleted?: () => void;
    onTabChange?: (tab: "providers" | "access" | "budget" | "onboarding" | "general") => void;
  }) => (
    <div>
      {`general-hub-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("providers")}>
        mock-general-providers
      </button>
      <button type="button" onClick={onOnboardingCompleted}>
        mock-onboarding-complete
      </button>
    </div>
  ),
}));

vi.mock("./pages/HealthPage", () => ({
  HealthPage: ({ activeTab, onTabChange }: { activeTab?: string; onTabChange?: (tab: "system" | "costs") => void }) => (
    <div>
      {`health-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("system")}>
        mock-health-system
      </button>
      <button type="button" onClick={() => onTabChange?.("costs")}>
        mock-health-costs
      </button>
    </div>
  ),
}));

vi.mock("./pages/IntegrationsHubPage", () => ({
  IntegrationsHubPage: ({
    activeTab,
    onTabChange,
  }: {
    activeTab?: string;
    onTabChange?: (tab: "channels" | "connectors" | "obsidian" | "hooks") => void;
  }) => (
    <div>
      {`integrations-hub-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("connectors")}>
        mock-integrations-connectors
      </button>
    </div>
  ),
}));

vi.mock("./pages/PromptLabPage", () => ({
  PromptLabPage: () => {
    if (appPageBehavior.promptLabShouldThrow) {
      throw new Error("prompt lab render failed");
    }
    return <div>prompt-lab-ready</div>;
  },
}));

vi.mock("./pages/RuntimeHubPage", () => ({
  RuntimeHubPage: () => <div>runtime-hub-ready</div>,
}));

vi.mock("./pages/TimelinePage", () => ({
  TimelinePage: ({
    activeTab,
    onTabChange,
  }: {
    activeTab?: string;
    onTabChange?: (tab: "activity" | "sessions" | "scheduler" | "improvement") => void;
  }) => (
    <div>
      {`timeline-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("sessions")}>
        mock-timeline-sessions
      </button>
      <button type="button" onClick={() => onTabChange?.("scheduler")}>
        mock-timeline-scheduler
      </button>
      <button type="button" onClick={() => onTabChange?.("improvement")}>
        mock-timeline-improvement
      </button>
    </div>
  ),
}));

vi.mock("./pages/ToolsPage", () => ({
  ToolsPage: () => <div>tools-ready</div>,
}));

vi.mock("./pages/WorkspacesHubPage", () => ({
  WorkspacesHubPage: ({
    activeTab,
    onTabChange,
    onWorkspaceChange,
  }: {
    activeTab?: string;
    onTabChange?: (tab: "workspaces" | "addons") => void;
    onWorkspaceChange?: (workspaceId: string) => void;
  }) => (
    <div>
      {`workspaces-hub-ready:${activeTab ?? ""}`}
      <button type="button" onClick={() => onTabChange?.("addons")}>
        mock-workspaces-addons
      </button>
      <button type="button" onClick={() => onWorkspaceChange?.("workspace-from-mock")}>
        mock-workspace-change
      </button>
    </div>
  ),
}));

vi.mock("./components/DeviceAccessApprovalModal", () => ({
  DeviceAccessApprovalModal: ({
    open,
    prompt,
    onApprove,
    onDismiss,
    onReject,
  }: {
    open: boolean;
    prompt?: { deviceLabel?: string };
    onApprove?: () => void;
    onDismiss?: () => void;
    onReject?: () => void;
  }) =>
    open ? (
      <div>
        <div>device-access-modal:{prompt?.deviceLabel ?? "unknown"}</div>
        <button type="button" onClick={onApprove}>
          approve device access
        </button>
        <button type="button" onClick={onReject}>
          reject device access
        </button>
        <button type="button" onClick={onDismiss}>
          dismiss device access
        </button>
      </div>
    ) : null,
}));

vi.mock("./components/RemoteApprovalActionModal", () => ({
  RemoteApprovalActionModal: ({
    open,
    prompt,
    onApprove,
    onDismiss,
    onReject,
  }: {
    open: boolean;
    prompt?: { kind?: string };
    onDismiss?: () => void;
    onApprove: () => void;
    onReject: () => void;
  }) =>
    open ? (
      <div>
        <div>remote-approval-modal:{prompt?.kind ?? "unknown"}</div>
        <button type="button" onClick={onApprove}>
          approve remote approval
        </button>
        <button type="button" onClick={onReject}>
          reject remote approval
        </button>
        <button type="button" onClick={onDismiss}>
          dismiss remote approval
        </button>
      </div>
    ) : null,
}));

const appModulePromise = import("./App");

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

const activeTimeoutHandles = new Set<ReturnType<typeof globalThis.setTimeout>>();
const activeIntervalHandles = new Set<ReturnType<typeof globalThis.setInterval>>();

function trackedSetTimeout(
  callback: (...args: never[]) => void,
  delay?: number,
  ...args: never[]
): ReturnType<typeof globalThis.setTimeout> {
  const handle = globalThis.setTimeout(
    () => {
      activeTimeoutHandles.delete(handle);
      callback(...args);
    },
    delay,
    ...args,
  ) as unknown as ReturnType<typeof globalThis.setTimeout>;
  activeTimeoutHandles.add(handle);
  return handle;
}

function trackedClearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
  activeTimeoutHandles.delete(handle);
  globalThis.clearTimeout(handle);
}

function trackedSetInterval(
  callback: (...args: never[]) => void,
  delay?: number,
  ...args: never[]
): ReturnType<typeof globalThis.setInterval> {
  const handle = globalThis.setInterval(callback, delay, ...args);
  activeIntervalHandles.add(handle);
  return handle;
}

function trackedClearInterval(handle: ReturnType<typeof globalThis.setInterval>): void {
  activeIntervalHandles.delete(handle);
  globalThis.clearInterval(handle);
}

function clearTrackedTimers(): void {
  for (const handle of activeIntervalHandles) {
    globalThis.clearInterval(handle);
  }
  activeIntervalHandles.clear();

  for (const handle of activeTimeoutHandles) {
    globalThis.clearTimeout(handle);
  }
  activeTimeoutHandles.clear();
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
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      trackedSetTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) =>
      trackedClearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
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

function captureWindowListeners(): Map<string, Set<(event: any) => void>> {
  const listeners = new Map<string, Set<(event: any) => void>>();
  window.addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    const bucket = listeners.get(type) ?? new Set<(event: any) => void>();
    const callback = typeof listener === "function" ? listener : (event: any) => listener.handleEvent(event as Event);
    bucket.add(callback as (event: any) => void);
    listeners.set(type, bucket);
  }) as typeof window.addEventListener;
  window.removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    const bucket = listeners.get(type);
    if (!bucket) {
      return;
    }
    const callback = typeof listener === "function" ? listener : (event: any) => listener.handleEvent(event as Event);
    bucket.delete(callback as (event: any) => void);
  }) as typeof window.removeEventListener;
  return listeners;
}

async function dispatchCapturedWindowEvent(
  listeners: Map<string, Set<(event: any) => void>>,
  type: string,
  event: any,
): Promise<void> {
  await act(async () => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
    await Promise.resolve();
  });
}

function renderTreeText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

const mountedRenderers = new Set<ReactTestRenderer>();

function mount(element: React.ReactElement): ReactTestRenderer {
  const renderer = create(element);
  mountedRenderers.add(renderer);
  return renderer;
}

async function unmountMountedRenderers(): Promise<void> {
  if (mountedRenderers.size === 0) {
    return;
  }

  await act(async () => {
    for (const renderer of mountedRenderers) {
      renderer.unmount();
    }
    mountedRenderers.clear();
  });
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

function findButtonContaining(renderer: ReactTestRenderer, label: string) {
  return findButtonsContaining(renderer, label)[0];
}

function findButtonsContaining(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) => node.type === "button" && flattenNodeText(node.props.children).includes(label),
  );
}

function findButtonContainingWithClass(renderer: ReactTestRenderer, label: string, classNamePart: string) {
  return renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props.className === "string" &&
      node.props.className.includes(classNamePart) &&
      flattenNodeText(node.props.children).includes(label),
  )[0];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("deriveRefreshTopics", () => {
  it("keeps session-scoped chat events off the surface refresh topic", async () => {
    const { deriveRefreshTopics } = await appModulePromise;

    expect(
      deriveRefreshTopics({
        eventId: "evt-chat-1",
        eventType: "chat_thread_updated",
        source: "chat",
        payload: { kind: "event" },
        links: { sessionId: "sess-1" },
      } as any),
    ).toContain("chat");

    expect(
      deriveRefreshTopics({
        eventId: "evt-chat-1",
        eventType: "chat_thread_updated",
        source: "chat",
        payload: { kind: "event" },
        links: { sessionId: "sess-1" },
      } as any),
    ).not.toContain("surface");
  }, 45_000);

  it("keeps durable-history events from triggering duplicate refresh work", async () => {
    const { deriveRefreshTopics } = await appModulePromise;

    expect(
      deriveRefreshTopics({
        eventId: "evt-history-1",
        eventType: "approval_state_changed",
        source: "approvals",
        eventAuthority: "durable_history",
        payload: { kind: "event" },
      } as any),
    ).toEqual([]);
  });

  it("refreshes every legacy topic when the event stream reports a replay gap", async () => {
    const { deriveRefreshTopics } = await appModulePromise;

    expect(
      deriveRefreshTopics({
        eventId: "evt-gap-1",
        eventType: "stream_replay_gap",
        source: "system",
        payload: { kind: "replay_gap" },
      } as any),
    ).toEqual(expect.arrayContaining(["surface", "chat", "approvals", "agents", "skills", "llamaCpp", "system"]));
  });

  it("uses explicit realtime links for approval and task refresh topics", async () => {
    const { deriveRefreshTopics } = await appModulePromise;

    expect(
      deriveRefreshTopics({
        eventId: "evt-approval-1",
        eventType: "approval_state_changed",
        source: "approvals",
        payload: { kind: "event" },
        links: { approvalId: "apr-1" },
      } as any),
    ).toContain("approvals");
    expect(
      deriveRefreshTopics({
        eventId: "evt-task-1",
        eventType: "task_updated",
        source: "cowork",
        payload: { kind: "event" },
        links: { taskId: "task-1" },
      } as any),
    ).toContain("tasks");
  });
});

describe("App pure shell derivations", () => {
  it("resolves theme overrides and default shell theme classes", async () => {
    installMockWindow();
    const { readThemeOverrideFromLocation, resolveShellThemeClass, buildMissionControlResolverId } =
      await appModulePromise;

    window.location.search = "?theme=citadel-light";
    expect(readThemeOverrideFromLocation()).toBe("light");
    expect(resolveShellThemeClass("dark")).toBe("theme-citadel-light");

    window.location.search = "?theme=signal-noir";
    expect(readThemeOverrideFromLocation()).toBe("dark");
    expect(resolveShellThemeClass("light")).toBe("theme-signal-noir");

    window.location.search = "";
    expect(readThemeOverrideFromLocation()).toBeNull();
    expect(resolveShellThemeClass("dark")).toBe("theme-signal-noir");
    expect(buildMissionControlResolverId()).toBe("mission-control:localhost");
  });

  it("derives shell tabs and rail defaults from resolved routes", async () => {
    const { deriveGeneralTab, deriveHealthTab, deriveTimelineTab, deriveWorkspacesTab, resolveShellRailDefaultSize } =
      await appModulePromise;

    expect(deriveTimelineTab({ space: "observe", page: "sessions" } as any)).toBe("sessions");
    expect(deriveTimelineTab({ space: "observe", page: "activity", tab: "scheduler" } as any)).toBe("scheduler");
    expect(deriveTimelineTab({ space: "operate", page: "surface" } as any)).toBe("activity");
    expect(deriveHealthTab({ space: "observe", page: "system" } as any)).toBe("system");
    expect(deriveHealthTab({ space: "observe", page: "costs" } as any)).toBe("costs");
    expect(deriveGeneralTab({ space: "configure", page: "settings", tab: "providers" } as any)).toBe("providers");
    expect(deriveGeneralTab({ space: "configure", page: "settings", tab: "other" } as any)).toBe("general");
    expect(deriveWorkspacesTab({ space: "configure", page: "settings", tab: "addons" } as any)).toBe("addons");
    expect(deriveWorkspacesTab({ space: "configure", page: "workspaces" } as any)).toBe("workspaces");
    expect(resolveShellRailDefaultSize("expanded")).toBe(264);
    expect(resolveShellRailDefaultSize("compact")).toBe(176);
    expect(resolveShellRailDefaultSize("icon")).toBe(92);
  });
});

async function waitForTreeText(renderer: ReactTestRenderer, expected: string, attempts = 20): Promise<string> {
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
    appPageBehavior.promptLabShouldThrow = false;
    refreshSubscriptionMocks.callbacks.clear();
    refreshSubscriptionMocks.options.clear();
  });

  afterEach(async () => {
    await unmountMountedRenderers();
    clearTrackedTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the access gate and does not start SSE when auth is required", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockResolvedValue({
      status: "needs-auth",
      message: "Gateway credentials are required to continue.",
      healthDetail: "Gateway health check OK (200).",
      authMode: "token",
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "Mission Control access gate");
    expect(text).toContain("Mission Control access gate");
    expect(text).toContain("Gateway credentials are required to continue.");
    expect(connectEventStreamMock).not.toHaveBeenCalled();
  }, 15_000);

  it("starts Mission Control normally after a ready preflight result", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).toContain("chat-ready:chat:locked");
    expect(connectEventStreamMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("restores the last safe shell route when launched from the PWA entrypoint", async () => {
    const { App } = await appModulePromise;
    window.localStorage.setItem("goatcitadel.shell.last-route", "?space=operate&page=surface&surface=code");
    window.location.search = "?source=pwa";
    window.location.href = "http://localhost:5173/?source=pwa";
    window.history.replaceState = vi.fn((_state: unknown, _title: string, nextUrl: string) => {
      const url = new URL(String(nextUrl), window.location.origin);
      window.location.search = url.search;
      window.location.href = url.href;
    });
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:code:locked");
    expect(text).toContain("chat-ready:code:locked");
    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/?space=operate&page=surface&surface=code");
  }, 15_000);

  it("keeps direct Work surface entry active when onboarding is incomplete", async () => {
    const { App } = await appModulePromise;
    window.location.search = "?space=operate&page=surface&surface=code";
    window.location.href = "http://localhost:5173/?space=operate&page=surface&surface=code";
    preflightGatewayAccessMock.mockResolvedValue({
      ...createReadyPreflightResult(),
      onboardingState: {
        ...createReadyPreflightResult().onboardingState,
        completed: false,
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:code:locked");
    expect(text).toContain("chat-ready:code:locked");
    expect(text).toContain("Onboarding still needs attention.");
    expect(text).not.toContain("Launch Wizard");
  }, 15_000);

  it("shows startup copy before the first preflight resolves and then transitions into the shell", async () => {
    const { App } = await appModulePromise;
    let resolvePreflight: ((value: ReturnType<typeof createReadyPreflightResult>) => void) | undefined;
    preflightGatewayAccessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreflight = resolve as (value: ReturnType<typeof createReadyPreflightResult>) => void;
        }),
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
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
      const { App } = await appModulePromise;
      preflightGatewayAccessMock
        .mockResolvedValueOnce({
          status: "unreachable",
          message: "Mission Control cannot reach the gateway yet.",
          healthDetail: "Gateway health probe failed: connect ECONNREFUSED 127.0.0.1:8787",
        })
        .mockResolvedValueOnce(createReadyPreflightResult());

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = mount(<App />);
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
    const { deriveShellApprovalCount } = await appModulePromise;

    expect(deriveShellApprovalCount(null, 0)).toBe(0);
    expect(
      deriveShellApprovalCount(
        {
          timestamp: new Date().toISOString(),
          sessions: [],
          pendingApprovals: 3,
          activeSubagents: 0,
          taskStatusCounts: [],
          recentEvents: [],
          dailyCostUsd: 0,
        },
        0,
      ),
    ).toBe(3);
    expect(
      deriveShellApprovalCount(
        {
          timestamp: new Date().toISOString(),
          sessions: [],
          pendingApprovals: 3,
          activeSubagents: 0,
          taskStatusCounts: [],
          recentEvents: [],
          dailyCostUsd: 0,
        },
        2,
      ),
    ).toBe(5);
  });

  it("marks shell status stale after refresh failures or long gaps", async () => {
    const { deriveOperateStatusFreshness } = await appModulePromise;

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
    const { App } = await appModulePromise;
    const { UiPreferencesProvider } = await import("./state/ui-preferences");
    window.localStorage.setItem("goatcitadel.ui.mode.v1", "advanced");
    window.location.search = "?space=operate&page=surface&surface=chat";
    window.location.href = "http://localhost:5173/?space=operate&page=surface&surface=chat";
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width: 1100px"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:chat:locked");
    expect(text).toContain("Work");
    expect(text).toContain("Observe");
    expect(text).toContain("Configure");
    expect(text).toContain("Cowork");
    expect(text).toContain("Code");
    expect(text).toContain("Mission Control");
    expect(text).toContain("Work pages");
    expect(text).not.toContain("Surface");
    expect(text).not.toContain("More");
  });

  it("reads the work surface from a legacy URL and passes it to the shared Chat page", async () => {
    const { App } = await appModulePromise;
    window.location.search = "?tab=chat&surface=code";
    window.location.href = "http://localhost:5173/?tab=chat&surface=code";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:code:locked");
    expect(chatPageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        surface: "code",
        lockSurface: true,
      }),
    );
  });

  it("routes into the shared Chat page when a surface tab is selected from another page", async () => {
    const { App } = await appModulePromise;
    window.location.search = "?space=operate&page=tasks";
    window.location.href = "http://localhost:5173/?space=operate&page=tasks";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const coworkButton = renderer!.root.findAll(
      (node) => node.type === "button" && flattenNodeText(node.props.children).includes("Cowork"),
    )[0];

    await act(async () => {
      coworkButton?.props.onClick();
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("chat-ready:cowork:locked");
  });

  it("uses the compact page selector when the shell is on a narrow viewport", async () => {
    const { App } = await appModulePromise;
    window.location.search = "?space=configure&page=settings&tab=general";
    window.location.href = "http://localhost:5173/?space=configure&page=settings&tab=general";
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const compactPageSelect = renderer!.root.findByProps({ "aria-label": "Configure pages" });
    expect(compactPageSelect.props.value).toBe("general");

    await act(async () => {
      compactPageSelect.props.onChange("runtime");
    });
    await flush();

    expect(renderTreeText(renderer!)).toContain("runtime-hub-ready");
  });

  it("drives work-surface callbacks from the shell-hosted Chat page", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-code")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:code:locked");

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-cowork")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:cowork:locked");

    await act(async () => {
      findButtonContaining(renderer!, "mock-navigate-surface")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:code:locked");

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-tasks")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("tasks-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Approvals")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("approvals-ready");
  });

  it("opens and closes a registered shell detail drawer from the active work surface", async () => {
    const { App } = await appModulePromise;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width: 1100px"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    expect(renderTreeText(renderer!)).toContain("Show details");
    expect(renderTreeText(renderer!)).not.toContain("mock-chat-detail-body");

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-detail-panel")?.props.onClick();
    });
    await flush();

    const openedText = renderTreeText(renderer!);
    expect(openedText).toContain("Mock Chat Detail");
    expect(openedText).toContain("mock-chat-detail-body");
    expect(openedText).toContain("mock-detail-action");
    expect(openedText).toContain("Hide details");

    await act(async () => {
      findButtonContaining(renderer!, "Close")?.props.onClick();
    });
    await flush();

    const closedText = renderTreeText(renderer!);
    expect(closedText).toContain("Show details");
    expect(closedText).not.toContain("mock-chat-detail-body");
  });

  it("wires observe and configure route tab callbacks through lazy pages", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());
    window.location.search = "?space=observe&page=activity&tab=activity";
    window.location.href = "http://localhost:5173/?space=observe&page=activity&tab=activity";

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "mock-timeline-scheduler")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("timeline-ready:");
    expect(renderTreeText(renderer!)).toContain("scheduler");

    await act(async () => {
      findButtonContaining(renderer!, "Artifacts")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "mock-open-artifact")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:cowork:locked");

    await act(async () => {
      findButtonContaining(renderer!, "Configure")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "mock-general-providers")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("general-hub-ready:providers");

    await act(async () => {
      findButtonContaining(renderer!, "Agents")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "mock-agents-catalog")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("agents-hub-ready:catalog");
  });

  it("runs command palette shell actions without leaving the mounted shell", async () => {
    const { App } = await appModulePromise;
    const { UiPreferencesProvider } = await import("./state/ui-preferences");
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "Command Palette")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("command-palette-open");

    for (const label of [
      "Use Compact density",
      "Use Default density",
      "Use Comfortable density",
      "Switch to Beginner experience",
      "Switch to Advanced experience",
      "Use automatic effects",
      "Use full effects",
      "Use reduced effects",
      "Show technical details",
    ]) {
      await act(async () => {
        findButtonContaining(renderer!, label)?.props.onClick();
      });
      await flush();
    }

    const text = renderTreeText(renderer!);
    expect(text).toContain("command-palette-open");
    expect(text).toContain("chat-ready:chat:locked");
  });

  it("opens developer diagnostics from the command palette when diagnostics are enabled", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "Command Palette")?.props.onClick();
    });
    await flush();

    const diagnosticsCommand = findButtonContaining(renderer!, "Show developer diagnostics");
    expect(diagnosticsCommand).toBeDefined();

    await act(async () => {
      diagnosticsCommand?.props.onClick();
    });
    await flush();

    expect(renderTreeText(renderer!)).toContain("dev-diagnostics-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Hide developer diagnostics")?.props.onClick();
    });
    await flush();

    expect(renderTreeText(renderer!)).not.toContain("dev-diagnostics-ready");
  });

  it("captures the PWA install prompt and clears the install action after prompting", async () => {
    const { App } = await appModulePromise;
    const listeners = captureWindowListeners();
    const preventDefault = vi.fn();
    const prompt = vi.fn(async () => undefined);
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await dispatchCapturedWindowEvent(listeners, "beforeinstallprompt", {
      preventDefault,
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    await flush();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(renderTreeText(renderer!)).toContain("Install app");

    const installButton = renderer!.root.findAll(
      (node) => node.type === "button" && flattenNodeText(node.props.children).includes("Install app"),
    )[0];
    await act(async () => {
      installButton?.props.onClick();
    });
    await flush();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(renderTreeText(renderer!)).not.toContain("Install app");
  });

  it("announces PWA installation and lets the operator dismiss the notification", async () => {
    const { App } = await appModulePromise;
    const listeners = captureWindowListeners();
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await dispatchCapturedWindowEvent(listeners, "appinstalled", {});
    await flush();

    expect(renderTreeText(renderer!)).toContain("Mission Control installed and ready from your launcher.");

    const dismissButton = renderer!.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Dismiss notification",
    )[0];
    await act(async () => {
      dismissButton?.props.onClick();
    });
    await flush();

    expect(renderTreeText(renderer!)).not.toContain("Mission Control installed and ready from your launcher.");
  });

  it("handles shell keyboard shortcuts without stealing keys from editable targets", async () => {
    const { App } = await appModulePromise;
    const listeners = captureWindowListeners();
    class MockHTMLElement {
      isContentEditable = false;

      constructor(public tagName = "DIV") {}
    }
    vi.stubGlobal("HTMLElement", MockHTMLElement);
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const commandPreventDefault = vi.fn();
    await dispatchCapturedWindowEvent(listeners, "keydown", {
      key: "k",
      ctrlKey: true,
      metaKey: false,
      preventDefault: commandPreventDefault,
    });
    await flush();

    expect(commandPreventDefault).toHaveBeenCalledTimes(1);
    expect(renderTreeText(renderer!)).toContain("command-palette-open");

    await dispatchCapturedWindowEvent(listeners, "keydown", {
      key: "Escape",
      preventDefault: vi.fn(),
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("command-palette-open");

    const surfacePreventDefault = vi.fn();
    await dispatchCapturedWindowEvent(listeners, "keydown", {
      key: "2",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: null,
      preventDefault: surfacePreventDefault,
    });
    await flush();
    expect(surfacePreventDefault).toHaveBeenCalledTimes(1);
    expect(renderTreeText(renderer!)).toContain("chat-ready:cowork:locked");

    const editablePreventDefault = vi.fn();
    await dispatchCapturedWindowEvent(listeners, "keydown", {
      key: "3",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: new MockHTMLElement("INPUT"),
      preventDefault: editablePreventDefault,
    });
    await flush();

    expect(editablePreventDefault).not.toHaveBeenCalled();
    expect(renderTreeText(renderer!)).toContain("chat-ready:cowork:locked");

    for (const key of ["[", "]", "|"]) {
      const preventDefault = vi.fn();
      await dispatchCapturedWindowEvent(listeners, "keydown", {
        key,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        preventDefault,
      });
      await flush();
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("preloads lazy route modules during idle time after gateway access is ready", async () => {
    const { App } = await appModulePromise;
    const idleCallbacks: Array<() => void> = [];
    const cancelIdleCallback = vi.fn();
    Object.assign(window, {
      requestIdleCallback: vi.fn((callback: () => void) => {
        idleCallbacks.push(callback);
        return 42;
      }),
      cancelIdleCallback,
    });
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    expect(idleCallbacks).toHaveLength(1);
    await act(async () => {
      idleCallbacks[0]?.();
      await Promise.resolve();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:chat:locked");
  });

  it("enters a waiting state after requesting device approval from the access gate", async () => {
    const { App } = await appModulePromise;
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
      renderer = mount(<App />);
    });
    await flush();

    const requestButton = renderer!.root.findAll(
      (node) =>
        node.type === "button" && flattenNodeText(node.props.children).includes("Request approval from another device"),
    )[0];

    await act(async () => {
      requestButton?.props.onClick();
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("Waiting for approval from another authenticated Mission Control session.");
  });

  it("surfaces device approval prompts from realtime events", async () => {
    const { App } = await appModulePromise;
    let onEvent:
      | ((event: {
          eventId: string;
          sequence: number;
          eventType: string;
          source: string;
          timestamp: string;
          payload: Record<string, unknown>;
        }) => void)
      | undefined;
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
      renderer = mount(<App />);
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

  it("keeps provider trust out of duplicated shell chrome for work surfaces", async () => {
    const { App } = await appModulePromise;

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).not.toContain("shell-trust-provider");
    expect(text).not.toContain("OpenAI / gpt-5.4");
  });

  it("keeps the status center collapsed by default while the shell stays compact", async () => {
    const { App } = await appModulePromise;

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).toContain("Status Center");
    expect(text).toContain("Decisions clear");
    expect(text).not.toContain("System health");
    expect(text).not.toContain("Pending decisions");
  });

  it("does not auto-expand the status center when approvals are the only active trust warning", async () => {
    const { App } = await appModulePromise;
    fetchDashboardStateMock.mockResolvedValue({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 2,
      activeSubagents: 0,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 0,
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "2 decisions waiting");
    expect(text).toContain("2 decisions waiting");
    expect(text).not.toContain("System health");
  });

  it("lets the status center expand workload detail on demand", async () => {
    const { App } = await appModulePromise;
    const { UiPreferencesProvider } = await import("./state/ui-preferences");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    expect(renderTreeText(renderer!)).not.toContain("Pending decisions");

    const statusToggle = renderer!.root.find(
      (node) =>
        node.type === "button" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("shell-status-center-trigger"),
    );

    await act(async () => {
      statusToggle.props.onClick?.();
    });
    await flush();

    const expandedText = renderTreeText(renderer!);
    expect(expandedText).toContain("System health");
    expect(expandedText).toContain("Approvals clear");
    expect(expandedText).toContain("Active agents");
  });

  it("surfaces remote approval action prompts from realtime events and resolves them with the delivered token", async () => {
    const { App } = await appModulePromise;
    let onEvent:
      | ((event: {
          eventId: string;
          sequence: number;
          eventType: string;
          source: string;
          timestamp: string;
          payload: Record<string, unknown>;
        }) => void)
      | undefined;
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
      renderer = mount(<App />);
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

    const remoteApprovalModal = renderer!.root.findAll((node) =>
      flattenNodeText(node).includes("remote-approval-modal:tool.invoke"),
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

  it("routes through the remaining major shell pages and responds to history changes", async () => {
    const { App } = await appModulePromise;
    const listeners = captureWindowListeners();
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished: Promise.resolve() };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    fetchWorkspacesMock.mockResolvedValue({
      items: [{ workspaceId: "workspace-alpha", name: "Alpha Workspace" }],
    });
    window.location.search = "?space=observe&page=costs";
    window.location.href = "http://localhost:5173/?space=observe&page=costs";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    expect(renderTreeText(renderer!)).toContain("health-ready:costs");

    await act(async () => {
      findButtonContaining(renderer!, "mock-health-system")?.props.onClick();
    });
    await flush();
    expect(startViewTransition).toHaveBeenCalled();
    expect(renderTreeText(renderer!)).toContain("health-ready:system");

    await act(async () => {
      findButtonContaining(renderer!, "Quality")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("prompt-lab-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Configure")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "Runtime")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("runtime-hub-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Workspaces")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("workspaces-hub-ready:workspaces");

    await act(async () => {
      findButtonContaining(renderer!, "mock-workspaces-addons")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("workspaces-hub-ready:addons");

    await act(async () => {
      findButtonContaining(renderer!, "mock-workspace-change")?.props.onClick();
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "Integrations")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("integrations-hub-ready:overview");

    await act(async () => {
      findButtonContaining(renderer!, "mock-integrations-connectors")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("integrations-hub-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Tools")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("tools-ready");

    window.location.search = "?space=operate&page=tasks";
    window.location.href = "http://localhost:5173/?space=operate&page=tasks";
    await dispatchCapturedWindowEvent(listeners, "popstate", {});
    await flush();
    expect(renderTreeText(renderer!)).toContain("tasks-ready");
  }, 15_000);

  it("surfaces startup preflight crashes as access-gate failures", async () => {
    const { App } = await appModulePromise;
    preflightGatewayAccessMock.mockRejectedValueOnce(new Error("preflight exploded"));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    const text = await waitForTreeText(renderer!, "preflight exploded");
    expect(text).toContain("Mission Control access gate");
    expect(text).toContain("preflight exploded");
    expect(connectEventStreamMock).not.toHaveBeenCalled();
  }, 15_000);

  it("resolves device prompts and records realtime stream state changes", async () => {
    const { App } = await appModulePromise;
    let onEvent:
      | ((event: {
          eventId: string;
          sequence: number;
          eventType: string;
          source: string;
          timestamp: string;
          payload: Record<string, unknown>;
        }) => void)
      | undefined;
    let onState: ((state: "closed" | "connecting" | "open" | "error") => void) | undefined;
    connectEventStreamMock.mockImplementation((handler: typeof onEvent, stateHandler: typeof onState) => {
      onEvent = handler;
      onState = stateHandler;
      return () => undefined;
    });
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());
    resolveApprovalMock.mockResolvedValueOnce({});

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    await act(async () => {
      onState?.("open");
      onEvent?.({
        eventId: "evt-device-approve",
        sequence: 301,
        eventType: "auth_device_request_created",
        source: "auth",
        timestamp: new Date().toISOString(),
        payload: {
          approvalId: "approval-device-approve",
          requestId: "request-device-approve",
          deviceLabel: "Tablet Chrome",
          requestedIp: "192.168.1.45",
          platform: "android",
        },
      });
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("device-access-modal");
    expect(renderTreeText(renderer!)).toContain("Tablet Chrome");

    await act(async () => {
      findButtonContaining(renderer!, "approve device access")?.props.onClick();
    });
    await flush();

    expect(resolveApprovalMock).toHaveBeenCalledWith(
      "approval-device-approve",
      expect.objectContaining({
        decision: "approve",
        resolutionNote: "Approved from Mission Control.",
      }),
    );
    expect(renderTreeText(renderer!)).toContain("Tablet Chrome was approved.");

    resolveApprovalMock.mockRejectedValueOnce(new Error("approval service down"));
    await act(async () => {
      onEvent?.({
        eventId: "evt-device-reject",
        sequence: 302,
        eventType: "auth_device_request_created",
        source: "auth",
        timestamp: new Date().toISOString(),
        payload: {
          approvalId: "approval-device-reject",
          requestId: "request-device-reject",
          deviceLabel: "Kiosk Edge",
          requestedIp: "192.168.1.46",
        },
      });
    });
    await flush();

    await act(async () => {
      findButtonContaining(renderer!, "reject device access")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("approval service down");

    await act(async () => {
      onEvent?.({
        eventId: "evt-device-resolved",
        sequence: 303,
        eventType: "auth_device_request_resolved",
        source: "auth",
        timestamp: new Date().toISOString(),
        payload: {
          approvalId: "approval-device-reject",
        },
      });
      onEvent?.({
        eventId: "evt-gap",
        sequence: 304,
        eventType: "stream_replay_gap",
        source: "system",
        timestamp: new Date().toISOString(),
        payload: { kind: "replay_gap" },
      });
      onState?.("error");
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).not.toContain("device-access-modal");
    expect(text).toContain("Live event history rotated past this browser cursor.");
  }, 15_000);

  it("drives remaining shell controls, status actions, and prompt dismissal callbacks", async () => {
    const { App } = await appModulePromise;
    const { UiPreferencesProvider } = await import("./state/ui-preferences");
    let onEvent:
      | ((event: {
          eventId: string;
          sequence: number;
          eventType: string;
          source: string;
          timestamp: string;
          payload: Record<string, unknown>;
        }) => void)
      | undefined;
    connectEventStreamMock.mockImplementation((handler: typeof onEvent) => {
      onEvent = handler;
      return () => undefined;
    });
    fetchDashboardStateMock.mockResolvedValue({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 1,
      activeSubagents: 2,
      taskStatusCounts: [
        { status: "running", count: 3 },
        { status: "done", count: 5 },
      ],
      recentEvents: [],
      dailyCostUsd: 12.34,
    });
    preflightGatewayAccessMock.mockResolvedValue({
      ...createReadyPreflightResult(),
      onboardingState: {
        ...createReadyPreflightResult().onboardingState,
        completed: false,
      },
    });
    resolveApprovalWithRemoteTokenMock.mockResolvedValue({
      approval: {
        approvalId: "apr-remote-reject",
        kind: "tool.invoke",
        status: "rejected",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: new Date().toISOString(),
        explanationStatus: "not_requested",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    let text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
    expect(text).toContain("Onboarding still needs attention.");

    await act(async () => {
      findButtonContaining(renderer!, "Open onboarding")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("general-hub-ready:onboarding");

    await act(async () => {
      findButtonContaining(renderer!, "mock-onboarding-complete")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:chat:locked");

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-detail-panel")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("mock-chat-detail-body");

    await act(async () => {
      findButtonContaining(renderer!, "mock-close-detail-panel")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("mock-chat-detail-body");

    await act(async () => {
      findButtonContaining(renderer!, "mock-open-approvals")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("approvals-ready");

    await act(async () => {
      renderer!.root
        .findAll((node) => node.type === "button" && String(node.props["aria-label"] ?? "").startsWith("Switch to "))[0]
        ?.props.onClick();
    });
    await flush();
    await act(async () => {
      renderer!.root
        .findAll((node) => node.type === "button" && node.props["aria-label"] === "Settings")[0]
        ?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("general-hub-ready:general");

    await act(async () => {
      findButtonContaining(renderer!, "Command Palette")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("command-palette-open");

    for (const label of ["Open Observe", "Open Health", "Open Code", "Open General", "Show technical details"]) {
      await act(async () => {
        findButtonContaining(renderer!, label)?.props.onClick();
      });
      await flush();
    }
    await act(async () => {
      findButtonsContaining(renderer!, "Open Code")[1]?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("chat-ready:code:locked");

    await act(async () => {
      findButtonContaining(renderer!, "Open Artifacts")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "mock-artifacts-tab")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("artifacts-ready:memory");

    await act(async () => {
      findButtonsContaining(renderer!, "Open General")[1]?.props.onClick();
    });
    await flush();
    text = renderTreeText(renderer!);
    expect(text).toContain("command-palette-open");
    expect(text).toContain("general-hub-ready:general");

    await act(async () => {
      findButtonContaining(renderer!, "Run first command")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("command-palette-open");

    await act(async () => {
      findButtonContaining(renderer!, "Command Palette")?.props.onClick();
    });
    await flush();
    await act(async () => {
      findButtonContaining(renderer!, "Show developer diagnostics")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("dev-diagnostics-ready");

    await act(async () => {
      findButtonContaining(renderer!, "mock-close-dev-diagnostics")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("dev-diagnostics-ready");

    await act(async () => {
      findButtonContaining(renderer!, "Run first command")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("command-palette-open");

    const statusToggle = renderer!.root.find(
      (node) =>
        node.type === "button" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("shell-status-center-trigger"),
    );
    await act(async () => {
      statusToggle.props.onClick?.();
    });
    await flush();

    await act(async () => {
      findButtonContainingWithClass(renderer!, "Open queue", "shell-status-entry-card")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("approvals-ready");

    await act(async () => {
      findButtonContainingWithClass(renderer!, "Open tasks", "shell-status-entry-card")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("tasks-ready");

    await act(async () => {
      findButtonContainingWithClass(renderer!, "Open health", "shell-status-entry-card")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("health-ready:costs");

    await act(async () => {
      findButtonContainingWithClass(renderer!, "Open agents", "shell-status-entry-card")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).toContain("agents-hub-ready:overview");

    await act(async () => {
      onEvent?.({
        eventId: "evt-dismiss-device",
        sequence: 401,
        eventType: "auth_device_request_created",
        source: "auth",
        timestamp: new Date().toISOString(),
        payload: {
          approvalId: "approval-device-dismiss",
          requestId: "request-device-dismiss",
          deviceLabel: "Dismissed Phone",
        },
      });
    });
    await flush();
    text = renderTreeText(renderer!);
    expect(text).toContain("device-access-modal:");
    expect(text).toContain("Dismissed Phone");

    await act(async () => {
      findButtonContaining(renderer!, "dismiss device access")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("device-access-modal:");

    await act(async () => {
      onEvent?.({
        eventId: "evt-reject-remote",
        sequence: 402,
        eventType: "approval_remote_action_ready",
        source: "approvals",
        timestamp: new Date().toISOString(),
        payload: {
          payload: {
            approvalId: "apr-remote-reject",
            tokenId: "rat-remote-reject",
            token: "remote_reject_token",
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "pending",
          },
        },
      });
    });
    await flush();
    text = renderTreeText(renderer!);
    expect(text).toContain("remote-approval-modal:");
    expect(text).toContain("tool.invoke");

    await act(async () => {
      findButtonContaining(renderer!, "reject remote approval")?.props.onClick();
    });
    await flush();
    expect(resolveApprovalWithRemoteTokenMock).toHaveBeenCalledWith("remote_reject_token", "reject");

    await act(async () => {
      onEvent?.({
        eventId: "evt-dismiss-remote",
        sequence: 403,
        eventType: "approval_remote_action_ready",
        source: "approvals",
        timestamp: new Date().toISOString(),
        payload: {
          payload: {
            approvalId: "apr-remote-dismiss",
            tokenId: "rat-remote-dismiss",
            token: "remote_dismiss_token",
            kind: "approval",
            riskLevel: "high",
            status: "pending",
          },
        },
      });
    });
    await flush();
    text = renderTreeText(renderer!);
    expect(text).toContain("remote-approval-modal:");
    expect(text).toContain("approval");

    await act(async () => {
      findButtonContaining(renderer!, "dismiss remote approval")?.props.onClick();
    });
    await flush();
    expect(renderTreeText(renderer!)).not.toContain("remote-approval-modal:");
  }, 15_000);

  it("uses desktop secondary navigation callbacks when the rail shell is available", async () => {
    const { App } = await appModulePromise;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width: 1100px"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(<App />);
    });
    await flush();

    expect(await waitForTreeText(renderer!, "chat-ready:chat:locked")).toContain("chat-ready:chat:locked");

    await act(async () => {
      findButtonContainingWithClass(renderer!, "Code", "surface-nav-item")?.props.onClick();
    });
    await flush();

    expect(renderTreeText(renderer!)).toContain("chat-ready:code:locked");
  }, 15_000);

  it("refreshes shell status from the surface refresh subscription callback", async () => {
    const { App } = await appModulePromise;
    const { UiPreferencesProvider } = await import("./state/ui-preferences");
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = mount(
        <UiPreferencesProvider>
          <App />
        </UiPreferencesProvider>,
      );
    });
    await flush();

    expect(await waitForTreeText(renderer!, "chat-ready:chat:locked")).toContain("chat-ready:chat:locked");
    expect(refreshSubscriptionMocks.options.get("surface")).toEqual(expect.objectContaining({ enabled: true }));

    fetchDashboardStateMock.mockResolvedValueOnce({
      timestamp: new Date().toISOString(),
      sessions: [],
      pendingApprovals: 0,
      activeSubagents: 4,
      taskStatusCounts: [{ status: "running", count: 2 }],
      recentEvents: [],
      dailyCostUsd: 1.25,
    });

    await act(async () => {
      await refreshSubscriptionMocks.callbacks.get("surface")?.({
        topic: "surface",
        reason: "manual-test",
        timestamp: Date.now(),
      });
    });
    await flush();

    const statusToggle = renderer!.root.find(
      (node) =>
        node.type === "button" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("shell-status-center-trigger"),
    );
    await act(async () => {
      statusToggle.props.onClick?.();
    });
    await flush();

    const text = renderTreeText(renderer!);
    expect(text).toContain("4 runtimes");
    expect(text).toContain("$1.25");
    expect(text).toContain("Review linked work and blockers.");
  }, 15_000);

  it("returns to Chat from a page render failure", async () => {
    const { App } = await appModulePromise;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    appPageBehavior.promptLabShouldThrow = true;
    window.location.search = "?space=observe&page=quality";
    window.location.href = "http://localhost:5173/?space=observe&page=quality";
    preflightGatewayAccessMock.mockResolvedValue(createReadyPreflightResult());

    let renderer: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = mount(<App />);
      });
      await flush();

      let text = await waitForTreeText(renderer!, "Page unavailable");
      expect(text).toContain("Page unavailable");
      expect(text).toContain("Quality");
      expect(text).toContain("hit a render failure.");

      await act(async () => {
        findButtonContaining(renderer!, "Return to Chat")?.props.onClick();
      });
      await flush();

      text = await waitForTreeText(renderer!, "chat-ready:chat:locked");
      expect(text).toContain("chat-ready:chat:locked");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  }, 15_000);
});
