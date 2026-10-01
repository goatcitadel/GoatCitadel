import { beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { inspectMcpServer } from "./mcp-server-inspection";
const api = vi.hoisted(() => ({ fetchMcpServer: vi.fn(), fetchMcpTools: vi.fn(), fetchMcpRemotePreview: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const server = (): McpServerRecord => ({ serverId: "server", revision: "a".repeat(64), label: "Fixture", transport: "stdio", command: "node", authType: "none", enabled: false,
  category: "development", trustTier: "restricted", costTier: "free", status: "disconnected", policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [] }, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" });
const tool = { serverId: "server", toolName: "read", enabled: true, updatedAt: "2026-09-30T00:00:00Z" };
beforeEach(() => { vi.resetAllMocks(); api.fetchMcpServer.mockResolvedValue(server()); api.fetchMcpTools.mockResolvedValue({ items: [tool] }); });
it("keeps cached descriptor truth and rereads the exact saved owner", async () => {
  expect(await inspectMcpServer("server")).toMatchObject({ server: server(), tools: [tool], issues: [] });
  expect(api.fetchMcpServer).toHaveBeenCalledTimes(2); expect(api.fetchMcpTools).toHaveBeenCalledExactlyOnceWith("server");
  expect(api.fetchMcpRemotePreview).not.toHaveBeenCalled();
});
it.each([{ items: [{ ...tool, serverId: "foreign" }] }, { items: [tool, tool] }])("withholds foreign or duplicated tool evidence", async ({ items }) => {
  api.fetchMcpTools.mockResolvedValue({ items }); const result = await inspectMcpServer("server");
  expect(result.tools).toBeUndefined(); expect(result.issues[0]).toContain("incomplete, duplicated or belongs to another server");
});
it("fails closed when the saved revision or exact selected identity changes during reads", async () => {
  api.fetchMcpServer.mockResolvedValueOnce(server()).mockResolvedValueOnce({ ...server(), revision: "b".repeat(64) });
  await expect(inspectMcpServer("server")).rejects.toThrow("changed during inspection");
  api.fetchMcpServer.mockResolvedValueOnce({ ...server(), serverId: "foreign" }); await expect(inspectMcpServer("server")).rejects.toThrow("mismatched");
});
it("keeps partial owner metadata when cached tools are unavailable", async () => {
  api.fetchMcpTools.mockRejectedValue(new Error("offline")); const result = await inspectMcpServer("server");
  expect(result.server.serverId).toBe("server"); expect(result.tools).toBeUndefined(); expect(result.issues[0]).toContain("Cached tools unavailable");
});
it("requires exact remote projection binding instead of rendering another server's diagnostics", async () => {
  api.fetchMcpServer.mockResolvedValue({ ...server(), transport: "http", url: "https://example.test/mcp" });
  api.fetchMcpRemotePreview.mockResolvedValue({ readOnly: true, mutationSemantics: "none", generatedAt: "2026-09-30T00:00:00Z", items: [{ source: "server", id: "other", blockers: ["foreign detail"] }] });
  const result = await inspectMcpServer("server"); expect(result.remote).toBeUndefined(); expect(result.issues[0]).toContain("does not match this saved server");
});
