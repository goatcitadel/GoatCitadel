// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesArea } from "./CapabilitiesArea";
import { CAPABILITIES_TABS, readCapabilitiesTab } from "./capabilities-tabs";

const route = vi.hoisted(() => ({ rest: [] as string[], search: "", hash: "", navigate: vi.fn() }));
const connectorsRendered = vi.hoisted(() => vi.fn());
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
// The tabs have their own tests; this file covers the page around them, which mounts without a query client.
vi.mock("./connectors/ConnectorsTab", () => ({
  ConnectorsTab: () => {
    connectorsRendered();
    return <div data-testid="connectors-tab" />;
  },
}));
vi.mock("./connectors/ConnectorSetupPage", () => ({
  ConnectorSetupPage: () => <div data-testid="connector-setup" />,
}));
vi.mock("./tools/ToolsTab", () => ({ ToolsTab: () => <div data-testid="tools-tab" /> }));
vi.mock("./skills/SkillsTab", () => ({ SkillsTab: () => <div data-testid="skills-tab" /> }));

const LAST_TAB_KEY = "goatcitadel.cockpit.capabilities.last-tab.v1";

let container: HTMLDivElement;
let root: Root;

// happy-dom hands out bound wrappers, so a spy on Storage.prototype never intercepts; the instance is spied instead.
// Its spies are restored one by one because restoreAllMocks leaves them in place.
const restores: Array<() => void> = [];
function failing(method: "getItem" | "setItem") {
  const spy = vi.spyOn(window.localStorage, method).mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  restores.push(() => spy.mockRestore());
  return spy;
}

const tabLink = (name: string) =>
  [...container.querySelectorAll<HTMLAnchorElement>("nav a")].find((link) => link.textContent === name);
const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;

async function render() {
  await act(async () => root.render(<CapabilitiesArea />));
}

beforeEach(() => {
  window.localStorage.clear();
  route.rest = [];
  route.search = "";
  route.hash = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const restore of restores.splice(0)) restore();
  vi.clearAllMocks();
});

