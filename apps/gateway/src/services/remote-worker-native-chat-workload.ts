import { remoteWorkerInferenceCanonicalSha256 as digest, removeRemoteWorkerNativeChatContext } from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerAssignmentWorkloadProjection } from "@goatcitadel/storage";
import { buildRemoteWorkerChatSequenceContext } from "./remote-worker-chat-output-service.js";
import { readRemoteWorkerNativeChatHistory } from "./remote-worker-native-chat-history.js";
import { readRetainedRemoteWorkerChatEvidence } from "./remote-worker-chat-admission-authority.js";

type Storage = Pick<AsyncStorage, "remoteWorkerAssignments" | "chatTurnCapabilityProfiles" | "remoteWorkerInference" |
  "remoteWorkerEffects" | "chatToolRuns" | "approvals" | "sessionMutationAdmissions" | "durableRuns">;

/** Called only inside the protected workload owner, which rechecks its active
 * lease and original workload identity after this asynchronous projection. */
export async function projectRemoteWorkerNativeChatWorkload(storage: Storage, workload: RemoteWorkerAssignmentWorkloadProjection,
  scope: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number }): Promise<RemoteWorkerAssignmentWorkloadProjection> {
  if (!workload.nativeChatContext) return workload;
  const aggregate = await storage.remoteWorkerAssignments.findAssignmentAggregate(scope.registryWorkspaceId, scope.assignmentId);
  const evidence = await readRetainedRemoteWorkerChatEvidence(storage, workload);
  if (!aggregate?.generation || aggregate.generation.assignmentGeneration !== scope.assignmentGeneration ||
    aggregate.assignment.manifestSha256 !== workload.assignmentManifestSha256 ||
    aggregate.assignment.manifest.durableRunId !== workload.durableRunId)
    throw new Error("Native Chat workload history lost its canonical assignment or profile.");
  const context = buildRemoteWorkerChatSequenceContext(storage, evidence, { workload, authority: aggregate } as never);
  const { history } = await readRemoteWorkerNativeChatHistory(storage.remoteWorkerInference, scope,
    { ...context, baseMessages: removeRemoteWorkerNativeChatContext(context.baseMessages, workload.nativeChatContext) }, workload.nativeChatContext);
  const { payload, chatContext, artifactPolicy, workloadSha256: _hash, ...identity } = workload;
  const material = { ...identity, nativeChatHistory: history };
  return Object.freeze({ ...material, workloadSha256: digest(material), payload,
    ...(chatContext ? { chatContext } : {}), ...(artifactPolicy ? { artifactPolicy } : {}) });
}
