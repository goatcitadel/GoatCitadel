import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { formatDashboardBytes } from "./dashboard-page-helpers";

const apiMocks = vi.hoisted(() => ({
  fetchCronJobs: vi.fn(),
  fetchDashboardState: vi.fn(),
  fetchMemoryFiles: vi.fn(),
  fetchOperators: vi.fn(),
  fetchSystemVitals: vi.fn(),
}));

const refreshSubscriptionMock = vi.hoisted(() => ({
  callback: null as null | (() => void | Promise<void>),
  options: null as null | Record<string, unknown>,
}));

vi.mock("../api/client", () => ({
  fetchCronJobs: apiMocks.fetchCronJobs,
  fetchDashboardState: apiMocks.fetchDashboardState,
  fetchMemoryFiles: apiMocks.fetchMemoryFiles,
  fetchOperators: apiMocks.fetchOperators,
  fetchSystemVitals: apiMocks.fetchSystemVitals,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: () => void | Promise<void>, options?: Record<string, unknown>) => {
    refreshSubscriptionMock.callback = callback;
    refreshSubscriptionMock.options = options ?? null;
  },
}));

function dashboardState(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-05-14T12:00:00.000Z",
    sessions: [{ sessionId: "session-1" }, { sessionId: "session-2" }],
    pendingApprovals: 2,
    activeSubagents: 1,
    taskStatusCounts: [
      { status: "in_progress", count: 3 },
      { status: "blocked", count: 1 },
    ],
    recentEvents: [],
    dailyCostUsd: 12.3456,
    ...overrides,
  };
}

