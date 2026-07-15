import { describe, expect, it } from "vitest";
import {
  COMPANION_PRINCIPAL_PURPOSES,
  CompanionPrincipalPurposeSchema,
  DEFAULT_COMPANION_PRINCIPAL_PURPOSE,
  DefaultedCompanionPrincipalPurposeSchema,
  type DeviceAccessGrantListResponse,
  type DeviceAccessGrantRecord,
  type DeviceAccessGrantRevokeResponse,
  type DeviceAccessRequestCreateInput,
  type DeviceAccessRequestCreateResponse,
  type DeviceAccessRequestDeviceType,
  type DeviceAccessRequestStatus,
  type DeviceAccessRequestStatusResponse,
  type SseTokenIssueResponse,
} from "./auth.js";
import type {
  CompanionAuditEvent,
  CompanionAuditEventListResponse,
  CompanionAuditEventRecord,
  CompanionSessionAdminRecord,
  CompanionSessionExchangeInput,
  CompanionSessionExchangeResponse,
  CompanionSessionInfoResponse,
  CompanionSessionListResponse,
  CompanionSessionRefreshInput,
  CompanionSessionRefreshResponse,
  CompanionSessionRevokeResponse,
  CompanionSessionTokenBundle,
  CompanionSignatureAlgorithm,
} from "./companion-auth.js";
import type { CompanionContractId } from "./companion.js";

type ExactKeys<T, Keys extends PropertyKey> =
  Exclude<keyof T, Keys> extends never ? (Exclude<Keys, keyof T> extends never ? true : false) : false;

const exactKeys = <_Result extends true>(): true => true;

const AUTH_SHAPE_FREEZE: readonly true[] = [
  exactKeys<ExactKeys<SseTokenIssueResponse, "token" | "expiresAt" | "scope">>(),
  exactKeys<ExactKeys<DeviceAccessRequestCreateInput, "deviceLabel" | "deviceType" | "platform">>(),
  exactKeys<
    ExactKeys<
      DeviceAccessRequestCreateResponse,
      "requestId" | "requestSecret" | "approvalId" | "status" | "expiresAt" | "pollAfterMs" | "message"
    >
  >(),
  exactKeys<ExactKeys<DeviceAccessGrantListResponse, "items">>(),
  exactKeys<ExactKeys<DeviceAccessGrantRevokeResponse, "grant">>(),
  exactKeys<
    ExactKeys<
      DeviceAccessRequestStatusResponse,
      | "requestId"
      | "approvalId"
      | "status"
      | "expiresAt"
      | "resolvedAt"
      | "deviceToken"
      | "deviceTokenExpiresAt"
      | "message"
    >
  >(),
  exactKeys<
    ExactKeys<
      DeviceAccessGrantRecord,
      | "grantId"
      | "requestId"
      | "actorId"
      | "deviceLabel"
      | "deviceType"
      | "platform"
      | "grantedBy"
      | "createdAt"
      | "expiresAt"
      | "lastUsedAt"
      | "revokedAt"
      | "metadata"
    >
  >(),
  exactKeys<ExactKeys<CompanionSessionExchangeInput, "signingPublicKeyPem" | "clientName" | "appVersion">>(),
  exactKeys<ExactKeys<CompanionSessionRefreshInput, "refreshToken">>(),
  exactKeys<
    ExactKeys<
      CompanionSessionTokenBundle,
      | "sessionId"
      | "accessToken"
      | "accessTokenExpiresAt"
      | "refreshToken"
      | "refreshTokenExpiresAt"
      | "issuedAt"
      | "signatureAlgorithm"
    >
  >(),
  exactKeys<
    ExactKeys<
      CompanionSessionExchangeResponse,
      | keyof CompanionSessionTokenBundle
      | "contractId"
      | "grantId"
      | "actorId"
      | "deviceLabel"
      | "deviceType"
      | "platform"
    >
  >(),
  exactKeys<
    ExactKeys<CompanionSessionRefreshResponse, keyof CompanionSessionTokenBundle | "contractId" | "grantId" | "actorId">
  >(),
  exactKeys<
    ExactKeys<
      CompanionSessionInfoResponse,
      | "contractId"
      | "sessionId"
      | "grantId"
      | "actorId"
      | "deviceLabel"
      | "deviceType"
      | "platform"
      | "createdAt"
      | "lastSeenAt"
      | "accessTokenExpiresAt"
      | "refreshTokenExpiresAt"
      | "signatureAlgorithm"
      | "metadata"
    >
  >(),
  exactKeys<
    ExactKeys<
      CompanionSessionAdminRecord,
      keyof CompanionSessionInfoResponse | "lastRotatedAt" | "revokedAt" | "grantExpiresAt" | "grantRevokedAt"
    >
  >(),
  exactKeys<ExactKeys<CompanionSessionListResponse, "items">>(),
  exactKeys<ExactKeys<CompanionSessionRevokeResponse, "session">>(),
  exactKeys<
    ExactKeys<
      CompanionAuditEventRecord,
      | "timestamp"
      | "event"
      | "actorId"
      | "deviceId"
      | "grantId"
      | "companionSessionId"
      | "contractId"
      | "method"
      | "path"
      | "nonce"
      | "requestHash"
      | "detail"
      | "metadata"
    >
  >(),
  exactKeys<ExactKeys<CompanionAuditEventListResponse, "items">>(),
];

