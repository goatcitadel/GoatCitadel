// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilityConnectorItem,
  CapabilityConnectorsResponse,
  McpServerRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../../app/inspector";
import { queryKeys } from "../../../data/query-keys";
import { ConnectorPanel } from "./ConnectorPanel";
import { ConnectorsTab } from "./ConnectorsTab";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const mcp = vi.hoisted(() => ({
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  fetchMcpTools: vi.fn(),
  fetchMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", () => mcp);
const connectorsApi = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => connectorsApi);
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));

const REVISION = "a".repeat(64);
const KEY = queryKeys.capabilityConnectors("ws-1");

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

const LINEAR = item({
  id: "mcp-server:linear",
  name: "Linear",
  description: "Issues and projects",
  source: "mcp_server",
  category: "development",
  state: "connected",
  reason: "ready",
  group: "connected",
  auth: "oauth",
  networkHosts: ["mcp.linear.app"],
  serverId: "linear",
  serverRevision: REVISION,
});
const OFF_LINEAR = { ...LINEAR, state: "turned_off", reason: "turned_off", group: "turned_off" } as const;
const NOTION = item({ id: "mcp-server:notion", name: "Notion", source: "mcp_server", serverId: "notion" });
const CONTEXT7 = item({
  id: "mcp-template:context7",
  name: "Context7",
  description: "Up-to-date library docs",
  group: "on_this_device",
  runsOnThisDevice: true,
  command: "npx -y @upstash/context7-mcp@1.0.31",
  templateId: "context7",
});

function savedServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "linear",
    revision: REVISION,
    label: "Linear",
    transport: "stdio",
    authType: "none",
    enabled: false,
    status: "disconnected",
    category: "development",
    trustTier: "verified",
    costTier: "free",
    policy: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as unknown as McpServerRecord;
}

function tool(toolName: string, description?: string, enabled = true): McpToolRecord {
  return { serverId: "linear", toolName, ...(description ? { description } : {}), enabled, updatedAt: "2026-10-01" };
}

