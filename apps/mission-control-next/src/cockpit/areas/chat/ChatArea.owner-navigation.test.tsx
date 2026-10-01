// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArea } from "./ChatArea";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

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
let draft: ReturnType<typeof useSessionDraft<{ name: string }>>;
function DraftProbe() {
  draft = useSessionDraft("chat-owner-handoff", { name: "Saved" }, 1, { label: "Chat owner draft" });
  return null;
}
async function render() {
  await act(async () => { root.render(<><ChatArea /><DraftProbe /></>); });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  mocks.hostProps = null;
  mocks.preferences = { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" };
  mocks.switchShell.mockResolvedValue("opened");
  window.history.replaceState(null, "", "/chat?sessionId=session-a&shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
});

describe("cockpit Chat owner navigation", () => {
  it("opens native owner destinations with cockpit selection and no document reload", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    await render();
    const host = mocks.hostProps!;
    host.onOpenApprovals();
    host.onOpenTasks();
    host.onOpenStartHere();
    host.onOpenOpsRuntime();
    host.onOpenPersonalitiesSettings();
    host.onOpenProviderSettings();
    host.onOpenLocalAiSettings();
    host.onOpenLibraryArtifacts();
    expect(mocks.navigate.mock.calls.map(([href]) => href)).toEqual([
      "/inbox?shell=cockpit", "/work?shell=cockpit", "/settings/first-run?shell=cockpit",
      "/system/health?shell=cockpit", "/settings/general?shell=cockpit#work-personality",
      "/settings/models?shell=cockpit#providers", "/settings/models?shell=cockpit#local-ai",
      "/library/artifacts?shell=cockpit",
    ]);
    expect(assign).not.toHaveBeenCalled();
    expect(mocks.switchShell).not.toHaveBeenCalled();
  });

  it("passes exact specialist paths through the shared guarded handoff", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    await render();
    await act(async () => { mocks.hostProps!.onOpenApprovals("approval/one?two"); });
    await act(async () => { mocks.hostProps!.onOpenLibraryImports(); });
    expect(mocks.switchShell.mock.calls.map(([shell, options]) => [shell, options.href])).toEqual([
      ["classic", "/ops/approvals?approvalId=approval%2Fone%3Ftwo&shell=classic"],
      ["classic", "/library/knowledge?shell=classic"],
    ]);
    for (const [, options] of mocks.switchShell.mock.calls) {
      expect(options.isCurrent()).toBe(true);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(assign).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows the shared draft-leave review and prevents stale scope continuation", async () => {
    await render();
    await act(async () => { draft.setValue({ name: "Unsaved" }); });
    await act(async () => { mocks.hostProps!.onOpenLibraryImports(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Unsaved changes");
    const oldKeep = [...document.querySelectorAll("button")].find((button) => button.textContent === "Keep draft and close");
    expect(oldKeep).toBeDefined();
    expect(mocks.switchShell).not.toHaveBeenCalled();
    mocks.preferences = { ...mocks.preferences, activeCitadelId: "citadel-b" };
    await render();
    mocks.preferences = { ...mocks.preferences, activeCitadelId: "citadel-a" };
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { oldKeep!.click(); });
    expect(mocks.switchShell).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(draft.value.name).toBe("Unsaved");
    expect(draft.isDirty).toBe(true);
  });

  it("renders a failed handoff without losing the current view", async () => {
    mocks.switchShell.mockRejectedValueOnce(new Error("synthetic import failure"));
    await render();
    await act(async () => { mocks.hostProps!.onOpenLibraryImports(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The view could not open. Your current drafts are still available.",
    );
    expect(window.location.pathname).toBe("/chat");
  });
});