type ExactType<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
const exactType = <_Result extends true>(): true => true;

type ExpectedCompanionTokenBundle = {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  issuedAt: string;
  signatureAlgorithm: CompanionSignatureAlgorithm;
};
type ExpectedCompanionInfo = {
  contractId: CompanionContractId;
  sessionId: string;
  grantId: string;
  actorId: string;
  deviceLabel: string;
  deviceType: DeviceAccessRequestDeviceType;
  platform?: string;
  createdAt: string;
  lastSeenAt?: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  signatureAlgorithm: CompanionSignatureAlgorithm;
  metadata: Record<string, unknown>;
};

const AUTH_TYPE_FREEZE: readonly true[] = [
  exactType<
    ExactType<
      SseTokenIssueResponse,
      { token: string; expiresAt: string; scope: "events:stream" | "dev:diagnostics:stream" }
    >
  >(),
  exactType<
    ExactType<
      DeviceAccessRequestCreateInput,
      { deviceLabel?: string; deviceType?: DeviceAccessRequestDeviceType; platform?: string }
    >
  >(),
  exactType<
    ExactType<
      DeviceAccessRequestCreateResponse,
      {
        requestId: string;
        requestSecret: string;
        approvalId: string;
        status: DeviceAccessRequestStatus;
        expiresAt: string;
        pollAfterMs: number;
        message: string;
      }
    >
  >(),
  exactType<
    ExactType<
      DeviceAccessRequestStatusResponse,
      {
        requestId: string;
        approvalId: string;
        status: DeviceAccessRequestStatus;
        expiresAt: string;
        resolvedAt?: string;
        deviceToken?: string;
        deviceTokenExpiresAt?: string;
        message: string;
      }
    >
  >(),
  exactType<
    ExactType<
      DeviceAccessGrantRecord,
      {
        grantId: string;
        requestId: string;
        actorId: string;
        deviceLabel: string;
        deviceType: DeviceAccessRequestDeviceType;
        platform?: string;
        grantedBy: string;
        createdAt: string;
        expiresAt?: string;
        lastUsedAt?: string;
        revokedAt?: string;
        metadata: Record<string, unknown>;
      }
    >
  >(),
  exactType<ExactType<DeviceAccessGrantListResponse, { items: DeviceAccessGrantRecord[] }>>(),
  exactType<ExactType<DeviceAccessGrantRevokeResponse, { grant: DeviceAccessGrantRecord }>>(),
  exactType<
    ExactType<CompanionSessionExchangeInput, { signingPublicKeyPem: string; clientName?: string; appVersion?: string }>
  >(),
  exactType<ExactType<CompanionSessionRefreshInput, { refreshToken: string }>>(),
  exactType<ExactType<CompanionSessionTokenBundle, ExpectedCompanionTokenBundle>>(),
  exactType<
    ExactType<
      CompanionSessionExchangeResponse,
      ExpectedCompanionTokenBundle & {
        contractId: CompanionContractId;
        grantId: string;
        actorId: string;
        deviceLabel: string;
        deviceType: DeviceAccessRequestDeviceType;
        platform?: string;
      }
    >
  >(),
  exactType<
    ExactType<
      CompanionSessionRefreshResponse,
      ExpectedCompanionTokenBundle & { contractId: CompanionContractId; grantId: string; actorId: string }
    >
  >(),
  exactType<ExactType<CompanionSessionInfoResponse, ExpectedCompanionInfo>>(),
  exactType<
    ExactType<
      CompanionSessionAdminRecord,
      ExpectedCompanionInfo & {
        lastRotatedAt: string;
        revokedAt?: string;
        grantExpiresAt?: string;
        grantRevokedAt?: string;
      }
    >
  >(),
  exactType<ExactType<CompanionSessionListResponse, { items: CompanionSessionAdminRecord[] }>>(),
  exactType<ExactType<CompanionSessionRevokeResponse, { session: CompanionSessionAdminRecord }>>(),
  exactType<
    ExactType<
      CompanionAuditEventRecord,
      {
        timestamp: string;
        event: CompanionAuditEvent;
        actorId?: string;
        deviceId?: string;
        grantId?: string;
        companionSessionId?: string;
        contractId?: CompanionContractId;
        method?: string;
        path?: string;
        nonce?: string;
        requestHash?: string;
        detail?: string;
        metadata?: Record<string, unknown>;
      }
    >
  >(),
  exactType<ExactType<CompanionAuditEventListResponse, { items: CompanionAuditEventRecord[] }>>(),
];

