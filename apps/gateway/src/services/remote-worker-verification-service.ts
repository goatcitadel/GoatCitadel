import {
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  redactSecretText,
  type RemoteWorkerVerificationAttemptState,
  type RemoteWorkerVerificationEvidence,
} from "@goatcitadel/contracts";
import type { RemoteWorkerArtifactRepository } from "@goatcitadel/storage";
import type { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import type { AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

/**
 * HX-506 trusted verification service (production-dark).
 *
 * Worker-reported verification is evidence ONLY and never satisfies the gate,
 * even when the worker advertises trusted_verification. Gateway-trusted
 * verification rehashes the immutable CAS bytes before and after execution,
 * uses a server-owned profile, denies default egress, bounds time and output,
 * and appends evidence. It cannot activate skills, memory, capabilities, tools,
 * or artifacts, and uploaded code is never executed merely because it was
 * uploaded. A crashed running verifier becomes indeterminate; a retry is a new
 * explicit attempt. Only a passed Gateway attempt advances the gate.
 */

export interface RemoteWorkerVerifierFile {
  blobSha256: string;
  bytes: Uint8Array;
}

export interface RemoteWorkerTrustedVerifierPort {
  /** Runs a server-owned verifier profile against immutable CAS bytes, no egress. */
  verify(input: {
    profileSha256: string;
    manifestSha256: string;
    files: readonly RemoteWorkerVerifierFile[];
    wallDeadlineMs: number;
  }): Promise<{ outcome: "passed" | "failed" | "blocked"; summary: string; capturedOutputBytes: number }>;
}

export interface RemoteWorkerVerificationDependencies {
  repository: RemoteWorkerVerificationRepositoryPort;
  store: RemoteWorkerArtifactStore;
  verifier: RemoteWorkerTrustedVerifierPort;
}

type RemoteWorkerVerificationRepositoryMethod =
  | "recordWorkerClaim"
  | "openGatewayVerification"
  | "advanceGatewayVerification";

export type RemoteWorkerVerificationRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerArtifactRepository,
  RemoteWorkerVerificationRepositoryMethod
>;

export interface RecordWorkerClaimInput {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  attemptIndex: number;
  summary: string;
  manifestSha256: string;
  idempotencyKey: string;
}

export interface RunGatewayVerificationInput {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  executionWorkspaceId: string;
  attemptIndex: number;
  verifierProfileSha256: string;
  manifestSha256: string;
  blobs: readonly string[];
  wallDeadlineAt: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface GatewayVerificationOutcome {
  verificationId: string;
  attemptState: RemoteWorkerVerificationAttemptState;
  gateState: "not_required" | "pending" | "satisfied" | null;
}

export class RemoteWorkerVerificationService {
  private readonly repository: RemoteWorkerVerificationRepositoryPort;
  private readonly store: RemoteWorkerArtifactStore;
  private readonly verifier: RemoteWorkerTrustedVerifierPort;

  public constructor(dependencies: RemoteWorkerVerificationDependencies) {
    this.repository = dependencies.repository;
    this.store = dependencies.store;
    this.verifier = dependencies.verifier;
  }

  /** Records worker-reported evidence. It never satisfies the gate. */
  public async recordWorkerClaim(input: RecordWorkerClaimInput): Promise<{ verificationId: string }> {
    const evidence: RemoteWorkerVerificationEvidence = {
      schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      kind: "worker_claim",
      attemptState: "worker_reported",
      verifierProfileSha256: null,
      preExecutionManifestSha256: input.manifestSha256,
      postExecutionManifestSha256: input.manifestSha256,
      summary: secretFreeVerificationSummary(input.summary, "worker_claim"),
      capturedOutputBytes: 0,
    };
    return await this.repository.recordWorkerClaim({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      attemptIndex: input.attemptIndex,
      evidence,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public async runGatewayVerification(input: RunGatewayVerificationInput): Promise<GatewayVerificationOutcome> {
    // Rehash immutable CAS bytes BEFORE execution; a tampered object fails closed.
    const files = await this.loadImmutableFiles(input);

    const attempt = await this.repository.openGatewayVerification({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      attemptIndex: input.attemptIndex,
      verifierProfileSha256: input.verifierProfileSha256,
      wallDeadlineAt: input.wallDeadlineAt,
      evidence: this.evidence("queued", input, 0, "queued"),
      idempotencyKey: input.idempotencyKey,
    });

    await this.repository.advanceGatewayVerification({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      verificationId: attempt.verificationId,
      expectedAttemptRevision: 1,
      nextState: "running",
      evidence: this.evidence("running", input, 0, "running"),
    });

    let nextState: RemoteWorkerVerificationAttemptState;
    let summary: string;
    let capturedOutputBytes = 0;
    try {
      const result = normalizeVerifierResult(
        await this.verifier.verify({
          profileSha256: input.verifierProfileSha256,
          manifestSha256: input.manifestSha256,
          files,
          wallDeadlineMs: REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerifierWallMs,
        }),
      );
      capturedOutputBytes = result.capturedOutputBytes;
      nextState = result.outcome;
      summary = result.summary;
      // Rehash AFTER execution: the verifier may not have mutated the immutable bytes.
      await this.loadImmutableFiles(input);
    } catch {
      // A crashed or timed-out running verifier becomes indeterminate, never passed.
      nextState = "indeterminate";
      summary = "verifier_indeterminate";
    }

    const advanced = await this.repository.advanceGatewayVerification({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      verificationId: attempt.verificationId,
      expectedAttemptRevision: 2,
      nextState,
      evidence: this.evidence(nextState, input, capturedOutputBytes, summary),
    });
    return { verificationId: attempt.verificationId, attemptState: nextState, gateState: advanced.gateState };
  }

  private async loadImmutableFiles(input: RunGatewayVerificationInput): Promise<RemoteWorkerVerifierFile[]> {
    const files: RemoteWorkerVerifierFile[] = [];
    for (const blobSha256 of input.blobs) {
      const bytes = await this.store.readBlob({
        executionWorkspaceId: input.executionWorkspaceId,
        blobSha256,
        signal: input.signal,
      });
      files.push({ blobSha256, bytes });
    }
    return files;
  }

  private evidence(
    attemptState: RemoteWorkerVerificationAttemptState,
    input: RunGatewayVerificationInput,
    capturedOutputBytes: number,
    summary: unknown,
  ): RemoteWorkerVerificationEvidence {
    return {
      schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      kind: "gateway_attempt",
      attemptState,
      verifierProfileSha256: input.verifierProfileSha256,
      preExecutionManifestSha256: input.manifestSha256,
      postExecutionManifestSha256: input.manifestSha256,
      summary: secretFreeVerificationSummary(summary, attemptState),
      capturedOutputBytes,
    };
  }
}

function normalizeVerifierResult(value: unknown): {
  outcome: "passed" | "failed" | "blocked";
  summary: string;
  capturedOutputBytes: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Remote worker verifier result is invalid.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Remote worker verifier result is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(["outcome", "summary", "capturedOutputBytes"]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TypeError("Remote worker verifier result is invalid.");
  }
  const outcome = descriptors.outcome?.value;
  const summary = descriptors.summary?.value;
  const capturedOutputBytes = descriptors.capturedOutputBytes?.value;
  if (
    (outcome !== "passed" && outcome !== "failed" && outcome !== "blocked") ||
    typeof summary !== "string" ||
    !Number.isSafeInteger(capturedOutputBytes) ||
    Number(capturedOutputBytes) < 0 ||
    Number(capturedOutputBytes) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerifierCapturedOutputBytes
  ) {
    throw new TypeError("Remote worker verifier result is invalid.");
  }
  return {
    outcome,
    summary: secretFreeVerificationSummary(summary, outcome),
    capturedOutputBytes: Number(capturedOutputBytes),
  };
}

function secretFreeVerificationSummary(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : fallback;
  const redacted = redactSecretText(source, { redactEnvAssignmentsAsWhole: true }).value;
  const normalized = Array.from(redacted.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  const safe = normalized.length > 0 ? normalized : fallback;
  let output = "";
  let bytes = 0;
  for (const character of safe) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerificationSummaryBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output || fallback;
}
