import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { isGenericChannelInboundPath } from "../services/generic-channel-webhook.js";
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
  claimToken?: string;
}

export class MutationIdempotencyClaimLostError extends Error {
  public constructor() {
    super("HTTP mutation idempotency claim ownership was lost before canonical commit.");
    this.name = "MutationIdempotencyClaimLostError";
  }
}

interface IdempotencyHeaderPluginOptions {
  mutationStore?: MutationIdempotencyStore;
}

const MUTATING_HTTP_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const GATEWAY_EVENTS_PATH = "/api/v1/gateway/events";
const HTTP_MUTATION_CLAIM_LEASE_MS = 5 * 60_000;
const GENERATION_FENCED_CHAT_SSE_ROUTES = new Set([
  "/api/v1/chat/sessions/:sessionId/agent-send/stream",
  "/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream",
  "/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream",
]);
const SECRET_SENSITIVE_USER_INPUT_ROUTES = new Set([
  "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/respond",
  "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/secure-configuration",
]);
const SECRET_SENSITIVE_REMOTE_WORKER_CONTROL_ROUTES = new Set([
  "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/quarantine",
  "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/revoke",
]);
const SECRET_SENSITIVE_MOBILE_PUSH_ROUTES = new Set(["/api/v1/mobile/current-device/push"]);
/**
 * Provider credentials and Gateway auth settings carry raw secrets (API keys, tokens, Basic passwords). Their
 * bodies must never be fingerprinted durably: an unsalted hash of a low-entropy password is an offline oracle.
 * A key binds one attempt to its concrete path; the owner's expectedRevision governs explicit retries.
 */
const SECRET_SENSITIVE_CREDENTIAL_ROUTES = new Set(["/api/v1/secrets/providers/:providerId", "/api/v1/auth/settings"]);
const MOBILE_PUSH_REGISTRATION_PATH = "/api/v1/mobile/current-device/push";
const SECURE_CONFIGURATION_ROUTE =
  "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/secure-configuration";
const REMOTE_WORKER_BOOTSTRAP_ROUTE = "/api/v1/ops/workspaces/:workspaceId/remote-workers/bootstrap";
const REMOTE_WORKER_MESH_JOIN_AUTHORITY_ROUTE =
  "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/mesh-node-join-authorities";
const CANONICAL_REPLAY_ROUTES = new Set([SECURE_CONFIGURATION_ROUTE]);
const CANONICAL_IDEMPOTENCY_OWNER_ROUTES = new Set([
  REMOTE_WORKER_BOOTSTRAP_ROUTE,
  REMOTE_WORKER_MESH_JOIN_AUTHORITY_ROUTE,
]);

