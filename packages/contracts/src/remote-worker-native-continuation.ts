/** Gateway-owned routing evidence. An approval decision alone is not admission,
 * execution, a retained result, or permission to complete the parent Chat turn. */
export interface RemoteWorkerNativeContinuation {
  readonly schemaVersion: "goatcitadel.remote-worker-native-continuation.v1";
  readonly assignmentGeneration: number;
  readonly resumeSha256: string;
  readonly approvalId: string;
  readonly approvalSha256: string;
  readonly nativeRuntimeBindingSha256: string;
  readonly decision: "approved" | "rejected";
}
export function normalizeRemoteWorkerNativeContinuation(input: unknown): RemoteWorkerNativeContinuation {
  const refused = () => new TypeError("Native continuation route is invalid.");
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const keys = ["schemaVersion", "assignmentGeneration", "resumeSha256", "approvalId", "approvalSha256", "nativeRuntimeBindingSha256", "decision"];
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !properties[key]?.enumerable || !("value" in properties[key]))) throw refused();
  const row = Object.fromEntries(keys.map(key => [key, properties[key]!.value]));
  if (row.schemaVersion !== "goatcitadel.remote-worker-native-continuation.v1" ||
      !Number.isSafeInteger(row.assignmentGeneration) || row.assignmentGeneration < 1 ||
      typeof row.approvalId !== "string" || row.approvalId !== row.approvalId.trim() || !row.approvalId || row.approvalId.length > 200 ||
      !["approved", "rejected"].includes(row.decision)) throw refused();
  for (const key of ["resumeSha256", "approvalSha256", "nativeRuntimeBindingSha256"])
    if (typeof row[key] !== "string" || !/^[0-9a-f]{64}$/u.test(row[key]) || /^0+$/u.test(row[key])) throw refused();
  return Object.freeze(row) as unknown as RemoteWorkerNativeContinuation;
}
