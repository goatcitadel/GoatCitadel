import type {
  McpServerRecord,
  McpTestAllowanceRequest,
  McpToolRecord,
  ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { LocalMcpFixtureTestService } from "./local-mcp-fixture-test.js";

const serverId = "11111111-1111-4111-8111-111111111111";
const toolName = "feature_quality_read";
const sessionId = "sess_123abc";
const workspaceId = "default";
const actorId = "operator";
const serverRevision = "a".repeat(64);
const connectionRevision = "b".repeat(64);

const selection: McpTestAllowanceRequest = {
  serverId,
  serverRevision,
  connectionRevision,
  workspaceId,
  sessionId,
  toolName,
};
const request: ToolAccessEvaluateRequest = {
  agentId: "assistant",
  toolName: `mcp.${serverId}.${toolName}`,
  workspaceId,
  sessionId,
  surface: "chat",
  policyContext: { authActorId: actorId, authActorSource: "token" },
};

function fixture() {
  const server = {
    serverId,
    url: "http://127.0.0.1:61000/mcp",
    revision: serverRevision,
    connectionRevision,
    status: "connected",
    configurationBindingId: "fixture",
    enabled: true,
    transport: "http",
    authType: "none",
    trustTier: "restricted",
    policy: { requireFirstToolApproval: true, allowedToolPatterns: [toolName] },
  } as McpServerRecord;
  const tool = {
    serverId,
    toolName,
    enabled: true,
    annotations: { readOnlyHint: true, destructiveHint: false },
  } as McpToolRecord;
  const port = {
    available: vi.fn(() => true),
    readServers: vi.fn(async () => [server]),
    readTools: vi.fn(async () => [tool]),
    readSession: vi.fn(async () => ({ workspaceId, lifecycleStatus: "active" as const })),
  };
  return { port, server, tool, service: new LocalMcpFixtureTestService(port) };
}

afterEach(() => vi.useRealTimers());

it("admits only the selected argument-free tool in the operator's signed-in Chat", async () => {
  const { service } = fixture();
  expect(await service.matches(request, serverId)).toBe(false);
  await service.activate(actorId, selection);
  expect(await service.matches(request, serverId)).toBe(true);
  for (const change of [
    { sessionId: "sess_other" },
    { workspaceId: "another-workspace" },
    { surface: "tools" as const },
    { policyContext: { authActorId: actorId, authActorSource: "loopback" as const } },
    { policyContext: { authActorId: "other", authActorSource: "token" as const } },
    { toolName: "mcp.invoke" },
    { args: { unexpected: "value" } },
  ]) {
    expect(await service.matches({ ...request, ...change }, serverId)).toBe(false);
  }
});

it("fails closed after connector revision changes, lost read-only evidence, or expiry", async () => {
  vi.useFakeTimers();
  const { service, port, server, tool } = fixture();
  const allowance = await service.activate(actorId, selection);
  port.readServers.mockResolvedValueOnce([{ ...server, connectionRevision: "c".repeat(64) }]);
  expect(await service.matches(request, serverId)).toBe(false);
  port.readTools.mockResolvedValueOnce([{ ...tool, annotations: { readOnlyHint: true, destructiveHint: true } }]);
  expect(await service.matches(request, serverId)).toBe(false);
  vi.setSystemTime(new Date(allowance.expiresAt));
  expect(await service.matches(request, serverId)).toBe(false);
  expect((await service.status(actorId)).allowance).toBeNull();
});

it("rejects stale selections and overlapping activation, and honors only the owner's revocation", async () => {
  const { service } = fixture();
  await expect(service.activate(actorId, { ...selection, workspaceId: "other" })).rejects.toThrow(/active Chat/);
  await expect(service.activate(actorId, { ...selection, serverRevision: "c".repeat(64) })).rejects.toThrow(/eligible/);
  const results = await Promise.allSettled([
    service.activate(actorId, selection),
    service.activate(actorId, selection),
  ]);
  expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  const { allowance } = await service.status(actorId);
  expect(allowance).not.toBeNull();
  expect(service.revoke("another actor", allowance!.allowanceId)).toBe(false);
  expect(service.revoke(actorId, allowance!.allowanceId)).toBe(true);
  expect(await service.matches(request, serverId)).toBe(false);
});
