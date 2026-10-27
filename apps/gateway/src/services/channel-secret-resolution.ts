import type { IntegrationConnection } from "@goatcitadel/contracts";

const CHANNEL_SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /^(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD|QQBOT|WECOM)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|AES_KEY|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
  /^(?:WEBHOOK_SECRET|CHANNEL_SECRET)(?:_[A-Z0-9]+)?$/,
  /^(?:GOATCITADEL|GC)_(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD|QQBOT|WECOM)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|AES_KEY|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
];

const TELEGRAM_BOT_TOKEN_ENV_PATTERNS: readonly RegExp[] = [
  /^TELEGRAM_BOT_TOKEN$/,
  /^TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
  /^GOATCITADEL_TELEGRAM_BOT_TOKEN$/,
  /^GOATCITADEL_TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^GOATCITADEL_TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
  /^GC_TELEGRAM_BOT_TOKEN$/,
  /^GC_TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^GC_TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
];

/** Reads the key a reference points to in secure storage; undefined when the reference cannot be used. */
export type ChannelSecretReferenceResolver = (secretRef: string) => string | undefined;

/** Where every secure-storage reference starts. A value that starts this way is a pointer, never a secret. */
const SECRET_REFERENCE_PREFIX = "keychain:goatcitadel:";
/** Where the references saved for a channel connection start; the connection id and a colon follow. */
const CONNECTION_SECRET_REFERENCE_PREFIX = `${SECRET_REFERENCE_PREFIX}channel-connection:`;

export function resolveTelegramWebhookSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv", resolveReference) ??
    readConfigSecret(config, "secretToken", "secretTokenEnv", resolveReference) ??
    readConfigSecret(config, "botSecret", "botSecretEnv", resolveReference)
  );
}

/**
 * Limits a reference reader to the keys one connection saved for itself. A reference to another connection,
 * one the reader cannot resolve, a failing read and a missing reader all give no key: the reference text is never
 * a credential, and a read failure is dropped so its message cannot reach a response or a log.
 */
export function createConnectionSecretReferenceResolver(
  connectionId: string,
  readReference: ChannelSecretReferenceResolver | undefined,
): ChannelSecretReferenceResolver {
  const ownPrefix = `${CONNECTION_SECRET_REFERENCE_PREFIX}${connectionId}:`;
  return (secretRef) => {
    const reference = secretRef.trim();
    if (!readReference || !reference.startsWith(ownPrefix)) {
      return undefined;
    }
    try {
      return readReference(reference)?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
}

export function isTelegramApprovalActionConnectionReady(connection: IntegrationConnection): boolean {
  return (
    connection.kind === "channel" &&
    connection.key === "telegram" &&
    connection.enabled &&
    connection.status === "connected" &&
    Boolean(resolveTelegramWebhookSecret(connection.config))
  );
}

export async function isTelegramApprovalActionConnectorReady(
  connections: { get(connectionId: string): Promise<IntegrationConnection> },
  connectionId: string,
): Promise<boolean> {
  try {
    return isTelegramApprovalActionConnectionReady(await connections.get(connectionId));
  } catch {
    return false;
  }
}

export function isAllowedSecretEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim();
  return (
    trimmedEnvName === trimmedEnvName.toUpperCase() &&
    CHANNEL_SECRET_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName))
  );
}

export function isAllowedTelegramBotTokenEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim();
  return (
    trimmedEnvName === trimmedEnvName.toUpperCase() &&
    TELEGRAM_BOT_TOKEN_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName))
  );
}

/**
 * Resolve an environment-variable secret by name, but only when the name matches the
 * channel-secret allowlist. Use this whenever the env-var NAME can be influenced by a
 * request. Keep generic GOATCITADEL_* / GC_* names out of this path; field-specific
 * secrets must opt in to a narrower resolver such as resolveTelegramBotTokenEnvSecret.
 */
export function resolveAllowlistedEnvSecret(envName: string | undefined): string | undefined {
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  if (!isAllowedSecretEnvName(envName)) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}

export function resolveTelegramBotTokenEnvSecret(envName: string | undefined): string | undefined {
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  if (!isAllowedTelegramBotTokenEnvName(envName)) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}

/**
 * Reads a channel secret from its direct config field, else from an allowlisted env var. With a resolver, a direct
 * value that is a secure-storage reference is replaced by the key it points to, and is missing when the resolver
 * gives none; the reference is never returned as the secret. Without one, direct values come back as saved.
 */
export function readConfigSecret(
  config: Record<string, unknown>,
  key: string,
  envKey: string,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    const value = direct.trim();
    return resolveReference && value.startsWith(SECRET_REFERENCE_PREFIX) ? resolveReference(value) : value;
  }
  const envName = config[envKey];
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  return resolveAllowlistedEnvSecret(envName);
}
