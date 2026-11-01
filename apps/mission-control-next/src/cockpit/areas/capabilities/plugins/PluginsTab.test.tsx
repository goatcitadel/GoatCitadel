// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilityPluginInstalledItem,
  CapabilityPluginListItem,
  CapabilityPluginListResponse,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginListQuery } from "../../../data/capability-plugins-query";
import { PluginsTab } from "./PluginsTab";
import { pluginItemHref } from "./plugin-links";

const api = vi.hoisted(() => ({
  fetchCapabilityPlugins: vi.fn(),
  fetchCapabilityPluginDetail: vi.fn(),
  fetchCapabilityPluginInspection: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-plugins", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "default", activeWorkspaceId: "ws-1" }),
}));
// View moves the address to the plugin's panel; Install, Continue and the source buttons open the install panel.
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
const opener = vi.hoisted(() => ({ install: vi.fn(), resume: vi.fn(), openSource: vi.fn() }));
vi.mock("./use-plugin-install-panel", () => ({ usePluginInstallPanel: () => opener }));

const LIST_KEY = pluginListQuery("ws-1").queryKey;

function installed(
  overrides: Partial<CapabilityPluginInstalledItem> & Pick<CapabilityPluginInstalledItem, "pluginId" | "name">,
): CapabilityPluginInstalledItem {
  return {
    description: `${overrides.name} adds a few pieces.`,
    version: "1.0.0",
    trust: "unverified",
    sourceDisplay: "github.com/acme/tools",
    state: "installed",
    pieceCounts: { skill: 1 },
    workspaceId: "ws-1",
    sourceKind: "git",
    ...overrides,
  };
}

function builtIn(
  overrides: Partial<CapabilityPluginListItem> & Pick<CapabilityPluginListItem, "pluginId" | "name">,
): CapabilityPluginListItem {
  return {
    description: `${overrides.name} ships with GoatCitadel.`,
    version: "1.0.0",
    trust: "built_in",
    sourceDisplay: "Ships with GoatCitadel",
    state: "available",
    pieceCounts: { connector: 1, skill: 1 },
    ...overrides,
  };
}

function listOf(extra: Partial<CapabilityPluginListResponse> = {}): CapabilityPluginListResponse {
  return {
    installed: [],
    builtIn: [],
    operatorApprovalSkip: false,
    folderSourcesAllowed: true,
    issues: [],
    ...extra,
  };
}

const RELEASE_NOTES = installed({
  pluginId: "release-notes",
  name: "Release notes",
  description: "Drafts notes from merged work.",
  // The manifest listed its connector first; the line still starts with skills.
  pieceCounts: { connector: 1, skill: 2 },
});
const TEAM_KIT = installed({
  pluginId: "team-kit",
  name: "Team kit",
  description: "Shared prompts for the team.",
  trust: "built_in",
  sourceDisplay: "Ships with GoatCitadel",
  sourceKind: "built_in",
  pieceCounts: { prompt_pack: 1 },
});
const BROWSER_CHECKS = builtIn({
  pluginId: "browser-checks",
  name: "Browser checks",
  description: "Checks web pages in a real browser.",
});

