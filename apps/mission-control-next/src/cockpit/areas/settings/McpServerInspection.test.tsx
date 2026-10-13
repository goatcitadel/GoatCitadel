// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerInspection } from "./McpServerInspection";

type ButtonRender = (label: string, click: () => void, disabled: boolean) => ReactNode;
const api = vi.hoisted(() => ({ inspectMcpServer: vi.fn(), fetchSettings: vi.fn(), fetchMcpServerTestEvidence: vi.fn() }));
vi.mock("../../../features/native-routes/settings/mcp-server-inspection", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchSettings: api.fetchSettings, fetchMcpServerTestEvidence: api.fetchMcpServerTestEvidence }));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock("../../ui/ClassicOwnerLink", () => ({ ClassicOwnerLink: () => null }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("../../../features/native-routes/settings/McpConfigurationReport", () => ({
  McpConfigurationReport: () => null,
}));
vi.mock("../../../features/native-routes/settings/McpConnectionControls", () => ({
  McpConnectionControls: ({ button, onSettled }: { button: ButtonRender; onSettled: () => Promise<unknown> }) => (
    <>{button("Test connection", () => void onSettled(), false)}</>
  ),
}));
vi.mock("../../../features/native-routes/settings/McpOAuthControls", () => ({ McpOAuthControls: () => null }));

const inspection = {
  server: {
    serverId: "server-a",
    label: "Files server",
    revision: "rev-1",
    enabled: true,
    status: "connected",
    transport: "stdio",
    trustTier: "trusted",
    authType: "none",
  },
  issues: [],
  tools: [],
};
let root: Root, container: HTMLDivElement, client: QueryClient;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;

beforeEach(() => {
  api.inspectMcpServer.mockReset().mockResolvedValue(inspection);
  api.fetchSettings.mockReset().mockResolvedValue({ chatFeatureAvailability: { staticMcp: false } });
  api.fetchMcpServerTestEvidence.mockReset().mockResolvedValue({ serverId: "server-a", workspaceId: "w", state: "unverified", historyLimit: 32, toolLimitPerTurn: 32 });
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

describe("MCP server inspection", () => {
  it("keeps the inspection and its controls, disabled, while it is read again, and beside a failed read", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <McpServerInspection serverId="server-a" workspaceId="w" onClose={() => undefined} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Files server"));
    expect(container.textContent).toContain("Static MCP in Chat is disabled");
    expect(button("Test connection").disabled).toBe(false);
    let release!: () => void;
    api.inspectMcpServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(inspection);
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).not.toContain("Reading current server and cached inventory…");
    expect(container.textContent).toContain("Files server");
    expect(button("Test connection").disabled).toBe(true);
    await act(async () => release());
    await vi.waitFor(() => expect(button("Test connection").disabled).toBe(false));
    api.inspectMcpServer.mockRejectedValueOnce(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Files server");
    expect(container.textContent).toContain("Showing the last version from");
  });

  it("projects failed availability as unknown without discarding server inspection", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <McpServerInspection serverId="server-a" workspaceId="w" onClose={() => undefined} />
    </QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Static MCP in Chat is disabled"));
    api.fetchSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
    await act(async () => button("Refresh Chat availability").click());
    await vi.waitFor(() => expect(container.textContent).toContain("availability in Chat is unverified"));
    expect(container.textContent).toContain("Files server");
    expect(button("Test connection").disabled).toBe(false);
  });

  it("refreshes the existing server list after connection settlement instead of leaving its recorded state behind", async () => {
    const key = ["settings", "mcp-servers"];
    client.setQueryData(key, { items: [{ ...inspection.server, status: "disconnected" }] });
    const readServers = vi.fn(async () => ({ items: [inspection.server] }));
    const observer = new QueryObserver(client, { queryKey: key, queryFn: readServers, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await act(async () => root.render(<QueryClientProvider client={client}>
        <McpServerInspection serverId="server-a" workspaceId="w" onClose={() => undefined} />
      </QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Files server"));
      expect(readServers).not.toHaveBeenCalled();
      await act(async () => button("Test connection").click());
      await vi.waitFor(() => expect(readServers).toHaveBeenCalledOnce());
      expect(client.getQueryData(key)).toEqual({ items: [inspection.server] });
      expect(api.inspectMcpServer).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });
});
