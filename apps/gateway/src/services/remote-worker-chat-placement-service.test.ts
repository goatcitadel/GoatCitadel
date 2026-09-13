import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpRequesterScopeHashMaterial,
  mcpStaticToolScopeHashMaterial,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolDefinition,
} from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { prepareChatOfferFixture } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { createMeshChatCatalogFixture } from "./gateway/mesh-chat-catalog-test-fixtures.js";
import {
  RemoteWorkerChatPlacementService,
  type RemoteWorkerChatPlacementDependencies,
} from "./remote-worker-chat-placement-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});

function fixture(
  options: {
    subagentPolicy?: "off" | "auto_when_useful";
    granted?: boolean;
    separateRegistry?: boolean;
    tools?: ChatTurnCapabilityToolDefinition[];
    governedTools?: boolean;
    scopedTool?: "mcp" | "mesh";
    requesterOwner?: boolean;
    meshOwner?: boolean;
    meshExecution?: boolean;
    staticMcp?: boolean;
    genericChat?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "goat-chat-placement-"));
  const storage = new Storage({
    dbPath: join(root, "gateway.sqlite"),
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const registryWorkspaceId = options.separateRegistry
    ? storage.workspaces.create({ name: "Shared worker registry" }).workspaceId
    : "default";
  const tools = [...(options.tools ?? [])];
  const meshCatalog = options.scopedTool === "mesh" ? createMeshChatCatalogFixture({ workspaceId: "default" }) : undefined;
  const scoped = options.scopedTool ? readTool(meshCatalog?.capabilityId ?? `${options.scopedTool}.fixture.read`, `${options.scopedTool}_read`) : undefined;
  if (scoped) tools.push(scoped);
  const callableEntries: CapabilityCatalogEntry[] = tools.map((tool) => meshCatalog && tool === scoped ? meshCatalog.entry : ({
    capabilityId: `tool:${tool.canonicalName}`, kind: "tool", category: "built_in", title: tool.canonicalName,
    summary: "Placement fixture tool", callable: true, trustLabel: "Builtin", toolName: tool.canonicalName,
    effectPotential: tool.effectPotential,
  }));
  if (scoped && meshCatalog) {
    scoped.meshPublication = meshCatalog.binding;
    scoped.effectPotential = { version: "goatcitadel.tool-effect.v1", potential: "unknown",
      sourceKind: "remote", reason: "remote_runtime_may_cross_boundary" };
  } else if (scoped) {
    callableEntries.find((entry) => entry.toolName === scoped.canonicalName)!.sourceRef =
      `mcp-tool-definition:${digest("fixture-native-definition")}`;
    callableEntries.unshift({ capabilityId: "tool:mcp.invoke", kind: "tool", category: "built_in", title: "MCP",
      summary: "Governed MCP invocation", callable: true, toolName: "mcp.invoke" });
    const material = { schemaVersion: "goatcitadel.mcp-requester-resolution-binding.v1" as const,
      mode: "requester_scoped" as const, serverId: "fixture", toolName: scoped.canonicalName,
      resolverId: "fixture", resolverVersion: "1.0.0", resolverConfigGeneration: 1,
      requesterScopeSha256: digest(mcpRequesterScopeHashMaterial({
        profileId: "profile-connected-worker", turnId: "turn-connected-worker", sessionId: "session-connected-worker",
        workspaceId: "default", authActorId: "operator-a", authActorSource: "token",
      })), serverConfigRevision: 1, serverConfigSha256: digest("server"), transportPolicySha256: digest("transport"),
      callableCatalogSnapshotId: "connected-worker-snapshot", callableCatalogSha256: digest(callableEntries),
    };
    if (options.staticMcp) {
      const staticMaterial = { schemaVersion: "goatcitadel.mcp-static-tool-binding.v1" as const, mode: "static" as const,
        serverId: "fixture", nativeToolName: "read", toolName: scoped.canonicalName, transport: "http" as const,
        configurationBindingId: "00000000-0000-4000-8000-000000000001", toolDefinitionSha256: scoped.definitionHash,
        profileScopeSha256: digest(mcpStaticToolScopeHashMaterial({ profileId: "profile-connected-worker", turnId: "turn-connected-worker",
          sessionId: "session-connected-worker", workspaceId: "default", authActorId: "operator-a", authActorSource: "token" })),
        callableCatalogSnapshotId: material.callableCatalogSnapshotId, callableCatalogSha256: material.callableCatalogSha256 };
      scoped.mcpStaticBinding = { ...staticMaterial, bindingSha256: digest(staticMaterial) };
    } else scoped.mcpRequesterResolution = { ...material, bindingSha256: digest(material) };
  }
  const seed = prepareChatOfferFixture(storage.db, true, "", {
    subagentPolicy: options.subagentPolicy ?? "off", tools, callableEntries, genericChat: options.genericChat,
  });
  const run = storage.durableRuns.getRun(seed.durableRunId);
  const profile = storage.chatTurnCapabilityProfiles.findByRun(run.runId)!;
  const prepared = {
    workspaceId: profile.identity.workspaceId,
    session: { sessionId: profile.identity.sessionId },
    turnId: profile.identity.turnId,
    assistantMessageId: run.payload!.assistantMessageId,
    capabilityProfile: profile,
  } as PreparedAgentChatTurn;
  const dependencies: RemoteWorkerChatPlacementDependencies = {
    storage: createSqliteAsyncStorage(storage),
    enabled: true,
    registryWorkspaceId: "default",
    artifactRoot: join(root, "cas"),
    pathJailSha256: seed.offerInput.pathJailSha256,
    listCallableCapabilities: async () => callableEntries.filter((entry) => !entry.sourceRef?.startsWith("mcp-tool-definition:")),
    resolvePolicyContext: async () => ({ permissionProfileId: "safe", authActorId: "operator-a", authActorSource: "token" }),
    ...(options.requesterOwner ? { revalidateRequesterTool: vi.fn(async () => undefined) } : {}),
    ...(options.meshOwner ? { revalidateMeshTool: vi.fn(async () => undefined) } : {}),
    meshToolExecutionAvailable: options.meshExecution ?? false,
  };
  // Eligibility projections only. The spawned-worker lane supplies real native
  // admission and mesh records; these unit cases isolate routing decisions.
  vi.spyOn(storage.remoteWorkerAdmissions, "findCurrentGeneration").mockReturnValue({
    workerId: "worker-1",
    workerGeneration: 1,
    bootstrapId: "bootstrap-1",
    nodeId: "node-1",
  } as ReturnType<typeof storage.remoteWorkerAdmissions.findCurrentGeneration>);
  const registry = vi.spyOn(storage.remoteWorkerAdmissions, "findWorkerRegistryEntry").mockReturnValue({
    admission: { platform: "windows", transportIdentitySource: "native_mtls" },
  } as ReturnType<typeof storage.remoteWorkerAdmissions.findWorkerRegistryEntry>);
  vi.spyOn(storage.remoteWorkerAdmissions, "getBootstrap").mockReturnValue({
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference",
      ...(options.governedTools ? ["governed_tool"] : [])],
  } as ReturnType<typeof storage.remoteWorkerAdmissions.getBootstrap>);
  vi.spyOn(storage.mesh, "getNode").mockReturnValue({ status: "online" } as ReturnType<typeof storage.mesh.getNode>);
  const grant = () =>
    storage.remoteWorkerBudgets.createGrant(
      {
        grantId: "placement-grant",
        registryWorkspaceId,
        executionWorkspaceId: "default",
        workerId: "worker-1",
        workerGeneration: 1,
        maxRequests: 2,
        maxCostMicrousd: 1_000_000,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      "operator-a",
    );
  if (options.granted !== false) grant();
  return {
    storage,
    seed,
    run,
    prepared,
    dependencies,
    grant,
    registry,
    callableEntries,
    registryWorkspaceId,
    service: new RemoteWorkerChatPlacementService(dependencies),
  };
}

function readTool(canonicalName = "fs.read", modelName = "fs_read"): ChatTurnCapabilityToolDefinition {
  const providerDefinition = { type: "function", function: {
    name: modelName, description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  } };
  return { canonicalName, modelName, providerDefinition, definitionHash: digest(providerDefinition),
    runtimeOwner: { kind: "builtin", bindingHash: digest("fixture-read-owner") },
    effectPotential: { version: "goatcitadel.tool-effect.v1", potential: "none",
      sourceKind: "builtin", reason: "trusted_builtin_safe_read" },
  };
}

describe("ordinary durable Chat worker placement", () => {
  it("places Chat without a supplied task and preserves the original admission on replay", async () => {
    const f = fixture({ genericChat: true });
    expect(f.storage.tasks.list({ limit: 100 })).toHaveLength(0);
    expect(f.run.payload?.request).not.toHaveProperty("policyTaskId");
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    const assignment = f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)!.assignment;
    const task = f.storage.tasks.get(assignment.manifest.taskId);
    expect(task).toMatchObject({ workspaceId: "default", status: "in_progress", createdBy: "operator-a",
      proactiveContext: { sessionId: f.prepared.session.sessionId, durableRunId: f.run.runId } });
    expect(f.storage.durableRuns.getRun(f.run.runId).payload).toEqual(f.run.payload);
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.storage.tasks.list({ limit: 100 })).toEqual([task]);
  });

  it("creates no worker task for ordinary Chat without an execution grant", async () => {
    const f = fixture({ genericChat: true, granted: false });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
    expect(f.storage.tasks.list({ limit: 100 })).toHaveLength(0);
  });

  it("creates a canonical offer for an eligible admitted task and retains the choice after a settings change", async () => {
    const f = fixture();
    expect(f.run.attemptCount).toBe(0);
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    const selected = f.storage.chatExecutionPlacements.get(f.run.runId)!;
    expect(selected.executionKind).toBe("remote_worker");
    expect(
      f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)?.assignment.assignmentId,
    ).toBe(selected.assignmentId);
    f.dependencies.enabled = false;
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toEqual(selected);
  });

  it("keeps a retry without a placement ledger local even when a worker is eligible", async () => {
    const f = fixture();
    const retry = f.storage.durableRuns.updateRun({
      runId: f.run.runId,
      status: "running",
      attemptCount: 1,
      expectedVersion: f.run.version,
    });
    expect(await f.service.resolve(retry, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(retry.runId)?.executionKind).toBe("local");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("keeps a locally started turn local when a worker grant becomes available later", async () => {
    const f = fixture({ granted: false });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    f.grant();
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("selects an authorized registry separately from the execution workspace", async () => {
    const f = fixture({ separateRegistry: true });
    expect(f.registryWorkspaceId).not.toBe("default");
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toMatchObject({
      workspaceId: "default",
      registryWorkspaceId: f.registryWorkspaceId,
      executionKind: "remote_worker",
    });
  });

  it("does not replace the full delegation runner with the current worker model/tool loop", async () => {
    const f = fixture({ subagentPolicy: "auto_when_useful" });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
  });

  it("places an admitted tool profile without spending or invoking tools and retains its choice", async () => {
    const f = fixture({ tools: [readTool()], governedTools: true });
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    const selected = f.storage.chatExecutionPlacements.get(f.run.runId)!;
    const assignment = f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)!;
    expect(selected.executionKind).toBe("remote_worker");
    expect(assignment.assignment.manifest.requiredCapabilityClasses).toContain("governed_tool");
    expect(f.storage.remoteWorkerBudgets.listExecutionGrants("default", "operator-a")[0]).toMatchObject({
      heldRequests: 0, settledRequests: 0,
    });
    expect(f.storage.chatToolRuns.listByTurn(f.prepared.turnId)).toEqual([]);
    f.dependencies.enabled = false;
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toEqual(selected);
  });

  it("keeps tools local if the admitted worker has no governed tool capability", async () => {
    const f = fixture({ tools: [readTool()] });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it.each(["mcp", "mesh"] as const)("keeps a scoped %s profile local when its worker runtime owner is unavailable", async (scopedTool) => {
    const f = fixture({ tools: [readTool()], governedTools: true, scopedTool });
    expect(f.prepared.capabilityProfile!.selection.tools).toHaveLength(2);
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("places an exact mesh profile only with its authority and effect owners available", async () => {
    const f = fixture({ tools: [readTool()], governedTools: true, scopedTool: "mesh", meshOwner: true, meshExecution: true });
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.dependencies.revalidateMeshTool).toHaveBeenCalledExactlyOnceWith(f.prepared.capabilityProfile, "mesh:node-a:tool:project.status");
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("remote_worker");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)?.assignment.manifest.requiredCapabilityClasses)
      .toContain("governed_tool");
    expect(f.storage.chatToolRuns.listByTurn(f.prepared.turnId)).toEqual([]);
    expect(f.storage.remoteWorkerBudgets.listExecutionGrants("default", "operator-a")[0]).toMatchObject({ heldRequests: 0, settledRequests: 0 });
  });

  it.each(["authority", "execution", "governed-tool-class"] as const)("keeps mesh local without %s", async (missing) => {
    const f = fixture({ governedTools: missing !== "governed-tool-class", scopedTool: "mesh",
      meshOwner: missing !== "authority", meshExecution: missing !== "execution" });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("refuses mesh placement when current publication authority was withdrawn", async () => {
    const f = fixture({ governedTools: true, scopedTool: "mesh", meshOwner: true, meshExecution: true });
    f.dependencies.revalidateMeshTool = async () => { throw new Error("mesh activation revoked"); };
    await expect(f.service.resolve(f.run, f.prepared)).rejects.toThrow("mesh activation revoked");
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toBeUndefined();
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it.each([false, true])("places native MCP with static=%s through its current Gateway owner", async (staticMcp) => {
    const f = fixture({ tools: [readTool()], governedTools: true, scopedTool: "mcp", requesterOwner: true, staticMcp });
    expect(await f.dependencies.listCallableCapabilities("default")).not.toContainEqual(
      expect.objectContaining({ toolName: "mcp.fixture.read" }),
    );
    expect(await f.service.resolve(f.run, f.prepared)).toBeDefined();
    expect(f.dependencies.revalidateRequesterTool).toHaveBeenCalledExactlyOnceWith(f.prepared.capabilityProfile, "mcp.fixture.read");
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("remote_worker");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)?.assignment.manifest.requiredCapabilityClasses)
      .toContain("governed_tool");
    expect(f.storage.chatToolRuns.listByTurn(f.prepared.turnId)).toEqual([]);
    expect(f.storage.remoteWorkerBudgets.listExecutionGrants("default", "operator-a")[0]).toMatchObject({ heldRequests: 0, settledRequests: 0 });
  });

  it("keeps a static MCP profile local without its Gateway authority owner", async () => {
    const f = fixture({ governedTools: true, scopedTool: "mcp", staticMcp: true });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it.each(["requester revoked", "shared capability withdrawn"])("refuses worker MCP placement when %s", async (drift) => {
    const f = fixture({ governedTools: true, scopedTool: "mcp", requesterOwner: true });
    if (drift === "requester revoked") f.dependencies.revalidateRequesterTool = async () => { throw new Error(drift); };
    else f.callableEntries.splice(f.callableEntries.findIndex((entry) => entry.toolName === "mcp.invoke"), 1);
    await expect(f.service.resolve(f.run, f.prepared)).rejects.toThrow();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toBeUndefined();
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("keeps native MCP without a frozen requester binding on its local runner", async () => {
    const f = fixture({ tools: [readTool("mcp.static.read")], governedTools: true, requesterOwner: true });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.dependencies.revalidateRequesterTool).not.toHaveBeenCalled();
  });

  it.each(["runtimeOwner", "effectPotential"] as const)("keeps a tool with missing %s on its local runner", async (field) => {
    const tool = readTool();
    delete tool[field];
    const f = fixture({ tools: [tool], governedTools: true });
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
  });

  it("rejects a withdrawn tool before committing a worker placement", async () => {
    const f = fixture({ tools: [readTool()], governedTools: true });
    f.callableEntries.splice(0);
    await expect(f.service.resolve(f.run, f.prepared)).rejects.toThrow("current callable catalog");
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toBeUndefined();
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("does not place work on a quarantined generation", async () => {
    const f = fixture();
    f.registry.mockReturnValue({
      admission: { platform: "windows", transportIdentitySource: "native_mtls" },
      control: { action: "quarantine" },
    } as ReturnType<typeof f.storage.remoteWorkerAdmissions.findWorkerRegistryEntry>);
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(f.seed.offerInput)).toBeUndefined();
  });

  it("retains local ownership for a pre-ledger run with a recorded provider dispatch", async () => {
    const f = fixture();
    const usage = vi.spyOn(f.storage.modelUsageEvents, "list").mockReturnValue({
      items: [{ eventId: "prior-provider-dispatch" }],
    } as ReturnType<typeof f.storage.modelUsageEvents.list>);
    expect(await f.service.resolve(f.run, f.prepared)).toBeUndefined();
    expect(usage).toHaveBeenCalledWith({ durableRunId: f.run.runId, limit: 1 });
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)?.executionKind).toBe("local");
  });

  it("retains admission/permission failures instead of falling back to another execution", async () => {
    const f = fixture();
    f.dependencies.resolvePolicyContext = async () => ({ permissionProfileId: "different" });
    await expect(f.service.resolve(f.run, f.prepared)).rejects.toThrow("permission authority changed");
    expect(f.storage.chatExecutionPlacements.get(f.run.runId)).toBeUndefined();
    await expect(f.service.resolve({ ...f.run, leaseOwnerId: "stale" }, f.prepared)).rejects.toThrow("claim");
    await expect(f.service.resolve(f.run, { ...f.prepared, workspaceId: "foreign" })).rejects.toThrow("scope");
  });
});
