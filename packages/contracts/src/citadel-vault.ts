export interface SealedValue {
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64 (GCM auth tag)
}

// --- Vault persistence (§13 MVP) ---
// A secret stored in a Citadel's Vault. The plaintext is never persisted: only the
// sealed envelope is, and the per-Citadel master key lives in the OS keychain
// (the Secret Vault is encrypted-at-rest with a single Citadel key for the MVP;
// per-Chamber keys, rotation, and E2EE are the deferred follow-on).

export interface CitadelVaultSecretRecord {
  secretId: string;
  citadelId: string;
  secretName: string;
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
}

export function toVaultSecretMetadata(record: CitadelVaultSecretRecord): CitadelVaultSecretMetadata {
  return {
    secretId: record.secretId,
    secretName: record.secretName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
