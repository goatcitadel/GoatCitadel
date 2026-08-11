import { canonicalJsonString } from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";

/**
 * The reusable M2 runtime credential the worker retains after a one-time
 * bootstrap exchange. This is the ONLY authority the worker replays to
 * reconnect: the `authorizationCredential` bearer, the credential
 * id/generation, the worker generation, the transport digests, and the
 * Ed25519 signing key (the "protected PoP-v2 signing pin"). The one-time
 * bootstrap secret is deliberately absent — there is no field for it and no
 * API to store it, so a reconnect or restart can never replay it.
 */
export interface RetainedRuntimeCredential {
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly workerGeneration: number;
  readonly registryWorkspaceId: string;
  /** 32-byte base64url bearer secret sent as `Authorization: Bearer <credential>`. */
  readonly authorizationCredential: string;
  readonly clientCertificateSha256: string;
  readonly workerPublicKeySpkiSha256: string;
  /** PEM-encoded Ed25519 private key — the signing pin for every protected PoP-v2 proof. */
  readonly signingPrivateKeyPem: string;
}

/** A per-assignment lease the worker holds while executing dispatched work. */
export interface RetainedAssignmentLease {
  readonly assignmentId: string;
  /** Worker-created 32-byte base64url secret. Gateway only ever sees its hash. */
  readonly rawLeaseToken: string;
  readonly leaseRevision: number;
  readonly assignmentGeneration: number;
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,510}[A-Za-z0-9])?$/u;

const CREDENTIAL_KEY = "runtime-credential";
const LEASES_KEY = "assignment-leases";

const FORBIDDEN_CREDENTIAL_FIELDS = Object.freeze([
  "bootstrapSecret",
  "bootstrap_secret",
  "bootstrapToken",
  "oneTimeSecret",
]);

export class WorkerCredentialVaultError extends Error {
  readonly code = "REMOTE_WORKER_CREDENTIAL_VAULT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerCredentialVaultError";
  }
}

/**
 * Durable custody of the worker's reusable credential, signing key, and active
 * leases. Every mutation is persisted so a restarted worker re-hydrates the
 * exact retained authority without re-running admission.
 */
export class WorkerCredentialVault {
  private constructor(
    private readonly state: WorkerDurableStatePort,
    private credential: RetainedRuntimeCredential | undefined,
    private readonly leases: Map<string, RetainedAssignmentLease>,
  ) {}

  static async open(state: WorkerDurableStatePort): Promise<WorkerCredentialVault> {
    const credentialRaw = await state.read(CREDENTIAL_KEY);
    const leasesRaw = await state.read(LEASES_KEY);
    const credential = credentialRaw === undefined ? undefined : normalizeCredential(JSON.parse(credentialRaw));
    const leases = new Map<string, RetainedAssignmentLease>();
    if (leasesRaw !== undefined) {
      const parsed: unknown = JSON.parse(leasesRaw);
      if (!Array.isArray(parsed)) throw new WorkerCredentialVaultError("Retained leases are corrupt.");
      for (const entry of parsed) {
        const lease = normalizeLease(entry);
        leases.set(lease.assignmentId, lease);
      }
    }
    return new WorkerCredentialVault(state, credential, leases);
  }

  hasCredential(): boolean {
    return this.credential !== undefined;
  }

  getCredential(): RetainedRuntimeCredential {
    if (this.credential === undefined) {
      throw new WorkerCredentialVaultError("No runtime credential is retained; admission has not completed.");
    }
    return this.credential;
  }

  /**
   * Retain the credential produced by a one-time bootstrap exchange. The input
   * is rejected if it smuggles a bootstrap-secret-shaped field, guaranteeing
   * the vault never becomes a replay source for the one-time secret.
   */
  async retainCredential(credential: RetainedRuntimeCredential): Promise<void> {
    const normalized = normalizeCredential(credential);
    this.credential = normalized;
    await this.state.write(CREDENTIAL_KEY, canonicalJsonString(normalized));
  }

  /**
   * The exact authority a reconnect replays: the credential bearer. There is no
   * code path here that can produce a `GoatWorkerBootstrap` one-time secret.
   */
  reconnectAuthorization(): string {
    return `Bearer ${this.getCredential().authorizationCredential}`;
  }

