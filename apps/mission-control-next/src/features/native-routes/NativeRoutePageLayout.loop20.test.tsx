// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { Server } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "./NativeRoutePageLayout";

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

describe("NativeRoutePageLayout loop 20 branch tails", () => {
  it("renders loading frames without scheduling tall-layout diagnostics", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <NativePageFrame
          icon={Server}
          kicker="Library"
          title="Skills"
          description="Loading skill catalog"
          loading
          error={null}
        >
          Loaded content
        </NativePageFrame>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Loading current route data");
    expect(container.textContent).not.toContain("Loaded content");
    expect(raf).not.toHaveBeenCalled();
    expect(diagnosticMocks.recordClientDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "native.route.frame.mounted",
        context: expect.objectContaining({ loading: true, hasError: false }),
      }),
    );
  });

  it("renders native grids with and without optional class names", () => {
    expect(renderToStaticMarkup(<NativeGrid>Default</NativeGrid>)).toContain('class="mc-next-directory-grid-native"');
    expect(renderToStaticMarkup(<NativeGrid className="custom-grid">Custom</NativeGrid>)).toContain("custom-grid");
  });

  it("handles frames before DOM refs exist and zero-height viewport checks", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <NativePageFrame
          icon={Server}
          kicker="Ops"
          title="Runtime"
          description="Runtime posture"
          loading={false}
          error={null}
        >
          Runtime content
        </NativePageFrame>,
      );
    });

    expect(raf).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 0 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 900,
      height: 1200,
      top: 0,
      left: 0,
      right: 900,
      bottom: 1200,
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
          error={null}
        >
          Runtime content
        </NativePageFrame>,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("Runtime content");
    expect(diagnosticMocks.recordClientDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "native.route.layout.tall",
      }),
    );
  });

  it("renders optional list and quick-jump branches without extra metadata", () => {
    expect(renderToStaticMarkup(<NativeList items={[{ title: "Daemon" }]} />)).toContain("<strong>Daemon</strong>");
    expect(renderToStaticMarkup(<NativeList items={[{ title: "Daemon" }]} />)).not.toContain("<p></p>");
    expect(
      renderToStaticMarkup(
        <QuickJumpCard
          title="Jump"
          subtitle="Route choices"
          navigate={vi.fn()}
          actions={[{ label: "Runtime", route: { area: "ops", section: "runtime" } as any }]}
        />,
      ),
    ).not.toContain("mc-next-directory-quickjump-inline");
  });
});
