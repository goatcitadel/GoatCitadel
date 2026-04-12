/**
 * Shared constants, types, and pure helpers for device-access and
 * companion-session flows.
 *
 * These helpers are intentionally shared by gateway-service.ts and
 * settings-auth-service.ts because both still participate in the same
 * auth/runtime surface.
 */

import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import {
  ValidationError,
  type CompanionSignatureAlgorithm,
  type DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
  type DeviceAccessRequestStatus,
  type DeviceAccessRequestStatusResponse,
} from "@goatcitadel/contracts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEVICE_ACCESS_APPROVAL_KIND = "auth.device_access";
export const DEVICE_ACCESS_REQUEST_POLL_AFTER_MS = 2_500;
export const DEVICE_ACCESS_REQUEST_TTL_MS = 10 * 60 * 1000;
export const DEVICE_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_ACCESS_SECRET_BYTES = 24;
export const DEVICE_ACCESS_TOKEN_BYTES = 32;

export const COMPANION_CONTRACT_ID = "companion.android.v1";
export const COMPANION_SIGNATURE_ALGORITHM: CompanionSignatureAlgorithm = "ed25519";
export const COMPANION_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const COMPANION_REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const COMPANION_ACCESS_TOKEN_BYTES = 32;
export const COMPANION_REFRESH_TOKEN_BYTES = 32;
export const COMPANION_MAX_PUBLIC_KEY_PEM_LENGTH = 4_096;
export const COMPANION_REQUEST_NONCE_MAX_LENGTH = 160;
export const COMPANION_REQUEST_SIGNATURE_MAX_LENGTH = 1_024;
export const COMPANION_REQUEST_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const COMPANION_REQUEST_REPLAY_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthDeviceRequestRecord {
  requestId: string;
  approvalId: string;
  requestSecretHash: string;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  requestedOrigin?: string;
  requestedIp?: string;
  userAgent?: string;
  status: DeviceAccessRequestStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  approvedTokenPlaintext?: string;
  approvedTokenExpiresAt?: string;
  deliveredAt?: string;
}

