// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitAccessGate } from "./CockpitAccessGate";
import { applyCockpitAppearance } from "./cockpit-appearance";

// The real shell switch runs, so a click reaches switchShell with the URL it would open.
const shell = vi.hoisted(() => ({ switchShell: vi.fn<typeof import("../../shell-preference").switchShell>() }));
vi.mock("../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shell-preference")>()),
  switchShell: shell.switchShell,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  shell.switchShell.mockReset();
  shell.switchShell.mockResolvedValue("opened");
  window.history.replaceState(null, "", "/chat?shell=cockpit");
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

  it.each(["needs-auth", "misconfigured"])(
    "opens the classic view as a visit when access is %s, so the saved layout stays the cockpit",
    async (status) => {
      await act(async () =>
        root.render(<CockpitAccessGate access={{ status } as never} busy={false} onRetry={vi.fn()} />),
      );
      const open = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Open classic view");
      await act(async () => open!.click());
      await vi.waitFor(() => expect(shell.switchShell).toHaveBeenCalledOnce());
      const [name, options] = shell.switchShell.mock.calls[0]!;
      expect(name).toBe("classic");
      expect(options.href).toContain("shellScope=visit");
    },
  );

  it("applies the saved theme to the document before the shell mounts", () => {
    applyCockpitAppearance("dark", "compact");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
