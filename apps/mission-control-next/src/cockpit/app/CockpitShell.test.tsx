// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { useCockpitNavigation } from "./cockpit-navigation-context";
import { CockpitShell } from "./CockpitShell";

vi.mock("@goatcitadel/mission-control-shared/api/citadels", () => ({
  getCitadelStructureSnapshot: vi.fn(async () => {
    throw new Error("No Citadel in this shell fixture.");
  }),
  listCitadels: vi.fn(async () => ({ items: [] })),
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/durable")>()),
  fetchDurableRunHistory: vi.fn(async () => ({ items: [], nextCursor: "more" })),
}));
vi.mock("./CommandPalette", () => ({
  CommandPalette: ({ open }: { open: boolean }) =>
    open ? (
      <section role="dialog" aria-label="Command palette">
        Palette fixture
      </section>
    ) : null,
}));
vi.mock("../areas/library/LibraryArea", () => ({ LibraryArea: () => null }));
vi.mock("../areas/system/system-health-sources", () => ({
  loadSystemHealthSources: vi.fn(async () => {
    throw new Error("Health owner unavailable in shell fixture.");
  }),
}));

vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [{ workspaceId: "default", name: "Default Workspace" }] })),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  fetchCapabilityCatalog: vi.fn(async (scope: string) => ({ scope, items: [] })),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: vi.fn(async (workspaceId: string) => ({
    authority: "derived_projection",
    workspaceId,
    generatedAt: "2026-09-28T00:00:00Z",
    items: [],
    coverage: [],
    counts: Object.fromEntries(
      ["needs_decision", "proposals", "needs_attention", "updates"].map((group) => [
        group,
        { known: 0, complete: true },
      ]),
    ),
  })),
}));

let navigation: ReturnType<typeof useCockpitNavigation>;
let shellDraft: ReturnType<typeof useSessionDraft<{ text: string }>>;
function PendingProbe() {
  navigation = useCockpitNavigation();
  shellDraft = useSessionDraft("shell-shortcuts", { text: "" }, 1, { label: "Shortcut draft" });
  return null;
}
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Shell tests must not access the network.");
    }),
  );
  window.history.replaceState(null, "", "/inbox");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.shell;
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});

