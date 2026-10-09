// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
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
const libraryArea = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("../areas/library/LibraryArea", () => ({
  LibraryArea: () => {
    if (libraryArea.failure) throw libraryArea.failure;
    return <p>Library content</p>;
  },
}));
// No other test here visits Chat, so a stub keeps the failure test off the network.
const chatArea = vi.hoisted(() => ({ failure: null as Error | null, effects: 0 }));
vi.mock("../areas/chat/ChatArea", () => ({
  ChatArea: () => {
    useEffect(() => { chatArea.effects++; return () => { chatArea.effects--; }; }, []);
    if (chatArea.failure) throw chatArea.failure;
    return <><p>Chat content</p><input aria-label="Retained conversation draft" defaultValue="Draft" /></>;
  },
}));
vi.mock("../areas/chat/ChatProjects", () => ({ ChatProjects: () => <p>Native projects content</p> }));
const health = vi.hoisted(() => ({
  sources: vi.fn(async () => {
    throw new Error("Health owner unavailable in shell fixture.");
  }),
  digest: vi.fn(async () => {
    throw new Error("Health owner unavailable in shell fixture.");
  }),
}));
vi.mock("../areas/system/system-health-sources", () => ({
  loadSystemHealthSources: health.sources,
  loadSystemHealthDigest: health.digest,
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
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }));
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
    expect(container.querySelector("[data-gateway-banner]")).toBeNull();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell
            streamState="retrying"
            gatewayReachability={{ unavailable: true, lastConfirmedAt: null, checking: false, lastCheckedAt: null }}
          />
        </QueryClientProvider>,
      ),
    );
    const alert = container.querySelector("[data-gateway-banner]");
    expect(alert?.getAttribute("role")).toBe("alert");
    // Above the scrolling area, so it never scrolls away and phones see it.
    expect(alert?.closest("#main-content")).toBeNull();
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
            gatewayReachability={{
              unavailable: true,
              lastConfirmedAt: null,
              checking: false,
              lastCheckedAt: null,
              retry,
            }}
          />
        </QueryClientProvider>,
      ),
    );
    const check = [...container.querySelectorAll("[data-gateway-banner] button")].find(
      (b) => b.textContent?.trim() === "Check again",
    );
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
        {
          id: "a",
          kind: "approval",
          group: "needs_decision",
          title: "t",
          summary: "s",
          createdAt: "x",
          source: { workspaceId: "default" },
          href: "/x",
        },
      ],
      coverage: [],
      counts: {
        needs_decision: { known: 1, complete: true },
        proposals: { known: 0, complete: true },
        needs_attention: { known: 0, complete: true },
        updates: { known: 0, complete: true },
      },
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
    expect(inbox.getAttribute("aria-label")).toBe("Inbox, 1 decision");
    const badge = inbox.querySelector('[title="Outstanding decisions"]')!;
    expect(badge.textContent).toBe("1");
    expect(badge.className).not.toContain("sr-only");
    expect(container.querySelector("#cockpit-work-running-summary")?.className).toContain("absolute");
    client.clear();
  });

  it("defaults tablet navigation to the rail and leaves editor Ctrl+B untouched", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: media === "(640px <= width < 1024px)" || media === "(width >= 640px)",
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

  it("says the system is being checked, then offers a retry when the checks are unavailable (NV-04)", async () => {
    let fail!: () => void;
    health.digest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("Health owner unavailable in shell fixture."));
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell />
        </QueryClientProvider>,
      );
    });
    const sidebar = () => container.querySelector('[aria-label="Cockpit sidebar"]')!;
    expect(sidebar().textContent).toContain("Checking system…");
    expect(sidebar().textContent).not.toContain("System checks unavailable");
    const calls = health.digest.mock.calls.length;
    await act(async () => {
      fail();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(sidebar().textContent).toContain("System checks unavailable"));
    const retry = [...sidebar().querySelectorAll("button")].find((node) => node.textContent === "Retry")!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(health.digest.mock.calls.length).toBe(calls + 1);
    expect(health.sources).not.toHaveBeenCalled();
    client.clear();
  });

  it("renders no sidebar on phones and shows the status strip in the tab bar instead (NV-13)", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    health.sources.mockClear();
    health.digest.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CockpitShell streamState="open" />
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector('[aria-label="Cockpit sidebar"]')).toBeNull();
    const strip = container.querySelector('[aria-label="System status"]');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain("Updates connected");
    expect(health.sources).not.toHaveBeenCalled();
    expect(health.digest).toHaveBeenCalledTimes(1);
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

  it("keeps the shell usable when one area fails to render", async () => {
    libraryArea.failure = new Error("synthetic Library failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/library?shell=cockpit");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <CockpitShell />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll('[role="alert"]')].some((node) =>
            node.textContent?.includes("Library couldn't be shown"),
          ),
        ).toBe(true),
      );
      expect(container.querySelector('nav[aria-label="Areas"]')).not.toBeNull();
    } finally {
      libraryArea.failure = null;
      consoleError.mockRestore();
    }
  });

  const failedView = (label: string) =>
    [...container.querySelectorAll('[role="alert"]')].some((node) =>
      node.textContent?.includes(`${label} couldn't be shown`),
    );

  it("retries a failed area when Back moves to another page of the same area", async () => {
    libraryArea.failure = new Error("synthetic Library failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/library?shell=cockpit");
    window.history.pushState(null, "", "/library/skills?shell=cockpit");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <CockpitShell />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => expect(failedView("Library")).toBe(true));
      libraryArea.failure = null;
      await act(async () => window.history.back());
      expect(window.location.pathname).toBe("/library");
      await vi.waitFor(() => expect(container.textContent).toContain("Library content"));
      expect(failedView("Library")).toBe(false);
    } finally {
      libraryArea.failure = null;
      consoleError.mockRestore();
    }
  });

  it("retries a failed area when only its query string changes", async () => {
    libraryArea.failure = new Error("synthetic Library failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/library?type=skill&shell=cockpit");
    window.history.pushState(null, "", "/library?type=tool&shell=cockpit");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <CockpitShell />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => expect(failedView("Library")).toBe(true));
      libraryArea.failure = null;
      await act(async () => window.history.back());
      expect(window.location.search).toBe("?type=skill&shell=cockpit");
      await vi.waitFor(() => expect(container.textContent).toContain("Library content"));
      expect(failedView("Library")).toBe(false);
    } finally {
      libraryArea.failure = null;
      consoleError.mockRestore();
    }
  });

  it("retries a failed Chat when the route opens another conversation", async () => {
    chatArea.failure = new Error("synthetic Chat failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/chat?shell=cockpit&sessionId=session-a");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <CockpitNavigationProvider>
              <PendingProbe />
              <CockpitShell />
            </CockpitNavigationProvider>
          </QueryClientProvider>,
        );
      });
      expect(failedView("Chat")).toBe(true);
      chatArea.failure = null;
      // What the palette's New chat does once the conversation is created and verified.
      await act(async () => navigation.navigate("/chat?shell=cockpit&sessionId=session-b"));
      expect(window.location.search).toContain("sessionId=session-b");
      expect(failedView("Chat")).toBe(false);
      expect(container.textContent).toContain("Chat content");
    } finally {
      chatArea.failure = null;
      consoleError.mockRestore();
    }
  });

  it("contains a Chat render failure in the Chat view while the navigation stays usable", async () => {
    chatArea.failure = new Error("synthetic Chat failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/chat?shell=cockpit");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <CockpitShell />
          </QueryClientProvider>,
        );
      });
      expect(failedView("Chat")).toBe(true);
      expect(container.querySelector('main [role="alert"]')?.textContent).toContain("Chat couldn't be shown");
      const nav = container.querySelector('nav[aria-label="Areas"]')!;
      await act(async () => nav.querySelector<HTMLButtonElement>('button[aria-label^="Inbox"]')!.click());
      expect(window.location.pathname).toBe("/inbox");
      expect(nav.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toMatch(/^Inbox/);
    } finally {
      chatArea.failure = null;
      consoleError.mockRestore();
    }
  });

  it("opens Chat from a failed area's Go to Chat", async () => {
    libraryArea.failure = new Error("synthetic Library failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/library?shell=cockpit");
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <CockpitShell />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => expect(failedView("Library")).toBe(true));
      const goToChat = [...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
        (button) => button.textContent === "Go to Chat",
      );
      await act(async () => goToChat!.click());
      expect(window.location.pathname + window.location.search).toBe("/chat?shell=cockpit");
      expect(container.textContent).toContain("Chat content");
      expect(failedView("Library")).toBe(false);
    } finally {
      libraryArea.failure = null;
      consoleError.mockRestore();
    }
  });
});

