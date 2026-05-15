import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  fetchHealthSummary: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  restartDaemon: vi.fn(),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    fetchHealthSummary: apiMocks.fetchHealthSummary,
    startDaemon: apiMocks.startDaemon,
    stopDaemon: apiMocks.stopDaemon,
    restartDaemon: apiMocks.restartDaemon,
  };
});

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

import { HealthPage } from "./HealthPage";

function healthSummary(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-04-10T10:00:00.000Z",
    systemVitals: {
      hostname: "goat-box",
      platform: "win32",
      release: "11",
      uptimeSeconds: 30,
      loadAverage: [0.1, 0.2, 0.3],
      cpuCount: 8,
      memoryTotalBytes: 1024,
      memoryFreeBytes: 512,
      memoryUsedBytes: 512,
      processRssBytes: 256,
      processHeapUsedBytes: 128,
    },
    daemonStatus: {
      running: true,
      pid: 42,
      uptimeSeconds: 30,
      host: "goat-box",
      state: "running",
      controllable: true,
      supported: true,
      controlMessage: "ready",
    },
    daemonLogs: {
      items: [{ timestamp: "2026-04-10T10:00:00.000Z", level: "info", message: "ready" }],
    },
    costs: {
      summary: {
        scope: "day",
        from: "2026-04-03T10:00:00.000Z",
        to: "2026-04-10T10:00:00.000Z",
        usageAvailability: {
          trackedEvents: 12,
          unknownEvents: 1,
          totalAgentEvents: 13,
        },
        items: [{ key: "day", tokenInput: 10, tokenOutput: 12, tokenCachedInput: 0, tokenTotal: 22, costUsd: 1.23 }],
      },
      qmd: {
        totalRuns: 2,
        compressionPercent: 18,
        expansionPercent: 0,
        efficiencyLabel: "reduced",
        originalTokenEstimate: 120,
        distilledTokenEstimate: 98,
        netTokenDelta: -22,
      },
    },
    backups: {
      items: [
        {
          backupId: "backup-1",
          createdAt: "2026-04-10T10:00:00.000Z",
          files: [{ path: "config/llm-providers.json" }],
        },
      ],
      latest: {
        backupId: "backup-1",
        createdAt: "2026-04-10T10:00:00.000Z",
        files: [{ path: "config/llm-providers.json" }],
      },
    },
    ...overrides,
  };
}

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function renderedTextContent(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map(renderedTextContent).join(" ");
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAllByType("button").find((node) => node.props.children === label);
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
}

