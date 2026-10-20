import type { CitadelRecord } from "./citadels.js";

export interface SealedValue {
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64 (GCM auth tag)
}

/** An envelope bound by associated data to its Citadel, scope, secret and data key. */
export interface SealedValueV2 extends SealedValue {
  v: 2;
  keyId: string;
}

// --- Vault persistence ---
// A secret stored in a Citadel's Vault. The plaintext is never persisted: only the
// sealed envelope is. The Citadel key-encryption key lives in the OS keychain and
// wraps one data key per scope (the Citadel scope, or a Chamber); data keys are
// stored wrapped. Legacy v1 envelopes were sealed directly under the Citadel key
// and are upgraded by the Gateway. E2EE is out of scope.

export const VAULT_ERROR_CODES = {
  keychainUnavailable: "VAULT_KEYCHAIN_UNAVAILABLE",
  keyMissing: "VAULT_KEY_MISSING",
  rotationInProgress: "VAULT_ROTATION_IN_PROGRESS",
  keyChanged: "VAULT_KEY_CHANGED",
  legacySecretsPresent: "VAULT_LEGACY_SECRETS_PRESENT",
  noKeyToRotate: "VAULT_NO_KEY_TO_ROTATE",
} as const;

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[keyof typeof VAULT_ERROR_CODES];

export type CitadelVaultScope = { type: "citadel" } | { type: "chamber"; chamberId: string };

export interface CitadelVaultSecretRecord {
  secretId: string;
  citadelId: string;
  secretName: string;
  /** null = Citadel scope. */
  chamberId: string | null;
  /** The data key that sealed this envelope; null for a legacy v1 envelope. */
  keyId: string | null;
  envelopeVersion: 1 | 2;
  sealedValue: SealedValue;
  createdAt: string;
  updatedAt: string;
}

export interface CitadelVaultSecretInput {
  citadelId: string;
  secretName: string;
  sealedValue: SealedValue;
}

/** The safe-to-return view of a Vault secret: name + provenance, never the value. */
export interface CitadelVaultSecretMetadata {
  secretId: string;
  secretName: string;
  createdAt: string;
  updatedAt: string;
  chamberId: string | null;
  /** null = legacy envelope awaiting upgrade. */
  keyVersion: number | null;
}

export interface CitadelVaultScopeKeyMetadata {
  chamberId: string | null;
  chamberName?: string;
  /** null = no data key yet (nothing sealed in this scope). */
  activeKeyVersion: number | null;
  keyCreatedAt?: string;
  secretCount: number;
}

export type CitadelVaultRotationPhase =
  | "awaiting_approval"
  | "approved"
  | "resealing"
  | "kek_staged"
  | "rewrapped"
  | "completed"
  | "cancelled"
  | "failed";

export const CITADEL_VAULT_TERMINAL_ROTATION_PHASES: readonly CitadelVaultRotationPhase[] = [
  "completed",
  "cancelled",
  "failed",
];

export interface CitadelVaultRotationView {
  rotationId: string;
  target: "dek" | "kek";
  chamberId: string | null;
  phase: CitadelVaultRotationPhase;
  approvalId?: string;
  resealedCount: number;
  totalCount: number;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CitadelVaultKeyMetadata {
  custody: "os_keychain" | "dev_verification";
  keychainAvailable: boolean;
  /** missing = sealed data exists but the keychain has no entry for the active key. */
  kekState: "ready" | "missing" | "unavailable";
  kekVersion: number | null;
  kekRotatedAt?: string;
  scopes: CitadelVaultScopeKeyMetadata[];
  legacySecretCount: number;
  legacyUnreadableCount: number;
  /** The one non-terminal rotation, if any. */
  rotation?: CitadelVaultRotationView;
}

/**
 * Storage-side key facts. Custody, keychain availability and KEK state are added
 * by the Gateway, which is the only owner that can see the keychain.
 */
export type CitadelVaultStoredKeyMetadata = Pick<
  CitadelVaultKeyMetadata,
  "kekVersion" | "kekRotatedAt" | "scopes" | "legacySecretCount" | "rotation"
>;

/** Reviews metadata and lifecycle only. No secret value or value-derived digest is returned. */
export interface CitadelVaultSnapshot {
  citadelId: string;
  revision: string;
  record?: CitadelRecord;
  items: CitadelVaultSecretMetadata[];
  keys: CitadelVaultStoredKeyMetadata &
    Partial<Pick<CitadelVaultKeyMetadata, "custody" | "keychainAvailable" | "kekState" | "legacyUnreadableCount">>;
}

export type CitadelVaultChange =
  /** Legacy v1 store, sealed directly under the Citadel key. Removed once the Gateway seals bound envelopes. */
  | { type: "store"; secretName: string; sealedValue: SealedValue }
  | {
      type: "store_bound";
      secretId: string;
      secretName: string;
      chamberId: string | null;
      sealedValue: SealedValueV2;
    }
  | { type: "move"; secretId: string; chamberId: string | null; sealedValue: SealedValueV2 }
  | { type: "delete"; secretId: string };

/** Sealing happens in the dedicated credential owner before this storage command. */
export interface CitadelVaultMutation {
  citadelId: string;
  expectedRevision: string;
  change: CitadelVaultChange;
}

export function toVaultSecretMetadata(
  record: CitadelVaultSecretRecord,
  keyVersion: number | null = null,
): CitadelVaultSecretMetadata {
  return {
    secretId: record.secretId,
    secretName: record.secretName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    chamberId: record.chamberId,
    keyVersion,
  };
}
