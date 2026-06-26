import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  controllerProps: null as null | Record<string, unknown>,
  pageProps: null as null | Record<string, unknown>,
  fetchEffectivePermissionProfile: vi.fn(() => new Promise(() => undefined)),
  renderSurfaceInput: { controller: "ready" } as Record<string, unknown>,
}));

vi.mock("@goatcitadel/threaded-surface-core", () => ({
  MissionThreadedControllerHost: (props: Record<string, unknown> & { renderSurface: (input: unknown) => unknown }) => {
    routeMocks.controllerProps = props;
    return createElement(
      "div",
      { className: "mock-controller-host" },
      props.renderSurface(routeMocks.renderSurfaceInput) as ReactNode,
    );
  },
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchEffectivePermissionProfile: routeMocks.fetchEffectivePermissionProfile,
}));

vi.mock("./ThreadedSurfacePage", () => ({
  ThreadedSurfacePage: (props: Record<string, unknown>) => {
    routeMocks.pageProps = props;
    return createElement("section", { className: "mock-threaded-page" }, String(props.surface));
  },
}));

describe("ThreadedSurfaceRoute", () => {
  beforeEach(() => {
    routeMocks.controllerProps = null;
    routeMocks.pageProps = null;
    routeMocks.renderSurfaceInput = { controller: "ready" };
    routeMocks.fetchEffectivePermissionProfile.mockReset();
    routeMocks.fetchEffectivePermissionProfile.mockImplementation(() => new Promise(() => undefined));
  });

  it("passes route chrome and render-surface input through the shared controller host", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    const onOpenCowork = vi.fn();
    const onOpenCode = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenApprovals = vi.fn();
    const onOpenStartHere = vi.fn();
    const onOpenUniversalRunDetail = vi.fn();
    const onNavigateSurface = vi.fn();
    const gatewayStatus = {
      ready: true,
      tone: "success",
      label: "Gateway ready",
      detail: "Gateway ready. Daemon health is serving.",
    } as const;

    const renderer = create(
      createElement(ThreadedSurfaceRoute, {
        surface: "code",
        workspaceId: "workspace-1",
        workspaceName: "Workspace One",
        gatewayStatus,
        approvalsCount: 4,
        lockSurface: true,
        hidePageHeader: true,
        onOpenCowork,
        onOpenCode,
        onOpenTasks,
        onOpenApprovals,
        onOpenStartHere,
        onOpenUniversalRunDetail,
        onNavigateSurface,
      }),
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("code");
    expect(routeMocks.controllerProps).toMatchObject({
      workspaceId: "workspace-1",
      workspaceName: "Workspace One",
      gatewayStatus,
      approvalsCount: 4,
      surface: "code",
      lockSurface: true,
      hidePageHeader: true,
      onOpenCowork,
      onOpenCode,
      onOpenTasks,
      onOpenApprovals,
      onOpenStartHere,
      onNavigateSurface,
    });
    expect(routeMocks.pageProps).toMatchObject({
      surface: "code",
      input: { controller: "ready" },
      permissionState: { loading: true },
      onOpenUniversalRunDetail,
    });
  });

  it("passes resolved permission profile and override state into the threaded page", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    routeMocks.renderSurfaceInput = {
      activeSessionSurfaceProps: {
        selectedSessionId: "session-1",
        selectedTurn: {
          trace: {
            durable: {
              runId: "run-1",
            },
          },
        },
      },
    };
    routeMocks.fetchEffectivePermissionProfile.mockResolvedValueOnce({
      permissionProfileId: "trusted-local-power",
      permissionProfile: {
        label: "Trusted Local Power",
        approvalMode: "bypass",
      },
      localOperatorOverrideId: "override-1",
      localOperatorOverride: {
        expiresAt: "2026-05-17T20:30:00.000Z",
      },
    });

    await act(async () => {
      create(
        createElement(ThreadedSurfaceRoute, {
          surface: "cowork",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
      );
      await Promise.resolve();
    });

    expect(routeMocks.fetchEffectivePermissionProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      surface: "cowork",
      sessionId: "session-1",
      runId: "run-1",
    });
    expect(routeMocks.pageProps).toMatchObject({
      surface: "cowork",
      permissionState: {
        loading: false,
        profileId: "trusted-local-power",
        profileLabel: "Trusted Local Power",
        approvalMode: "bypass",
        localOperatorOverrideId: "override-1",
        overrideExpiresAt: "2026-05-17T20:30:00.000Z",
      },
    });
  });

  it("accepts flat effective permission fields from older gateway responses", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    routeMocks.renderSurfaceInput = {
      activeSessionSurfaceProps: {
        selectedSessionId: "session-1",
        selectedTurn: {
          trace: {
            orchestration: { runId: "orchestration-run-1" },
            durable: { runId: "durable-run-1" },
          },
        },
      },
    };
    routeMocks.fetchEffectivePermissionProfile.mockResolvedValueOnce({
      permissionProfileId: "safe",
      permissionProfileLabel: "Safe",
      permissionProfileApprovalMode: "approve_all",
      localOperatorOverrideId: "override-flat",
      localOperatorOverrideExpiresAt: "2026-05-17T21:00:00.000Z",
    });

    await act(async () => {
      create(
        createElement(ThreadedSurfaceRoute, {
          surface: "chat",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
      );
      await Promise.resolve();
    });

    expect(routeMocks.fetchEffectivePermissionProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      surface: "chat",
      sessionId: "session-1",
      runId: "orchestration-run-1",
    });
    expect(routeMocks.pageProps).toMatchObject({
      permissionState: {
        loading: false,
        profileId: "safe",
        profileLabel: "Safe",
        approvalMode: "approve_all",
        localOperatorOverrideId: "override-flat",
        overrideExpiresAt: "2026-05-17T21:00:00.000Z",
      },
    });
  });

  it("accepts nested-only local override identity from effective permission responses", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    routeMocks.renderSurfaceInput = {
      activeSessionSurfaceProps: {
        selectedSessionId: "session-1",
        selectedTurn: {
          trace: {
            durable: { runId: "run-1" },
          },
        },
      },
    };
    routeMocks.fetchEffectivePermissionProfile.mockResolvedValueOnce({
      permissionProfileId: "trusted-local-power",
      permissionProfile: {
        label: "Trusted Local Power",
        approvalMode: "bypass",
      },
      localOperatorOverride: {
        overrideId: "override-nested",
        expiresAt: "2026-05-17T22:00:00.000Z",
      },
    });

    await act(async () => {
      create(
        createElement(ThreadedSurfaceRoute, {
          surface: "code",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
      );
      await Promise.resolve();
    });

    expect(routeMocks.pageProps).toMatchObject({
      permissionState: {
        loading: false,
        localOperatorOverrideId: "override-nested",
        overrideExpiresAt: "2026-05-17T22:00:00.000Z",
      },
    });
  });

  it("does not refetch effective permissions when the render-surface object changes but ids do not", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    routeMocks.fetchEffectivePermissionProfile.mockResolvedValue({
      permissionProfileId: "safe",
      permissionProfile: {
        label: "Safe",
        approvalMode: "approve_all",
      },
    });
    routeMocks.renderSurfaceInput = {
      activeSessionSurfaceProps: {
        selectedSessionId: "session-1",
        selectedTurn: {
          trace: { durable: { runId: "run-1" } },
        },
      },
    };

    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        createElement(ThreadedSurfaceRoute, {
          surface: "code",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
      );
      await Promise.resolve();
    });
    expect(routeMocks.fetchEffectivePermissionProfile).toHaveBeenCalledTimes(1);

    routeMocks.renderSurfaceInput = {
      activeSessionSurfaceProps: {
        selectedSessionId: "session-1",
        selectedTurn: {
          trace: { durable: { runId: "run-1" } },
        },
      },
    };
    await act(async () => {
      renderer!.update(
        createElement(ThreadedSurfaceRoute, {
          surface: "code",
          workspaceId: "workspace-1",
          workspaceName: "Workspace One",
          approvalsCount: 0,
        }),
      );
      await Promise.resolve();
    });

    expect(routeMocks.fetchEffectivePermissionProfile).toHaveBeenCalledTimes(1);
  });
});
