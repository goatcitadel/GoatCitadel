// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArea } from "./ChatArea";

interface HostDestinations {
  onOpenApprovals: (approvalId?: string) => void;
  onOpenTasks: () => void;
  onOpenStartHere: () => void;
  onOpenOpsRuntime: () => void;
  onOpenPersonalitiesSettings: () => void;
  onOpenProviderSettings: () => void;
  onOpenLocalAiSettings: () => void;
  onOpenLibraryArtifacts: () => void;
  onOpenLibraryImports: () => void;
}

const mocks = vi.hoisted(() => ({
  hostProps: null as HostDestinations | null,
  navigate: vi.fn(),
  switchShell: vi.fn<typeof import("../../../shell-preference").switchShell>(),
  preferences: { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" },
}));

vi.mock("@goatcitadel/threaded-surface-core", () => ({
  MissionThreadedControllerHost: (props: HostDestinations) => {
    mocks.hostProps = props;
    return null;
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => mocks.preferences,
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../../shell-preference", () => ({ switchShell: mocks.switchShell }));

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(<ChatArea />);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.hostProps = null;
  mocks.preferences = { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" };
  mocks.switchShell.mockResolvedValue("opened");
  window.history.replaceState(null, "", "/chat?sessionId=session-a&shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("cockpit Chat owner navigation", () => {
  it("opens every owner destination natively with cockpit selection and no document reload", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    await render();
    const host = mocks.hostProps!;
    host.onOpenApprovals();
    host.onOpenTasks();
    host.onOpenStartHere();
    host.onOpenPersonalitiesSettings();
    host.onOpenProviderSettings();
    host.onOpenLocalAiSettings();
    host.onOpenLibraryArtifacts();
    host.onOpenLibraryImports();
    // System › Health owns runtime status, so the Ops runtime no longer hands off to Classic either.
    host.onOpenOpsRuntime();
    expect(mocks.navigate.mock.calls.map(([href]) => href)).toEqual([
      "/inbox?shell=cockpit",
      "/work?shell=cockpit",
      "/settings/first-run?shell=cockpit",
      "/settings/general?shell=cockpit#work-personality",
      "/settings/models?shell=cockpit#providers",
      "/settings/models?shell=cockpit#local-ai",
      "/library/artifacts?shell=cockpit",
      "/library/knowledge?shell=cockpit#external-sources",
      "/system?shell=cockpit",
    ]);
    expect(assign).not.toHaveBeenCalled();
    expect(mocks.switchShell).not.toHaveBeenCalled();
  });

  it("opens an exact approval through native Inbox navigation", async () => {
    await render();
    mocks.hostProps!.onOpenApprovals("approval/one?two");
    expect(mocks.navigate.mock.calls.map(([href]) => href)).toEqual([
      "/inbox?item=approval:approval%2Fone%3Ftwo&workspaceId=workspace-a&shell=cockpit",
    ]);
    expect(mocks.switchShell).not.toHaveBeenCalled();
  });
});
