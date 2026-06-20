import { describe, expect, it } from "vitest";
import {
  assertNoCallableExposureForUnsafeRuntimes,
  normalizePluginProviderRuntimeStatus,
  runtimeStatusToCapabilityAvailability,
} from "./plugin-provider-governance-service.js";

describe("plugin/provider governance", () => {
  it("keeps corrupt plugin manifests unavailable and non-callable", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "plugin-corrupt",
      kind: "plugin",
      label: "Corrupt Plugin",
      integrityStatus: "corrupt",
      runtimeAvailable: true,
      approvedForCallableUse: true,
      healthOk: true,
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    expect(status.status).toBe("unavailable");
    expect(status.callableExposure).toBe("unavailable");
    expect(status.healthMessage).toContain("corrupt");
    expect(runtimeStatusToCapabilityAvailability(status).callable).toBe(false);
  });

  it("keeps corrupt provider manifests quarantined from callable exposure", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "provider-corrupt",
      kind: "provider",
      label: "Corrupt Provider",
      integrityStatus: "quarantined",
      runtimeAvailable: true,
      approvedForCallableUse: true,
      healthOk: true,
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    expect(status.status).toBe("unavailable");
    expect(status.callableExposure).toBe("unavailable");
    expect(runtimeStatusToCapabilityAvailability(status)).toMatchObject({
      status: "unavailable",
      callable: false,
    });
  });

  it("keeps missing plugin/provider runtime inspectable but not configured", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "provider-missing-secret",
      kind: "provider",
      label: "Provider Missing Secret",
      integrityStatus: "verified",
      runtimeAvailable: false,
      approvedForCallableUse: true,
      healthOk: false,
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    expect(status.status).toBe("not_configured");
    expect(status.callableExposure).toBe("not_configured");
    expect(runtimeStatusToCapabilityAvailability(status).callable).toBe(false);
  });

  it("blocks unapproved provider profiles even when configured and healthy", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "provider-beta",
      kind: "provider",
      label: "Provider Beta",
      integrityStatus: "verified",
      runtimeAvailable: true,
      approvedForCallableUse: false,
      healthOk: true,
      secretsRequired: ["API_KEY", "API_KEY"],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    const capability = runtimeStatusToCapabilityAvailability(status);
    expect(status.status).toBe("blocked");
    expect(capability.status).toBe("blocked");
    expect(capability.reasons).toContain("Runtime status: blocked");
    expect(capability.reasons).toContain("Missing SecretRefs: API_KEY");
  });

  it("blocks otherwise healthy runtimes when required SecretRefs are missing", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "plugin-missing-secret",
      kind: "plugin",
      label: "Plugin Missing Secret",
      integrityStatus: "verified",
      runtimeAvailable: true,
      approvedForCallableUse: true,
      healthOk: true,
      secretsRequired: ["OPENCLAW_TOKEN", "OPENCLAW_TOKEN"],
      secretsConfigured: [],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    expect(status.status).toBe("blocked");
    expect(status.callableExposure).toBe("blocked");
    expect(status.secretReadiness).toEqual({
      required: ["OPENCLAW_TOKEN"],
      configured: [],
      missing: ["OPENCLAW_TOKEN"],
    });
    expect(status.healthMessage).toContain("Missing required SecretRef");
    expect(runtimeStatusToCapabilityAvailability(status)).toMatchObject({
      callable: false,
      reasons: expect.arrayContaining(["Missing SecretRefs: OPENCLAW_TOKEN"]),
    });
  });

  it("allows callable exposure only after integrity, approval, availability, and health pass", () => {
    const status = normalizePluginProviderRuntimeStatus({
      runtimeId: "provider-ready",
      kind: "provider",
      label: "Provider Ready",
      integrityStatus: "verified",
      runtimeAvailable: true,
      approvedForCallableUse: true,
      healthOk: true,
      secretsRequired: ["READY_SECRET"],
      secretsConfigured: ["READY_SECRET"],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });

    expect(status.status).toBe("callable");
    expect(status.secretReadiness).toEqual({
      required: ["READY_SECRET"],
      configured: ["READY_SECRET"],
      missing: [],
    });
    expect(runtimeStatusToCapabilityAvailability(status)).toMatchObject({
      capabilityId: "provider:provider-ready",
      family: "provider",
      status: "callable",
      callable: true,
      reasons: [],
    });
  });

  it("detects impossible unsafe callable records as a behavioral proof failure", () => {
    const proof = assertNoCallableExposureForUnsafeRuntimes([
      {
        runtimeId: "bad",
        kind: "plugin",
        label: "Bad",
        status: "unavailable",
        integrityStatus: "quarantined",
        permissions: [],
        secretsRequired: [],
        callableExposure: "callable",
      },
    ]);

    expect(proof.passed).toBe(false);
    expect(proof.failures[0]?.runtimeId).toBe("bad");
  });
});
