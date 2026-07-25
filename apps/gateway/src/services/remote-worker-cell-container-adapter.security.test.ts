import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  type RemoteWorkerCellPlatformIdentity,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import {
  WORKER_CELL_PROXY_ENV_NAME,
  WorkerCellContainerSpecError,
  assertRemoteWorkerCellContainerSpecSafe,
  buildRemoteWorkerCellContainerSpec,
  type WorkerCellContainerSpecInput,
} from "./remote-worker-cell-container-adapter.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const platformIdentity: RemoteWorkerCellPlatformIdentity = {
  schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  backend: "container",
  containerName: "gc-cell-abc",
  containerLabelSha256: D("label"),
  imageDigest: `sha256:${"a".repeat(64)}`,
  networkName: "gc-cell-net",
};

function input(overrides: Partial<WorkerCellContainerSpecInput> = {}): WorkerCellContainerSpecInput {
  return {
    platformIdentity,
    limits: {
      cpuLimitMilli: 2_000,
      memoryLimitBytes: 2_000_000_000,
      swapLimitBytes: 2_000_000_000,
      pidLimit: 128,
      wallLimitMs: 900_000,
      rootVolumeBytes: 4_000_000,
      tmpfsBytes: 1_000_000,
    },
    rootVolumeSource: "/var/lib/gc/cells/abc",
    egressProxyUrl: "socks5://127.0.0.1:54999",
    environmentAllowlist: { CELL_MODE: "worker", GOATCITADEL_CELL_LABEL: "abc" },
    ...overrides,
  };
}

describe("HX-505 cell container adapter — hardened by construction", () => {
  it("builds a digest-pinned, capability-dropped, read-only, no-fallback container spec", () => {
    const spec = buildRemoteWorkerCellContainerSpec(input());
    expect(spec.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(spec.readOnlyRootfs).toBe(true);
    expect(spec.noNewPrivileges).toBe(true);
    expect(spec.autoRemove).toBe(false);
    expect(spec.hostPid).toBe(false);
    expect(spec.hostIpc).toBe(false);
    expect(spec.hostNetwork).toBe(false);
    expect(spec.privileged).toBe(false);
    expect(spec.internalNetworkOnly).toBe(true);
    expect(spec.droppedCapabilities).toEqual(["ALL"]);
    expect(spec.addedCapabilities).toEqual([]);
    expect(spec.environment[WORKER_CELL_PROXY_ENV_NAME]).toBe("socks5://127.0.0.1:54999");
    expect(spec.mounts.every((mount) => mount.quotaBytes > 0)).toBe(true);
  });
});

describe("HX-505 cell container adapter — fails closed on any weakened posture", () => {
  const base = buildRemoteWorkerCellContainerSpec(input());

  it("rejects a non-pinned image, --rm, writable root, and no-new-privileges removal", () => {
    for (const bad of [
      { imageDigest: "latest" },
      { imageDigest: "sha256:short" },
      { autoRemove: true as never },
      { readOnlyRootfs: false as never },
      { noNewPrivileges: false as never },
    ]) {
      expect(() => assertRemoteWorkerCellContainerSpecSafe({ ...base, ...bad })).toThrow(WorkerCellContainerSpecError);
    }
  });

  it("rejects host PID/IPC/network, privileged, and re-added capabilities", () => {
    for (const bad of [
      { hostPid: true as never },
      { hostIpc: true as never },
      { hostNetwork: true as never },
      { privileged: true as never },
      { internalNetworkOnly: false as never },
      { droppedCapabilities: [] as never },
      { addedCapabilities: ["NET_ADMIN"] as never },
    ]) {
      expect(() => assertRemoteWorkerCellContainerSpecSafe({ ...base, ...bad })).toThrow(WorkerCellContainerSpecError);
    }
  });

  it("rejects a Docker-socket mount and an unquota'd mount", () => {
    expect(() =>
      assertRemoteWorkerCellContainerSpecSafe({
        ...base,
        mounts: [
          {
            source: "/var/run/docker.sock",
            target: "/var/run/docker.sock",
            readOnly: false,
            kind: "volume",
            quotaBytes: 1,
          },
        ],
      }),
    ).toThrow(/Docker socket/u);
    expect(() =>
      assertRemoteWorkerCellContainerSpecSafe({
        ...base,
        mounts: [{ source: "/cell", target: "/cell", readOnly: false, kind: "volume", quotaBytes: 0 }],
      }),
    ).toThrow(/quota-controlled/u);
  });

  it("rejects non-loopback egress and secret-bearing environment names", () => {
    expect(() =>
      assertRemoteWorkerCellContainerSpecSafe({ ...base, egressProxyUrl: "socks5://10.0.0.1:8080" }),
    ).toThrow(/loopback guarded proxy/u);
    expect(() =>
      buildRemoteWorkerCellContainerSpec(input({ environmentAllowlist: { AWS_SECRET_ACCESS_KEY: "x" } })),
    ).toThrow(/non-secret/u);
    expect(() => buildRemoteWorkerCellContainerSpec(input({ environmentAllowlist: { "bad name": "x" } }))).toThrow(
      /environment name is invalid/u,
    );
  });

  it("rejects a spec missing any CPU/memory/swap/PID/wall/quota limit", () => {
    expect(() => assertRemoteWorkerCellContainerSpecSafe({ ...base, limits: { ...base.limits, pidLimit: 0 } })).toThrow(
      /limit/u,
    );
  });
});
