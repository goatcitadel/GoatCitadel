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

export interface MobilePushRegistrationRequest {
  provider: "expo" | "fcm" | "local_only";
  enabled: boolean;
  tokenHash?: string;
  tokenPreview?: string;
  deviceLabel?: string;
  appVersion?: string;
}

export interface MobilePushRegistrationResponse {
  registrationId: string;
  registeredAt: string;
  enabled: boolean;
}

export interface MobileRevocationRequest {
  reason: "panic_off" | "device_revoked" | "user_disabled" | "session_expired";
  capabilityIds?: MobileNativeCapabilityId[];
  revokedAt?: string;
}

export interface MobileAuditListResponse {
  items: Record<string, unknown>[];
}
