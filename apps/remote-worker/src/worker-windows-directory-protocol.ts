import { assertWorkerLocalPathPart } from "./worker-local-file-reader.js";
import { workerMeshRejected } from "./worker-mesh-capability-data.js";

export const WORKER_DIRECTORY_MAX_ENTRIES = 128;
export const WORKER_DIRECTORY_RESPONSE_BYTES = 44 + 32768;
export interface WindowsWorkerDirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "unavailable";
}
export interface WindowsWorkerDirectoryResult {
  readonly rootIdentity: string;
  readonly entries: readonly WindowsWorkerDirectoryEntry[];
  readonly truncated: boolean;
}
export class WindowsWorkerDirectoryRefusedError extends Error {
  constructor() { super("The native directory owner refused this read."); }
}

/** The helper's bounded binary receipt contains names/types only, never file contents. */
export function decodeWindowsWorkerDirectoryResult(response: Buffer, rootIdentity: string): WindowsWorkerDirectoryResult {
  if (response.length < 44 || response.length > WORKER_DIRECTORY_RESPONSE_BYTES ||
    !response.subarray(0, 8).equals(Buffer.from("GCFLIST1", "ascii")) ||
    response.readUInt32LE(12) > 1 || response.readUInt32LE(16) > WORKER_DIRECTORY_MAX_ENTRIES ||
    !/^[a-f0-9]{48}$/u.test(rootIdentity) || /^0+$/u.test(rootIdentity)) throw workerMeshRejected();
  const count = response.readUInt32LE(16), truncated = response.readUInt32LE(12) === 1;
  const returnedIdentity = response.subarray(20, 44).toString("hex");
  if (response.readUInt32LE(8) !== 0) {
    if (response.length !== 44 || count !== 0 || truncated || (returnedIdentity !== rootIdentity && !/^0+$/u.test(returnedIdentity)))
      throw workerMeshRejected();
    throw new WindowsWorkerDirectoryRefusedError();
  }
  if (returnedIdentity !== rootIdentity) throw workerMeshRejected();
  if (truncated && count === 0) throw workerMeshRejected();
  let offset = 44;
  const entries: WindowsWorkerDirectoryEntry[] = [], names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 8 > response.length) throw workerMeshRejected();
    const kind = response.readUInt32LE(offset), length = response.readUInt32LE(offset + 4);
    offset += 8;
    if (kind < 1 || kind > 3 || length < 1 || length > 1024 || offset + length > response.length) throw workerMeshRejected();
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.subarray(offset, offset + length)); }
    catch { throw workerMeshRejected(); }
    assertWorkerLocalPathPart(name);
    if (names.has(name)) throw workerMeshRejected();
    names.add(name);
    entries.push({ name, type: kind === 1 ? "file" : kind === 2 ? "directory" : "unavailable" });
    offset += length;
  }
  if (offset !== response.length) throw workerMeshRejected();
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { rootIdentity, entries, truncated };
}
