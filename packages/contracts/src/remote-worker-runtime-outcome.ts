import { normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerRuntimeResultExchange, type RemoteWorkerRuntimeResultExchange } from "./remote-worker-runtime-result-pages.js";
import type { RemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";

export const REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA = "goatcitadel.remote-worker-runtime-outcome.v1" as const;
export interface RemoteWorkerRuntimeOutcomeSubmission {
  readonly kind: "runtime.outcome.read"; readonly nonce: string; readonly requestSha256: string; readonly challenge: string;
}
const CHECKS = ["bindingVerified", "runtimeBundleVerified", "protectedWorkspaceVerified", "inventoryVerified", "zeroProcessesVerified",
  "outputDrained", "captureVerified", "stdinComplete", "stdoutTruncated", "stderrTruncated"] as const;
export interface RemoteWorkerRuntimeOutcome {
  readonly end: RemoteWorkerRuntimeResult["end"];
  readonly error: number;
  readonly exitCode: number;
  readonly checks: Readonly<Pick<RemoteWorkerRuntimeResult["flags"], typeof CHECKS[number]>>;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly inventoryEntries: number | null;
}
/** Retained observations only. This is neither Chat completion nor retry authority. */
export interface RemoteWorkerRuntimeOutcomeExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA;
  readonly challenge: string;
  readonly lookup: RemoteWorkerRuntimeResultExchange;
  readonly outcome: RemoteWorkerRuntimeOutcome | null;
}
const refused = () => new TypeError("Native runtime outcome binding is invalid.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !properties[key]?.enumerable || !("value" in properties[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, properties[key]!.value]));
}
function challenge(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw refused(); return value;
}
export function normalizeRemoteWorkerRuntimeOutcomeSubmission(input: unknown): RemoteWorkerRuntimeOutcomeSubmission {
  const value = fields(input, ["kind", "nonce", "requestSha256", "challenge"]);
  if (value.kind !== "runtime.outcome.read") throw refused();
  const lookup = normalizeRemoteWorkerRuntimeResultSubmission({ kind: "runtime.result.lookup", nonce: value.nonce, requestSha256: value.requestSha256 });
  return Object.freeze({ kind: value.kind, nonce: lookup.nonce, requestSha256: lookup.requestSha256, challenge: challenge(value.challenge) });
}
export function normalizeRemoteWorkerRuntimeOutcomeExchange(input: unknown): RemoteWorkerRuntimeOutcomeExchange {
  const value = fields(input, ["schemaVersion", "challenge", "lookup", "outcome"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA) throw refused();
  const lookup = normalizeRemoteWorkerRuntimeResultExchange(value.lookup);
  if (lookup.accepted !== null || (lookup.record === null) !== (value.outcome === null)) throw refused();
  const outcome = value.outcome === null ? null : normalizeRemoteWorkerRuntimeOutcome(value.outcome);
  return Object.freeze({ schemaVersion: value.schemaVersion, challenge: challenge(value.challenge), lookup, outcome });
}
export function normalizeRemoteWorkerRuntimeOutcome(input: unknown): RemoteWorkerRuntimeOutcome {
    const row = fields(input, ["end", "error", "exitCode", "checks", "stdinBytes", "stdoutBytes", "stderrBytes", "inventoryEntries"]);
    if (!["exited", "cancelled", "wall_limit", "output_limit", "launch_failed", "control_failed"].includes(row.end as string)) throw refused();
    const checks = fields(row.checks, CHECKS);
    if (CHECKS.some(key => typeof checks[key] !== "boolean")) throw refused();
    const stdoutBytes = integer(row.stdoutBytes, 67108864), stderrBytes = integer(row.stderrBytes, 67108864);
    if (stdoutBytes + stderrBytes > 67108864 || (checks.inventoryVerified === false) !== (row.inventoryEntries === null)) throw refused();
    return Object.freeze({ end: row.end as RemoteWorkerRuntimeResult["end"], error: integer(row.error, 0xffffffff), exitCode: integer(row.exitCode, 0xffffffff),
      checks: Object.freeze(checks) as RemoteWorkerRuntimeOutcome["checks"], stdinBytes: integer(row.stdinBytes, 1048576), stdoutBytes, stderrBytes,
      inventoryEntries: row.inventoryEntries === null ? null : integer(row.inventoryEntries, 20000) });
}
export function projectRemoteWorkerRuntimeOutcome(result: RemoteWorkerRuntimeResult): RemoteWorkerRuntimeOutcome {
  return { end: result.end, error: result.error, exitCode: result.exitCode,
    checks: Object.fromEntries(CHECKS.map(key => [key, result.flags[key]])) as unknown as RemoteWorkerRuntimeOutcome["checks"],
    stdinBytes: result.stdinBytes, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, inventoryEntries: result.inventory?.entries.length ?? null };
}
