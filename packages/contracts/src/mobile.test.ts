import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MOBILE_NATIVE_CAPABILITY_IDS,
  type MobileCapabilityHeartbeatRequest,
  type MobileContextEnvelope,
  type MobileNativeCapabilityId,
  type MobileNativeCapabilityRecord,
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
});
