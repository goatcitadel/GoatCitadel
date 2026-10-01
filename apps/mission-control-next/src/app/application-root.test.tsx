// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { renderApplicationRoot, captureApplicationRoot, isApplicationRootCurrent } from "./application-root";
import { mountClassic } from "../classic-entry";
import { mountCockpit } from "../cockpit-entry";
import { __resetSessionDraftsForTests, useSessionDraft } from "../features/native-routes/library/session-drafts";
import { setWorkspaceAttempt, workspaceAttemptLocked } from "../features/native-routes/settings/workspace-editor-state";
import { switchShell } from "../shell-preference";
import { hasSessionDraft } from "../features/native-routes/library/session-drafts";

vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  UiPreferencesProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@next/app/MissionControlNextApp", () => ({ MissionControlNextApp: () => <div>Classic shell</div> }));
vi.mock("@next/cockpit/app/CockpitApp", () => ({ CockpitApp: () => <div>Cockpit shell</div> }));

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(createRoot).mockClear();
  __resetSessionDraftsForTests();
});
afterEach(async () => {
  await act(async () => {
    for (const result of vi.mocked(createRoot).mock.results) if (result.type === "return") result.value.unmount();
  });
  container.remove();
  __resetSessionDraftsForTests();
  setWorkspaceAttempt("citadel:root-proof:edit", { phase: "idle" });
  delete document.documentElement.dataset.shell;
});

describe("shared application root owner", () => {
  it("lets both real lazy entry mount functions reuse one React root", async () => {
    await act(async () => mountCockpit(container));
    expect(container.textContent).toBe("Cockpit shell");
    const cockpitToken = captureApplicationRoot(container)!;
    await act(async () => mountClassic(container));
    expect(container.textContent).toBe("Classic shell");
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(container);
    expect(isApplicationRootCurrent(container, cockpitToken)).toBe(false);
    expect(isApplicationRootCurrent(container, captureApplicationRoot(container)!)).toBe(true);
  });

  it("retains actual session drafts and unknown mutation locks when the displaying subtree changes", async () => {
    let draft!: ReturnType<typeof useSessionDraft<{ name: string }>>;
    function Probe({ shell }: { shell: string }) {
      draft = useSessionDraft("root-proof", { name: "Saved" }, "revision", { label: "Retained profile" });
      return <div>{shell}: {draft.value.name}: {workspaceAttemptLocked("citadel:root-proof:edit") ? "locked" : "available"}</div>;
    }
    await act(async () => renderApplicationRoot(container, <Probe key="cockpit" shell="cockpit" />));
    await act(async () => {
      draft.setValue({ name: "Unsaved input" });
      setWorkspaceAttempt("citadel:root-proof:edit", { phase: "uncertain", message: "Owner outcome unknown" });
    });
    await act(async () => renderApplicationRoot(container, <Probe key="classic" shell="classic" />));
    expect(container.textContent).toBe("classic: Unsaved input: locked");
    expect(draft.isDirty).toBe(true);
    expect(createRoot).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unowned or different container as the captured application", async () => {
    expect(captureApplicationRoot(container)).toBeUndefined();
    await act(async () => renderApplicationRoot(container, <div>Mounted</div>));
    const token = captureApplicationRoot(container)!;
    expect(isApplicationRootCurrent(document.createElement("div"), token)).toBe(false);
    expect(isApplicationRootCurrent(container, {})).toBe(false);
  });

  it("round-trips through both real shell entry functions without losing drafts, locks, or root ownership", async () => {
    container.id = "root";
    document.documentElement.dataset.shell = "cockpit";
    window.history.replaceState({ retained: "history" }, "", "/settings/general?shell=cockpit");
    let draft!: ReturnType<typeof useSessionDraft<{ name: string }>>;
    function Probe() {
      draft = useSessionDraft("root-round-trip", { name: "Saved" }, 1, { label: "Retained input" });
      return <div>Original editor</div>;
    }
    await act(async () => renderApplicationRoot(container, <Probe />));
    await act(async () => {
      draft.setValue({ name: "Retained typing" });
      setWorkspaceAttempt("citadel:root-proof:edit", { phase: "uncertain", message: "Unknown" });
    });
    const originalDocument = document, originalRoot = container, length = window.history.length;
    await act(async () => { expect(await switchShell("classic", { isCurrent: () => true })).toBe("opened"); });
    expect(container.textContent).toBe("Classic shell");
    await act(async () => { expect(await switchShell("cockpit", { isCurrent: () => true })).toBe("opened"); });
    expect(container.textContent).toBe("Cockpit shell");
    expect(document).toBe(originalDocument); expect(document.getElementById("root")).toBe(originalRoot);
    expect(createRoot).toHaveBeenCalledTimes(1); expect(hasSessionDraft("root-round-trip")).toBe(true);
    expect(workspaceAttemptLocked("citadel:root-proof:edit")).toBe(true);
    expect(window.history.length).toBe(length); expect(window.history.state).toEqual({ retained: "history" });
  });
});
