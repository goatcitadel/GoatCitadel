import { randomUUID } from "node:crypto";
import { ValidationError } from "@goatcitadel/contracts";
import type { SecretStoreService } from "./secret-store-service.js";

const SECRET_REF_PREFIX = "keychain:goatcitadel:hook:";

/**
 * Keeps webhook signing keys out of workspace hook JSON and durable payloads.
 * The reference is opaque to clients and bound only to this hook-custody
 * namespace; it is not a general keychain resolver.
 */
export class HookSecretCustodyService {
  public constructor(private readonly store: Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret">) {}

  public storeSecret(value: string): string {
    const secret = value.trim();
    if (!secret) throw new ValidationError({ message: "Hook signing secret is required." });
    const account = `hook-signing:${randomUUID()}`;
    this.store.setSecret(account, secret);
    return `${SECRET_REF_PREFIX}${account.slice("hook-signing:".length)}`;
  }

  public resolveSecret(secretRef: string): string {
    const account = accountFromSecretRef(secretRef);
    const value = this.store.getSecret(account)?.trim();
    if (!value) throw new ValidationError({ message: "Hook signing secret is unavailable from secure storage." });
    return value;
  }

  public deleteSecret(secretRef: string): void {
    this.store.deleteSecret(accountFromSecretRef(secretRef));
  }
}

function accountFromSecretRef(secretRef: string): string {
  const normalized = secretRef.trim();
  if (!normalized.startsWith(SECRET_REF_PREFIX)) {
    throw new ValidationError({ message: "Hook signing secret reference is invalid." });
  }
  const suffix = normalized.slice(SECRET_REF_PREFIX.length);
  if (!/^[0-9a-f-]{16,}$/i.test(suffix)) {
    throw new ValidationError({ message: "Hook signing secret reference is invalid." });
  }
  return `hook-signing:${suffix}`;
}
