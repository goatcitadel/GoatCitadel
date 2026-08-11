import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MOBILE_NATIVE_CAPABILITY_IDS,
  type MobileApprovalKeyRegistrationResponse,
  type MobileCapabilityHeartbeatRequest,
  type MobileContextEnvelope,
  type MobileNativeCapabilityId,
  type MobileNativeCapabilityRecord,
  type MobilePushApprovalRefreshPayload,
  type MobilePushRegistrationResponse,
  mobileApprovalKeyRegistrationRequestSchema,
  mobileApprovalKeyRevokeRequestSchema,
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

  it("accepts only public Ed25519 material at the approval-key registration boundary", () => {
    const pem =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtesttesttesttesttesttesttesttesttes=\n-----END PUBLIC KEY-----";
    expect(
      mobileApprovalKeyRegistrationRequestSchema.parse({
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: pem,
        keyProvenance: "secure_hardware",
      }),
    ).toEqual({ enabled: true, algorithm: "ed25519", publicKeyPem: pem, keyProvenance: "secure_hardware" });
    expect(mobileApprovalKeyRegistrationRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(
      mobileApprovalKeyRegistrationRequestSchema.safeParse({
        enabled: true,
        algorithm: "rsa",
        publicKeyPem: pem,
        keyProvenance: "software",
      }).success,
    ).toBe(false);
    expect(
      mobileApprovalKeyRegistrationRequestSchema.safeParse({
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: pem,
        keyProvenance: "software",
        publicKeySha256: "caller-controlled",
      }).success,
    ).toBe(false);
    expect(
      mobileApprovalKeyRegistrationRequestSchema.safeParse({
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: pem,
        keyProvenance: "software",
        privateKeyPem: "leaky",
      }).success,
    ).toBe(false);
    expect(mobileApprovalKeyRevokeRequestSchema.parse({ grantId: "grant-1" })).toEqual({ grantId: "grant-1" });
    expect(mobileApprovalKeyRevokeRequestSchema.safeParse({ grantId: "grant-1", force: true }).success).toBe(false);
    expectTypeOf<MobileApprovalKeyRegistrationResponse["verificationAvailability"]>().toEqualTypeOf<
      "available" | "unavailable"
    >();
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
