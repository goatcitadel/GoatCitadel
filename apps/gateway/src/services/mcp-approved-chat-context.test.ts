import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError, type ApprovalRequest, type ChatToolRunRecord, type ChatTurnCapabilityProfileRecord,
  type PendingApprovalAction, type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import { readApprovedExternalChatProfile, readApprovedMcpChatProfile } from "./mcp-approved-chat-context.js";

function fixture(toolName = "mcp.invoke") {
  const request: ToolInvokeRequest = {
    toolName, agentId: "assistant", sessionId: "session", turnId: "turn", toolRunId: "tool-run",
    workspaceId: "workspace", citadelId: "citadel", runId: "run", surface: "chat",
    args: { serverId: "server", toolName: "echo", arguments: { message: "controlled" } },
    policyContext: { authActorId: "actor", authActorSource: "token" },
  };
  const profile = {
    profileId: "profile",
    identity: { turnId: "turn", sessionId: "session", workspaceId: "workspace", citadelId: "citadel",
      durableRunId: "run", authActorId: "actor", authActorSource: "token" },
    selection: { tools: [{ canonicalName: toolName }] },
    catalog: { snapshotId: "catalog", callableHash: "a".repeat(64) },
    hashes: { profileHash: "b".repeat(64) },
  } as ChatTurnCapabilityProfileRecord;
  const approval: ApprovalRequest = {
    approvalId: "approval", kind: "tool.invoke", riskLevel: "caution", status: "approved",
    payload: {}, preview: {}, createdAt: "2026-09-10T00:00:00.000Z", explanationStatus: "not_requested",
    linkage: { sessionId: "session", turnId: "turn", workspaceId: "workspace", durableRunId: "run",
      runId: "run", toolName, authActorId: "actor", authActorSource: "token" },
  };
  const tool = { toolRunId: "tool-run", sessionId: "session", turnId: "turn", toolName,
    args: request.args, status: "approval_required", approvalId: "approval" } as ChatToolRunRecord;
  const pending = { approvalId: "approval", actionType: "tool.invoke", resolutionStatus: "pending",
    request: { ...request }, createdAt: "2026-09-10T00:00:00.000Z" } as PendingApprovalAction;
  const storage = {
    pendingApprovalActions: { find: vi.fn(async () => pending) },
    approvals: { get: vi.fn(async () => approval) },
    chatToolRuns: { get: vi.fn(async () => tool) },
    chatTurnCapabilityProfiles: { findByTurn: vi.fn(async (): Promise<ChatTurnCapabilityProfileRecord | undefined> => profile) },
  };
  return { request, profile, approval, tool, pending, storage,
    read: () => readApprovedExternalChatProfile(storage as unknown as Parameters<typeof readApprovedExternalChatProfile>[0], "approval", request) };
}

