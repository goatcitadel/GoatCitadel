import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MOBILE_NATIVE_CAPABILITY_IDS,
  type MobileCapabilityHeartbeatRequest,
  type MobileContextEnvelope,
  type MobileNativeCapabilityId,
  type MobileNativeCapabilityRecord,
  type MobilePushApprovalRefreshPayload,
  type MobilePushRegistrationResponse,
  mobilePushRegistrationRequestSchema,
} from "./mobile.js";

describe("mobile native contracts", () => {
  it("exports the expected capability ids", () => {
    expect(MOBILE_NATIVE_CAPABILITY_IDS).toContain("location_context");
    expect(MOBILE_NATIVE_CAPABILITY_IDS).toContain("approval_key");
    expect(MOBILE_NATIVE_CAPABILITY_IDS).toContain("call_screening");
  });

  it("types request-scoped mobile context envelopes", () => {
    expectTypeOf<MobileContextEnvelope>().toMatchTypeOf<{
      capabilityId: MobileNativeCapabilityId;
      capturedAt: string;
      sensitivity: "low" | "moderate" | "high";
      summary: string;
      structuredFields: Record<string, string>;
      userVisibleReason: string;
    }>();
  });

  it("types capability heartbeat payloads", () => {
    expectTypeOf<MobileCapabilityHeartbeatRequest["capabilities"]>().toMatchTypeOf<MobileNativeCapabilityRecord[]>();
  });

  it("accepts a raw provider token only for an enabled signed registration boundary", () => {
    expect(
      mobilePushRegistrationRequestSchema.parse({ provider: "expo", enabled: true, token: "ExpoPushToken[value]" }),
    ).toEqual({ provider: "expo", enabled: true, token: "ExpoPushToken[value]" });
    expect(mobilePushRegistrationRequestSchema.parse({ provider: "fcm", enabled: false })).toEqual({
      provider: "fcm",
      enabled: false,
    });
    expect(
      mobilePushRegistrationRequestSchema.safeParse({
        provider: "expo",
        enabled: true,
        tokenHash: "caller-controlled",
        tokenPreview: "leaky",
      }).success,
    ).toBe(false);
    expect(mobilePushRegistrationRequestSchema.safeParse({ provider: "local_only", enabled: false }).success).toBe(
      false,
    );
  });

  it("keeps approval refresh payloads content-free and deep-link typed", () => {
    expectTypeOf<MobilePushApprovalRefreshPayload>().toEqualTypeOf<{
      schemaVersion: 1;
      type: "approval_refresh";
      realtimeEventId: string;
      approvalId: string;
      deepLink: { kind: "approval"; approvalId: string };
    }>();
    expectTypeOf<MobilePushRegistrationResponse["deliveryAvailability"]>().toEqualTypeOf<"available" | "unavailable">();
  });
});
