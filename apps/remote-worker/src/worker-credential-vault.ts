import { canonicalJsonString } from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import {
  normalizeWorkerProtectedKeyReference,
  workerProtectedKeySpkiSha256,
  type WorkerProtectedKeyReference,
} from "./worker-protected-key-owner.js";

/**
 * The reusable M2 runtime credential the worker retains after a one-time
 * bootstrap exchange. This is the ONLY authority the worker replays to
 * reconnect: the `authorizationCredential` bearer, the credential
 * id/generation, the worker generation, the transport digests, and the
 * PEM signing key or public reference to the protected Ed25519 signing owner.
 * Protected references contain no private key bytes. The one-time
 * bootstrap secret is deliberately absent — there is no field for it and no
 * API to store it, so a reconnect or restart can never replay it.
 */
interface RetainedCredentialAuthority {
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly workerGeneration: number;
  readonly registryWorkspaceId: string;
  /** 32-byte base64url bearer secret sent as `Authorization: Bearer <credential>`. */
  readonly authorizationCredential: string;
  readonly clientCertificateSha256: string;
  readonly workerPublicKeySpkiSha256: string;
}

export interface RetainedPemRuntimeCredential extends RetainedCredentialAuthority {
  readonly signingPrivateKeyPem: string;
  readonly protectedKey?: never;
}

export interface RetainedProtectedRuntimeCredential extends RetainedCredentialAuthority {
  readonly protectedKey: WorkerProtectedKeyReference;
  readonly signingPrivateKeyPem?: never;
}

export type RetainedRuntimeCredential = RetainedPemRuntimeCredential | RetainedProtectedRuntimeCredential;

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
 * Durable retention of reusable credentials, signing references, and active
 * leases. Protected signing requires a separately supplied native owner after
 * restart. Bearer and lease secrets still use the configured state port; this
 * class does not encrypt them or provide native volume protection.
 */
export class WorkerCredentialVault {
  private mutationTail: Promise<void> = Promise.resolve();
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
    await this.mutate(async () => {
      await this.state.write(CREDENTIAL_KEY, canonicalJsonString(normalized));
      this.credential = normalized;
    });
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
    await this.mutate(async () => {
      const current = this.leases.get(normalized.assignmentId);
      if (
        current &&
        (normalized.assignmentGeneration < current.assignmentGeneration ||
          (normalized.assignmentGeneration === current.assignmentGeneration &&
            (normalized.leaseRevision < current.leaseRevision ||
              (normalized.leaseRevision === current.leaseRevision &&
                normalized.rawLeaseToken !== current.rawLeaseToken))))
      )
        throw new WorkerCredentialVaultError(
          "Retained lease authority cannot move backwards or change at the same revision.",
        );
      const next = new Map(this.leases).set(normalized.assignmentId, normalized);
      await this.persistLeases(next);
    });
  }

  /** Rotate to a new lease revision (and optionally a rotated secret) after a renewal. */
  async advanceLease(assignmentId: string, leaseRevision: number, rawLeaseToken?: string): Promise<void> {
    await this.mutate(async () => {
      const current = this.getLease(assignmentId);
      const rotated = normalizeLease({
        ...current,
        leaseRevision,
        ...(rawLeaseToken === undefined ? {} : { rawLeaseToken }),
      });
      if (
        rotated.leaseRevision < current.leaseRevision ||
        (rotated.leaseRevision === current.leaseRevision && rotated.rawLeaseToken !== current.rawLeaseToken)
      ) {
        throw new WorkerCredentialVaultError("A lease revision may not move backwards or change its secret in place.");
      }
      await this.persistLeases(new Map(this.leases).set(assignmentId, rotated));
    });
  }

  async forgetLease(assignmentId: string): Promise<void> {
    await this.mutate(async () => {
      const next = new Map(this.leases);
      if (next.delete(assertIdentifier(assignmentId, "assignmentId"))) await this.persistLeases(next);
    });
  }

  private async persistLeases(next: ReadonlyMap<string, RetainedAssignmentLease>): Promise<void> {
    await this.state.write(LEASES_KEY, canonicalJsonString([...next.values()]));
    this.leases.clear();
    for (const [key, value] of next) this.leases.set(key, value);
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationTail.then(operation);
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function normalizeCredential(value: unknown): RetainedRuntimeCredential {
  const record = asRecord(value, "runtime credential");
  for (const field of FORBIDDEN_CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      throw new WorkerCredentialVaultError("A runtime credential must not carry a one-time bootstrap secret.");
    }
  }
  const hasPem = Object.prototype.hasOwnProperty.call(record, "signingPrivateKeyPem");
  const hasProtectedKey = Object.prototype.hasOwnProperty.call(record, "protectedKey");
  if (hasPem === hasProtectedKey)
    throw new WorkerCredentialVaultError("Worker vault requires exactly one signing key source.");
  const protectedKey = hasProtectedKey ? normalizeWorkerProtectedKeyReference(record.protectedKey) : undefined;
  if (
    protectedKey &&
    (protectedKey.keysetGeneration !== record.workerGeneration ||
      workerProtectedKeySpkiSha256(protectedKey) !== record.workerPublicKeySpkiSha256)
  )
    throw new WorkerCredentialVaultError("Worker vault protected key differs from credential authority.");
  return Object.freeze({
    credentialId: assertIdentifier(record.credentialId, "credentialId"),
    credentialGeneration: assertPositiveInteger(record.credentialGeneration, "credentialGeneration"),
    workerGeneration: assertPositiveInteger(record.workerGeneration, "workerGeneration"),
    registryWorkspaceId: assertIdentifier(record.registryWorkspaceId, "registryWorkspaceId"),
    authorizationCredential: assertBase64Url32(record.authorizationCredential, "authorizationCredential"),
    clientCertificateSha256: assertSha256(record.clientCertificateSha256, "clientCertificateSha256"),
    workerPublicKeySpkiSha256: assertSha256(record.workerPublicKeySpkiSha256, "workerPublicKeySpkiSha256"),
    ...(protectedKey ? { protectedKey } : { signingPrivateKeyPem: assertPrivateKeyPem(record.signingPrivateKeyPem) }),
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
