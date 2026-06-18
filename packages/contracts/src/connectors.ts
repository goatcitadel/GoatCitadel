export type ConnectorType = "browser" | "mcp_server" | "integration_connection";

export type ConnectorCapabilityId =
  | "inbound_messages"
  | "outbound_messages"
  | "approvals"
  | "health_checks"
  | "interactive_actions";

export interface ConnectorCapability {
  id: ConnectorCapabilityId;
  version: string;
  enabled: boolean;
}

export interface ConnectorRecord {
  connectorId: string;
  connectorType: ConnectorType;
  label: string;
  sourceId: string;
  status: "active" | "disabled" | "degraded";
  capabilities: ConnectorCapability[];
  metadata?: Record<string, unknown>;
  lastSeenAt?: string;
  lastError?: string;
}

export interface IConnector {
  readonly connectorId: string;
  readonly connectorType: ConnectorType;
  readonly capabilities: ConnectorCapability[];
}

export type ConnectorEnrollmentStatus = "challenge_issued" | "disabled" | "active" | "expired" | "failed_signature";

export interface ConnectorEnrollmentChallengeRequest {
  connectorType: ConnectorType;
  label: string;
  sourceId?: string;
  publicKeyPem: string;
  capabilities?: ConnectorCapability[];
}

export interface ConnectorEnrollmentRecord {
  enrollmentId: string;
  connectorId: string;
  connectorType: ConnectorType;
  label: string;
  sourceId: string;
  status: ConnectorEnrollmentStatus;
  challenge: string;
  challengeExpiresAt: string;
  publicKeyFingerprint: string;
  capabilities: ConnectorCapability[];
  createdAt: string;
  completedAt?: string;
  activatedAt?: string;
  activatedBy?: string;
  lastHealthCheckAt?: string;
  lastError?: string;
}

export interface ConnectorEnrollmentChallengeResponse {
  enrollment: ConnectorEnrollmentRecord;
  challenge: string;
  signatureAlgorithm: "ed25519";
}

export interface ConnectorEnrollmentCompleteRequest {
  signatureBase64: string;
}

export interface ConnectorEnrollmentActivateRequest {
  approvedBy: string;
}

export interface ConnectorEnrollmentHealthResponse {
  enrollmentId: string;
  connectorId: string;
  status: ConnectorEnrollmentStatus;
  callable: boolean;
  checkedAt: string;
  blockers: string[];
}
