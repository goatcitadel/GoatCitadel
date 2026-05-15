// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { Server } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCard, NativeList, NativePageFrame, QuickJumpCard } from "./NativeRoutePageLayout";

const diagnosticMocks = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: diagnosticMocks.recordClientDiagnostic,
}));

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  diagnosticMocks.recordClientDiagnostic.mockClear();
});

describe("NativeRoutePageLayout", () => {
  it("records mounted and tall-layout diagnostics without blocking route rendering", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1200,
      height: 2000,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 2000,
      toJSON: () => ({}),
    } as DOMRect);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <NativePageFrame
          icon={Server}
          kicker="Ops"
          title="Runtime"
          description="Runtime posture"
          loading={false}
          error="Runtime source failed"
        >
          <NativeCard title="Scrollable" subtitle="Body" scrollBody bodyMaxHeight="10rem">
            Tall content
          </NativeCard>
        </NativePageFrame>,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("Runtime source failed");
    expect(diagnosticMocks.recordClientDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "native.route.frame.mounted",
        route: "Ops",
      }),
    );
    expect(diagnosticMocks.recordClientDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "native.route.layout.tall",
        level: "warn",
        route: "Ops",
        context: expect.objectContaining({ routeHeight: 2000, viewportHeight: 800, scrollContainers: 1 }),
      }),
    );
  });

  it("renders native cards, lists, and quick-jump actions across compact and empty branches", () => {
    const cardMarkup = renderToStaticMarkup(
      <NativeCard
        title="Runtime"
        subtitle="Controls"
        density="compact"
        className="custom-card"
        stats={[{ label: "Health", value: "ready" }]}
        actions={<button type="button">Refresh</button>}
      >
        <NativeList
          ariaLabel="Runtime items"
          density="compact"
          maxHeight="12rem"
          items={[{ title: "Daemon", meta: "running", body: "localhost" }]}
        />
      </NativeCard>,
    );
    expect(cardMarkup).toContain("custom-card");
    expect(cardMarkup).toContain("ready");
    expect(cardMarkup).toContain('data-native-scroll="true"');
    expect(renderToStaticMarkup(<NativeList items={[]} emptyLabel="Empty route" />)).toContain("Empty route");

    const navigate = vi.fn();
    const onSelect = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QuickJumpCard
          title="Jump"
          subtitle="Route choices"
          compact
          navigate={navigate}
          actions={[{ label: "Runtime", route: { area: "ops", section: "runtime" } as any, onSelect }]}
        />,
      );
    });

    act(() => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "runtime" });
  });
});
