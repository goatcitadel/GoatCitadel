import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const DEFAULT_WEBHOOK_INGRESS_MAX = 500;
const DEFAULT_WEBHOOK_ACCEPTED_MAX = 180;
const WEBHOOK_RATE_LIMIT_WINDOW = "1 minute";

export type AcceptedWebhookSource = "generic" | "telegram" | "whatsapp" | "slack" | "line" | "nextcloud-talk";

export type AcceptedWebhookRateLimit = ReturnType<FastifyInstance["createRateLimit"]>;

export function resolveWebhookRateLimitConfig(): {
  maxIngress: number;
  maxAccepted: number;
} {
  const maxIngress = parsePositiveInt(
    process.env.GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_INGRESS,
    DEFAULT_WEBHOOK_INGRESS_MAX,
  );
  const configuredAccepted = parsePositiveInt(
    process.env.GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_ACCEPTED,
    DEFAULT_WEBHOOK_ACCEPTED_MAX,
  );

  // Keep the post-verification bucket below the coarse ingress bucket. This
  // preserves capacity for callers with valid signatures even if operators
  // accidentally configure the two limits in the wrong order.
  const maxAccepted = Math.min(configuredAccepted, Math.max(1, maxIngress - 1));
  return { maxIngress, maxAccepted };
}

export function buildWebhookIngressRateLimitKey(request: FastifyRequest): string {
  const routePath = String(request.routeOptions.url || "webhook").toLowerCase();
  // This bucket runs before connection/channel validation or signature
  // verification. Keep its identity limited to trusted Fastify route metadata;
  // request params such as `:channel` are attacker-controlled at this point
  // and would let callers evade the coarse quota by rotating path segments.
  return `webhook-ingress:${request.ip}:${routePath}`;
}

export function createAcceptedWebhookRateLimit(
  fastify: Pick<FastifyInstance, "createRateLimit">,
  source: AcceptedWebhookSource,
): AcceptedWebhookRateLimit | undefined {
  if (typeof fastify.createRateLimit !== "function") {
    return undefined;
  }
  const { maxAccepted } = resolveWebhookRateLimitConfig();
  return fastify.createRateLimit({
    max: maxAccepted,
    timeWindow: WEBHOOK_RATE_LIMIT_WINDOW,
    skipOnError: true,
    allowList: (request) => isLoopbackRateLimitAllowlisted(request.ip, request),
    keyGenerator: (request) => {
      const params = readRequestParams(request.params);
      const connectionId = readNonEmptyString(params.connectionId) ?? "unknown-connection";
      const resolvedSource = resolveWebhookSource(request, source);
      return `webhook-accepted:${resolvedSource}:${connectionId}:${request.ip}`;
    },
  });
}

export async function enforceAcceptedWebhookRateLimit(
  checkRateLimit: AcceptedWebhookRateLimit | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!checkRateLimit) {
    return false;
  }
  const result = await checkRateLimit(request);
  if (result.isAllowed) {
    return false;
  }

  reply.header("x-ratelimit-limit", result.max);
  reply.header("x-ratelimit-remaining", result.remaining);
  reply.header("x-ratelimit-reset", result.ttlInSeconds);
  if (!result.isExceeded) {
    return false;
  }

  const retryAfterSeconds = Math.max(1, result.ttlInSeconds);
  reply.header("retry-after", retryAfterSeconds);
  void reply.code(429).send({
    error: "Accepted webhook callback rate limit exceeded",
    retryAfterSeconds,
  });
  return true;
}

export function isLoopbackRateLimitAllowlisted(ip: string, request?: Pick<FastifyRequest, "headers" | "ips">): boolean {
  if (hasProxyProvenance(request)) {
    return false;
  }
  const normalized = ip.trim().toLowerCase().replace(/%.+$/, "");
  return (
    normalized === "::1" ||
    normalized === "::ffff:7f00:1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

function resolveWebhookSource(request: FastifyRequest, source: AcceptedWebhookSource): string {
  if (source !== "generic") {
    return source;
  }
  const params = readRequestParams(request.params);
  const channel = readNonEmptyString(params.channel);
  if (channel) {
    return channel.toLowerCase();
  }
  const pathname = String(request.raw.url ?? request.url).split(/[?#]/u, 1)[0] ?? "";
  const match = /\/connections\/[^/]+\/([^/]+)\/(?:inbound|webhook)$/iu.exec(pathname);
  return match?.[1]?.toLowerCase() ?? "generic";
}

function hasProxyProvenance(request: Pick<FastifyRequest, "headers" | "ips"> | undefined): boolean {
  if (!request) {
    return false;
  }
  const forwarded = request.headers.forwarded;
  const forwardedFor = request.headers["x-forwarded-for"];
  const realIp = request.headers["x-real-ip"];
  return (
    hasNonEmptyHeaderValue(forwarded) ||
    hasNonEmptyHeaderValue(forwardedFor) ||
    hasNonEmptyHeaderValue(realIp) ||
    (Array.isArray(request.ips) && request.ips.length > 1)
  );
}

function hasNonEmptyHeaderValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function readRequestParams(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