function response(items: CapabilityConnectorItem[]): CapabilityConnectorsResponse {
  return { workspaceId: "ws-1", items, issues: [], generatedAt: "2026-10-25T10:00:00.000Z" };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const body = () => document.body;
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
const link = (label: string) =>
  [...document.body.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent === label);
const switchControl = () => document.body.querySelector<HTMLButtonElement>('[role="switch"]');
const cached = (id: string) => client.getQueryData<CapabilityConnectorsResponse>(KEY)?.items.find((e) => e.id === id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function renderPanel(itemId: string, items: CapabilityConnectorItem[] = [LINEAR, NOTION, CONTEXT7]) {
  client.setQueryData(KEY, response(items));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>
          <ConnectorPanel itemId={itemId} />
        </InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}

async function renderTab() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>
          <ConnectorsTab />
          <InspectorPanel />
        </InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  // The docked desktop layout.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  for (const mock of [...Object.values(mcp), ...Object.values(connectorsApi), route.navigate]) mock.mockReset();
  mcp.fetchMcpTools.mockResolvedValue({ items: [] });
  mcp.fetchMcpServer.mockResolvedValue(savedServer());
  route.search = "";
  prefs.showTechnicalDetails = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe("Connector panel", () => {
  it("shows the kind, category, state and reason", async () => {
    await renderPanel(LINEAR.id);
    expect(text()).toContain("MCP · Development");
    expect(text()).toContain("Connected");
    expect(text()).toContain("Ready to use");
    expect(text()).toContain("Issues and projects");
  });

  it("says when the connector is no longer listed", async () => {
    await renderPanel("mcp-server:gone");
    expect(text()).toContain("isn't in the list anymore");
    expect(switchControl()).toBeNull();
  });

  it("shows the exact command and the network warning for on-device apps", async () => {
    await renderPanel(CONTEXT7.id);
    expect(text()).toContain("How it connects");
    expect(text()).toContain("Runs on this computer");
    expect(body().querySelector("code")?.textContent).toBe("npx -y @upstash/context7-mcp@1.0.31");
    expect(text()).toContain("This program's own internet access isn't limited by GoatCitadel's allowed sites.");
    // An app that is not saved has no switch and nothing to remove yet.
    expect(switchControl()).toBeNull();
    expect(button("Remove")).toBeUndefined();
  });

  it("names the sign-in host for an app that signs in", async () => {
    await renderPanel(LINEAR.id);
    expect(text()).toContain("Signs in at mcp.linear.app");
    expect(body().querySelector("code")).toBeNull();
    expect(text()).not.toContain("isn't limited by GoatCitadel's allowed sites");
  });

  it("links Advanced setup to the MCP section", async () => {
    await renderPanel(LINEAR.id);
    const advanced = link("Advanced setup in Settings");
    expect(advanced).toBeDefined();
    const target = new URL(advanced!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/settings/connections");
    expect(target.hash).toBe("#mcp-servers");
  });

  it("explains when Chat can't use connectors yet, with a link to Settings", async () => {
    const blocked = { ...LINEAR, chat: { available: false, blockedBy: "mcp_in_chat_off" } } as const;
    await renderPanel(LINEAR.id, [blocked]);
    expect(text()).toContain("Chat can't use connectors yet");
    const target = new URL(link("See Chat access in Settings")!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname + target.hash).toBe("/settings/connections#mcp-servers");
  });

  it("stays quiet about Chat when Chat can use it", async () => {
    await renderPanel(LINEAR.id);
    expect(text()).not.toContain("Chat can't use connectors yet");
  });

  it("says a hidden connector is hidden here, with a link to the workspace's capabilities", async () => {
    await renderPanel(LINEAR.id, [{ ...LINEAR, hiddenInWorkspace: true }]);
    expect(text()).toContain("The AI can't use it in this workspace");
    expect(text()).not.toContain("Ready to use");
    const target = new URL(link("Change workspace capabilities")!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname + target.hash).toBe("/settings/citadel#workspace-capabilities");
  });

  it("keeps ids, hosts and the last error inside technical details", async () => {
    const failing = { ...LINEAR, state: "broken", reason: "error", lastError: "spawn ENOENT" } as const;
    await renderPanel(LINEAR.id, [failing]);
    expect(text()).not.toContain("spawn ENOENT");
    expect(text()).not.toContain("mcp-server:linear");
    prefs.showTechnicalDetails = true;
    await renderPanel(LINEAR.id, [failing]);
    const details = body().querySelector("details")!;
    expect(details.textContent).toContain("spawn ENOENT");
    expect(details.textContent).toContain("mcp-server:linear");
    expect(details.textContent).toContain("mcp.linear.app");
    expect(details.textContent).toContain(REVISION);
  });
});

describe("Connector panel tools", () => {
  it("lists a saved server's tools", async () => {
    mcp.fetchMcpTools.mockResolvedValue({
      items: [
        tool("create_issue", "Create an issue"),
        tool("list_projects", "List projects"),
        tool("old_tool", "", false),
      ],
    });
    await renderPanel(LINEAR.id);
    await vi.waitFor(() => expect(text()).toContain("create_issue"));
    expect(mcp.fetchMcpTools).toHaveBeenCalledExactlyOnceWith("linear");
    expect(text()).toContain("Create an issue");
    expect(text()).toContain("list_projects");
    expect([...body().querySelectorAll("li")].map((entry) => entry.querySelector("code")?.textContent)).toEqual([
      "create_issue",
      "list_projects",
      "old_tool",
    ]);
    expect(text()).toContain("Switched off");
  });

  it("says when no tools are listed yet", async () => {
    await renderPanel(LINEAR.id);
    await vi.waitFor(() => expect(text()).toContain("No tools listed yet"));
  });

  it("says when the tool list couldn't load, and tries again", async () => {
    mcp.fetchMcpTools.mockRejectedValueOnce(new Error("offline"));
    await renderPanel(LINEAR.id);
    await vi.waitFor(() => expect(text()).toContain("The tool list couldn't load."));
    mcp.fetchMcpTools.mockResolvedValue({ items: [tool("create_issue")] });
    await act(async () => button("Retry")?.click());
    await vi.waitFor(() => expect(text()).toContain("create_issue"));
  });

  it("does not ask for tools of an app that isn't saved", async () => {
    await renderPanel(CONTEXT7.id);
    expect(mcp.fetchMcpTools).not.toHaveBeenCalled();
  });
});

describe("Connector panel switch", () => {
  it("is on for a connected server and named by the app", async () => {
    await renderPanel(LINEAR.id);
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
    expect(switchControl()?.getAttribute("aria-label")).toBe("Turn it on or off: Linear");
  });

  it("switches a server off, saved with its version", async () => {
    const saving = deferred<McpServerRecord>();
    mcp.updateMcpServer.mockReturnValue(saving.promise);
    await renderPanel(LINEAR.id);
    await act(async () => switchControl()?.click());
    expect(switchControl()?.getAttribute("aria-checked")).toBe("false");
    expect(switchControl()?.getAttribute("aria-busy")).toBe("true");
    expect(mcp.updateMcpServer).toHaveBeenCalledExactlyOnceWith("linear", {
      expectedRevision: REVISION,
      enabled: false,
    });
    await act(async () => saving.resolve(savedServer({ revision: "b".repeat(64) })));
    expect(switchControl()?.getAttribute("aria-checked")).toBe("false");
    expect(switchControl()?.getAttribute("aria-busy")).toBeNull();
  });

  it("rolls back only the failed switch", async () => {
    const saving = deferred<McpServerRecord>();
    mcp.updateMcpServer.mockReturnValue(saving.promise);
    await renderPanel(LINEAR.id);
    await act(async () => switchControl()?.click());
    expect(switchControl()?.getAttribute("aria-checked")).toBe("false");
    const newerNotion = { ...NOTION, state: "broken", reason: "error" } as const;
    act(() => {
      client.setQueryData(KEY, (list: CapabilityConnectorsResponse) => ({
        ...list,
        items: list.items.map((entry) => (entry.id === NOTION.id ? newerNotion : entry)),
      }));
    });

    await act(async () => saving.reject(new Error("The server said no")));
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
    expect(body().querySelector('[role="alert"]')?.textContent).toContain("The server said no");
    expect(cached(LINEAR.id)).toMatchObject({ state: "connected", group: "connected" });
    expect(cached(NOTION.id)).toEqual(newerNotion);
    expect(switchControl()?.getAttribute("aria-busy")).toBeNull();
  });

  it("explains a 409 with a reload", async () => {
    mcp.updateMcpServer.mockRejectedValue(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/mcp/servers/linear",
        status: 409,
        body: { code: "WRITE_CONFLICT" },
      }),
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await renderPanel(LINEAR.id);
    await act(async () => switchControl()?.click());
    expect(body().querySelector('[role="alert"]')?.textContent).toContain(
      "Changed elsewhere. Reload to see the latest.",
    );
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => button("Reload")?.click());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(body().querySelector('[role="alert"]')).toBeNull();
  });

  it("disables the switch with the reason when the server can't run yet", async () => {
    mcp.fetchMcpServer.mockResolvedValue(
      savedServer({ transport: "http", url: "https://mcp.example.com", authType: "oauth2" }),
    );
    await renderPanel(LINEAR.id, [OFF_LINEAR]);
    const reason = "Transport, trust, or authentication setup is incomplete. Review server setup before enabling.";
    await vi.waitFor(() => expect(text()).toContain(reason));
    expect(switchControl()?.disabled).toBe(true);
    expect(switchControl()?.getAttribute("aria-checked")).toBe("false");
    const describedBy = switchControl()?.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason);
    await act(async () => switchControl()?.click());
    expect(mcp.updateMcpServer).not.toHaveBeenCalled();
  });

  it("has no switch for an app that is not a saved server", async () => {
    await renderPanel(CONTEXT7.id);
    expect(switchControl()).toBeNull();
  });
});

