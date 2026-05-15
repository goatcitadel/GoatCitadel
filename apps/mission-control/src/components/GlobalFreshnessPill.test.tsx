import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalFreshnessPill } from "./GlobalFreshnessPill";

const streamStatusState = vi.hoisted(() => ({
  value: {
    lastEventAt: "2026-04-10T10:00:00.000Z",
    gatewayNodeId: "gateway-alpha",
    reconnectAttempts: 3,
  } as { lastEventAt: string | undefined; gatewayNodeId: string | undefined; reconnectAttempts: number },
}));

vi.mock("../hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => streamStatusState.value,
}));

describe("GlobalFreshnessPill", () => {
  beforeEach(() => {
    streamStatusState.value = {
      lastEventAt: "2026-04-10T10:00:00.000Z",
      gatewayNodeId: "gateway-alpha",
      reconnectAttempts: 3,
    };
  });

  it("uses the compact trust read without duplicating gateway detail", () => {
    const markup = renderToStaticMarkup(<GlobalFreshnessPill streamState="open" variant="compact" />);

    expect(markup).toContain("global-freshness-pill compact live");
    expect(markup).toContain("Live");
    expect(markup).not.toContain("Last update:");
    expect(markup).not.toContain("Gateway:");
    expect(markup).not.toContain("Reconnects:");
  });

  it.each([
    ["connecting", "Reconnecting", "reconnecting"],
    ["retrying", "Reconnecting", "reconnecting"],
    ["error", "Degraded", "degraded"],
    ["closed", "Offline", "offline"],
  ] as const)("maps %s stream state into full freshness copy", (streamState, label, className) => {
    streamStatusState.value = {
      lastEventAt: undefined,
      gatewayNodeId: "",
      reconnectAttempts: 0,
    };

    const markup = renderToStaticMarkup(<GlobalFreshnessPill streamState={streamState} />);

    expect(markup).toContain(`global-freshness-pill ${className}`);
    expect(markup).toContain(label);
    expect(markup).toContain("Last update: n/a");
    expect(markup).not.toContain("Gateway:");
    expect(markup).not.toContain("Reconnects:");
  });

  it("shows gateway and reconnect detail in the full pill", () => {
    const markup = renderToStaticMarkup(<GlobalFreshnessPill streamState="open" />);

    expect(markup).toContain("Live");
    expect(markup).toContain("Last update:");
    expect(markup).toContain("Gateway: gateway-alpha");
    expect(markup).toContain("Reconnects: 3");
  });
});
