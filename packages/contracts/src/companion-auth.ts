import type { CompanionPrincipalPurpose, DeviceAccessRequestDeviceType } from "./auth.js";
import type { CompanionContractId } from "./companion.js";

export type CompanionSignatureAlgorithm = "ed25519";

export type CompanionAuditEvent =
  | "auth.companion_session.exchange"
  | "auth.companion_session.refresh"
  | "auth.companion_session.revoke"
  | "auth.companion_request.accepted"
  | "auth.companion_request.timestamp_invalid"
  | "auth.companion_request.signature_invalid"
  | "auth.companion_request.replay_rejected"
  | "auth.companion_request.session_inactive";

export interface CompanionSessionExchangeInput {
  signingPublicKeyPem: string;
  clientName?: string;
  appVersion?: string;
}

export interface CompanionSessionRefreshInput {
  refreshToken: string;
}

export interface CompanionSessionTokenBundle {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  issuedAt: string;
  signatureAlgorithm: CompanionSignatureAlgorithm;
}

export interface CompanionSessionExchangeResponse extends CompanionSessionTokenBundle {
  contractId: CompanionContractId;
  grantId: string;
  actorId: string;
  deviceLabel: string;
  deviceType: DeviceAccessRequestDeviceType;
  platform?: string;
  /** Server-owned, immutable purpose carried from the device grant. */
  principalPurpose: CompanionPrincipalPurpose;
}

export interface CompanionSessionRefreshResponse extends CompanionSessionTokenBundle {
  contractId: CompanionContractId;
  grantId: string;
  actorId: string;
  /** Server-owned, immutable purpose; refresh can never broaden it. */
  principalPurpose: CompanionPrincipalPurpose;
}

export interface CompanionSessionInfoResponse {
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
  /** Server-owned, immutable purpose the companion session was minted with. */
  principalPurpose: CompanionPrincipalPurpose;
}

export interface CompanionSessionAdminRecord extends CompanionSessionInfoResponse {
  lastRotatedAt: string;
  revokedAt?: string;
  grantExpiresAt?: string;
  grantRevokedAt?: string;
}

export interface CompanionSessionListResponse {
  items: CompanionSessionAdminRecord[];
}

export interface CompanionSessionRevokeResponse {
  session: CompanionSessionAdminRecord;
}

export interface CompanionAuditEventRecord {
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

export interface CompanionAuditEventListResponse {
  items: CompanionAuditEventRecord[];
}
