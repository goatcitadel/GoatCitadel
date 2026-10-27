import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebhookRawBodyRequest } from "./webhook-handler-factory.js";
import { CHANNEL_INBOUND_MAX_BYTES, createWebhookPreParsing } from "./webhook-handler-factory.js";
import {
  createConnectionSecretReferenceResolver,
  readConfigSecret,
  type ChannelSecretReferenceResolver,
} from "../services/channel-secret-resolution.js";
import type { IntegrationWebhookRouteLike } from "../services/channel-inbound-dispatch.js";
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

/**
 * Reads the keys a webhook's connection saved at setup. Pass the connection id the request is for: only that
 * connection's own references resolve, and anything else counts as a missing secret. The gateway port checks the
 * same thing again, so a route that skips this helper still cannot read another connection's key.
 */
export function createWebhookSecretResolver(
  fastify: { services: { integrationWebhooks: Pick<IntegrationWebhookRouteLike, "resolveChannelConnectionSecret"> } },
  connectionId: string,
): ChannelSecretReferenceResolver {
  const { integrationWebhooks } = fastify.services;
  return createConnectionSecretReferenceResolver(connectionId, (secretRef) =>
    integrationWebhooks.resolveChannelConnectionSecret?.(connectionId, secretRef),
  );
}

export function resolveNextcloudTalkSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "token", "tokenEnv", resolveReference) ??
    readConfigSecret(config, "botSecret", "botSecretEnv", resolveReference) ??
    readConfigSecret(config, "secret", "secretEnv", resolveReference)
  );
}

export function resolveQqbotSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return readConfigSecret(config, "appSecret", "appSecretEnv", resolveReference);
}

export interface WecomCallbackSecrets {
  corpId?: string;
  token?: string;
  encodingAesKey?: string;
}

/** Callback credentials for the WeCom URL verification and message callbacks. */
export function resolveWecomCallbackSecrets(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): WecomCallbackSecrets {
  const corpId = typeof config.corpId === "string" ? config.corpId.trim() : "";
  return {
    ...(corpId ? { corpId } : {}),
    token: readConfigSecret(config, "callbackToken", "callbackTokenEnv", resolveReference),
    encodingAesKey: readConfigSecret(config, "encodingAesKey", "encodingAesKeyEnv", resolveReference),
  };
}

export function resolveWhatsAppAppSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "appSecret", "appSecretEnv", resolveReference) ??
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv", resolveReference)
  );
}

export function resolveWhatsAppVerifyToken(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "webhookVerifyToken", "webhookVerifyTokenEnv", resolveReference) ??
    readConfigSecret(config, "verifyToken", "verifyTokenEnv", resolveReference)
  );
}

export function resolveLineChannelSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "channelSecret", "channelSecretEnv", resolveReference) ??
    readConfigSecret(config, "secret", "secretEnv", resolveReference)
  );
}

export function resolveGenericChannelInboundSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "inboundSecret", "inboundSecretEnv", resolveReference) ??
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv", resolveReference) ??
    readConfigSecret(config, "signingSecret", "signingSecretEnv", resolveReference) ??
    readConfigSecret(config, "channelSecret", "channelSecretEnv", resolveReference) ??
    readConfigSecret(config, "secret", "secretEnv", resolveReference)
  );
}
