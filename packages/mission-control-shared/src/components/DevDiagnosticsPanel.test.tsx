import React from "react";
import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DevDiagnosticsPanel } from "./DevDiagnosticsPanel";

const storeMocks = vi.hoisted(() => ({
  buildDevDiagnosticsBundle: vi.fn(),
  clearClientDiagnostics: vi.fn(),
  isDevDiagnosticsEnabled: vi.fn(),
  listClientDiagnostics: vi.fn(),
  useDevDiagnosticsState: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  connectDevDiagnosticsStream: vi.fn(),
  fetchDevDiagnostics: vi.fn(),
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  buildDevDiagnosticsBundle: storeMocks.buildDevDiagnosticsBundle,
  clearClientDiagnostics: storeMocks.clearClientDiagnostics,
  isDevDiagnosticsEnabled: storeMocks.isDevDiagnosticsEnabled,
  listClientDiagnostics: storeMocks.listClientDiagnostics,
  useDevDiagnosticsState: storeMocks.useDevDiagnosticsState,
}));

vi.mock("../api/client", () => ({
  connectDevDiagnosticsStream: apiMocks.connectDevDiagnosticsStream,
  fetchDevDiagnostics: apiMocks.fetchDevDiagnostics,
}));

function diagnostic(
  input: Partial<DevDiagnosticsEvent> & Pick<DevDiagnosticsEvent, "id" | "timestamp">,
): DevDiagnosticsEvent {
  return {
    id: input.id,
    timestamp: input.timestamp,
    level: input.level ?? "info",
    category: input.category ?? "api",
    event: input.event ?? "request.finish",
    message: input.message ?? "Request completed",
    source: input.source ?? "gateway",
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    runtimeKind: input.runtimeKind,
    runtimeStatus: input.runtimeStatus,
    runId: input.runId,
    toolName: input.toolName,
    meetingSessionId: input.meetingSessionId,
    context: input.context,
  } as DevDiagnosticsEvent;
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DevDiagnosticsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.isDevDiagnosticsEnabled.mockReturnValue(true);
    storeMocks.useDevDiagnosticsState.mockReturnValue({
      enabled: true,
      verbose: true,
      items: [],
      currentRoute: "/chat",
      activeChatSessionId: "session-1",
      activeCorrelationId: "corr-1",
      currentEffectsMode: "auto",
      gatewayReachable: true,
      sseState: "open",
      startupSummary: {
        startedAt: "2026-01-01T12:00:00.000Z",
        finishedAt: "2026-01-01T12:00:01.000Z",
        durationMs: 1000,
        outcome: "ready",
        phases: [
          {
            key: "auth",
            label: "Access check",
            status: "success",
            startedAt: "2026-01-01T12:00:00.000Z",
            finishedAt: "2026-01-01T12:00:01.000Z",
            durationMs: 1000,
            detail: "Authenticated",
          },
        ],
      },
    });
    storeMocks.listClientDiagnostics.mockReturnValue([
      diagnostic({
        id: "client-1",
        timestamp: "2026-01-01T12:02:00.000Z",
        source: "client",
        category: "refresh",
        level: "debug",
        event: "refresh.completed",
        message: "Refresh completed",
        correlationId: "corr-2",
      }),
    ]);
    storeMocks.buildDevDiagnosticsBundle.mockReturnValue({ bundle: true });
    apiMocks.fetchDevDiagnostics.mockResolvedValue({
      items: [
        diagnostic({
          id: "gateway-1",
          timestamp: "2026-01-01T12:01:00.000Z",
          source: "gateway",
          category: "api",
          level: "info",
          event: "request.finish",
          message: "Gateway request completed",
          correlationId: "corr-1",
          sessionId: "session-1",
        }),
      ],
    });
    apiMocks.connectDevDiagnosticsStream.mockReturnValue(vi.fn());
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  it("renders nothing when closed or diagnostics are disabled", () => {
    const closed = create(<DevDiagnosticsPanel open={false} onClose={() => undefined} />);
    expect(closed.toJSON()).toBeNull();
    expect(apiMocks.fetchDevDiagnostics).not.toHaveBeenCalled();

    storeMocks.isDevDiagnosticsEnabled.mockReturnValue(false);
    const disabled = create(<DevDiagnosticsPanel open onClose={() => undefined} />);
    expect(disabled.toJSON()).toBeNull();
    expect(apiMocks.fetchDevDiagnostics).not.toHaveBeenCalled();
  });

  it("loads gateway diagnostics, merges local items, filters, selects, copies, clears, and closes", async () => {
    let streamCallback!: (event: DevDiagnosticsEvent) => void;
    const closeStream = vi.fn();
    apiMocks.connectDevDiagnosticsStream.mockImplementation((callback) => {
      streamCallback = callback;
      return closeStream;
    });
    const onClose = vi.fn();
    const renderer = create(<DevDiagnosticsPanel open onClose={onClose} />);
    await flushAsync();

    expect(apiMocks.fetchDevDiagnostics).toHaveBeenCalledWith({ limit: 120 });
    expect(apiMocks.connectDevDiagnosticsStream).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ className: "dev-diagnostics-startup-phase is-success" })).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.children.includes("Gateway request completed"))).not.toHaveLength(0);
    expect(renderer.root.findAll((node) => node.children.includes("Refresh completed"))).not.toHaveLength(0);

    await act(async () => {
      streamCallback(
        diagnostic({
          id: "gateway-2",
          timestamp: "2026-01-01T12:03:00.000Z",
          source: "gateway",
          category: "chat",
          level: "warn",
          event: "chat.warning",
          message: "Streamed warning",
          correlationId: "corr-3",
        }),
      );
    });
    expect(renderer.root.findAll((node) => node.children.includes("Streamed warning"))).not.toHaveLength(0);

    const [categorySelect, levelSelect] = renderer.root.findAllByType("select");
    const correlationInput = renderer.root.findByProps({ placeholder: "Correlation ID" });
    await act(async () => {
      categorySelect!.props.onChange({ target: { value: "chat" } });
      levelSelect!.props.onChange({ target: { value: "warn" } });
      correlationInput.props.onChange({ target: { value: "corr-3" } });
    });
    expect(renderer.root.findAll((node) => node.children.includes("Streamed warning"))).not.toHaveLength(0);
    expect(renderer.root.findAll((node) => node.children.includes("Gateway request completed"))).toHaveLength(0);

    const itemButton = renderer.root
      .findAllByType("button")
      .find((button) => String(button.props.className).includes("dev-diagnostics-item"));
    await act(async () => {
      itemButton!.props.onClick();
    });
    expect(renderer.root.findAllByType("pre")[0]?.children.join("")).toContain("gateway-2");

    const copyRecent = renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Copy last 100")!;
    const copySession = renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Copy session bundle")!;
    const clear = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Clear")!;
    await act(async () => {
      await copyRecent.props.onClick();
      await copySession.props.onClick();
      clear.props.onClick();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(storeMocks.buildDevDiagnosticsBundle).toHaveBeenCalled();
    expect(storeMocks.clearClientDiagnostics).toHaveBeenCalled();
    expect(renderer.root.findByProps({ className: "dev-diagnostics-copy-status" }).children.join("")).toBe(
      "Session bundle copied.",
    );

    const close = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Close")!;
    await act(async () => {
      close.props.onClick();
    });
    expect(onClose).toHaveBeenCalled();

    renderer.unmount();
    expect(closeStream).toHaveBeenCalled();
  });

  it("reports clipboard failures without leaking rejected copy promises", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    const renderer = create(<DevDiagnosticsPanel open onClose={() => undefined} />);
    await flushAsync();

    const copyRecent = renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Copy last 100")!;
    await act(async () => {
      await copyRecent.props.onClick();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ className: "dev-diagnostics-copy-status" }).children.join("")).toBe(
      "Copy failed: denied",
    );
  });

  it("handles fetch failures and empty filtered states", async () => {
    apiMocks.fetchDevDiagnostics.mockRejectedValueOnce(new Error("offline"));
    storeMocks.listClientDiagnostics.mockReturnValue([]);
    const renderer = create(<DevDiagnosticsPanel open onClose={() => undefined} />);
    await flushAsync();

    expect(
      renderer.root
        .findAllByProps({ className: "dev-diagnostics-empty" })
        .some((node) => node.children.join("") === "No diagnostics captured yet."),
    ).toBe(true);
  });
});
