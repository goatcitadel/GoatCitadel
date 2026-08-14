import { randomUUID } from "node:crypto";
import { ValidationError } from "@goatcitadel/contracts";
import type { SecretStoreService } from "./secret-store-service.js";

const SECRET_REF_PREFIX = "keychain:goatcitadel:";
const TEMPORARY_PREFIX = "channel-draft:";
const CONNECTION_PREFIX = "channel-connection:";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/u;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

type ChannelSecretStore = Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret">;

/** OS-keychain custody for channel setup. Raw values never enter draft or connection JSON. */
export class ChannelSecretCustodyService {
  public constructor(private readonly store: ChannelSecretStore) {}

  public storeTemporary(draftId: string, fieldKey: string, secret: string): string {
    const normalized = requireSecret(secret);
    const account = `${TEMPORARY_PREFIX}${requireIdentifier(draftId, "draftId")}:${requireFieldKey(fieldKey)}:${randomUUID()}`;
    this.store.setSecret(account, normalized);
    return `${SECRET_REF_PREFIX}${account}`;
  }

  public resolve(secretRef: string): string {
    const account = parseChannelSecretRef(secretRef).account;
    const value = this.store.getSecret(account)?.trim();
    if (!value) throw new ValidationError({ message: "The channel credential is unavailable from secure storage." });
    return value;
  }

  public copyToConnection(secretRef: string, connectionId: string, fieldKey: string): string {
    const parsed = parseChannelSecretRef(secretRef);
    const expectedField = requireFieldKey(fieldKey);
    if (parsed.fieldKey !== expectedField) {
      throw new ValidationError({ message: "The channel credential reference is not bound to the requested field." });
    }
    const account = `${CONNECTION_PREFIX}${requireIdentifier(connectionId, "connectionId")}:${expectedField}`;
    this.store.setSecret(account, this.resolve(secretRef));
    return `${SECRET_REF_PREFIX}${account}`;
  }

  public deleteTemporary(secretRef: string): void {
    const parsed = parseChannelSecretRef(secretRef);
    if (parsed.custody !== "temporary") return;
    this.store.deleteSecret(parsed.account);
  }

  public delete(secretRef: string): void {
    this.store.deleteSecret(parseChannelSecretRef(secretRef).account);
  }

  public isChannelSecretRef(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
      parseChannelSecretRef(value);
      return true;
    } catch {
      return false;
    }
  }

  public custodyFor(secretRef: string): "temporary" | "connection" {
    return parseChannelSecretRef(secretRef).custody;
  }

  /**
   * Revalidates both keychain presence and owner binding before a draft may use
   * an opaque credential reference. This prevents one draft from replaying a
   * reference copied from another draft or connection.
   */
  public assertUsableForDraft(
    secretRef: string,
    input: { draftId: string; connectionId?: string; fieldKey: string },
  ): void {
    const parsed = parseChannelSecretRef(secretRef);
    const fieldKey = requireFieldKey(input.fieldKey);
    if (parsed.fieldKey !== fieldKey) {
      throw new ValidationError({ message: "The channel credential reference is bound to a different field." });
    }
    if (parsed.custody === "temporary" && parsed.ownerId !== requireIdentifier(input.draftId, "draftId")) {
      throw new ValidationError({ message: "The temporary channel credential belongs to a different draft." });
    }
    if (
      parsed.custody === "connection" &&
      (!input.connectionId || parsed.ownerId !== requireIdentifier(input.connectionId, "connectionId"))
    ) {
      throw new ValidationError({ message: "The channel credential belongs to a different connection." });
    }
    void this.resolve(secretRef);
  }
}

export function parseChannelSecretRef(secretRef: string): {
  account: string;
  custody: "temporary" | "connection";
  ownerId: string;
  fieldKey: string;
} {
  const normalized = secretRef.trim();
  if (!normalized.startsWith(SECRET_REF_PREFIX)) {
    throw new ValidationError({ message: "The channel credential reference is invalid." });
  }
  const account = normalized.slice(SECRET_REF_PREFIX.length);
  const parts = account.split(":");
  const temporary = parts[0] === "channel-draft";
  const connection = parts[0] === "channel-connection";
  if ((!temporary && !connection) || (temporary ? parts.length !== 4 : parts.length !== 3)) {
    throw new ValidationError({ message: "The channel credential reference is invalid." });
  }
  const ownerId = requireIdentifier(parts[1] ?? "", temporary ? "draftId" : "connectionId");
  const fieldKey = requireFieldKey(parts[2] ?? "");
  if (temporary) requireIdentifier(parts[3] ?? "", "credential nonce");
  return { account, custody: temporary ? "temporary" : "connection", ownerId, fieldKey };
}

function requireSecret(secret: string): string {
  const value = secret.trim();
  if (!value || value.length > 16_384) {
    throw new ValidationError({ message: "Channel credential is empty or exceeds the secure-input limit." });
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new ValidationError({ message: `Channel ${label} is invalid.` });
  return normalized;
}

function requireFieldKey(value: string): string {
  const normalized = value.trim();
  if (!FIELD_KEY.test(normalized)) throw new ValidationError({ message: "Channel credential field is invalid." });
  return normalized;
}
