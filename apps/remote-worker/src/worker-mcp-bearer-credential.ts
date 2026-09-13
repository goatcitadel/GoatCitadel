import { createHash } from "node:crypto";
import { readWorkerLocalFile } from "./worker-local-file-reader.js";
import { snapshotWorkerMeshValue, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";

export interface WorkerMcpBearerCredentialReference {
  readonly type: "bearer_file";
  readonly file: string;
  readonly sha256: string;
}

export interface WorkerMcpBearerCredential {
  readonly authorization: string;
  assertCurrent(signal: AbortSignal): Promise<void>;
  assertOutputSafe(value: unknown): void;
}

export function workerMcpBearerReference(value: unknown): WorkerMcpBearerCredentialReference {
  const reference = workerMeshRecord(snapshotWorkerMeshValue(value, 16 * 1024, true), ["type", "file", "sha256"]);
  if (reference.type !== "bearer_file" || typeof reference.file !== "string" ||
    typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(reference.sha256)) throw workerMeshRejected();
  return reference as unknown as WorkerMcpBearerCredentialReference;
}

/** A separately configured operator credential, never the Gateway enrollment or
 * assignment credential. The file's OS access control remains operator-owned. */
export async function loadWorkerMcpBearerCredential(
  value: unknown, assertConfigurationCurrent: (signal: AbortSignal) => Promise<void>, signal: AbortSignal,
): Promise<WorkerMcpBearerCredential> {
  const reference = workerMcpBearerReference(value);
  const read = async (currentSignal: AbortSignal): Promise<string> => {
    const bytes = await readWorkerLocalFile(reference.file, 16 * 1024, currentSignal,
      async () => assertConfigurationCurrent(currentSignal));
    try {
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw workerMeshRejected();
      const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (token.length < 16 || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+={0,2}$/u.test(token)) throw workerMeshRejected();
      return token;
    } catch {
      throw workerMeshRejected();
    } finally {
      bytes.fill(0);
    }
  };
  const token = await read(signal);
  return Object.freeze({
    authorization: `Bearer ${token}`,
    assertCurrent: async (currentSignal: AbortSignal) => {
      if (await read(currentSignal) !== token) throw workerMeshRejected();
    },
    assertOutputSafe: (output: unknown) => {
      // Successful tool output can otherwise echo its request headers into Chat.
      if (JSON.stringify(output).includes(token)) throw workerMeshRejected();
    },
  });
}
