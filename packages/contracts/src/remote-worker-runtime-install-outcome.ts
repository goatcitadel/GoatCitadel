import { sha256BytesHex } from "./sha256.js";
import { normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellProvisioningCheckpoint,
  type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { normalizeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256 } from "./remote-worker-runtime-install.js";

export interface RemoteWorkerRuntimeInstallOutcome {
  readonly nonce: string;
  readonly requestSha256: string;
  readonly checkpointSha256: string;
  readonly intentSha256: string;
  readonly outcomeSha256: string | null;
  readonly installation: Readonly<{ error: number; verified: boolean; filesCreated: number; directoriesCreated: number; bytesWritten: number }> | null;
}
const refused = () => new TypeError("Native installation outcome differs from its independently retained request and journal.");
function digest(domain: string, bytes: Uint8Array): string {
  const prefix = new TextEncoder().encode(`${domain}\0`), input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length); return sha256BytesHex(input);
}

/** Decodes the native GCRLI001 intent and optional sealed GCRLIT01 outcome.
 * A valid intent alone means uncertain installation, never permission to retry.
 * Hashes bind bytes; authenticated custody and canonical admission are separate
 * caller obligations. Even verified copying does not establish worker readiness. */
export function readRemoteWorkerRuntimeInstallOutcome(input: unknown, suppliedRequest: unknown,
  suppliedHistory: RemoteWorkerCellProvisioningExchange): RemoteWorkerRuntimeInstallOutcome {
  if (typeof input !== "string" || ![512, 704].includes(input.length) || !/^[0-9a-f]+$/u.test(input)) throw refused();
  const request = normalizeRemoteWorkerRuntimeInstallRequest(suppliedRequest);
  const history = normalizeRemoteWorkerCellProvisioningExchange(suppliedHistory);
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  if (history.mountedWorkspaceRecords?.length !== 2 || request.journalIdentityHex !== first.journalIdentityHex ||
      request.preparedSha256 !== first.recordSha256 || request.checkpointSha256 !== history.mountedWorkspaceRecords[1]!.slice(-64)) throw refused();
  const bytes = Uint8Array.from({ length: input.length / 2 }, (_, index) => Number.parseInt(input.slice(index * 2, index * 2 + 2), 16));
  const hex = (offset: number, size: number) => input.slice(offset * 2, (offset + size) * 2);
  const magic = (offset: number, expected: string) => expected.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  const requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request);
  if (!magic(0, "GCRLI001") || hex(8, 32) !== request.nonce || hex(40, 32) !== requestSha256 ||
      hex(72, 32) !== request.checkpointSha256 || hex(104, 24) !== request.journalIdentityHex ||
      hex(128, 32) !== request.preparedSha256 || hex(160, 32) !== history.plan.assignmentBindingSha256 ||
      hex(192, 32) !== history.plan.profileSha256) throw refused();
  const intentSha256 = digest("goatcitadel.worker-runtime-install-local-intent.v1", bytes.subarray(0, 224));
  if (hex(224, 32) !== intentSha256) throw refused();
  const base = { nonce: request.nonce, requestSha256, checkpointSha256: request.checkpointSha256, intentSha256 };
  if (bytes.length === 256) return Object.freeze({ ...base, outcomeSha256: null, installation: null });
  const view = new DataView(bytes.buffer), u32 = (offset: number) => view.getUint32(offset, true);
  const error = u32(264), verified = u32(268), filesCreated = u32(272), directoriesCreated = u32(276);
  const count = view.getBigUint64(280, true), total = request.runtimeBundle.files.reduce((sum, file) => sum + BigInt(file.bytes), 0n);
  if (!magic(256, "GCRLIT01") || hex(288, 32) !== intentSha256 || verified > 1 || filesCreated > 2 || directoriesCreated !== 0 || count > total ||
      (verified === 1 && (error !== 0 || filesCreated !== 2 || count !== total)) || (error === 0 && verified !== 1)) throw refused();
  const outcomeSha256 = digest("goatcitadel.worker-runtime-install-local-outcome.v1", bytes.subarray(0, 320));
  if (hex(320, 32) !== outcomeSha256) throw refused();
  return Object.freeze({ ...base, outcomeSha256,
    installation: Object.freeze({ error, verified: verified === 1, filesCreated, directoriesCreated, bytesWritten: Number(count) }) });
}
