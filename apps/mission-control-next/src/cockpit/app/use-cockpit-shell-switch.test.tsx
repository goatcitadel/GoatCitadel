// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";

const shell = vi.hoisted(() => ({ switchShell: vi.fn<typeof import("../../shell-preference").switchShell>() }));
vi.mock("../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shell-preference")>()),
  switchShell: shell.switchShell,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://owner.invalid",
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }),
}));

let root: Root;
let container: HTMLDivElement;
let shellSwitch: ReturnType<typeof useCockpitShellSwitch>;
function Probe() {
  shellSwitch = useCockpitShellSwitch("session-a");
  return shellSwitch.feedback;
}

beforeEach(() => {
  shell.switchShell.mockReset();
  shell.switchShell.mockResolvedValue("opened");
  window.history.replaceState(null, "", "/chat?sessionId=session-a&shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("cockpit shell switch", () => {
  it("opens a task detour in classic, marked as a visit and carrying the hook's conversation", async () => {
    // No sessionId in the URL, so only the hook's argument can put one in the detour.
    window.history.replaceState(null, "", "/chat?shell=cockpit");
    await act(async () => root.render(<Probe />));
    await act(async () => shellSwitch.visit());
    await vi.waitFor(() => expect(shell.switchShell).toHaveBeenCalledOnce());
    const [name, options] = shell.switchShell.mock.calls[0]!;
    expect(name).toBe("classic");
    const target = new URL(options.href!);
    expect(target.searchParams.get("shell")).toBe("classic");
    expect(target.searchParams.get("shellScope")).toBe("visit");
    expect(target.searchParams.get("sessionId")).toBe("session-a");
  });

  it("keeps the explicit layout switch persistent", async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => shellSwitch.request());
    await vi.waitFor(() => expect(shell.switchShell).toHaveBeenCalledOnce());
    const [name, options] = shell.switchShell.mock.calls[0]!;
    expect(name).toBe("classic");
    expect(options.href).toBeUndefined();
    expect(options.sessionId).toBe("session-a");
  });
});
