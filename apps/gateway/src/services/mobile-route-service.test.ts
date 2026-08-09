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
      mobilePush: createMobilePushMock(),
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

  it("applies capability list limits after deriving latest records", async () => {
    const records: Record<string, unknown>[] = [
      {
        eventType: "mobile.capability_heartbeat",
        capabilities: [createCapability("notification_awareness"), createCapability("location_context")],
      },
      {
        eventType: "mobile.capability_heartbeat",
        capabilities: [createCapability("camera_capture")],
      },
    ];
    const service = createMobileRoutePort({
      storage: { audit: { append: vi.fn(), list: vi.fn(async () => records) } } as never,
      mobilePush: createMobilePushMock(),
      publishRealtime: vi.fn(),
    });

    await expect(service.listMobileCapabilities({ limit: 2 })).resolves.toEqual({
      items: [
        expect.objectContaining({ capabilityId: "camera_capture" }),
        expect.objectContaining({ capabilityId: "location_context" }),
      ],
    });
  });

  it("returns the newest matching mobile audit entries without reversing the whole log", async () => {
    const records = [
      { eventType: "mobile.capability_heartbeat", capabilityId: "location_context", eventId: "old" },
      { eventType: "approval.created", capabilityId: "location_context", eventId: "ignored" },
      { eventType: "mobile.context_audit", capabilityId: "camera_capture", eventId: "other-capability" },
      { eventType: "mobile.context_audit", capabilityId: "location_context", eventId: "newer" },
      { eventType: "mobile.push_registration", capabilityId: "location_context", eventId: "newest" },
    ];
    const service = createMobileRoutePort({
      storage: { audit: { append: vi.fn(), list: vi.fn(async () => records) } } as never,
      mobilePush: createMobilePushMock(),
      publishRealtime: vi.fn(),
    });

    await expect(service.listMobileAudit({ capabilityId: "location_context", limit: 2 })).resolves.toEqual({
      items: [expect.objectContaining({ eventId: "newest" }), expect.objectContaining({ eventId: "newer" })],
    });
  });

  it("publishes context capability ids for accepted contexts only", async () => {
    const records: Record<string, unknown>[] = [];
    const publishRealtime = vi.fn();
    const service = createMobileRoutePort({
      storage: {
        audit: {
          append: vi.fn(async (_stream: string, payload: Record<string, unknown>) => {
            records.push(payload);
          }),
          list: vi.fn(async () => records),
        },
      } as never,
      mobilePush: createMobilePushMock(),
      publishRealtime,
    });
    const contexts = Array.from({ length: 14 }, (_, index) =>
      createContext(index === 13 ? "notification_awareness" : "location_context", index),
    );

    await expect(service.recordMobileContextAudit({ contexts }, { deviceId: "device-1" })).resolves.toMatchObject({
      accepted: 12,
    });

    expect(records).toHaveLength(12);
    expect(publishRealtime).toHaveBeenCalledWith(
      "mobile_context_audit_recorded",
      "mobile",
      expect.objectContaining({
        accepted: 12,
        capabilityIds: Array.from({ length: 12 }, () => "location_context"),
      }),
    );
  });

  it("delegates the raw token to custody without persisting or publishing it", async () => {
    const records: Record<string, unknown>[] = [];
    const mobilePush = createMobilePushMock();
    const publishRealtime = vi.fn();
    const service = createMobileRoutePort({
      storage: {
        audit: {
          append: vi.fn(async (_stream: string, payload: Record<string, unknown>) => records.push(payload)),
          list: vi.fn(async () => records),
        },
      } as never,
      mobilePush,
      publishRealtime,
    });
    const rawToken = "ExpoPushToken[raw-secret-value]";

    await service.registerMobilePush(
      { provider: "expo", enabled: true, token: rawToken, deviceLabel: "Pixel" },
      { grantId: "grant-1", companionSessionId: "companion-1" },
    );

    expect(mobilePush.register).toHaveBeenCalledWith(
      expect.objectContaining({ token: rawToken }),
      expect.objectContaining({ grantId: "grant-1" }),
    );
    expect(JSON.stringify(records)).not.toContain(rawToken);
    expect(JSON.stringify(records)).not.toMatch(/tokenHash|tokenPreview|tokenSha|secretRef/i);
    expect(JSON.stringify(publishRealtime.mock.calls)).not.toContain(rawToken);
  });

  it("revokes grant-bound push registrations during panic-off", async () => {
    const mobilePush = createMobilePushMock();
    const service = createMobileRoutePort({
      storage: { audit: { append: vi.fn(), list: vi.fn(async () => []) } } as never,
      mobilePush,
      publishRealtime: vi.fn(),
    });

    await service.revokeMobileCapabilities({ reason: "panic_off" }, { grantId: "grant-1" });

    expect(mobilePush.revokeGrant).toHaveBeenCalledWith("grant-1");
  });
});

function createMobilePushMock() {
  return {
    register: vi.fn(async (input: { provider: "expo" | "fcm"; enabled: boolean }) => ({
      registrationId: "mpr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      provider: input.provider,
      registeredAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      enabled: input.enabled,
      deliveryAvailability: "unavailable" as const,
      revision: 1,
    })),
    revokeGrant: vi.fn(async () => [
      {
        registrationId: "mpr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        grantId: "grant-1",
        provider: "expo" as const,
        tokenSecretRef: "keychain:goatcitadel:mobile-push:mpr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        lifecycleState: "revoked" as const,
        revision: 2,
        registeredAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        revokedAt: "2026-08-09T00:01:00.000Z",
      },
    ]),
  };
}

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

function createContext(capabilityId: MobileContextEnvelope["capabilityId"], index: number): MobileContextEnvelope {
  return {
    capabilityId,
    capturedAt: `2026-05-22T12:${String(index).padStart(2, "0")}:00.000Z`,
    sensitivity: "moderate",
    summary: `Context ${index}`,
    structuredFields: {
      place: "San Francisco, CA",
    },
    userVisibleReason: "operator requested mobile context",
  };
}