export const idempotencyHeaderPlugin = fp<IdempotencyHeaderPluginOptions>(async (fastify, options) => {
  fastify.decorateRequest("idempotencyKey", "");
  fastify.decorateRequest("mutationIdempotencyState", null);
  fastify.decorateRequest("mutationCommitted", false);
  fastify.decorateRequest("mutationIdempotencyOutcome", null);
  fastify.decorateRequest("mutationIdempotencyCommit", null);

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
    const routePath = getNormalizedRoutePath(request);
    if (
      !options.mutationStore ||
      !shouldEnforceMutationIdempotency(request) ||
      CANONICAL_IDEMPOTENCY_OWNER_ROUTES.has(routePath)
    ) {
      // One-time remote-worker secrets are deliberately not recoverable from
      // durable hashes. Their repositories own replay and request drift; a
      // second generic claim could fail after canonical commit and suppress the
      // only response that is allowed to expose a secret.
      return;
    }

    const actorScope = request.authActorId?.trim() || "";
    const claim = await options.mutationStore.claim({
      method: request.method,
      routePath,
      idempotencyKey: key,
      actorScope,
      payloadHash: hashMutationPayload(request),
      ...(usesGenerationFencedCanonicalCommit(routePath) ? { leaseDurationMs: HTTP_MUTATION_CLAIM_LEASE_MS } : {}),
    });
    if (claim.outcome === "claimed") {
      const state: MutationIdempotencyState = {
        method: request.method,
        routePath,
        idempotencyKey: key,
        actorScope,
        claimToken: claim.record.claimToken,
      };
      (request as typeof request & { mutationIdempotencyState: MutationIdempotencyState }).mutationIdempotencyState =
        state;
      request.mutationIdempotencyOutcome = "pending";
      request.mutationIdempotencyCommit = async () => {
        if ((await options.mutationStore?.markCompleted(state)) === false) {
          throw new MutationIdempotencyClaimLostError();
        }
      };
      return;
    }

    if (claim.outcome === "duplicate" && CANONICAL_REPLAY_ROUTES.has(routePath)) {
      // The secure-configuration handler owns a secret-independent replay path
      // backed by its canonical repository. Let an exact transport retry
      // recover a secret-free receipt after a lost response; newly supplied
      // bytes are ignored. In-progress and payload-mismatch claims remain
      // blocked.
      request.mutationIdempotencyOutcome = "committed";
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
    // F-M1: any non-2xx/3xx response means the handler rejected the request —
    // a 4xx (validation/permission failure) just like a 5xx typically performs
    // NO durable side effect. Burning the key as `completed` on a 4xx blocked a
    // legitimate corrected retry with a 409. Treat every error status (>= 400)
    // as a failed claim so it is revivable; only a 2xx/3xx outcome finalises the
    // key as completed.
    if (request.mutationIdempotencyOutcome === "failed_before_commit") {
      await options.mutationStore.markFailed(state);
      return;
    }
    if (reply.statusCode >= 400 && !request.mutationCommitted) {
      await options.mutationStore.markFailed(state);
      return;
    }
    await options.mutationStore.markCompleted(state);
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (isMobilePushRegistrationRequest(request) || getNormalizedRoutePath(request).startsWith("/api/v1/citadels/:citadelId/vault-secrets")
      || getNormalizedRoutePath(request) === "/api/v1/integrations/connections"
      || getNormalizedRoutePath(request) === "/api/v1/integrations/connections/:connectionId") {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    return payload;
  });

  /**
   * Caller-scoped outcome of one mutation attempt, by the Idempotency-Key the caller chose. It lets a client settle a
   * lost response from the Gateway's own durable claim instead of guessing: completed = committed, failed = the claim
   * was released after an error status without a commit mark (commit state unproven: a handler can commit and then
   * fail, so confirm by the owner's readback), pending = still running (or an expired claim), absent = never recorded
   * for this caller. It never returns the payload fingerprint or the claim token.
   *
   * Client rule: "absent" is not proof that nothing ran (a delayed request can still arrive). Settle a lost response
   * by re-sending with the SAME key, which the claim makes safe whatever the answer; never mint a new key because of
   * "absent". A pending claim with claimExpired is unknown, not failed. `route` must be the registered route pattern
   * (for example /api/v1/secrets/providers/:providerId), never a concrete URL: anything else is refused, so a wrong
   * route can never read as "absent".
   */
  fastify.get("/api/v1/mutation-attempts/:idempotencyKey", ATTEMPT_READ_ROUTE_OPTIONS, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Exactly the key the claim stored: no trimming, so a read can never alias a different stored key.
    const key = (request.params as { idempotencyKey?: string }).idempotencyKey ?? "";
    const query = request.query as { method?: unknown; route?: unknown };
    const method = typeof query.method === "string" ? query.method.toUpperCase() : "";
    const routePath = typeof query.route === "string" ? query.route : "";
    if (!key.trim() || key.length > 256 || !MUTATING_HTTP_METHODS.has(method) || !isTrackedAttemptRoute(routePath)) {
      return reply.code(400).send({ error: "An attempt read needs its key, a mutating method and a tracked API route." });
    }
    if (!fastify.hasRoute({ method: method as "POST", url: routePath })) {
      return reply.code(400).send({ error: "unknown_route: pass the registered route pattern for this method." });
    }
    if (!options.mutationStore?.get) {
      return reply.code(503).send({ error: "Mutation attempts are not recorded by this Gateway." });
    }
    const record = await options.mutationStore.get({
      method,
      routePath,
      idempotencyKey: key,
      actorScope: request.authActorId?.trim() || "",
    });
    if (!record) return { attempt: { status: "absent" } };
    const claimExpired =
      record.status === "pending" && typeof record.claimExpiresAt === "string"
        ? Date.parse(record.claimExpiresAt) < Date.now()
        : false;
    return { attempt: { status: record.status, claimExpired, updatedAt: record.updatedAt } };
  });
});

const ATTEMPT_READ_ROUTE_OPTIONS = { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } };

function isTrackedAttemptRoute(routePath: string): boolean {
  return (
    routePath.length <= 512 &&
    routePath.startsWith("/api/v1/") &&
    routePath !== GATEWAY_EVENTS_PATH &&
    !isGenericChannelInboundPath(routePath) &&
    !isWebhookOrInboundPath(routePath) &&
    !CANONICAL_IDEMPOTENCY_OWNER_ROUTES.has(routePath)
  );
}

/**
 * Marks that the canonical mutation transaction committed. A later transport,
 * projection, or response-delivery failure must not revive the same
 * idempotency key and execute the mutation again.
 */