describe("Capabilities page", () => {
  it("opens Connectors on the first visit and the last tab after that", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Capabilities");
    expect(container.textContent).toContain("Everything GoatCitadel's AI can use, in one place.");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Capabilities sections");
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    expect(tabLink("Connectors")?.getAttribute("href")).toBe("/capabilities/connectors");
    expect(tabLink("Skills")?.getAttribute("href")).toBe("/capabilities/skills");
    expect(tabLink("Tools")?.getAttribute("href")).toBe("/capabilities/tools");
    expect(shown("connectors-tab")).toBe(true);
    expect(shown("skills-tab")).toBe(false);
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors", { replace: true });
    // Landing on the default is not a choice, so nothing is remembered yet.
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBeNull();

    window.localStorage.setItem(LAST_TAB_KEY, "tools");
    vi.clearAllMocks();
    await render();
    expect(tabLink("Tools")?.getAttribute("aria-current")).toBe("page");
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBeNull();
    expect(shown("tools-tab")).toBe(true);
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/tools", { replace: true });
  });

  it("never mounts Connectors first when the last tab was Tools", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "tools");
    await render();
    // Connectors would fire its queries the moment it rendered, so it must not render even once.
    expect(connectorsRendered).not.toHaveBeenCalled();
    expect(shown("connectors-tab")).toBe(false);
    expect(shown("tools-tab")).toBe(true);
  });

  it("keeps the workspace and fragment on the address it opens", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "tools");
    route.search = "?workspaceId=w&shell=cockpit";
    route.hash = "#top";
    await render();
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/tools?workspaceId=w&shell=cockpit#top", {
      replace: true,
    });
  });

  it("falls back to Connectors when storage throws", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "tools");
    const getItem = failing("getItem");
    const setItem = failing("setItem");
    await render();
    expect(getItem).toHaveBeenCalledWith(LAST_TAB_KEY);
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    expect(shown("connectors-tab")).toBe(true);
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors", { replace: true });
    // A tab named by the address still shows when it can't be remembered.
    route.rest = ["tools"];
    await render();
    expect(tabLink("Tools")?.getAttribute("aria-current")).toBe("page");
    expect(shown("tools-tab")).toBe(true);
    expect(setItem).toHaveBeenCalledWith(LAST_TAB_KEY, "tools");
  });

  it("ignores a remembered tab that no longer exists", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "plugins");
    await render();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors", { replace: true });
  });

  it("opens the Skills tab when it was the last one", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "skills");
    await render();
    expect(tabLink("Skills")?.getAttribute("aria-current")).toBe("page");
    expect(shown("skills-tab")).toBe(true);
    expect(shown("connectors-tab")).toBe(false);
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/skills", { replace: true });
  });

  it.each([
    ["skills", "Skills", "skills-tab"],
    ["connectors", "Connectors", "connectors-tab"],
    ["tools", "Tools", "tools-tab"],
  ])("opens %s for its address and remembers it", async (id, label, testId) => {
    route.rest = [id];
    await render();
    expect(tabLink(label)?.getAttribute("aria-current")).toBe("page");
    expect(shown(testId)).toBe(true);
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBe(id);
    // The address already names the tab, so it is not rewritten.
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it("remembers the tab an address moves to, whether from a click, the palette or a redirect", async () => {
    route.rest = ["connectors"];
    await render();
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBe("connectors");
    route.rest = ["tools"];
    await render();
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBe("tools");
  });

  it("opens Connectors for an unknown tab without remembering or rewriting it", async () => {
    route.rest = ["no-such-tab"];
    await render();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBeNull();
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it("does not let an unknown tab replace the remembered one", async () => {
    window.localStorage.setItem(LAST_TAB_KEY, "tools");
    route.rest = ["no-such-tab"];
    await render();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBe("tools");
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it("navigates in the app when a tab is clicked", async () => {
    route.rest = ["connectors"];
    await render();
    await act(async () => tabLink("Tools")?.click());
    expect(route.navigate).toHaveBeenCalledWith("/capabilities/tools");
    await act(async () => tabLink("Connectors")?.click());
    expect(route.navigate).toHaveBeenCalledWith("/capabilities/connectors");
    await act(async () => tabLink("Skills")?.click());
    expect(route.navigate).toHaveBeenCalledWith("/capabilities/skills");
  });
});

describe("readCapabilitiesTab", () => {
  it.each([
    [[], "connectors"],
    [["connectors"], "connectors"],
    [["connectors", "extra"], "connectors"],
    [["tools"], "tools"],
    [["tools", "extra"], "tools"],
    [["skills"], "skills"],
    [["skills", "extra"], "skills"],
    [["plugins"], "connectors"],
    [[""], "connectors"],
  ])("reads %j as %s", (rest, expected) => {
    expect(readCapabilitiesTab(rest)).toBe(expected);
  });

  it("opens Connectors' Advanced setup under the Connectors tab, in place of the list", async () => {
    route.rest = ["connectors", "advanced"];
    route.hash = "#web-search";
    await render();
    await vi.waitFor(() => expect(shown("connector-setup")).toBe(true));
    expect(shown("connectors-tab")).toBe(false);
    expect(connectorsRendered).not.toHaveBeenCalled();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    // It names a tab, so it is remembered like one, and the address is left as it is.
    expect(window.localStorage.getItem(LAST_TAB_KEY)).toBe("connectors");
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it("does not open Advanced setup under another tab", async () => {
    route.rest = ["tools", "advanced"];
    await render();
    expect(shown("tools-tab")).toBe(true);
    expect(shown("connector-setup")).toBe(false);
  });

  it("gives every tab an id, a label and an address under /capabilities", () => {
    for (const tab of CAPABILITIES_TABS) expect(tab.href).toBe(`/capabilities/${tab.id}`);
    expect(CAPABILITIES_TABS.map((tab) => tab.label)).toEqual(["Skills", "Connectors", "Tools"]);
    // Skills come first, but a first visit still opens Connectors.
    expect(readCapabilitiesTab([])).toBe("connectors");
  });
});
