import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeRoutePage } from "./RuntimeRoutePage";

const runtimeSnapshotOverrides = vi.hoisted(() => ({
  sourceStatus: null as null | Record<string, { status: "ok" | "error"; error?: string }>,
  daemon: undefined as unknown,
  health: undefined as unknown,
  data: undefined as unknown,
  daemonBusy: null as null | "start" | "restart" | "stop",
  notice: undefined as unknown,
  reload: vi.fn(),
  runDaemonAction: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => ({
    loading: false,
    error: null,
    notice:
      runtimeSnapshotOverrides.notice === undefined
        ? { tone: "success", message: "Daemon restarted." }
        : runtimeSnapshotOverrides.notice,
    daemonBusy: runtimeSnapshotOverrides.daemonBusy,
    reload: runtimeSnapshotOverrides.reload,
    runDaemonAction: runtimeSnapshotOverrides.runDaemonAction,
    data:
      runtimeSnapshotOverrides.data === undefined
        ? {
            dashboard: {
              timestamp: "2026-04-22T00:00:00.000Z",
              sessions: [
                {
                  sessionId: "session-dashboard",
                  displayName: "Dashboard session",
                  channel: "chat",
                  lastActivityAt: "2026-04-22T00:00:00.000Z",
                },
              ],
              pendingApprovals: 2,
              activeSubagents: 3,
              taskStatusCounts: [],
              recentEvents: [{ eventType: "approval.created", source: "gateway" }],
              dailyCostUsd: 12.34,
            },
            timeline: {
              generatedAt: "2026-04-22T00:00:00.000Z",
              events: {
                items: [
                  {
                    eventId: "evt-1",
                    sequence: 1,
                    eventType: "approval.created",
                    source: "gateway",
                    timestamp: "2026-04-22T00:00:00.000Z",
                    payload: {},
                  },
                ],
              },
              sessions: { items: [] },
              scheduler: {
                jobs: [
                  {
                    jobId: "job-1",
                    name: "Daily review",
                    enabled: true,
                    action: "review",
                    nextRunAt: "2026-04-23T00:00:00.000Z",
                  },
                ],
                reviewQueue: [
                  {
                    itemId: "review-1",
                    reason: "Needs operator review",
                    status: "queued",
                    scheduledFor: "2026-04-23T00:00:00.000Z",
                  },
                ],
              },
              improvement: {
                reports: [
                  {
                    reportId: "report-1",
                    runId: "run-1",
                    title: "Quality review",
                    createdAt: "2026-04-22T00:00:00.000Z",
                  },
                ],
                replayRuns: [
                  {
                    runId: "replay-1",
                    status: "completed",
                    createdAt: "2026-04-22T00:05:00.000Z",
                    updatedAt: "2026-04-22T00:10:00.000Z",
                  },
                ],
              },
            },
            health:
              runtimeSnapshotOverrides.health === undefined
                ? {
                    generatedAt: "2026-04-22T00:00:00.000Z",
                    systemVitals: {
                      hostname: "goat",
                      platform: "win32",
                      release: "1.0",
                      uptimeSeconds: 3600,
                      loadAverage: [0.2, 0.1, 0.05],
                      cpuCount: 8,
                      memoryTotalBytes: 1000,
                      memoryFreeBytes: 400,
                      memoryUsedBytes: 600,
                      processRssBytes: 300,
                      processHeapUsedBytes: 200,
                    },
                    daemonStatus: {
                      running: true,
                      pid: 42,
                      uptimeSeconds: 1200,
                      host: "localhost",
                      state: "running",
                      supported: true,
                      controllable: true,
                      controlMessage: "ok",
                    },
                    daemonLogs: { items: [] },
                    costs: {
                      summary: {
                        scope: "day",
                        from: "",
                        to: "",
                        items: [],
                        usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
                      },
                      qmd: {
                        totalRuns: 8,
                        compressionPercent: 24,
                        expansionPercent: 0,
                        efficiencyLabel: "reduced",
                        netTokenDelta: -320,
                      },
                    },
                    backups: { items: [], latest: null },
                  }
                : runtimeSnapshotOverrides.health,
            cost: {
              scope: "day",
              from: "",
              to: "",
              usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
              items: [
                {
                  key: "openai:gpt-5",
                  tokenInput: 0,
                  tokenOutput: 0,
                  tokenCachedInput: 0,
                  tokenTotal: 4000,
                  costUsd: 12.34,
                },
              ],
            },
            daemon:
              runtimeSnapshotOverrides.daemon === undefined
                ? {
                    running: true,
                    pid: 42,
                    uptimeSeconds: 1200,
                    host: "localhost",
                    state: "running",
                    supported: true,
                    controllable: true,
                    controlMessage: "ok",
                  }
                : runtimeSnapshotOverrides.daemon,
            backups: [],
            sessions: [
              {
                sessionId: "session-1",
                displayName: "Chat session",
                channel: "chat",
                lastActivityAt: "2026-04-22T00:00:00.000Z",
              },
            ],
            mcpServers: [{ serverId: "srv-1", label: "GitHub", transport: "stdio", enabled: true, category: "code" }],
            sourceStatus: {
              dashboard: { status: "ok" },
              timeline: { status: "ok" },
              health: { status: "ok" },
              cost: { status: "ok" },
              daemon: { status: "ok" },
              backups: { status: "ok" },
              sessions: { status: "ok" },
              mcpServers: { status: "ok" },
              ...(runtimeSnapshotOverrides.sourceStatus ?? {}),
            },
          }
        : runtimeSnapshotOverrides.data,
  }),
}));

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}

