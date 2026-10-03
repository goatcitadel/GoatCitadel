// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTabBar } from "./MobileTabBar";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";

vi.mock("../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <section role="dialog" aria-label={title}>{children}</section> : null,
}));
vi.mock("../../shell-preference", () => ({ switchShell: vi.fn() }));
const preload = vi.hoisted(() => vi.fn());
vi.mock("./use-cockpit-preload", () => ({ useCockpitPreload: () => preload }));
vi.mock("../data/use-operator-inbox", () => ({
  useOperatorInbox: () => ({ data: {
    workspaceId: "default",
    items: [],
    counts: {
      needs_decision: { known: 2, complete: true },
      proposals: { known: 0, complete: true },
      needs_attention: { known: 0, complete: false },
      updates: { known: 0, complete: false },
    },
  }, isError: false }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  preload.mockClear();
  window.history.replaceState(null, "", "/chat");
  window.localStorage.setItem("goatcitadel.ui.theme.v1", "dark");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("MobileTabBar", () => {
  it("warms touch and keyboard destinations without navigating until activation", async () => {
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><UiPreferencesProvider><CockpitNavigationProvider><MobileTabBar onOpenPalette={vi.fn()} /></CockpitNavigationProvider></UiPreferencesProvider></QueryClientProvider>));
    act(() => button("Work").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
    expect(preload).toHaveBeenLastCalledWith("work");
    act(() => button("Library").focus());
    expect(preload).toHaveBeenLastCalledWith("library");
    expect(window.location.pathname).toBe("/chat");
    await act(async () => button("Work").click());
    expect(window.location.pathname).toBe("/work");
  });
  it("opens More as a sheet with System and appearance controls", async () => {
    await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><UiPreferencesProvider><CockpitNavigationProvider><MobileTabBar onOpenPalette={vi.fn()} /></CockpitNavigationProvider></UiPreferencesProvider></QueryClientProvider>));
    expect(container.querySelector('[title="At least this many Inbox items"]')?.textContent).toBe("2+");
    expect(container.querySelector('button[aria-label="Inbox, at least 2 items"]')).not.toBeNull();
    await act(async () => button("More").click());
    expect(document.querySelector('[role="dialog"][aria-label="More"]')).not.toBeNull();
    expect(button("Switch to light theme")).not.toBeNull();

    await act(async () => button("Switch to light theme").click());
    await act(async () => button("More").click());
    expect(button("Switch to dark theme")).not.toBeNull();

    await act(async () => button("System").click());
    expect(window.location.pathname).toBe("/system");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
