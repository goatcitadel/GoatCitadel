import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RuntimeRoutePage } from "./RuntimeRoutePage";

vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => ({
    loading: false,
    error: null,
    notice: { tone: "success", message: "Daemon restarted." },
    daemonBusy: null,
    reload: vi.fn(),
    runDaemonAction: vi.fn(),
    data: {
      dashboard: {
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 2,
        activeSubagents: 3,
        taskStatusCounts: [],
        recentEvents: [],
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
        scheduler: { jobs: [], reviewQueue: [] },
        improvement: {
          reports: [{ reportId: "report-1", title: "Quality review", createdAt: "2026-04-22T00:00:00.000Z" }],
          replayRuns: [{ runId: "replay-1", status: "completed", updatedAt: "2026-04-22T00:10:00.000Z" }],
        },
      },
      health: {
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
      },
      cost: {
        scope: "day",
        from: "",
        to: "",
        usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
        items: [
          { key: "openai:gpt-5", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 4000, costUsd: 12.34 },
        ],
      },
      daemon: {
        running: true,
        pid: 42,
        uptimeSeconds: 1200,
        host: "localhost",
        state: "running",
        supported: true,
        controllable: true,
        controlMessage: "ok",
      },
      backups: [],
      sessions: [],
      mcpServers: [{ serverId: "srv-1", label: "GitHub", transport: "stdio", enabled: true, category: "code" }],
    },
  }),
}));

describe("RuntimeRoutePage", () => {
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
});
