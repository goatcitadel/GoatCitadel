// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ShellRouteStage } from "./MissionControlShellChrome";

it("cleans up the old surface while a replacement route is loading", async () => {
  const cleanup = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ready = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = () => {
      ready = true;
      resolve();
    };
  });
  function OldSurface() {
    useEffect(() => cleanup, []);
    return <div>Old surface</div>;
  }
  function ReplacementSurface() {
    if (!ready) throw pending;
    return <div>Replacement ready</div>;
  }
  const props = {
    currentRouteDescription: "Fixture route",
    currentRouteLabel: "Fixture",
    fallback: <p role="status">Loading replacement</p>,
    onReturnToChat: vi.fn(),
    pageErrorResetKey: "/chat",
    usesFullStageLayout: false,
  };
  try {
    act(() =>
      root.render(
        <ShellRouteStage {...props} surfaceKey="chat">
          <OldSurface />
        </ShellRouteStage>,
      ),
    );
    act(() =>
      root.render(
        <ShellRouteStage {...props} surfaceKey="library:memory" pageErrorResetKey="/library/memory">
          <ReplacementSurface />
        </ShellRouteStage>,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading replacement");
    expect(cleanup).toHaveBeenCalledOnce();
    await act(async () => release());
    expect(container.textContent).toContain("Replacement ready");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
