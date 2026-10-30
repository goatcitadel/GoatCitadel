// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { ConnectorSetupPage } from "./ConnectorSetupPage";

const owner = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));
function OwnerProbe({ name }: { name: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    owner.mounted(name);
    return () => owner.unmounted(name);
  }, [name]);
  return (
    <label>
      {name}
      <input aria-label={`${name} retained draft`} value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  );
}
// The editors moved here unchanged and have their own tests; this file covers the page around them.
vi.mock("../../settings/McpServersSettings", () => ({
  McpServersSettings: ({ workspaceId }: { workspaceId: string }) => <OwnerProbe name={`MCP owner ${workspaceId}`} />,
}));
vi.mock("../../settings/IntegrationConnectionsSettings", () => ({
  IntegrationConnectionsSettings: ({ workspaceId }: { workspaceId: string }) => (
    <OwnerProbe name={`Integration owner ${workspaceId}`} />
  ),
}));
vi.mock("../../settings/WebSearchSettings", () => ({
  WebSearchSettings: () => <OwnerProbe name="Web & Search owner" />,
}));

let root: Root, container: HTMLDivElement, queryClient: QueryClient;
const tab = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!;
const active = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const mounted = () => owner.mounted.mock.calls.map(([name]) => name);

async function render(url: string) {
  window.history.replaceState(null, "", url);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <CockpitNavigationProvider>
          <ConnectorSetupPage />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
async function activate(label: string) {
  await act(async () => {
    const element = tab(label);
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  preferences.activeWorkspaceId = "workspace-a";
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  window.history.replaceState(null, "", "/");
});

describe("Capabilities › Connectors › Advanced setup", () => {
  it("names itself, links back to Connectors and opens on MCP servers for this workspace", async () => {
    await render("/capabilities/connectors/advanced?shell=cockpit");
    await vi.waitFor(() => expect(mounted()).toEqual(["MCP owner workspace-a"]));
    expect(container.querySelector("h2")?.textContent).toBe("Advanced setup");
    expect(container.textContent).toContain("Every setting behind the Connectors list");
    const back = [...container.querySelectorAll("a")].find((link) => link.textContent === "Back to Connectors");
    expect(new URL(back!.href).pathname).toBe("/capabilities/connectors");
    expect([...container.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual([
      "MCP servers",
      "Integrations",
      "Web & Search",
    ]);
    expect(active()).toBe("MCP servers");
  });

  it.each([
    ["#web-search", "Web & Search", "Web & Search owner"],
    ["#integration-connections", "Integrations", "Integration owner workspace-a"],
    // A provider's sign-in returns here; the fragment opens the section that hands it back.
    ["#mcp-oauth-return&state=s-1&code=abc", "MCP servers", "MCP owner workspace-a"],
    ["#google-oauth-return&state=s-2&code=4%2F0Ad", "Integrations", "Integration owner workspace-a"],
  ])("opens %s on %s", async (hash, label, ownerName) => {
    await render(`/capabilities/connectors/advanced?shell=cockpit${hash}`);
    await vi.waitFor(() => expect(mounted()).toEqual([ownerName]));
    expect(active()).toBe(label);
  });

  it("keeps a section's unsaved input while another section is open, as Settings did", async () => {
    await render("/capabilities/connectors/advanced?shell=cockpit#mcp-servers");
    await vi.waitFor(() => expect(mounted()).toEqual(["MCP owner workspace-a"]));
    const draft = container.querySelector<HTMLInputElement>('[aria-label="MCP owner workspace-a retained draft"]')!;
    await fill(draft, "npx my-server");
    await activate("Web & Search");
    expect(window.location.pathname).toBe("/capabilities/connectors/advanced");
    expect(window.location.hash).toBe("#web-search");
    await vi.waitFor(() => expect(active()).toBe("Web & Search"));
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
    await activate("MCP servers");
    await vi.waitFor(() => expect(active()).toBe("MCP servers"));
    expect(draft.value).toBe("npx my-server");
    expect(owner.unmounted).not.toHaveBeenCalled();
  });
});
