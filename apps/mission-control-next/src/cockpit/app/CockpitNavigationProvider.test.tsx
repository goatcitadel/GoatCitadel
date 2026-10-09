// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useState } from "react";
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
  setSectionDirty,
  useFormDirty,
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
let setPlainDirty: (dirty: boolean) => void = () => undefined;
let editorUnmounts = 0;
/** When set, the editor offers "Save and continue" through this save owner. */
let plainEditorSave: (() => Promise<boolean>) | undefined;
/** A route-owned editor whose draft is lost when it unmounts, like the Hooks "new" form. */
function PlainEditor() {
  const [dirty, setDirty] = useState(false);
  setPlainDirty = setDirty;
  useFormDirty("plain-editor", dirty, { label: "Plain editor", onSave: plainEditorSave });
  useEffect(
    () => () => {
      editorUnmounts++;
    },
    [],
  );
  return <p data-editor>{dirty ? "Unsaved" : "Saved"}</p>;
}
function Probe() {
  route = useCockpitRoute();
  draft = useSessionDraft("central-navigation-draft", { name: "Saved" }, 1, { label: "Current editor" });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return (
    <>
      <p>{route.pathname}</p>
      {route.pathname === "/hooks" ? <PlainEditor /> : null}
    </>
  );
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
  editorUnmounts = 0;
  plainEditorSave = undefined;
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

  it("asks the browser to confirm a reload or close only while a draft is unsaved", async () => {
    await render();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await act(async () => {
      draft.setValue({ name: "Unsaved text" });
    });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("browser Back and Forward with unsaved drafts", () => {
  // A listener added after mount, like every React store and handoff listener in the app.
  let seen: string[] = [];
  const later = () => seen.push(window.location.pathname + window.location.hash);
  const listenAfterMount = () => {
    seen = [];
    window.addEventListener("popstate", later);
  };
  const here = () => window.location.pathname + window.location.search + window.location.hash;
  const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
  async function visit(...hrefs: string[]) {
    for (const href of hrefs) {
      await act(async () => {
        route.navigate(href);
      });
    }
  }
  async function back() {
    await act(async () => {
      window.history.back();
    });
  }
  async function forward() {
    await act(async () => {
      window.history.forward();
    });
  }
  async function editPlainDraft() {
    await act(async () => {
      setPlainDirty(true);
    });
  }
  afterEach(() => window.removeEventListener("popstate", later));

  it("holds Back before any later listener or view sees it, keeping the editor and its draft", async () => {
    await render();
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    listenAfterMount();
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(route.pathname).toBe("/hooks");
    expect(dialogs()).toBe(1);
    expect(document.querySelector("[data-editor]")?.textContent).toBe("Unsaved");
    expect(editorUnmounts).toBe(0);
    expect(seen).toEqual([]);
    expect(window.history.length).toBe(length);
  });

  it("leaves for the held destination after Discard without changing session history", async () => {
    await render();
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    await back();
    await click("Discard changes");
    expect(here()).toBe("/work?shell=cockpit");
    expect(route.pathname).toBe("/work");
    expect(window.history.length).toBe(length);
    await forward();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(0);
  });

  it("keeps the page and the stack on Cancel, and asks again on the next Back", async () => {
    await render();
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    await back();
    await click("Cancel");
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(0);
    expect(window.history.length).toBe(length);
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(1);
    await click("Discard changes");
    expect(here()).toBe("/work?shell=cockpit");
    expect(window.history.length).toBe(length);
  });

  it("holds Forward the same way", async () => {
    await render();
    await visit("/hooks", "/inbox");
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    await editPlainDraft();
    const length = window.history.length;
    listenAfterMount();
    await forward();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(1);
    expect(seen).toEqual([]);
    await click("Discard changes");
    expect(here()).toBe("/inbox?shell=cockpit");
    expect(window.history.length).toBe(length);
  });

  it("holds Back for a kept session draft too, and Keep reaches the destination with the draft retained", async () => {
    await render();
    await visit("/library");
    await act(async () => {
      draft.setValue({ name: "Unsaved text" });
    });
    const length = window.history.length;
    await back();
    expect(here()).toBe("/library?shell=cockpit");
    expect(dialogs()).toBe(1);
    await click("Keep draft and close");
    expect(here()).toBe("/work?shell=cockpit");
    expect(route.pathname).toBe("/work");
    expect(window.history.length).toBe(length);
    expect(draft.value.name).toBe("Unsaved text");
    expect(draft.isDirty).toBe(true);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("saves on Save and continue, then reaches the held destination by traversal", async () => {
    const onSave = vi.fn(async () => true);
    plainEditorSave = onSave;
    await render();
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    const push = vi.spyOn(window.history, "pushState");
    const go = vi.spyOn(window.history, "go");
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(1);
    await click("Save and continue");
    expect(onSave).toHaveBeenCalledOnce();
    expect(here()).toBe("/work?shell=cockpit");
    expect(route.pathname).toBe("/work");
    expect(dialogs()).toBe(0);
    // The restore went forward one entry and the confirmed move back one; nothing was pushed or replaced.
    expect(go.mock.calls).toEqual([[1], [-1]]);
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
    await forward();
    expect(here()).toBe("/hooks?shell=cockpit");
  });

  it("lets Back through while a reviewed transition that already decided the drafts is still running", async () => {
    await render();
    await visit("/library");
    await act(async () => {
      draft.setValue({ name: "Unsaved text" });
    });
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await act(async () => {
      route.requestTransition(() => running);
    });
    await click("Keep draft and close");
    // The kept draft is still unsaved, so only the running transition lets this Back through.
    expect(draft.isDirty).toBe(true);
    listenAfterMount();
    await back();
    expect(here()).toBe("/work?shell=cockpit");
    expect(route.pathname).toBe("/work");
    expect(seen).toEqual(["/work"]);
    expect(dialogs()).toBe(0);
    await act(async () => {
      finish();
      await running;
    });
  });

  it("lets hash-only moves through, wherever shell=cockpit appears in the query", async () => {
    window.history.replaceState(null, "", "/work#a");
    await settleHistoryEvents();
    await render();
    await visit("/work?shell=cockpit#b");
    await act(async () => {
      setSectionDirty("plain-editor", true, "Plain editor");
    });
    listenAfterMount();
    await back();
    await settleHistoryEvents();
    // A held move would keep its review open through these hashchange events, so each check discriminates.
    expect(dialogs()).toBe(0);
    expect(here()).toBe("/work#a");
    expect(seen).toEqual(["/work#a"]);
    await forward();
    await settleHistoryEvents();
    expect(here()).toBe("/work?shell=cockpit#b");
    expect(dialogs()).toBe(0);
  });

  it("lets a same-page Settings tab move through", async () => {
    window.history.replaceState(null, "", "/settings/general#appearance");
    await settleHistoryEvents();
    await render();
    await visit("/settings/general?shell=cockpit#work-personality");
    await settleHistoryEvents();
    await act(async () => {
      draft.setValue({ name: "Unsaved text" });
    });
    listenAfterMount();
    await back();
    await settleHistoryEvents();
    expect(here()).toBe("/settings/general#appearance");
    expect(dialogs()).toBe(0);
    expect(seen).toEqual(["/settings/general#appearance"]);
  });

  it("lets Back through when nothing is unsaved", async () => {
    await render();
    await visit("/library");
    listenAfterMount();
    await back();
    expect(here()).toBe("/work?shell=cockpit");
    expect(route.pathname).toBe("/work");
    expect(dialogs()).toBe(0);
    expect(seen).toEqual(["/work"]);
  });

  it("puts the page back on an entry without a position, without adding entries", async () => {
    await render();
    await visit("/library");
    // An entry written before positions existed, or by another history writer.
    window.history.replaceState(null, "", window.location.href);
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    listenAfterMount();
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(route.pathname).toBe("/hooks");
    expect(dialogs()).toBe(1);
    expect(seen).toEqual([]);
    // Happy DOM drops forward entries on replaceState (browsers keep them), so only growth is checked here.
    expect(window.history.length).toBeLessThanOrEqual(length);
    await click("Discard changes");
    expect(here()).toBe("/library?shell=cockpit");
    expect(route.pathname).toBe("/library");
    expect(window.history.length).toBeLessThanOrEqual(length);
  });

  it("holds Back under StrictMode", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <CockpitNavigationProvider>
            <Probe />
          </CockpitNavigationProvider>
        </StrictMode>,
      );
    });
    await visit("/hooks");
    await editPlainDraft();
    const length = window.history.length;
    await back();
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(dialogs()).toBe(1);
    await click("Discard changes");
    expect(here()).toBe("/work?shell=cockpit");
    expect(window.history.length).toBe(length);
  });

  it("holds a second Back while the review is open and keeps that review", async () => {
    await render();
    await visit("/library", "/hooks");
    await editPlainDraft();
    const length = window.history.length;
    await back();
    expect(dialogs()).toBe(1);
    await back();
    expect(dialogs()).toBe(1);
    expect(here()).toBe("/hooks?shell=cockpit");
    expect(window.history.length).toBe(length);
    await click("Discard changes");
    expect(here()).toBe("/library?shell=cockpit");
    expect(window.history.length).toBe(length);
  });

  it("keeps the review open through the hashchange events of a held move across a path change", async () => {
    await render();
    await visit("/hooks#signing");
    // Happy DOM queues hashchange for pushState; browsers do not. Finish setup events
    // before starting the dirty Back traversal whose real hash events this test checks.
    await settleHistoryEvents();
    await editPlainDraft();
    await back();
    await settleHistoryEvents();
    expect(dialogs()).toBe(1);
    expect(here()).toBe("/hooks?shell=cockpit#signing");
    await click("Discard changes");
    expect(here()).toBe("/work?shell=cockpit");
  });
});

it("replaces a compatibility entry once while preserving state, scope and fragment", async () => {
  window.history.replaceState({retained: "yes"}, "", "/ops/approvals?approvalId=a&workspaceId=w#review");
  const length = window.history.length;
  await render();
  expect(window.location.pathname).toBe("/inbox");
  expect(window.location.hash).toBe("#review");
  expect(window.history.state).toMatchObject({retained: "yes"});
  expect(window.history.length).toBe(length);
  expect(route.search).toContain("workspaceId=w");
});
it("reviews a compatibility navigation and leaves it untouched on cancel", async () => {
  await render();
  await act(async () => { draft.setValue({name: "Unsaved"}); });
  await act(async () => { route.navigate("/ops/approvals?approvalId=a#record"); });
  expect(window.location.pathname).toBe("/work");
  await click("Cancel");
  expect(window.location.pathname).toBe("/work");
  await act(async () => { route.navigate("/ops/approvals?approvalId=a#record"); });
  await click("Keep draft and close");
  expect(window.location.pathname).toBe("/inbox");
  expect(window.location.hash).toBe("#record");
});
