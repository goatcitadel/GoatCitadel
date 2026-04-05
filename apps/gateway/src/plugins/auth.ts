import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SseTokenIssueResponse } from "@goatcitadel/contracts";
import { enterRequestAttribution } from "../../../../packages/storage/src/request-attribution.js";
import { isLineWebhookPath } from "../services/line-webhook.js";
import { isNextcloudTalkWebhookPath } from "../services/nextcloud-talk-webhook.js";
import { isSlackWebhookPath } from "../services/slack-webhook.js";
import { isTelegramWebhookPath } from "../services/telegram-webhook.js";
import { isWhatsAppWebhookPath } from "../services/whatsapp-webhook.js";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    issueSseToken: (
      scope: "events:stream" | "dev:diagnostics:stream",
      ttlMs?: number,
      actorId?: string,
    ) => SseTokenIssueResponse;
  }

  interface FastifyRequest {
    authActorId: string;
    authActorSource: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion";
    authDeviceId?: string;
    authGrantId?: string;
    authCompanionSessionId?: string;
  }
}

interface SseTokenRecord {
  token: string;
  actorId: string;
  scope: "events:stream" | "dev:diagnostics:stream";
  expiresAt: number;
}

const MAX_AUTH_TOKEN_LENGTH = 4096;
const MAX_BASIC_CREDENTIAL_LENGTH = 8192;
const MAX_ACTIVE_SSE_TOKENS = 10_000;
const MAX_ACTIVE_SSE_TOKENS_PER_ACTOR = 50;