describe("HealthPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
  });

  it("renders one focused health page without duplicated secondary summaries", async () => {
    apiMocks.fetchHealthSummary.mockResolvedValueOnce({
      generatedAt: "2026-04-10T10:00:00.000Z",
      systemVitals: {
        hostname: "goat-box",
        platform: "win32",
        release: "11",
        uptimeSeconds: 30,
        loadAverage: [0.1, 0.2, 0.3],
        cpuCount: 8,
        memoryTotalBytes: 1024,
        memoryFreeBytes: 512,
        memoryUsedBytes: 512,
        processRssBytes: 256,
        processHeapUsedBytes: 128,
      },
      daemonStatus: {
        running: true,
        pid: 42,
        uptimeSeconds: 30,
        host: "goat-box",
        state: "running",
        controllable: true,
        supported: true,
        controlMessage: "ready",
      },
      daemonLogs: {
        items: [{ timestamp: "2026-04-10T10:00:00.000Z", level: "info", message: "ready" }],
      },
      costs: {
        summary: {
          scope: "day",
          from: "2026-04-03T10:00:00.000Z",
          to: "2026-04-10T10:00:00.000Z",
          usageAvailability: {
            trackedEvents: 12,
            unknownEvents: 1,
            totalAgentEvents: 13,
          },
          items: [{ key: "day", tokenInput: 10, tokenOutput: 12, tokenCachedInput: 0, tokenTotal: 22, costUsd: 1.23 }],
        },
        qmd: {
          totalRuns: 2,
          compressionPercent: 18,
          expansionPercent: 0,
          efficiencyLabel: "reduced",
          originalTokenEstimate: 120,
          distilledTokenEstimate: 98,
          netTokenDelta: -22,
        },
      },
      backups: {
        items: [
          {
            backupId: "backup-1",
            createdAt: "2026-04-10T10:00:00.000Z",
            files: [{ path: "config/llm-providers.json" }],
          },
        ],
        latest: {
          backupId: "backup-1",
          createdAt: "2026-04-10T10:00:00.000Z",
          files: [{ path: "config/llm-providers.json" }],
        },
      },
    });
    apiMocks.fetchHealthSummary.mockResolvedValueOnce({
      generatedAt: "2026-04-10T10:10:00.000Z",
      systemVitals: {
        hostname: "goat-box",
        platform: "win32",
        release: "11",
        uptimeSeconds: 60,
        loadAverage: [0.2, 0.3, 0.4],
        cpuCount: 8,
        memoryTotalBytes: 1024,
        memoryFreeBytes: 256,
        memoryUsedBytes: 768,
        processRssBytes: 300,
        processHeapUsedBytes: 180,
      },
      daemonStatus: {
        running: true,
        pid: 42,
        uptimeSeconds: 60,
        host: "goat-box",
        state: "running",
        controllable: true,
        supported: true,
        controlMessage: "ready",
      },
      daemonLogs: {
        items: [{ timestamp: "2026-04-10T10:10:00.000Z", level: "info", message: "refreshed" }],
      },
      costs: {
        summary: {
          scope: "day",
          from: "2026-04-03T10:00:00.000Z",
          to: "2026-04-10T10:10:00.000Z",
          usageAvailability: {
            trackedEvents: 20,
            unknownEvents: 1,
            totalAgentEvents: 21,
          },
          items: [{ key: "day", tokenInput: 20, tokenOutput: 30, tokenCachedInput: 0, tokenTotal: 50, costUsd: 2.5 }],
        },
        qmd: {
          totalRuns: 4,
          compressionPercent: 20,
          expansionPercent: 0,
          efficiencyLabel: "reduced",
          originalTokenEstimate: 200,
          distilledTokenEstimate: 160,
          netTokenDelta: -40,
        },
      },
      backups: {
        items: [
          {
            backupId: "backup-2",
            createdAt: "2026-04-10T10:10:00.000Z",
            files: [{ path: "data/index.db" }, { path: "config/llm-providers.json" }],
          },
        ],
        latest: {
          backupId: "backup-2",
          createdAt: "2026-04-10T10:10:00.000Z",
          files: [{ path: "data/index.db" }, { path: "config/llm-providers.json" }],
        },
      },
    });

    let renderer = create(<div />);
    await act(async () => {
      renderer = create(<HealthPage activeTab="system" onTabChange={() => undefined} />);
    });

    await act(async () => {
      await refreshState.callback?.({
        topic: "system",
        timestamp: Date.now(),
        reason: "test-refresh",
      });
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Health");
    expect(text).toContain("Runtime");
    expect(text).toContain("Service Manager");
    expect(text).toContain("Backup ready");
    expect(text).toContain("Runtime serving");
    expect(text).toContain("$2.50 recorded");
    expect(text).toContain("Latest backup");
    expect(text).not.toContain("Other lane");
  });

  it("routes section tabs and renders spend fallbacks with expanded QMD impact", async () => {
    apiMocks.fetchHealthSummary.mockResolvedValueOnce(
      healthSummary({
        daemonStatus: {
          running: false,
          pid: 0,
          uptimeSeconds: 0,
          host: "",
          state: "stopped",
          controllable: true,
          supported: true,
          controlMessage: "stopped",
        },
        systemVitals: null,
        costs: {
          summary: {
            scope: "week",
            from: "2026-04-03T10:00:00.000Z",
            to: "2026-04-10T10:00:00.000Z",
            usageAvailability: {
              trackedEvents: 0,
              unknownEvents: 3,
              totalAgentEvents: 3,
            },
            items: [],
          },
          qmd: {
            totalRuns: 3,
            compressionPercent: 0,
            expansionPercent: 42,
            efficiencyLabel: "expanded",
            originalTokenEstimate: 100,
            distilledTokenEstimate: 142,
            netTokenDelta: 42,
          },
        },
        backups: {
          items: [],
          latest: null,
        },
      }),
    );
    const onTabChange = vi.fn();
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<HealthPage activeTab="costs" onTabChange={onTabChange} />);
      });

      await clickButton(renderer, "Runtime");

      const text = renderedTextContent(renderer.toJSON()).replace(/\s+/g, " ");
      expect(onTabChange).toHaveBeenCalledWith("system");
      expect(text).toContain("Runtime needs attention");
      expect(text).toContain("Scope week");
      expect(text).toContain("0 tracked");
      expect(text).toContain("42% expanded");
      expect(text).toContain("Backup missing");
      expect(text).toContain("No backup summary is available yet.");
    } finally {
      renderer.unmount();
    }
  });

  it("runs daemon manager actions and surfaces action failures without leaving runtime status", async () => {
    apiMocks.fetchHealthSummary.mockResolvedValue(healthSummary());
    apiMocks.startDaemon.mockResolvedValue({ status: { running: true } });
    apiMocks.stopDaemon.mockResolvedValue({ status: { running: false } });
    apiMocks.restartDaemon.mockResolvedValue({ status: { running: true } });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<HealthPage activeTab="system" onTabChange={() => undefined} />);
      });

      await clickButton(renderer, "Start");
      await clickButton(renderer, "Stop");
      await clickButton(renderer, "Restart");
      await clickButton(renderer, "Refresh");

      expect(apiMocks.startDaemon).toHaveBeenCalledTimes(1);
      expect(apiMocks.stopDaemon).toHaveBeenCalledTimes(1);
      expect(apiMocks.restartDaemon).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(5);

      apiMocks.restartDaemon.mockRejectedValueOnce(new Error("restart denied"));
      await clickButton(renderer, "Restart");

      expect(rendererText(renderer)).toContain("restart denied");
      expect(rendererText(renderer)).toContain("Runtime serving");
    } finally {
      renderer.unmount();
    }
  });
});
