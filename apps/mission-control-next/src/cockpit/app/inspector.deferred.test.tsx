// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { InspectorPanel, InspectorProvider, useInspector } from "./inspector";

const loader = vi.hoisted(() => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { start: vi.fn(), held, release };
});

vi.mock("./inspector-panel-controls", async (importOriginal) => {
  loader.start();
  await loader.held;
  return importOriginal<typeof import("./inspector-panel-controls")>();
});

it("loads controls only on opening and never revives a retired modal selection", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: media === "(width < 1024px)" || media === "(width < 1280px)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderEvidence = vi.fn();
  function Evidence() {
    renderEvidence();
    return <p>Private evidence</p>;
  }
  function Trigger() {
    const { open } = useInspector();
    return (
      <button onClick={() => open({ title: "Run", body: <Evidence /> })} type="button">
        Inspect run
      </button>
    );
  }
  try {
    await act(async () =>
      root.render(
        <InspectorProvider>
          <Trigger />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    expect(loader.start).not.toHaveBeenCalled();
    const trigger = container.querySelector("button")!;
    trigger.focus();
    await act(async () => trigger.click());
    await vi.waitFor(() => expect(loader.start).toHaveBeenCalledOnce());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Loading inspector");
    expect(renderEvidence).not.toHaveBeenCalled();

    await act(async () => notifyGatewayAccessChanged(false));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => {
      loader.release();
      await vi.dynamicImportSettled();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(renderEvidence).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  } finally {
    loader.release();
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
