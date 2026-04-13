import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GlobalFreshnessPill } from "./GlobalFreshnessPill";

vi.mock("../hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => ({
    lastEventAt: "2026-04-10T10:00:00.000Z",
    gatewayNodeId: "gateway-alpha",
    reconnectAttempts: 3,
  }),
}));

describe("GlobalFreshnessPill", () => {
  it("uses the compact trust read without duplicating gateway detail", () => {
    const markup = renderToStaticMarkup(<GlobalFreshnessPill streamState="open" variant="compact" />);

    expect(markup).toContain("global-freshness-pill compact live");
    expect(markup).toContain("Live");
    expect(markup).not.toContain("Last update:");
    expect(markup).not.toContain("Gateway:");
    expect(markup).not.toContain("Reconnects:");
  });
});