function systemVitals(overrides: Record<string, unknown> = {}) {
  return {
    hostname: "goat-box",
    platform: "win32",
    release: "11",
    uptimeSeconds: 500,
    loadAverage: [0.1, 0.2, 0.3],
    cpuCount: 8,
    memoryTotalBytes: 16 * 1024 * 1024 * 1024,
    memoryFreeBytes: 8 * 1024 * 1024 * 1024,
    memoryUsedBytes: 8 * 1024 * 1024 * 1024,
    processRssBytes: 256 * 1024 * 1024,
    processHeapUsedBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

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
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}

function buttonByText(renderer: ReactTestRenderer, text: string) {
  const buttons = renderer.root.findAll((node) => node.type === "button");
  const button = buttons.find((node) => collectText(node as unknown as ReactTestRendererJSON).includes(text));
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("formatDashboardBytes", () => {
  it.each([
    [512, "512 B"],
    [2048, "2.00 KB"],
    [5 * 1024 * 1024, "5.00 MB"],
    [3 * 1024 * 1024 * 1024, "3.00 GB"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatDashboardBytes(input)).toBe(expected);
  });
});

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshSubscriptionMock.callback = null;
    refreshSubscriptionMock.options = null;
    apiMocks.fetchDashboardState.mockResolvedValue(dashboardState());
    apiMocks.fetchSystemVitals.mockResolvedValue(systemVitals());
    apiMocks.fetchCronJobs.mockResolvedValue({
      items: [
        {
          jobId: "job-1",
          name: "Nightly Memory",
          schedule: "0 2 * * *",
          enabled: false,
        },
      ],
    });
    apiMocks.fetchOperators.mockResolvedValue({
      items: [
        {
          operatorId: "operator-a",
          sessionCount: 4,
          activeSessions: 2,
        },
      ],
    });
    apiMocks.fetchMemoryFiles.mockResolvedValue({
      items: [{ relativePath: "memory/a.md", size: 10, modifiedAt: "2026-05-14T12:00:00.000Z" }],
    });
  });

  it("renders loaded operator attention state and routes dashboard actions", async () => {
    const onNavigate = vi.fn();
    const renderer = create(<DashboardPage onNavigate={onNavigate} />);

    await flush();

    const text = rendererText(renderer);
    expect(text).toContain("2 approvals are waiting on you");
    expect(text).toContain("1 scheduler jobs are disabled");
    expect(text).toContain("2 active operator sessions in flight");
    expect(text).toContain("8.00 GB");
    expect(text).toContain("256.00 MB");
    expect(text).toContain("Nightly Memory");
    expect(text).toContain("operator-a");

    await act(async () => {
      buttonByText(renderer, "Review approvals").props.onClick();
      buttonByText(renderer, "Open agent board").props.onClick();
      buttonByText(renderer, "Review jobs").props.onClick();
      buttonByText(renderer, "Inspect runs").props.onClick();
      buttonByText(renderer, "Configure connections").props.onClick();
    });

    expect(onNavigate).toHaveBeenCalledWith("approvals");
    expect(onNavigate).toHaveBeenCalledWith("office");
    expect(onNavigate).toHaveBeenCalledWith("tasks");
    expect(onNavigate).toHaveBeenCalledWith("sessions");
    expect(onNavigate).toHaveBeenCalledWith("integrations");
  });

  it("renders the quiet dashboard when there are no urgent items", async () => {
    apiMocks.fetchDashboardState.mockResolvedValue(
      dashboardState({ pendingApprovals: 0, activeSubagents: 0, taskStatusCounts: [] }),
    );
    apiMocks.fetchCronJobs.mockResolvedValue({ items: [] });
    apiMocks.fetchOperators.mockResolvedValue({ items: [] });
    apiMocks.fetchMemoryFiles.mockResolvedValue({ items: [] });

    const renderer = create(<DashboardPage />);
    await flush();

    const text = rendererText(renderer);
    expect(text).toContain("No urgent blockers detected. All clear.");
    expect(text).toContain("No scheduler jobs configured.");
    expect(text).toContain("No operators registered.");
    expect(text).toContain("Open chat");
    expect(text).toContain("Open settings");
  });

  it("routes the hero primary action to active sessions when operators are running without approvals", async () => {
    const onNavigate = vi.fn();
    apiMocks.fetchDashboardState.mockResolvedValue(
      dashboardState({ pendingApprovals: 0, activeSubagents: 0, taskStatusCounts: [] }),
    );
    apiMocks.fetchCronJobs.mockResolvedValue({ items: [] });
    apiMocks.fetchOperators.mockResolvedValue({
      items: [{ operatorId: "operator-a", sessionCount: 4, activeSessions: 2 }],
    });

    const renderer = create(<DashboardPage onNavigate={onNavigate} />);
    await flush();

    expect(refreshSubscriptionMock.options).toMatchObject({
      enabled: true,
      coalesceMs: 900,
      staleMs: 20000,
      pollIntervalMs: 15000,
    });
    expect(rendererText(renderer)).toContain("Inspect active runs");

    await act(async () => {
      buttonByText(renderer, "Inspect active runs").props.onClick();
      buttonByText(renderer, "Open settings").props.onClick();
    });

    expect(onNavigate).toHaveBeenCalledWith("sessions");
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("keeps usable dashboard data visible when supplementary refreshes fail", async () => {
    apiMocks.fetchCronJobs.mockRejectedValue(new Error("cron down"));
    apiMocks.fetchOperators.mockRejectedValue(new Error("operators down"));
    apiMocks.fetchMemoryFiles.mockRejectedValue(new Error("memory down"));

    const renderer = create(<DashboardPage />);
    await flush();

    const text = rendererText(renderer);
    expect(text).toContain("Background refresh degraded: unable to refresh scheduler, operators, memory files.");
    expect(text).toContain("No scheduler jobs configured.");
    expect(text).toContain("No operators registered.");
  });

  it("blocks the page on core dashboard load failure", async () => {
    apiMocks.fetchDashboardState.mockRejectedValue(new Error("dashboard down"));
    apiMocks.fetchSystemVitals.mockRejectedValue(new Error("vitals down"));

    const renderer = create(<DashboardPage />);
    await flush();

    expect(rendererText(renderer)).toContain("dashboard down | vitals down");
  });

  it("keeps previous dashboard content visible when a background core refresh fails", async () => {
    const renderer = create(<DashboardPage />);
    await flush();

    expect(rendererText(renderer)).toContain("Nightly Memory");
    apiMocks.fetchDashboardState.mockRejectedValueOnce(new Error("dashboard later down"));
    apiMocks.fetchSystemVitals.mockResolvedValueOnce(systemVitals());

    await act(async () => {
      await refreshSubscriptionMock.callback?.();
    });
    await flush();

    const text = rendererText(renderer);
    expect(text).toContain("Background refresh failed: dashboard later down");
    expect(text).toContain("Nightly Memory");
  });
});