describe("Connector panel remove", () => {
  it("removes a server only after confirming", async () => {
    mcp.deleteMcpServer.mockResolvedValue({ deleted: true });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await renderPanel(LINEAR.id);
    expect(button("Remove")?.className).toContain("border-status-failed");
    await act(async () => button("Remove")?.click());
    expect(mcp.deleteMcpServer).not.toHaveBeenCalled();
    // The confirmation names the app and says what is lost.
    const dialog = body().querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Remove Linear?");
    expect(dialog.textContent).toContain("every workspace");
    expect(dialog.textContent).toContain("can't be undone");

    await act(async () => button("Remove Linear")?.click());
    expect(mcp.deleteMcpServer).toHaveBeenCalledExactlyOnceWith("linear", REVISION);
    await vi.waitFor(() => expect(cached(LINEAR.id)).toBeUndefined());
    expect(cached(NOTION.id)).toBeDefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    await vi.waitFor(() => expect(body().querySelector('[role="dialog"]')).toBeNull());
  });

  it("keeps the server when the confirmation is declined", async () => {
    await renderPanel(LINEAR.id);
    await act(async () => button("Remove")?.click());
    await act(async () => button("Keep it")?.click());
    expect(mcp.deleteMcpServer).not.toHaveBeenCalled();
    expect(cached(LINEAR.id)).toBeDefined();
    expect(body().querySelector('[role="dialog"]')).toBeNull();
  });

  it("says why a removal failed, and offers a reload after a conflict", async () => {
    mcp.deleteMcpServer.mockRejectedValue(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "DELETE",
        path: "/api/v1/mcp/servers/linear",
        status: 409,
        body: { code: "WRITE_CONFLICT" },
      }),
    );
    await renderPanel(LINEAR.id);
    await act(async () => button("Remove")?.click());
    await act(async () => button("Remove Linear")?.click());
    expect(cached(LINEAR.id)).toBeDefined();
    expect(body().querySelector('[role="alert"]')?.textContent).toContain(
      "Changed elsewhere. Reload to see the latest.",
    );
    expect(button("Reload")).toBeDefined();
  });
});

