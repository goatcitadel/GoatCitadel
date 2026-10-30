// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilitySkillDiscoverItem,
  CapabilitySkillDiscoverResponse,
  CapabilitySkillItem,
  CapabilitySkillsResponse,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoverView } from "./DiscoverView";
import { setSkillSwitch } from "./skill-switch-store";
import { SkillsTab } from "./SkillsTab";
import { useSkillFilters } from "./use-skill-filters";
import { __resetSkillSwitchesForTests } from "./use-skill-switch";

const api = vi.hoisted(() => ({
  fetchCapabilitySkills: vi.fn(),
  fetchCapabilitySkillUsage: vi.fn(),
  fetchCapabilitySkillDetail: vi.fn(),
  fetchCapabilitySkillDiscover: vi.fn(),
  setCapabilitySkillState: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => api);
const approvals = vi.hoisted(() => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<object>()),
  ...approvals,
}));
const prefs = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "default", activeWorkspaceId: "ws-1", ...prefs }),
}));
// The panel and the address have their own tests (SkillPanel.test.tsx); here only the hand-off is checked.
const route = vi.hoisted(() => ({ search: "?view=discover", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
const inspector = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  content: null as null | { source?: string },
}));
vi.mock("../../../app/inspector", () => ({ useInspector: () => inspector }));

function offer(
  overrides: Partial<CapabilitySkillDiscoverItem> & Pick<CapabilitySkillDiscoverItem, "id" | "name">,
): CapabilitySkillDiscoverItem {
  return {
    description: `${overrides.name} does its job.`,
    category: "coding",
    provider: "goatcitadel",
    providerLabel: "GoatCitadel",
    state: "available",
    ...overrides,
  };
}

const HIMALAYA = offer({
  id: "pack:himalaya",
  name: "Himalaya",
  category: "email",
  install: { kind: "pack", packId: "himalaya" },
});
const GITHUB = offer({
  id: "pack:github-cli",
  name: "GitHub CLI",
  state: "installed",
  installedSkillId: "extra:github-cli",
  install: { kind: "pack", packId: "github-cli" },
});
const REVIEW = offer({
  id: "source:design-review",
  name: "Design review",
  category: "design",
  provider: "agentskill",
  providerLabel: "AgentSkill",
  state: "view_only",
  listingUrl: "https://agentskill.sh/skills/design-review",
});
const STAGED = offer({
  id: "pack:staged",
  name: "Staged pack",
  category: "coding",
  state: "installing",
  install: { kind: "pack", packId: "staged" },
});
const CURATED = offer({
  id: "source:release-notes",
  name: "Release notes",
  category: "coding",
  provider: "clawhub",
  providerLabel: "ClawHub",
  state: "view_only",
  listingUrl: "https://clawhub.ai/acme/release-notes",
});

const PLAIN = [HIMALAYA, GITHUB, STAGED, REVIEW, CURATED];

function discoverOf(
  items: readonly CapabilitySkillDiscoverItem[] = PLAIN,
  extra: Partial<CapabilitySkillDiscoverResponse> = {},
): CapabilitySkillDiscoverResponse {
  return { items: [...items], unavailableProviders: [], generatedAt: "2026-10-30T10:00:00.000Z", ...extra };
}

function skill(
  overrides: Partial<CapabilitySkillItem> & Pick<CapabilitySkillItem, "skillId" | "name">,
): CapabilitySkillItem {
  return {
    description: `${overrides.name} does its job.`,
    category: "writing",
    origin: "built_in",
    state: "on",
    callable: true,
    revision: 3,
    switchable: true,
    pinned: false,
    lifecycleState: "approved",
    tags: [],
    ...overrides,
  };
}

const INSTALLED = [
  skill({ skillId: "extra:github-cli", name: "GitHub CLI", category: "coding", tags: ["pull-request"] }),
  skill({ skillId: "writer", name: "Writer", category: "writing" }),
];