describe("CockpitShell", () => {
  it.each(["classic", undefined])(
    "preserves transferred shell ownership during real StrictMode unmount (%s)",
    async (nextOwner) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>
              <CockpitShell />
            </QueryClientProvider>
          </StrictMode>,
        );
      });
      expect(document.documentElement.dataset.shell).toBe("cockpit");
      if (nextOwner) document.documentElement.dataset.shell = nextOwner;
      await act(async () => {
        root.render(<div>Replacement owner</div>);
      });
      expect(document.documentElement.dataset.shell).toBe(nextOwner);
      expect(container.textContent).toBe("Replacement owner");
      client.clear();
    },
  );
  it("renders five areas, preserves the current route, and switches with Ctrl+number", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <CockpitShell streamState="retrying" />
        </QueryClientProvider>,
      );
    });
    const nav = container.querySelector('nav[aria-label="Areas"]');
    expect([...nav!.querySelectorAll("button")].map((node) => node.getAttribute("aria-label"))).toEqual([
      "Chat",
      "Inbox",
      "Work",
      "Library",
      "System",
    ]);
    expect(nav!.querySelector('[aria-current="page"]')?.textContent).toContain("Inbox");
    expect(container.textContent).toContain("Reconnecting to updates");
    expect(container.textContent).not.toContain("All systems ok");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "4", ctrlKey: true }));
    });
    expect(window.location.pathname).toBe("/library");
  });
  it("shows a prominent Gateway outage without claiming an SSE retry is an outage", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell streamState="retrying" />
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelector('main [role="alert"]')).toBeNull();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell streamState="retrying" gatewayReachability={{ unavailable: true, lastConfirmedAt: null }} />
        </QueryClientProvider>,
      ),
    );
    const alert = container.querySelector('main [role="alert"]');
    // Only Chat sends, so other areas must not claim that sending is paused.
    expect(alert?.textContent).toContain("Gateway unavailable. What you see here may be out of date.");
    expect(alert?.textContent).not.toContain("Sending is paused");
    expect(alert?.textContent).toContain("goatcitadel up");
    const retry = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell
            streamState="retrying"
            gatewayReachability={{ unavailable: true, lastConfirmedAt: null, retry }}
          />
        </QueryClientProvider>,
      ),
    );
    const check = [...container.querySelectorAll("main button")].find((b) => b.textContent?.trim() === "Check again");
    await act(async () => (check as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledOnce();
    client.clear();
  });

  it("sets a per-area document title and restores the previous one on unmount", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.title = "Before";
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell />
        </QueryClientProvider>,
      ),
    );
    expect(document.title).toMatch(/^GoatCitadel /);
    expect(document.title).not.toBe("GoatCitadel Mission Control Next");
    await act(async () => root.render(<></>));
    expect(document.title).toBe("Before");
    client.clear();
  });
  it("collapses to an accessible rail with Ctrl+B and preserves the route", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell />
        </QueryClientProvider>,
      ),
    );
    const sidebar = container.querySelector('[aria-label="Cockpit sidebar"]')!;
    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    const href = window.location.href;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(sidebar.classList.contains("w-14")).toBe(true);
    expect(sidebar.querySelector('[aria-label="Chat"]')).not.toBeNull();
    expect(window.location.href).toBe(href);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]')!.click());
    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    client.clear();
  });

  it("keeps rail icons full size and shows a visible Inbox count when collapsed", async () => {
    const { fetchOperatorInbox } = await import("@goatcitadel/mission-control-shared/api/operator-inbox");
    vi.mocked(fetchOperatorInbox).mockResolvedValue({
      authority: "derived_projection",
      workspaceId: "default",
      generatedAt: "2026-09-28T00:00:00Z",
      items: [
        { id: "a", kind: "approval", group: "needs_decision", title: "t", summary: "s", createdAt: "x",
          source: { workspaceId: "default" }, href: "/x" },
      ],
      coverage: [],
      counts: { needs_decision: { known: 1, complete: true }, proposals: { known: 0, complete: true },
        needs_attention: { known: 0, complete: true }, updates: { known: 0, complete: true } },
    } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    const sidebar = container.querySelector('[aria-label="Cockpit sidebar"]')!;
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    for (const icon of sidebar.querySelectorAll('nav[aria-label="Areas"] button > svg')) {
      expect(icon.getAttribute("class")).toContain("shrink-0");
    }
    const inbox = sidebar.querySelector('nav[aria-label="Areas"] button[aria-label^="Inbox"]')!;
    expect(inbox.getAttribute("aria-label")).toBe("Inbox, 1 item");
    const badge = inbox.querySelector('[title="Inbox items"]')!;
    expect(badge.textContent).toBe("1");
    expect(badge.className).not.toContain("sr-only");
    expect(container.querySelector("#cockpit-work-running-summary")?.className).toContain("absolute");
    client.clear();
  });

  it("defaults tablet navigation to the rail and leaves editor Ctrl+B untouched", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: media === "(640px <= width < 1024px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell />
        </QueryClientProvider>,
      );
    });
    const sidebar = container.querySelector('[aria-label="Cockpit sidebar"]')!;
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    const input = document.createElement("textarea");
    container.append(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    input.remove();
    client.clear();
  });

  it("withholds Ctrl+K during same-event leave consent and its accepted preflight, then resumes normal editor behavior", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <PendingProbe />
              <CockpitShell />
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      shellDraft.setValue({ text: "Keep this draft" });
    });
    let finish!: () => void;
    await act(async () => {
      navigation.requestTransition(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Unsaved changes");
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
    const keep = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Keep draft and close",
    )!;
    await act(async () => {
      keep.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
    await act(async () => {
      finish();
    });
    const input = document.createElement("textarea");
    container.append(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelector('[aria-label="Command palette"]')).not.toBeNull();
    expect(shellDraft.value.text).toBe("Keep this draft");
    input.remove();
    client.clear();
  });
});
