import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatTurnFeatureReferences,
  type ToolInvokeRequest,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  readApprovedRequesterAdmission,
  materializeRequesterAdmissionApproval,
  resumeAdmittedExternalApprovals,
} from "./mcp-requester-admission-approval.js";
import {
  createMcpRequesterAdmissionConnection,
  type McpRequesterAdmissionCurrentState,
} from "./mcp-requester-admission-authority.js";
import { createMcpRequesterAdmissionTurnContext } from "./mcp-requester-admission-context.js";
import { normalizeMcpRequesterDiscoveryOutput } from "./mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { createMeshChatCatalogFixture } from "./gateway/mesh-chat-catalog-test-fixtures.js";
import { resolveMeshChatToolSchemas } from "./gateway/mesh-chat-catalog.js";
import { createMeshAdmissionTurnContext } from "./gateway/mesh-chat-binding.js";
import { buildSelectedMeshAdmission } from "./chat-mesh-admission-service.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture(mode: "requester" | "static" = "requester", delegated = false) {
  const requestContent = {
    content: "Search notes",
    ...(delegated ? { parentDelegationStepId: "step", policyRunId: "delegation", policyTaskId: "task" } : {}),
  };
  const materialSha256 = hash({ version: 2, request: requestContent });
  const state: McpRequesterAdmissionCurrentState = {
    scope: {
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
    },
    connectionId: "connection",
    generation: 1,
    revoked: false,
    server: {
      serverId: "server",
      transport: "http",
      connectionMode: "requester_scoped",
      configurationRevision: 1,
      requesterResolution: {
        resolverId: "gateway.actor",
        resolverVersion: "1.0.0",
        configGeneration: 1,
        transportPolicy: {
          allowedSchemes: ["https"],
          allowedHosts: ["mcp.example.test"],
          allowedPorts: [443],
          allowedHeaderNames: [],
        },
      },
    },
  };
  const catalog = normalizeMcpRequesterDiscoveryOutput(
    "server",
    {
      tools: [{ rawRemoteToolName: "search", canonicalToolName: "mcp.server.search", inputSchema: { type: "object" } }],
    },
    createMcpRequesterDiscoverySecretScanner(),
  );
  const receipt = createMcpRequesterAdmissionConnection({
    current: state,
    catalog,
    selectedToolNames: ["mcp.server.search"],
  });
  const staticMaterial = {
    version: "mcp.static.admission.v1" as const,
    scope: state.scope,
    serverId: "server",
    transport: "http" as const,
    configurationBindingId: "configuration",
    connectionRevision: "a".repeat(64),
    serverRevision: "b".repeat(64),
    selectedTools: receipt.selectedTools.map((tool) => ({ ...tool, modelName: `mcp_s_${"c".repeat(56)}` })),
  };
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    ...(mode === "requester"
      ? { requesterConnections: [receipt] }
      : { selectedStaticMcp: [{ ...staticMaterial, bindingSha256: hash(staticMaterial) }] }),
  };
  const binding = { references, referenceSha256: hash(references) };
  const request: ToolInvokeRequest = {
    toolName: "mcp.server.search",
    agentId: "assistant",
    args: { query: "reviewed" },
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    toolRunId: "tool",
    runId: delegated ? "delegation" : "run",
    policyContext: { authActorId: "actor", authActorSource: "token" },
  };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
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
    ...(!delegated ? { policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" } } : {}),
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    featureReferenceSha256: binding.referenceSha256,
    request: requestContent,
  };
  const pending = {
    approvalId: "approval",
    actionType: "tool.invoke",
    resolutionStatus: "pending",
    request: { ...request },
    result: undefined as Record<string, unknown> | undefined,
  };
  const approval = {
    approvalId: "approval",
    status: "approved",
    linkage: {
      sessionId: "session",
      turnId: "turn",
      workspaceId: "workspace",
      runId: request.runId,
      durableRunId: "separate-approval-wait",
      toolName: request.toolName,
      authActorId: "actor",
      authActorSource: "token",
    },
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", status: "running", payload };
  const trace = { sessionId: "session", turnId: "turn", durable: { runId: "run" } };
  const step = {
    stepId: "step",
    runId: "delegation",
    status: "running",
    childSessionId: "session",
    childTurnId: "turn",
    durableRunId: "run",
  };
  const durableBinding = { durableRunId: "run" };
  const admission = {
    ...state.scope,
    admissionKind: "turn_write",
    actorKind: "operator",
    actorId: "actor",
    status: "active",
  };
  const external = {
    runId: "external",
    workspaceId: "workspace",
    status: "completed",
    actionId: "approval",
    catalogId: request.toolName,
    responsePayload: undefined as Record<string, unknown> | undefined,
  };
  const storage = {
    approvals: { get: vi.fn(async () => approval) },
    pendingApprovalActions: { find: vi.fn(async () => pending) },
    chatToolRuns: {
      get: vi.fn(async () => ({ ...request, status: "approval_required", approvalId: "approval" })),
      patch: vi.fn(async () => undefined),
    },
    chatTurnTraces: { get: vi.fn(async () => trace) },
    chatDelegationSteps: { get: vi.fn(async () => step) },
    durableRuns: { getRun: vi.fn(async () => run) },
    sessionMutationAdmissions: {
      get: vi.fn(async () => admission),
      findDurableRunBinding: vi.fn(async () => durableBinding),
      findFeatureReferences: vi.fn(async () => binding),
    },
    sessionControls: { getControl: vi.fn(async () => ({ generation: 1, ownerKind: "operator" })) },
    externalSideEffectRuns: { findByIdempotency: vi.fn(async () => external) },
    chatInlineApprovals: { get: vi.fn(async () => undefined), upsert: vi.fn() },
    runImmediateTransaction: async <T>(work: () => Promise<T>) => work(),
  };
  const port = storage as unknown as Parameters<typeof readApprovedRequesterAdmission>[0];
  const assertCurrent = vi.fn(async () => undefined);
  const handle = createMcpRequesterAdmissionTurnContext(state.scope, binding.referenceSha256, assertCurrent);
  const result: ToolInvokeResult = {
    outcome: "executed",
    policyReason: "Approved",
    auditEventId: "audit",
    result: { output: { value: "done" } },
  };
  const settle = () => {
    pending.resolutionStatus = "executed";
    pending.result = { ...result };
    external.responsePayload = { ...result };
  };
  return {
    port,
    storage,
    request,
    payload,
    binding,
    durableBinding,
    run,
    trace,
    step,
    admission,
    approval,
    pending,
    external,
    result,
    handle,
    settle,
    assertCurrent,
  };
}

describe("requester MCP approval admission restoration", () => {
  function resumeFixture() {
    const f = fixture();
    const listByTurn = vi.fn(async () => [
      { toolName: f.request.toolName, status: "approval_required", approvalId: "approval" },
    ]);
    const refreshPolicy = vi.fn(async () => undefined);
    const executePending = vi.fn(async () => {
      f.settle();
      return f.result;
    });
    const host = {
      storage: { ...f.port, chatToolRuns: { ...f.storage.chatToolRuns, listByTurn } },
      refreshPolicy,
      executePending,
    } as unknown as Parameters<typeof resumeAdmittedExternalApprovals>[0];
    const input = {
      sessionId: "session",
      turnId: "turn",
      workspaceId: "workspace",
      policyRunId: "run",
      canonicalDurableRunId: "run",
      featureAdmission: f.binding,
      canonicalWriteFence: async <T>(work: () => T | Promise<T>) => await work(),
    } as Parameters<typeof resumeAdmittedExternalApprovals>[1];
    return { ...f, host, input, listByTurn, refreshPolicy, executePending };
  }

  it("resumes pending selected approval through its existing executor and materialization transaction", async () => {
    const f = resumeFixture();
    await resumeAdmittedExternalApprovals(f.host, f.input, f.handle);
    expect(f.refreshPolicy).toHaveBeenCalledWith("approval");
    expect(f.executePending).toHaveBeenCalledWith("approval", f.pending, undefined, f.handle);
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledWith("tool", expect.objectContaining({ status: "executed" }));
  });

  it("materializes an already settled receipt without executing the external effect again", async () => {
    const f = resumeFixture();
    f.settle();
    await resumeAdmittedExternalApprovals(f.host, f.input, f.handle);
    expect(f.executePending).not.toHaveBeenCalled();
    expect(f.refreshPolicy).not.toHaveBeenCalled();
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledOnce();
  });

  it("refuses revoked live handles before reading approval candidates", async () => {
    const f = resumeFixture();
    f.assertCurrent.mockRejectedValue(new Error("revoked"));
    await expect(resumeAdmittedExternalApprovals(f.host, f.input, f.handle)).rejects.toThrow("revoked");
    expect(f.listByTurn).not.toHaveBeenCalled();
    expect(f.executePending).not.toHaveBeenCalled();
  });

  it("rechecks revocation after refreshing approval policy and before dispatch", async () => {
    const f = resumeFixture();
    f.refreshPolicy.mockImplementation(async () => {
      f.assertCurrent.mockRejectedValue(new Error("revoked during policy refresh"));
    });
    await expect(resumeAdmittedExternalApprovals(f.host, f.input, f.handle)).rejects.toThrow(/revoked during/);
    expect(f.executePending).not.toHaveBeenCalled();
    expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });
  it("joins the exact approved request, durable turn, actor and selected receipt without creating a lease", async () => {
    const f = fixture();
    expect(await readApprovedRequesterAdmission(f.port, "approval", f.request)).toMatchObject({
      referenceSha256: f.binding.referenceSha256,
    });
    expect(f.assertCurrent).not.toHaveBeenCalled();
    expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
    expect(f.storage.chatDelegationSteps.get).not.toHaveBeenCalled();
  });

  it.each(["requester", "static"] as const)(
    "restores delegated %s approval using the exact child execution run while preserving aggregate policy accounting",
    async (mode) => {
      const f = fixture(mode, true);
      expect(await readApprovedRequesterAdmission(f.port, "approval", f.request)).toMatchObject({
        referenceSha256: f.binding.referenceSha256,
      });
      expect(f.storage.chatDelegationSteps.get).toHaveBeenCalledWith("step");
      expect(f.storage.durableRuns.getRun).toHaveBeenCalledWith("run");
      expect(f.storage.durableRuns.getRun).not.toHaveBeenCalledWith("delegation");
      expect(f.request.runId).toBe("delegation");
      expect(f.approval.linkage.durableRunId).toBe("separate-approval-wait");
      f.settle();
      await materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result);
      expect(f.storage.chatToolRuns.patch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "step",
    "aggregate",
    "child run",
    "child turn",
    "trace run",
    "durable binding",
    "settled child",
    "actor",
    "controller",
  ])("refuses delegated approval after %s drift", async (drift) => {
    const f = fixture("requester", true);
    if (drift === "step") f.step.stepId = "other";
    if (drift === "aggregate") f.step.runId = "other";
    if (drift === "child run") f.step.durableRunId = "other";
    if (drift === "child turn") f.step.childTurnId = "other";
    if (drift === "trace run") f.trace.durable.runId = "other";
    if (drift === "durable binding") f.durableBinding.durableRunId = "other";
    if (drift === "settled child") f.step.status = "completed";
    if (drift === "actor") f.admission.actorId = "other";
    if (drift === "controller")
      f.storage.sessionControls.getControl.mockResolvedValue({ generation: 2, ownerKind: "operator" });
    let value;
    try {
      value = await readApprovedRequesterAdmission(f.port, "approval", f.request);
    } catch {
      value = undefined;
    }
    expect(value).toBeUndefined();
    expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });

  it("restores a selected delegated mesh approval through the same child identity without changing policy attribution", async () => {
    const f = fixture("requester", true);
    const connection = f.binding.references.requesterConnections![0]!;
    if (!("scope" in connection)) throw new Error("Fixture requires a selected admission receipt.");
    const mesh = createMeshChatCatalogFixture({ workspaceId: "workspace" });
    const schemas = await resolveMeshChatToolSchemas(mesh.deps, {
      workspaceId: mesh.workspaceId,
      entries: [mesh.entry],
    });
    f.binding.references = {
      version: "chat.turn.feature-references.v1",
      selectedMeshCapabilities: buildSelectedMeshAdmission(connection.scope, schemas),
    };
    f.binding.referenceSha256 = hash(f.binding.references);
    f.payload.featureReferenceSha256 = f.binding.referenceSha256;
    f.request.toolName = mesh.capabilityId;
    f.pending.request.toolName = mesh.capabilityId;
    f.approval.linkage.toolName = mesh.capabilityId;
    f.external.catalogId = mesh.capabilityId;
    const handle = createMeshAdmissionTurnContext(connection.scope, f.binding.referenceSha256, f.assertCurrent);
    expect(await readApprovedRequesterAdmission(f.port, "approval", f.request)).toMatchObject({
      referenceSha256: f.binding.referenceSha256,
    });
    f.settle();
    await materializeRequesterAdmissionApproval(f.port, f.request, "approval", handle, f.result);
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledOnce();
    expect(f.request.runId).toBe("delegation");
    expect(f.storage.durableRuns.getRun).not.toHaveBeenCalledWith("delegation");
  });
  it.each(["actor", "turn", "args", "hash", "controller", "closed", "chat-run", "approval", "pending-approval"])(
    "refuses %s drift in the canonical approval join",
    async (drift) => {
      const f = fixture();
      if (drift === "actor") f.approval.linkage.authActorId = "foreign";
      if (drift === "turn") f.approval.linkage.turnId = "foreign";
      if (drift === "args") f.pending.request.args = { query: "unreviewed" };
      if (drift === "hash") f.binding.referenceSha256 = "0".repeat(64);
      if (drift === "controller")
        f.storage.sessionControls.getControl.mockResolvedValue({ generation: 2, ownerKind: "operator" });
      if (drift === "closed") f.admission.status = "cancelled";
      if (drift === "chat-run") f.approval.linkage.runId = "foreign-chat-run";
      if (drift === "approval") f.approval.approvalId = "foreign-approval";
      if (drift === "pending-approval") f.pending.approvalId = "foreign-approval";
      let value;
      try {
        value = await readApprovedRequesterAdmission(f.port, "approval", f.request);
      } catch {
        value = undefined;
      }
      expect(value).toBeUndefined();
      expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
    },
  );
  it("links the canonical external receipt under a live claim and rejects a lost claim", async () => {
    const f = fixture();
    f.settle();
    await materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result);
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledWith(
      "tool",
      expect.objectContaining({
        status: "executed",
        effectOutcomeKind: "concrete",
        effectEvidence: expect.objectContaining({ refs: [{ owner: "external_side_effect", refId: "external" }] }),
      }),
    );
    f.storage.chatToolRuns.patch.mockClear();
    f.assertCurrent.mockRejectedValue(new Error("claim lost"));
    await expect(
      materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result),
    ).rejects.toThrow("claim lost");
    expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });
  it("retains unknown-after-send from the persisted effect receipt", async () => {
    const f = fixture();
    f.result.result = { externalOutcome: "unknown_after_send", manualReconciliationRequired: true };
    f.settle();
    await materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result);
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledWith(
      "tool",
      expect.objectContaining({ effectOutcomeKind: "uncertain", effectDisposition: "unknown" }),
    );
  });
  it("restores and materializes an approved static receipt through the same canonical durable join", async () => {
    const f = fixture("static");
    expect(await readApprovedRequesterAdmission(f.port, "approval", f.request)).toMatchObject({
      referenceSha256: f.binding.referenceSha256,
    });
    expect(f.assertCurrent).not.toHaveBeenCalled();
    f.settle();
    await materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result);
    expect(f.storage.chatToolRuns.patch).toHaveBeenCalledWith(
      "tool",
      expect.objectContaining({ status: "executed", effectOutcomeKind: "concrete" }),
    );
    f.storage.chatToolRuns.patch.mockClear();
    f.binding.references.selectedStaticMcp![0]!.scope.actorId = "foreign";
    await expect(
      materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result),
    ).rejects.toThrow();
    expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });
  it.each(["requester", "static"] as const)(
    "never treats an edited %s approval as execution authority",
    async (mode) => {
      const f = fixture(mode);
      f.approval.status = "edited";
      expect(await readApprovedRequesterAdmission(f.port, "approval", f.request)).toBeUndefined();
      f.settle();
      await expect(
        materializeRequesterAdmissionApproval(f.port, f.request, "approval", f.handle, f.result),
      ).rejects.toThrow(/live admission/);
      expect(f.storage.chatToolRuns.patch).not.toHaveBeenCalled();
    },
  );
});