function installedOf(items: readonly CapabilitySkillItem[] = INSTALLED): CapabilitySkillsResponse {
  return {
    workspaceId: "ws-1",
    items: [...items],
    operatorApprovalSkip: false,
    issues: [],
    generatedAt: "2026-10-30T10:00:00.000Z",
  };
}

const httpFailure = (status: number) =>
  new ApiRequestError("failed", { kind: "http", method: "GET", path: "/api/v1/capabilities/skills/discover", status });

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const text = () => container.textContent ?? "";
const cards = () => [...container.querySelectorAll("li")];
const names = () => cards().map((card) => card.querySelector("h3")?.textContent);
const rowOf = (name: string) => cards().find((card) => card.querySelector("h3")?.textContent === name)!;
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((entry) => entry.querySelector("h2")?.textContent === title);
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
const link = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent?.trim() === label);
const searchBox = () => container.querySelector<HTMLInputElement>('[role="search"] input')!;
const tab = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((entry) => entry.textContent === label)!;
const group = (label: string) => container.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
const chips = (label: string) =>
  [...(group(label)?.querySelectorAll("button") ?? [])].map((entry) => entry.textContent);
const alerts = () => container.querySelectorAll('[role="alert"]');
const discoverCalls = () => api.fetchCapabilitySkillDiscover.mock.calls;

async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** For the tests that run the search pause on a fake clock. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function tabElement() {
  return (
    <QueryClientProvider client={client}>
      <SkillsTab />
    </QueryClientProvider>
  );
}

async function render() {
  await act(async () => root.render(tabElement()));
  await settle();
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchBox(), value);
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement).click());
  await settle();
}

