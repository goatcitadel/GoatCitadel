import { assertRemoteWorkerLogicalPath, remoteWorkerLogicalPathCollisionKey } from "./remote-worker-settlement.js";

/** Explicit local collection policy. This does not authorize file disclosure. */
export interface RemoteWorkerNativeFileStaging {
  readonly paths: readonly string[];
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
}
export function normalizeRemoteWorkerNativeFileStaging(input: unknown): RemoteWorkerNativeFileStaging {
  const invalid = () => new TypeError("Native file staging requires exact bounded relative paths and byte limits.");
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const keys = ["paths", "maximumFileBytes", "maximumTotalBytes"] as const;
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw invalid();
  const supplied = fields.paths!.value;
  if (!Array.isArray(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype || !supplied.length || supplied.length > 64) throw invalid();
  const entries = Object.getOwnPropertyDescriptors(supplied);
  if (Reflect.ownKeys(supplied).length !== supplied.length + 1) throw invalid();
  const paths: string[] = [], collisions = new Set<string>();
  for (let index = 0; index < supplied.length; ++index) {
    const entry = entries[String(index)];
    if (!entry?.enumerable || !("value" in entry)) throw invalid();
    const path = assertRemoteWorkerLogicalPath(entry.value);
    if (/[<>"|?*]/u.test(path) || new TextDecoder().decode(new TextEncoder().encode(path)) !== path ||
        path.split("/").some(part => /^(?:conin\$|conout\$)(?:\.|$)/iu.test(part))) throw invalid();
    const collision = remoteWorkerLogicalPathCollisionKey(path);
    if (collisions.has(collision)) throw invalid();
    collisions.add(collision); paths.push(path);
  }
  const maximumFileBytes: unknown = fields.maximumFileBytes!.value, maximumTotalBytes: unknown = fields.maximumTotalBytes!.value;
  const bounded = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
  if (!bounded(maximumFileBytes, 1048576) || !bounded(maximumTotalBytes, 64 * 1048576)) throw invalid();
  return Object.freeze({ paths: Object.freeze(paths), maximumFileBytes, maximumTotalBytes });
}
