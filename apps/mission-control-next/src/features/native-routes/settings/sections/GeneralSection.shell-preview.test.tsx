// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { switchShell } from "@next/shell-preference";
import { GeneralSection } from "./GeneralSection";

vi.mock("@next/shell-preference", () => ({ switchShell: vi.fn().mockResolvedValue("opened") }));
vi.mock("../../../desktop-updates/DesktopUpdatesPanel", () => ({ DesktopUpdatesPanel: () => null }));

afterEach(() => vi.clearAllMocks());

describe("GeneralSection cockpit preview", () => {
  it("lets the operator opt into the new layout through a scoped async handoff", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<GeneralSection
      route={{ area: "settings", section: "general" }} section="general"
      activeWorkspaceId="default" activeWorkspaceName="Default workspace"
      navigate={vi.fn()} setActiveWorkspaceId={vi.fn()}
    />));
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Try the new Mission Control");
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
    expect(switchShell).toHaveBeenCalledWith("cockpit", {
      isCurrent: expect.any(Function), signal: expect.any(AbortSignal),
    });
    const options = vi.mocked(switchShell).mock.calls[0]![1];
    expect(options.isCurrent()).toBe(true);
    act(() => root.unmount());
    expect(options.isCurrent()).toBe(false);
    container.remove();
  });
});
