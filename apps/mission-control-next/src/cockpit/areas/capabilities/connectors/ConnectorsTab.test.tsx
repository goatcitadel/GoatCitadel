// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsTab } from "./ConnectorsTab";

const api = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));
// The panel and the address have their own tests (ConnectorPanel.test.tsx); here only the hand-off is checked.
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
const inspector = vi.hoisted(() => ({ open: vi.fn(), content: null as null | { source?: string } }));
vi.mock("../../../app/inspector", () => ({ useInspector: () => inspector }));
vi.mock("../../settings/McpServerCreate", () => ({
  McpServerCreate: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Register MCP server">
      <button onClick={onClose}>Close registration</button>
    </div>
  ),
}));

function item(overrides: Partial<CapabilityConnectorItem>): CapabilityConnectorItem {
  return {
    id: "mcp-template:example",
    name: "Example",
    description: "An example app.",
    kind: "mcp",
    source: "mcp_template",
    category: "automation",
    state: "available",
    reason: "not_installed",
    group: "available",
    auth: "none",
    runsOnThisDevice: false,
    networkHosts: [],
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

const SLACK = item({
  id: "integration:slack",
  name: "Slack",
  description: "Chat with your team",
  kind: "channel",
  source: "integration",
  category: "messaging",
  state: "connected",
  reason: "ready",
  group: "connected",
});
const LINEAR = item({
  id: "mcp-server:linear",
  name: "Linear",
  description: "Issues and projects",
  category: "development",
  state: "broken",
  reason: "error",
  group: "connected",
});
const NOTION = item({ id: "mcp-template:notion", name: "Notion", description: "Notes and wikis" });
const AIRTABLE = item({
  id: "mcp-template:airtable",
  name: "Airtable",
  description: "Tables and bases",
  category: "data",
});
const ASANA = item({ id: "mcp-template:asana", name: "Asana", description: "Team tasks" });

function response(items: CapabilityConnectorItem[], issues: CapabilityConnectorsResponse["issues"] = []) {
  return { workspaceId: "ws-1", items, issues, generatedAt: "2026-10-25T10:00:00.000Z" };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
const searchBox = () => container.querySelector<HTMLInputElement>("input")!;
const headings = () => [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
const rowNames = () => [...container.querySelectorAll("li h3")].map((heading) => heading.textContent);

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectorsTab />
      </QueryClientProvider>,
    ),
  );
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchBox(), value);
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  api.fetchCapabilityConnectors.mockReset();
  route.navigate.mockReset();
  route.search = "";
  inspector.open = vi.fn();
  inspector.content = null;
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

describe("Connectors tab", () => {
  it("reads the active workspace's connectors", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Slack"));
    expect(api.fetchCapabilityConnectors).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("renders groups with counts", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, LINEAR, NOTION, AIRTABLE, ASANA]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Connected 2"));
    expect(text()).toContain("Available 3");
    expect(headings()).toEqual(["Connected 2", "Available 3"]);
    expect(rowNames()).toEqual(["Slack", "Linear", "Notion", "Airtable", "Asana"]);
  });

  it("shows what each row is and the one thing to do with it", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, LINEAR, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Slack"));
    const slack = [...container.querySelectorAll("li")].find((row) => row.textContent?.includes("Slack"))!;
    expect(slack.textContent).toContain("Channel");
    expect(slack.textContent).toContain("Chat with your team");
    expect(slack.textContent).toContain("Connected");
    expect(slack.textContent).toContain("Ready to use");
    expect(slack.querySelectorAll("button")).toHaveLength(1);
    expect(slack.querySelector("button")?.textContent).toBe("Manage");
    expect(slack.querySelector("button")?.getAttribute("aria-label")).toBe("Manage Slack");
    const linear = [...container.querySelectorAll("li")].find((row) => row.textContent?.includes("Linear"))!;
    expect(linear.textContent).toContain("Not working");
    expect(linear.querySelector("button")?.textContent).toBe("Try again");
    const notion = [...container.querySelectorAll("li")].find((row) => row.textContent?.includes("Notion"))!;
    expect(notion.textContent).toContain("MCP");
    expect(notion.querySelector("button")?.textContent).toBe("Set up");
  });

  it("opens the row's panel from its button by moving the address to that item", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Set up Notion"]')?.click());
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors?item=mcp-template%3Anotion");
  });

  it("opens the panel the address names once the list has it", async () => {
    route.search = "?item=mcp-template%3Anotion";
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(inspector.open).toHaveBeenCalledTimes(1));
    expect(inspector.open).toHaveBeenCalledWith(
      expect.objectContaining({ source: "capabilities:mcp-template:notion", title: "Notion" }),
    );
  });

  it("asks again when the inspector was replaced before the first request landed", async () => {
    route.search = "?item=mcp-template%3Anotion";
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(inspector.open).toHaveBeenCalledTimes(1));
    // A new address brings a new inspector; a request made to the old one is lost.
    const replacement = vi.fn();
    inspector.open = replacement;
    await render();
    expect(replacement).toHaveBeenCalledTimes(1);
    await render();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("opens the Add your own form and reads the list again when it closes", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    expect(container.querySelector('[role="search"] button')?.textContent).toBe("Add your own");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Add your own")?.click());
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
    expect(api.fetchCapabilityConnectors).toHaveBeenCalledTimes(1);
    await act(async () => button("Close registration")?.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(api.fetchCapabilityConnectors).toHaveBeenCalledTimes(2));
  });

  it("offers Add your own when there is nothing to list", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("No connectors yet"));
    expect(button("Add your own")).toBeDefined();
  });

  it("keeps rows and shows an issue line when one source failed", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(
      response([SLACK, NOTION], [{ source: "integration", message: "Gmail's sign-in status couldn't be read." }]),
    );
    await render();
    await vi.waitFor(() => expect(text()).toContain("Slack"));
    expect(text()).toContain("Gmail's sign-in status couldn't be read.");
    expect(rowNames()).toEqual(["Slack", "Notion"]);
    // The issue is one plain line above the groups, not a banner.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const issue = [...container.querySelectorAll("p")].find((line) => line.textContent?.includes("Gmail's"))!;
    expect(
      issue.compareDocumentPosition(container.querySelector("h2")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers Clear filters when nothing matches", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    await type("zzzz");
    expect(text()).toContain("Nothing matches");
    expect(headings().filter((heading) => /Connected|Available/.test(heading ?? ""))).toEqual([]);
    expect(rowNames()).toEqual([]);
    await act(async () => button("Clear filters")?.click());
    expect(searchBox().value).toBe("");
    expect(rowNames()).toEqual(["Slack", "Notion"]);
  });

  it("searches by name, description, category and kind", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, LINEAR, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    await type("wikis");
    expect(rowNames()).toEqual(["Notion"]);
    await type("channel");
    expect(rowNames()).toEqual(["Slack"]);
    await type("development");
    expect(rowNames()).toEqual(["Linear"]);
  });

  it("filters by category and clears the category with the search", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, LINEAR, NOTION, AIRTABLE]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    await act(async () => button("Development")?.click());
    expect(rowNames()).toEqual(["Linear"]);
    await type("zzzz");
    expect(text()).toContain("Nothing matches");
    await act(async () => button("Clear filters")?.click());
    expect(rowNames()).toEqual(["Slack", "Linear", "Notion", "Airtable"]);
    expect(button("All")?.getAttribute("aria-pressed")).toBe("true");
    // The pressed button left with the empty state, so focus goes to the search box instead of the page.
    expect(document.activeElement).toBe(searchBox());
  });

  it("hides the category buttons when there is only one category", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([NOTION, ASANA]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    expect(container.querySelector('[aria-label="Categories"]')).toBeNull();
  });

  it("suggests a search from the first connected row's category", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    expect(searchBox().placeholder).toBe('Try "Messaging"');
  });

  it("suggests automation when nothing is connected", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([NOTION, AIRTABLE]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    expect(searchBox().placeholder).toBe('Try "automation"');
  });

  it("says when there is nothing to list at all", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("No connectors yet"));
    expect(button("Clear filters")).toBeUndefined();
  });

  it("says it couldn't load any connectors when sources failed and nothing is left to list", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(
      response(
        [],
        [
          { source: "mcp_server", message: "Saved MCP servers couldn't be read." },
          { source: "integration", message: "Integrations couldn't be read." },
        ],
      ),
    );
    await render();
    await vi.waitFor(() => expect(text()).toContain("Couldn't load any connectors right now"));
    expect(text()).toContain("Saved MCP servers couldn't be read.");
    expect(text()).toContain("Integrations couldn't be read.");
    // An empty answer from failed sources is not an empty list.
    expect(text()).not.toContain("No connectors yet");
    expect(container.querySelector("input")).toBeNull();
    expect(button("Add your own")).toBeUndefined();

    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK]));
    await act(async () => button("Retry")?.click());
    await vi.waitFor(() => expect(rowNames()).toEqual(["Slack"]));
    expect(text()).not.toContain("Couldn't load any connectors");
  });

  it("shows the checking line while the first read runs", async () => {
    api.fetchCapabilityConnectors.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(text()).toContain("Checking for changes…");
    expect(headings()).toEqual([]);
  });

  it("never renders 0 apps while the first load fails", async () => {
    api.fetchCapabilityConnectors.mockRejectedValue(new Error("Gateway offline"));
    await render();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(button("Retry")).toBeDefined();
    expect(text()).not.toContain("Search 0 apps");
    expect(text()).not.toMatch(/Connected|Available|On this device|Turned off/);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("li")).toBeNull();

    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK]));
    await act(async () => button("Retry")?.click());
    await vi.waitFor(() => expect(rowNames()).toEqual(["Slack"]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps Retry on screen, busy, while the first read is tried again", async () => {
    api.fetchCapabilityConnectors.mockRejectedValue(new Error("Gateway offline"));
    await render();
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    const retry = button("Retry")!;
    retry.focus();
    let release!: () => void;
    api.fetchCapabilityConnectors.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(response([SLACK]));
        }),
    );
    await act(async () => retry.click());
    await vi.waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
    // The same button stays mounted and focused, and the page doesn't fall back to a bare loading line.
    expect(container.contains(retry)).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(text()).toContain("Connectors couldn't load.");
    await act(async () => release());
    await vi.waitFor(() => expect(rowNames()).toEqual(["Slack"]));
  });

  it("keeps the list and adds one warning line when a recheck fails", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    api.fetchCapabilityConnectors.mockRejectedValue(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(text()).toContain("Showing the last version"));
    expect(rowNames()).toEqual(["Slack", "Notion"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Retry")).toBeUndefined();
  });

  it("keeps the list while it is read again", async () => {
    api.fetchCapabilityConnectors.mockResolvedValue(response([SLACK, NOTION]));
    await render();
    await vi.waitFor(() => expect(text()).toContain("Notion"));
    let release!: () => void;
    api.fetchCapabilityConnectors.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(response([SLACK, NOTION]));
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text()).toContain("Checking for changes…");
    expect(rowNames()).toEqual(["Slack", "Notion"]);
    await act(async () => release());
    await vi.waitFor(() => expect(text()).not.toContain("Checking for changes…"));
  });
});
