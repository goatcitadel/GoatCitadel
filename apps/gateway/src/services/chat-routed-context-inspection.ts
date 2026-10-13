import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  CHAT_ROUTED_CONTEXT_ADMISSION_SNAPSHOT_VERSION,
  NotFoundError,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatRoutedContextInspectionEnvelope,
  type ChatRoutedContextSnapshotRecord,
} from "@goatcitadel/contracts";
import { projectChatRoutedContextInspection, type AsyncStorage } from "@goatcitadel/storage";
import { projectPublicSecretValue } from "./public-secret-projection.js";

export interface ChatRoutedContextInspectionHost {
  storage: Pick<
    AsyncStorage,
    "chatTurnTraces" | "chatSessionMeta" | "durableRuns" | "sessionMutationAdmissions" | "routedContextSnapshots"
  >;
  normalizeWorkspaceId(value?: string): string;
  revalidateChatRoutedContextSnapshot(snapshot: ChatRoutedContextSnapshotRecord): Promise<void>;
}

/** Read evidence through its original durable admission. A completed run remains
 * inspectable; this read grants no execution authority and never returns bytes. */
export async function inspectAdmittedChatRoutedContext(
  host: ChatRoutedContextInspectionHost,
  sessionId: string,
  turnId: string,
  options: { workspaceId?: string; operatorId?: string } = {},
): Promise<ChatRoutedContextInspectionEnvelope> {
  const missing = (): never => {
    throw new NotFoundError({ entity: "Chat routed context snapshot", id: turnId });
  };
  const trace = await host.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId || trace.turnId !== turnId || !trace.durable?.runId || !trace.routing.routedContext)
    missing();
  const session = await host.storage.chatSessionMeta.get(sessionId);
  if (!session) missing();
  const workspaceId = host.normalizeWorkspaceId(session!.workspaceId);
  if (options.workspaceId && host.normalizeWorkspaceId(options.workspaceId) !== workspaceId) missing();
  const runId = trace.durable!.runId!;
  const run = await host.storage.durableRuns.getRun(runId);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: runId,
    payload: run.payload,
  });
  const actorId = options.operatorId?.trim();
  if (
    !authority ||
    authority.capabilityProfileId ||
    authority.requestActor.actorKind !== "operator" ||
    authority.sessionId !== sessionId ||
    authority.turnId !== turnId ||
    authority.workspaceId !== workspaceId ||
    !actorId ||
    ![authority.requestActor.operatorId, authority.requestActor.authActorId].includes(actorId)
  )
    missing();
  const admitted = authority!;
  const identity = {
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    aggregateRevision: admitted.admissionAggregateRevision,
    controllerGeneration: admitted.admissionControllerGeneration,
    materialSha256: admitted.admissionMaterialSha256,
  };
  const [features, binding] = await Promise.all([
    host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
    host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
  ]);
  const context = features?.references.explicitContext;
  const expected = trace.routing.routedContext!;
  if (
    !features ||
    !context ||
    binding?.durableRunId !== runId ||
    features.referenceSha256 !== admitted.featureReferenceSha256 ||
    createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !== features.referenceSha256 ||
    context.snapshotId !== admitted.routedContextSnapshotId ||
    context.snapshotHash !== admitted.routedContextSnapshotHash ||
    context.snapshotId !== expected.snapshotId ||
    context.snapshotHash !== expected.snapshotHash
  )
    missing();
  // Scope and actor are checked before loading immutable source metadata/bytes.
  const snapshot = await host.storage.routedContextSnapshots.get(context!.snapshotId);
  const receipt = snapshot.admissionBinding;
  if (
    snapshot.schemaVersion !== CHAT_ROUTED_CONTEXT_ADMISSION_SNAPSHOT_VERSION ||
    !receipt ||
    snapshot.turnId !== turnId ||
    snapshot.sessionId !== sessionId ||
    snapshot.workspaceId !== workspaceId ||
    snapshot.snapshotHash !== expected.snapshotHash ||
    snapshot.contentHash !== expected.contentHash ||
    snapshot.sourceRequestHash !== expected.sourceRequestHash ||
    receipt.admissionId !== identity.admissionId ||
    receipt.sessionIncarnationId !== identity.sessionIncarnationId ||
    receipt.materialSha256 !== identity.materialSha256 ||
    receipt.aggregateRevision !== identity.aggregateRevision ||
    receipt.controllerGeneration !== identity.controllerGeneration
  )
    missing();
  await host.revalidateChatRoutedContextSnapshot(snapshot);
  return {
    state: "admission_bound",
    sessionId,
    turnId,
    workspaceId,
    routedContext: projectPublicSecretValue(projectChatRoutedContextInspection(snapshot)),
  };
}