it.each(["/missing", "/system/missing", "/ops/runtime", "/library/knowledge"])("does not show Chat or Health for %s", async (path) => {
  window.history.replaceState(null, "", path + "?workspaceId=w#record");
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><CockpitShell /></QueryClientProvider>));
  expect(container.textContent).not.toContain("Chat content");
  if (path === "/ops/runtime") {
    expect(container.textContent).toContain("This view is available in Classic");
    const link = container.querySelector<HTMLAnchorElement>('a[href*="shell=classic"]');
    expect(link?.href).toContain("workspaceId=w");
    expect(link?.hash).toBe("#record");
  } else if (path === "/library/knowledge") {
    expect(container.textContent).toContain("Library content");
    expect(container.textContent).not.toContain("This view is available in Classic");
  } else expect(container.textContent).toContain("Page not found");
});


it("retains Chat state but suspends its effects while native Projects owns the destination", async () => {
  window.history.replaceState(null, "", "/chat?sessionId=conversation-a&shell=cockpit");
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><CockpitNavigationProvider><CockpitShell /><PendingProbe /></CockpitNavigationProvider></QueryClientProvider>));
  const draft = container.querySelector<HTMLInputElement>('[aria-label="Retained conversation draft"]')!;
  draft.value = "Keep my conversation input";
  expect(chatArea.effects).toBe(1);
  await act(async () => navigation.navigate("/chat/projects/project-a"));
  await vi.waitFor(() => expect(container.textContent).toContain("Native projects content"));
  expect(window.location.pathname).toBe("/chat/projects/project-a"); expect(chatArea.effects).toBe(0);
  expect(container.querySelector('[aria-label="Retained conversation draft"]')).toBe(draft);
  await act(async () => window.history.back());
  await vi.waitFor(() => expect(window.location.pathname).toBe("/chat"));
  expect(chatArea.effects).toBe(1); expect(draft.value).toBe("Keep my conversation input");
  await act(async () => window.history.forward());
  await vi.waitFor(() => expect(window.location.pathname).toBe("/chat/projects/project-a"));
  expect(chatArea.effects).toBe(0);
});
