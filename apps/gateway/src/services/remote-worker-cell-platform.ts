import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  normalizeRemoteWorkerCellPlatformIdentity,
  remoteWorkerCellPlatformIdentitySha256,
  type RemoteWorkerCellBackend,
  type RemoteWorkerCellPlatformIdentity,
} from "@goatcitadel/contracts";

/**
 * HX-505 remote-worker cell platform adapter (production-dark).
 *
 * Derives the deterministic, server-owned platform identity (container name,
 * label hash, and internal network name) that is persisted BEFORE launch. The
 * worker cannot choose any of these. Unsupported or partial backends return
 * `cell_backend_unavailable`; there is no best-effort host fallback.
 */

export class WorkerCellBackendUnavailableError extends Error {
  public readonly code = "cell_backend_unavailable" as const;
  public constructor(message: string) {
    super(message);
    this.name = "WorkerCellBackendUnavailableError";
  }
}

export interface WorkerCellPlatformInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly backend: RemoteWorkerCellBackend;
  readonly imageDigest: string;
  readonly namePrefix?: string;
}

export interface WorkerCellBackendCapabilities {
  readonly backend: RemoteWorkerCellBackend;
  readonly containerRuntimeReady: boolean;
  readonly internalNetworkReady: boolean;
  readonly quotaEnforcementReady: boolean;
}

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_PREFIX = "gc-cell";

/** Assert the backend is fully supported; any partial adapter is unavailable (fail closed). */
export function assertWorkerCellBackendSupported(capabilities: WorkerCellBackendCapabilities): void {
  if (
    capabilities.backend !== "container" ||
    !capabilities.containerRuntimeReady ||
    !capabilities.internalNetworkReady ||
    !capabilities.quotaEnforcementReady
  ) {
    throw new WorkerCellBackendUnavailableError(
      "Remote worker cell backend is unsupported or partially provisioned (no best-effort fallback).",
    );
  }
}

/** Derive the deterministic, server-owned platform identity persisted before launch. */
export function planRemoteWorkerCellPlatformIdentity(input: WorkerCellPlatformInput): RemoteWorkerCellPlatformIdentity {
  if (input.backend !== "container") {
    throw new WorkerCellBackendUnavailableError("Only the container backend is available in this tranche.");
  }
  if (typeof input.imageDigest !== "string" || !IMAGE_DIGEST_PATTERN.test(input.imageDigest)) {
    throw new WorkerCellBackendUnavailableError("Remote worker cell image must be pinned to a sha256 digest.");
  }
  const prefix = normalizePrefix(input.namePrefix);
  const identityKey = canonicalIdentityKey(input);
  const shortHash = createHash("sha256").update(identityKey, "utf8").digest("hex").slice(0, 32);
  const containerLabelSha256 = createHash("sha256").update(identityKey, "utf8").digest("hex");
  const identity: RemoteWorkerCellPlatformIdentity = {
    schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
    backend: "container",
    containerName: `${prefix}-${shortHash}`,
    containerLabelSha256,
    imageDigest: input.imageDigest,
    networkName: `${prefix}-net-${shortHash}`,
  };
  return normalizeRemoteWorkerCellPlatformIdentity(identity);
}

export function planRemoteWorkerCellPlatformIdentitySha256(input: WorkerCellPlatformInput): string {
  return remoteWorkerCellPlatformIdentitySha256(planRemoteWorkerCellPlatformIdentity(input));
}

function canonicalIdentityKey(input: WorkerCellPlatformInput): string {
  return JSON.stringify([
    "goatcitadel.remote-worker-cell-platform.v1",
    input.registryWorkspaceId,
    input.assignmentId,
    input.assignmentGeneration,
    input.cellId,
  ]);
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined) return DEFAULT_PREFIX;
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(prefix)) {
    throw new WorkerCellBackendUnavailableError("Remote worker cell name prefix must be a lower-case token.");
  }
  return prefix;
}
