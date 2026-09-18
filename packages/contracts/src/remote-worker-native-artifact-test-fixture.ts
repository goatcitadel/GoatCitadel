import { createHash } from "node:crypto";
import { normalizeRemoteWorkerNativeFileReceipt, REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA } from "./remote-worker-native-file-receipt.js";
import { REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, remoteWorkerNativeFileStagingSha256 } from "./remote-worker-native-file-disclosure.js";

/** Controlled receipt metadata for manifest/settlement tests, not native-origin evidence. */
export function nativeArtifactFixture(text = "native-result") {
  const bytes = Buffer.from(text), digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const identity = { registryWorkspaceId: "default", executionWorkspaceId: "execution", assignmentId: "native-artifact", assignmentGeneration: 1,
    workerId: "worker", workerGeneration: 1, runtimeManifestSha256: "11".repeat(32), workspaceCeilingSha256: "22".repeat(32),
    capabilityCeilingSha256: "33".repeat(32), assignmentManifestSha256: "44".repeat(32) };
  const fileStaging = { paths: ["out/report.txt"], maximumFileBytes: 1048576, maximumTotalBytes: 1048576 };
  const receipt = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
    disclosure: { schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts",
      registryWorkspaceId: "default", executionWorkspaceId: "execution", assignmentId: "native-artifact", assignmentGeneration: 1,
      nonce: "55".repeat(32), requestSha256: "66".repeat(32), pathJailSha256: "77".repeat(32), fileStagingSha256: remoteWorkerNativeFileStagingSha256(fileStaging) },
    fileStaging, resultSha256: "88".repeat(32), totalBytes: bytes.length, files: [{ selection: {
      schemaVersion: "goatcitadel.remote-worker-native-file-export.v1", registryWorkspaceId: "default", assignmentId: "native-artifact", assignmentGeneration: 1,
      nonce: "55".repeat(32), requestSha256: "66".repeat(32), resultSha256: "88".repeat(32),
      workDirectoryIdentityHex: "0100000000000000" + "99".repeat(16), fileIdentityHex: "0100000000000000" + "aa".repeat(16),
      logicalFileBytes: bytes.length, allocatedBytes: 4096, maximumBytes: 1048576, logicalPath: "out/report.txt" },
      recordSha256: digest("controlled-record"), contentSha256: digest(bytes) }] });
  return { receipt, identity, bytes };
}
