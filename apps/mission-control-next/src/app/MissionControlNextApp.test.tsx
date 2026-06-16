import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted(() => ({
  activeWorkspaceId: "workspace-1",
  closeEventStream: vi.fn(),
  connectEventStream: vi.fn(),
  consumeGatewayAccessBootstrapFromLocation: vi.fn(),
  deriveRealtimeNotification: vi.fn(),
  deriveRealtimeRefresh: vi.fn(),
  emitRefresh: vi.fn(),
  fetchDashboardState: vi.fn(),
  fetchHealthSummary: vi.fn(),
  fetchRuntimeLifecycleExport: vi.fn(),
  fetchWorkspaces: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(),
  preflightGatewayAccess: vi.fn(),
  publishEventStreamStatus: vi.fn(),
  publishChannelActivityFromRealtimeEvent: vi.fn(),
  resetEventStreamStatus: vi.fn(),
  resetChannelActivitySnapshots: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
  setDetailPanelPinned: vi.fn(),
  setMode: vi.fn(),
  setNotificationDesktopEnabled: vi.fn(),
  setNotificationOnlyWhenUnfocused: vi.fn(),
  setNotificationSoundMode: vi.fn(),
  setNotificationToastsEnabled: vi.fn(),
  setTheme: vi.fn(),
  playOperatorAttentionSound: vi.fn(),
  streamCallbacks: {} as {
    onEvent?: (event: unknown) => void;
    onStateChange?: (state: string) => void;
    onStatusChange?: (status: unknown) => void;
  },
}));

vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  connectEventStream: appMocks.connectEventStream,
  consumeGatewayAccessBootstrapFromLocation: appMocks.consumeGatewayAccessBootstrapFromLocation,
  fetchWorkspaces: appMocks.fetchWorkspaces,
  getGatewayApiBaseUrl: appMocks.getGatewayApiBaseUrl,
  preflightGatewayAccess: appMocks.preflightGatewayAccess,
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchDashboardState: appMocks.fetchDashboardState,
  fetchHealthSummary: appMocks.fetchHealthSummary,
  fetchRuntimeLifecycleExport: appMocks.fetchRuntimeLifecycleExport,
}));

vi.mock("@goatcitadel/mission-control-shared/components/GatewayAccessGate", () => ({
  GatewayAccessGate: ({
    access,
    busy,
    autoRetryPending,
    onRetry,
  }: {
    access: { status: string; message: string };
    busy: boolean;
    autoRetryPending?: boolean;
    onRetry: () => void;
  }) =>
    createElement(
      "section",
      {
        className: "mock-gateway-access",
        "data-status": access.status,
        "data-busy": String(busy),
        "data-auto-retry": String(Boolean(autoRetryPending)),
      },
      createElement("span", null, access.message),
      createElement("button", { type: "button", onClick: onRetry }, "Retry"),
    ),
}));

vi.mock("@goatcitadel/mission-control-shared/components/NotificationStack", () => ({
  NotificationStack: ({
    items,
    onDismiss,
  }: {
    items: Array<{ id: string; message: string }>;
    onDismiss: (id: string) => void;
  }) =>
    createElement(
      "div",
      { className: "mock-notifications" },
      items.map((item) =>
        createElement("button", { key: item.id, type: "button", onClick: () => onDismiss(item.id) }, item.message),
      ),
    ),
  upsertNotificationItem: (
    items: Array<{ id: string; groupKey?: string }>,
    item: { id: string; groupKey?: string },
  ) => {
    if (!item.groupKey) {
      return [...items, item];
    }
    return [...items.filter((current) => current.groupKey !== item.groupKey), item];
  },
}));

vi.mock("@goatcitadel/mission-control-shared/components/PageErrorBoundary", () => ({
  PageErrorBoundary: ({ children, onReturnToChat }: { children: ReactNode; onReturnToChat: () => void }) =>
    createElement(
      "div",
      { className: "mock-error-boundary" },
      children,
      createElement("button", { type: "button", onClick: onReturnToChat }, "Boundary return to chat"),
    ),
}));

