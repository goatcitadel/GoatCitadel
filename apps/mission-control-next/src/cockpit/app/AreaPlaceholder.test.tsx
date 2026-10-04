// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AreaPlaceholder } from "./AreaPlaceholder";

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
  window.history.replaceState(null, "", "/library?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("area placeholder", () => {
  it("opens the classic view as a visit, so the saved layout stays the cockpit", async () => {
    await act(async () => root.render(<AreaPlaceholder area="library" />));
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in classic view",
    );
    await act(async () => open!.click());
    await vi.waitFor(() => expect(shell.switchShell).toHaveBeenCalledOnce());
    const [name, options] = shell.switchShell.mock.calls[0]!;
    expect(name).toBe("classic");
    expect(options.href).toContain("shellScope=visit");
  });
});
