// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Dialog } from "../ui/Dialog";
import { InspectorPanel, InspectorProvider, useInspector } from "./inspector";

vi.unmock("vaul");
const installation = vi.hoisted(() => ({ value: "http://inspector.invalid" }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => installation.value,
}));
let preferences: ReturnType<typeof useUiPreferences>;
function ScopeProbe() {
  preferences = useUiPreferences();
  return <Probe />;
}
let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useInspector>;

function Probe() {
  api = useInspector();
  return null;
}

beforeEach(() => {
  installation.value = "http://inspector.invalid";
  window.history.replaceState(null, "", "/chat?sessionId=current&shell=cockpit");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("inspector", () => {
  it("keeps the provider connected to consumers from a refreshed component module", async () => {
    const refreshedPath = "./inspector?hmr_probe=qa";
    const refreshed: typeof import("./inspector") = await import(refreshedPath);
    function RefreshedProbe() {
      api = refreshed.useInspector();
      return null;
    }
    await act(async () =>
      root.render(
        <InspectorProvider>
          <RefreshedProbe />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    act(() => api.open({ title: "Refreshed consumer", body: <p>Still connected</p> }));
    expect(container.querySelector('[aria-label="Inspector: Refreshed consumer"]')?.textContent).toContain(
      "Still connected",
    );
  });

  it("opens typed detail and closes on Escape", () => {
    act(() => {
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      );
    });
    act(() => api.open({ title: "Run", body: <p>Steps</p> }));
    expect(container.querySelector('[aria-label="Inspector: Run"]')?.textContent).toContain("Steps");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector('[aria-label="Inspector: Run"]')).toBeNull();
  });

  it("refreshes only the matching owner and closes its panel when the owner leaves", () => {
    act(() => {
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      );
    });
    act(() => api.open({ source: "chat", title: "Conversation", body: <p>First model</p> }));
    act(() => api.updateIfOpen("system", { source: "system", title: "System", body: <p>Other owner</p> }));
    expect(container.textContent).toContain("First model");
    act(() => api.updateIfOpen("chat", { source: "chat", title: "Conversation", body: <p>Current model</p> }));
    expect(container.textContent).toContain("Current model");
    act(() => api.closeIfOpen("chat"));
    expect(container.querySelector('[aria-label="Inspector: Conversation"]')).toBeNull();
  });

  it("uses an accessible bottom sheet for the phone inspector", () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: media === "(width < 640px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    act(() => {
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      );
    });
    act(() => api.open({ title: "Run", body: <p>Steps</p> }));
    expect(document.querySelector('.cockpit-sheet [aria-label="Inspector: Run"]')?.textContent).toContain("Steps");
    expect(container.querySelector("aside.cockpit-inspector")).toBeNull();
  });
  it("opens only a registered current selection with Ctrl+I and cannot resurrect it after route ABA", () => {
    act(() =>
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    const key = () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true }));
    };
    act(key);
    expect(container.querySelector("aside")).toBeNull();
    act(() => api.register("chat", { source: "chat", title: "Current conversation", body: <p>Scoped evidence</p> }));
    act(key);
    expect(container.textContent).toContain("Scoped evidence");
    act(key);
    expect(container.querySelector("aside")).toBeNull();
    const oldOpen = api.open,
      href = window.location.href;
    act(() => {
      window.history.pushState(null, "", "/inbox");
      window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
    });
    act(() => {
      window.history.pushState(null, "", href);
      window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
    });
    act(() => {
      oldOpen({ title: "Old approval", body: <p>Stale</p> });
      key();
    });
    expect(container.querySelector("aside")).toBeNull();
  });

  it("bounds keyboard resize and releases pointer capture when its current inspector closes", () => {
    act(() =>
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    act(() => api.open({ title: "Run", body: <p>Current run</p> }));
    const separator = container.querySelector<HTMLDivElement>('[role="separator"]')!;
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("360");
    const capture = vi.fn(),
      release = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { value: capture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: release },
    });
    act(() =>
      separator.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 7, button: 0, clientX: 600, bubbles: true }),
      ),
    );
    expect(capture).toHaveBeenCalledWith(7);
    act(() => api.close());
    expect(release).toHaveBeenCalledWith(7);
  });

  it("invalidates registered evidence across scope ABA and a dynamic installation change", () => {
    act(() => {
      root.render(
        <UiPreferencesProvider>
          <InspectorProvider>
            <ScopeProbe />
            <InspectorPanel />
          </InspectorProvider>
        </UiPreferencesProvider>,
      );
    });
    act(() => {
      preferences.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    act(() => {
      api.register("approval", { source: "approval", title: "Exact approval", body: <p>Private origin evidence</p> });
    });
    const oldOpen = api.open;
    act(() => {
      preferences.setActiveScope({ citadelId: "cit-b", workspaceId: "ws-b" });
    });
    act(() => {
      preferences.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    act(() => {
      oldOpen({ title: "Old approval", body: <p>Private origin evidence</p> });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true }));
    });
    expect(container.querySelector("aside")).toBeNull();
    act(() => {
      api.register("chat", { source: "chat", title: "Current", body: <p>Current evidence</p> });
    });
    installation.value = "http://other-inspector.invalid";
    act(() => {
      api.open({ title: "Old installation", body: <p>Private origin evidence</p> });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true }));
    });
    expect(container.querySelector("aside")).toBeNull();
  });

  it("leaves the inspector intact when a newer modal is the top layer", () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: media === "(width < 640px)" || media === "(width < 1024px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const onOpenChange = vi.fn();
    const render = (review: boolean) => (
      <InspectorProvider>
        <Probe />
        <InspectorPanel />
        <Dialog open={review} onOpenChange={onOpenChange} title="Review change">
          <button type="button">Current review</button>
        </Dialog>
      </InspectorProvider>
    );
    act(() => {
      root.render(render(false));
    });
    act(() => {
      api.open({ title: "Run", body: <p>Current run evidence</p> });
    });
    act(() => {
      root.render(render(true));
    });
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(2);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true }));
    });
    expect(document.querySelector('[aria-label="Inspector: Run"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[aria-label="Inspector: Run"]')).not.toBeNull();
  });
});