describe("Connector panel from the Connectors tab", () => {
  it("opens the panel from ?item= once the list loads", async () => {
    route.search = `?item=${encodeURIComponent(LINEAR.id)}`;
    const loading = deferred<CapabilityConnectorsResponse>();
    connectorsApi.fetchCapabilityConnectors.mockReturnValue(loading.promise);
    await renderTab();
    // Nothing opens before the list says the connector exists.
    expect(body().querySelector('[data-inspector-body="true"]')).toBeNull();

    await act(async () => loading.resolve(response([LINEAR, NOTION])));
    await vi.waitFor(() => expect(body().querySelector('[aria-label="Inspector: Linear"]')).not.toBeNull());
    expect(body().querySelector('[data-inspector-body="true"]')?.textContent).toContain("How it connects");
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
  });

  it("ignores an item that isn't in the list", async () => {
    route.search = "?item=mcp-server%3Anope";
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([LINEAR]));
    await renderTab();
    await vi.waitFor(() => expect(text()).toContain("Linear"));
    expect(body().querySelector('[data-inspector-body="true"]')).toBeNull();
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it("puts the item in the address when a row is pressed", async () => {
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([LINEAR, NOTION]));
    await renderTab();
    await vi.waitFor(() => expect(text()).toContain("Linear"));
    await act(async () => body().querySelector<HTMLButtonElement>('button[aria-label="Manage Linear"]')?.click());
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors?item=mcp-server%3Alinear");
  });

  it("opens the panel again when the address already names the pressed row", async () => {
    route.search = `?item=${encodeURIComponent(LINEAR.id)}`;
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([LINEAR, NOTION]));
    await renderTab();
    await vi.waitFor(() => expect(body().querySelector('[aria-label="Inspector: Linear"]')).not.toBeNull());
    await act(async () => body().querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]')?.click());
    // Closing clears the address so the same row can be pressed again.
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/capabilities/connectors", { replace: true });
  });

  it("keeps the panel's switch current as the list is read again", async () => {
    route.search = `?item=${encodeURIComponent(LINEAR.id)}`;
    connectorsApi.fetchCapabilityConnectors.mockResolvedValue(response([LINEAR]));
    await renderTab();
    await vi.waitFor(() => expect(switchControl()).not.toBeNull());
    await act(async () => {
      client.setQueryData(
        KEY,
        response([{ ...LINEAR, state: "turned_off", reason: "turned_off", group: "turned_off" }]),
      );
    });
    await vi.waitFor(() => expect(switchControl()?.getAttribute("aria-checked")).toBe("false"));
  });
});
