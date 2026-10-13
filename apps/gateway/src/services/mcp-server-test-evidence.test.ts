import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type McpServerRecord,
  type McpToolRecord,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import { buildStaticMcpAdmissionReceipt, staticAdmissionDigest as hash } from "./mcp-static-admission.js";
import { createStaticMcpCatalogSnapshot } from "./mcp-static-catalog.js";
import { normalizeMcpRequesterDiscoveryOutput } from "./mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { readMcpServerTestEvidence, type McpTestEvidenceHost } from "./mcp-server-test-evidence.js";

function fixture() {
  const requestContent = { content: "PRIVATE PROMPT MUST NOT BE PROJECTED" };
  const materialSha256 = hash({ version: 2, request: requestContent });
  const scope: McpRequesterAdmissionScope = {
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    aggregateRevision: 1,
    controllerGeneration: 1,
    materialSha256,
    actorId: "actor",
    actorSource: "token",
  };
  const server = {
    serverId: "server",
    revision: "a".repeat(64),
    connectionRevision: "b".repeat(64),
    configurationBindingId: "11111111-1111-4111-8111-111111111111",
    transport: "http",
    enabled: true,
    status: "connected",
  } as McpServerRecord;
  const catalog = normalizeMcpRequesterDiscoveryOutput(
    "server",
    { tools: [{ rawRemoteToolName: "read", canonicalToolName: "mcp.server.read", inputSchema: { type: "object" } }] },
    createMcpRequesterDiscoverySecretScanner(),
  );
  const selected = buildStaticMcpAdmissionReceipt(scope, server, createStaticMcpCatalogSnapshot(server, catalog), [
    "mcp.server.read",
  ]);
  const references = { version: "chat.turn.feature-references.v1", selectedStaticMcp: [selected] };
  const binding = { references, referenceSha256: hash(references) };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: scope.admissionId,
    sessionIncarnationId: scope.sessionIncarnationId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256: materialSha256,
    effectiveRequestMaterialSha256: hash({
      version: 1,
      admissionMaterialSha256: materialSha256,
      request: requestContent,
    }),
    requestActor: {
      actorKind: "operator",
      actorId: "actor",
      operatorId: "actor",
      authActorId: "actor",
      authActorSource: "token",
    },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    featureReferenceSha256: binding.referenceSha256,
    request: requestContent,
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", status: "completed", payload };
  const result = { contentText: "PRIVATE TOOL RESULT MUST NOT BE PROJECTED" };
  const tool = {
    toolRunId: "tool",
    turnId: "turn",
    sessionId: "session",
    toolName: "mcp.server.read",
    status: "executed",
    approvalId: "approval",
    finishedAt: "2026-10-11T00:00:00Z",
    effectOutcomeKind: "concrete",
    effectEvidence: {
      version: "goatcitadel.tool-effect.v1",
      outcomeKind: "concrete",
      reason: "canonical_effect_receipt_linked",
      refs: [{ owner: "external_side_effect", refId: "effect" }],
    },
    result,
  };
  const pending = {
    approvalId: "approval",
    actionType: "tool.invoke",
    resolutionStatus: "executed",
    request: {
      toolRunId: "tool",
      runId: "run",
      sessionId: "session",
      turnId: "turn",
      toolName: tool.toolName,
      workspaceId: "workspace",
      policyContext: { authActorId: "actor", authActorSource: "token" },
    },
    result: { outcome: "executed", result },
  };
  const approval = {
    approvalId: "approval",
    status: "approved",
    linkage: {
      runId: "run",
      durableRunId: "distinct-wait-run",
      sessionId: "session",
      turnId: "turn",
      toolName: tool.toolName,
      workspaceId: "workspace",
      authActorId: "actor",
      authActorSource: "token",
    },
  };
  const effect = {
    runId: "effect",
    status: "completed",
    workspaceId: "workspace",
    actionId: "approval",
    catalogId: tool.toolName,
    completedAt: tool.finishedAt,
    responsePayload: structuredClone(pending.result),
  };
  const tools = [
    { serverId: "server", toolName: "read", enabled: true, inputSchema: { type: "object" } },
  ] as McpToolRecord[];
  const storage = {
    durableRuns: { listRunHistory: vi.fn(async () => ({ items: [run] })) },
    sessionMutationAdmissions: {
      findFeatureReferences: vi.fn(async () => binding),
      findDurableRunBinding: vi.fn(async () => ({ durableRunId: "run" })),
    },
    chatTurnTraces: {
      get: vi.fn(async () => ({ sessionId: "session", status: "completed", durable: { runId: "run" } })),
    },
    chatToolRuns: { listByTurnPage: vi.fn(async () => [tool]) },
    approvals: { get: vi.fn(async () => approval) },
    pendingApprovalActions: { find: vi.fn(async () => pending) },
    externalSideEffectRuns: { findByIdempotency: vi.fn(async () => effect) },
  };
  const host = {
    storage,
    readServer: vi.fn(async () => server),
    readTools: vi.fn(async () => tools),
  } as unknown as McpTestEvidenceHost;
  return { host, storage, server, scope, run, tool, approval, pending, effect, tools, binding };
}

