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

const ALLOWED_SECRET_ENV_PREFIXES = [
  "GOATCITADEL_",
  "GC_",
  "SLACK_",
  "DISCORD_",
  "TELEGRAM_",
  "WHATSAPP_",
  "LINE_",
  "NEXTCLOUD_",
  "WEBHOOK_SECRET",
  "CHANNEL_SECRET",
];

export function isAllowedSecretEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim().toUpperCase();
  return ALLOWED_SECRET_ENV_PREFIXES.some((prefix) => trimmedEnvName.startsWith(prefix));
}

/**
 * Resolve an environment-variable secret by name, but only when the name matches the
 * channel-secret allowlist. Use this whenever the env-var NAME can be influenced by a
 * request (never resolve a request-supplied env name without this guard, or arbitrary
 * process env — DATABASE_URL, AWS_SECRET_ACCESS_KEY, GOATCITADEL_*_SECRET, … — can be
 * exfiltrated to a third-party host).
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