export const authPlugin = fp(async (fastify) => {
  const sseTokens = new Map<string, SseTokenRecord>();
  const configuredQueryParam = fastify.gatewayConfig.assistant.auth.token.queryParam?.trim();
  if (configuredQueryParam) {
    fastify.log.warn(
      {
        authMode: fastify.gatewayConfig.assistant.auth.mode,
        queryParam: configuredQueryParam,
      },
      "assistant.auth.token.queryParam is deprecated for normal gateway requests; only SSE bridge tokens still use query parameters.",
    );
  }
  fastify.decorateRequest("authActorId", "anonymous");
  fastify.decorateRequest("authActorSource", "none");
  fastify.decorateRequest("authDeviceId", undefined);
  fastify.decorateRequest("authGrantId", undefined);
  fastify.decorateRequest("authCompanionSessionId", undefined);

  fastify.decorate("issueSseToken", (
    scope: "events:stream" | "dev:diagnostics:stream",
    ttlMs = 2 * 60 * 1000,
    actorId = "anonymous",
  ) => {
    purgeExpiredSseTokens(sseTokens);
    enforceSseTokenCapacity(sseTokens, MAX_ACTIVE_SSE_TOKENS, actorId, MAX_ACTIVE_SSE_TOKENS_PER_ACTOR);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + Math.max(30_000, Math.min(10 * 60 * 1000, ttlMs));
    sseTokens.set(token, {
      token,
      actorId,
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
    request.authCompanionSessionId = undefined;
    if (request.method === "OPTIONS") {
      return;
    }
    if (request.url.startsWith("/health")) {
      return;
    }
    if (request.url.startsWith("/api/v1/auth/device-requests")) {
      return;
    }
    if (request.url.split("?", 1)[0] === "/api/v1/auth/companion/session/refresh") {
      return;
    }
    if (
      isLineWebhookPath(request.url)
      || isNextcloudTalkWebhookPath(request.url)
      || isSlackWebhookPath(request.url)
      || isTelegramWebhookPath(request.url)
      || isWhatsAppWebhookPath(request.url)
    ) {
      return;
    }

    const auth = fastify.gatewayConfig.assistant.auth;
    if (auth.mode === "none") {
      setAuthActor(request, "auth:none", "none");
      return;
    }

    const remoteAddress = request.raw.socket.remoteAddress ?? request.ip;
    const forwardedFor = request.headers["x-forwarded-for"];
    const loopbackRequest = !forwardedFor && isLoopbackAddress(remoteAddress);
    if (
      auth.allowLoopbackBypass
      && loopbackRequest
    ) {
      setAuthActor(request, `loopback:${normalizeActorSuffix(remoteAddress)}`, "loopback");
      return;
    }

    if (
      loopbackRequest
      && isOnboardingRecoveryRoute(request.url)
      && isAuthMisconfigured(auth)
      && !isOnboardingComplete(fastify)
    ) {
      setAuthActor(request, `loopback:${normalizeActorSuffix(remoteAddress)}`, "loopback");
      return;
    }

    // SSE bridge token for EventSource, regardless of auth mode.
    const sseScope = getSseTokenScopeForPath(request.url);
    if (sseScope) {
      const sseToken = readQueryToken(request.query, "sse_token");
      if (sseToken && validateSseToken(sseToken, sseScope, sseTokens)) {
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

      const companionSession = fastify.gateway.validateCompanionAccessToken(providedBearerToken);
      if (companionSession) {
        setAuthActor(request, companionSession.actorId, "companion");
        request.authDeviceId = companionSession.deviceId;
        request.authGrantId = companionSession.grantId;
        request.authCompanionSessionId = companionSession.sessionId;
        enterRequestAttribution({
          actorId: companionSession.actorId,
          deviceId: companionSession.deviceId,
          grantId: companionSession.grantId,
          companionSessionId: companionSession.sessionId,
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
        ?? readHeaderToken(request.headers["x-goatcitadel-token"]);

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

  fastify.addHook("preHandler", async (request, reply) => {
    if (request.authActorSource !== "companion") {
      return;
    }
    if (!isCompanionSignedMutationMethod(request.method)) {
      return;
    }
    if (!request.authCompanionSessionId) {
      return reply.code(401).send({
        error: "Unauthorized",
        authMode: "companion",
      });
    }

    const timestamp = readHeaderToken(request.headers["x-goatcitadel-companion-timestamp"]);
    const nonce = readHeaderToken(request.headers["x-goatcitadel-companion-nonce"]);
    const signature = readHeaderToken(request.headers["x-goatcitadel-companion-signature"]);
    if (!timestamp || !nonce || !signature) {
      return reply.code(401).send({
        error: "Missing companion request signature headers.",
      });
    }

    try {
      fastify.gateway.verifyCompanionRequestSignature({
        sessionId: request.authCompanionSessionId,
        method: request.method,
        path: request.url,
        timestamp,
        nonce,
        signature,
        body: request.body,
      });
    } catch (error) {
      return reply.code(401).send({
        error: (error as Error).message,
      });
    }
  });
});

function isOnboardingRecoveryRoute(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/v1/onboarding/startup"
    || pathname === "/api/v1/onboarding/state"
    || pathname === "/api/v1/onboarding/bootstrap"
    || pathname === "/api/v1/auth/plan"
    || pathname === "/api/v1/auth/install-token";
}

function getSseTokenScopeForPath(url: string): "events:stream" | "dev:diagnostics:stream" | null {
  const pathname = url.split("?", 1)[0] ?? url;
  if (pathname === "/api/v1/events/stream") {
    return "events:stream";
  }
  if (pathname === "/api/v1/dev/diagnostics/stream") {
    return "dev:diagnostics:stream";
  }
  return null;
}

function isAuthMisconfigured(auth: {
  mode: "none" | "token" | "basic";
  token: { value?: string };
  basic: { username?: string; password?: string };
}): boolean {
  if (auth.mode === "token") {
    return !auth.token.value?.trim();
  }
  if (auth.mode === "basic") {
    return !auth.basic.username?.trim() || !auth.basic.password?.trim();
  }
  return false;
}

function isOnboardingComplete(fastify: FastifyInstance): boolean {
  try {
    return Boolean(fastify.gateway?.getOnboardingStartupState?.().completed);
  } catch (error) {
    // Safe default: "complete" disables the onboarding recovery bypass and keeps auth enforced.
    fastify.log.warn(
      { err: error },
      "Failed to inspect onboarding startup state; treating onboarding as complete to keep auth restrictive.",
    );
    return true;
  }
}

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
  scope: "events:stream" | "dev:diagnostics:stream",
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

function enforceSseTokenCapacity(
  store: Map<string, SseTokenRecord>,
  maxItems: number,
  actorId: string,
  maxItemsPerActor: number,
): void {
  while (countSseTokensForActor(store, actorId) >= maxItemsPerActor) {
    const oldestActorKey = findOldestSseTokenKey(store, actorId);
    if (!oldestActorKey) {
      break;
    }
    store.delete(oldestActorKey);
  }
  while (store.size >= maxItems) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    store.delete(oldestKey);
  }
}

function countSseTokensForActor(store: Map<string, SseTokenRecord>, actorId: string): number {
  let count = 0;
  for (const record of store.values()) {
    if (record.actorId === actorId) {
      count += 1;
    }
  }
  return count;
}

function findOldestSseTokenKey(store: Map<string, SseTokenRecord>, actorId: string): string | undefined {
  for (const [key, record] of store.entries()) {
    if (record.actorId === actorId) {
      return key;
    }
  }
  return undefined;
}

function setAuthActor(
  request: { authActorId?: string; authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" },
  actorId: string,
  source: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion",
): void {
  request.authActorId = actorId;
  request.authActorSource = source;
  enterRequestAttribution({ actorId });
}

function isCompanionSignedMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
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