describe("companion principal purpose contract", () => {
  it("accepts exactly the two frozen purposes without coercion", () => {
    expect(COMPANION_PRINCIPAL_PURPOSES).toEqual(["general_companion", "session_control_client"]);
    expect(DEFAULT_COMPANION_PRINCIPAL_PURPOSE).toBe("general_companion");
    expect(DefaultedCompanionPrincipalPurposeSchema.parse(undefined)).toBe("general_companion");
    expect(CompanionPrincipalPurposeSchema.parse("general_companion")).toBe("general_companion");
    expect(CompanionPrincipalPurposeSchema.parse("session_control_client")).toBe("session_control_client");
    for (const malformed of ["", "GENERAL_COMPANION", " general_companion", "general_companion ", "admin", null]) {
      expect(CompanionPrincipalPurposeSchema.safeParse(malformed).success).toBe(false);
      expect(DefaultedCompanionPrincipalPurposeSchema.safeParse(malformed).success).toBe(false);
    }
    const secretPurpose = "apiKey_SUPER_SECRET_abc123";
    const result = CompanionPrincipalPurposeSchema.safeParse(secretPurpose);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).not.toContain(secretPurpose);
  });

  it("keeps every existing auth and companion projection purpose-free", () => {
    expect(AUTH_SHAPE_FREEZE.every(Boolean)).toBe(true);
    expect(AUTH_TYPE_FREEZE.every(Boolean)).toBe(true);

    const request: DeviceAccessRequestCreateInput = {
      deviceLabel: "CLI",
      // @ts-expect-error Purpose must not enter the live device request in this tranche.
      purpose: "session_control_client",
    };
    const exchange: CompanionSessionExchangeInput = {
      signingPublicKeyPem: "public-key",
      // @ts-expect-error Exchange cannot select or broaden a stored purpose.
      purpose: "session_control_client",
    };
    const refresh: CompanionSessionRefreshInput = {
      refreshToken: "refresh-token",
      // @ts-expect-error Refresh cannot select or broaden a stored purpose.
      purpose: "session_control_client",
    };
    expect([request.deviceLabel, exchange.signingPublicKeyPem, refresh.refreshToken]).toEqual([
      "CLI",
      "public-key",
      "refresh-token",
    ]);
  });
});
