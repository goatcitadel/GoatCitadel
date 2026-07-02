import type { WebhookRawBodyRequest } from "./webhook-handler-factory.js";
import { CHANNEL_INBOUND_MAX_BYTES, createWebhookPreParsing } from "./webhook-handler-factory.js";

export function createWebhookRouteOptions(rawBodyKey?: keyof WebhookRawBodyRequest) {
  return {
    bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
    ...(rawBodyKey ? { preParsing: createWebhookPreParsing(rawBodyKey) } : {}),
    config: {
      rateLimit: {
        max: 500,
      },
    },
  };
}

export function createWebhookReadRouteOptions() {
  return {
    config: {
      rateLimit: {
        max: 500,
      },
    },
  };
}

export function resolveNextcloudTalkSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "token", "tokenEnv") ??
    readConfigSecret(config, "botSecret", "botSecretEnv") ??
    readConfigSecret(config, "secret", "secretEnv")
  );
}

export function resolveTelegramWebhookSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv") ??
    readConfigSecret(config, "secretToken", "secretTokenEnv") ??
    readConfigSecret(config, "botSecret", "botSecretEnv")
  );
}

export function resolveWhatsAppAppSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "appSecret", "appSecretEnv") ??
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv")
  );
}

export function resolveWhatsAppVerifyToken(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "webhookVerifyToken", "webhookVerifyTokenEnv") ??
    readConfigSecret(config, "verifyToken", "verifyTokenEnv")
  );
}

export function resolveLineChannelSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "channelSecret", "channelSecretEnv") ?? readConfigSecret(config, "secret", "secretEnv")
  );
}

export function resolveGenericChannelInboundSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "inboundSecret", "inboundSecretEnv") ??
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv") ??
    readConfigSecret(config, "signingSecret", "signingSecretEnv") ??
    readConfigSecret(config, "channelSecret", "channelSecretEnv") ??
    readConfigSecret(config, "secret", "secretEnv")
  );
}

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

export function isAllowedSecretEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim().toUpperCase();
  return CHANNEL_SECRET_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName));
}

export function isAllowedTelegramBotTokenEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim().toUpperCase();
  return TELEGRAM_BOT_TOKEN_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName));
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
