import {
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerInferenceUsageEventIdsSha256,
} from "@goatcitadel/contracts";
import type { RemoteWorkerInferencePerformOutcome } from "./remote-worker-inference-service.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

type InferenceRequestRecord = RemoteWorkerInferencePerformOutcome["request"];
type InferenceFrameRecord = RemoteWorkerInferencePerformOutcome["frames"][number];

/**
 * Secret-free wire projection of the HX-503 request record. The stored record
 * additionally carries server-internal budget reservation, policy revision,
 * approval-resolution, dispatch-claim, and effective-route material (including
 * provider credential fingerprints and per-token pricing); none of that may
 * cross to a remote worker, so the projection is an explicit allowlist rather
 * than an omission list.
 */
export interface RemoteWorkerInferenceExchangeRequestProjection {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly state: InferenceRequestRecord["state"];
  readonly governanceDecision: InferenceRequestRecord["governanceDecision"];
  readonly requestSha256: string;
  /** Hash only; enables worker frame-chain verification without exposing route credentials. */
  readonly effectiveRouteSha256: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly governanceOutputTokenCeiling: number;
  readonly governanceReasoningTokenCeiling: number;
  readonly governanceExpiresAt: string;
  /** Every canonical provider attempt, including output-cap recovery retries. */
  readonly usageEventIds?: readonly string[];
  readonly usageEventIdsSha256?: string;
}

/** Secret-free wire projection of one ordered provider-output frame. */
export interface RemoteWorkerInferenceExchangeFrameProjection {
  readonly frameSequence: number;
  readonly frameKind: InferenceFrameRecord["frameKind"];
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly previousFrameSha256: string;
  readonly frameSha256: string;
  readonly frameCharCount: number;
  readonly createdAt: string;
  readonly usageEventId?: string;
}

export function inferenceRequestProjection(
  record: InferenceRequestRecord,
): RemoteWorkerInferenceExchangeRequestProjection {
  return Object.freeze({
    registryWorkspaceId: record.registryWorkspaceId,
    assignmentId: record.assignmentId,
    assignmentGeneration: record.assignmentGeneration,
    inferenceRequestId: record.inferenceRequestId,
    attempt: record.attempt,
    state: record.state,
    governanceDecision: record.governanceDecision,
    requestSha256: record.requestSha256,
    effectiveRouteSha256: record.effectiveRouteSha256,
    outputTokenCeiling: record.outputTokenCeiling,
    reasoningTokenCeiling: record.reasoningTokenCeiling,
    governanceOutputTokenCeiling: record.governanceOutputTokenCeiling,
    governanceReasoningTokenCeiling: record.governanceReasoningTokenCeiling,
    governanceExpiresAt: record.governanceExpiresAt,
    ...inferenceUsageProjection(record),
  });
}

function inferenceUsageProjection(
  record: InferenceRequestRecord,
): Pick<RemoteWorkerInferenceExchangeRequestProjection, "usageEventIds" | "usageEventIdsSha256"> {
  if (record.usageEventIdsJson === undefined && record.usageEventIdsSha256 === undefined) return {};
  try {
    if (typeof record.usageEventIdsJson !== "string" || record.usageEventIdsJson.length > 65_536) {
      throw new Error("Usage receipt is unavailable.");
    }
    const ids = normalizeRemoteWorkerInferenceUsageEventIds(JSON.parse(record.usageEventIdsJson));
    if (remoteWorkerInferenceUsageEventIdsSha256(ids) !== record.usageEventIdsSha256) {
      throw new Error("Usage receipt hash mismatch.");
    }
    return { usageEventIds: ids, usageEventIdsSha256: record.usageEventIdsSha256 };
  } catch {
    throw rejected("Remote worker inference usage receipt is invalid.");
  }
}

export function inferenceFrameProjection(record: InferenceFrameRecord): RemoteWorkerInferenceExchangeFrameProjection {
  return Object.freeze({
    frameSequence: record.frameSequence,
    frameKind: record.frameKind,
    payloadJson: record.payloadJson,
    payloadSha256: record.payloadSha256,
    previousFrameSha256: record.previousFrameSha256,
    frameSha256: record.frameSha256,
    frameCharCount: record.frameCharCount,
    createdAt: record.createdAt,
    ...(record.usageEventId === undefined ? {} : { usageEventId: record.usageEventId }),
  });
}
