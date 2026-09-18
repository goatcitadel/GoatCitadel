import { normalizeRemoteWorkerRuntimeCleanupExchange, normalizeRemoteWorkerRuntimeCleanupHistory,
  type RemoteWorkerRuntimeCleanupHistory } from "./remote-worker-runtime-cleanup.js";
import { readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor } from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint } from "./remote-worker-cell-mounted-workspace.js";
import { sha256BytesHex } from "./sha256.js";

/** GCCLEAN1: 252-byte common header followed by 108-byte ordered expectations.
 * The independently delivered digest/challenge binds the entire set. Encoding
 * does not establish protected transport, writer custody or measurement authority. */
export function encodeRemoteWorkerRuntimeCleanup(input: unknown) {
  const value = normalizeRemoteWorkerRuntimeCleanupExchange(input);
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...history } = value.history;
  return encode({ challenge: value.challenge, history, expectations: value.expectations });
}
export function encodeRemoteWorkerRuntimeCleanupHistory(input: unknown) {
  return encode(normalizeRemoteWorkerRuntimeCleanupHistory(input));
}
function encode(value: RemoteWorkerRuntimeCleanupHistory) {
  const history = value.history;
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const mounted = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords![1]);
  const bytes = new Uint8Array(252 + 108 * value.expectations.length), view = new DataView(bytes.buffer);
  const put = (offset: number, hex: string) => {
    for (let index = 0; index < hex.length / 2; index++) bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  };
  bytes.set(new TextEncoder().encode("GCCLEAN1")); put(8, value.challenge);
  put(40, first.journalIdentityHex); put(64, first.recordSha256); put(96, mounted.recordSha256);
  put(128, mounted.workspaceCheckpoint.rootIdentityHex);
  mounted.workspaceCheckpoint.directoryIdentityHex.forEach((identity, index) => put(152 + index * 24, identity));
  view.setUint32(248, value.expectations.length, true);
  value.expectations.forEach((expected, index) => {
    const offset = 252 + index * 108;
    put(offset, expected.nonce); put(offset + 32, expected.requestSha256); put(offset + 64, expected.runtimeBundleSha256);
    view.setUint32(offset + 96, expected.maxInputBytes, true); view.setUint32(offset + 100, expected.maxOutputBytes, true);
    view.setUint32(offset + 104, expected.maxInventoryEntries, true);
  });
  const domain = new TextEncoder().encode("goatcitadel.worker-runtime-cleanup.v1\0"), material = new Uint8Array(domain.length + bytes.length);
  material.set(domain); material.set(bytes, domain.length);
  return Object.freeze({ challenge: value.challenge, setSha256: sha256BytesHex(material),
    bytesHex: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") });
}
