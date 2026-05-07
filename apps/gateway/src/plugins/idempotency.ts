import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { isLineWebhookPath } from "../services/line-webhook.js";
import { isNextcloudTalkWebhookPath } from "../services/nextcloud-talk-webhook.js";
import { isSlackWebhookPath } from "../services/slack-webhook.js";
import { isTelegramWebhookPath } from "../services/telegram-webhook.js";
import { isWhatsAppWebhookPath } from "../services/whatsapp-webhook.js";
import type { MutationIdempotencyStore } from "../services/mutation-idempotency-store.js";

interface MutationIdempotencyState {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope: string;
}

interface IdempotencyHeaderPluginOptions {
  mutationStore?: MutationIdempotencyStore;
}

const MUTATING_HTTP_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const GATEWAY_EVENTS_PATH = "/api/v1/gateway/events";
const INBOUND_CHANNEL_PATH_PREFIX = "/api/v1/channels/";

export const idempotencyHeaderPlugin = fp<IdempotencyHeaderPluginOptions>(async (fastify, options) => {
  fastify.decorateRequest("idempotencyKey", "");
  fastify.decorateRequest("mutationIdempotencyState", null);

  fastify.addHook("preHandler", async (request, reply) => {
    if (!MUTATING_HTTP_METHODS.has(request.method)) {
      return;
    }
    if (isWebhookOrInboundPath(request.url)) {
      return;
    }

    const key = request.headers["idempotency-key"];
    if (!key || Array.isArray(key) || !key.trim()) {
      await reply.code(400).send({
        error: "Idempotency-Key header is required for mutating requests",
      });
      return;
    }

    (request as typeof request & { idempotencyKey: string }).idempotencyKey = key;
    if (!options.mutationStore || !shouldEnforceMutationIdempotency(request)) {
      return;
    }

    const routePath = getNormalizedRoutePath(request);
    const actorScope = request.authActorId?.trim() || "";
    const claim = options.mutationStore.claim({
      method: request.method,
      routePath,
      idempotencyKey: key,
      actorScope,
      payloadHash: hashCanonicalPayload((request as { body?: unknown }).body ?? null),
    });
    if (claim.outcome === "claimed") {
      (request as typeof request & { mutationIdempotencyState: MutationIdempotencyState }).mutationIdempotencyState = {
        method: request.method,
        routePath,
        idempotencyKey: key,
        actorScope,
      };
      return;
    }

    const error =
      claim.outcome === "payload_mismatch"
        ? "Idempotency-Key was reused with a different payload"
        : claim.outcome === "in_progress"
          ? "Request already in progress for this Idempotency-Key"
          : "Duplicate mutation blocked for this Idempotency-Key";
    await reply.code(409).send({ error });
  });

  fastify.addHook("onResponse", async (request, reply) => {
    const state = (
      request as typeof request & {
        mutationIdempotencyState?: MutationIdempotencyState | null;
      }
    ).mutationIdempotencyState;
    if (!state || !options.mutationStore) {
      return;
    }
    if (reply.statusCode >= 500) {
      await options.mutationStore.markFailed(state);
      return;
    }
    await options.mutationStore.markCompleted(state);
  });
});

function shouldEnforceMutationIdempotency(request: FastifyRequest): boolean {
  const path = getNormalizedRoutePath(request);
  return path.startsWith("/api/v1/") && path !== GATEWAY_EVENTS_PATH && !path.startsWith(INBOUND_CHANNEL_PATH_PREFIX);
}

function isWebhookOrInboundPath(url: string): boolean {
  const path = url.split("?", 1)[0] || url;
  return (
    path.startsWith(INBOUND_CHANNEL_PATH_PREFIX) ||
    isLineWebhookPath(url) ||
    isNextcloudTalkWebhookPath(url) ||
    isSlackWebhookPath(url) ||
    isTelegramWebhookPath(url) ||
    isWhatsAppWebhookPath(url)
  );
}

function getNormalizedRoutePath(request: FastifyRequest): string {
  const routePath = request.routeOptions.url?.trim();
  if (routePath) {
    return routePath;
  }
  return request.url.split("?", 1)[0] || request.url;
}

function hashCanonicalPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}
