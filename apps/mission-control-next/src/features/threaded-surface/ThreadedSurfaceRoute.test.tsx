import { createElement, type ReactNode } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  controllerProps: null as null | Record<string, unknown>,
  pageProps: null as null | Record<string, unknown>,
}));

vi.mock("@goatcitadel/threaded-surface-core", () => ({
  MissionThreadedControllerHost: (props: Record<string, unknown> & { renderSurface: (input: unknown) => unknown }) => {
    routeMocks.controllerProps = props;
    return createElement(
      "div",
      { className: "mock-controller-host" },
      props.renderSurface({ controller: "ready" }) as ReactNode,
    );
  },
}));

vi.mock("./ThreadedSurfacePage", () => ({
  ThreadedSurfacePage: (props: Record<string, unknown>) => {
    routeMocks.pageProps = props;
    return createElement("section", { className: "mock-threaded-page" }, String(props.surface));
  },
}));

describe("ThreadedSurfaceRoute", () => {
  it("passes route chrome and render-surface input through the shared controller host", async () => {
    const { ThreadedSurfaceRoute } = await import("./ThreadedSurfaceRoute");
    const onOpenCowork = vi.fn();
    const onOpenCode = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenApprovals = vi.fn();
    const onNavigateSurface = vi.fn();

    const renderer = create(
      createElement(ThreadedSurfaceRoute, {
        surface: "code",
        workspaceId: "workspace-1",
        workspaceName: "Workspace One",
        approvalsCount: 4,
        lockSurface: true,
        onOpenCowork,
        onOpenCode,
        onOpenTasks,
        onOpenApprovals,
        onNavigateSurface,
      }),
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("code");
    expect(routeMocks.controllerProps).toMatchObject({
      workspaceId: "workspace-1",
      workspaceName: "Workspace One",
      approvalsCount: 4,
      surface: "code",
      lockSurface: true,
      onOpenCowork,
      onOpenCode,
      onOpenTasks,
      onOpenApprovals,
      onNavigateSurface,
    });
    expect(routeMocks.pageProps).toMatchObject({
      surface: "code",
      input: { controller: "ready" },
    });
  });
});
