import type { RemoteWorkerCellPlatformIdentity } from "@goatcitadel/contracts";

/**
 * HX-505 remote-worker cell container adapter (production-dark).
 *
 * The first backend is a dedicated, digest-pinned container with deterministic
 * names/labels, no `--rm`, a read-only root, all capabilities dropped,
 * `no-new-privileges`, no host PID/IPC and no Docker socket, quota-controlled
 * volume/tmpfs, CPU/memory/swap/PID/wall limits, an internal-only network,
 * guarded proxy-only egress, and a fixed non-secret environment allowlist.
 * There is no best-effort host fallback. The container runtime is injected so
 * the boundary logic is provable single-host with a double; a real runtime is
 * gated on the live-execution lane.
 */

export const WORKER_CELL_PROXY_ENV_NAME = "GOATCITADEL_CELL_EGRESS_PROXY_URL";

export interface WorkerCellContainerLimits {
  readonly cpuLimitMilli: number;
  readonly memoryLimitBytes: number;
  readonly swapLimitBytes: number;
  readonly pidLimit: number;
  readonly wallLimitMs: number;
  readonly rootVolumeBytes: number;
  readonly tmpfsBytes: number;
}

export interface WorkerCellContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly kind: "volume" | "tmpfs";
  readonly quotaBytes: number;
}

export interface WorkerCellContainerSpec {
  readonly name: string;
  readonly imageDigest: string;
  readonly networkName: string;
  readonly internalNetworkOnly: true;
  readonly readOnlyRootfs: true;
  readonly noNewPrivileges: true;
  readonly autoRemove: false;
  readonly hostPid: false;
  readonly hostIpc: false;
  readonly hostNetwork: false;
  readonly privileged: false;
  readonly droppedCapabilities: readonly ["ALL"];
  readonly addedCapabilities: readonly [];
  readonly mounts: readonly WorkerCellContainerMount[];
  readonly limits: WorkerCellContainerLimits;
  readonly environment: Readonly<Record<string, string>>;
  readonly egressProxyUrl: string;
}

export interface WorkerCellContainerSpecInput {
  readonly platformIdentity: RemoteWorkerCellPlatformIdentity;
  readonly limits: WorkerCellContainerLimits;
  readonly rootVolumeSource: string;
  readonly egressProxyUrl: string;
  /** Fixed, non-secret environment names → non-secret values (never a credential). */
  readonly environmentAllowlist: Readonly<Record<string, string>>;
}

export interface WorkerCellContainerRuntimePort {
  create(spec: WorkerCellContainerSpec): Promise<{ containerId: string; running: boolean }>;
  inspect(containerId: string): Promise<{ running: boolean; imageDigest: string; name: string }>;
  stop(containerId: string): Promise<void>;
}

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SECRET_ENV_HINT = /(secret|token|password|passwd|credential|api[_-]?key|bearer|private[_-]?key)/iu;
const DOCKER_SOCKET_HINT = /docker\.sock|\/var\/run\/docker/iu;

export class WorkerCellContainerSpecError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerCellContainerSpecError";
  }
}

/** Build the hardened, deterministic container run-spec from the server-owned profile. */
export function buildRemoteWorkerCellContainerSpec(input: WorkerCellContainerSpecInput): WorkerCellContainerSpec {
  const identity = input.platformIdentity;
  const mounts: WorkerCellContainerMount[] = [
    {
      source: input.rootVolumeSource,
      target: "/cell",
      readOnly: false,
      kind: "volume",
      quotaBytes: input.limits.rootVolumeBytes,
    },
    { source: "tmpfs", target: "/tmp", readOnly: false, kind: "tmpfs", quotaBytes: input.limits.tmpfsBytes },
  ];
  const environment: Record<string, string> = {
    ...input.environmentAllowlist,
    [WORKER_CELL_PROXY_ENV_NAME]: input.egressProxyUrl,
  };
  const spec: WorkerCellContainerSpec = {
    name: identity.containerName,
    imageDigest: identity.imageDigest,
    networkName: identity.networkName,
    internalNetworkOnly: true,
    readOnlyRootfs: true,
    noNewPrivileges: true,
    autoRemove: false,
    hostPid: false,
    hostIpc: false,
    hostNetwork: false,
    privileged: false,
    droppedCapabilities: ["ALL"],
    addedCapabilities: [],
    mounts,
    limits: input.limits,
    environment,
    egressProxyUrl: input.egressProxyUrl,
  };
  assertRemoteWorkerCellContainerSpecSafe(spec);
  return Object.freeze({ ...spec, mounts: Object.freeze(mounts), environment: Object.freeze(environment) });
}

/** Fail closed on any weakened container posture. */
export function assertRemoteWorkerCellContainerSpecSafe(spec: WorkerCellContainerSpec): void {
  if (!IMAGE_DIGEST_PATTERN.test(spec.imageDigest)) {
    throw new WorkerCellContainerSpecError("Remote worker cell container image must be pinned to a sha256 digest.");
  }
  if (
    spec.autoRemove !== false ||
    spec.readOnlyRootfs !== true ||
    spec.noNewPrivileges !== true ||
    spec.hostPid !== false ||
    spec.hostIpc !== false ||
    spec.hostNetwork !== false ||
    spec.privileged !== false ||
    spec.internalNetworkOnly !== true
  ) {
    throw new WorkerCellContainerSpecError("Remote worker cell container posture is weakened.");
  }
  if (
    spec.droppedCapabilities.length !== 1 ||
    spec.droppedCapabilities[0] !== "ALL" ||
    spec.addedCapabilities.length !== 0
  ) {
    throw new WorkerCellContainerSpecError("Remote worker cell container must drop ALL capabilities and add none.");
  }
  for (const mount of spec.mounts) {
    if (DOCKER_SOCKET_HINT.test(mount.source) || DOCKER_SOCKET_HINT.test(mount.target)) {
      throw new WorkerCellContainerSpecError("Remote worker cell container must not mount the Docker socket.");
    }
    if (!Number.isInteger(mount.quotaBytes) || mount.quotaBytes < 1) {
      throw new WorkerCellContainerSpecError("Remote worker cell container mounts must be quota-controlled.");
    }
  }
  for (const limit of [
    spec.limits.cpuLimitMilli,
    spec.limits.memoryLimitBytes,
    spec.limits.swapLimitBytes,
    spec.limits.pidLimit,
    spec.limits.wallLimitMs,
    spec.limits.rootVolumeBytes,
    spec.limits.tmpfsBytes,
  ]) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new WorkerCellContainerSpecError(
        "Remote worker cell container must set every CPU/memory/swap/PID/wall/quota limit.",
      );
    }
  }
  if (!spec.egressProxyUrl || !/^socks5:\/\/127\.0\.0\.1:\d+$/u.test(spec.egressProxyUrl)) {
    throw new WorkerCellContainerSpecError("Remote worker cell egress must route through a loopback guarded proxy.");
  }
  for (const [name, value] of Object.entries(spec.environment)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new WorkerCellContainerSpecError(`Remote worker cell environment name is invalid: ${name}.`);
    }
    if (name !== WORKER_CELL_PROXY_ENV_NAME && SECRET_ENV_HINT.test(name)) {
      throw new WorkerCellContainerSpecError(`Remote worker cell environment must be non-secret: ${name}.`);
    }
    if (typeof value !== "string" || value.length > 4_096) {
      throw new WorkerCellContainerSpecError(`Remote worker cell environment value is invalid: ${name}.`);
    }
  }
}
