import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebhookRawBodyRequest } from "./webhook-handler-factory.js";
import { CHANNEL_INBOUND_MAX_BYTES, createWebhookPreParsing } from "./webhook-handler-factory.js";
import { readConfigSecret } from "../services/channel-secret-resolution.js";
import { buildWebhookIngressRateLimitKey, resolveWebhookRateLimitConfig } from "../services/webhook-rate-limit.js";
export {
  isAllowedSecretEnvName,
  isAllowedTelegramBotTokenEnvName,
  readConfigSecret,
  resolveAllowlistedEnvSecret,
  resolveTelegramBotTokenEnvSecret,
  resolveTelegramWebhookSecret,
} from "../services/channel-secret-resolution.js";

/**
 * Resolves the channelVoiceInboundV1Enabled gate for a webhook parse. A failed
 * flag read is treated as voice disabled so text payloads still normalize and
 * dispatch; only the error type is logged (never its message or the payload).
 */
export async function readWebhookVoiceInboundEnabled(
  fastify: FastifyInstance,
  request: FastifyRequest,
  source: string,
): Promise<boolean> {
  try {
    return (await fastify.services.integrationWebhooks.isVoiceInboundEnabled?.()) === true;
  } catch (error) {
    request.log.warn(
      { source, errorType: error instanceof Error ? error.name : typeof error },
      "Voice inbound flag read failed; treating voice as disabled",
    );
    return false;
  }
}

export function createWebhookRouteOptions(rawBodyKey?: keyof WebhookRawBodyRequest) {
  const { maxIngress } = resolveWebhookRateLimitConfig();
  return {
    bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
    ...(rawBodyKey ? { preParsing: createWebhookPreParsing(rawBodyKey) } : {}),
    config: {
      rateLimit: {
        max: maxIngress,
        keyGenerator: buildWebhookIngressRateLimitKey,
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
