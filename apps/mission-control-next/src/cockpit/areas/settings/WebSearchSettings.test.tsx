// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { WebSearchSettings } from "./WebSearchSettings";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchWebSearchCredentials: vi.fn(),
  saveWebSearchCredential: vi.fn(),
  clearWebSearchCredential: vi.fn(),
  checkFirecrawlConnection: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
vi.mock("@goatcitadel/mission-control-shared/api/web-search-settings", () => ({
  fetchWebSearchCredentials: api.fetchWebSearchCredentials,
  saveWebSearchCredential: api.saveWebSearchCredential,
  clearWebSearchCredential: api.clearWebSearchCredential,
  checkFirecrawlConnection: api.checkFirecrawlConnection,
}));

type Saved = {
  revision: number;
  networkAllowlist: string[];
  features: Record<string, boolean>;
  web: {
    firecrawl: Record<string, unknown>;
    search: { engineOrder: string[] };
  };
};

function settingsAt(revision: number, overrides: Partial<Saved> = {}): Saved {
  return {
    revision,
    networkAllowlist: ["lite.duckduckgo.com"],
    features: {},
    web: {
      firecrawl: {
        enabled: true,
        baseUrl: "http://127.0.0.1:3002",
        apiKeyEnv: "FIRECRAWL_API_KEY",
        timeoutMs: 20_000,
        defaultReadBackend: "firecrawl",
        fallbackToNative: true,
        baseUrlAllowlisted: true,
      },
      search: { engineOrder: ["duckduckgo", "bing", "google"] },
    },
    ...overrides,
  };
}

const credential = (targetId: string, label: string, overrides: Record<string, unknown> = {}) => ({
  targetId,
  label,
  endpointHost: targetId === "search.firecrawl" ? "127.0.0.1:3002" : "api.search.brave.com",
  endpointAllowlisted: true,
  keychainAvailable: true,
  keychainConfigured: false,
  envNames: targetId === "search.firecrawl" ? ["FIRECRAWL_API_KEY"] : ["BRAVE_SEARCH_API_KEY"],
  envConfigured: false,
  activeSource: "none",
  acquisitionUrl: "https://example.com/keys",
  ...overrides,
});

let saved: Saved;

function installGateway() {
  saved = settingsAt(4);
  api.fetchSettings.mockImplementation(async () => saved);
  api.patchSettings.mockImplementation(async (input: { expectedRevision: number } & Partial<Saved>) => {
    const { expectedRevision, ...patch } = input;
    saved = {
      ...saved,
      revision: expectedRevision + 1,
      ...(patch.networkAllowlist ? { networkAllowlist: patch.networkAllowlist } : {}),
      web: {
        firecrawl: { ...saved.web.firecrawl, ...(patch.web?.firecrawl ?? {}) },
        search: patch.web?.search ?? saved.web.search,
      },
    };
    return {
      ...saved,
      changePlanReceipt: { planId: `plan-${saved.revision}`, status: "completed", revision: 3, summary: "ok" },
    };
  });
  api.fetchWebSearchCredentials.mockResolvedValue({
    items: [
      credential("search.firecrawl", "Firecrawl", { envConfigured: true, activeSource: "env" }),
      credential("search.brave", "Brave Search"),
      credential("search.parallel", "Parallel Search", { endpointAllowlisted: false, endpointHost: "api.parallel.ai" }),
    ],
  });
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <WebSearchSettings />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  const unmount = () => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  };
  return { container, unmount };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit Web & Search settings", () => {
  it("saves a reordered native engine list through the governed settings patch", async () => {
    installGateway();
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(button(container, "Move Bing up")).toBeTruthy());
      await click(button(container, "Move Bing up"));
      expect(container.textContent).toContain("Unsaved draft: Bing, then DuckDuckGo, then Google");

      await click(button(container, "Save search engines"));

      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 4,
        web: { search: { engineOrder: ["bing", "duckduckgo", "google"] } },
      });
      await vi.waitFor(() => expect(container.textContent).toContain("Search engine order saved."));
    } finally {
      unmount();
    }
  });

  it("requires the hosted Firecrawl host in the allowlist before it can be saved", async () => {
    installGateway();
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Hosted Firecrawl"));
      const hosted = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0]!;
      await click(hosted);

      expect(container.textContent).toContain("api.firecrawl.dev is not in the outbound allowlist");
      expect(button(container, "Save Firecrawl")?.disabled).toBe(true);

      await click(button(container, "Add api.firecrawl.dev to the outbound allowlist"));
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 4,
        networkAllowlist: ["lite.duckduckgo.com", "api.firecrawl.dev"],
      });
      await vi.waitFor(() => expect(button(container, "Save Firecrawl")?.disabled).toBe(false));
      expect(container.textContent).not.toContain("is not in the outbound allowlist. Tools cannot reach it");

      await click(button(container, "Save Firecrawl"));
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 5,
        web: {
          firecrawl: {
            enabled: true,
            baseUrl: "https://api.firecrawl.dev",
            defaultReadBackend: "firecrawl",
            fallbackToNative: true,
            timeoutMs: 20_000,
          },
        },
      });
    } finally {
      unmount();
    }
  });

  it("shows the connection check result for the saved Firecrawl", async () => {
    installGateway();
    api.checkFirecrawlConnection.mockResolvedValue({
      status: "ok",
      baseUrl: "https://api.firecrawl.dev",
      checkedAt: "2026-10-21T00:00:00.000Z",
      keySource: "keychain",
      remainingCredits: 480,
      message: "Firecrawl answered and accepted the request.",
    });
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(button(container, "Test connection")).toBeTruthy());
      await click(button(container, "Test connection"));
      await vi.waitFor(() => expect(container.textContent).toContain("Connected"));
      expect(container.textContent).toContain("Key: OS keychain · 480 credits left");
    } finally {
      unmount();
    }
  });

  it("checks and saves a key without keeping it in the page", async () => {
    installGateway();
    const braveSaved = credential("search.brave", "Brave Search", {
      keychainConfigured: true,
      activeSource: "keychain",
    });
    api.saveWebSearchCredential.mockImplementation(async () => {
      api.fetchWebSearchCredentials.mockResolvedValue({
        items: [
          credential("search.firecrawl", "Firecrawl"),
          braveSaved,
          credential("search.parallel", "Parallel Search"),
        ],
      });
      return { status: braveSaved };
    });
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("From FIRECRAWL_API_KEY"));
      // A Brave key does not make Brave the Chat default; the copy must say so.
      expect(container.textContent).toContain("Used only when a search asks for official providers");
      expect(container.textContent).toContain("api.parallel.ai is not in the outbound allowlist");

      const braveInput = [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')][1]!;
      typeInto(braveInput, "brave-secret-key");
      const saveButtons = [...container.querySelectorAll("button")].filter(
        (item) => item.textContent === "Check and save",
      );
      await click(saveButtons[1]);

      expect(api.saveWebSearchCredential).toHaveBeenCalledWith("search.brave", "brave-secret-key", 4);
      await vi.waitFor(() => expect(container.textContent).toContain("Brave Search key checked and saved."));
      expect(braveInput.value).toBe("");
      expect(container.innerHTML).not.toContain("brave-secret-key");
      await vi.waitFor(() => expect(container.textContent).toContain("Saved in OS keychain"));
    } finally {
      unmount();
    }
  });
});
