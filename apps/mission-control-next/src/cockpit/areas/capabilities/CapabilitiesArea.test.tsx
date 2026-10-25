// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesArea } from "./CapabilitiesArea";
import { CAPABILITIES_TABS, readCapabilitiesTab } from "./capabilities-tabs";

const route = vi.hoisted(() => ({ rest: [] as string[], navigate: vi.fn() }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
// The tab has its own tests; this file covers the page around it, which mounts without a query client.
vi.mock("./connectors/ConnectorsTab", () => ({ ConnectorsTab: () => <div data-testid="connectors-tab" /> }));

let container: HTMLDivElement;
let root: Root;

const tabLink = (name: string) =>
  [...container.querySelectorAll<HTMLAnchorElement>("nav a")].find((link) => link.textContent === name);

async function render() {
  await act(async () => root.render(<CapabilitiesArea />));
}

beforeEach(() => {
  route.rest = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Capabilities page", () => {
  it("opens Connectors for /capabilities", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Capabilities");
    expect(container.textContent).toContain("Everything GoatCitadel's AI can use, in one place.");
    const connectors = tabLink("Connectors");
    expect(connectors).toBeDefined();
    expect(connectors?.getAttribute("aria-current")).toBe("page");
    expect(connectors?.getAttribute("href")).toBe("/capabilities/connectors");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Capabilities sections");
    expect(container.querySelector('[data-testid="connectors-tab"]')).not.toBeNull();
  });

  it("opens Connectors for /capabilities/connectors and for an unknown tab", async () => {
    route.rest = ["connectors"];
    await render();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
    route.rest = ["no-such-tab"];
    await render();
    expect(tabLink("Connectors")?.getAttribute("aria-current")).toBe("page");
  });

  it("navigates in the app when a tab is clicked", async () => {
    await render();
    await act(async () => tabLink("Connectors")?.click());
    expect(route.navigate).toHaveBeenCalledWith("/capabilities/connectors");
  });
});

describe("readCapabilitiesTab", () => {
  it.each([
    [[], "connectors"],
    [["connectors"], "connectors"],
    [["connectors", "extra"], "connectors"],
    [["skills"], "connectors"],
    [[""], "connectors"],
  ])("reads %j as %s", (rest, expected) => {
    expect(readCapabilitiesTab(rest)).toBe(expected);
  });

  it("gives every tab an id, a label and an address under /capabilities", () => {
    for (const tab of CAPABILITIES_TABS) expect(tab.href).toBe(`/capabilities/${tab.id}`);
    expect(CAPABILITIES_TABS.map((tab) => tab.label)).toEqual(["Connectors"]);
  });
});
