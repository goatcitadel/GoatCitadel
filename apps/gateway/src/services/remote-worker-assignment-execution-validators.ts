import { timingSafeEqual } from "node:crypto";
import { ConflictError, normalizeRemoteWorkerInstallationSubmission } from "@goatcitadel/contracts";
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
export type ExecutionRejectionDiagnostic = Readonly<
  | { stage: "artifact_admission"; reason: "lease_parent_dispatch_mismatch" | "other" }
  | { stage: "unclassified"; reason: "unclassified" }
>;
const UNCLASSIFIED_REJECTION: ExecutionRejectionDiagnostic = Object.freeze({ stage: "unclassified", reason: "unclassified" });

/** Internal only: never serialize this projection onto the protected wire. */
function snapshotRejectionDiagnostic(value: unknown): ExecutionRejectionDiagnostic {
  if (value === null || typeof value !== "object" || nodeUtilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return UNCLASSIFIED_REJECTION;
  const fields = Object.getOwnPropertyDescriptors(value);
  const stage = fields.stage?.value;
  const reason = fields.reason?.value;
  if (stage === "artifact_admission" && (reason === "lease_parent_dispatch_mismatch" || reason === "other")) {
    return Object.freeze({ stage, reason });
  }
  return UNCLASSIFIED_REJECTION;
}

export function classifyArtifactAdmissionRejection(error: unknown): ExecutionRejectionDiagnostic {
  // The real local AsyncStorage preserves ConflictError. Do not promote a
  // lookalike object or any other STATE_CONFLICT to the parent-fence reason.
  if (error !== null && typeof error === "object" && !nodeUtilTypes.isProxy(error) && error instanceof ConflictError) {
    const fields = Object.getOwnPropertyDescriptors(error);
    if (fields.code?.value === "STATE_CONFLICT" && fields.message?.value ===
      "remote worker assignment lease parent dispatch authority conflicts with durable assignment authority.") {
      return Object.freeze({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" });
    }
  }
  return Object.freeze({ stage: "artifact_admission", reason: "other" });
}

export function readExecutionRejectionDiagnostic(error: unknown): ExecutionRejectionDiagnostic {
  if (error === null || typeof error !== "object" || nodeUtilTypes.isProxy(error) ||
    !(error instanceof RemoteWorkerAssignmentExecutionProtocolError)) return UNCLASSIFIED_REJECTION;
  return snapshotRejectionDiagnostic(Object.getOwnPropertyDescriptor(error, "diagnostic")?.value);
}

export class RemoteWorkerAssignmentExecutionProtocolError extends Error {
  public readonly code = "REMOTE_WORKER_ASSIGNMENT_EXECUTION_PROTOCOL_REJECTED";
  public readonly diagnostic!: ExecutionRejectionDiagnostic;

  public constructor(message: string, diagnostic?: unknown) {
    super(message);
    this.name = "RemoteWorkerAssignmentExecutionProtocolError";
    Object.defineProperty(this, "diagnostic", { value: snapshotRejectionDiagnostic(diagnostic),
      enumerable: true, configurable: false, writable: false });
  }
}

export function rejected(message: string, diagnostic?: ExecutionRejectionDiagnostic): RemoteWorkerAssignmentExecutionProtocolError {
  return new RemoteWorkerAssignmentExecutionProtocolError(message, diagnostic);
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