describe.each(["mcp.invoke", "mcp.server.with.dots.tool.echo", "mesh:node-a:tool:project.status", "mesh:node-a:mcp_server:project"])(
  "external runtime identity from a canonical Chat approval (%s)", (canonicalName) => {
  it("retains the exact target and reviewed edits through the canonical approval join", async () => {
    const f = fixture(canonicalName);
    f.approval.status = "edited";
    f.request.args = { value: "reviewed", serverId: "native data" };
    f.pending.request.args = f.request.args;
    expect(await f.read()).toBe(f.profile);
    f.approval.linkage!.toolName = "another.target";
    expect(await f.read()).toBeUndefined();
  });
  it("returns only the profile joined to the stored pending action, approval and Chat tool run", async () => {
    const f = fixture(canonicalName);
    expect(await f.read()).toBe(f.profile);
    expect(f.storage.pendingApprovalActions.find).toHaveBeenCalledExactlyOnceWith("approval");
    expect(f.storage.chatTurnCapabilityProfiles.findByTurn).toHaveBeenCalledExactlyOnceWith("turn");
    expect(f.storage.chatToolRuns.get).toHaveBeenCalledExactlyOnceWith("tool-run");
    expect(f.storage.approvals.get).toHaveBeenCalledExactlyOnceWith("approval");
  });

  it("preserves an operator-edited argument without replacing the frozen requester identity", async () => {
    const f = fixture(canonicalName);
    f.approval.status = "edited";
    f.pending.request = { ...f.pending.request, args: { ...f.request.args, arguments: { message: "reviewed edit" } } };
    f.request.args = f.pending.request.args as Record<string, unknown>;
    expect(await f.read()).toBe(f.profile);
  });

  const mismatches: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["actor", (f) => { f.profile.identity.authActorId = "another"; }],
    ["actor source", (f) => { f.profile.identity.authActorSource = "device"; }],
    ["workspace", (f) => { f.profile.identity.workspaceId = "another"; }],
    ["session", (f) => { f.profile.identity.sessionId = "another"; }],
    ["turn", (f) => { f.profile.identity.turnId = "another"; }],
    ["Citadel", (f) => { f.profile.identity.citadelId = "another"; }],
    ["durable run", (f) => { f.profile.identity.durableRunId = "another"; }],
    ["approval actor", (f) => { f.approval.linkage!.authActorId = "another"; }],
    ["approval tool", (f) => { f.approval.linkage!.toolName = "another"; }],
    ["approval turn", (f) => { f.approval.linkage!.turnId = "another"; }],
    ["approval run", (f) => { f.approval.linkage!.runId = "another"; }],
    ["tool run", (f) => { f.tool.toolRunId = "another"; }],
    ["tool approval", (f) => { f.tool.approvalId = "another"; }],
    ["tool status", (f) => { f.tool.status = "executed"; }],
    ["selected tool", (f) => { f.profile.selection.tools = []; }],
    ["retained arguments", (f) => { f.pending.request.args = { serverId: "another", toolName: "echo" }; }],
    ["retained actor", (f) => { f.pending.request.policyContext = { authActorId: "another", authActorSource: "token" }; }],
    ["settled action", (f) => { f.pending.resolutionStatus = "executed"; }],
    ["rejected approval", (f) => { f.approval.status = "rejected"; }],
    ["unresolved approval", (f) => { f.approval.status = "pending"; }],
    ["missing actor", (f) => { delete f.profile.identity.authActorId; }],
    ["missing linkage", (f) => { delete f.approval.linkage; }],
  ];
  it.each(mismatches)("does not restore context after a change to %s", async (_name, change) => {
    const f = fixture(canonicalName);
    change(f);
    expect(await f.read()).toBeUndefined();
  });

  it("does not promote request-shaped context for a direct approval without Chat linkage", async () => {
    const f = fixture(canonicalName);
    delete f.request.turnId;
    f.request.args.mcpRequesterTurnContext = { profileId: "profile", actorId: "actor" };
    expect(await f.read()).toBeUndefined();
    expect(f.storage.pendingApprovalActions.find).not.toHaveBeenCalled();
  });

  it("keeps a missing profile closed and propagates unavailable or corrupt storage", async () => {
    const f = fixture(canonicalName);
    f.storage.chatTurnCapabilityProfiles.findByTurn.mockResolvedValueOnce(undefined);
    expect(await f.read()).toBeUndefined();
    f.storage.chatToolRuns.get.mockRejectedValueOnce(new NotFoundError({ entity: "tool run", id: "tool-run" }));
    expect(await f.read()).toBeUndefined();
    f.storage.chatTurnCapabilityProfiles.findByTurn.mockRejectedValueOnce(new Error("profile integrity failure"));
    await expect(f.read()).rejects.toThrow("profile integrity failure");
  });
});

it("keeps the MCP-only context entry point closed for a mesh approval", async () => {
  const f = fixture("mesh:node-a:tool:project.status");
  expect(await readApprovedMcpChatProfile(
    f.storage as unknown as Parameters<typeof readApprovedMcpChatProfile>[0], "approval", f.request,
  )).toBeUndefined();
  expect(f.storage.pendingApprovalActions.find).not.toHaveBeenCalled();
});
