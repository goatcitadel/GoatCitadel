import { canonicalJsonString, type DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  readChatTurnRuntimeAuthoritySeal,
  readExactGeneralChatPostCommitSettlement,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
} from "./chat-durable-runtime-authority.js";
import {
  AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
} from "./chat-durable-run-service.js";

/** Shared by canonical queue transitions and worker approval handoff. A valid
 * seal alone is insufficient: its exact waiting finalizers must have settled. */
export async function verifySettledChatWaitingAuthority(
  storage: Pick<AsyncStorage, "durableRuns">,
  run: DurableRunRecord,
) {
  const metadata = run.metadata ?? {};
  const authority = readChatTurnRuntimeAuthoritySeal(metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
  if (!authority || authority.material.transitionKind !== "waiting" ||
    authority.material.durableStatus !== "waiting" || authority.material.runId !== run.runId ||
    authority.material.turnId !== run.payload?.turnId) {
    throw new Error(`Admitted Chat run ${run.runId} has no exact waiting runtime authority.`);
  }
  if (canonicalJsonString(metadata.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent))
    throw new Error(`Admitted Chat run ${run.runId} wait registration drifted from its runtime authority.`);
  const waitingCheckpoint = await storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting");
  if (!waitingCheckpoint)
    throw new Error(`Admitted Chat run ${run.runId} has no authority-anchored waiting checkpoint.`);
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, waitingCheckpoint.state);
  if (metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined)
    throw new Error(`Admitted Chat run ${run.runId} cannot queue before its waiting generation settles.`);
  if (metadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
    metadata.linkedFinalizationPending !== undefined || metadata.chatTurnAdmissionHandoff !== undefined)
    throw new Error(`Admitted Chat run ${run.runId} carries terminal finalization evidence while waiting.`);
  const settlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
  if (!settlement || settlement.generationId !== authority.material.postCommitGenerationId ||
    settlement.traceStatus !== authority.material.traceStatus ||
    settlement.requestedAt !== authority.material.transitionAt || settlement.settlementStatus !== "completed" ||
    typeof settlement.completedAt !== "string" ||
    canonicalJsonString(settlement.postCommitEligibility) !== canonicalJsonString(authority.material.postCommitEligibility))
    throw new Error(`Admitted Chat run ${run.runId} has no exact settled waiting generation.`);
  return { authority, waitingCheckpoint };
}
