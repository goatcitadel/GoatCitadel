// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { useCockpitRoute } from "./use-cockpit-route";
import { SHELL_NAVIGATION_EVENTS } from "../../app/shell-transition";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import {
  __resetFormDirtyRegistryForTests,
  getDirtySectionKeys,
} from "../../features/native-routes/library/use-form-dirty";

const scope = vi.hoisted(() => ({
  installation: "http://owner.invalid",
  activeCitadelId: "citadel-a",
  activeWorkspaceId: "workspace-a",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => scope.installation,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
vi.mock("../../shell-preference", () => ({ switchShell: vi.fn(), writeShellPreference: vi.fn() }));
let root: Root, element: HTMLDivElement;
let route: ReturnType<typeof useCockpitRoute>, draft: ReturnType<typeof useSessionDraft<{ name: string }>>;
let mounts = 0,
  unmounts = 0;
function Probe() {
  route = useCockpitRoute();
  draft = useSessionDraft("central-navigation-draft", { name: "Saved" }, 1, { label: "Current editor" });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return <p>{route.pathname}</p>;
}
async function render(provided = true) {
  await act(async () => {
    root.render(
      provided ? (
        <CockpitNavigationProvider>
          <Probe />
        </CockpitNavigationProvider>
      ) : (
        <Probe />
      ),
    );
  });
}
async function settleHistoryEvents() {
  // Happy DOM queues hashchange even for pushState/replaceState; settle those
  // emulator events before starting the next independent user interaction.
  await act(async () => {
    await (window as unknown as Pick<HappyDomWindow, "happyDOM">).happyDOM.waitUntilComplete();
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  Object.assign(scope, {
    installation: "http://owner.invalid",
    activeCitadelId: "citadel-a",
    activeWorkspaceId: "workspace-a",
  });
  mounts = 0;
  unmounts = 0;
  window.history.replaceState(null, "", "/work?shell=cockpit");
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  element.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
});

describe("central cockpit navigation", () => {
  it("fails closed without its provider", async () => {
    await render(false);
    const action = vi.fn();
    await act(async () => {
      route.navigate("/library");
      route.requestTransition(action);
    });
    expect(window.location.pathname).toBe("/work");
    expect(action).not.toHaveBeenCalled();
  });

  it("uses one leave review, cancel leaves draft untouched, and Keep commits once in the same document", async () => {
    await render();
    const push = vi.spyOn(window.history, "pushState"),
      assign = vi.spyOn(window.location, "assign");
    await act(async () => {
      draft.setValue({ name: "Retained text" });
    });
    await act(async () => {
      route.navigate("/library?type=tool#catalog");
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
    await click("Cancel");
    expect(draft.value.name).toBe("Retained text");
    expect(window.location.pathname).toBe("/work");
    await act(async () => {
      route.navigate("/library?type=tool#catalog");
      route.navigate("/inbox");
    });
    await click("Keep draft and close");
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/library?type=tool&shell=cockpit#catalog",
    );
    expect(draft.value.name).toBe("Retained text");
    expect(draft.isDirty).toBe(true);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not review known same-page Settings tabs but reviews first-run and cross-page transitions", async () => {
    window.history.replaceState(null, "", "/settings/general#appearance");
    await settleHistoryEvents();
    await render();
    await act(async () => {
      draft.setValue({ name: "Retained" });
    });
    expect(getDirtySectionKeys()).toEqual(["central-navigation-draft"]);
    await act(async () => {
      route.navigate("/settings/general?shell=cockpit#work-personality");
    });
    await settleHistoryEvents();
    expect(window.location.hash).toBe("#work-personality");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(getDirtySectionKeys()).toEqual(["central-navigation-draft"]);
    await act(async () => {
      route.navigate("/settings/first-run");
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click("Cancel");
    await act(async () => {
      route.navigate("/settings/connections#channels");
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(window.location.pathname).toBe("/settings/general");
  });

  it.each(SHELL_NAVIGATION_EVENTS)("invalidates old navigation callbacks on %s, including URL ABA", async (event) => {
    await render();
    const oldNavigate = route.navigate;
    await act(async () => {
      window.history.replaceState(null, "", "/inbox?shell=cockpit");
      window.dispatchEvent(new Event(event));
      window.history.replaceState(null, "", "/work?shell=cockpit");
      window.dispatchEvent(new Event(event));
    });
    await act(async () => {
      oldNavigate("/library");
    });
    expect(window.location.pathname).toBe("/work");
  });

  it("invalidates old scope callbacks and pending reviews without discarding the draft", async () => {
    await render();
    const oldNavigate = route.navigate;
    await act(async () => {
      draft.setValue({ name: "Keep me" });
    });
    expect(getDirtySectionKeys()).toEqual(["central-navigation-draft"]);
    await act(async () => {
      route.navigate("/library");
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const staleKeep = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Keep draft and close",
    );
    expect(staleKeep).toBeDefined();
    scope.activeWorkspaceId = "workspace-b";
    await render();
    scope.activeWorkspaceId = "workspace-a";
    await render();
    await act(async () => {
      oldNavigate("/inbox");
      staleKeep!.click();
    });
    expect(window.location.pathname).toBe("/work");
    expect(draft.value.name).toBe("Keep me");
  });

  it("does not execute after installation changes or component unmount, and works under StrictMode", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <CockpitNavigationProvider>
            <Probe />
          </CockpitNavigationProvider>
        </StrictMode>,
      );
    });
    await act(async () => {
      route.navigate("/inbox");
    });
    expect(window.location.pathname).toBe("/inbox");
    const retained = route.requestTransition,
      action = vi.fn();
    scope.installation = "http://other.invalid";
    await act(async () => {
      retained(action);
    });
    expect(action).not.toHaveBeenCalled();
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      retained(action);
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("gives an accepted async operation currentness and one navigation capability, then rejects later navigation", async () => {
    await render();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reviewed: Parameters<Parameters<typeof route.requestTransition>[0]>[0] | undefined;
    await act(async () => {
      route.requestTransition(async (guard) => {
        reviewed = guard;
        await pending;
      });
    });
    expect(reviewed?.isCurrent()).toBe(true);
    await act(async () => {
      expect(reviewed?.navigate("/library?type=skill")).toBe(true);
    });
    expect(reviewed?.isCurrent()).toBe(false);
    expect(reviewed?.navigate("/inbox")).toBe(false);
    await act(async () => {
      finish();
      await pending;
    });
    expect(window.location.pathname).toBe("/library");
  });
});
