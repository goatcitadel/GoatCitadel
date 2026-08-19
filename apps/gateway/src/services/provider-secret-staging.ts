/**
 * Custody router for the credential a provider Change Plan holds between
 * secure input and owner promotion.
 *
 * Staging normally lives in the OS keychain so the raw value never enters the
 * durable plan record. Hosts without a keychain (headless Linux installs) have
 * no such vault, which would otherwise make an env-backed credential
 * impossible to save — even though its final owner is a plaintext `.env` file
 * that needs no keychain at all. For those plans only, staging falls back to a
 * process-local hold that is cleared on settle, abort, or failure: custody is
 * never weaker than the owner the operator explicitly chose. A keychain-backed
 * plan still fails closed, because that owner genuinely requires a vault.
 */

/** The subset of the OS keychain surface this router depends on. */
export interface ProviderSecretStagingStore {
  isAvailable(): boolean;
  setSecret(account: string, secret: string): void;
  getSecret(account: string): string | undefined;
  deleteSecret(account: string): void;
}

export type ProviderSecretStagingTarget = "keychain" | "env";

export class ProviderSecretStaging {
  private readonly held = new Map<string, string>();

  public constructor(private readonly store: ProviderSecretStagingStore) {}

  public stage(account: string, secret: string, target: ProviderSecretStagingTarget): void {
    if (this.store.isAvailable() || target !== "env") {
      this.store.setSecret(account, secret);
      return;
    }
    this.held.set(account, secret);
  }

  public read(account: string): string | undefined {
    if (this.held.has(account)) {
      return this.held.get(account);
    }
    // Without a keychain the process hold is the only place staging can live,
    // so an absent entry is a plain miss rather than a reason to fail.
    if (!this.store.isAvailable()) {
      return undefined;
    }
    return this.store.getSecret(account);
  }

  public clear(account: string): void {
    if (this.held.delete(account) || !this.store.isAvailable()) {
      return;
    }
    this.store.deleteSecret(account);
  }
}
