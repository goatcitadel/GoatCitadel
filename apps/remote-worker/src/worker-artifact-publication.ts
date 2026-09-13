import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE,
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
  canonicalJsonString,
  normalizeRemoteWorkerArtifactManifest,
  normalizeRemoteWorkerSettlementIdentity,
  remoteWorkerArtifactManifestSha256,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";

type ArtifactPhase = "open" | "part" | "commit";
export type WorkerArtifactCall = (
  phase: ArtifactPhase,
  submission: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

export async function callWorkerArtifact(
  context: RouteContext,
  lease: LeaseBinding,
  phase: ArtifactPhase,
  submission: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await callProtectedRoute({
    ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit",
    idempotencyKey: `artifact-${phase}:${lease.assignmentId}:${lease.assignmentGeneration}`,
    signal,
    payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...lease, submission },
  });
  if (response.body.disposition !== "artifact_recorded") throw new Error("Gateway did not record the artifact phase.");
  return object(response.body.upload);
}

/** Persist the exact upload intent before HTTP. A restart replays the same
 * manifest and expiry, and accepts completion only with Gateway verification. */
export async function publishWorkerChatArtifact(input: {
  state: WorkerDurableStatePort;
  lease: LeaseBinding;
  workload: Record<string, unknown>;
  lines: readonly string[];
  call: WorkerArtifactCall;
}): Promise<{ outputManifestSha256: string; resultSha256: string }> {
  const policy = object(input.workload.artifactPolicy);
  const profile = REMOTE_WORKER_CHAT_OUTPUT_PROFILE;
  const text = input.lines.join("");
  const bytes = Buffer.from(text, "utf8");
  if (
    !text.trim() ||
    bytes.length > profile.maxBytes ||
    input.workload.assignmentId !== input.lease.assignmentId ||
    input.workload.registryWorkspaceId !== input.lease.registryWorkspaceId ||
    policy.verifierProfileSha256 !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256 ||
    typeof policy.pathJailSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(policy.pathJailSha256) ||
    typeof policy.deadlineAt !== "string" ||
    !Number.isFinite(Date.parse(policy.deadlineAt))
  )
    throw new Error("Worker artifact lacks bounded, authenticated Chat output policy.");
  const blobSha256 = sha256Utf8(text);
  const logicalPathSha256 = sha256Utf8(canonicalJsonString({ logicalPath: profile.logicalPath }));
  const binding = {
    assignmentId: input.lease.assignmentId,
    assignmentGeneration: input.lease.assignmentGeneration,
    registryWorkspaceId: input.lease.registryWorkspaceId,
    assignmentManifestSha256: input.workload.assignmentManifestSha256,
    blobSha256,
    byteCount: bytes.length,
    pathJailSha256: policy.pathJailSha256,
    verifierProfileSha256: policy.verifierProfileSha256,
  };
  const stagingRootSha256 = sha256Utf8(canonicalJsonString(binding));
  const key = `artifact-${sha256Utf8(canonicalJsonString([input.lease.assignmentId, input.lease.assignmentGeneration]))}`;
  const retained = await input.state.read(key);
  const intent =
    retained === undefined
      ? {
          stagingRootSha256,
          expiresAt: new Date(Math.min(Date.parse(policy.deadlineAt), Date.now() + 300_000)).toISOString(),
        }
      : object(JSON.parse(retained));
  if (
    intent.stagingRootSha256 !== stagingRootSha256 ||
    typeof intent.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(intent.expiresAt))
  )
    throw new Error("Retained artifact intent changed.");
  if (retained === undefined) await input.state.write(key, canonicalJsonString(intent));
  const opened = await input.call("open", {
    kind: "artifact.open",
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: bytes.length,
    stagingRootSha256,
    expiresAt: intent.expiresAt,
  });
  const identity = normalizeRemoteWorkerSettlementIdentity(
    object(opened.identity) as unknown as RemoteWorkerSettlementIdentity,
  );
  if (
    identity.registryWorkspaceId !== input.lease.registryWorkspaceId ||
    identity.assignmentId !== input.lease.assignmentId ||
    identity.assignmentGeneration !== input.lease.assignmentGeneration ||
    identity.assignmentManifestSha256 !== input.workload.assignmentManifestSha256 ||
    typeof opened.uploadId !== "string" ||
    !opened.uploadId ||
    opened.stagingRootSha256 !== stagingRootSha256 ||
    opened.declaredFileCount !== 1 ||
    opened.declaredTotalBytes !== bytes.length ||
    opened.expiresAt !== intent.expiresAt
  )
    throw new Error("Gateway upload receipt does not match this artifact.");
  const manifest = normalizeRemoteWorkerArtifactManifest({
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity,
    pathJailSha256: policy.pathJailSha256,
    workerClaimIds: [],
    workerClaimSha256: sha256Utf8(canonicalJsonString([])),
    requiredVerifierProfileSha256: REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
    fileCount: 1,
    totalBytes: bytes.length,
    entries: [
      {
        entryIndex: 0,
        logicalPath: profile.logicalPath,
        logicalPathSha256,
        blobSha256,
        byteCount: bytes.length,
        mimeType: profile.mimeType,
      },
    ],
  });
  await input.call("part", {
    kind: "artifact.part",
    uploadId: opened.uploadId,
    part: {
      globalSequence: 1,
      logicalPathSha256,
      filePartIndex: 0,
      isFinalPart: true,
      partBytes: bytes.length,
      partSha256: blobSha256,
    },
  });
  const committed = await input.call("commit", {
    kind: "artifact.commit",
    uploadId: opened.uploadId,
    manifest,
    files: [
      {
        logicalPath: profile.logicalPath,
        logicalPathSha256,
        bytesBase64: bytes.toString("base64"),
        mimeType: profile.mimeType,
      },
    ],
  });
  const outputManifestSha256 = remoteWorkerArtifactManifestSha256(manifest);
  if (
    committed.uploadId !== opened.uploadId ||
    canonicalJsonString(committed.identity) !== canonicalJsonString(identity) ||
    committed.uploadState !== "committed" ||
    committed.committedManifestSha256 !== outputManifestSha256 ||
    committed.verificationGateState !== "satisfied"
  )
    throw new Error("Worker artifact has no matching Gateway verification receipt.");
  return { outputManifestSha256, resultSha256: blobSha256 };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker artifact receipt.");
  return value as Record<string, unknown>;
}
