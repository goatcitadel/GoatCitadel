import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted(() => ({
  activeCitadelId: "personal",
  activeWorkspaceId: "workspace-1",
  authRejectionListener: undefined as
    | ((rejection: { authMode: "token" | "basic"; path: string; status: 401 }) => void)
    | undefined,
  closeEventStream: vi.fn(),
  connectEventStream: vi.fn(),
  consumeGatewayAccessBootstrapFromLocation: vi.fn(),
  deriveRealtimeNotification: vi.fn(),
  deriveRealtimeRefresh: vi.fn(),
  emitRefresh: vi.fn(),
  fetchDashboardState: vi.fn(),
  fetchHealthSummary: vi.fn(),
  fetchRuntimeBuildIdentity: vi.fn(),
  listCitadels: vi.fn(),
  fetchRuntimeLifecycleExport: vi.fn(),
  fetchWorkspaces: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(),
  isCompactTopbar: false,
  isMobileNav: false,
  preflightGatewayAccess: vi.fn(),
  publishEventStreamStatus: vi.fn(),
  publishChannelActivityFromRealtimeEvent: vi.fn(),
  resetEventStreamStatus: vi.fn(),
  resetChannelActivitySnapshots: vi.fn(),
  subscribeGatewayAuthRejection: vi.fn(),
  setActiveCitadelId: vi.fn(),
  setActiveScope: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
  setDetailPanelPinned: vi.fn(),
  setMode: vi.fn(),
  setNotificationDesktopEnabled: vi.fn(),
  setNotificationOnlyWhenUnfocused: vi.fn(),
  setNotificationSoundMode: vi.fn(),
  setNotificationToastsEnabled: vi.fn(),
  setTheme: vi.fn(),
  upsertNotificationPresence: vi.fn(async (input) => input),
  playOperatorAttentionSound: vi.fn(),
  threadedRouteProps: null as null | Record<string, unknown>,
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
  subscribeGatewayAuthRejection: appMocks.subscribeGatewayAuthRejection,
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchDashboardState: appMocks.fetchDashboardState,
  fetchHealthSummary: appMocks.fetchHealthSummary,
  listCitadels: appMocks.listCitadels,
  fetchRuntimeLifecycleExport: appMocks.fetchRuntimeLifecycleExport,
  upsertNotificationPresence: appMocks.upsertNotificationPresence,
}));

vi.mock("@goatcitadel/mission-control-shared/api/review-readiness", () => ({
  fetchRuntimeBuildIdentity: appMocks.fetchRuntimeBuildIdentity,
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
    activeCitadelId: appMocks.activeCitadelId,
    setActiveCitadelId: appMocks.setActiveCitadelId,
    activeWorkspaceId: appMocks.activeWorkspaceId,
    setActiveWorkspaceId: appMocks.setActiveWorkspaceId,
    setActiveScope: appMocks.setActiveScope,
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

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) => (query.includes("1023px") ? appMocks.isMobileNav : appMocks.isCompactTopbar),
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
  LazyThreadedSurfaceRoute: (props: {
    surface: string;
    hidePageHeader?: boolean;
    gatewayStatus?: { label?: string };
    onOpenApprovals?: (approvalId?: string) => void;
    onOpenStartHere?: () => void;
  }) => {
    appMocks.threadedRouteProps = props;
    return createElement(
      "div",
      { className: "mock-threaded-route" },
      `Threaded ${props.surface} ${props.gatewayStatus?.label ?? ""}`,
      createElement(
        "button",
        { type: "button", onClick: () => props.onOpenApprovals?.("approval-focused-1") },
        "Open focused approval",
      ),
      createElement("button", { type: "button", onClick: () => props.onOpenStartHere?.() }, "Open threaded Start Here"),
    );
  },
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

/*
 * Every root rendered by `renderApp` is tracked so `afterEach` can unmount it.
 * A root left mounted keeps running: its shell notification hook holds live
 * `AUTO_DISMISS_TOAST_MS` (6s) timers, and when one fires during a *later* test
 * the dead root re-renders and its `LazyThreadedSurfaceRoute` mock overwrites
 * the module-global `appMocks.threadedRouteProps` with that dead root's props.
 * A test reading a callback off that handle then drives the dead tree, so the
 * notification never reaches the renderer under assertion. That only reproduces
 * once the file's wall clock passes 6s, which is why it stayed green locally and
 * flaked on loaded CI hosts. Unmounting runs the effect cleanups that clear
 * those timers, so no retired root can touch shared state.
 */
const mountedRenderers = new Set<ReactTestRenderer>();

async function renderApp(href = "http://localhost:5173/chat?sessionId=session-1&turnId=turn-1") {
  installBrowser(href);
  vi.resetModules();
  const { MissionControlNextApp } = await import("./MissionControlNextApp");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(MissionControlNextApp));
  });
  mountedRenderers.add(renderer);
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

