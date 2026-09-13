import {
  NotFoundError,
  REMOTE_WORKER_BUDGET_MAX_ATTEMPTS,
  readDurableChatTurnExecutionPayloadAuthority,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { isNativeMcpToolName } from "./gateway/native-mcp-chat-binding.js";
import {
  RemoteWorkerChatExecutionService,
  type RemoteWorkerChatExecution,
} from "./remote-worker-chat-execution-service.js";
import {
  RemoteWorkerChatOfferService,
  type RemoteWorkerChatOfferDependencies,
} from "./remote-worker-chat-offer-service.js";

export interface RemoteWorkerChatPlacementDependencies extends RemoteWorkerChatOfferDependencies {
  artifactRoot: string;
  /** Set only by composition with the mesh effect and approved-dispatch owners. */
  meshToolExecutionAvailable?: boolean;
}

/** Gateway-owned placement at the ordinary durable Chat dispatch boundary. */
export class RemoteWorkerChatPlacementService {
  constructor(private readonly dependencies: RemoteWorkerChatPlacementDependencies) {}

  async resolve(
    run: DurableRunRecord,
    prepared: PreparedAgentChatTurn,
  ): Promise<RemoteWorkerChatExecution | undefined> {
    const { storage } = this.dependencies;
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload: run.payload,
    });
    if (
      !payload ||
      payload.workspaceId !== prepared.workspaceId ||
      payload.sessionId !== prepared.session.sessionId ||
      payload.turnId !== prepared.turnId
    )
      throw new Error("Chat placement differs from its admitted execution scope.");
    const placement = await storage.chatExecutionPlacements.get(run.runId);
    const assignment = await storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
      executionWorkspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      durableRunId: run.runId,
    });
    const registryWorkspaceId =
      !placement && !assignment
        ? await this.selectWorkerRegistry(run, prepared, payload.requestActor.actorId)
        : undefined;
    if (registryWorkspaceId !== undefined) {
      // The offer and remote ownership decision commit together. A concurrent
      // local decision rejects this offer; it never authorizes a second runner.
      const current = await storage.durableRuns.getRun(run.runId);
      if (current.leaseOwnerId !== run.leaseOwnerId || current.attemptCount !== run.attemptCount)
        throw new Error("Chat placement lost its durable execution claim.");
      await new RemoteWorkerChatOfferService({ ...this.dependencies, registryWorkspaceId }).schedule(current);
    }
    const selected = await storage.chatExecutionPlacements.claimLocal(run);
    if (selected.executionKind === "local") return undefined;
    const execution = await new RemoteWorkerChatExecutionService(storage, this.dependencies.artifactRoot).resolve(
      run,
      prepared,
    );
    if (!execution) throw new Error("Chat worker placement lost its assignment.");
    return execution;
  }

  private async selectWorkerRegistry(
    run: DurableRunRecord,
    prepared: PreparedAgentChatTurn,
    actorId: string,
  ): Promise<string | undefined> {
    const { storage, enabled } = this.dependencies;
    const profile = prepared.capabilityProfile;
    const request = run.payload?.request as Record<string, unknown> | undefined;
    // Admit the bounded model/tool loop only when every selected tool can enter
    // RemoteWorkerEffectRuntime. Scoped MCP and mesh use their Gateway owners;
    // council and delegation still need their full local runner.
    if (
      !enabled ||
      run.attemptCount !== 0 ||
      !profile ||
      !request ||
      !run.metadata?.remoteWorkerChatContextSha256 ||
      profile.selection.tools.some((tool) =>
        !tool.runtimeOwner || !tool.effectPotential ||
        (tool.meshPublication && (!this.dependencies.meshToolExecutionAvailable || !this.dependencies.revalidateMeshTool)) ||
        (isNativeMcpToolName(tool.canonicalName) &&
          ((!tool.mcpRequesterResolution && !tool.mcpStaticBinding) || !this.dependencies.revalidateRequesterTool))) ||
      profile.selection.subagentPolicy !== "off" ||
      request.modelCouncil ||
      request.parentDelegationStepId ||
      request.sideChatContext ||
      run.payload?.heartbeatOccurrenceId
    )
      return undefined;
    // A run created before the placement ledger may already have crossed a
    // local dispatch boundary. Recovery of that work must stay on its runner.
    const priorUsage = await storage.modelUsageEvents.list({ durableRunId: run.runId, limit: 1 });
    if (priorUsage.items.length > 0 || (await storage.chatToolRuns.listByTurn(prepared.turnId)).length > 0)
      return undefined;
    const requiredCapabilities = ["artifact_stage", "durable_compute", "gateway_inference"];
    if (profile.selection.tools.length > 0) requiredCapabilities.push("governed_tool");
    const balances = await storage.remoteWorkerBudgets.listExecutionGrants(prepared.workspaceId, actorId);
    for (const { grant, availableRequests, availableCostMicrousd } of balances) {
      const registryWorkspaceId = grant.registryWorkspaceId;
      if (
        grant.operatorId !== actorId ||
        grant.revokedAt ||
        Date.parse(grant.expiresAt) <= Date.now() ||
        availableRequests < REMOTE_WORKER_BUDGET_MAX_ATTEMPTS ||
        (grant.maxCostMicrousd > 0 && availableCostMicrousd <= 0)
      )
        continue;
      const worker = await storage.remoteWorkerAdmissions.findCurrentGeneration(registryWorkspaceId, grant.workerId);
      const registry = await storage.remoteWorkerAdmissions.findWorkerRegistryEntry(
        registryWorkspaceId,
        grant.workerId,
      );
      if (
        !worker ||
        worker.workerGeneration !== grant.workerGeneration ||
        !registry ||
        registry.control ||
        registry.admission.platform !== "windows" ||
        registry.admission.transportIdentitySource !== "native_mtls"
      )
        continue;
      const bootstrap = await storage.remoteWorkerAdmissions.getBootstrap(registryWorkspaceId, worker.bootstrapId);
      if (
        !bootstrap.allowedWorkspaceIds.includes(prepared.workspaceId) ||
        !requiredCapabilities.every((capability) =>
          bootstrap.capabilityClasses.some((entry) => entry === capability),
        )
      )
        continue;
      try {
        const node = await storage.mesh.getNode(worker.nodeId);
        if (node.status === "online") return registryWorkspaceId;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return undefined;
  }
}
