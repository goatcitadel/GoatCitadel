import { z } from "zod";

export const COMPANION_PRINCIPAL_PURPOSES = ["general_companion", "session_control_client"] as const;
export const DEFAULT_COMPANION_PRINCIPAL_PURPOSE = "general_companion" as const;
export type CompanionPrincipalPurpose = (typeof COMPANION_PRINCIPAL_PURPOSES)[number];

export const CompanionPrincipalPurposeSchema = z
  .string()
  .refine(
    (value): value is CompanionPrincipalPurpose =>
      COMPANION_PRINCIPAL_PURPOSES.includes(value as CompanionPrincipalPurpose),
    { message: "Companion principal purpose is invalid." },
  );
export const DefaultedCompanionPrincipalPurposeSchema = CompanionPrincipalPurposeSchema.default(
  DEFAULT_COMPANION_PRINCIPAL_PURPOSE,
);

/**
 * Coerces any stored/persisted purpose value to one of the two frozen purposes.
 * Only the exact confined purpose (`session_control_client`) is preserved; every
 * other value — legacy nulls, corrupt rows, or unexpected strings — fails safe to
 * the generic `general_companion`, so a broken value can never widen a principal
 * into session-control authority. Approval/exchange/refresh inputs never supply
 * this; the value is always server-owned and immutable in storage.
 */
export function normalizeCompanionPrincipalPurpose(value: unknown): CompanionPrincipalPurpose {
  return value === "session_control_client" ? "session_control_client" : DEFAULT_COMPANION_PRINCIPAL_PURPOSE;
}

export interface SseTokenIssueResponse {
  token: string;
  expiresAt: string;
  scope: "events:stream" | "dev:diagnostics:stream";
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
  /** Server-owned, immutable purpose carried from the approved device request. */
  principalPurpose: CompanionPrincipalPurpose;
}

export interface DeviceAccessGrantListResponse {
  items: DeviceAccessGrantRecord[];
}

export interface DeviceAccessGrantRevokeResponse {
  grant: DeviceAccessGrantRecord;
}
