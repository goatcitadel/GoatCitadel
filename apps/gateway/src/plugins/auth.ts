import { createHash, randomBytes } from "node:crypto";
import { normalizeCompanionPrincipalPurpose } from "@goatcitadel/contracts";
import type { CompanionPrincipalPurpose, SseTokenIssueResponse } from "@goatcitadel/contracts";
import { enterRequestAttribution } from "@goatcitadel/storage";
import { timingSafeStringEqual } from "../services/crypto-equals.js";
import { isGenericChannelInboundPath } from "../services/generic-channel-webhook.js";
import { isMeshCapabilityNodeInvocationPath } from "../services/mesh-capability-invocation-service.js";
import { isMeshCapabilityNodePublicationPath } from "../services/mesh-capability-publication-service.js";
import type { MeshCapabilityAuthenticatedNodeIdentity } from "../services/mesh-capability-publication-service.js";
import { isLineWebhookPath } from "../services/line-webhook.js";
import { isNextcloudTalkWebhookPath } from "../services/nextcloud-talk-webhook.js";
import { isSlackWebhookPath } from "../services/slack-webhook.js";
import { isTelegramWebhookPath } from "../services/telegram-webhook.js";
import { isWhatsAppWebhookPath } from "../services/whatsapp-webhook.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    issueSseToken: (
      scope: "events:stream" | "dev:diagnostics:stream",
      ttlMs?: number,
      actorId?: string,
    ) => SseTokenIssueResponse;
    requireOperatorAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
  }

  interface FastifyRequest {
    authActorId: string;
    authActorSource:
      | "none"
      | "token"
      | "basic"
      | "loopback"
      | "sse"
      | "device"
      | "companion"
      | "a2a_peer"
      | "mesh_node";
    /** Set only when the Gateway's primary operator credential boundary emits a 401. */
    operatorAuthRejected: boolean;
    authDeviceId?: string;
    authGrantId?: string;
    authCompanionSessionId?: string;
    /**
     * Immutable, server-owned purpose projected from an authenticated device
     * grant or companion session. `undefined` for every non-device/companion
     * source (operator token, basic, loopback, sse, a2a, anonymous), which the
     * purpose guard treats as "not purpose-bound".
     */
    authPrincipalPurpose?: CompanionPrincipalPurpose;
    a2aPeerId?: string;
    /**
     * HX-408: server-resolved admitted mesh-node identity, set only by the
     * mesh-node route access class after the durable admission credential
     * verifies. Never derived from request bodies.
     */
    meshNodeIdentity?: MeshCapabilityAuthenticatedNodeIdentity;
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
const SSE_TOKEN_CLEANUP_INTERVAL_MS = 60_000;
const REMOTE_APPROVAL_CREATE_TOKEN_HEADER = "x-goatcitadel-approval-create-token";

export const authPlugin = fp(async (fastify) => {
  const sseTokens = new Map<string, SseTokenRecord>();
  const sseTokenCleanupTimer = setInterval(() => {
    purgeExpiredSseTokens(sseTokens);
  }, SSE_TOKEN_CLEANUP_INTERVAL_MS);
  sseTokenCleanupTimer.unref?.();
  const configuredQueryParam = fastify.gatewayConfig.assistant.auth.token.queryParam?.trim();
  fastify.decorateRequest("authActorId", "anonymous");
  fastify.decorateRequest("authActorSource", "none");
  fastify.decorateRequest("operatorAuthRejected", false);
  fastify.decorateRequest("authDeviceId", undefined);
  fastify.decorateRequest("authGrantId", undefined);
  fastify.decorateRequest("authCompanionSessionId", undefined);
  fastify.decorateRequest("authPrincipalPurpose", undefined);
  fastify.decorateRequest("a2aPeerId", undefined);
  fastify.decorateRequest("meshNodeIdentity", undefined);

  fastify.decorate(
    "issueSseToken",
    (scope: "events:stream" | "dev:diagnostics:stream", ttlMs = 2 * 60 * 1000, actorId = "anonymous") => {
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
    },
  );
  fastify.decorate("requireOperatorAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (hasOperatorControlPlaneAccess(fastify, request.authActorSource)) {
      return;
    }
    return reply.code(403).send({
      error: "Operator authentication is required for this control-plane route.",
    });
  });

  fastify.addHook("onRequest", async (request, reply) => {
    setAuthActor(request, "anonymous", "none");
    request.operatorAuthRejected = false;
    request.authDeviceId = undefined;
    request.authGrantId = undefined;
    request.authCompanionSessionId = undefined;
    request.authPrincipalPurpose = undefined;
    request.a2aPeerId = undefined;
    request.meshNodeIdentity = undefined;
    if (request.method === "OPTIONS") {
      return;
    }
    if (request.url.startsWith("/health") || request.url.split("?", 1)[0] === "/livez") {
      return;
    }
    if (request.url.startsWith("/api/v1/auth/device-requests")) {
      return;
    }
    if (request.url.split("?", 1)[0] === "/api/v1/auth/companion/session/refresh") {
      return;
    }
    if (request.url.split("?", 1)[0] === "/api/v1/integrations/slack/oauth/callback") {
      return;
    }
    if (
      isGenericChannelInboundPath(request.url) ||
      isLineWebhookPath(request.url) ||
      isNextcloudTalkWebhookPath(request.url) ||
      isSlackWebhookPath(request.url) ||
      isTelegramWebhookPath(request.url) ||
      isWhatsAppWebhookPath(request.url)
    ) {
      return;
    }
    // HX-408: admitted-node publication and invocation routes carry the
    // node's durable join-token credential, not operator authority. Leave
    // them unauthenticated here (in every auth mode); the mesh-node route
    // access class fails closed unless the admission owner verifies the
    // credential.
    if (isMeshCapabilityNodePublicationPath(request.url) || isMeshCapabilityNodeInvocationPath(request.url)) {
      return;
    }

    const auth = fastify.gatewayConfig.assistant.auth;
    if (auth.mode === "none") {
      setAuthActor(request, "auth:none", "none");
      return;
    }
    if (isRemoteApprovalResolveRequest(request)) {
      setAuthActor(request, "approval-remote-resolve", "none");
      return;
    }
    if (isRemoteApprovalCreateRequest(request) && validateRemoteApprovalCreateToken(request)) {
      const provided = readHeaderToken(request.headers[REMOTE_APPROVAL_CREATE_TOKEN_HEADER]);
      setAuthActor(request, `approval-create:${tokenFingerprint(provided ?? "unknown")}`, "none");
      return;
    }

    const remoteAddress = request.raw.socket.remoteAddress ?? request.ip;
    // SECURITY (codex finding #19): Treat a request as loopback only when
    // it carries NO proxy provenance at all — neither `X-Forwarded-For` nor
    // `Forwarded`. A reverse proxy that bridges remote clients to a
    // 127.0.0.1-bound gateway can strip proxy headers (intentionally or by
    // misconfig), in which case `request.raw.socket.remoteAddress === 127.0.0.1`
    // and a remote attacker would otherwise satisfy `loopbackRequest`. We
    // also defer to `request.ips` when Fastify's `trustProxy` is configured;
    // if `ips.length > 1` the request travelled through a proxy. Defence in
    // depth — we still treat the bypass as an exception rather than a rule.
    //
    // Check header *presence*, not just truthiness — a proxy that emits an
    // empty `X-Forwarded-For: ` header still indicates the request crossed
    // a proxy boundary, even though `Boolean("") === false`.
    const proxyHopCount = Array.isArray(request.ips) ? request.ips.length : 0;
    const hasProxyProvenance =
      "x-forwarded-for" in request.headers || "forwarded" in request.headers || proxyHopCount > 1;
    const loopbackRequest = !hasProxyProvenance && isLoopbackAddress(remoteAddress);
    if (auth.allowLoopbackBypass && loopbackRequest) {
      setAuthActor(request, `loopback:${normalizeActorSuffix(remoteAddress)}`, "loopback");
      return;
    }

    // The onboarding-recovery bypass is the only way for a fresh install
    // (no token, no basic credentials yet) to authenticate the first
    // operator without manual file edits. Keep it independent of
    // `auth.allowLoopbackBypass` so first-run onboarding still works when
    // the operator disables the broader loopback shortcut.
    //
    // SECURITY (codex finding #19): The reverse-proxy attack scenario the
    // finding describes is already neutralised above by the much stricter
    // `hasProxyProvenance` check — any request with `X-Forwarded-For`,
    // `Forwarded`, or `request.ips.length > 1` is no longer treated as a
    // loopback request, even if `request.raw.socket.remoteAddress` looks
    // like 127.0.0.1.
    if (
      loopbackRequest &&
      isOnboardingRecoveryRoute(request.url) &&
      isAuthMisconfigured(auth) &&
      !isOnboardingComplete(fastify)
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
    if (!sseScope && configuredQueryParam) {
      const deprecatedQueryToken = readQueryToken(request.query, configuredQueryParam);
      if (deprecatedQueryToken) {
        fastify.log.warn(
          {
            authMode: fastify.gatewayConfig.assistant.auth.mode,
            queryParam: configuredQueryParam,
            url: request.url,
          },
          "assistant.auth.token.queryParam is deprecated for normal gateway requests; only SSE bridge tokens still use query parameters.",
        );
      }
    }

    const providedBearerToken = readBearerToken(request.headers.authorization);

    if (auth.mode === "token") {
      const configuredToken = auth.token.value?.trim();
      if (!configuredToken) {
        return reply.code(503).send({
          error: "Gateway auth mode is token, but no token is configured",
        });
      }

      const provided = providedBearerToken ?? readHeaderToken(request.headers["x-goatcitadel-token"]);

      // Operator bearer tokens are the common path for Mission Control. Check
      // them before device/companion storage lookups so lightweight routes stay
      // lightweight.
      if (provided && timingSafeStringEqual(provided, configuredToken)) {
        setAuthActor(request, `token:${tokenFingerprint(provided)}`, "token");
        return;
      }
    }

    if (providedBearerToken) {
      const deviceGrant = await fastify.gatewayAuth.validateDeviceAccessToken(providedBearerToken);
      if (deviceGrant) {
        setAuthActor(request, deviceGrant.actorId, "device");
        request.authDeviceId = deviceGrant.deviceId;
        request.authGrantId = deviceGrant.grantId;
        request.authPrincipalPurpose = normalizeCompanionPrincipalPurpose(deviceGrant.principalPurpose);
        enterRequestAttribution({
          actorId: deviceGrant.actorId,
          deviceId: deviceGrant.deviceId,
          grantId: deviceGrant.grantId,
        });
        return;
      }

      const companionSession = await fastify.gatewayAuth.validateCompanionAccessToken(providedBearerToken);
      if (companionSession) {
        setAuthActor(request, companionSession.actorId, "companion");
        request.authDeviceId = companionSession.deviceId;
        request.authGrantId = companionSession.grantId;
        request.authCompanionSessionId = companionSession.sessionId;
        request.authPrincipalPurpose = normalizeCompanionPrincipalPurpose(companionSession.principalPurpose);
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

      const provided = providedBearerToken ?? readHeaderToken(request.headers["x-goatcitadel-token"]);

      if (!provided || !timingSafeStringEqual(provided, configuredToken)) {
        request.operatorAuthRejected = true;
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
      const usernameMatches = credentials ? timingSafeStringEqual(credentials.username, username) : false;
      const passwordMatches = credentials ? timingSafeStringEqual(credentials.password, password) : false;
      const credentialsMatch = usernameMatches && passwordMatches;
      if (!credentialsMatch) {
        request.operatorAuthRejected = true;
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
      await fastify.gatewayAuth.verifyCompanionRequestSignature({
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

  fastify.addHook("onClose", async () => {
    clearInterval(sseTokenCleanupTimer);
    sseTokens.clear();
  });
});

function isOnboardingRecoveryRoute(url: string): boolean {
  const pathname = url.split("?", 1)[0];
  return (
    pathname === "/api/v1/onboarding/startup" ||
    pathname === "/api/v1/onboarding/state" ||
    pathname === "/api/v1/onboarding/bootstrap" ||
    pathname === "/api/v1/auth/plan" ||
    pathname === "/api/v1/auth/install-token"
  );
}

function getSseTokenScopeForPath(url: string): "events:stream" | "dev:diagnostics:stream" | null {
  const pathname = url.split("?", 1)[0];
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
    return Boolean(fastify.gatewayAuth.getOnboardingStartupState().completed);
  } catch (error) {
    // Safe default: "complete" disables the onboarding recovery bypass and keeps auth enforced.
    fastify.log.warn(
      { err: error },
      "Failed to inspect onboarding startup state; treating onboarding as complete to keep auth restrictive.",
    );
    return true;
  }
}

function hasOperatorControlPlaneAccess(fastify: FastifyInstance, source: FastifyRequest["authActorSource"]): boolean {
  if (source === "token" || source === "basic" || source === "loopback") {
    return true;
  }
  return source === "none" && fastify.gatewayConfig.assistant.auth.mode === "none";
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
  const token = readAuthorizationSchemeValue(header, "bearer");
  if (!token || token.length === 0 || token.length > MAX_AUTH_TOKEN_LENGTH) {
    return undefined;
  }
  return token;
}

function readBasicCredentials(
  header: string | string[] | undefined,
): { username: string; password: string } | undefined {
  const encoded = readAuthorizationSchemeValue(header, "basic");
  if (!encoded) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
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

function readAuthorizationSchemeValue(
  header: string | string[] | undefined,
  scheme: "basic" | "bearer",
): string | undefined {
  if (!header || Array.isArray(header) || header.length <= scheme.length) {
    return undefined;
  }
  const providedScheme = header.slice(0, scheme.length);
  if (providedScheme.toLowerCase() !== scheme) {
    return undefined;
  }
  if (!isAsciiWhitespaceCode(header.charCodeAt(scheme.length))) {
    return undefined;
  }
  const value = header.slice(scheme.length + 1).trim();
  return value.length > 0 ? value : undefined;
}

function isAsciiWhitespaceCode(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function isLoopbackAddress(ip: string): boolean {
  const normalized = ip.replace("::ffff:", "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function isRemoteApprovalCreateRequest(request: FastifyRequest): boolean {
  return request.method.toUpperCase() === "POST" && request.url.split("?", 1)[0] === "/api/v1/approvals";
}

function isRemoteApprovalResolveRequest(request: FastifyRequest): boolean {
  return request.method.toUpperCase() === "POST" && request.url.split("?", 1)[0] === "/api/v1/approvals/remote-resolve";
}

function validateRemoteApprovalCreateToken(request: FastifyRequest): boolean {
  const expected = resolveRemoteApprovalCreateToken();
  if (!expected) {
    return false;
  }
  const provided = readHeaderToken(request.headers[REMOTE_APPROVAL_CREATE_TOKEN_HEADER]);
  return Boolean(provided && timingSafeStringEqual(provided, expected));
}

function resolveRemoteApprovalCreateToken(): string | undefined {
  const envName = process.env.GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN_ENV?.trim();
  const fromNamedEnv = envName ? process.env[envName]?.trim() : undefined;
  return fromNamedEnv || process.env.GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN?.trim() || undefined;
}

function validateSseToken(
  provided: string,
  scope: "events:stream" | "dev:diagnostics:stream",
  store: Map<string, SseTokenRecord>,
): boolean {
  purgeExpiredSseTokens(store);
  const record = store.get(provided);
  if (record) {
    // Consume bridge tokens before validation so every token is single-attempt,
    // including wrong-scope and expired attempts.
    store.delete(provided);
  }
  if (
    record &&
    record.scope === scope &&
    record.expiresAt > Date.now() &&
    timingSafeStringEqual(record.token, provided)
  ) {
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
  const actorKeys: string[] = [];
  for (const [key, record] of store.entries()) {
    if (record.actorId === actorId) {
      actorKeys.push(key);
    }
  }
  const actorEvictionCount = Math.max(0, actorKeys.length - maxItemsPerActor + 1);
  for (const key of actorKeys.slice(0, actorEvictionCount)) {
    store.delete(key);
  }
  while (store.size >= maxItems) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    store.delete(oldestKey);
  }
}

function setAuthActor(
  request: {
    authActorId?: string;
    authActorSource?:
      | "none"
      | "token"
      | "basic"
      | "loopback"
      | "sse"
      | "device"
      | "companion"
      | "a2a_peer"
      | "mesh_node";
  },
  actorId: string,
  source: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer" | "mesh_node",
): void {
  request.authActorId = actorId;
  request.authActorSource = source;
  enterRequestAttribution({ actorId });
}

function isCompanionSignedMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function tokenFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function normalizeActorSuffix(value: string): string {
  return value.trim().replace(/\s+/g, "_").slice(0, 80) || "unknown";
}