/** The segments activate with Enter (manual activation), the way the Settings tabs do in their tests. */
async function activate(label: string) {
  await act(async () => {
    const element = tab(label);
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  api.fetchCapabilitySkills.mockReset().mockResolvedValue(installedOf());
  api.fetchCapabilitySkillUsage.mockReset().mockResolvedValue({ since: "", generatedAt: "", skills: [] });
  api.fetchCapabilitySkillDetail.mockReset().mockResolvedValue({
    skillId: "extra:github-cli",
    instructionBody: "Keep each sentence short.",
    keywords: [],
    declaredTools: [],
    requires: [],
  });
  api.setCapabilitySkillState.mockReset();
  api.fetchCapabilitySkillDiscover.mockReset().mockResolvedValue(discoverOf());
  approvals.fetchApproval.mockReset();
  prefs.showTechnicalDetails = false;
  route.search = "?view=discover";
  route.navigate.mockReset();
  inspector.open.mockReset();
  inspector.close.mockReset();
  inspector.content = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSkillSwitchesForTests();
});

describe("Discover", () => {
  it("shows packs and curated skills before any search", async () => {
    await render();

    // One read for the plain list: no search term, nothing online asked for.
    expect(discoverCalls()).toHaveLength(1);
    expect(discoverCalls()[0]).toEqual(["ws-1", { signal: expect.anything() }]);
    expect(tab("Discover").getAttribute("aria-selected")).toBe("true");
    expect(tab("Installed").getAttribute("aria-selected")).toBe("false");
    // The Gateway's order, with the state each source is in, and no installed skill rows.
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    expect(section("Suggested skills")?.textContent).toContain("5 skills");
    expect(rowOf("Himalaya").textContent).toContain("From GoatCitadel");
    expect(rowOf("Himalaya").textContent).toContain("Himalaya does its job.");
    expect(rowOf("Himalaya").textContent).toContain("Not installed");
    expect(rowOf("GitHub CLI").textContent).toContain("Installed");
    expect(rowOf("Staged pack").textContent).toContain("Install not finished");
    expect(rowOf("Design review").textContent).toContain("From AgentSkill");
    expect(container.querySelector("li button[role='switch']")).toBeNull();
    // The box suggests the most common category of the list, lower-cased; ties go to the contract's order.
    expect(container.querySelector('[role="search"] label')?.textContent).toBe("Skills search");
    expect(searchBox().placeholder).toBe('Try "coding"');
    expect(section("Suggested skills")?.querySelector("ul")?.className).toBe("grid grid-cols-1 gap-2 sm:grid-cols-2");
  });

  it("searches after a pause, from two characters", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The app keeps a read fresh for 30 seconds, so going back to the plain list asks the Gateway for nothing.
    client.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
    api.fetchCapabilitySkillDiscover.mockImplementation(async (_workspaceId: string, options: { q?: string }) =>
      options.q ? discoverOf([HIMALAYA], { query: options.q }) : discoverOf(),
    );
    await act(async () => root.render(tabElement()));
    await advance(0);
    expect(discoverCalls()).toHaveLength(1);

    // One character is not a search.
    await type("e");
    await advance(2_000);
    expect(discoverCalls()).toHaveLength(1);

    // Two characters wait for the typing to stop: 400 ms, counted again from every key.
    await type("em");
    await advance(399);
    expect(discoverCalls()).toHaveLength(1);
    await type("ema");
    await advance(399);
    expect(discoverCalls()).toHaveLength(1);
    await advance(1);
    await advance(0);
    expect(discoverCalls()).toHaveLength(2);
    expect(discoverCalls()[1]).toEqual(["ws-1", { q: "ema", signal: expect.anything() }]);
    expect(names()).toEqual(["Himalaya"]);
    expect(section("Search results")?.textContent).toContain("1 skill");

    // Spaces around the text are not text.
    await type("  ema  ");
    await advance(1_000);
    expect(discoverCalls()).toHaveLength(2);

    // Going under two characters is the plain list again, at once, from what was read before.
    await type("e");
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    await advance(1_000);
    expect(discoverCalls()).toHaveLength(2);
  });

  it("offers See listing for a source it can't install", async () => {
    await render();

    const row = rowOf("Design review");
    const listing = link("See listing", row)!;
    expect(listing.getAttribute("href")).toBe("https://agentskill.sh/skills/design-review");
    expect(listing.getAttribute("target")).toBe("_blank");
    expect(listing.getAttribute("rel")?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    // The accessible name starts with the visible words and names the skill.
    expect(listing.getAttribute("aria-label")).toBe("See listing for Design review");
    expect(row.textContent).toContain("Can't be installed from here");
    expect(button("Install Design review", row)).toBeUndefined();
    // The address is not printed; it appears only in Technical details.
    expect(row.textContent).not.toContain("agentskill.sh");
    expect(row.querySelector("details")).toBeNull();
    // Nothing else links out: the other rows have no listing to see.
    expect(link("See listing", rowOf("Himalaya"))).toBeUndefined();
  });

  it("prints a listing's address only inside Technical details", async () => {
    prefs.showTechnicalDetails = true;
    await render();

    const details = rowOf("Design review").querySelector("details");
    expect(details?.textContent).toContain("https://agentskill.sh/skills/design-review");
    expect(rowOf("Himalaya").querySelector("details")).toBeNull();
  });

  it("names the sites that couldn't be searched and keeps the rest", async () => {
    api.fetchCapabilitySkillDiscover.mockResolvedValue(
      discoverOf([HIMALAYA, REVIEW], { unavailableProviders: ["AgentSkill", "SkillsMP"] }),
    );
    await render();

    expect(text()).toContain("AgentSkill and SkillsMP couldn't be searched right now.");
    expect(names()).toEqual(["Himalaya", "Design review"]);
    expect(text()).not.toContain("No skills match");
    // One line, not one alert per site.
    expect(text().split("couldn't be searched right now.")).toHaveLength(2);
    expect(alerts()).toHaveLength(0);
  });

  it("says no skills match, with Clear search, when a search found nothing", async () => {
    api.fetchCapabilitySkillDiscover.mockImplementation(async (_workspaceId: string, options: { q?: string }) =>
      options.q ? discoverOf([]) : discoverOf(),
    );
    await render();
    await type("zzz");
    await vi.waitFor(() => expect(text()).toContain("No skills match zzz"), { timeout: 3_000 });

    expect(alerts()).toHaveLength(0);
    expect(names()).toEqual([]);
    await click(button("Clear search"));
    expect(searchBox().value).toBe("");
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    // The button that was pressed left, so focus goes to the search box.
    expect(document.activeElement).toBe(searchBox());
  });

  it("doesn't say No skills match when a site couldn't be searched and nothing else matched", async () => {
    api.fetchCapabilitySkillDiscover.mockImplementation(async (_workspaceId: string, options: { q?: string }) =>
      options.q ? discoverOf([], { unavailableProviders: ["AgentSkill", "SkillsMP"] }) : discoverOf(),
    );
    await render();
    await type("pdf");
    await vi.waitFor(() => expect(text()).toContain("AgentSkill and SkillsMP couldn't be searched right now."), {
      timeout: 3_000,
    });

    // The sites that were down may have had a match, so nothing is claimed about them. The line stands once, with Try again.
    expect(text()).not.toContain("No skills match");
    expect(text().split("couldn't be searched right now.")).toHaveLength(2);
    expect(names()).toEqual([]);
    expect(alerts()).toHaveLength(0);

    // Try again asks again; when the sites answer and nothing matches, that is a real no match.
    api.fetchCapabilitySkillDiscover.mockImplementation(async () => discoverOf([]));
    await click(button("Try again"));
    expect(text()).toContain("No skills match pdf");
    expect(text()).not.toContain("couldn't be searched right now.");
    expect(button("Try again")).toBeUndefined();
  });

  it("never says No skills match when the search failed", async () => {
    api.fetchCapabilitySkillDiscover.mockImplementation(async (_workspaceId: string, options: { q?: string }) => {
      if (options.q) throw httpFailure(503);
      return discoverOf();
    });
    await render();
    await type("pdf");
    await vi.waitFor(() => expect(text()).toContain("The search didn't finish."), { timeout: 3_000 });

    expect(text()).toContain(describeApiError(httpFailure(503)).summary);
    expect(text()).not.toContain("No skills match");
    expect(alerts()).toHaveLength(1);
    expect(names()).toEqual([]);

    // Try again is a plain read again: it answers, and the results come back.
    api.fetchCapabilitySkillDiscover.mockImplementation(async () => discoverOf([HIMALAYA]));
    await click(button("Try again"));
    expect(names()).toEqual(["Himalaya"]);
    expect(alerts()).toHaveLength(0);
    expect(text()).not.toContain("The search didn't finish.");
  });

  it("says the list couldn't load, not that nothing matched, when the first read failed", async () => {
    api.fetchCapabilitySkillDiscover.mockRejectedValue(httpFailure(500));
    await render();

    expect(text()).toContain("Skills to install couldn't load.");
    expect(text()).not.toContain("No skills match");
    expect(text()).not.toContain("Nothing to install");
    expect(button("Try again")).toBeDefined();
  });

  it("keeps the last list beside one warning when a recheck fails", async () => {
    client.setQueryData(["skills", "capability-skill-discover", "ws-1", ""], discoverOf());
    api.fetchCapabilitySkillDiscover.mockRejectedValue(httpFailure(503));
    // The cached list is fresh for the app's default 30 seconds; this client has none, so the mount reads again.
    await render();

    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    expect(text()).toContain(`${describeApiError(httpFailure(503)).summary} Showing the last version`);
    expect(alerts()).toHaveLength(0);
  });

  it("filters the Gateway's list in the browser, by category and by where it came from", async () => {
    await render();

    expect(chips("Where it came from")).toEqual(["All", "GoatCitadel", "AgentSkill", "ClawHub"]);
    expect(chips("Categories")).toEqual(["All", "Coding", "Design", "Email and messages"]);

    await click(button("AgentSkill"));
    expect(names()).toEqual(["Design review"]);
    await click(button("ClawHub"));
    expect(names()).toEqual(["Design review", "Release notes"]);
    await click(button("All", group("Where it came from")!));
    await click(button("Coding"));
    expect(names()).toEqual(["GitHub CLI", "Staged pack", "Release notes"]);
    // Pressing buttons asked the Gateway for nothing more.
    expect(discoverCalls()).toHaveLength(1);

    // Nothing left to show says so, and Clear filters brings the list back without touching the search.
    await click(button("AgentSkill"));
    expect(text()).toContain("Nothing matches");
    expect(text()).not.toContain("No skills match");
    await click(button("Clear filters"));
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
  });

  it("keeps the search and the category buttons when the view changes", async () => {
    await render();
    await click(button("Coding"));
    await type("review");
    expect(searchBox().value).toBe("review");

    route.search = "";
    await render();
    expect(tab("Installed").getAttribute("aria-selected")).toBe("true");
    expect(searchBox().value).toBe("review");
    expect(button("Coding")?.getAttribute("aria-pressed")).toBe("true");
    // Installed filters its own list by the same text: nothing there is called a review.
    expect(text()).toContain("Nothing matches");
  });
});

describe("the Installed and Discover segments", () => {
  it("opens the Discover segment from ?view=discover", async () => {
    // Installed is what any other address opens, and Discover reads nothing until it is opened.
    await render();
    expect(tab("Discover").getAttribute("aria-selected")).toBe("true");
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    expect(api.fetchCapabilitySkillDiscover).toHaveBeenCalled();

    route.search = "";
    api.fetchCapabilitySkillDiscover.mockClear();
    await render();
    expect(tab("Installed").getAttribute("aria-selected")).toBe("true");
    expect(names()).toEqual(INSTALLED.map((entry) => entry.name));
    // Discover reads nothing until it is opened.
    expect(api.fetchCapabilitySkillDiscover).not.toHaveBeenCalled();

    route.search = "?shell=cockpit&view=other";
    await render();
    expect(tab("Installed").getAttribute("aria-selected")).toBe("true");
  });

  it("moves the address when a segment is chosen, and drops the parameter for Installed", async () => {
    route.search = "";
    await render();
    await activate("Discover");
    expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills?view=discover");

    route.search = "?view=discover";
    await render();
    await activate("Installed");
    expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills");
  });

  it("labels the two segments as one group of tabs", async () => {
    await render();
    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toBe("Skills view");
    expect([...(list?.querySelectorAll('[role="tab"]') ?? [])].map((entry) => entry.textContent)).toEqual([
      "Installed",
      "Discover",
    ]);
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull();
  });

  it("shows Discover when the installed list can't be read", async () => {
    api.fetchCapabilitySkills.mockRejectedValue(httpFailure(503));
    await render();

    // The segments, the shared search and the whole Discover list are there.
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(names()).toEqual(PLAIN.map((entry) => entry.name));
    expect(text()).not.toContain("Skills couldn't load.");
    expect(alerts()).toHaveLength(0);

    // Only the Installed segment tells the installed list's story.
    route.search = "";
    await render();
    expect(text()).toContain("Skills couldn't load.");
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(alerts()).toHaveLength(1);
    expect(tab("Discover")).toBeDefined();
  });

  it("keeps the search box and the segments while the installed list loads", async () => {
    route.search = "";
    api.fetchCapabilitySkills.mockReturnValue(new Promise(() => {}));
    await render();

    expect(text()).toContain("Checking for changes…");
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(tab("Discover")).toBeDefined();
  });
});

describe("the actions", () => {
  const onInstall = vi.fn();
  const onContinue = vi.fn();
  const onViewInstalled = vi.fn();

  function Harness() {
    const filters = useSkillFilters();
    return (
      <DiscoverView
        workspaceId="ws-1"
        filters={filters}
        onInstall={onInstall}
        onContinue={onContinue}
        onViewInstalled={onViewInstalled}
      />
    );
  }

  async function renderView() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    await settle();
  }

  beforeEach(() => {
    onInstall.mockReset();
    onContinue.mockReset();
    onViewInstalled.mockReset();
  });

  it("gives the source to the tab for Install and for Continue, and the card itself is not a click target", async () => {
    await renderView();

    await click(rowOf("Himalaya"));
    await click(rowOf("Himalaya").querySelector("h3"));
    expect(onInstall).not.toHaveBeenCalled();

    await click(button("Install Himalaya"));
    expect(onInstall).toHaveBeenCalledExactlyOnceWith(HIMALAYA);
    await click(button("Continue Staged pack"));
    expect(onContinue).toHaveBeenCalledExactlyOnceWith(STAGED);
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("offers View for an installed source and Continue for one between steps", async () => {
    await renderView();

    expect(button("View GitHub CLI", rowOf("GitHub CLI"))).toBeDefined();
    expect(button("Continue Staged pack", rowOf("Staged pack"))).toBeDefined();
    expect(button("Install Himalaya", rowOf("Himalaya"))).toBeDefined();
    // One action a row, and none of the wrong ones.
    expect(rowOf("GitHub CLI").querySelectorAll("button")).toHaveLength(1);
    expect(rowOf("Staged pack").querySelectorAll("button")).toHaveLength(1);
    expect(rowOf("Himalaya").querySelectorAll("button")).toHaveLength(1);
    expect(rowOf("Design review").querySelectorAll("button")).toHaveLength(0);

    await click(button("View GitHub CLI"));
    expect(onViewInstalled).toHaveBeenCalledExactlyOnceWith("extra:github-cli", "GitHub CLI");
  });

  it("names each action starting with what it says", async () => {
    await renderView();

    for (const [row, label] of [
      ["Himalaya", "Install"],
      ["GitHub CLI", "View"],
      ["Staged pack", "Continue"],
    ] as const) {
      const action = rowOf(row).querySelector("button")!;
      expect(action.textContent).toBe(label);
      expect(action.getAttribute("aria-label")).toBe(`${label} ${row}`);
    }
  });

  it("offers nothing to open for an installed source that can't name its skill", async () => {
    api.fetchCapabilitySkillDiscover.mockResolvedValue(
      discoverOf([offer({ id: "source:x", name: "Unnamed", state: "installed" })]),
    );
    await renderView();

    expect(rowOf("Unnamed").textContent).toContain("Installed");
    expect(rowOf("Unnamed").querySelectorAll("button, a")).toHaveLength(0);
  });
});

describe("View on an installed source", () => {
  it("keeps the Discover view when a panel opens and closes", async () => {
    await render();
    expect(route.navigate).not.toHaveBeenCalled();

    // Pressing View moves the address to the skill, with the view kept.
    await click(button("View GitHub CLI"));
    expect(route.navigate).toHaveBeenLastCalledWith(
      "/capabilities/skills?item=skill%3Aextra%3Agithub-cli&view=discover",
    );
    route.navigate.mockClear();

    // The address now names the skill: its panel opens (the inspector is a stub here).
    route.search = "?item=skill%3Aextra%3Agithub-cli&view=discover";
    await render();
    expect(inspector.open).toHaveBeenCalledTimes(1);
    expect(inspector.open.mock.calls[0]?.[0]).toMatchObject({
      source: "capabilities-skills:extra:github-cli",
      title: "GitHub CLI",
    });

    // The panel is on screen, then closed: the address goes back to the view it came from, not to Installed.
    inspector.content = { source: "capabilities-skills:extra:github-cli" };
    await render();
    expect(route.navigate).not.toHaveBeenCalled();
    inspector.content = null;
    await render();
    expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills?view=discover", { replace: true });
  });

  it("opens the panel's own not-found state when the installed list doesn't hold the skill", async () => {
    // The Gateway named `extra:old-folder`, but the loader knows the skill by another id.
    api.fetchCapabilitySkillDiscover.mockResolvedValue(
      discoverOf([
        offer({ id: "pack:old", name: "Old pack", state: "installed", installedSkillId: "extra:old-folder" }),
      ]),
    );
    await render();

    await click(button("View Old pack"));
    expect(inspector.open).toHaveBeenCalledTimes(1);
    const panel = inspector.open.mock.calls[0]?.[0] as { source: string; title: string; body: ReactNode };
    expect(panel.source).toBe("capabilities-skills:extra:old-folder");
    expect(panel.title).toBe("Old pack");
    // Nothing moved the address for a panel that opens at once.
    expect(route.navigate).not.toHaveBeenCalled();

    const host = document.createElement("div");
    document.body.append(host);
    const panelRoot = createRoot(host);
    await act(async () => panelRoot.render(<QueryClientProvider client={client}>{panel.body}</QueryClientProvider>));
    expect(host.textContent).toContain("This skill isn't in the list anymore.");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    act(() => panelRoot.unmount());
    host.remove();
  });
});

describe("a skill's panel opened from Discover", () => {
  const ITEM_ADDRESS = "?item=skill%3Aextra%3Agithub-cli";
  let panelRoot: Root | undefined;
  let host: HTMLDivElement | undefined;

  /** Opens the panel the address names and renders what the tab handed the inspector, as the inspector would. */
  async function openPanel(search: string) {
    route.search = search;
    await render();
    expect(inspector.open).toHaveBeenCalledTimes(1);
    const panel = inspector.open.mock.calls[0]?.[0] as { body: ReactNode };
    host = document.createElement("div");
    document.body.append(host);
    panelRoot = createRoot(host);
    await act(async () => panelRoot!.render(<QueryClientProvider client={client}>{panel.body}</QueryClientProvider>));
    await settle();
    return host;
  }

  afterEach(() => {
    if (panelRoot) act(() => panelRoot!.unmount());
    host?.remove();
    panelRoot = undefined;
    host = undefined;
  });

  it("announces its note, because no row on the page does", async () => {
    const panel = await openPanel(`${ITEM_ADDRESS}&view=discover`);

    const note = panel.querySelector('[role="status"]');
    expect(note?.textContent).toContain("Takes effect in new chats.");
    // Discover lists no installed row for the skill, so the panel is the only place that can say it.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("announces why a change didn't happen", async () => {
    const panel = await openPanel(`${ITEM_ADDRESS}&view=discover`);
    expect(panel.querySelector('[role="alert"]')).toBeNull();

    const message = "This skill changed since you opened it. Reload and try again.";
    act(() => setSkillSwitch("extra:github-cli", { phase: "failed", message, conflict: true }));
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(message);
  });

  it("stays quiet beside the Installed list, where the skill's row announces", async () => {
    const panel = await openPanel(ITEM_ADDRESS);

    expect(panel.textContent).toContain("Takes effect in new chats.");
    expect(panel.querySelector('[role="status"]')).toBeNull();
    act(() =>
      setSkillSwitch("extra:github-cli", {
        phase: "failed",
        message: "This skill changed since you opened it. Reload and try again.",
        conflict: true,
      }),
    );
    expect(panel.textContent).toContain("This skill changed since you opened it.");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it("puts a pressed tag in the shared search box and searches Discover for it", async () => {
    api.fetchCapabilitySkillDiscover.mockImplementation(async (_workspaceId: string, options: { q?: string }) =>
      options.q ? discoverOf([HIMALAYA], { query: options.q }) : discoverOf(),
    );
    const panel = await openPanel(`${ITEM_ADDRESS}&view=discover`);
    expect(searchBox().value).toBe("");

    await click(button("pull-request", panel));
    // The tag searches the tab the panel was opened from, and the panel closes.
    expect(inspector.close).toHaveBeenCalledTimes(1);
    expect(tab("Discover").getAttribute("aria-selected")).toBe("true");
    expect(searchBox().value).toBe("pull-request");
    await vi.waitFor(() => expect(discoverCalls().some(([, options]) => options.q === "pull-request")).toBe(true), {
      timeout: 3_000,
    });
    expect(names()).toEqual(["Himalaya"]);
    // Installed was not asked for it.
    expect(api.fetchCapabilitySkills).toHaveBeenCalledTimes(1);
  });
});