export interface AuthDeviceGrantRecord {
  grantId: string;
  requestId: string;
  tokenHash: string;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  grantedBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Crypto / token helpers
// ---------------------------------------------------------------------------

export function hashSensitiveToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Timing-safe string comparison. Must only be called with fixed-length
 * inputs (e.g. SHA-256 hex digests). For variable-length secrets, hash
 * both sides first.
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

// ---------------------------------------------------------------------------
// Device-access normalizers
// ---------------------------------------------------------------------------

export function normalizeDeviceAccessDeviceType(value?: string): DeviceAccessGrantContractRecord["deviceType"] {
  if (value === "mobile" || value === "desktop" || value === "tablet" || value === "browser") {
    return value;
  }
  return "unknown";
}

export function normalizeOptionalDeviceAccessText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

export function normalizeDeviceAccessLabel(
  value: string | undefined,
  context: {
    deviceType: string;
    platform?: string;
    userAgent?: string;
  },
): string {
  const provided = normalizeOptionalDeviceAccessText(value, 120);
  if (provided) {
    return provided;
  }
  const platform = context.platform?.trim();
  const browser = inferBrowserFromUserAgent(context.userAgent);
  if (platform && browser) {
    return `${platform} ${browser}`;
  }
  if (platform) {
    return platform;
  }
  return context.deviceType === "unknown"
    ? "New device"
    : `${context.deviceType[0]?.toUpperCase() ?? ""}${context.deviceType.slice(1)} device`;
}

export function inferPlatformFromUserAgent(userAgent?: string): string | undefined {
  const ua = userAgent?.toLowerCase() ?? "";
  if (!ua) {
    return undefined;
  }
  if (ua.includes("iphone")) {
    return "iPhone";
  }
  if (ua.includes("ipad")) {
    return "iPad";
  }
  if (ua.includes("android")) {
    return "Android";
  }
  if (ua.includes("windows")) {
    return "Windows";
  }
  if (ua.includes("mac os x") || ua.includes("macintosh")) {
    return "macOS";
  }
  if (ua.includes("linux")) {
    return "Linux";
  }
  return undefined;
}

export function inferBrowserFromUserAgent(userAgent?: string): string | undefined {
  const ua = userAgent?.toLowerCase() ?? "";
  if (!ua) {
    return undefined;
  }
  if (ua.includes("edg/")) {
    return "Edge";
  }
  if (ua.includes("chrome/") && !ua.includes("edg/")) {
    return "Chrome";
  }
  if (ua.includes("firefox/")) {
    return "Firefox";
  }
  if (ua.includes("safari/") && !ua.includes("chrome/")) {
    return "Safari";
  }
  return undefined;
}

export function normalizeDeviceAccessRequestStatus(value: unknown): DeviceAccessRequestStatus {
  if (value === "approved" || value === "rejected" || value === "expired") {
    return value;
  }
  return "pending";
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function safeJsonParseRecord(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function mapAuthDeviceRequestRow(row: Record<string, unknown>): AuthDeviceRequestRecord {
  return {
    requestId: String(row.request_id ?? ""),
    approvalId: String(row.approval_id ?? ""),
    requestSecretHash: String(row.request_secret_hash ?? ""),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    requestedOrigin: typeof row.requested_origin === "string" ? row.requested_origin : undefined,
    requestedIp: typeof row.requested_ip === "string" ? row.requested_ip : undefined,
    userAgent: typeof row.user_agent === "string" ? row.user_agent : undefined,
    status: normalizeDeviceAccessRequestStatus(row.status),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    expiresAt: String(row.expires_at ?? new Date().toISOString()),
    resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : undefined,
    resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : undefined,
    resolutionNote: typeof row.resolution_note === "string" ? row.resolution_note : undefined,
    approvedTokenPlaintext: typeof row.approved_token_plaintext === "string" ? row.approved_token_plaintext : undefined,
    approvedTokenExpiresAt:
      typeof row.approved_token_expires_at === "string" ? row.approved_token_expires_at : undefined,
    deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : undefined,
  };
}

export function mapAuthDeviceGrantRow(row: Record<string, unknown>): AuthDeviceGrantRecord {
  return {
    grantId: String(row.grant_id ?? ""),
    requestId: String(row.request_id ?? ""),
    tokenHash: String(row.token_hash ?? ""),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    grantedBy: String(row.granted_by ?? ""),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : undefined,
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : undefined,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : undefined,
    metadata: safeJsonParseRecord(typeof row.metadata_json === "string" ? row.metadata_json : "{}", {}),
  };
}

export function toDeviceAccessGrantRecord(grant: AuthDeviceGrantRecord): DeviceAccessGrantContractRecord {
  return {
    grantId: grant.grantId,
    requestId: grant.requestId,
    actorId: `device:${grant.grantId}`,
    deviceLabel: grant.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(grant.deviceType),
    platform: grant.platform,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    lastUsedAt: grant.lastUsedAt,
    revokedAt: grant.revokedAt,
    metadata: grant.metadata,
  };
}

export function mapDeviceAccessStatusResponse(record: AuthDeviceRequestRecord): DeviceAccessRequestStatusResponse {
  if (record.status === "approved") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      ...(record.approvedTokenPlaintext
        ? {
            deviceToken: record.approvedTokenPlaintext,
            deviceTokenExpiresAt: record.approvedTokenExpiresAt,
          }
        : {}),
      message: "Access approved. Finishing secure handoff to this device.",
    };
  }
  if (record.status === "rejected") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      message: "This device request was rejected from another authenticated session.",
    };
  }
  if (record.status === "expired") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      message: "This device request expired before it was approved.",
    };
  }
  return {
    requestId: record.requestId,
    approvalId: record.approvalId,
    status: "pending",
    expiresAt: record.expiresAt,
    message: "Waiting for approval from another authenticated Mission Control session.",
  };
}

// ---------------------------------------------------------------------------
// Companion signing key validation
// ---------------------------------------------------------------------------

export function normalizeCompanionSigningPublicKeyPem(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function assertCompanionSigningPublicKeyPem(value: string): void {
  if (!value || value.length > COMPANION_MAX_PUBLIC_KEY_PEM_LENGTH) {
    throw new ValidationError({
      message: "Signing public key is missing or too large.",
    });
  }
  let publicKey;
  try {
    publicKey = createPublicKey(value);
  } catch {
    throw new ValidationError({
      message: "Signing public key must be a valid PEM-encoded Ed25519 public key.",
    });
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new ValidationError({
      message: "Signing public key must use the Ed25519 algorithm.",
    });
  }
}
