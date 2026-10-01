// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeOwnerLink } from "./NativeOwnerLink";
import { CockpitNavigationProvider } from "../app/CockpitNavigationProvider";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";
import {
  setWorkspaceAttempt,
  workspaceAttemptLocked,
} from "../../features/native-routes/settings/workspace-editor-state";

const switchShell = vi.hoisted(() => vi.fn());
vi.mock("../../shell-preference", () => ({ switchShell, writeShellPreference: vi.fn() }));
let root: Root, container: HTMLDivElement;
let draft: ReturnType<typeof useSessionDraft<{ name: string }>>;
let mounts = 0,
  unmounts = 0;
const href = "/chat?sessionId=session%2Fone&turnId=turn%3Atwo#evidence";
function Probe({ scope = "record-a", target = href }: { scope?: string; target?: string }) {
  draft = useSessionDraft("native-navigation", { name: "Saved" }, 1, { label: "Retained native draft" });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return (
    <NativeOwnerLink href={target} scope={scope} className="evidence-link">
      <strong>Open evidence</strong>
      <span aria-hidden="true">↗</span>
    </NativeOwnerLink>
  );
}
async function render(scope = "record-a", target = href) {
  await act(async () => {
    root.render(<CockpitNavigationProvider><Probe scope={scope} target={target} /></CockpitNavigationProvider>);
  });
}
async function clickKeep() {
  const keep = [...document.querySelectorAll("button")].find((button) => button.textContent === "Keep draft and close");
  expect(keep).toBeDefined();
  await act(async () => {
    keep!.click();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  mounts = 0;
  unmounts = 0;
  window.history.replaceState(null, "", "/work?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  setWorkspaceAttempt("native-navigation-lock", { phase: "idle" });
  vi.restoreAllMocks();
});

describe("native owner navigation", () => {
  it("withholds same-document navigation if the central owner is absent", async () => {
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => { root.render(<Probe />); });
    await act(async () => { container.querySelector("a")!.click(); });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/work");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("changes the native route exactly once without remounting, reloading, or losing an uncertain owner lock", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const push = vi.spyOn(window.history, "pushState");
    await render();
    setWorkspaceAttempt("native-navigation-lock", { phase: "uncertain", message: "Lost receipt" });
    const link = container.querySelector("a")!;
    const expected = "/chat?sessionId=session%2Fone&turnId=turn%3Atwo&shell=cockpit#evidence";
    expect(link.getAttribute("href")).toBe(expected);
    expect(link.querySelector("strong")?.textContent).toBe("Open evidence");
    await act(async () => {
      link.click();
      link.click();
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(expected);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(workspaceAttemptLocked("native-navigation-lock")).toBe(true);
    expect(switchShell).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("requires the real draft decision and retains the draft after same-document continuation", async () => {
    await render();
    await act(async () => {
      draft.setValue({ name: "Unsaved input" });
    });
    await act(async () => {
      container.querySelector("a")!.click();
    });
    expect(window.location.pathname).toBe("/work");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Unsaved changes");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await clickKeep();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.pathname).toBe("/chat");
    expect(draft.value.name).toBe("Unsaved input");
    expect(draft.isDirty).toBe(true);
  });

  it.each(["scope", "origin", "cancel"])(
    "does not navigate a retained leave review after %s changes",
    async (change) => {
      await render();
      await act(async () => {
        draft.setValue({ name: "Unsaved input" });
      });
      await act(async () => {
        container.querySelector("a")!.click();
      });
      const oldKeep = [...document.querySelectorAll("button")].find((button) => button.textContent === "Keep draft and close");
      expect(oldKeep).toBeDefined();
      if (change === "scope") {
        await render("record-b");
        await render();
      }
      if (change === "origin") {
        await act(async () => {
          window.history.replaceState(null, "", "/system?shell=cockpit");
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
          window.history.replaceState(null, "", "/work?shell=cockpit");
        });
      }
      if (change === "cancel") {
        await act(async () => {
          [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
        });
      }
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => { oldKeep!.click(); });
      expect(window.location.pathname).toBe("/work");
      expect(draft.value.name).toBe("Unsaved input");
      expect(draft.isDirty).toBe(true);
    },
  );

  it("preserves modified clicks and withholds foreign or Classic destinations", async () => {
    await render();
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
      await act(async () => {
        container.querySelector("a")!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    for (const target of [
      "https://foreign.invalid/chat",
      "//foreign.invalid/chat",
      "/\\foreign.invalid/chat",
      "/ops/approvals?shell=classic",
    ]) {
      await render("record-a", target);
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toContain("Open evidence");
    }
    expect(switchShell).not.toHaveBeenCalled();
  });
});