async function openTopbarMore(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "More controls" }).props.onClick();
  });
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
    appMocks.activeCitadelId = "personal";
    appMocks.activeWorkspaceId = "workspace-1";
    appMocks.isCompactTopbar = false;
    appMocks.isMobileNav = false;
    appMocks.threadedRouteProps = null;
    appMocks.authRejectionListener = undefined;
    appMocks.closeEventStream.mockReset();
    appMocks.connectEventStream.mockImplementation((onEvent, onStateChange, onStatusChange) => {
      appMocks.streamCallbacks.onEvent = onEvent;
      appMocks.streamCallbacks.onStateChange = onStateChange;
      appMocks.streamCallbacks.onStatusChange = onStatusChange;
      return appMocks.closeEventStream;
    });
    appMocks.consumeGatewayAccessBootstrapFromLocation.mockReturnValue({ consumed: false });
    appMocks.subscribeGatewayAuthRejection.mockImplementation((listener) => {
      appMocks.authRejectionListener = listener;
      return () => {
        appMocks.authRejectionListener = undefined;
      };
    });
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
    appMocks.fetchRuntimeBuildIdentity.mockResolvedValue({
      schemaVersion: 1,
      kind: "packaged",
      version: "1.0.0",
      buildSha: "a".repeat(40),
      shortSha: "a".repeat(8),
      integrity: "clean",
      identitySource: "packaged_manifest",
      release: {
        verified: false,
        certificateState: "absent",
        requiredProof: { total: 25, passed: 0, missing: 25, failed: 0, stale: 0 },
        acceptedFailureCount: 0,
        acceptedFailures: [],
        reasonCodes: ["certificate_absent"],
        reasons: ["No release certificate is available to the running Gateway."],
      },
    });
    appMocks.listCitadels.mockResolvedValue({
      items: [
        { citadelId: "personal", name: "Personal" },
        { citadelId: "company", name: "Company" },
      ],
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
    // Retire every root this test mounted before the stubbed globals go away,
    // so cleanup effects still see `window`/`document` and their toast timers
    // cannot fire into a later test. Unmounting twice is a no-op, so tests that
    // already unmount explicitly stay valid.
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps topbar chrome shrink-safe instead of clipping right-side controls", () => {
    const css = readFileSync(new URL("../styles/mission-control-next.css", import.meta.url), "utf8").replaceAll(
      "\r\n",
      "\n",
    );

    expect(css).toContain(".mc-next-topbar-left {\n  flex: 1 1 auto;");
    expect(css).toContain(".mc-next-topbar-right {\n  flex: 0 1 min(52rem, 62vw);");
    expect(css).toContain(".mc-next-primary-nav {\n  display: inline-flex;");
    expect(css).toContain("overflow-x: auto;");
    expect(css).toContain(".mc-next-command-search {\n  order: -1;\n  flex: 1 1 12rem;");
    expect(css).toContain("min-width: 3rem;");
    expect(css).toContain(".mc-next-topbar-right > .mc-next-icon-button {");
    expect(css).not.toContain(".mc-next-topbar-right > button:not(.mc-next-command-search)");
    // F1: lower-priority controls collapse into the overflow ⋯ More menu at the
    // laptop breakpoint, while text badges stay outside the icon-only selector.
    expect(css).toContain(".mc-next-topbar-more-menu {");
    expect(css).toContain("z-index: var(--z-dropdown);");
    expect(css).toContain(".mc-dialog-overlay {");
    expect(css).toContain("z-index: var(--z-modal);");
    expect(css).toContain(".mc-dialog-content {");
    expect(css).toContain("transform: translate(-50%, -50%);");
    expect(css).toContain("@media (max-width: 1180px) {");
    expect(css).toContain(".mc-next-topbar-status .mc-next-badge-label {\n    display: inline;");
    // Guardrail: the restored quick-glance status cluster (release scope /
    // degraded-realtime / approvals) must never be silently re-hidden.
    expect(css).not.toContain(".mc-next-topbar-status {\n  display: none;");
    expect(css).not.toContain(
      ".mc-next-topbar-right > button.mc-next-start-button,\n.mc-next-topbar-right > button.mc-next-mode-toggle {\n  display: none;",
    );
    // HX-303: identity is pinned outside the scrollable metrics and switches
    // to a compact visual token at the mobile breakpoint. It shares the row
    // with a non-shrinking Gateway pill and the labeled Details control.
    expect(css).toContain(".mc-next-status-strip-identity {");
    expect(css).toContain("flex: 1 1 0;");
    expect(css).toContain("overflow: hidden;");
    expect(css).toContain(".mc-next-status-strip-primary {\n    flex: 0 0 auto;");
    expect(css).toContain(".mc-next-status-strip-identity .mc-next-status-value-compact {");
    expect(css).toContain("display: block !important;");
    expect(css).toContain(".mc-next-shell .mc-next-status-strip {");
    expect(css).toContain("position: fixed;");
    // Detail and status values must not wrap character-by-character and expand
    // the fixed mobile strip.
    expect(css).toContain(
      ".mc-next-shell .mc-next-status-details summary strong {\n    flex: 0 0 auto;\n    min-width: max-content;",
    );
    expect(css).toContain("white-space: nowrap;\n    overflow-wrap: normal;");
    expect(css).toContain(".mc-next-status-strip-primary .mc-next-status-pill {\n    max-width: none;");
    expect(css).toContain(".mc-next-status-details summary > span {\n    display: inline;");
  });

  it("keeps non-work routes inside the bounded stage scroller", () => {
    const css = readFileSync(new URL("../styles/mission-control-next.css", import.meta.url), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    const nativeCss = readFileSync(
      new URL("../features/native-routes/styles/03-shared-native-primitives.css", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");

    expect(css).toContain(".mc-next-body:not(.is-work-area) {\n  align-items: stretch;\n  overflow: hidden;\n}");
    expect(css).toContain(
      ".mc-next-stage:not(.mc-next-stage-work) {\n  background: color-mix(in oklab, var(--background) 94%, var(--mc-surface-2));\n  height: 100%;\n  overflow: hidden;\n}",
    );
    expect(css).toContain(
      ".mc-next-stage:not(.mc-next-stage-work) .mc-next-stage-scroll {\n  height: 100%;\n  padding: 0.85rem 0.85rem 2.75rem;\n  overflow: auto;",
    );
    expect(css).toContain("scrollbar-gutter: stable;");
    expect(nativeCss).toContain("overflow: auto;\n  overscroll-behavior-x: contain;\n  overscroll-behavior-y: auto;");
    expect(css).toMatch(
      /\.mc-next-stage:not\(\.mc-next-stage-work\) \.mc-next-stage-scroll\s*\{[\s\S]*?overscroll-behavior: contain;/,
    );
    expect(css).toMatch(/\.mc-gc-combobox-list\s*\{[\s\S]*?overscroll-behavior: contain;/);
    expect(css).toMatch(/\.mc-next-shell-inspector\.side-inspector-drawer\s*\{[\s\S]*?overscroll-behavior: contain;/);
  });

  it("keeps passive notification copy from blocking operator controls", () => {
    const css = readFileSync(new URL("../styles/mission-control-next.css", import.meta.url), "utf8").replaceAll(
      "\r\n",
      "\n",
    );

    expect(css).toMatch(/\.notification-stack\s*\{[\s\S]*?pointer-events: none;/u);
    expect(css).toMatch(/\.notification-dismiss\s*\{[\s\S]*?pointer-events: auto;/u);
  });

  it("keeps the build identity action in compact shell chrome and links it to Ops proof", async () => {
    appMocks.isCompactTopbar = true;
    appMocks.isMobileNav = true;
    const renderer = await renderApp();
    const chip = renderer.root
      .findAllByType("button")
      .find((node) => String(node.props["aria-label"] ?? "").startsWith("Build identity:"));

    expect(chip).toBeDefined();
    expect(chip?.props["aria-label"]).toContain("Packaged · v1.0.0 · aaaaaaaa · proof unverified");
    expect(chip?.props["data-identity-status"]).toBe("unverified");

    await act(async () => chip?.props.onClick());
    expect(window.location.pathname).toBe("/ops/diagnostics");
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

  it("renders the ready shell and handles navigation and realtime updates", async () => {
    const renderer = await renderApp();

    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
    expect(appMocks.threadedRouteProps).toMatchObject({
      gatewayStatus: expect.objectContaining({
        ready: true,
        label: "Gateway ready",
      }),
      onCopyTrustReport: expect.any(Function),
    });
    expect(appMocks.fetchWorkspaces).toHaveBeenCalledWith("all", 400, "personal");
    expect(appMocks.fetchDashboardState).toHaveBeenCalled();
    expect(appMocks.connectEventStream).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ "aria-label": "Approvals: 2 pending" })).toHaveLength(2);
    expect(renderer.root.findByProps({ "aria-label": "Sessions: 2 visible" })).toBeDefined();
    expect(renderer.root.findByProps({ "aria-label": "Spend: $1.25" })).toBeDefined();

    await act(async () => {
      (appMocks.threadedRouteProps?.onCopyTrustReport as (sessionId: string, turnId: string) => void)(
        "session-1",
        "turn-1",
      );
    });
    await flush();
    expect(appMocks.fetchRuntimeLifecycleExport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1", format: "trust_report" }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("# Trust\n\nReady.");

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

    await openTopbarMore(renderer);
    await act(async () => {
      findButton(renderer, "Switch to Expert mode").props.onClick();
      renderer.root.findByProps({ "aria-label": "Switch to light theme" }).props.onClick();
    });
    expect(appMocks.setMode).toHaveBeenCalledWith("advanced");
    expect(appMocks.setTheme).toHaveBeenCalledWith("light");
    // F10: the Cmd/Ctrl+K trigger, its accessible name, and the dialog it opens
    // all read "Command Palette" (visible label matches accessible name).
    expect(findButton(renderer, "Command Palette").props["aria-label"]).toBe("Command Palette");
    expect(renderer.root.findAllByProps({ "aria-label": "Open Route details" })).toHaveLength(0);

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

    await openTopbarMore(renderer);
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

    const selects = renderer.root.findAllByType("select");
    const citadelSelect = selects.find((node) => node.props.value === "personal");
    const workspaceSelect = selects.find((node) => node.props.value === "workspace-1");
    expect(citadelSelect).toBeDefined();
    expect(workspaceSelect).toBeDefined();
    await act(async () => {
      workspaceSelect?.props.onChange({ target: { value: "workspace-2" } });
    });
    expect(appMocks.setActiveWorkspaceId).toHaveBeenCalledWith("workspace-2");

    // Code is no longer a primary-nav area; it is reached via /chat?mode=code.
    // Verify the unified Work primary-nav area navigates to /chat.
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-primary-link") && readNodeText(node).includes("Work"),
        )
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/chat");

    await act(async () => {
      findButton(renderer, "Open threaded Start Here").props.onClick();
    });
    expect(window.location.pathname).toBe("/settings/onboarding");

    await openTopbarMore(renderer);
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

    await act(async () => {
      citadelSelect?.props.onChange({ target: { value: "company" } });
    });
    expect(appMocks.setActiveCitadelId).toHaveBeenCalledWith("company");
    expect(JSON.stringify(renderer.toJSON())).toContain("Loading Personal workspaces");
  });

  it("returns to the access gate and closes realtime when active credentials are rejected", async () => {
    const renderer = await renderApp();
    expect(appMocks.connectEventStream).toHaveBeenCalled();
    expect(appMocks.authRejectionListener).toBeTypeOf("function");

    act(() => {
      appMocks.authRejectionListener?.({
        authMode: "token",
        path: "/api/v1/dashboard/state",
        status: 401,
      });
    });

    const gate = renderer.root.findByProps({ className: "mock-gateway-access" });
    expect(gate.props["data-status"]).toBe("needs-auth");
    expect(readNodeText(gate)).toContain("Gateway credentials were rejected");
    expect(appMocks.closeEventStream).toHaveBeenCalled();
  });

  it("pauses scoped routes when the active Citadel has no workspaces", async () => {
    appMocks.activeCitadelId = "company";
    appMocks.activeWorkspaceId = "default";
    appMocks.fetchWorkspaces.mockResolvedValue({ items: [] });

    const renderer = await renderApp("http://localhost:5173/projects");
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain("Company needs a workspace");
    expect(rendered).not.toContain("Native projects/root");
    const workspaceSelect = renderer.root.findByProps({ "aria-label": "Active Workspace" });
    expect(workspaceSelect.props.disabled).toBe(true);
    expect(readNodeText(workspaceSelect)).toContain("No workspaces");
    expect(appMocks.setActiveScope).not.toHaveBeenCalled();

    await act(async () => {
      findButton(renderer, "Create workspace").props.onClick();
    });
    expect(window.location.pathname).toBe("/settings/workspaces");
    expect(JSON.stringify(renderer.toJSON())).toContain("Native settings/workspaces");
  });

  it("keeps scoped routes paused until a stale workspace is atomically replaced", async () => {
    appMocks.activeCitadelId = "company";
    appMocks.activeWorkspaceId = "default";
    appMocks.fetchWorkspaces.mockResolvedValue({
      items: [{ workspaceId: "engineering", name: "Engineering" }],
    });

    const renderer = await renderApp("http://localhost:5173/projects");

    expect(appMocks.setActiveScope).toHaveBeenCalledWith({
      citadelId: "company",
      workspaceId: "engineering",
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Loading Company workspaces");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Native projects/root");
  });

  it("ignores an obsolete workspace response after a Citadel switch begins", async () => {
    let resolveWorkspaces!: (value: { items: Array<{ workspaceId: string; name: string }> }) => void;
    appMocks.fetchWorkspaces.mockReturnValue(
      new Promise((resolve) => {
        resolveWorkspaces = resolve;
      }),
    );

    const renderer = await renderApp("http://localhost:5173/projects");
    const citadelSelect = renderer.root.findByProps({ "aria-label": "Active Citadel" });
    await act(async () => {
      citadelSelect.props.onChange({ target: { value: "company" } });
    });
    await act(async () => {
      resolveWorkspaces({ items: [{ workspaceId: "workspace-1", name: "Workspace One" }] });
    });
    await flush();

    expect(JSON.stringify(renderer.toJSON())).toContain("Loading Personal workspaces");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Native projects/root");
    expect(appMocks.setActiveScope).not.toHaveBeenCalled();
  });

  it("keeps the route inspector off Chat while preserving non-Chat trust evidence", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/providers?sessionId=session-1&turnId=turn-1");

    await openTopbarMore(renderer);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open Route details" }).props.onClick();
    });
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
      findButton(renderer, "Pin").props.onClick();
      findButton(renderer, "Close").props.onClick();
    });
    expect(appMocks.setDetailPanelPinned).toHaveBeenCalledWith(true);

    await openTopbarMore(renderer);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open Route details" }).props.onClick();
      renderer.root
        .findAllByType("button")
        .find((node) => String(node.props.className).includes("mc-next-inspector-scrim"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Copy trust report");
  });

  it("clears the shell inspector when entering Chat so it cannot resurrect on return", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/providers");

    await openTopbarMore(renderer);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open Route details" }).props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Release readiness");

    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-primary-link") && readNodeText(node).includes("Work"),
        )
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/chat");
    expect(renderer.root.findAllByProps({ "aria-label": "Open Route details" })).toHaveLength(0);

    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find(
          (node) =>
            String(node.props.className).includes("mc-next-primary-link") && readNodeText(node).includes("Settings"),
        )
        ?.props.onClick();
    });
    expect(window.location.pathname).toBe("/settings/general");
    await openTopbarMore(renderer);
    expect(renderer.root.findAllByProps({ "aria-label": "Open Route details" }).length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Release readiness");
  });

  it("keeps grouped rail labels visible to assistive technology", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/providers");
    const railSeparators = renderer.root.findAllByProps({ className: "mc-next-rail-separator" });
    const separatorIds = railSeparators.map((node) => node.props.id);

    expect(readNodeText(renderer.root)).toContain("Identity");
    expect(separatorIds).toContain("mc-next-rail-group-settings-identity");
    expect(railSeparators.every((node) => node.props["aria-hidden"] === undefined)).toBe(true);
    expect(
      renderer.root.findAllByProps({
        className: "mc-next-rail-section",
        "aria-labelledby": "mc-next-rail-group-settings-identity",
      }),
    ).toHaveLength(1);
    expect(readNodeText(renderer.root)).not.toContain("Workspace capabilities");
    expect(readNodeText(renderer.root)).not.toContain("Citadel capabilities");

    await act(async () => {
      findButton(renderer, "Command Palette").props.onClick();
    });
    const palette = JSON.stringify(renderer.toJSON());
    expect(palette).not.toContain("Settings → Workspace capabilities");
    expect(palette).not.toContain("Settings → Citadel capabilities");
  });

  it("keeps hidden settings reachable by direct URL", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/workspace-capabilities");

    expect(JSON.stringify(renderer.toJSON())).toContain("Native settings/workspace-capabilities");
    expect(JSON.stringify(renderer.toJSON())).toContain("Direct URL only");
  });

  it("keeps the rail-hidden experimental Journey route reachable from the command palette", async () => {
    const renderer = await renderApp("http://localhost:5173/library/knowledge");

    await act(async () => {
      findButton(renderer, "Command Palette").props.onClick();
    });
    const paletteSearch = renderer.root.findAllByType("input").find((node) => node.props.role === "combobox");
    expect(paletteSearch).toBeDefined();
    await act(async () => {
      paletteSearch!.props.onChange({ target: { value: "journey" } });
    });
    await act(async () => {
      findButton(renderer, "Library → Journey (Experimental)").props.onClick();
    });

    expect(window.location.pathname).toBe("/library/journey");
  });

  it("exposes Citadel, workspace, and command switching in the mobile drawer", async () => {
    appMocks.isCompactTopbar = true;
    appMocks.isMobileNav = true;
    const renderer = await renderApp();

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open navigation" }).props.onClick();
    });

    const mobileScope = renderer.root.findByProps({ className: "mc-next-rail-mobile-context" });
    const citadelSelect = mobileScope.findByProps({ "aria-label": "Active Citadel" });
    const workspaceSelect = mobileScope.findByProps({ "aria-label": "Active Workspace" });
    await act(async () => {
      citadelSelect.props.onChange({ target: { value: "company" } });
      workspaceSelect.props.onChange({ target: { value: "workspace-2" } });
    });
    expect(appMocks.setActiveCitadelId).toHaveBeenCalledWith("company");
    expect(appMocks.setActiveWorkspaceId).toHaveBeenCalledWith("workspace-2");

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open navigation" }).props.onClick();
      renderer.root.findByProps({ "aria-label": "Open Command Palette" }).props.onClick();
    });
    expect(renderer.root.findAllByProps({ className: "modal-card command-palette" })).toHaveLength(1);
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
    // Cowork is no longer a primary-nav area (it is reached as /chat?mode=cowork).
    // Verify that navigating to Work via the palette preserves session context and
    // does not leak the stored theme preference into the URL.
    const renderer = await renderApp("http://localhost:5173/chat?sessionId=session-1&turnId=turn-1");

    await act(async () => {
      findButton(renderer, "Command Palette").props.onClick();
    });

    await act(async () => {
      findButton(renderer, "Go to Work").props.onClick();
    });

    expect(window.location.pathname).toBe("/chat");
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
    const fallbackRenderer = await renderApp("http://localhost:5173/chat");
    expect(appMocks.setActiveScope).toHaveBeenCalledWith({
      citadelId: "personal",
      workspaceId: "workspace-2",
    });
    expect(JSON.stringify(fallbackRenderer.toJSON())).toContain("Loading Personal workspaces");
    fallbackRenderer.unmount();

    appMocks.activeWorkspaceId = "workspace-2";
    const noSessionRenderer = await renderApp("http://localhost:5173/chat");
    await act(async () => {
      (appMocks.threadedRouteProps?.onCopyTrustReport as (sessionId?: string) => void)(undefined);
    });
    expect(JSON.stringify(noSessionRenderer.toJSON())).toContain(
      "Open a Work session before exporting a trust report.",
    );
    noSessionRenderer.unmount();

    appMocks.fetchRuntimeLifecycleExport.mockRejectedValueOnce(new Error("export offline"));
    const failingRenderer = await renderApp("http://localhost:5173/chat?sessionId=session-err");
    await act(async () => {
      (appMocks.threadedRouteProps?.onCopyTrustReport as (sessionId?: string) => void)("session-err");
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

    await openTopbarMore(renderer);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Open Route details" }).props.onClick();
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
    expect(JSON.stringify(renderer.toJSON())).toContain("Native ops/kanban");
    renderer.unmount();

    renderer = await renderApp("http://localhost:5173/code?sessionId=code-session");
    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
    renderer.unmount();

    renderer = await renderApp("http://localhost:5173/projects/Project-1");
    expect(JSON.stringify(renderer.toJSON())).toContain("Native projects/root");
    renderer.unmount();
  });

  it("chat, cowork, and code route inputs normalize to unlocked Chat", async () => {
    // Chat stays unlocked so the gateway auto-router can classify a new thread's first turn.
    let renderer = await renderApp("http://localhost:5173/chat?sessionId=session-1");
    expect(appMocks.threadedRouteProps).toMatchObject({ surface: "chat", lockSurface: false, hidePageHeader: true });
    renderer.unmount();

    // Legacy Cowork route inputs normalize back into the unified Chat surface.
    renderer = await renderApp("http://localhost:5173/cowork?sessionId=session-1");
    expect(appMocks.threadedRouteProps).toMatchObject({ surface: "chat", lockSurface: false });
    renderer.unmount();

    // Legacy Code route inputs also normalize back into the unified Chat surface.
    renderer = await renderApp("http://localhost:5173/code?sessionId=code-session");
    expect(appMocks.threadedRouteProps).toMatchObject({ surface: "chat", lockSurface: false });
    renderer.unmount();
  });

  it.each([
    {
      href: "http://localhost:5173/cowork?sessionId=session-1&turnId=turn-1#composer",
      expectedPath: "/chat",
      expectedSearch: "?sessionId=session-1&turnId=turn-1",
      expectedHash: "#composer",
    },
    {
      href: "http://localhost:5173/code?sessionId=code-session#run-detail",
      expectedPath: "/chat",
      expectedSearch: "?sessionId=code-session",
      expectedHash: "#run-detail",
    },
    {
      href: "http://localhost:5173/settings/safety?view=advanced#trust-policy",
      expectedPath: "/settings/permissions",
      expectedSearch: "?view=advanced",
      expectedHash: "#trust-policy",
    },
  ])("replaces direct compatibility URL $href with its canonical path", async (input) => {
    const renderer = await renderApp(input.href);

    expect(window.location.pathname).toBe(input.expectedPath);
    expect(window.location.search).toBe(input.expectedSearch);
    expect(window.location.hash).toBe(input.expectedHash);
    expect(window.history.replaceState).toHaveBeenCalled();

    renderer.unmount();
  });

  it("canonicalizes a direct compatibility alias reached through browser history", async () => {
    const renderer = await renderApp("http://localhost:5173/settings/general");
    const popstateListener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([eventName]) => eventName === "popstate",
    )?.[1] as (() => void) | undefined;
    expect(popstateListener).toBeTypeOf("function");

    window.history.pushState({}, "", "/code?sessionId=history-session#run-detail");
    await act(async () => {
      popstateListener?.();
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?sessionId=history-session");
    expect(window.location.hash).toBe("#run-detail");
    expect(JSON.stringify(renderer.toJSON())).toContain("Threaded chat");
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
    expect(JSON.stringify(workspaceRenderer.toJSON())).toContain("Workspaces could not load");
    expect(JSON.stringify(workspaceRenderer.toJSON())).not.toContain("Native settings/access");
    workspaceRenderer.unmount();

    const qualityRenderer = await renderApp("http://localhost:5173/ops/quality?sessionId=session-1&theme=light");
    expect(window.location.pathname).toBe("/ops/quality");
    expect(JSON.stringify(qualityRenderer.toJSON())).toContain("Native ops/quality");
  });
});