const httpFailure = (status: number) =>
  new ApiRequestError("Plugins can't be read right now.", {
    kind: "http",
    method: "GET",
    path: "/api/v1/capabilities/plugins",
    status,
    body: { error: "Plugins can't be read right now." },
  });

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const text = () => container.textContent ?? "";
const cards = () => [...container.querySelectorAll("li")];
const names = () => cards().map((card) => card.querySelector("h3")?.textContent);
const rowOf = (name: string) => cards().find((card) => card.querySelector("h3")?.textContent === name)!;
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
const headings = () => [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
const alerts = () => container.querySelectorAll('[role="alert"]');
const searchBox = () => container.querySelector<HTMLInputElement>('[role="search"] input')!;
const trustGroup = () => container.querySelector('[role="group"][aria-label="Where it comes from"]');

async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsTab />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function click(element: Element | null | undefined) {
  expect(element, "the element to click").toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchBox(), value);
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  api.fetchCapabilityPlugins.mockReset().mockResolvedValue(listOf());
  route.navigate.mockReset();
  route.search = "";
  opener.install.mockReset();
  opener.resume.mockReset();
  opener.openSource.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("Plugins tab", () => {
  it("lists installed plugins first, then built-in ones", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ installed: [RELEASE_NOTES], builtIn: [BROWSER_CHECKS] }));
    await render();

    expect(api.fetchCapabilityPlugins).toHaveBeenCalledExactlyOnceWith("ws-1", expect.objectContaining({}));
    expect(headings()).toEqual(["Installed", "Built in"]);
    expect(names()).toEqual(["Release notes", "Browser checks"]);
    // Each section's rows sit in the two-column grid.
    for (const list of container.querySelectorAll("section ul")) expect(list.className).toContain("sm:grid-cols-2");

    const release = rowOf("Release notes");
    expect(release.textContent).toContain("Drafts notes from merged work.");
    expect(release.textContent).toContain("Installed · 2 skills, 1 connector");
    // The badge holds the state alone, and the pieces sit beside it, so the badge never wraps.
    expect(release.querySelector("[data-tone]")?.textContent).toBe("Installed");
    expect(release.querySelector("[data-tone] + span")?.textContent).toBe("· 2 skills, 1 connector");
    expect(button("View Release notes", release)?.textContent).toBe("View");
    expect(release.querySelectorAll("button")).toHaveLength(1);
    const browser = rowOf("Browser checks");
    expect(browser.textContent).toContain("Built in");
    expect(browser.textContent).toContain("Ready to install");
    expect(browser.textContent).not.toContain("Installed ·");
    expect(button("Install Browser checks", browser)?.textContent).toBe("Install");
    expect(browser.querySelectorAll("button")).toHaveLength(1);

    // The box suggests a real plugin's name.
    expect(searchBox().placeholder).toBe('Try "release notes"');
    expect(container.querySelector('[role="search"] label')?.textContent).toBe("Plugins search");

    // View moves the address to the plugin's own panel; Install checks the plugin in the install panel.
    await click(button("View Release notes"));
    expect(route.navigate).toHaveBeenLastCalledWith(pluginItemHref("release-notes"));
    await click(button("Install Browser checks"));
    expect(opener.install).toHaveBeenCalledExactlyOnceWith(BROWSER_CHECKS);
    expect(route.navigate).toHaveBeenCalledTimes(1);
  });

  it("labels unverified plugins", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(
      listOf({ installed: [RELEASE_NOTES, TEAM_KIT], builtIn: [BROWSER_CHECKS] }),
    );
    await render();

    expect(rowOf("Release notes").querySelector("h3 + span")?.textContent).toBe("Unverified");
    expect(rowOf("Team kit").querySelector("h3 + span")?.textContent).toBe("Built in");
    expect(rowOf("Browser checks").querySelector("h3 + span")?.textContent).toBe("Built in");
    // Both labels are present, so one filter chooses between them.
    expect(trustGroup()).not.toBeNull();
    expect([...trustGroup()!.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
      "All",
      "Built in",
      "Unverified",
    ]);

    await click(button("Unverified", trustGroup()!));
    expect(names()).toEqual(["Release notes"]);
    expect(headings()).toEqual(["Installed"]);
    expect(text()).toContain("1 of 2 plugins");

    await click(button("Built in", trustGroup()!));
    // Choosing both is All again.
    expect(names()).toEqual(["Release notes", "Team kit", "Browser checks"]);
  });

  it("drops a chosen trust label once no plugin has it", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(
      listOf({ installed: [RELEASE_NOTES, TEAM_KIT], builtIn: [BROWSER_CHECKS] }),
    );
    await render();
    await click(button("Unverified", trustGroup()!));
    expect(names()).toEqual(["Release notes"]);

    // The last unverified plugin goes: the filter has nothing left to choose between, so it goes too, and so does
    // the choice, rather than hiding every row behind a button no one can see.
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ installed: [TEAM_KIT], builtIn: [BROWSER_CHECKS] }));
    await act(async () => client.invalidateQueries({ queryKey: LIST_KEY }));
    await settle();
    expect(trustGroup()).toBeNull();
    expect(names()).toEqual(["Team kit", "Browser checks"]);
    expect(headings()).not.toContain("No plugins match");
  });

  it("shows no trust filter when every plugin has the same label", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ installed: [TEAM_KIT], builtIn: [BROWSER_CHECKS] }));
    await render();
    expect(names()).toEqual(["Team kit", "Browser checks"]);
    expect(trustGroup()).toBeNull();
  });

  it("offers Continue for an install that isn't finished", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(
      listOf({
        installed: [
          installed({ pluginId: "half-done", name: "Half done", state: "install_not_finished" }),
          installed({ pluginId: "going-away", name: "Going away", state: "uninstalling" }),
        ],
      }),
    );
    await render();

    const half = rowOf("Half done");
    expect(half.textContent).toContain("Install not finished");
    expect(half.textContent).not.toContain("Installed ·");
    expect(button("Continue Half done", half)?.textContent).toBe("Continue");
    expect(half.querySelectorAll("button")).toHaveLength(1);
    // Continue opens the install panel, which carries on from the first piece that isn't done.
    await click(button("Continue Half done"));
    expect(opener.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pluginId: "half-done" }));
    expect(route.navigate).not.toHaveBeenCalled();

    // A plugin on its way out is viewed; its panel says how to finish.
    const going = rowOf("Going away");
    expect(going.textContent).toContain("Removing…");
    expect(button("View Going away", going)?.textContent).toBe("View");
    expect(going.querySelectorAll("button")).toHaveLength(1);
    await click(button("View Going away"));
    expect(route.navigate).toHaveBeenLastCalledWith(pluginItemHref("going-away"));
    expect(button("Install Half done")).toBeUndefined();
  });

  it("hides Add from folder when remote hardened", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ builtIn: [BROWSER_CHECKS], folderSourcesAllowed: false }));
    await render();
    expect(button("Install from Git")).toBeDefined();
    expect(button("Add from folder")).toBeUndefined();
    // Nor does the empty state point at a folder.
    expect(text()).toContain("Install one from the built-in list or a Git repository.");
    expect(text()).not.toContain("folder");

    act(() => root.unmount());
    client.clear();
    root = createRoot(container);
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ builtIn: [BROWSER_CHECKS], folderSourcesAllowed: true }));
    await render();
    expect(button("Add from folder")).toBeDefined();
    const actions = [...container.querySelectorAll('[role="search"] button')].map((entry) => entry.textContent);
    expect(actions).toEqual(["Install from Git", "Add from folder"]);

    // Each opens its form in the install panel.
    await click(button("Install from Git"));
    expect(opener.openSource).toHaveBeenLastCalledWith("git");
    await click(button("Add from folder"));
    expect(opener.openSource).toHaveBeenLastCalledWith("folder");
  });

  it("shows Try again when the list fails, never an empty list", async () => {
    api.fetchCapabilityPlugins.mockRejectedValue(httpFailure(503));
    await render();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.textContent).toBe(
      `Plugins can't be read right now. ${describeApiError(httpFailure(503)).summary}`,
    );
    expect(text()).not.toContain("No plugins yet");
    expect(headings()).toEqual([]);
    expect(cards()).toHaveLength(0);

    // Trying again keeps the alert, and the button with its focus, until the read answers.
    let answer!: (value: CapabilityPluginListResponse) => void;
    api.fetchCapabilityPlugins.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const retry = button("Try again")!;
    retry.focus();
    await click(retry);
    expect(alerts()).toHaveLength(1);
    // The same button stays, busy, with its label swapped.
    expect(retry.isConnected).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(retry.textContent).toBe("Trying…");
    expect(document.activeElement).toBe(retry);

    await act(async () => answer(listOf({ installed: [RELEASE_NOTES] })));
    await settle();
    expect(alerts()).toHaveLength(0);
    expect(names()).toEqual(["Release notes"]);
  });

  it.each<
    [
      string,
      { list?: CapabilityPluginListResponse; fails?: boolean; search?: string },
      { title?: string; alert?: string; description?: string; action: string | null },
    ]
  >([
    [
      "nothing installed, with built-ins and folders",
      { list: listOf({ builtIn: [BROWSER_CHECKS] }) },
      {
        title: "No plugins yet",
        description: "Install one from the built-in list, a Git repository or a folder.",
        action: null,
      },
    ],
    [
      "nothing installed and nothing built in",
      { list: listOf() },
      { title: "No plugins yet", description: "Install one from a Git repository or a folder.", action: null },
    ],
    [
      "nothing installed, and no folders",
      { list: listOf({ builtIn: [BROWSER_CHECKS], folderSourcesAllowed: false }) },
      { title: "No plugins yet", description: "Install one from the built-in list or a Git repository.", action: null },
    ],
    [
      "nothing at all, and no folders",
      { list: listOf({ folderSourcesAllowed: false }) },
      { title: "No plugins yet", description: "Install one from a Git repository.", action: null },
    ],
    ["a failed read", { fails: true }, { alert: "Plugins can't be read right now.", action: "Try again" }],
    [
      "a search nothing matches",
      { list: listOf({ installed: [RELEASE_NOTES], builtIn: [BROWSER_CHECKS] }), search: "spreadsheets" },
      {
        title: "No plugins match",
        description: "Try a different search, or clear the filters.",
        action: "Clear filters",
      },
    ],
  ])("says so for %s", async (_name, setup, expected) => {
    if (setup.fails) api.fetchCapabilityPlugins.mockRejectedValue(httpFailure(503));
    else api.fetchCapabilityPlugins.mockResolvedValue(setup.list);
    await render();
    if (setup.search) await type(setup.search);

    if (expected.title) {
      expect(headings()).toContain(expected.title);
      const state = [...container.querySelectorAll("h2")].find(
        (heading) => heading.textContent === expected.title,
      )!.parentElement!;
      expect(state.querySelector("p")?.textContent).toBe(expected.description);
      // An empty state is page content, never announced.
      expect(alerts()).toHaveLength(0);
      if (expected.action) expect(button(expected.action, state)).toBeDefined();
      else expect(state.querySelector("button")).toBeNull();
    }
    if (expected.alert) {
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]?.textContent?.startsWith(expected.alert)).toBe(true);
      expect(text()).not.toContain("No plugins");
      expect(button(expected.action!)).toBeDefined();
    }
    // An empty list never hides where to add a plugin from, and a failed read offers nothing it can't tell.
    expect(button("Install from Git") !== undefined).toBe(!setup.fails);
  });

  it("lists the built-in plugins under the empty state when nothing is installed", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ builtIn: [BROWSER_CHECKS] }));
    await render();
    expect(headings()).toEqual(["No plugins yet", "Built in"]);
    expect(names()).toEqual(["Browser checks"]);
    expect(searchBox().placeholder).toBe('Try "browser checks"');
  });

  it("says what it searches when there are no plugins", async () => {
    await render();
    expect(searchBox().placeholder).toBe("Search plugins");
    expect(trustGroup()).toBeNull();
  });

  it("clears the search and the filter, and puts focus in the search box", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(
      listOf({ installed: [RELEASE_NOTES, TEAM_KIT], builtIn: [BROWSER_CHECKS] }),
    );
    await render();
    await click(button("Unverified", trustGroup()!));
    await type("browser");
    expect(headings()).toContain("No plugins match");

    await click(button("Clear filters"));
    expect(searchBox().value).toBe("");
    expect(names()).toEqual(["Release notes", "Team kit", "Browser checks"]);
    expect(button("All", trustGroup()!)?.getAttribute("aria-pressed")).toBe("true");
    // The button that was pressed left, so focus goes to the search box.
    expect(document.activeElement).toBe(searchBox());
  });

  it("searches both sections and hides one with nothing left", async () => {
    api.fetchCapabilityPlugins.mockResolvedValue(listOf({ installed: [RELEASE_NOTES], builtIn: [BROWSER_CHECKS] }));
    await render();
    await type("real browser");
    expect(headings()).toEqual(["Built in"]);
    expect(names()).toEqual(["Browser checks"]);
  });

  it("shows each line about what couldn't be read", async () => {
    const issues = [
      "Whether some plugins' skills are switched on couldn't be read right now, so those plugins show as not finished.",
      "The plugins that ship with GoatCitadel couldn't be read right now.",
    ];
    api.fetchCapabilityPlugins.mockResolvedValue(
      listOf({
        installed: [installed({ pluginId: "half-done", name: "Half done", state: "install_not_finished" })],
        issues,
      }),
    );
    await render();
    for (const issue of issues) expect(text()).toContain(issue);
    expect(alerts()).toHaveLength(0);
    expect(names()).toEqual(["Half done"]);
  });

  it("paints the cached list at once and checks it again in the background", async () => {
    client.setQueryData(LIST_KEY, listOf({ installed: [RELEASE_NOTES] }));
    api.fetchCapabilityPlugins.mockReturnValue(new Promise(() => {}));
    await render();
    expect(names()).toEqual(["Release notes"]);
    expect(text()).toContain("Checking for changes…");
    expect(api.fetchCapabilityPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached list beside one warning when a recheck fails", async () => {
    client.setQueryData(LIST_KEY, listOf({ installed: [RELEASE_NOTES] }));
    api.fetchCapabilityPlugins.mockRejectedValue(httpFailure(503));
    await render();
    expect(names()).toEqual(["Release notes"]);
    expect(text()).toContain(`${describeApiError(httpFailure(503)).summary} Showing the last version`);
    expect(text()).not.toContain("Plugins can't be read right now.");
    expect(alerts()).toHaveLength(0);
  });

  it("says it is checking before the first read answers", async () => {
    api.fetchCapabilityPlugins.mockReturnValue(new Promise(() => {}));
    await render();
    expect(text()).toBe("Checking for changes…");
    expect(alerts()).toHaveLength(0);
  });
});