vi.mock("@goatcitadel/mission-control-shared/components/SideInspectorDrawer", () => ({
  SideInspectorDrawer: ({
    children,
    actions,
    title,
    onClose,
    onTogglePinned,
  }: {
    children: ReactNode;
    actions?: ReactNode;
    title: ReactNode;
    onClose: () => void;
    onTogglePinned: () => void;
  }) =>
    createElement(
      "aside",
      { className: "mock-inspector" },
      createElement("h2", null, title),
      actions,
      children,
      createElement("button", { type: "button", onClick: onTogglePinned }, "Pin"),
      createElement("button", { type: "button", onClick: onClose }, "Close"),
    ),
}));

vi.mock("@goatcitadel/mission-control-shared/components/ShellDetailPanelContext", () => ({
  ShellDetailPanelProvider: ({
    children,
    onOpenPanel,
    onClosePanel,
  }: {
    children: ReactNode;
    onOpenPanel: () => void;
    onClosePanel: () => void;
  }) =>
    createElement(
      "div",
      { className: "mock-detail-provider" },
      createElement("button", { type: "button", onClick: onOpenPanel }, "Detail provider open"),
      createElement("button", { type: "button", onClick: onClosePanel }, "Detail provider close"),
      children,
    ),
}));

vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    mode: "simple",
    setMode: appMocks.setMode,
    density: "comfortable",
    effectsMode: "standard",
    showTechnicalDetails: true,
    detailPanelPinned: false,
    setDetailPanelPinned: appMocks.setDetailPanelPinned,
    activeWorkspaceId: appMocks.activeWorkspaceId,
    setActiveWorkspaceId: appMocks.setActiveWorkspaceId,
    theme: "dark",
    setTheme: appMocks.setTheme,
    notifications: {
      toastsEnabled: true,
      soundMode: "off",
      desktopEnabled: false,
      onlyWhenUnfocused: false,
    },
    setNotificationToastsEnabled: appMocks.setNotificationToastsEnabled,
    setNotificationSoundMode: appMocks.setNotificationSoundMode,
    setNotificationDesktopEnabled: appMocks.setNotificationDesktopEnabled,
    setNotificationOnlyWhenUnfocused: appMocks.setNotificationOnlyWhenUnfocused,
  }),
}));

vi.mock("@goatcitadel/mission-control-shared/state/operator-attention", () => ({
  playOperatorAttentionSound: appMocks.playOperatorAttentionSound,
}));

vi.mock("@goatcitadel/mission-control-shared/state/effects-mode", () => ({
  resolveEffectiveEffectsMode: (mode: string) => mode,
}));

vi.mock("@goatcitadel/mission-control-shared/state/refresh-bus", () => ({
  emitRefresh: appMocks.emitRefresh,
}));

vi.mock("@goatcitadel/mission-control-shared/state/event-stream-status-store", () => ({
  publishEventStreamStatus: appMocks.publishEventStreamStatus,
  resetEventStreamStatus: appMocks.resetEventStreamStatus,
}));

vi.mock("@goatcitadel/mission-control-shared/state/channel-activity-store", () => ({
  publishChannelActivityFromRealtimeEvent: appMocks.publishChannelActivityFromRealtimeEvent,
  resetChannelActivitySnapshots: appMocks.resetChannelActivitySnapshots,
}));

vi.mock("@goatcitadel/mission-control-shared/state/realtime-derived", () => ({
  deriveRealtimeNotification: appMocks.deriveRealtimeNotification,
  deriveRealtimeRefresh: appMocks.deriveRealtimeRefresh,
}));

