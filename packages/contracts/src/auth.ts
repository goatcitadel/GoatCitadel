export interface SseTokenIssueResponse {
  token: string;
  expiresAt: string;
  scope: "events:stream";
}

export type DeviceAccessRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type DeviceAccessRequestDeviceType = "mobile" | "desktop" | "tablet" | "browser" | "unknown";

export interface DeviceAccessRequestCreateInput {
  deviceLabel?: string;
  deviceType?: DeviceAccessRequestDeviceType;
  platform?: string;
}

export interface DeviceAccessRequestCreateResponse {
  requestId: string;
  requestSecret: string;
  approvalId: string;
  status: DeviceAccessRequestStatus;
  expiresAt: string;
  pollAfterMs: number;
  message: string;
}

export interface DeviceAccessRequestStatusResponse {
  requestId: string;
  approvalId: string;
  status: DeviceAccessRequestStatus;
  expiresAt: string;
  resolvedAt?: string;
  deviceToken?: string;
  deviceTokenExpiresAt?: string;
  message: string;
}

export interface DeviceAccessGrantRecord {
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

export interface DeviceAccessGrantListResponse {
  items: DeviceAccessGrantRecord[];
}

export interface DeviceAccessGrantRevokeResponse {
  grant: DeviceAccessGrantRecord;
}
