import { timingSafeEqual } from "node:crypto";
import { normalizeRemoteWorkerInstallationSubmission } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerRuntimeCleanupSubmission } from "@goatcitadel/contracts";
import { types as nodeUtilTypes } from "node:util";
import { normalizeRemoteWorkerRuntimeInstallSelectionSubmission, normalizeRemoteWorkerRuntimeInstallSubmission, normalizeRemoteWorkerRuntimeOutputSubmission, redactSecretText, normalizeRemoteWorkerRuntimeOutcomeSubmission,
  normalizeRemoteWorkerRuntimeRequestPageSubmission, normalizeRemoteWorkerRuntimeAuthorizationSubmission,
  normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerNativeFileReconciliationSubmission, normalizeRemoteWorkerNativeFileGrantSubmission,
  normalizeRemoteWorkerNativeFileTransferBegin, normalizeRemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";

/**
 * Bounded, secret-free value validators for the routes 11-12 protected wire.
 *
 * These are deliberately leaf functions with no service dependencies: every
 * rejection is a fixed message with no interpolated attacker input beyond a
 * static field label, so a failure can never echo request material back to a
 * remote worker. They live beside the protocol owner rather than inside it so
 * the owner file stays reviewable.
 */
export class RemoteWorkerAssignmentExecutionProtocolError extends Error {
  public readonly code = "REMOTE_WORKER_ASSIGNMENT_EXECUTION_PROTOCOL_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAssignmentExecutionProtocolError";
  }
}

export function rejected(message: string): RemoteWorkerAssignmentExecutionProtocolError {
  return new RemoteWorkerAssignmentExecutionProtocolError(message);
}

export function exactOwnDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw rejected(`Remote worker ${label} is invalid.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((name) => !(name in descriptors)) ||
    (keys as string[]).some((name) => !allowed.has(name)) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) result[key] = descriptors[key]?.value;
  return result;
}

export function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
}

export function identifier(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw rejected(`Remote worker assignment execution ${field} is invalid.`);
  }
  return value;
}

export function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw rejected(`Remote worker assignment execution ${field} is invalid.`);
  }
  return value as number;
}

export function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw rejected(`Remote worker assignment execution ${field} is invalid.`);
  }
  return value;
}

export function canonical32ByteSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw rejected(`Remote worker assignment execution ${field} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
      throw rejected(`Remote worker assignment execution ${field} is invalid.`);
    }
  } finally {
    decoded.fill(0);
  }
  return value;
}

/**
 * Canonical unpadded/padded base64 file body. The ceiling is the contract's own
 * part-body bound rather than a looser local number, so the boundary refuses
 * at the same edge storage would.
 */
export function base64Bytes(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw rejected("Remote worker assignment execution file bytes are invalid.");
  }
  return value;
}

export function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw rejected(`Remote worker assignment execution ${field} is invalid.`);
  }
  return value;
}

export function snapshotClock(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw rejected("Remote worker assignment execution clock is invalid.");
  }
  return new Date(value.getTime());
}

export function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Native settlement selectors share the protected wire's fixed-error boundary. */
export function normalizeNativeRuntimeSettlementSubmission(value: unknown, kind: unknown, rawLeaseToken: string) {
  if (kind === "runtime.install.session") {
    try { return normalizeRemoteWorkerInstallationSubmission(value); }
    catch { throw rejected("Installation session submission is invalid."); }
  }
  if (kind === "runtime.cleanup.read") {
    try { return normalizeRemoteWorkerRuntimeCleanupSubmission(value); }
    catch { throw rejected("Native cleanup submission is invalid."); }
  }
  if (kind === "runtime.install.select") {
    try { return normalizeRemoteWorkerRuntimeInstallSelectionSubmission(value); }
    catch { throw rejected("Worker installation selection is invalid."); }
  }
  if (kind === "runtime.install.lookup" || kind === "runtime.install.retain") {
    try { return normalizeRemoteWorkerRuntimeInstallSubmission(value); }
    catch { throw rejected("Worker installation evidence submission is invalid."); }
  }
  if (kind === "runtime.output.retain") {
    try {
      const submission = normalizeRemoteWorkerRuntimeOutputSubmission(value);
      if (Object.values(submission.evidence.streams).some(stream => redactSecretText(stream.text,
        { env: { WORKER_LEASE_TOKEN: rawLeaseToken }, redactEmailAddresses: true }).value !== stream.text)) throw rejected("Unredacted native output.");
      return submission;
    } catch { throw rejected("Native output submission is invalid."); }
  }
  if (kind === "runtime.outcome.read") {
    try { return normalizeRemoteWorkerRuntimeOutcomeSubmission(value); }
    catch { throw rejected("Native outcome lookup is invalid."); }
  }
  if (kind === "runtime.request.page") {
    try { return normalizeRemoteWorkerRuntimeRequestPageSubmission(value); }
    catch { throw rejected("Native request page selection is invalid."); }
  }
  if (kind === "runtime.authorize") {
    try { return normalizeRemoteWorkerRuntimeAuthorizationSubmission(value); }
    catch { throw rejected("Native runtime authorization request is invalid."); }
  }
  if (kind === "runtime.result.page" || kind === "runtime.result.lookup") {
    try { return normalizeRemoteWorkerRuntimeResultSubmission(value); }
    catch { throw rejected("Worker runtime result submission is invalid."); }
  }
  if (kind === "runtime.files.reconcile") {
    try { return normalizeRemoteWorkerNativeFileReconciliationSubmission(value); }
    catch { throw rejected("Native file reconciliation request is invalid."); }
  }
  if (kind === "runtime.file.authorize") {
    try { return normalizeRemoteWorkerNativeFileGrantSubmission(value); }
    catch { throw rejected("Native file authorization request is invalid."); }
  }
  if (kind === "runtime.files.begin" || kind === "runtime.files.page") {
    try { return kind === "runtime.files.begin" ? normalizeRemoteWorkerNativeFileTransferBegin(value) : normalizeRemoteWorkerNativeFileTransferPage(value); }
    catch { throw rejected("Native file transfer request is invalid."); }
  }
  return null;
}