  hasLease(assignmentId: string): boolean {
    return this.leases.has(assignmentId);
  }

  getLease(assignmentId: string): RetainedAssignmentLease {
    const lease = this.leases.get(assignmentId);
    if (lease === undefined) {
      throw new WorkerCredentialVaultError(`No lease is retained for assignment ${assignmentId}.`);
    }
    return lease;
  }

  listLeaseAssignmentIds(): readonly string[] {
    return Object.freeze([...this.leases.keys()]);
  }

  async retainLease(lease: RetainedAssignmentLease): Promise<void> {
    const normalized = normalizeLease(lease);
    this.leases.set(normalized.assignmentId, normalized);
    await this.persistLeases();
  }

  /** Rotate to a new lease revision (and optionally a rotated secret) after a renewal. */
  async advanceLease(assignmentId: string, leaseRevision: number, rawLeaseToken?: string): Promise<void> {
    const current = this.getLease(assignmentId);
    const rotated = normalizeLease({
      ...current,
      leaseRevision,
      ...(rawLeaseToken === undefined ? {} : { rawLeaseToken }),
    });
    if (rotated.leaseRevision < current.leaseRevision) {
      throw new WorkerCredentialVaultError("A lease revision may not move backwards.");
    }
    this.leases.set(assignmentId, rotated);
    await this.persistLeases();
  }

  async forgetLease(assignmentId: string): Promise<void> {
    if (this.leases.delete(assertIdentifier(assignmentId, "assignmentId"))) {
      await this.persistLeases();
    }
  }

  private async persistLeases(): Promise<void> {
    await this.state.write(LEASES_KEY, canonicalJsonString([...this.leases.values()]));
  }
}

function normalizeCredential(value: unknown): RetainedRuntimeCredential {
  const record = asRecord(value, "runtime credential");
  for (const field of FORBIDDEN_CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      throw new WorkerCredentialVaultError("A runtime credential must not carry a one-time bootstrap secret.");
    }
  }
  return Object.freeze({
    credentialId: assertIdentifier(record.credentialId, "credentialId"),
    credentialGeneration: assertPositiveInteger(record.credentialGeneration, "credentialGeneration"),
    workerGeneration: assertPositiveInteger(record.workerGeneration, "workerGeneration"),
    registryWorkspaceId: assertIdentifier(record.registryWorkspaceId, "registryWorkspaceId"),
    authorizationCredential: assertBase64Url32(record.authorizationCredential, "authorizationCredential"),
    clientCertificateSha256: assertSha256(record.clientCertificateSha256, "clientCertificateSha256"),
    workerPublicKeySpkiSha256: assertSha256(record.workerPublicKeySpkiSha256, "workerPublicKeySpkiSha256"),
    signingPrivateKeyPem: assertPrivateKeyPem(record.signingPrivateKeyPem),
  });
}

function normalizeLease(value: unknown): RetainedAssignmentLease {
  const record = asRecord(value, "assignment lease");
  return Object.freeze({
    assignmentId: assertIdentifier(record.assignmentId, "assignmentId"),
    rawLeaseToken: assertBase64Url32(record.rawLeaseToken, "rawLeaseToken"),
    leaseRevision: assertPositiveInteger(record.leaseRevision, "leaseRevision"),
    assignmentGeneration: assertPositiveInteger(record.assignmentGeneration, "assignmentGeneration"),
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerCredentialVaultError(`Retained ${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new WorkerCredentialVaultError(`Worker vault ${field} is invalid.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkerCredentialVaultError(`Worker vault ${field} is invalid.`);
  }
  return value;
}

function assertBase64Url32(value: unknown, field: string): string {
  if (typeof value !== "string" || !BASE64URL_32.test(value)) {
    throw new WorkerCredentialVaultError(`Worker vault ${field} must be canonical 32-byte base64url.`);
  }
  return value;
}

function assertSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new WorkerCredentialVaultError(`Worker vault ${field} must be a sha-256 hex digest.`);
  }
  return value;
}

function assertPrivateKeyPem(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.includes("-----BEGIN PRIVATE KEY-----") ||
    !value.includes("-----END PRIVATE KEY-----")
  ) {
    throw new WorkerCredentialVaultError("Worker vault signing key must be a PEM private key.");
  }
  return value;
}
