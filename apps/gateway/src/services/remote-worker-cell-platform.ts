import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PLATFORM_V2_SCHEMA_VERSION,
  normalizeRemoteWorkerCellPlatformIdentity,
  remoteWorkerCellPlatformIdentitySha256,
  type RemoteWorkerCellBackend,
  type RemoteWorkerCellPlatformIdentity,
  type RemoteWorkerContainerPlatformIdentity,
  type RemoteWorkerWindowsPlatformIdentity,
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

export interface ContainerCellBackendCapabilities {
  readonly backend: "container";
  readonly containerRuntimeReady: boolean;
  readonly internalNetworkReady: boolean;
  readonly quotaEnforcementReady: boolean;
}

export interface WindowsCellBackendCapabilities {
  readonly backend: "windows_native";
  readonly platform: "win32";
  readonly architecture: "x64";
  readonly buildNumber: number;
  readonly signedHelperVerified: boolean;
  readonly protectedVolumeReady: boolean;
  readonly appContainerReady: boolean;
  readonly jobLimitsReady: boolean;
  readonly stdioHandleAllowlistReady: boolean;
  readonly quotaEnforcementReady: boolean;
}
export type WorkerCellBackendCapabilities = ContainerCellBackendCapabilities | WindowsCellBackendCapabilities;

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_PREFIX = "gc-cell";

/** Assert the backend is fully supported; any partial adapter is unavailable (fail closed). */
export function assertWorkerCellBackendSupported(capabilities: WorkerCellBackendCapabilities): void {
  if (capabilities.backend === "windows_native") {
    if (
      capabilities.platform === "win32" &&
      capabilities.architecture === "x64" &&
      Number.isInteger(capabilities.buildNumber) &&
      capabilities.buildNumber >= 22000 &&
      capabilities.signedHelperVerified === true &&
      capabilities.protectedVolumeReady === true &&
      capabilities.appContainerReady === true &&
      capabilities.jobLimitsReady === true &&
      capabilities.stdioHandleAllowlistReady === true &&
      capabilities.quotaEnforcementReady === true
    )
      return;
    throw new WorkerCellBackendUnavailableError(
      "Native Windows worker prerequisites or protected enforcement evidence are incomplete.",
    );
  }
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
export function planRemoteWorkerCellPlatformIdentity(
  input: WorkerCellPlatformInput,
): RemoteWorkerContainerPlatformIdentity {
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
  return normalizeRemoteWorkerCellPlatformIdentity(identity) as RemoteWorkerContainerPlatformIdentity;
}

/** Server-owned v2 identity. No Docker/WSL requirement and no fallback to an unconfined process. */
export function planNativeWindowsWorkerCellPlatform(
  input: Omit<WorkerCellPlatformInput, "backend" | "imageDigest" | "namePrefix"> & {
    volumeIdentitySha256: string;
    runtimeBundleSha256: string;
    launcherSha256: string;
  },
  capabilities: WindowsCellBackendCapabilities,
): RemoteWorkerWindowsPlatformIdentity {
  assertWorkerCellBackendSupported(capabilities);
  if (
    !Number.isSafeInteger(input.assignmentGeneration) ||
    input.assignmentGeneration < 1 ||
    [input.registryWorkspaceId, input.assignmentId, input.cellId].some(
      (value) => typeof value !== "string" || !value.trim() || value.length > 256,
    )
  ) {
    throw new WorkerCellBackendUnavailableError("Native Windows cell assignment identity is invalid.");
  }
  const shortHash = createHash("sha256")
    .update(
      JSON.stringify([
        REMOTE_WORKER_CELL_PLATFORM_V2_SCHEMA_VERSION,
        input.registryWorkspaceId,
        input.assignmentId,
        input.assignmentGeneration,
        input.cellId,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return normalizeRemoteWorkerCellPlatformIdentity({
    schemaVersion: REMOTE_WORKER_CELL_PLATFORM_V2_SCHEMA_VERSION,
    backend: "windows_native",
    jobName: `gc-cell-${shortHash}`,
    appContainerName: `GoatCitadel.Worker.${shortHash}`,
    volumeIdentitySha256: input.volumeIdentitySha256,
    runtimeBundleSha256: input.runtimeBundleSha256,
    launcherSha256: input.launcherSha256,
    networkPolicy: "deny_all",
  }) as RemoteWorkerWindowsPlatformIdentity;
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
