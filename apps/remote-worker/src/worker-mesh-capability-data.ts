import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJsonString } from "@goatcitadel/contracts";

export const WORKER_MESH_MAX_INPUT_BYTES = 256 * 1024;
export const WORKER_MESH_MAX_OUTPUT_BYTES = 64 * 1024;
export const WORKER_MESH_MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const workerMeshHash = (value: unknown): string => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export const workerMeshRejected = (): Error => new Error("Worker mesh execution evidence is invalid or requires reconciliation.");

/** Inspect descriptors before serialization so caller code, proxies and cycles cannot run at this boundary. */
export function snapshotWorkerMeshValue<T>(value: T, maxBytes: number, freeze = false): T {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new Set<object>();
  const walk = (current: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw workerMeshRejected();
    if (typeof current === "string") {
      textBytes += Buffer.byteLength(current, "utf8");
      if (textBytes > maxBytes) throw workerMeshRejected();
      return;
    }
    if (current === null || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) return;
    if (!current || typeof current !== "object" || types.isProxy(current) || ancestors.has(current)) throw workerMeshRejected();
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype :
      ![Object.prototype, null].includes(Object.getPrototypeOf(current) as object | null)) throw workerMeshRejected();
    const fields = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(current).some((key) => typeof key !== "string")) throw workerMeshRejected();
    ancestors.add(current);
    for (const [key, descriptor] of Object.entries(fields)) {
      if (array && key === "length") continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length))) throw workerMeshRejected();
      textBytes += Buffer.byteLength(key, "utf8");
      if (textBytes > maxBytes) throw workerMeshRejected();
      walk(descriptor.value, depth + 1);
    }
    if (array && Object.keys(fields).length !== current.length + 1) throw workerMeshRejected();
    ancestors.delete(current);
  };
  walk(value, 0);
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw workerMeshRejected();
  const copy = JSON.parse(encoded) as T;
  const freezeDeep = (current: unknown): void => {
    if (current && typeof current === "object") {
      for (const item of Object.values(current)) freezeDeep(item);
      Object.freeze(current);
    }
  };
  if (freeze) freezeDeep(copy);
  return copy;
}

export function workerMeshRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workerMeshRejected();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !optional.includes(key) && !Object.hasOwn(record, key)))
    throw workerMeshRejected();
  return record;
}
