import type { RemoteWorkerCellBackupState, RemoteWorkerCellExecutionState } from "@goatcitadel/contracts";

/**
 * HX-505 remote-worker cell backup port (production-dark).
 *
 * Backup delegates to the EXISTING backup owner (injected here as a narrow port,
 * never re-implemented) only after confirmed zero process AND network liveness.
 * It stages privately, hashes/fsyncs, publishes atomically, and reverifies;
 * corruption preserves source/staging, counts all bytes, and enters manual
 * reconciliation. Restore requires approval and a NEW EMPTY root with exact
 * identity/profile/manifest/digest/capacity validation and returns only to
 * `ready`; drift enters manual reconciliation. Force cleanup outside the exact
 * verified root is outside this tranche.
 */

export interface WorkerCellLivenessEvidence {
  readonly executionState: RemoteWorkerCellExecutionState;
  readonly zeroProcessConfirmed: boolean;
  readonly networkClosedConfirmed: boolean;
  readonly rootIdentityUnchanged: boolean;
}

export interface WorkerCellBackupOwnerStageResult {
  readonly stagingSha256: string;
  readonly stagedBytes: number;
}

export interface WorkerCellBackupOwnerPublishResult {
  readonly publicationSha256: string;
  readonly publishedBytes: number;
}

export interface WorkerCellBackupOwnerVerifyResult {
  readonly matches: boolean;
  readonly observedSha256: string;
}

export interface WorkerCellBackupOwnerRestoreResult {
  readonly matches: boolean;
  readonly restoredSha256: string;
  readonly restoredBytes: number;
}

export interface WorkerCellBackupOwnerPort {
  stagePrivately(cellStateSha256: string): Promise<WorkerCellBackupOwnerStageResult>;
  publishAtomically(stagingSha256: string): Promise<WorkerCellBackupOwnerPublishResult>;
  reverify(publicationSha256: string): Promise<WorkerCellBackupOwnerVerifyResult>;
  restoreToNewRoot(publicationSha256: string): Promise<WorkerCellBackupOwnerRestoreResult>;
}

export interface WorkerCellBackupInput {
  readonly liveness: WorkerCellLivenessEvidence;
  readonly cellStateSha256: string;
}

export interface WorkerCellBackupOutcome {
  readonly nextBackupState: Extract<RemoteWorkerCellBackupState, "verified" | "manual_reconciliation">;
  readonly stagedThrough: "verified" | "corrupt";
  readonly publicationSha256: string;
  readonly retainedBytes: number;
  readonly detailSha256: string;
}

export interface WorkerCellRestoreExpectation {
  readonly profileSha256: string;
  readonly assignmentManifestSha256: string;
  readonly imageDigest: string;
  readonly allocatedDiskBytes: number;
}

export interface WorkerCellRestoreInput {
  readonly approvalReceiptSha256?: string;
  readonly newRootEmpty: boolean;
  readonly publicationSha256: string;
  readonly expected: WorkerCellRestoreExpectation;
  readonly observed: WorkerCellRestoreExpectation;
}

export interface WorkerCellRestoreOutcome {
  readonly nextBackupState: Extract<RemoteWorkerCellBackupState, "restored" | "manual_reconciliation">;
  readonly targetExecutionState: "ready";
  readonly restoredSha256: string;
  readonly retainedBytes: number;
  readonly detailSha256: string;
}

export class WorkerCellBackupError extends Error {
  public constructor(
    public readonly code: "liveness_unconfirmed" | "approval_required" | "root_not_empty" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "WorkerCellBackupError";
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export class WorkerCellBackupPort {
  public constructor(private readonly owner: WorkerCellBackupOwnerPort) {}

  /** Stage, publish, and reverify a backup — only after confirmed zero process/network liveness. */
  public async planBackup(input: WorkerCellBackupInput): Promise<WorkerCellBackupOutcome> {
    assertDigest(input.cellStateSha256, "cellStateSha256");
    const { liveness } = input;
    if (
      liveness.executionState === "liveness_unknown" ||
      !liveness.zeroProcessConfirmed ||
      !liveness.networkClosedConfirmed ||
      !liveness.rootIdentityUnchanged ||
      !isTerminalExecution(liveness.executionState)
    ) {
      throw new WorkerCellBackupError(
        "liveness_unconfirmed",
        "Remote worker cell backup requires confirmed zero process/network liveness and an unchanged root.",
      );
    }
    const staged = await this.owner.stagePrivately(input.cellStateSha256);
    const published = await this.owner.publishAtomically(staged.stagingSha256);
    const verify = await this.owner.reverify(published.publicationSha256);
    if (!verify.matches) {
      // Corruption preserves source/staging and counts all bytes for reconciliation.
      return {
        nextBackupState: "manual_reconciliation",
        stagedThrough: "corrupt",
        publicationSha256: published.publicationSha256,
        retainedBytes: staged.stagedBytes + published.publishedBytes,
        detailSha256: verify.observedSha256,
      };
    }
    return {
      nextBackupState: "verified",
      stagedThrough: "verified",
      publicationSha256: published.publicationSha256,
      retainedBytes: published.publishedBytes,
      detailSha256: published.publicationSha256,
    };
  }

  /** Restore into a new empty root under approval with exact validation; drift → manual reconciliation. */
  public async planRestore(input: WorkerCellRestoreInput): Promise<WorkerCellRestoreOutcome> {
    if (input.approvalReceiptSha256 === undefined || !DIGEST_PATTERN.test(input.approvalReceiptSha256)) {
      throw new WorkerCellBackupError("approval_required", "Remote worker cell restore requires an approval receipt.");
    }
    if (input.newRootEmpty !== true) {
      throw new WorkerCellBackupError("root_not_empty", "Remote worker cell restore requires a new empty root.");
    }
    assertDigest(input.publicationSha256, "publicationSha256");
    const restore = await this.owner.restoreToNewRoot(input.publicationSha256);
    const identityMatches =
      input.expected.profileSha256 === input.observed.profileSha256 &&
      input.expected.assignmentManifestSha256 === input.observed.assignmentManifestSha256 &&
      input.expected.imageDigest === input.observed.imageDigest &&
      input.expected.allocatedDiskBytes === input.observed.allocatedDiskBytes;
    if (!restore.matches || !identityMatches) {
      // Drift preserves the source/staging and counts all bytes for reconciliation.
      return {
        nextBackupState: "manual_reconciliation",
        targetExecutionState: "ready",
        restoredSha256: restore.restoredSha256,
        retainedBytes: restore.restoredBytes,
        detailSha256: restore.restoredSha256,
      };
    }
    return {
      nextBackupState: "restored",
      targetExecutionState: "ready",
      restoredSha256: restore.restoredSha256,
      retainedBytes: restore.restoredBytes,
      detailSha256: restore.restoredSha256,
    };
  }
}

function isTerminalExecution(state: RemoteWorkerCellExecutionState): boolean {
  return state === "exited" || state === "cancelled" || state === "limit_exceeded" || state === "failed";
}

function assertDigest(value: string, field: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new WorkerCellBackupError(
      "invalid_input",
      `Remote worker cell ${field} must be a lower-case SHA-256 digest.`,
    );
  }
}