export async function markMutationCommitted(request: FastifyRequest): Promise<void> {
  request.mutationCommitted = true;
  request.mutationIdempotencyOutcome = "committed";
  await request.mutationIdempotencyCommit?.();
}

/**
 * Completes the persistent HTTP mutation claim inside the canonical owner's
 * transaction. This intentionally does not update request-local commit truth:
 * if the surrounding transaction rolls back, `afterCommit` must remain the
 * only signal that prevents the response boundary from releasing the claim.
 */
export async function commitMutationIdempotencyAlongsideCanonicalWrite(request: FastifyRequest): Promise<void> {
  await request.mutationIdempotencyCommit?.();
}

/**
 * Releases a claimed mutation whose streamed handler terminated before its
 * first canonical write. Once commit has been observed, later stream failures
 * cannot downgrade the claim back to retryable.
 */
export function markMutationFailedBeforeCommit(request: FastifyRequest): void {
  if (request.mutationCommitted || request.mutationIdempotencyOutcome === "committed") {
    return;
  }
  request.mutationIdempotencyOutcome = "failed_before_commit";
}

/** Preserve committed idempotency truth for mutation-aware domain errors. */
export async function markMutationCommittedFromError(request: FastifyRequest, error: unknown): Promise<void> {
  if (
    error &&
    typeof error === "object" &&
    "mutationCommitted" in error &&
    (error as { mutationCommitted?: unknown }).mutationCommitted === true
  ) {
    await markMutationCommitted(request);
  }
}

function shouldEnforceMutationIdempotency(request: FastifyRequest): boolean {
  const path = getNormalizedRoutePath(request);
  return path.startsWith("/api/v1/") && path !== GATEWAY_EVENTS_PATH && !isGenericChannelInboundPath(path);
}

function usesGenerationFencedCanonicalCommit(routePath: string): boolean {
  return GENERATION_FENCED_CHAT_SSE_ROUTES.has(routePath);
}

function isWebhookOrInboundPath(url: string): boolean {
  return (
    isGenericChannelInboundPath(url) ||
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

function isMobilePushRegistrationRequest(request: FastifyRequest): boolean {
  return request.method === "PUT" && (request.url.split("?", 1)[0] || request.url) === MOBILE_PUSH_REGISTRATION_PATH;
}

function hashCanonicalPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * Default deny for the generic fingerprint: any field whose name suggests a credential is replaced before hashing,
 * at any depth, so no route can durably fingerprint a secret by omission from the explicit lists above. Non-secret
 * fields still detect a reused key with a changed request. Over-matching only weakens drift detection.
 */
const SECRET_FIELD_NAME = new RegExp(
  [
    "api[-_]?key", "token", "password", "passwd", "passphrase", "secret", "credential", "private[-_]?key",
    "authorization", "cookie", "^values?$", "^headers$", "pwd", "passcode", "otp", "^pin$", "^pat$", "bearer", "jwt",
    "hmac", "signature", "signing", "access[-_]?key", "session[-_]?key", "encryption[-_]?key", "(?:^|[-_])key$",
    "pem", "certificate", "^dsn$", "connection[-_]?string", "(?:^|[-_])auth$", "^code$", "root[-_]?path",
  ].join("|"),
  "iu",
);
const REDACTED_SECRET_FIELD = "[redacted-secret-field]";
const MAX_REDACTION_DEPTH = 32;
/** Credentials embedded in otherwise ordinary strings: URL userinfo and well-known token shapes. */
const URL_USERINFO = /(\/\/)[^/@\s:]+:[^/@\s]+@/gu;
const TOKEN_SHAPED = /^(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA|eyJ[\w-]*\.[\w-]+\.)/u;
/** Flag names are checked in bounded, regex-free steps: nested quantifiers here would be a ReDoS on request bodies. */
const MAX_FLAG_LENGTH = 256;
const FLAG_NAME = /^--?[\w-]{1,128}$/u;
const SECRET_FLAG_WORDS = ["token", "password", "passwd", "secret", "key", "auth", "credential"] as const;
function readSecretFlag(item: string): { hasInlineValue: boolean } | null {
  if (!item.startsWith("-")) return null;
  // Only the flag name is bounded: an inline value of any length after "=" is always redacted.
  const equals = item.indexOf("=");
  const name = equals < 0 ? item : item.slice(0, equals);
  if (name.length > MAX_FLAG_LENGTH || !FLAG_NAME.test(name)) return null;
  const lower = name.toLowerCase();
  return SECRET_FLAG_WORDS.some((word) => lower.includes(word)) ? { hasInlineValue: equals >= 0 } : null;
}
function scrubString(value: string): string {
  if (TOKEN_SHAPED.test(value)) return REDACTED_SECRET_FIELD;
  return value.replace(URL_USERINFO, "$1[redacted-userinfo]@");
}
function redactSecretFields(value: unknown, depth = 0): unknown {
  // Fail closed: anything past the depth cap is not fingerprinted.
  if (depth > MAX_REDACTION_DEPTH) return REDACTED_SECRET_FIELD;
  if (typeof value === "string") return depth === 0 ? REDACTED_SECRET_FIELD : scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const previous = index > 0 ? value[index - 1] : undefined;
      if (typeof item === "string") {
        const flag = readSecretFlag(item);
        if (flag?.hasInlineValue) return item.slice(0, item.indexOf("=") + 1) + REDACTED_SECRET_FIELD;
        if (typeof previous === "string" && readSecretFlag(previous)?.hasInlineValue === false) return REDACTED_SECRET_FIELD;
      }
      return redactSecretFields(item, depth + 1);
    });
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_FIELD_NAME.test(key) ? REDACTED_SECRET_FIELD : redactSecretFields(item, depth + 1),
    ]),
  );
}

