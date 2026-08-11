import { z } from "zod";

export const MOBILE_NATIVE_CAPABILITY_IDS = [
  "location_context",
  "camera_capture",
  "image_library",
  "share_intake",
  "voice_capture",
  "approval_key",
  "push_refresh",
  "geofence_context",
  "notification_awareness",
  "screen_share",
  "otp_assist",
  "accessibility_helper",
  "call_screening",
] as const;

export type MobileNativeCapabilityId = (typeof MOBILE_NATIVE_CAPABILITY_IDS)[number];

export type MobileNativeCapabilityState = "unavailable" | "available" | "needs_consent" | "enabled" | "blocked";

export type MobileNativePermissionState =
  | "unknown"
  | "not_required"
  | "promptable"
  | "granted"
  | "denied"
  | "blocked"
  | "special_access_required";

export type MobileNativeSensitivity = "low" | "moderate" | "high";

export type MobileNativeCollectionMode = "user_initiated" | "foreground" | "background_opt_in" | "special_access";

export type MobileNativeImplementationStatus = "ready" | "scaffolded" | "deferred";

export interface MobileNativeCapabilityProvenance {
  platform: "android" | "ios" | "web" | "unknown";
  appVersion?: string;
  deviceId?: string;
  grantId?: string;
  companionSessionId?: string;
  source: "mobile_app" | "native_module" | "gateway";
  sessionId?: string;
}

export interface MobileNativeCapabilityRecord {
  capabilityId: MobileNativeCapabilityId;
  label: string;
  summary: string;
  state: MobileNativeCapabilityState;
  permissionState: MobileNativePermissionState;
  sensitivity: MobileNativeSensitivity;
  collectionMode: MobileNativeCollectionMode;
  implementationStatus: MobileNativeImplementationStatus;
  consentRequired: boolean;
  consentGranted: boolean;
  backgroundCapable: boolean;
  lastSeenAt?: string;
  lastUsedAt?: string;
  blockedReason?: string;
  provenance: MobileNativeCapabilityProvenance;
}

export interface MobileContextProvenance {
  platform?: "android" | "ios" | "web" | "unknown";
  appVersion?: string;
  deviceId?: string;
  grantId?: string;
  companionSessionId?: string;
  sessionId?: string;
  source?: "mobile_app" | "native_module" | "gateway";
}

export interface MobileContextEnvelope {
  contextId?: string;
  capabilityId: MobileNativeCapabilityId;
  capturedAt: string;
  expiresAt?: string;
  sensitivity: MobileNativeSensitivity;
  summary: string;
  structuredFields: Record<string, string>;
  attachmentIds?: string[];
  userVisibleReason: string;
  provenance?: MobileContextProvenance;
}

export interface MobileCapabilityHeartbeatRequest {
  observedAt: string;
  appVersion?: string;
  platform?: MobileNativeCapabilityProvenance["platform"];
  capabilities: MobileNativeCapabilityRecord[];
}

export interface MobileCapabilityListResponse {
  items: MobileNativeCapabilityRecord[];
}

export interface MobileContextAuditRequest {
  contexts: MobileContextEnvelope[];
}

export interface MobileContextAuditResponse {
  accepted: number;
  contextEventIds: string[];
}

export const MOBILE_PUSH_PROVIDERS = ["expo", "fcm"] as const;
export type MobilePushProvider = (typeof MOBILE_PUSH_PROVIDERS)[number];

const mobilePushRegistrationMetadataSchema = {
  provider: z.enum(MOBILE_PUSH_PROVIDERS),
  deviceLabel: z.string().trim().min(1).max(160).optional(),
  appVersion: z.string().trim().min(1).max(80).optional(),
};

/**
 * The provider token is accepted only at the signed companion boundary. Token
 * hashes/previews are deliberately not caller inputs: the Gateway computes the
 * authoritative digest and keeps the raw value in OS-keychain custody.
 */
export const mobilePushRegistrationRequestSchema = z.discriminatedUnion("enabled", [
  z
    .object({
      ...mobilePushRegistrationMetadataSchema,
      enabled: z.literal(true),
      token: z.string().trim().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...mobilePushRegistrationMetadataSchema,
      enabled: z.literal(false),
    })
    .strict(),
]);

export type MobilePushRegistrationRequest = z.infer<typeof mobilePushRegistrationRequestSchema>;

export interface MobilePushRegistrationResponse {
  registrationId: string;
  provider: MobilePushProvider;
  registeredAt: string;
  updatedAt: string;
  enabled: boolean;
  deliveryAvailability: "available" | "unavailable";
  revision: number;
}

export interface MobilePushApprovalRefreshPayload {
  schemaVersion: 1;
  type: "approval_refresh";
  realtimeEventId: string;
  approvalId: string;
  deepLink: {
    kind: "approval";
    approvalId: string;
  };
}

export const MOBILE_APPROVAL_KEY_PROVENANCES = ["secure_hardware", "software", "unknown"] as const;
export type MobileApprovalKeyProvenanceClaim = (typeof MOBILE_APPROVAL_KEY_PROVENANCES)[number];

/**
 * Registration boundary for the Gateway-verifiable consumer approval key: an
 * Ed25519 device public key bound to the durable companion grant. Only public
 * material crosses this boundary; the private key never leaves device
 * authentication custody. The Gateway recomputes the authoritative key digest
 * from the submitted SPKI, so digests/previews are deliberately not caller
 * inputs.
 */
export const mobileApprovalKeyRegistrationRequestSchema = z.discriminatedUnion("enabled", [
  z
    .object({
      enabled: z.literal(true),
      algorithm: z.literal("ed25519"),
      publicKeyPem: z.string().trim().min(1).max(512),
      keyProvenance: z.enum(MOBILE_APPROVAL_KEY_PROVENANCES),
      deviceLabel: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      enabled: z.literal(false),
    })
    .strict(),
]);

export type MobileApprovalKeyRegistrationRequest = z.infer<typeof mobileApprovalKeyRegistrationRequestSchema>;

export interface MobileApprovalKeyRegistrationResponse {
  keyId: string;
  algorithm: "ed25519";
  enabled: boolean;
  keyProvenance: MobileApprovalKeyProvenanceClaim;
  publicKeySha256: string;
  registeredAt: string;
  updatedAt: string;
  revision: number;
  /**
   * Whether the Gateway enforces approval-decision signatures end to end. Stays
   * "unavailable" while the `approval_key` capability is `scaffolded`; a
   * registered key alone is not live signature-gated approval.
   */
  verificationAvailability: "available" | "unavailable";
}

export interface MobileApprovalKeySummary {
  keyId: string;
  grantId: string;
  algorithm: "ed25519";
  lifecycleState: "active" | "revoked";
  keyProvenance: MobileApprovalKeyProvenanceClaim;
  publicKeySha256: string;
  revision: number;
  registeredAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface MobileApprovalKeyListResponse {
  items: MobileApprovalKeySummary[];
}

export const mobileApprovalKeyRevokeRequestSchema = z
  .object({
    grantId: z.string().trim().min(1).max(256),
  })
  .strict();

export type MobileApprovalKeyRevokeRequest = z.infer<typeof mobileApprovalKeyRevokeRequestSchema>;

export interface MobileRevocationRequest {
  reason: "panic_off" | "device_revoked" | "user_disabled" | "session_expired";
  capabilityIds?: MobileNativeCapabilityId[];
  revokedAt?: string;
}

export interface MobileAuditListResponse {
  items: Record<string, unknown>[];
}
