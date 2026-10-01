import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetMcpServerMutationsForTests, commitMcpServerUpdate } from "./mcp-server-mutation";
const api = vi.hoisted(() => ({ fetchMcpServer: vi.fn(), updateMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
const server = (patch: Partial<McpServerRecord> = {}): McpServerRecord => ({
  serverId: "review-server",
  revision: "a".repeat(64),
  label: "Review server",
  transport: "stdio",
  command: "node",
  authType: "none",
  enabled: false,
  status: "disconnected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "strict",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
    allowedEnvKeys: [],
  },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  ...patch,
});
const commit = (isCurrent = () => true) =>
  commitMcpServerUpdate({ reviewed: server(), input: { expectedRevision: "a".repeat(64), enabled: true }, isCurrent });
const failure = (body: Record<string, unknown>, path = "/api/v1/mcp/servers/review-server") =>
  new ApiRequestError("Synthetic conflict", {
    kind: "http",
    method: "PATCH",
    path,
    status: 409,
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpServerMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in MCP tests");
    }),
  );
  api.fetchMcpServer.mockResolvedValue(server());
  api.updateMcpServer.mockResolvedValue(server({ revision: "b".repeat(64), enabled: true }));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("shared MCP update owner", () => {
  it("saves reviewed arguments and the full normalized policy without changing authentication or trust", async () => {
    const policy = { requireFirstToolApproval: false, redactionMode: "basic" as const, allowedToolPatterns: ["read.*"], blockedToolPatterns: ["write.*"], allowedEnvKeys: ["MCP_CONFIG"], notes: "Reviewed policy" };
    api.updateMcpServer.mockResolvedValue(server({ revision: "b".repeat(64), args: ["path with spaces", "--readonly"], policy }));
    const input = { expectedRevision: "a".repeat(64), args: ["path with spaces", "--readonly"], policy };
    expect((await commitMcpServerUpdate({ reviewed: server(), input, isCurrent: () => true })).status).toBe("saved");
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("review-server", input);
  });
  it("keeps uncertainty when an argument or policy receipt differs from the exact reviewed configuration", async () => {
    api.updateMcpServer.mockResolvedValue(server({ revision: "b".repeat(64), args: ["different"] }));
    expect((await commitMcpServerUpdate({ reviewed: server(), input: { expectedRevision: "a".repeat(64), args: ["reviewed"] }, isCurrent: () => true })).status).toBe("uncertain");
  });
  it("rereads the exact server then sends only enabled metadata with owner CAS", async () => {
    expect((await commit()).status).toBe("saved");
    expect(api.fetchMcpServer).toHaveBeenCalledExactlyOnceWith("review-server");
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("review-server", {
      expectedRevision: "a".repeat(64),
      enabled: true,
    });
  });
  it("withholds a changed owner revision", async () => {
    api.fetchMcpServer.mockResolvedValue(server({ revision: "b".repeat(64) }));
    expect((await commit()).status).toBe("conflict");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("rechecks current trust eligibility before enabling even when the opaque revision is unchanged", async () => {
    api.fetchMcpServer.mockResolvedValue(server({ trustTier: "quarantined" }));
    expect((await commit()).status).toBe("conflict");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("cancels when the editor lifecycle changes during preflight", async () => {
    let current = true;
    api.fetchMcpServer.mockImplementation(async () => {
      current = false;
      return server();
    });
    expect((await commit(() => current)).status).toBe("cancelled");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    expect((await commit()).status).toBe("saved");
  });
  it("permits a fresh attempt after an owner read fails before mutation", async () => {
    api.fetchMcpServer.mockRejectedValueOnce(new Error("read failed"));
    expect((await commit()).status).toBe("unavailable");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    expect((await commit()).status).toBe("saved");
  });
  it("permits explicit review after the exact owner rejects stale CAS", async () => {
    api.updateMcpServer.mockRejectedValueOnce(
      failure({ code: "WRITE_CONFLICT", details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } }),
    );
    expect((await commit()).status).toBe("conflict");
    expect((await commit()).status).toBe("saved");
  });
  it.each([
    new Error("lost reply"),
    failure({ code: "WRITE_CONFLICT", details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } }, "/different-request"),
    failure({ code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } }),
    failure({ code: "WRITE_CONFLICT", details: { reason: "MCP_SERVER_REVIEW_REQUIRED", mutationCommitted: true } }),
  ])("retains a per-server lock after an unknown or committed outcome", async (error) => {
    api.updateMcpServer.mockRejectedValueOnce(error);
    expect((await commit()).status).toBe("uncertain");
    expect((await commit()).status).toBe("locked");
    expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
  });
  it.each([
    { enabled: false },
    { serverId: "foreign-server" },
    { revision: "a".repeat(64) },
    { command: "substituted" },
  ])("requires exact saved acknowledgement: %o", async (patch) => {
    api.updateMcpServer.mockResolvedValue(server({ revision: "b".repeat(64), enabled: true, ...patch }));
    expect((await commit()).status).toBe("uncertain");
  });
  it("blocks Gateway-owned records", async () => {
    const reviewed = server({ serverId: "goatcitadel-internal-durable-tasks" });
    expect(
      (
        await commitMcpServerUpdate({
          reviewed,
          input: { expectedRevision: reviewed.revision!, enabled: true },
          isCurrent: () => true,
        })
      ).status,
    ).toBe("cancelled");
    expect(api.fetchMcpServer).not.toHaveBeenCalled();
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
});