vi.mock("./lazy-legacy-pages", () => ({
  LazyNativeRoutePages: ({ route }: { route: { area: string; section?: string } }) =>
    createElement("div", { className: "mock-native-route" }, `Native ${route.area}/${route.section ?? "root"}`),
  LazyPromptPacksWorkbenchPage: ({ variant }: { variant: string }) =>
    createElement("div", { className: "mock-prompt-packs" }, `Prompt packs ${variant}`),
  LazyThreadedSurfaceRoute: ({
    surface,
    onOpenApprovals,
    onOpenStartHere,
  }: {
    surface: string;
    onOpenApprovals?: (approvalId?: string) => void;
    onOpenStartHere?: () => void;
  }) =>
    createElement(
      "div",
      { className: "mock-threaded-route" },
      `Threaded ${surface}`,
      createElement(
        "button",
        { type: "button", onClick: () => onOpenApprovals?.("approval-focused-1") },
        "Open focused approval",
      ),
      createElement("button", { type: "button", onClick: () => onOpenStartHere?.() }, "Open threaded Start Here"),
    ),
  preloadNativeRoutePages: vi.fn(() => Promise.resolve()),
  preloadPromptPacksWorkbenchPage: vi.fn(() => Promise.resolve()),
  preloadThreadedSurfaceRoute: vi.fn(() => Promise.resolve()),
}));

function installBrowser(href: string): void {
  const location = new URL(href);
  const classSet = () => {
    const values = new Set<string>();
    return {
      add: (...classes: string[]) => {
        for (const value of classes) values.add(value);
      },
      remove: (...classes: string[]) => {
        for (const value of classes) values.delete(value);
      },
      contains: (value: string) => values.has(value),
      toString: () => Array.from(values).join(" "),
    };
  };
  const updateLocation = (next: string) => {
    const nextUrl = new URL(next, location.origin);
    location.href = nextUrl.href;
    location.pathname = nextUrl.pathname;
    location.search = nextUrl.search;
    location.hash = nextUrl.hash;
  };

  vi.stubGlobal("window", {
    location,
    history: {
      pushState: vi.fn((_state: unknown, _title: string, next: string) => updateLocation(next)),
      replaceState: vi.fn((_state: unknown, _title: string, next: string) => updateLocation(next)),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
  vi.stubGlobal("document", {
    title: "",
    documentElement: { classList: classSet() },
    body: { classList: classSet() },
    activeElement: null,
  });
  vi.stubGlobal("HTMLElement", class HTMLElement {});
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderApp(href = "http://localhost:5173/chat?sessionId=session-1&turnId=turn-1") {
  installBrowser(href);
  vi.resetModules();
  const { MissionControlNextApp } = await import("./MissionControlNextApp");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(MissionControlNextApp));
  });
  await flush();
  return renderer;
}

function findButton(renderer: ReactTestRenderer, text: string) {
  const button = renderer.root.findAllByType("button").find((node) => readNodeText(node).includes(text));
  if (!button) {
    throw new Error(`Missing button ${text}`);
  }
  return button;
}

function readNodeText(node: { children?: unknown[] } | string | number | null | undefined): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || !Array.isArray(node.children)) {
    return "";
  }
  return node.children.map((child) => readNodeText(child as never)).join("");
}

