import { remoteWorkerInferenceCanonicalSha256 } from "./remote-worker-inference.js";

/** Versioned server verifier for the bounded Chat-inference worker workload. */
export const REMOTE_WORKER_CHAT_OUTPUT_PROFILE = Object.freeze({
  version: "goatcitadel.remote-worker-chat-output.v1",
  logicalPath: "response.txt",
  mimeType: "text/plain",
  verifier: "exact_completed_inference_output",
  // Base64 plus the manifest must fit the execution route's 256 KiB payload.
  maxBytes: 131_072,
  uploadedCodeExecution: false,
  networkAccess: false,
});
export const REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256 = remoteWorkerInferenceCanonicalSha256(
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE,
);

/** Authenticated workload metadata. This grants no additional capability. */
export interface RemoteWorkerChatArtifactPolicy {
  readonly pathJailSha256: string;
  readonly verifierProfileSha256: string;
  readonly deadlineAt: string;
}
