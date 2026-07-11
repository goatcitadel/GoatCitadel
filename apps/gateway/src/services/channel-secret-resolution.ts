import type { IntegrationConnection } from "@goatcitadel/contracts";

const CHANNEL_SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /^(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
  /^(?:WEBHOOK_SECRET|CHANNEL_SECRET)(?:_[A-Z0-9]+)?$/,
  /^(?:GOATCITADEL|GC)_(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
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

export function resolveTelegramWebhookSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv") ??
    readConfigSecret(config, "secretToken", "secretTokenEnv") ??
    readConfigSecret(config, "botSecret", "botSecretEnv")
  );
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

export function isTelegramApprovalActionConnectorReady(
  connections: { get(connectionId: string): IntegrationConnection },
  connectionId: string,
): boolean {
  try {
    return isTelegramApprovalActionConnectionReady(connections.get(connectionId));
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

export function readConfigSecret(config: Record<string, unknown>, key: string, envKey: string): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const envName = config[envKey];
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  return resolveAllowlistedEnvSecret(envName);
}
