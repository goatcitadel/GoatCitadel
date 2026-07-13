// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellRail } from "./MissionControlShellChrome";
import { AREA_META, type AppRoute } from "./route-model";

const route: AppRoute = { area: "settings", section: "providers" };

function MobileRailHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" aria-label="Open navigation" onClick={() => setOpen(true)}>
        Open navigation
      </button>
      <ShellRail
        activeCitadelId="personal"
        activeCitadelName="Personal"
        activeWorkspaceId="workspace-1"
        activeWorkspaceName="Workspace One"
        buildPrimaryAreaRoute={(area) => ({ area })}
        citadelOptions={[{ citadelId: "personal", name: "Personal" }]}
        currentAreaMeta={AREA_META.settings}
        groupedRailItems={[
          {
            id: "settings",
            items: [
              {
                id: "providers",
                label: "Providers",
                description: "Configure model providers.",
                area: "settings",
                section: "providers",
              },
            ],
          },
        ]}
        handleSelectCitadel={vi.fn()}
        handleSelectWorkspace={vi.fn()}
        isMobileNav
        navOpen={open}
        navigate={vi.fn()}
        onClose={() => setOpen(false)}
        onOpenPalette={vi.fn()}
        pendingApprovals={0}
        preloadRouteChunk={vi.fn()}
        railSignalLines={["Gateway ready"]}
        railSignalTitle="Runtime"
        route={route}
        taskBacklogCount={0}
        workspaceOptions={[{ workspaceId: "workspace-1", name: "Workspace One" }]}
      />
    </>
  );
}

function requiredElement<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) {
    throw new Error(`Expected ${selector}`);
  }
  return match;
}

async function openNavigation(): Promise<HTMLButtonElement> {
  const opener = requiredElement<HTMLButtonElement>('button[aria-label="Open navigation"]');
  opener.focus();
  await act(async () => {
    opener.click();
  });
  return opener;
}

describe("ShellRail mobile drawer focus behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<MobileRailHarness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.style.overflow = "";
  });

  it("moves focus into the open dialog and keeps the closed drawer inert", async () => {
    const drawer = requiredElement<HTMLElement>('aside[aria-label="Navigation"]');
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);

    await openNavigation();

    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(requiredElement('button[aria-label="Close navigation"]'));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("contains forward and reverse Tab focus within the open drawer", async () => {
    await openNavigation();
    const drawer = requiredElement<HTMLElement>('aside[aria-label="Navigation"]');
    const focusable = [...drawer.querySelectorAll<HTMLElement>("button, select")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    last!.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });

  it("closes with Escape and restores focus to the opener", async () => {
    const opener = await openNavigation();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    const drawer = requiredElement<HTMLElement>('aside[aria-label="Navigation"]');
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("closes from the scrim and restores focus to the opener", async () => {
    const opener = await openNavigation();
    const scrim = requiredElement<HTMLButtonElement>("button.mc-next-nav-scrim.open");

    await act(async () => {
      scrim.click();
    });

    expect(requiredElement('aside[aria-label="Navigation"]').getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(opener);
  });
});
