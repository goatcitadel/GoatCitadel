import {
  ConflictError,
  REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION,
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  sealRemoteWorkerChatContext,
  verifyRemoteWorkerChatContext,
  type ChatCompletionMessage,
  type RemoteWorkerChatContextSnapshot,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";
import {
  SessionMutationAdmissionRepository,
  type DurableTurnWriteClaim,
  type RequestRuntimeLeaseClaim,
} from "./session-mutation-admission-repo.js";
import { RoutedContextSnapshotRepository } from "./routed-context-snapshot-repo.js";

export interface FreezeRemoteWorkerChatContextInput {
  readonly durableRunId: string;
  readonly messages: readonly ChatCompletionMessage[];
  readonly requestRuntimeClaim?: RequestRuntimeLeaseClaim;
  readonly durableClaim?: DurableTurnWriteClaim;
}

/** One immutable input snapshot per admitted Chat turn. This is context storage,
 * not an execution grant: offers and model/tool dispatch still recheck their
 * own current admission, lease, capability, policy and spending authorities. */
export class RemoteWorkerChatContextRepository {
  constructor(private readonly db: DatabaseClient) {}

  public freezeForAdmission(input: FreezeRemoteWorkerChatContextInput): RemoteWorkerChatContextSnapshot {
    return this.db.transaction("immediate", () => {
      const runs = new DurableRunRepository(this.db);
      const run = runs.getRun(input.durableRunId);
      const payload = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: run.workflowKey,
        durableRunId: run.runId,
        payload: run.payload,
      });
      if (!payload || !payload.capabilityProfileId || !payload.capabilityProfileHash)
        throw conflict("Remote Chat context requires an admitted capability profile.");
      if (input.durableClaim && input.durableClaim.durableRunId !== run.runId)
        throw conflict("Remote Chat context durable claim differs from its run.");
      const admission = new SessionMutationAdmissionRepository(this.db).assertActiveTurnWrite({
        admissionId: payload.admissionId,
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        requestRuntimeClaim: input.requestRuntimeClaim,
        durableClaim: input.durableClaim,
        requireExactDurablePayloadIdentity: Boolean(input.durableClaim),
      }).admission;
      if (
        admission.materialSha256 !== payload.admissionMaterialSha256 ||
        admission.actorId !== payload.requestActor.actorId
      )
        throw conflict("Remote Chat context admission identity changed.");
      const profile = new ChatTurnCapabilityProfileRepository(this.db).findByRun(run.runId);
      if (
        !profile ||
        profile.profileId !== payload.capabilityProfileId ||
        profile.hashes.profileHash !== payload.capabilityProfileHash ||
        profile.identity.workspaceId !== payload.workspaceId ||
        profile.identity.sessionId !== payload.sessionId ||
        profile.identity.turnId !== payload.turnId
      )
        throw conflict("Remote Chat context capability profile changed.");
      if (payload.routedContextSnapshotId) {
        const routed = new RoutedContextSnapshotRepository(this.db).get(payload.routedContextSnapshotId);
        if (
          routed.snapshotHash !== payload.routedContextSnapshotHash ||
          routed.turnId !== payload.turnId ||
          routed.sessionId !== payload.sessionId ||
          routed.workspaceId !== payload.workspaceId ||
          routed.capabilityProfileId !== profile.profileId ||
          routed.capabilityProfileHash !== profile.hashes.profileHash ||
          (routed.contextText &&
            !input.messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.includes(routed.contextText),
            ))
        )
          throw conflict("Remote Chat context lost its admitted routed context.");
      }
      if (
        !input.messages.some(
          (message) =>
            message.role === "user" &&
            (typeof message.content === "string"
              ? message.content.includes(String(payload.request.content))
              : message.content.some(
                  (part) => typeof part.text === "string" && part.text.includes(String(payload.request.content)),
                )),
        )
      )
        throw conflict("Remote Chat context lost its admitted user input.");
      const snapshot = sealRemoteWorkerChatContext({
        schemaVersion: REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION,
        durableRunId: run.runId,
        admissionId: payload.admissionId,
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        requestMaterialSha256: payload.effectiveRequestMaterialSha256,
        capabilityProfileId: profile.profileId,
        capabilityProfileSha256: profile.hashes.profileHash,
        ...(payload.routedContextSnapshotId
          ? {
              routedContextSnapshotId: payload.routedContextSnapshotId,
              routedContextSnapshotSha256: payload.routedContextSnapshotHash,
            }
          : {}),
        messages: input.messages,
      });
      if (run.metadata?.remoteWorkerChatContextSha256 !== snapshot.contextSha256)
        throw conflict("Remote Chat context differs from its frozen admission digest.");
      const existing = this.findForRun(run.runId);
      if (existing) {
        if (canonicalJsonString(existing) !== canonicalJsonString(snapshot))
          throw conflict("Remote Chat context replay changed.");
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO remote_worker_chat_contexts
        (durable_run_id, workspace_id, session_id, turn_id, capability_profile_id, capability_profile_sha256, context_sha256, context_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.runId,
          snapshot.workspaceId,
          snapshot.sessionId,
          snapshot.turnId,
          snapshot.capabilityProfileId,
          snapshot.capabilityProfileSha256,
          snapshot.contextSha256,
          canonicalJsonString(snapshot),
          runs.readDatabaseNow(),
        );
      return snapshot;
    });
  }

  public findForRun(durableRunId: string): RemoteWorkerChatContextSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT workspace_id, session_id, turn_id, capability_profile_id, capability_profile_sha256,
      context_sha256, context_json FROM remote_worker_chat_contexts WHERE durable_run_id = ?`,
      )
      .get<{
        workspace_id: string;
        session_id: string;
        turn_id: string;
        capability_profile_id: string;
        capability_profile_sha256: string;
        context_sha256: string;
        context_json: string;
      }>(durableRunId);
    if (!row) return undefined;
    const snapshot = verifyRemoteWorkerChatContext(JSON.parse(row.context_json));
    if (
      snapshot.durableRunId !== durableRunId ||
      snapshot.workspaceId !== row.workspace_id ||
      snapshot.sessionId !== row.session_id ||
      snapshot.turnId !== row.turn_id ||
      snapshot.capabilityProfileId !== row.capability_profile_id ||
      snapshot.capabilityProfileSha256 !== row.capability_profile_sha256 ||
      snapshot.contextSha256 !== row.context_sha256
    )
      throw conflict("Remote Chat context storage binding changed.");
    return snapshot;
  }
}

function conflict(message: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message,
    details: { reason: "remote_worker_chat_context_conflict" },
  });
}
