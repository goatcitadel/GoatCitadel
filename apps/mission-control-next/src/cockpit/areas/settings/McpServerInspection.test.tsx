// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerInspection } from "./McpServerInspection";

type ButtonRender = (label: string, click: () => void, disabled: boolean) => ReactNode;
const api = vi.hoisted(() => ({ inspectMcpServer: vi.fn() }));
vi.mock("../../../features/native-routes/settings/mcp-server-inspection", () => api);
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock("../../ui/ClassicOwnerLink", () => ({ ClassicOwnerLink: () => null }));
vi.mock("../../../features/native-routes/settings/McpConfigurationReport", () => ({
  McpConfigurationReport: () => null,
}));
vi.mock("../../../features/native-routes/settings/McpConnectionControls", () => ({
  McpConnectionControls: ({ button }: { button: ButtonRender }) => (
    <>{button("Test connection", () => undefined, false)}</>
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
});
