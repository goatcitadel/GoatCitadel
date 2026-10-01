// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import type { Dialog } from "../../ui/Dialog";
import type { Sheet } from "../../ui/Sheet";
import { McpServersSettings } from "./McpServersSettings";
import { __resetMcpServerMutationsForTests } from "../../../features/native-routes/settings/mcp-server-mutation";
import { __resetMcpCreationForTests } from "../../../features/native-routes/settings/mcp-create-mutation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
const api = vi.hoisted(() => ({ fetchMcpServer: vi.fn(), fetchMcpServers: vi.fn(), fetchMcpTemplates: vi.fn(), createMcpServer: vi.fn(), deleteMcpServer: vi.fn(), fetchMcpTools: vi.fn(), fetchMcpRemotePreview: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: ComponentProps<typeof Dialog>) => open ? <section aria-label={title}>{children}</section> : null }));
vi.mock("../../ui/Sheet", () => ({ Sheet: ({ open, title, children }: ComponentProps<typeof Sheet>) => open ? <section aria-label={title}>{children}</section> : null }));
const fixture = (): McpServerRecord => ({ serverId: "saved-server", revision: "a".repeat(64), label: "Existing MCP", transport: "stdio", command: "node", args: ["--version"],
  authType: "none", enabled: false, status: "disconnected", category: "development", trustTier: "restricted", costTier: "free",
  policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: ["read.*"], blockedToolPatterns: [], allowedEnvKeys: [] },
  createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" });
let records: McpServerRecord[], root: Root, container: HTMLDivElement, client: QueryClient;
const button = (name: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === name || node.getAttribute("aria-label") === name)!;
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); await settle(); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render(workspaceId = "workspace") {
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><McpServersSettings key={workspaceId} workspaceId={workspaceId} /></QueryClientProvider></StrictMode>));
  await vi.waitFor(() => expect(container.textContent).toContain("Existing MCP")); await settle();
}
beforeEach(() => {
  vi.resetAllMocks(); __resetMcpServerMutationsForTests(); __resetMcpCreationForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  records = [fixture()];
  api.fetchMcpServers.mockImplementation(async () => ({ items: structuredClone(records) }));
  api.fetchMcpServer.mockImplementation(async (id: string) => {
    const server = records.find((item) => item.serverId === id);
    if (!server) throw new ApiRequestError("Missing", { kind: "http", method: "GET", path: `/api/v1/mcp/servers/${id}`, status: 404, body: { code: "ENTITY_NOT_FOUND" } });
    return structuredClone(server);
  });
  api.fetchMcpTemplates.mockResolvedValue({ items: [{ ...fixture(), templateId: "fixture-template", label: "Read-only fixture", description: "Disabled local metadata fixture", enabledByDefault: false, installed: false }] });
  api.createMcpServer.mockImplementation(async (input) => {
    const server = { ...fixture(), ...input, serverId: "new-server", revision: "b".repeat(64) };
    records.push(server); return structuredClone(server);
  });
  api.deleteMcpServer.mockImplementation(async (id: string) => { records = records.filter((item) => item.serverId !== id); return { deleted: true }; });
  api.fetchMcpTools.mockResolvedValue({ items: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

describe("native MCP registration and deletion", () => {
  it("reviews template arguments and policy, cancels without writes, and confirms the exact saved registration", async () => {
    await render(); await click("Register MCP server"); await click("Use Read-only fixture template"); await click("Review MCP registration");
    expect(container.textContent).toContain("--version"); expect(container.textContent).toContain("read.*"); expect(container.textContent).toContain("No connection, process launch");
    await click("Cancel registration review"); expect(api.createMcpServer).not.toHaveBeenCalled();
    await click("Review MCP registration"); await click("Register reviewed MCP server");
    expect(api.createMcpServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ label: "Read-only fixture", args: ["--version"], enabled: false,
      category: "development", trustTier: "restricted", costTier: "free", policy: expect.objectContaining({ requireFirstToolApproval: true, allowedToolPatterns: ["read.*"] }) }));
    expect(api.fetchMcpServer).toHaveBeenCalledWith("new-server"); expect(container.textContent).toContain("registered and saved configuration confirmed");
  });
  it("withholds direct leave saving until the registration fields are reviewed", async () => {
    await render(); await click("Register MCP server"); await click("Use Read-only fixture template"); await click("Close registration");
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeTruthy(); expect(button("Save and continue")).toBeUndefined();
    expect(api.createMcpServer).not.toHaveBeenCalled(); await click("Cancel"); expect(api.createMcpServer).not.toHaveBeenCalled();
  });
  it.each([
    new Error("response lost"),
    new ApiRequestError("Committed follow-up failed", { kind: "http", method: "POST", path: "/api/v1/mcp/servers", status: 500,
      body: { error: "The MCP configuration change was committed, but follow-up failed. Inspect the saved owner before another change.", mutationCommitted: true } }),
  ])("retains uncertain creation through native close and another workspace (%#)", async failure => {
    await render(); await click("Register MCP server"); await click("Use Read-only fixture template"); await click("Review MCP registration");
    api.createMcpServer.mockRejectedValueOnce(failure); await click("Register reviewed MCP server");
    expect(container.textContent).toContain("registration outcome is unconfirmed"); await render("other-workspace"); await click("Register MCP server");
    expect(button("Review MCP registration").disabled).toBe(true); expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  });
  it("cancels deletion, rejects a changed owner, then requires a separate fresh deletion review", async () => {
    await render(); await click("Review delete Existing MCP"); await click("Keep MCP server"); expect(api.deleteMcpServer).not.toHaveBeenCalled();
    await click("Review delete Existing MCP"); records[0] = { ...records[0]!, revision: "b".repeat(64) };
    await click("Delete reviewed MCP server"); expect(api.deleteMcpServer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(button("Review delete Existing MCP").disabled).toBe(false)); await click("Review delete Existing MCP");
    await click("Delete reviewed MCP server"); expect(api.deleteMcpServer).toHaveBeenCalledExactlyOnceWith("saved-server", "b".repeat(64));
    expect(container.textContent).not.toContain("Existing MCP");
  });
  it("shows bounded cached tools without calling transport or tool execution owners", async () => {
    api.fetchMcpTools.mockResolvedValue({ items: Array.from({ length: 45 }, (_, index) => ({ serverId: "saved-server", toolName: `cached-${index}`, enabled: true, description: "Recorded tool", updatedAt: "2026-09-30T00:00:00Z" })) });
    await render(); await click("Inspect Existing MCP"); await vi.waitFor(() => expect(container.textContent).toContain("Showing 30 of 45 cached descriptors."));
    expect(container.textContent).not.toContain("cached-44"); await click("Show more cached tools"); expect(container.textContent).toContain("cached-44");
    expect(api.fetchMcpRemotePreview).not.toHaveBeenCalled(); expect(api.createMcpServer).not.toHaveBeenCalled(); expect(api.deleteMcpServer).not.toHaveBeenCalled();
  });
});
