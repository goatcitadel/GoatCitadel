import { describe, expectTypeOf, it } from "vitest";
import type {
  CompanionAuditEventListResponse,
  CompanionSessionAdminRecord,
  CompanionSessionExchangeInput,
  CompanionSessionExchangeResponse,
  CompanionSessionInfoResponse,
  CompanionSessionListResponse,
  CompanionSessionRevokeResponse,
  CompanionSessionRefreshResponse,
} from "./companion-auth.js";

describe("companion auth contracts", () => {
  it("keeps exchange input tied to PEM-backed signing keys", () => {
    expectTypeOf<CompanionSessionExchangeInput>().toMatchTypeOf<{
      signingPublicKeyPem: string;
      clientName?: string;
      appVersion?: string;
    }>();
  });

  it("exposes session token bundles for exchange and refresh responses", () => {
    expectTypeOf<CompanionSessionExchangeResponse>().toHaveProperty("accessToken").toBeString();
    expectTypeOf<CompanionSessionRefreshResponse>().toHaveProperty("refreshToken").toBeString();
    expectTypeOf<CompanionSessionInfoResponse>().toHaveProperty("signatureAlgorithm").toEqualTypeOf<"ed25519">();
  });

  it("carries the stored immutable principal purpose on exchange, refresh, and session projections", () => {
    expectTypeOf<CompanionSessionExchangeResponse>()
      .toHaveProperty("principalPurpose")
      .toEqualTypeOf<"general_companion" | "session_control_client">();
    expectTypeOf<CompanionSessionRefreshResponse>()
      .toHaveProperty("principalPurpose")
      .toEqualTypeOf<"general_companion" | "session_control_client">();
    expectTypeOf<CompanionSessionInfoResponse>()
      .toHaveProperty("principalPurpose")
      .toEqualTypeOf<"general_companion" | "session_control_client">();
    expectTypeOf<CompanionSessionAdminRecord>()
      .toHaveProperty("principalPurpose")
      .toEqualTypeOf<"general_companion" | "session_control_client">();
  });

  it("exposes admin-facing companion session records", () => {
    expectTypeOf<CompanionSessionAdminRecord>().toHaveProperty("lastRotatedAt").toBeString();
    expectTypeOf<CompanionSessionListResponse["items"]>().toMatchTypeOf<CompanionSessionAdminRecord[]>();
    expectTypeOf<CompanionSessionRevokeResponse>()
      .toHaveProperty("session")
      .toMatchTypeOf<CompanionSessionAdminRecord>();
  });

  it("exposes audit events for companion session diagnostics", () => {
    expectTypeOf<CompanionAuditEventListResponse["items"]>().toMatchTypeOf<
      Array<{
        event:
          | "auth.companion_session.exchange"
          | "auth.companion_session.refresh"
          | "auth.companion_session.revoke"
          | "auth.companion_request.accepted"
          | "auth.companion_request.timestamp_invalid"
          | "auth.companion_request.signature_invalid"
          | "auth.companion_request.replay_rejected"
          | "auth.companion_request.session_inactive";
      }>
    >();
  });
});
