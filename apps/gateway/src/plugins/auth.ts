import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SseTokenIssueResponse } from "@goatcitadel/contracts";
import { enterRequestAttribution } from "../../../../packages/storage/src/request-attribution.js";
import { isNextcloudTalkWebhookPath } from "../services/nextcloud-talk-webhook.js";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    issueSseToken: (scope: "events:stream", ttlMs?: number) => SseTokenIssueResponse;
  }

  interface FastifyRequest {
    authActorId: string;
    authActorSource: "none" | "token" | "basic" | "loopback" | "sse" | "device";
    authDeviceId?: string;
    authGrantId?: string;
  }
}

interface SseTokenRecord {
  token: string;
  scope: "events:stream";
  expiresAt: number;
}

const MAX_AUTH_TOKEN_LENGTH = 4096;
const MAX_BASIC_CREDENTIAL_LENGTH = 8192;
const MAX_ACTIVE_SSE_TOKENS = 10_000;

export const authPlugin = fp(async (fastify) => {
  const sseTokens = new Map<string, SseTokenRecord>();
  fastify.decorateRequest("authActorId", "anonymous");
  fastify.decorateRequest("authActorSource", "none");
  fastify.decorateRequest("authDeviceId", undefined);
  fastify.decorateRequest("authGrantId", undefined);

  fastify.decorate("issueSseToken", (scope: "events:stream", ttlMs = 2 * 60 * 1000) => {
    purgeExpiredSseTokens(sseTokens);
    enforceSseTokenCapacity(sseTokens, MAX_ACTIVE_SSE_TOKENS);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + Math.max(30_000, Math.min(10 * 60 * 1000, ttlMs));
    sseTokens.set(token, {
      token,
      scope,
      expiresAt,
    });
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      scope,
    };
  });

  fastify.addHook("onRequest", async (request, reply) => {
    setAuthActor(request, "anonymous", "none");
    request.authDeviceId = undefined;
    request.authGrantId = undefined;
    if (request.method === "OPTIONS") {
      return;
    }
    if (request.url.startsWith("/health")) {
      return;
    }
    if (request.url.startsWith("/api/v1/auth/device-requests")) {
      return;
    }
    if (isNextcloudTalkWebhookPath(request.url)) {
      setAuthActor(request, "nextcloud-talk:webhook", "none");
      return;
    }

    const auth = fastify.gatewayConfig.assistant.auth;
    if (auth.mode === "none") {
      setAuthActor(request, "auth:none", "none");
      return;
    }

    const remoteAddress = request.raw.socket.remoteAddress ?? request.ip;
    const forwardedFor = request.headers["x-forwarded-for"];
    if (
      auth.allowLoopbackBypass
      && !forwardedFor
      && isLoopbackAddress(remoteAddress)
    ) {
      setAuthActor(request, `loopback:${normalizeActorSuffix(remoteAddress)}`, "loopback");
      return;
    }

    // SSE bridge token for EventSource, regardless of auth mode.
    if (request.url.startsWith("/api/v1/events/stream")) {
      const sseToken = readQueryToken(request.query, "sse_token");
      if (sseToken && validateSseToken(sseToken, "events:stream", sseTokens)) {
        setAuthActor(request, `sse:${tokenFingerprint(sseToken)}`, "sse");
        return;
      }
    }

    const providedBearerToken = readBearerToken(request.headers.authorization);
    if (providedBearerToken) {
      const deviceGrant = fastify.gateway.validateDeviceAccessToken(providedBearerToken);
      if (deviceGrant) {
        setAuthActor(request, deviceGrant.actorId, "device");
        request.authDeviceId = deviceGrant.deviceId;
        request.authGrantId = deviceGrant.grantId;
        enterRequestAttribution({
          actorId: deviceGrant.actorId,
          deviceId: deviceGrant.deviceId,
          grantId: deviceGrant.grantId,
        });
        return;
      }
    }

    if (auth.mode === "token") {
      const configuredToken = auth.token.value?.trim();
      if (!configuredToken) {
        return reply.code(503).send({
          error: "Gateway auth mode is token, but no token is configured",
        });
      }

      const provided = providedBearerToken
        ?? readHeaderToken(request.headers["x-goatcitadel-token"])
        ?? readQueryToken(request.query, auth.token.queryParam);

      if (!provided || !timingSafeStringEqual(provided, configuredToken)) {
        return reply.code(401).send({
          error: "Unauthorized",
          authMode: "token",
        });
      }
      setAuthActor(request, `token:${tokenFingerprint(provided)}`, "token");
      return;
    }

    if (auth.mode === "basic") {
      const username = auth.basic.username?.trim();
      const password = auth.basic.password?.trim();
      if (!username || !password) {
        return reply.code(503).send({
          error: "Gateway auth mode is basic, but credentials are not configured",
        });
      }

      const credentials = readBasicCredentials(request.headers.authorization);
      if (
        !credentials
        || !timingSafeStringEqual(credentials.username, username)
        || !timingSafeStringEqual(credentials.password, password)
      ) {
        reply.header("WWW-Authenticate", 'Basic realm="GoatCitadel Gateway"');
        return reply.code(401).send({
          error: "Unauthorized",
          authMode: "basic",
        });
      }
      setAuthActor(request, `basic:${normalizeActorSuffix(username)}`, "basic");
      return;
    }
  });
});

function readHeaderToken(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_AUTH_TOKEN_LENGTH) {
    return undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function readQueryToken(query: unknown, queryParam: string): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[queryParam];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_AUTH_TOKEN_LENGTH) {
    return undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBearerToken(header: string | string[] | undefined): string | undefined {
  if (!header || Array.isArray(header)) {
    return undefined;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return undefined;
  }
  const token = match[1]?.trim();
  if (!token || token.length === 0 || token.length > MAX_AUTH_TOKEN_LENGTH) {
    return undefined;
  }
  return token;
}

function readBasicCredentials(header: string | string[] | undefined): { username: string; password: string } | undefined {
  if (!header || Array.isArray(header)) {
    return undefined;
  }
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
    if (decoded.length > MAX_BASIC_CREDENTIAL_LENGTH) {
      return undefined;
    }
    const separator = decoded.indexOf(":");
    if (separator <= 0) {
      return undefined;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(ip: string): boolean {
  const normalized = ip.replace("::ffff:", "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = hashForTimingCompare(left);
  const rightDigest = hashForTimingCompare(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

function validateSseToken(
  provided: string,
  scope: "events:stream",
  store: Map<string, SseTokenRecord>,
): boolean {
  purgeExpiredSseTokens(store);
  const record = store.get(provided);
  if (
    record
    && record.scope === scope
    && record.expiresAt > Date.now()
    && timingSafeStringEqual(record.token, provided)
  ) {
    // One-time use token.
    store.delete(provided);
    return true;
  }
  return false;
}

function purgeExpiredSseTokens(store: Map<string, SseTokenRecord>): void {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (record.expiresAt <= now) {
      store.delete(key);
    }
  }
}

function enforceSseTokenCapacity(store: Map<string, SseTokenRecord>, maxItems: number): void {
  while (store.size >= maxItems) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    store.delete(oldestKey);
  }
}

function setAuthActor(
  request: { authActorId?: string; authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" },
  actorId: string,
  source: "none" | "token" | "basic" | "loopback" | "sse" | "device",
): void {
  request.authActorId = actorId;
  request.authActorSource = source;
  enterRequestAttribution({ actorId });
}

function hashForTimingCompare(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function normalizeActorSuffix(value: string): string {
  return value.trim().replace(/\s+/g, "_").slice(0, 80) || "unknown";
}
