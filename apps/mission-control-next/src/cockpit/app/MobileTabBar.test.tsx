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
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));
const shell = vi.hoisted(() => ({ switchShell: vi.fn<typeof import("../../shell-preference").switchShell>() }));
vi.mock("../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shell-preference")>()),
  switchShell: shell.switchShell,
}));
const preload = vi.hoisted(() => vi.fn());
vi.mock("./use-cockpit-preload", () => ({ useCockpitPreload: () => preload }));
vi.mock("../data/use-operator-inbox", () => ({
  useOperatorInbox: () => ({
    data: {
      workspaceId: "default",
      items: [],
      coverage: [],
      counts: {
        needs_decision: { known: 2, complete: true },
        proposals: { known: 0, complete: true },
        needs_attention: { known: 0, complete: false },
        updates: { known: 0, complete: false },
      },
    },
    isError: false,
  }),
}));

const status = vi.hoisted(() => ({ tone: "done" as "done" | "failed" }));
vi.mock("./use-health-digest", () => ({
  useHealthDigestStatus: () => ({
    phase: "ready",
    label: status.tone === "done" ? "All checks passed" : "1 check failing",
    tone: status.tone,
    title: "System checks",
    retry: () => undefined,
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  preload.mockClear();
  status.tone = "done";
  window.history.replaceState(null, "", "/chat");
  window.localStorage.setItem("goatcitadel.ui.theme.v1", "dark");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function tab(label: string): HTMLAnchorElement {
  const match = [...document.querySelectorAll("nav a")].find((element) => element.textContent?.trim() === label);
  if (!(match instanceof HTMLAnchorElement)) throw new Error(`Missing area link: ${label}`);
  return match;
}
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("MobileTabBar", () => {
  it("warms touch and keyboard destinations without navigating until activation", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    act(() => tab("Work").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
    expect(preload).toHaveBeenLastCalledWith("work");
    act(() => tab("Library").focus());
    expect(preload).toHaveBeenLastCalledWith("library");
    expect(window.location.pathname).toBe("/chat");
    // SH-28: a new tab opened from an area link stays in Cockpit, even when the saved shell is Classic.
    expect(new URL(tab("Library").href).searchParams.get("shell")).toBe("cockpit");
    expect(new URL(tab("Library").href).pathname).toBe("/library");
    await act(async () => tab("Work").click());
    expect(window.location.pathname).toBe("/work");
  });
  it("accessible name starts with the visible text", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    // Work names itself "Work", not the running indicator's sentence, which is its description instead.
    expect(tab("Work").getAttribute("aria-label")).toBe("Work");
    expect(button("More").getAttribute("aria-label")).toMatch(/^More/);
    const inbox = [...document.querySelectorAll("nav a")].find((link) => link.getAttribute("href")?.includes("/inbox"));
    expect(inbox?.getAttribute("aria-label") ?? inbox?.textContent).toMatch(/^Inbox/);
  });
  it("opens More as a sheet with System and appearance controls", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelector('[title="Outstanding decisions"]')?.textContent).toBe("2");
    expect(container.querySelector('a[aria-label="Inbox, 2 decisions"]')).not.toBeNull();
    await act(async () => button("More").click());
    expect(document.querySelector('[role="dialog"][aria-label="More"]')).not.toBeNull();
    // Capabilities is not a fifth tab: it lives in the More sheet, ahead of System.
    expect(() => tab("Capabilities")).toThrow("Missing area link");
    const sheetLabels = [...document.querySelectorAll('[role="dialog"][aria-label="More"] button')].map((element) =>
      element.textContent?.trim(),
    );
    expect(sheetLabels.indexOf("Capabilities")).toBeGreaterThan(-1);
    expect(sheetLabels.indexOf("Capabilities")).toBeLessThan(sheetLabels.indexOf("System"));
    // GL-15: the quick toggle offers the two theme choices that are not already saved.
    expect(button("Use light theme")).not.toBeNull();
    expect(button("Match system theme")).not.toBeNull();
    expect(() => button("Use dark theme")).toThrow("Missing button");

    await act(async () => button("Use light theme").click());
    expect(window.localStorage.getItem("goatcitadel.ui.theme.v1")).toBe("light");
    await act(async () => button("More").click());
    expect(button("Use dark theme")).not.toBeNull();
    expect(button("Match system theme")).not.toBeNull();

    await act(async () => button("System").click());
    expect(window.location.pathname).toBe("/system");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("opens Capabilities from the More sheet and warms it first", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    await act(async () => button("More").click());
    act(() => button("Capabilities").focus());
    expect(preload).toHaveBeenLastCalledWith("capabilities");
    expect(window.location.pathname).toBe("/chat");
    await act(async () => button("Capabilities").click());
    expect(window.location.pathname).toBe("/capabilities");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("marks More as current on Capabilities, which has no tab of its own", async () => {
    window.history.replaceState(null, "", "/capabilities");
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(button("More").getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('nav a[aria-current="page"]')).toBeNull();
  });
  it("keeps the bottom chrome to the tab bar and moves scope and status into More (SH-01, SH-22)", async () => {
    status.tone = "failed";
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} streamState="open" />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    const chrome = container.querySelector("[data-cockpit-tabbar]")!.parentElement!;
    expect(chrome.className).toContain("cockpit-safe-bottom");
    expect(chrome.querySelector("[data-cockpit-scope-line]")).toBeNull();
    expect(chrome.querySelector('[aria-label="System status"]')).toBeNull();
    // A failing check marks More with a shaped icon and a description, not a coloured dot.
    const more = button("More");
    expect(more.querySelector("[data-status-attention]")).not.toBeNull();
    expect(document.getElementById(more.getAttribute("aria-describedby")!)?.textContent).toBe(
      "System status needs attention",
    );
    await act(async () => more.click());
    const sheet = document.querySelector('[role="dialog"][aria-label="More"]')!;
    expect(sheet.querySelector('[aria-label="System status"]')?.textContent).toContain("1 check failing");
    expect(sheet.querySelector('[aria-label="System status"]')?.textContent).toContain("Updates connected");
    const scope = sheet.querySelector("[data-cockpit-scope-line]")?.textContent ?? "";
    expect(scope).not.toContain("Workspace name unavailable");
    expect(scope).not.toContain("Reading Citadel");
    await act(async () => button("Open System health").click());
    expect(window.location.pathname).toBe("/system/health");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("leaves More unmarked while checks pass and updates are connected", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} streamState="open" />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(button("More").hasAttribute("aria-describedby")).toBe(false);
    expect(container.querySelector("[data-status-attention]")).toBeNull();
  });
  it("switches to classic Mission Control as the saved layout, not a visit", async () => {
    shell.switchShell.mockReset();
    shell.switchShell.mockResolvedValue("opened");
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <MobileTabBar onOpenPalette={vi.fn()} />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    await act(async () => button("More").click());
    await act(async () => button("Switch to classic Mission Control").click());
    await vi.waitFor(() => expect(shell.switchShell).toHaveBeenCalledOnce());
    const [name, options] = shell.switchShell.mock.calls[0]!;
    expect(name).toBe("classic");
    // Without an href, switchShell builds the URL itself and saves classic as the layout.
    expect(options.href).toBeUndefined();
  });
});
