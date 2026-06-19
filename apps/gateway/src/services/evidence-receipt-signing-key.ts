import { GoatError } from "@goatcitadel/contracts";
import {
  generateEvidenceReceiptKeyPair,
  keyPairFromPrivatePkcs8Pem,
  type EvidenceReceiptKeyPair,
  type EvidenceReceiptSigningKeyProvider,
} from "./evidence-receipt-service.js";

/**
 * Signing-key decision (where the key lives):
 *
 * Evidence Receipts are signed with a per-HOST Ed25519 key. There is no pre-existing asymmetric
 * signing identity to reuse — the connector enrollment flow only *verifies* signatures produced by
 * external connectors (their keys live with the connector), and the Citadel Vault uses a symmetric
 * AES-256-GCM master key (encryption, not signatures). So we mint a dedicated Ed25519 keypair and
 * persist the PRIVATE key through the same store the Vault master key uses: the OS keychain via
 * `SecretStoreService` (Windows PasswordVault / macOS Keychain / libsecret), under the account
 * `evidence-receipt:signing-key:v1`. The PUBLIC key is never persisted — it is derived from the
 * private key and travels inside every receipt so verification is fully offline.
 *
 * The key is generated lazily on first receipt and cached in-process. If the keychain is
 * unavailable (headless/CI hosts), receipt *building* fails loudly with a 503-style error — but
 * receipt *verification* never needs this provider, so verifying a provided receipt always works.
 *
 * follow-up: per-workspace / per-Citadel signing keys + rotation (mirrors the Vault per-Chamber
 *   key follow-on). Today one host key signs all receipts.
 */
const SIGNING_KEY_ACCOUNT = "evidence-receipt:signing-key:v1";

export class EvidenceReceiptSigningKeyUnavailableError extends GoatError {
  // Reuses the existing SECRET_STORE_UNAVAILABLE contract code: the signing key is unavailable
  // precisely because the OS keychain (secret store) is. Avoids widening the shared error union
  // for a gateway-internal concern.
  readonly code = "SECRET_STORE_UNAVAILABLE" as const;
  readonly httpStatus = 503;
  public constructor(message: string) {
    super(message);
  }
}

/** Minimal view of the OS keychain store this provider needs (satisfied by SecretStoreService). */
export interface EvidenceReceiptSecretStore {
  isAvailable(): boolean;
  getSecret(account: string): string | undefined;
  setSecret(account: string, secret: string): void;
}

export interface KeychainSigningKeyProviderOptions {
  secretStore?: EvidenceReceiptSecretStore;
  account?: string;
}

/**
 * Persists/loads the Evidence Receipt signing key through the OS keychain. Generates and stores a
 * keypair on first use, then caches it for the lifetime of the process.
 */
export class KeychainEvidenceReceiptSigningKeyProvider implements EvidenceReceiptSigningKeyProvider {
  private readonly secretStore?: EvidenceReceiptSecretStore;
  private readonly account: string;
  private cached?: EvidenceReceiptKeyPair;

  public constructor(options: KeychainSigningKeyProviderOptions = {}) {
    this.secretStore = options.secretStore;
    this.account = options.account ?? SIGNING_KEY_ACCOUNT;
  }

  public getSigningKeyPair(): EvidenceReceiptKeyPair {
    if (this.cached) {
      return this.cached;
    }
    if (!this.secretStore || !this.secretStore.isAvailable()) {
      throw new EvidenceReceiptSigningKeyUnavailableError(
        "OS keychain is unavailable, so the Evidence Receipt signing key cannot be loaded or created on this host. " +
          "Receipt verification still works offline; only building new receipts requires the keychain.",
      );
    }

    const existing = this.readExistingKey();
    if (existing) {
      this.cached = existing;
      return existing;
    }

    const { keyPair, privateKeyPkcs8Pem } = generateEvidenceReceiptKeyPair();
    this.secretStore.setSecret(this.account, privateKeyPkcs8Pem);
    this.cached = keyPair;
    return keyPair;
  }

  private readExistingKey(): EvidenceReceiptKeyPair | undefined {
    const stored = this.secretStore?.getSecret(this.account);
    if (!stored || !stored.trim()) {
      return undefined;
    }
    try {
      return keyPairFromPrivatePkcs8Pem(stored);
    } catch (error) {
      throw new EvidenceReceiptSigningKeyUnavailableError(
        `The stored Evidence Receipt signing key is corrupt and could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * In-memory signing-key provider for tests / hosts without a keychain. Generates one keypair and
 * keeps it in process only. NOT for production receipt issuance (the key is lost on restart, so
 * older receipts would verify against a public key the host no longer holds — though each receipt
 * remains independently verifiable via its embedded public key).
 */
export class InMemoryEvidenceReceiptSigningKeyProvider implements EvidenceReceiptSigningKeyProvider {
  private cached?: EvidenceReceiptKeyPair;

  public getSigningKeyPair(): EvidenceReceiptKeyPair {
    if (!this.cached) {
      this.cached = generateEvidenceReceiptKeyPair().keyPair;
    }
    return this.cached;
  }
}
