import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchCostSummary: vi.fn(),
  fetchMemoryQmdStats: vi.fn(),
  runCheaper: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchCostSummary: apiMocks.fetchCostSummary,
  fetchMemoryQmdStats: apiMocks.fetchMemoryQmdStats,
  runCheaper: apiMocks.runCheaper,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn(),
}));

import { CostConsolePage } from "./CostConsolePage";

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

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("CostConsolePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: storage,
      sessionStorage: storage,
    });
    apiMocks.fetchMemoryQmdStats.mockResolvedValue({
      totalRuns: 0,
      compressionPercent: 0,
      expansionPercent: 0,
      efficiencyLabel: "neutral",
      originalTokenEstimate: 0,
      distilledTokenEstimate: 0,
      netTokenDelta: 0,
    });
    apiMocks.runCheaper.mockResolvedValue({
      actions: [],
    });
  });

  it("explains when token usage exists but USD spend was not recorded", async () => {
    apiMocks.fetchCostSummary.mockResolvedValue({
      scope: "day",
      from: "2026-03-22T00:00:00.000Z",
      to: "2026-03-29T00:00:00.000Z",
      usageAvailability: {
        trackedEvents: 4,
        unknownEvents: 0,
        totalAgentEvents: 4,
      },
      items: [
        {
          key: "2026-03-29",
          tokenInput: 1200,
          tokenOutput: 480,
          tokenCachedInput: 0,
          tokenTotal: 1680,
          costUsd: 0,
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CostConsolePage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Window Totals");
      expect(text).toContain("Recorded spend $0.00");
      expect(text).toContain("USD spend is not being recorded for this window.");
      expect(text).toContain("Token usage is available, but USD spend was not recorded for these runs.");
      expect(text).toContain("Not recorded");
      expect(text).not.toContain("All recent assistant events reported usage successfully.");
    } finally {
      renderer.unmount();
    }
  });

  it("shows recorded USD values when the summary includes spend", async () => {
    apiMocks.fetchCostSummary.mockResolvedValue({
      scope: "day",
      from: "2026-03-22T00:00:00.000Z",
      to: "2026-03-29T00:00:00.000Z",
      usageAvailability: {
        trackedEvents: 2,
        unknownEvents: 0,
        totalAgentEvents: 2,
      },
      items: [
        {
          key: "2026-03-29",
          tokenInput: 800,
          tokenOutput: 200,
          tokenCachedInput: 0,
          tokenTotal: 1000,
          costUsd: 1.2345,
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CostConsolePage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Recorded spend $1.23");
      expect(text).toContain("$1.2345");
      expect(text).not.toContain("USD spend is not being recorded for this window.");
    } finally {
      renderer.unmount();
    }
  });
});
