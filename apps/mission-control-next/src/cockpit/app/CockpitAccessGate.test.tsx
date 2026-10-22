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
  it("shows Gateway setup diagnosis and retries it natively", async () => {
    const onRetry = vi.fn();
    await act(async () =>
      root.render(
        <CockpitAccessGate
          access={{ status: "misconfigured", message: "Configured auth owner is unavailable" } as never}
          busy={false}
          onRetry={onRetry}
        />,
      ),
    );
    expect(container.textContent).toContain("Configured auth owner is unavailable");
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click(),
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(shell.switchShell).not.toHaveBeenCalled();
  });
  it("tells the operator how to start an unreachable Gateway", async () => {
    const onRetry = vi.fn();
    await act(async () =>
      root.render(<CockpitAccessGate access={{ status: "unreachable" } as never} busy={false} onRetry={onRetry} />),
    );
    expect(container.textContent).toContain("Can't reach GoatCitadel");
    expect(container.textContent).toContain("goatcitadel up");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again");
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no classic action when Gateway setup needs attention, because Classic shows the same gate", async () => {
    await act(async () =>
      root.render(
        <CockpitAccessGate
          access={{ status: "misconfigured", message: "Setup" } as never}
          busy={false}
          onRetry={vi.fn()}
        />,
      ),
    );
    expect([...container.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Try again"]);
    expect(shell.switchShell).not.toHaveBeenCalled();
  });

  it("puts the drafts note inside the shared sign-in card under a plain heading", async () => {
    await act(async () =>
      root.render(
        <CockpitAccessGate
          access={{ status: "access-blocked", authMode: "token", message: "Blocked" } as never}
          busy={false}
          onRetry={vi.fn()}
        />,
      ),
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const card = container.querySelector(".gateway-access-card");
    expect(card?.textContent).toContain("Unsaved drafts stay in this app session while you sign in.");
    expect(container.querySelector("h1")?.textContent).toBe("This browser can't open the cockpit yet");
    expect(container.textContent).not.toContain("caller");
    expect(container.textContent).not.toContain("access gate");
  });

  it("applies the saved theme to the document before the shell mounts", () => {
    applyCockpitAppearance("dark", "compact");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });

  it("points the browser chrome at the chosen theme, not the OS scheme", () => {
    const light = document.createElement("meta");
    light.name = "theme-color";
    light.media = "(prefers-color-scheme: light)";
    light.content = "#f0f8ff";
    const dark = document.createElement("meta");
    dark.name = "theme-color";
    dark.media = "(prefers-color-scheme: dark)";
    dark.content = "#122235";
    document.head.append(light, dark);
    try {
      applyCockpitAppearance("dark", undefined);
      expect([light.content, dark.content]).toEqual(["#122235", "#122235"]);
      applyCockpitAppearance("light", undefined);
      expect([light.content, dark.content]).toEqual(["#f0f8ff", "#f0f8ff"]);
    } finally {
      light.remove();
      dark.remove();
    }
  });
});

it("restores authentication through the shared native form without requiring a Classic handoff", async () => {
  await act(async () =>
    root.render(
      <CockpitAccessGate
        access={{ status: "needs-auth", authMode: "token", message: "Authentication required" } as never}
        busy={false}
        onRetry={vi.fn()}
      />,
    ),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(container.querySelector("input#gateway-access-token")).not.toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Open classic view"),
  ).toBe(false);
});