describe("MissionControlNextApp", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    appMocks.activeWorkspaceId = "workspace-1";
    appMocks.closeEventStream.mockReset();
    appMocks.connectEventStream.mockImplementation((onEvent, onStateChange, onStatusChange) => {
      appMocks.streamCallbacks.onEvent = onEvent;
      appMocks.streamCallbacks.onStateChange = onStateChange;
      appMocks.streamCallbacks.onStatusChange = onStatusChange;
      return appMocks.closeEventStream;
    });
    appMocks.consumeGatewayAccessBootstrapFromLocation.mockReturnValue({ consumed: false });
    appMocks.deriveRealtimeRefresh.mockReturnValue({
      topics: ["surface", "approvals"],
      signalReason: "test-refresh",
      signalEventType: "task.updated",
      truthMode: "authoritative",
    });
    appMocks.deriveRealtimeNotification.mockReturnValue({
      tone: "info",
      message: "Realtime task update",
      groupKey: "task",
      soundCue: "soft_update",
    });
    appMocks.fetchDashboardState.mockResolvedValue({
      pendingApprovals: 2,
      activeSubagents: 3,
      dailyCostUsd: 1.25,
      sessions: [{ sessionId: "session-1" }, { sessionId: "session-2" }],
      taskStatusCounts: [
        { status: "open", count: 4 },
        { status: "done", count: 1 },
      ],
    });
    appMocks.fetchHealthSummary.mockResolvedValue({
      daemonStatus: { running: false },
    });
    appMocks.fetchRuntimeLifecycleExport.mockResolvedValue({
      trustReport: { shareableMarkdown: "# Trust\n\nReady." },
    });
    appMocks.fetchWorkspaces.mockResolvedValue({
      items: [
        { workspaceId: "workspace-2", name: "Workspace Two" },
        { workspaceId: "workspace-1", name: "Workspace One" },
      ],
    });
    appMocks.getGatewayApiBaseUrl.mockReturnValue("http://localhost:8787");
    appMocks.preflightGatewayAccess.mockResolvedValue({
      status: "ready",
      message: "Gateway ready",
      healthDetail: "ok",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps topbar chrome shrink-safe instead of clipping right-side controls", () => {
    const css = readFileSync(new URL("../styles/mission-control-next.css", import.meta.url), "utf8").replaceAll(
      "\r\n",
      "\n",
    );

    expect(css).toContain(".mc-next-topbar-left {\n  flex: 1 1 auto;");
    expect(css).toContain(".mc-next-topbar-right {\n  flex: 0 1 auto;");
    expect(css).toContain(".mc-next-primary-nav {\n  display: inline-flex;");
    expect(css).toContain("overflow-x: auto;");
    expect(css).toContain(".mc-next-command-search {\n  order: -1;\n  flex: 1 1 18rem;\n  min-width: 9rem;");
  });

  it("renders access-gate states and lets retry recover from preflight failures", async () => {
    appMocks.preflightGatewayAccess
      .mockRejectedValueOnce(new Error("gateway offline"))
      .mockResolvedValueOnce({ status: "needs-auth", message: "Auth required", healthDetail: "token" });

    const renderer = await renderApp();
    expect(renderer.root.findByProps({ className: "mock-gateway-access" }).props["data-status"]).toBe("unreachable");

    await act(async () => {
      findButton(renderer, "Retry").props.onClick();
    });
    await flush();

    const gate = renderer.root.findByProps({ className: "mock-gateway-access" });
    expect(gate.props["data-status"]).toBe("needs-auth");
    expect(readNodeText(gate)).toContain("Auth required");
  });

  it("auto-retries transient unreachable gateway preflight failures", async () => {
    vi.useFakeTimers();
    appMocks.preflightGatewayAccess
      .mockRejectedValueOnce(new Error("gateway restarting"))
      .mockResolvedValueOnce({ status: "ready", message: "Gateway ready", healthDetail: "ok" });

    const renderer = await renderApp();
    const gate = renderer.root.findByProps({ className: "mock-gateway-access" });
    expect(gate.props["data-status"]).toBe("unreachable");
    expect(gate.props["data-auto-retry"]).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();

    expect(appMocks.preflightGatewayAccess).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
  });

  it("renders the ready shell, handles navigation, realtime updates, and trust-report export", async () => {
    const renderer = await renderApp();

    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
    expect(appMocks.fetchWorkspaces).toHaveBeenCalledWith("all", 400);
    expect(appMocks.fetchDashboardState).toHaveBeenCalled();
    expect(appMocks.connectEventStream).toHaveBeenCalled();

    await act(async () => {
      appMocks.streamCallbacks.onStateChange?.("open");
      appMocks.streamCallbacks.onEvent?.({
        eventId: "evt-1",
        eventType: "task.updated",
        source: "gateway",
      });
    });
    expect(appMocks.emitRefresh).toHaveBeenCalledWith(
      "surface",
      expect.objectContaining({ reason: "test-refresh", eventId: "evt-1" }),
    );
    expect(appMocks.publishChannelActivityFromRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-1" }),
    );

    await act(async () => {
      findButton(renderer, "Guided").props.onClick();
      renderer.root.findByProps({ "aria-label": "Switch to light theme" }).props.onClick();
      findButton(renderer, "Open Context").props.onClick();
    });
    expect(appMocks.setMode).toHaveBeenCalledWith("advanced");
    expect(appMocks.setTheme).toHaveBeenCalledWith("light");
    expect(findButton(renderer, "Search commands").props["aria-label"]).toBe("Open command palette");
    expect(JSON.stringify(renderer.toJSON())).toContain("Copy trust report");

    await act(async () => {
      findButton(renderer, "Copy trust report").props.onClick();
    });
    await flush();
    expect(appMocks.fetchRuntimeLifecycleExport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1", format: "trust_report" }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("# Trust\n\nReady.");

    await act(async () => {
      findButton(renderer, "Detail provider close").props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Copy trust report");

    await act(async () => {
      findButton(renderer, "Detail provider open").props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Copy trust report");

    await act(async () => {
      findButton(renderer, "Pin").props.onClick();
      findButton(renderer, "Close").props.onClick();
    });
    expect(appMocks.setDetailPanelPinned).toHaveBeenCalledWith(true);

    await act(async () => {
      findButton(renderer, "Open Context").props.onClick();
      renderer.root
        .findAllByType("button")
        .find((node) => String(node.props.className).includes("mc-next-inspector-scrim"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Copy trust report");

    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => String(node.props.className).includes("mc-next-nav-toggle"))
        ?.props.onClick();
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-rail-link") &&
            !String(node.props.className).includes("active"),
        )
        ?.props.onClick();
      renderer.root
        .findAllByType("button")
        .find((node) => String(node.props.className).includes("mc-next-rail-close"))
        ?.props.onClick();
      renderer.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "Open notifications")
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/ops/notifications");
    expect(readNodeText(renderer.root.findByProps({ "aria-label": "Open notifications" }))).toBe("2");
    expect(appMocks.playOperatorAttentionSound).toHaveBeenCalledWith("soft_update", "off");

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Enable notification sounds" }).props.onClick();
    });
    expect(appMocks.setNotificationSoundMode).toHaveBeenCalledWith("normal");

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open approvals" }).props.onClick();
    });
    expect(window.location.pathname).toBe("/ops/approvals");

    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-status-pill-action") &&
            readNodeText(node).includes("2 pending"),
        )
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/ops/approvals");

    const workspaceSelect = renderer.root.findByType("select");
    await act(async () => {
      workspaceSelect.props.onChange({ target: { value: "workspace-2" } });
    });
    expect(appMocks.setActiveWorkspaceId).toHaveBeenCalledWith("workspace-2");

    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-primary-link") && readNodeText(node).includes("Code"),
        )
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/code");

    await act(async () => {
      findButton(renderer, "Open threaded Start Here").props.onClick();
    });
    expect(window.location.pathname).toBe("/settings/onboarding");

    await act(async () => {
      findButton(renderer, "Start Here").props.onClick();
    });
    expect(window.location.pathname).toBe("/settings/onboarding");

    await act(async () => {
      findButton(renderer, "Boundary return to chat").props.onClick();
    });
    expect(window.location.pathname).toBe("/chat");

    const popstateHandler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([eventName]) => eventName === "popstate",
    )?.[1] as (() => void) | undefined;
    window.history.pushState(null, "", "/chat?sessionId=session-2");
    await act(async () => {
      popstateHandler?.();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
  });

  it("does not treat unknown daemon health as an intervention", async () => {
    appMocks.fetchHealthSummary.mockImplementationOnce(() => new Promise(() => undefined));

    const renderer = await renderApp();
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain("Checking");
    expect(rendered).toContain("2 visible");
    expect(rendered).not.toContain("Needs intervention");
  });

  it("marks daemon health unavailable when status refresh fails", async () => {
    appMocks.fetchHealthSummary.mockRejectedValueOnce(new Error("health offline"));

    const renderer = await renderApp();
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain("Unavailable");
    expect(rendered).not.toContain("Needs intervention");
  });

  it("keeps the daemon Serving but marks dashboard-derived pills unavailable when only dashboard refresh fails (F-H4)", async () => {
    appMocks.fetchDashboardState.mockRejectedValueOnce(new Error("dashboard offline"));
    appMocks.fetchHealthSummary.mockResolvedValueOnce({
      daemonStatus: { running: true },
    });

    const renderer = await renderApp("http://localhost:5173/settings/providers");
    const tree = renderer.toJSON();
    const rendered = JSON.stringify(tree);

    // Daemon health is independent of the dashboard, so the daemon pill stays
    // "Serving" (it is not affected by the dashboard failure).
    expect(rendered).toContain("Serving");

    // F-H4: the dashboard-derived footer pills (approvals/sessions/spend) must
    // not keep presenting retained last-good numbers as current — they read
    // "Unavailable" and carry the degraded marker. The status strip is the only
    // always-visible signal on settings (the stage-header chip is hidden here).
    expect(rendered).toContain("Unavailable");
    expect(rendered).toContain('"data-status":"degraded"');
  });

  it("does not keep stale serving daemon health after a later refresh failure", async () => {
    appMocks.fetchHealthSummary
      .mockResolvedValueOnce({
        daemonStatus: { running: true },
      })
      .mockRejectedValueOnce(new Error("health offline"));

    const renderer = await renderApp();
    expect(JSON.stringify(renderer.toJSON())).toContain("Serving");

    const intervalCallback = (window.setInterval as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    await flush();

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Unavailable");
    expect(rendered).not.toContain("Serving");
  });

  it("ignores older daemon health responses that settle after a newer failed refresh", async () => {
    let resolveInitialHealth!: (value: { daemonStatus: { running: boolean } }) => void;
    const initialHealth = new Promise<{ daemonStatus: { running: boolean } }>((resolve) => {
      resolveInitialHealth = resolve;
    });
    appMocks.fetchHealthSummary
      .mockImplementationOnce(() => initialHealth)
      .mockRejectedValueOnce(new Error("health offline"));

    const renderer = await renderApp();
    expect(JSON.stringify(renderer.toJSON())).toContain("Checking");

    const intervalCallback = (window.setInterval as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    await flush();
    expect(JSON.stringify(renderer.toJSON())).toContain("Unavailable");

    await act(async () => {
      resolveInitialHealth({ daemonStatus: { running: true } });
      await initialHealth;
    });
    await flush();

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Unavailable");
    expect(rendered).not.toContain("Serving");
  });

  it("passes a focused Code approval id through threaded-surface approval navigation", async () => {
    const renderer = await renderApp("http://localhost:5173/code");

    await act(async () => {
      findButton(renderer, "Open focused approval").props.onClick();
    });
    await flush();

    expect(window.location.pathname).toBe("/ops/approvals");
    expect(window.location.search).toContain("approvalId=approval-focused-1");
  });

  it("keeps command-palette area jumps session-scoped without leaking preference theme", async () => {
    const renderer = await renderApp("http://localhost:5173/chat?sessionId=session-1&turnId=turn-1");

    await act(async () => {
      findButton(renderer, "Search commands").props.onClick();
    });

    await act(async () => {
      findButton(renderer, "Go to Cowork").props.onClick();
    });

    expect(window.location.pathname).toBe("/cowork");
    expect(window.location.search).toContain("sessionId=session-1");
    expect(window.location.search).toContain("turnId=turn-1");
    expect(window.location.search).not.toContain("theme=dark");
  });

  it("surfaces replay-gap events as an operator-visible recovery signal", async () => {
    const renderer = await renderApp();
    appMocks.deriveRealtimeRefresh.mockReturnValueOnce({
      topics: ["surface"],
      signalReason: "replay_gap",
      signalEventType: "replay_gap",
      truthMode: "replay-gap",
    });
    appMocks.deriveRealtimeNotification.mockReturnValueOnce({
      tone: "warning",
      message:
        "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
      groupKey: "stream-replay-gap",
    });

    await act(async () => {
      appMocks.streamCallbacks.onStateChange?.("open");
      appMocks.streamCallbacks.onEvent?.({
        eventId: "evt-gap",
        eventType: "replay_gap",
        source: "gateway",
        payload: { kind: "replay_gap" },
      });
    });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Streaming (replay recovery)");
    expect(rendered).toContain(
      "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
    );
  });

  it("covers shell fallback and trust-report warning/error branches", async () => {
    appMocks.activeWorkspaceId = "missing-workspace";
    const noSessionRenderer = await renderApp("http://localhost:5173/chat");
    expect(appMocks.setActiveWorkspaceId).toHaveBeenCalledWith("workspace-2");
    noSessionRenderer.unmount();

    appMocks.fetchRuntimeLifecycleExport.mockRejectedValueOnce(new Error("export offline"));
    const failingRenderer = await renderApp("http://localhost:5173/chat?sessionId=session-err");
    await act(async () => {
      findButton(failingRenderer, "Open Context").props.onClick();
    });
    await act(async () => {
      findButton(failingRenderer, "Copy trust report").props.onClick();
    });
    await flush();

    expect(JSON.stringify(failingRenderer.toJSON())).toContain("Trust report export failed: export offline");

    await act(async () => {
      findButton(failingRenderer, "Trust report export failed: export offline").props.onClick();
    });
    expect(JSON.stringify(failingRenderer.toJSON())).not.toContain("Trust report export failed: export offline");
  });

  it("surfaces release readiness action and verification truth in the route inspector", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/providers");

    await act(async () => {
      findButton(renderer, "Open Context").props.onClick();
    });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Release readiness");
    expect(rendered).toContain("Scope: ");
    expect(rendered).toContain("Release-ready");
    expect(rendered).toContain("Configure provider credentials and run provider/model smoke evidence.");
    expect(rendered).toContain("verify:surface:regression, provider exercise paths");
    expect(rendered).toContain("smoke evidence, model discovery state, and plain failure copy");
  });

  it("dispatches route content for native, prompt-pack, and threaded areas", async () => {
    let renderer = await renderApp("http://localhost:5173/library/prompt-packs?theme=light");
    expect(JSON.stringify(renderer.toJSON())).toContain("Prompt packs library");
    renderer.unmount();

    renderer = await renderApp("http://localhost:5173/cowork/tasks");
    expect(JSON.stringify(renderer.toJSON())).toContain("Native cowork/tasks");
    renderer.unmount();

    renderer = await renderApp("http://localhost:5173/code?sessionId=code-session");
    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded code");
    renderer.unmount();

    renderer = await renderApp("http://localhost:5173/projects/Project-1");
    expect(JSON.stringify(renderer.toJSON())).toContain("Native projects/root");
    renderer.unmount();
  });

  it("covers shell realtime fallback, redirect, and status failure branches", async () => {
    const warningRenderer = await renderApp("http://localhost:5173/chat?sessionId=session-1");
    await act(async () => {
      appMocks.streamCallbacks.onStateChange?.("closed");
    });
    expect(JSON.stringify(warningRenderer.toJSON())).toContain("Polling fallback");
    warningRenderer.unmount();

    appMocks.fetchDashboardState.mockRejectedValueOnce(new Error("status offline"));
    const statusRenderer = await renderApp("http://localhost:5173/settings/providers");
    expect(appMocks.fetchDashboardState).toHaveBeenCalled();
    expect(JSON.stringify(statusRenderer.toJSON())).toContain("Native settings/providers");
    statusRenderer.unmount();

    appMocks.fetchWorkspaces.mockRejectedValueOnce(new Error("workspace offline"));
    const workspaceRenderer = await renderApp("http://localhost:5173/settings/access");
    expect(JSON.stringify(workspaceRenderer.toJSON())).toContain("Native settings/access");
    workspaceRenderer.unmount();

    const qualityRenderer = await renderApp("http://localhost:5173/ops/quality?sessionId=session-1&theme=light");
    expect(window.location.pathname).toBe("/ops/quality");
    expect(JSON.stringify(qualityRenderer.toJSON())).toContain("Native ops/quality");
  });
});
