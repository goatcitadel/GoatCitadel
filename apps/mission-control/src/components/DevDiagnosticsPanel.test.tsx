import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsState = vi.hoisted(() => ({
  value: {
    enabled: true,
    verbose: false,
    items: [],
    currentRoute: "/chat",
    activeChatSessionId: "session-1",
    currentEffectsMode: "balanced",
    gatewayReachable: true,
    sseState: "open",
    startupSummary: {
      startedAt: "2026-03-10T18:00:00.000Z",
      finishedAt: "2026-03-10T18:00:01.250Z",
      durationMs: 1250,
      outcome: "ready",
      phases: [
        {
          key: "gateway",
          label: "Gateway",
          status: "success",
          startedAt: "2026-03-10T18:00:00.000Z",
          finishedAt: "2026-03-10T18:00:00.500Z",
          durationMs: 500,
          detail: "connected",
        },
      ],
    },
  },
  localItems: [
    {
      id: "local-1",
      timestamp: "2026-03-10T18:01:00.000Z",
      level: "warn",
      category: "ui",
      event: "local.warn",
      message: "Local warning",
      source: "client",
      correlationId: "corr-local",
      sessionId: "session-1",
    },
  ],
}));

const apiMocks = vi.hoisted(() => ({
  fetchDevDiagnostics: vi.fn(async () => ({
    items: [
      {
        id: "gateway-1",
        timestamp: "2026-03-10T18:02:00.000Z",
        level: "error",
        category: "gateway",
        event: "gateway.error",
        message: "Gateway failed",
        source: "gateway",
        correlationId: "corr-gateway",
        sessionId: "session-2",
      },
    ],
  })),
  connectDevDiagnosticsStream: vi.fn((onEvent: (event: unknown) => void) => {
    onEvent({
      id: "stream-1",
      timestamp: "2026-03-10T18:03:00.000Z",
      level: "info",
      category: "chat",
      event: "stream.info",
      message: "Stream connected",
      source: "gateway",
      correlationId: "corr-stream",
      sessionId: "session-1",
    });
    return vi.fn();
  }),
  streamClose: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  buildDevDiagnosticsBundle: vi.fn((gatewayItems: unknown[] = []) => ({ gatewayItems, marker: "bundle" })),
  clearClientDiagnostics: vi.fn(() => {
    diagnosticsState.localItems = [];
  }),
}));

vi.mock("../api/client", () => ({
  connectDevDiagnosticsStream: apiMocks.connectDevDiagnosticsStream,
  fetchDevDiagnostics: apiMocks.fetchDevDiagnostics,
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  buildDevDiagnosticsBundle: storeMocks.buildDevDiagnosticsBundle,
  clearClientDiagnostics: storeMocks.clearClientDiagnostics,
  isDevDiagnosticsEnabled: () => diagnosticsState.value.enabled,
  listClientDiagnostics: () => diagnosticsState.localItems,
  useDevDiagnosticsState: () => diagnosticsState.value,
}));

