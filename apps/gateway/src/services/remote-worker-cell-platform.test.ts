import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerCellPlatformIdentity } from "@goatcitadel/contracts";
import {
  WorkerCellBackendUnavailableError,
  assertWorkerCellBackendSupported,
  planRemoteWorkerCellPlatformIdentity,
  planRemoteWorkerCellPlatformIdentitySha256,
  type WorkerCellPlatformInput,
} from "./remote-worker-cell-platform.js";

function input(overrides: Partial<WorkerCellPlatformInput> = {}): WorkerCellPlatformInput {
  return {
    registryWorkspaceId: "default",
    assignmentId: "assignment-1",
    assignmentGeneration: 3,
    cellId: "cell-1",
    backend: "container",
    imageDigest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

describe("HX-505 cell platform identity", () => {
  it("derives a deterministic identity the worker cannot choose", () => {
    const first = planRemoteWorkerCellPlatformIdentity(input());
    const second = planRemoteWorkerCellPlatformIdentity(input());
    expect(first).toEqual(second);
    expect(first.containerName).toMatch(/^gc-cell-[0-9a-f]{32}$/u);
    expect(first.networkName).toMatch(/^gc-cell-net-[0-9a-f]{32}$/u);
    expect(first.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Distinct cells get distinct identities.
    expect(planRemoteWorkerCellPlatformIdentity(input({ cellId: "cell-2" })).containerName).not.toBe(
      first.containerName,
    );
    // The derived identity round-trips through the contract normalizer.
    expect(() => normalizeRemoteWorkerCellPlatformIdentity(first)).not.toThrow();
    expect(planRemoteWorkerCellPlatformIdentitySha256(input())).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("requires a digest-pinned image and the container backend", () => {
    expect(() => planRemoteWorkerCellPlatformIdentity(input({ imageDigest: "latest" }))).toThrow(
      WorkerCellBackendUnavailableError,
    );
    expect(() => planRemoteWorkerCellPlatformIdentity(input({ backend: "vm" as never }))).toThrow(
      WorkerCellBackendUnavailableError,
    );
    expect(() => planRemoteWorkerCellPlatformIdentity(input({ namePrefix: "Bad_Prefix" }))).toThrow(
      WorkerCellBackendUnavailableError,
    );
  });

  it("fails closed for an unsupported or partial backend with no host fallback", () => {
    expect(() =>
      assertWorkerCellBackendSupported({
        backend: "container",
        containerRuntimeReady: true,
        internalNetworkReady: true,
        quotaEnforcementReady: true,
      }),
    ).not.toThrow();
    for (const partial of [
      { containerRuntimeReady: false },
      { internalNetworkReady: false },
      { quotaEnforcementReady: false },
      { backend: "vm" as never },
    ]) {
      expect(() =>
        assertWorkerCellBackendSupported({
          backend: "container",
          containerRuntimeReady: true,
          internalNetworkReady: true,
          quotaEnforcementReady: true,
          ...partial,
        }),
      ).toThrow(WorkerCellBackendUnavailableError);
    }
  });
});
