import { createHash } from "node:crypto";
import type {
  CompanionAuditEventRecord,
  CompanionSessionAdminRecord,
  CompanionSessionInfoResponse,
  CompanionSignatureAlgorithm,
} from "@goatcitadel/contracts";
import {
  COMPANION_CONTRACT_ID,
  COMPANION_REQUEST_NONCE_MAX_LENGTH,
  COMPANION_REQUEST_SIGNATURE_MAX_LENGTH,
  normalizeDeviceAccessDeviceType,
} from "./device-access-helpers.js";

export interface CompanionSessionRecord {
  sessionId: string;
  grantId: string;
  accessTokenHash: string;
  accessTokenExpiresAt: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: string;
  signingPublicKeyPem: string;
  signatureAlgorithm: CompanionSignatureAlgorithm;
  createdAt: string;
  lastRotatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  grantExpiresAt?: string;
  grantRevokedAt?: string;
}

export interface CompanionAccessValidationResult {
  actorId: string;
  deviceId: string;
  grantId: string;
  sessionId: string;
}

export function mapCompanionSessionRow(row: Record<string, unknown>): CompanionSessionRecord {
  return {
    sessionId: String(row.session_id ?? ""),
    grantId: String(row.grant_id ?? ""),
    accessTokenHash: String(row.access_token_hash ?? ""),
    // Required credential expiries have no permissive fallback. Missing or
    // malformed persisted values are rejected by the activity predicates.
    accessTokenExpiresAt: typeof row.access_token_expires_at === "string" ? row.access_token_expires_at : "",
    refreshTokenHash: String(row.refresh_token_hash ?? ""),
    refreshTokenExpiresAt: typeof row.refresh_token_expires_at === "string" ? row.refresh_token_expires_at : "",
    signingPublicKeyPem: String(row.signing_public_key_pem ?? ""),
    signatureAlgorithm: row.signature_algorithm === "ed25519" ? "ed25519" : "ed25519",
    createdAt: String(row.created_at ?? new Date().toISOString()),
    lastRotatedAt: String(row.last_rotated_at ?? new Date().toISOString()),
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : undefined,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : undefined,
    metadata: safeJsonParse<Record<string, unknown>>(
      typeof row.metadata_json === "string" ? row.metadata_json : "{}",
      {},
    ),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    grantExpiresAt: typeof row.grant_expires_at === "string" ? row.grant_expires_at : undefined,
    grantRevokedAt: typeof row.grant_revoked_at === "string" ? row.grant_revoked_at : undefined,
  };
}

export function toCompanionSessionInfoResponse(session: CompanionSessionRecord): CompanionSessionInfoResponse {
  return {
    contractId: COMPANION_CONTRACT_ID,
    sessionId: session.sessionId,
    grantId: session.grantId,
    actorId: `companion:${session.sessionId}`,
    deviceLabel: session.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(session.deviceType),
    platform: session.platform,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    signatureAlgorithm: session.signatureAlgorithm,
    metadata: session.metadata,
  };
}

export function toCompanionSessionAdminRecord(session: CompanionSessionRecord): CompanionSessionAdminRecord {
  return {
    ...toCompanionSessionInfoResponse(session),
    lastRotatedAt: session.lastRotatedAt,
    revokedAt: session.revokedAt,
    grantExpiresAt: session.grantExpiresAt,
    grantRevokedAt: session.grantRevokedAt,
  };
}

export function isCompanionSessionCurrentlyActive(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt !== undefined || session.grantRevokedAt !== undefined) {
    return false;
  }
  const now = Date.parse(nowIso);
  const accessExpiresAt = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(accessExpiresAt) || accessExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt !== undefined) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

export function isCompanionSessionRefreshable(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt !== undefined || session.grantRevokedAt !== undefined) {
    return false;
  }
  const now = Date.parse(nowIso);
  const refreshExpiresAt = Date.parse(session.refreshTokenExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt !== undefined) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

export function isCompanionSessionOperatorActive(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt !== undefined || session.grantRevokedAt !== undefined) {
    return false;
  }
  const now = Date.parse(nowIso);
  const refreshExpiresAt = Date.parse(session.refreshTokenExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt !== undefined) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

export function normalizeCompanionAuditEvent(value: unknown): CompanionAuditEventRecord["event"] {
  switch (value) {
    case "auth.companion_session.exchange":
    case "auth.companion_session.refresh":
    case "auth.companion_session.revoke":
    case "auth.companion_request.accepted":
    case "auth.companion_request.timestamp_invalid":
    case "auth.companion_request.signature_invalid":
    case "auth.companion_request.replay_rejected":
    case "auth.companion_request.session_inactive":
      return value;
    default:
      return "auth.companion_request.accepted";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCompanionNonce(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > COMPANION_REQUEST_NONCE_MAX_LENGTH ||
    !/^[A-Za-z0-9._~-]+$/.test(normalized)
  ) {
    throw new Error("Companion request nonce is invalid.");
  }
  return normalized;
}

export function normalizeCompanionSignature(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 16 ||
    normalized.length > COMPANION_REQUEST_SIGNATURE_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new Error("Companion request signature is invalid.");
  }
  return normalized;
}

export function normalizeCompanionRequestPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Companion request path is required.");
  }
  try {
    const parsed = new URL(trimmed, "http://goatcitadel.local");
    if (parsed.search) {
      throw new Error("Companion signed mutations must not include query parameters.");
    }
    return parsed.pathname || "/";
  } catch {
    if (!trimmed.startsWith("/")) {
      throw new Error("Companion request path must be absolute.");
    }
    if (trimmed.includes("?")) {
      throw new Error("Companion signed mutations must not include query parameters.");
    }
    return trimmed.split("?", 1)[0] || "/";
  }
}

export function decodeBase64Url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new Error("Companion request signature encoding is invalid.");
  }
}

export function buildCompanionSigningPayload(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  const method = input.method.trim().toUpperCase();
  const canonicalBody = canonicalizeCompanionBody(input.body);
  const bodyHash = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  return `${method}\n${input.path}\n${input.timestamp.trim()}\n${input.nonce}\n${bodyHash}`;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function canonicalizeCompanionBody(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(sortCompanionJsonValue(value));
}

function sortCompanionJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortCompanionJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortCompanionJsonValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
