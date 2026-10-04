// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitAccessGate } from "./CockpitAccessGate";
import { applyCockpitAppearance } from "./cockpit-appearance";

vi.mock("./use-cockpit-shell-switch", () => ({
  useCockpitShellSwitch: () => ({ request: vi.fn(), feedback: null }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

describe("cockpit access gate", () => {
  it("tells the operator how to start an unreachable Gateway", async () => {
    const onRetry = vi.fn();
    await act(async () =>
      root.render(<CockpitAccessGate access={{ status: "unreachable" } as never} busy={false} onRetry={onRetry} />),
    );
    expect(container.textContent).toContain("Can't reach the GoatCitadel gateway");
    expect(container.textContent).toContain("goatcitadel up");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again");
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("applies the saved theme to the document before the shell mounts", () => {
    applyCockpitAppearance("dark", "compact");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
