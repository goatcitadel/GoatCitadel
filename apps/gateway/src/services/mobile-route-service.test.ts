import { describe, expect, it, vi } from "vitest";
import type { MobileContextEnvelope, MobileNativeCapabilityRecord } from "@goatcitadel/contracts";
import { createMobileRoutePort, sanitizeMobileContextForAudit } from "./mobile-route-service.js";

describe("mobile-route-service", () => {
  it("redacts sensitive structured context fields before audit", () => {
    const context: MobileContextEnvelope = {
      capabilityId: "location_context",
      capturedAt: "2026-05-22T12:00:00.000Z",
      sensitivity: "moderate",
      summary: "Near user request",
      structuredFields: {
        latitude: "37.7749",
        longitude: "-122.4194",
        approxLatitude: "37.775",
        approxLongitude: "-122.419",
        notificationBody: "secret message",
        place: "San Francisco, CA",
      },
      userVisibleReason: "near me",
    };

    expect(sanitizeMobileContextForAudit(context).structuredFields).toEqual({
      latitude: "[REDACTED]",
      longitude: "[REDACTED]",
      approxLatitude: "37.775",
      approxLongitude: "-122.419",
      notificationBody: "[REDACTED]",
      place: "San Francisco, CA",
    });
  });

  it("records heartbeat audit and derives current capabilities", async () => {
    const records: Record<string, unknown>[] = [];
    const audit = {
      append: vi.fn(async (_stream: string, payload: Record<string, unknown>) => {
        records.push(payload);
      }),
      list: vi.fn(async () => records),
    };
    const publishRealtime = vi.fn();
    const service = createMobileRoutePort({
      storage: { audit } as never,
      publishRealtime,
    });
    const capability = createCapability("location_context");

    await service.recordMobileCapabilityHeartbeat(
      { observedAt: "2026-05-22T12:00:00.000Z", capabilities: [capability] },
      { companionSessionId: "companion-1", deviceId: "device-1" },
    );

    await expect(service.listMobileCapabilities()).resolves.toEqual({
      items: [expect.objectContaining({ capabilityId: "location_context" })],
    });
    expect(audit.append).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        eventType: "mobile.capability_heartbeat",
        companionSessionId: "companion-1",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith("mobile_capability_heartbeat", "mobile", expect.any(Object));
  });
});

function createCapability(capabilityId: MobileNativeCapabilityRecord["capabilityId"]): MobileNativeCapabilityRecord {
  return {
    capabilityId,
    label: capabilityId,
    summary: capabilityId,
    state: "available",
    permissionState: "promptable",
    sensitivity: "moderate",
    collectionMode: "user_initiated",
    implementationStatus: "ready",
    consentRequired: true,
    consentGranted: false,
    backgroundCapable: false,
    provenance: {
      platform: "android",
      source: "mobile_app",
    },
  };
}
