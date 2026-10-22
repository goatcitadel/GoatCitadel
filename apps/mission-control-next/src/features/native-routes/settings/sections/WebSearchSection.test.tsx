// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { switchShell } from "@next/shell-preference";
import { WebSearchSection } from "./WebSearchSection";

vi.mock("@next/shell-preference", () => ({ switchShell: vi.fn().mockResolvedValue("opened") }));

afterEach(() => vi.clearAllMocks());

describe("Classic Web & Search pointer", () => {
  it("names the section and hands off to the cockpit owner instead of editing in Classic", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <WebSearchSection
          route={{ area: "settings", section: "web-search" }}
          section="web-search"
          activeWorkspaceId="default"
          activeWorkspaceName="Default workspace"
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector("h2")?.textContent).toBe("Web & Search");
    expect(container.querySelector("input")).toBeNull();
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Open Web & Search in the cockpit",
    );
    await act(async () => button!.click());
    expect(switchShell).toHaveBeenCalledWith("cockpit", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    act(() => root.unmount());
    container.remove();
  });
});
