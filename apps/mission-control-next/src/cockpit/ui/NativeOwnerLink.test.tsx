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
function Probe({
  scope = "record-a",
  target = href,
  onNavigate,
}: {
  scope?: string;
  target?: string;
  onNavigate?: () => void;
}) {
  draft = useSessionDraft("native-navigation", { name: "Saved" }, 1, { label: "Retained native draft" });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return (
    <NativeOwnerLink href={target} scope={scope} className="evidence-link" onNavigate={onNavigate}>
      <strong>Open evidence</strong>
      <span aria-hidden="true">↗</span>
    </NativeOwnerLink>
  );
}
async function render(scope = "record-a", target = href, onNavigate?: () => void) {
  await act(async () => {
    root.render(
      <CockpitNavigationProvider>
        <Probe scope={scope} target={target} onNavigate={onNavigate} />
      </CockpitNavigationProvider>,
    );
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
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      container.querySelector("a")!.click();
    });
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
      const oldKeep = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Keep draft and close",
      );
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
      await act(async () => {
        oldKeep!.click();
      });
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
      // GL-N08: no cockpit destination means no link at all, not link text that does nothing.
      expect(container.textContent).not.toContain("Open evidence");
    }
    expect(switchShell).not.toHaveBeenCalled();
  });

  it("runs onNavigate once after a plain click has moved the page, and never for a modified click", async () => {
    const onNavigate = vi.fn();
    await render("record-a", href, onNavigate);
    // A modified click is left to the browser; here the browser's default move is stopped so the page stays put.
    const stopDefault = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopDefault);
    try {
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        await act(async () => {
          container
            .querySelector("a")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
        });
      }
    } finally {
      document.removeEventListener("click", stopDefault);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/work");
    await act(async () => container.querySelector("a")!.click());
    expect(window.location.pathname).toBe("/chat");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("runs onNavigate for a link to the page that is already open", async () => {
    const onNavigate = vi.fn();
    window.history.replaceState(null, "", "/work?shell=cockpit");
    await render("record-a", "/work", onNavigate);
    await act(async () => container.querySelector("a")!.click());
    expect(window.location.pathname).toBe("/work");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("waits for the leave review: onNavigate runs when it is confirmed, never when it is cancelled", async () => {
    const onNavigate = vi.fn();
    await render("record-a", href, onNavigate);
    await act(async () => {
      draft.setValue({ name: "Unsaved input" });
    });
    await act(async () => container.querySelector("a")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => {
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/work");
    await act(async () => container.querySelector("a")!.click());
    await clickKeep();
    expect(window.location.pathname).toBe("/chat");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("defaults to accent link styling at its natural width (WK-N04)", async () => {
    await act(async () => {
      root.render(
        <CockpitNavigationProvider>
          <NativeOwnerLink href="/work" scope="plain">
            Open Work
          </NativeOwnerLink>
        </CockpitNavigationProvider>,
      );
    });
    const link = container.querySelector("a")!;
    expect(link.className).toContain("text-accent");
    expect(link.className).toContain("w-fit");
  });

  it("merges the caller's classes with the default link styling", async () => {
    await render();
    const link = container.querySelector("a")!;
    expect(link.className).toContain("evidence-link");
    expect(link.className).toContain("text-accent");
  });

  it("renders nothing, not a bare span, when no cockpit href resolves (GL-N08)", async () => {
    await render("record-a", "https://foreign.invalid/chat");
    expect(container.innerHTML).toBe("");
  });
});
