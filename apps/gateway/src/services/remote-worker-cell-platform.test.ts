import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerCellPlatformIdentity } from "@goatcitadel/contracts";
import {
  WorkerCellBackendUnavailableError,
  assertWorkerCellBackendSupported,
  planRemoteWorkerCellPlatformIdentity,
  planRemoteWorkerCellPlatformIdentitySha256,
  planNativeWindowsWorkerCellPlatform,
  type WindowsCellBackendCapabilities,
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
  it("requires all native Windows controls and derives a distinct pinned v2 identity", () => {
    const capabilities: WindowsCellBackendCapabilities = {
      backend: "windows_native",
      platform: "win32",
      architecture: "x64",
      buildNumber: 22631,
      signedHelperVerified: true,
      protectedVolumeReady: true,
      appContainerReady: true,
      jobLimitsReady: true,
      stdioHandleAllowlistReady: true,
      quotaEnforcementReady: true,
    };
    const request = {
      registryWorkspaceId: "default",
      assignmentId: "a1",
      assignmentGeneration: 1,
      cellId: "c1",
      volumeIdentitySha256: "a".repeat(64),
      runtimeBundleSha256: "b".repeat(64),
      launcherSha256: "c".repeat(64),
    };
    const platform = planNativeWindowsWorkerCellPlatform(request, capabilities);
    expect(platform).toMatchObject({
      backend: "windows_native",
      networkPolicy: "deny_all",
      jobName: expect.stringMatching(/^gc-cell-[a-f0-9]{32}$/),
    });
    expect(planNativeWindowsWorkerCellPlatform(request, capabilities)).toEqual(platform);
    expect(planNativeWindowsWorkerCellPlatform({ ...request, assignmentGeneration: 2 }, capabilities).jobName).not.toBe(
      platform.jobName,
    );
    for (const control of [
      "signedHelperVerified",
      "protectedVolumeReady",
      "appContainerReady",
      "jobLimitsReady",
      "stdioHandleAllowlistReady",
      "quotaEnforcementReady",
    ] as const) {
      expect(() => planNativeWindowsWorkerCellPlatform(request, { ...capabilities, [control]: false })).toThrow(
        WorkerCellBackendUnavailableError,
      );
    }
    expect(() => planNativeWindowsWorkerCellPlatform(request, { ...capabilities, buildNumber: 19045 })).toThrow();
    expect(() =>
      normalizeRemoteWorkerCellPlatformIdentity({ ...platform, networkPolicy: "allowlisted" } as never),
    ).toThrow();
  });
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
