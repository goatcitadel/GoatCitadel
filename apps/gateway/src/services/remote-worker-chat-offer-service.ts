import {
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerInferenceCanonicalSha256,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  resolveRemoteWorkerChatProfileReference,
  type RemoteWorkerChatAuthorityDependencies,
} from "./remote-worker-chat-authority.js";

export type RemoteWorkerChatDispatchClaim = Pick<
  DurableRunRecord,
  "runId" | "leaseOwnerId" | "attemptCount" | "version"
>;

export interface RemoteWorkerChatOfferDependencies extends RemoteWorkerChatAuthorityDependencies {
  storage: AsyncStorage;
  enabled: boolean;
  registryWorkspaceId: string;
  pathJailSha256: string;
}

/** Internal durable-Chat handoff. Offers do not authorize spending or tool
 * effects; the worker re-enters those owners after claiming the assignment. */
export class RemoteWorkerChatOfferService {
  constructor(private readonly dependencies: RemoteWorkerChatOfferDependencies) {}

  async schedule(claim: RemoteWorkerChatDispatchClaim) {
    if (!this.dependencies.enabled) throw new Error("Remote worker assignment runtime is not activated.");
    const run = await this.dependencies.storage.durableRuns.getRun(claim.runId);
    if (
      run.status !== "running" ||
      !run.leaseOwnerId ||
      run.leaseOwnerId !== claim.leaseOwnerId ||
      run.attemptCount !== claim.attemptCount ||
      run.version !== claim.version
    )
      throw new Error("Remote worker scheduling requires the current durable Chat claim.");
    const payload = run.payload;
    const authority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload,
    });
    if (!authority || !payload || payload.version !== "chat.turn.execute.v2")
      throw new Error("Remote worker scheduling requires an admitted Chat turn.");
    const request = payload.request as Record<string, unknown> | undefined;
    if (
      !request ||
      (request.policyTaskId !== undefined &&
        (typeof request.policyTaskId !== "string" || !request.policyTaskId.trim())) ||
      typeof payload.capabilityProfileId !== "string" ||
      typeof payload.capabilityProfileHash !== "string"
    )
      throw new Error("Remote worker scheduling requires an admitted capability profile and valid optional task.");
    await resolveRemoteWorkerChatProfileReference(this.dependencies, {
      capabilityProfileId: payload.capabilityProfileId,
      capabilityProfileSha256: payload.capabilityProfileHash,
      executionWorkspaceId: authority.workspaceId,
      sessionId: authority.sessionId,
      turnId: authority.turnId,
      durableRunId: run.runId,
      taskId: request.policyTaskId as string | undefined,
    });
    const createdAt = Date.parse(run.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error("Remote worker Chat admission time is unavailable.");
    // Relative to the original admission, so retries cannot extend execution.
    const deadlineAt = new Date(createdAt + 30 * 60_000).toISOString();
    return await this.dependencies.storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer({
      registryWorkspaceId: this.dependencies.registryWorkspaceId,
      executionWorkspaceId: authority.workspaceId,
      sessionId: authority.sessionId,
      turnId: authority.turnId,
      durableRunId: run.runId,
      dispatchOwnerId: run.leaseOwnerId,
      durableRunAttempt: run.attemptCount,
      durableRunVersion: run.version,
      payloadMaterialSha256: remoteWorkerInferenceCanonicalSha256(payload),
      pathJailSha256: this.dependencies.pathJailSha256,
      deadlineAt,
      limits: {
        leaseTtlSeconds: 60,
        maxEventCount: 10_000,
        maxEventBytes: 65_536,
        eventLowWatermark: 32,
        eventHighWatermark: 64,
        maxOutputBytes: 1_048_576,
        maxArtifactBytes: 1_048_576,
      },
    });
  }
}