/**
 * The generic idempotency owner durably retains this digest. Secure runtime
 * input routes therefore must not derive it from the request body: even the
 * generic route may receive a malicious extra secret before strict validation.
 * The
 * concrete, query-free path contains only the already-public Chat authority
 * tuple (session, turn, and one-time prompt id), so it is sufficient to bind an
 * HTTP retry without creating a credential oracle or durable secret fingerprint.
 */
function hashMutationPayload(request: FastifyRequest): string {
  const routePath = getNormalizedRoutePath(request);
  if (routePath === "/api/v1/mcp/servers" || routePath.startsWith("/api/v1/mcp/servers/")) {
    return hashCanonicalPayload({ kind: "mcp_server_redacted_v1", path: request.url.split("?", 1)[0] || request.url });
  }
  if (routePath === "/api/v1/channels/drafts" || routePath.startsWith("/api/v1/channels/drafts/")) {
    return hashCanonicalPayload({ kind: "channel_setup_redacted_v1", path: request.url.split("?", 1)[0] || request.url });
  }
  if (routePath === "/api/v1/citadels/:citadelId/vault-secrets"
    || routePath === "/api/v1/citadels/:citadelId/vault-secrets/:secretId"
    || routePath === "/api/v1/integrations/connections"
    || routePath === "/api/v1/integrations/connections/:connectionId") {
    // A key identifies one attempt. Completed duplicates stay blocked regardless
    // of body changes; an explicit retry uses a new key and the owner's revision.
    // Do not fingerprint values, names, or unvalidated extra fields here.
    return hashCanonicalPayload({
      kind: routePath.startsWith("/api/v1/integrations/") ? "integration_connection_redacted_v1" : "citadel_vault_redacted_v1",
      path: request.url.split("?", 1)[0] || request.url,
    });
  }
  if (SECRET_SENSITIVE_CREDENTIAL_ROUTES.has(routePath)) {
    return hashCanonicalPayload({
      kind: "credential_route_redacted_v1",
      path: request.url.split("?", 1)[0] || request.url,
    });
  }
  if (SECRET_SENSITIVE_USER_INPUT_ROUTES.has(routePath)) {
    return hashCanonicalPayload({
      kind: "chat_user_input_redacted_v1",
      path: request.url.split("?", 1)[0] || request.url,
    });
  }
  if (SECRET_SENSITIVE_REMOTE_WORKER_CONTROL_ROUTES.has(routePath)) {
    const body = (request as { body?: unknown }).body;
    const reasonCode =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).reasonCode === "string" &&
      /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test((body as Record<string, unknown>).reasonCode as string)
        ? ((body as Record<string, unknown>).reasonCode as string)
        : null;
    return hashCanonicalPayload({
      kind: "remote_worker_generation_control_redacted_v1",
      path: request.url.split("?", 1)[0] || request.url,
      reasonCode,
    });
  }
  if (SECRET_SENSITIVE_MOBILE_PUSH_ROUTES.has(routePath)) {
    const body = (request as { body?: unknown }).body;
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const provider = record.provider === "expo" || record.provider === "fcm" ? record.provider : null;
    const enabled = typeof record.enabled === "boolean" ? record.enabled : null;
    return hashCanonicalPayload({
      kind: "mobile_push_registration_redacted_v1",
      path: request.url.split("?", 1)[0] || request.url,
      provider,
      enabled,
    });
  }
  return hashCanonicalPayload(redactSecretFields((request as { body?: unknown }).body ?? null));
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