import { DevDiagnosticsPanel } from "./DevDiagnosticsPanel";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DevDiagnosticsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diagnosticsState.value.enabled = true;
    diagnosticsState.localItems = [
      {
        id: "local-1",
        timestamp: "2026-03-10T18:01:00.000Z",
        level: "warn",
        category: "ui",
        event: "local.warn",
        message: "Local warning",
        source: "client",
        correlationId: "corr-local",
        sessionId: "session-1",
      },
    ];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    apiMocks.connectDevDiagnosticsStream.mockImplementation((onEvent: (event: unknown) => void) => {
      onEvent({
        id: "stream-1",
        timestamp: "2026-03-10T18:03:00.000Z",
        level: "info",
        category: "chat",
        event: "stream.info",
        message: "Stream connected",
        source: "gateway",
        correlationId: "corr-stream",
        sessionId: "session-1",
      });
      return apiMocks.streamClose;
    });
  });

  it("stays hidden when disabled or closed", () => {
    const renderer = create(<DevDiagnosticsPanel open={false} onClose={() => undefined} />);
    expect(renderer.toJSON()).toBeNull();

    diagnosticsState.value.enabled = false;
    renderer.update(<DevDiagnosticsPanel open onClose={() => undefined} />);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });

  it("loads gateway diagnostics, filters events, copies bundles, and clears items", async () => {
    const onClose = vi.fn();
    const renderer = create(<DevDiagnosticsPanel open onClose={onClose} />);
    await flush();

    expect(collectText(renderer.toJSON())).toContain("Reachable");
    expect(collectText(renderer.toJSON())).toContain("Gateway failed");
    expect(collectText(renderer.toJSON())).toContain("Local warning");
    expect(apiMocks.connectDevDiagnosticsStream).toHaveBeenCalledTimes(1);

    const selects = renderer.root.findAllByType("select");
    await act(async () => {
      selects[0]!.props.onChange({ target: { value: "gateway" } });
    });
    expect(collectText(renderer.toJSON())).toContain("Gateway failed");
    expect(collectText(renderer.toJSON())).not.toContain("Local warning");

    const buttons = renderer.root.findAllByType("button");
    const copyRecent = buttons.find((button) => collectText(button.props.children).includes("Copy last 100"))!;
    await act(async () => {
      copyRecent.props.onClick();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("bundle"));

    const clear = buttons.find((button) => collectText(button.props.children).includes("Clear"))!;
    await act(async () => {
      clear.props.onClick();
    });
    expect(storeMocks.clearClientDiagnostics).toHaveBeenCalledTimes(1);

    const close = buttons.find((button) => collectText(button.props.children).includes("Close"))!;
    await act(async () => {
      close.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("filters by level and correlation id, copies the active session bundle, and closes the stream", async () => {
    apiMocks.fetchDevDiagnostics.mockResolvedValueOnce({
      items: [
        {
          id: "gateway-session-1",
          timestamp: "2026-03-10T18:04:00.000Z",
          level: "info",
          category: "gateway",
          event: "gateway.info",
          message: "Gateway session event",
          source: "gateway",
          correlationId: "corr-stream",
          sessionId: "session-1",
        },
        {
          id: "gateway-session-2",
          timestamp: "2026-03-10T18:05:00.000Z",
          level: "error",
          category: "gateway",
          event: "gateway.error",
          message: "Gateway failed",
          source: "gateway",
          correlationId: "corr-gateway",
          sessionId: "session-2",
        },
      ],
    });
    const renderer = create(<DevDiagnosticsPanel open onClose={() => undefined} />);
    await flush();

    const selects = renderer.root.findAllByType("select");
    await act(async () => {
      selects[1]!.props.onChange({ target: { value: "info" } });
    });
    expect(collectText(renderer.toJSON())).toContain("Gateway session event");
    expect(collectText(renderer.toJSON())).not.toContain("Gateway failed");

    const correlationInput = renderer.root.findByProps({ placeholder: "Correlation ID" });
    await act(async () => {
      correlationInput.props.onChange({ target: { value: " corr-stream " } });
    });
    expect(collectText(renderer.toJSON())).toContain("gateway.info");

    const buttons = renderer.root.findAllByType("button");
    const copySession = buttons.find((button) => collectText(button.props.children).includes("Copy session bundle"))!;
    await act(async () => {
      copySession.props.onClick();
    });

    expect(storeMocks.buildDevDiagnosticsBundle).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "gateway-session-1", sessionId: "session-1" }),
    ]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("gateway-session-1"));

    renderer.unmount();
    expect(apiMocks.streamClose).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when filters remove all diagnostics and resets stale selections", async () => {
    const renderer = create(<DevDiagnosticsPanel open onClose={() => undefined} />);
    await flush();

    const eventButtons = renderer.root
      .findAllByType("button")
      .filter((button) => collectText(button.props.children).includes("Gateway failed"));
    await act(async () => {
      eventButtons[0]?.props.onClick();
    });

    const correlationInput = renderer.root.findByProps({ placeholder: "Correlation ID" });
    await act(async () => {
      correlationInput.props.onChange({ target: { value: "missing-correlation" } });
    });

    const text = collectText(renderer.toJSON());
    expect(text).toContain("No diagnostics captured yet.");
    expect(text).toContain("Select an event to inspect its details.");

    renderer.unmount();
  });
});