describe("retained MCP tested evidence", () => {
  it("projects only exact successful approved evidence, preserving distinct approval-wait ownership and bounded searches", async () => {
    const f = fixture();
    const result = await readMcpServerTestEvidence(f.host, "server", f.scope);
    expect(result).toMatchObject({
      state: "verified",
      schemaSource: "cached_inventory",
      receipt: {
        toolRunId: "tool",
        effectRunId: "effect",
        durableRunId: "run",
        chatHref: "/chat?workspaceId=workspace&sessionId=session&turnId=turn",
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.storage.durableRuns.listRunHistory).toHaveBeenCalledWith({ workspaceId: "workspace", limit: 32 });
    expect(f.storage.chatToolRuns.listByTurnPage).toHaveBeenCalledWith("turn", undefined, 32);
  });
  it.each(["actor", "source", "workspace"])("does not disclose another %s's receipt", async (kind) => {
    const f = fixture();
    const scope = { ...f.scope };
    if (kind === "actor") scope.actorId = "other";
    else if (kind === "source") scope.actorSource = "basic";
    else scope.workspaceId = "other";
    const result = await readMcpServerTestEvidence(f.host, "server", scope);
    expect(result.state).toBe("unverified");
    expect(result.receipt).toBeUndefined();
    expect(f.storage.sessionMutationAdmissions.findFeatureReferences).not.toHaveBeenCalled();
  });
  it.each(["server", "configuration", "connection", "schema"])(
    "marks a succeeded receipt stale after %s drift",
    async (kind) => {
      const f = fixture();
      if (kind === "server") f.server.revision = "c".repeat(64);
      else if (kind === "configuration") f.server.configurationBindingId = "new";
      else if (kind === "connection") f.server.connectionRevision = "c".repeat(64);
      else f.tools[0]!.inputSchema = { type: "object", required: ["new"] };
      const evidence = await readMcpServerTestEvidence(f.host, "server", f.scope);
      expect(evidence.state).toBe("stale");
      expect(evidence.receipt).toBeUndefined();
    },
  );
  it.each(["run", "approval", "tool", "effect", "uncertain", "receipt", "binding", "pending"])(
    "never verifies non-success or mismatched %s evidence",
    async (kind) => {
      const f = fixture();
      if (kind === "run") f.run.status = "waiting";
      else if (kind === "approval") f.approval.status = "edited";
      else if (kind === "tool") f.tool.status = "approval_required";
      else if (kind === "effect") f.effect.status = "unknown_after_send";
      else if (kind === "uncertain") f.tool.effectEvidence.outcomeKind = "uncertain";
      else if (kind === "receipt") f.effect.responsePayload.result.contentText = "different";
      else if (kind === "binding") f.binding.referenceSha256 = "0".repeat(64);
      else f.pending.request.runId = "wrong";
      expect((await readMcpServerTestEvidence(f.host, "server", f.scope)).state).toBe("unverified");
    },
  );
  it("rechecks generation after awaited history reads and preserves unavailable failures", async () => {
    const f = fixture();
    vi.mocked(f.host.readServer)
      .mockResolvedValueOnce({ ...f.server })
      .mockResolvedValue({ ...f.server, connectionRevision: "c".repeat(64) });
    expect((await readMcpServerTestEvidence(f.host, "server", f.scope)).state).toBe("stale");
    f.storage.durableRuns.listRunHistory.mockRejectedValueOnce(new Error("PRIVATE storage error"));
    const failed = await readMcpServerTestEvidence(f.host, "server", f.scope);
    expect(failed.state).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("PRIVATE");
  });
  it("skips a pruned approval before a valid retained receipt and treats a pruned trace as unverified", async () => {
    const f = fixture();
    f.storage.chatToolRuns.listByTurnPage.mockResolvedValue([
      { ...f.tool, toolRunId: "older", approvalId: "pruned" },
      f.tool,
    ]);
    f.storage.approvals.get.mockRejectedValueOnce(new NotFoundError({ entity: "Approval", id: "pruned" }));
    expect((await readMcpServerTestEvidence(f.host, "server", f.scope)).state).toBe("verified");
    f.storage.chatTurnTraces.get.mockRejectedValueOnce(new NotFoundError({ entity: "Chat turn", id: "turn" }));
    expect((await readMcpServerTestEvidence(f.host, "server", f.scope)).state).toBe("unverified");
  });
  it("rechecks cached schemas after retained joins", async () => {
    const f = fixture();
    vi.mocked(f.host.readTools)
      .mockResolvedValueOnce(f.tools)
      .mockResolvedValue([{ ...f.tools[0]!, inputSchema: { type: "object", required: ["changed"] } }]);
    expect((await readMcpServerTestEvidence(f.host, "server", f.scope)).state).toBe("stale");
  });
  it("caps overall receipt joins and reports a truncated search without asserting no historical test exists", async () => {
    const f = fixture();
    f.storage.chatToolRuns.listByTurnPage.mockResolvedValue(
      Array.from({ length: 32 }, (_, index) => ({ ...f.tool, toolRunId: `different-${index}` })),
    );
    const evidence = await readMcpServerTestEvidence(f.host, "server", f.scope);
    expect(evidence).toMatchObject({ state: "unverified", searchTruncated: true, receiptCandidateLimit: 8 });
    expect(f.storage.approvals.get).toHaveBeenCalledTimes(8);
    expect(f.storage.externalSideEffectRuns.findByIdempotency).not.toHaveBeenCalled();
  });
  it("stops before additional retained reads when the inspection read budget expires", async () => {
    const f = fixture();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    f.storage.durableRuns.listRunHistory.mockImplementation(async () => {
      now = 2_001;
      return { items: [f.run] };
    });
    try {
      expect(await readMcpServerTestEvidence(f.host, "server", f.scope)).toMatchObject({
        state: "unverified",
        searchTruncated: true,
      });
      expect(f.storage.sessionMutationAdmissions.findFeatureReferences).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