describe("RuntimeRoutePage", () => {
  afterEach(() => {
    runtimeSnapshotOverrides.sourceStatus = null;
    runtimeSnapshotOverrides.daemon = undefined;
    runtimeSnapshotOverrides.health = undefined;
    runtimeSnapshotOverrides.data = undefined;
    runtimeSnapshotOverrides.daemonBusy = null;
    runtimeSnapshotOverrides.notice = undefined;
    runtimeSnapshotOverrides.reload.mockClear();
    runtimeSnapshotOverrides.runDaemonAction.mockClear();
  });

  it("renders runtime posture and daemon controls in the canonical next shell", () => {
    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Runtime posture");
    expect(markup).toContain("Daemon running");
    expect(markup).toContain("Start daemon");
    expect(markup).toContain("Restart daemon");
  });

  it("runs daemon controls and refreshes runtime posture from the canonical shell", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "runtime", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Start daemon").props.onClick();
      findButton(renderer!.root, "Restart daemon").props.onClick();
      findButton(renderer!.root, "Stop daemon").props.onClick();
      findButton(renderer!.root, "Refresh").props.onClick();
    });

    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("start");
    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("restart");
    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("stop");
    expect(runtimeSnapshotOverrides.reload).toHaveBeenCalledTimes(1);

    runtimeSnapshotOverrides.daemonBusy = "start";
    await act(async () => {
      renderer!.update(
        <RuntimeRoutePage
          route={{ area: "ops", section: "runtime", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    expect(collectText(renderer!.root)).toContain("Starting...");
    expect(findButton(renderer!.root, "Starting...").props.disabled).toBe(true);
  });

  it("renders all ops subsections and their route-specific summaries", () => {
    const sections = [
      ["sessions", "Session evidence"],
      ["schedules", "Scheduler review"],
      ["improvement", "Improvement reports"],
      ["costs", "Spend summary"],
      ["notifications", "Operator notifications"],
      ["activity", "Activity feed"],
    ] as const;

    for (const [section, expected] of sections) {
      const markup = renderToStaticMarkup(
        <RuntimeRoutePage
          route={{ area: "ops", section, theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      expect(markup).toContain(expected);
    }

    runtimeSnapshotOverrides.data = null;
    const noDataMarkup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "activity", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );
    expect(noDataMarkup).toContain("Activity");
    expect(noDataMarkup).not.toContain("Activity feed");
  });

  it("navigates with canonical next-route objects instead of legacy URL strings", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "diagnostics", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    const promptPacksButton = buttons.find(
      (button: ReactTestInstance) =>
        button.findAll((node) => typeof node.props?.children === "string" && node.props.children === "Prompt packs")
          .length > 0,
    );

    expect(promptPacksButton).toBeDefined();

    act(() => {
      promptPacksButton!.props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({
      area: "library",
      section: "prompt-packs",
      theme: "ops",
    });
    expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty("space");
  });

  it("renders unavailable state instead of false runtime measurements when sources fail", () => {
    runtimeSnapshotOverrides.daemon = null;
    runtimeSnapshotOverrides.health = null;
    runtimeSnapshotOverrides.sourceStatus = {
      daemon: { status: "error", error: "daemon route failed" },
      health: { status: "error", error: "health route failed" },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Daemon unavailable");
    expect(markup).toContain("Backup status unavailable");
    expect(markup).toContain("unavailable");
    expect(markup).not.toContain("<strong>0</strong>");
    expect(markup).not.toContain("<strong>0 B</strong>");
  });

  it("covers degraded runtime formatting, backups, diagnostics, notifications, and QMD variants", () => {
    runtimeSnapshotOverrides.data = {
      dashboard: {
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: Number.NaN,
      },
      timeline: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        events: {
          items: [
            {
              eventId: "evt-runtime",
              sequence: 1,
              eventType: "runtime.failed",
              eventClass: "error",
              source: "gateway",
              timestamp: "bad-date",
              payload: {},
            },
          ],
        },
        sessions: { items: [] },
        scheduler: { jobs: [], reviewQueue: [] },
        improvement: { reports: [], replayRuns: [] },
      },
      health: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        systemVitals: {
          hostname: "edge",
          platform: "win32",
          release: "1.0",
          uptimeSeconds: -1,
          loadAverage: [],
          cpuCount: 8,
          memoryTotalBytes: 64 * 1024 * 1024,
          memoryFreeBytes: 0,
          memoryUsedBytes: 10 * 1024 * 1024,
          processRssBytes: 1536,
          processHeapUsedBytes: Number.POSITIVE_INFINITY,
        },
        daemonStatus: {
          running: false,
          pid: 0,
          uptimeSeconds: 0,
          host: "localhost",
          state: "stopped",
          supported: true,
          controllable: false,
          controlMessage: "manual",
        },
        daemonLogs: { items: [{ level: "warn", timestamp: "bad-date", message: "Runtime warning" }] },
        costs: {
          summary: {
            scope: "day",
            from: "",
            to: "",
            items: [],
            usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
          },
          qmd: {
            totalRuns: 1,
            compressionPercent: 0,
            expansionPercent: 14,
            efficiencyLabel: "expanded",
            netTokenDelta: 42.4,
          },
        },
        backups: { items: [], latest: null },
      },
      cost: {
        scope: "month",
        from: "",
        to: "",
        usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
        items: [
          {
            key: "unknown:model",
            tokenInput: 0,
            tokenOutput: 0,
            tokenCachedInput: 0,
            tokenTotal: 0,
            costUsd: Number.NaN,
          },
        ],
      },
      daemon: {
        running: false,
        pid: 0,
        uptimeSeconds: 0,
        host: "edge",
        state: "stopped",
        supported: true,
        controllable: false,
        controlMessage: "manual",
      },
      backups: [{ backupId: "backup-1", createdAt: undefined, files: ["a", "b"] }],
      sessions: [],
      mcpServers: [{ serverId: "srv-2", label: "Local MCP", transport: "http", enabled: false }],
      sourceStatus: {
        dashboard: { status: "ok" },
        timeline: { status: "ok" },
        health: { status: "ok" },
        cost: { status: "ok" },
        daemon: { status: "ok" },
        backups: { status: "ok" },
        sessions: { status: "ok" },
        mcpServers: { status: "ok" },
      },
    } as any;

    const commonProps = {
      activeWorkspaceId: "default",
      activeWorkspaceName: "Default",
      pendingApprovals: 0,
      navigate: vi.fn(),
      setActiveWorkspaceId: vi.fn(),
    };

    const runtimeMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "runtime", theme: "ops" } as any} {...commonProps} />,
    );
    expect(runtimeMarkup).toContain("Daemon stopped");
    expect(runtimeMarkup).toContain("No backup");
    expect(runtimeMarkup).toContain("Read only");
    expect(runtimeMarkup).toContain("Unknown · 2 files");
    expect(runtimeMarkup).toContain("http · general");

    const diagnosticsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "diagnostics", theme: "ops" } as any} {...commonProps} />,
    );
    expect(diagnosticsMarkup).toContain("n/a");
    expect(diagnosticsMarkup).toContain("0m");
    expect(diagnosticsMarkup).toContain("Runtime warning");

    const costsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "costs", theme: "ops" } as any} {...commonProps} />,
    );
    expect(costsMarkup).toContain("Expanded");
    expect(costsMarkup).toContain("+42 tokens");
    expect(costsMarkup).toContain("$0.00");

    runtimeSnapshotOverrides.data = {
      ...(runtimeSnapshotOverrides.data as any),
      health: {
        ...(runtimeSnapshotOverrides.data as any).health,
        costs: {
          ...(runtimeSnapshotOverrides.data as any).health.costs,
          qmd: {
            ...(runtimeSnapshotOverrides.data as any).health.costs.qmd,
            efficiencyLabel: "neutral",
            netTokenDelta: 0,
          },
        },
      },
    };
    expect(
      renderToStaticMarkup(
        <RuntimeRoutePage route={{ area: "ops", section: "costs", theme: "ops" } as any} {...commonProps} />,
      ),
    ).toContain("no token delta");

    const notificationsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "notifications", theme: "ops" } as any} {...commonProps} />,
    );
    expect(notificationsMarkup).toContain("Daemon needs intervention");
    expect(notificationsMarkup).toContain("runtime.failed");
    expect(notificationsMarkup).toContain("Unknown");
  });

  it("renders runtime without notices and with a ready backup signal", () => {
    runtimeSnapshotOverrides.notice = null;
    runtimeSnapshotOverrides.health = {
      generatedAt: "2026-04-22T00:00:00.000Z",
      systemVitals: {
        hostname: "goat",
        platform: "win32",
        release: "1.0",
        uptimeSeconds: 3600,
        loadAverage: [0.2],
        cpuCount: 8,
        memoryTotalBytes: 1000,
        memoryFreeBytes: 400,
        memoryUsedBytes: 600,
        processRssBytes: 300,
        processHeapUsedBytes: 200,
      },
      daemonStatus: {
        running: true,
        pid: 42,
        uptimeSeconds: 1200,
        host: "localhost",
        state: "running",
        supported: true,
        controllable: true,
        controlMessage: "ok",
      },
      daemonLogs: { items: [] },
      costs: {
        summary: {
          scope: "day",
          from: "",
          to: "",
          items: [],
          usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
        },
        qmd: {
          totalRuns: 1,
          compressionPercent: 0,
          expansionPercent: 0,
          efficiencyLabel: "neutral",
          netTokenDelta: 0,
        },
      },
      backups: { items: [], latest: { backupId: "latest-backup" } },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Backup ready");
    expect(markup).not.toContain("Daemon restarted.");
  });
});
