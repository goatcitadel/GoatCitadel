import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { enterRequestAttribution } from "../../../packages/storage/src/request-attribution.js";
import { loadLocalEnvFile } from "./env-file.js";
import { gatewayPlugin } from "./plugins/storage.js";
import { authPlugin } from "./plugins/auth.js";
import { idempotencyHeaderPlugin } from "./plugins/idempotency.js";
import { healthRoute } from "./routes/health.js";
import { gatewayEventsRoute } from "./routes/gateway-events.js";
import { sessionsListRoute } from "./routes/sessions-list.js";
import { toolsInvokeRoute } from "./routes/tools-invoke.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { costsRoutes } from "./routes/costs.js";
import { skillsRoutes } from "./routes/skills.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { assemblyRoutes } from "./routes/assembly.js";
import { tasksRoutes } from "./routes/tasks.js";
import { eventsRoutes } from "./routes/events.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { filesRoutes } from "./routes/files.js";
import { llmRoutes } from "./routes/llm.js";
import { llamaCppRoutes } from "./routes/llamacpp.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { integrationWebhookRoutes } from "./routes/integration-webhooks.js";
import { meshRoutes } from "./routes/mesh.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { memoryRoutes } from "./routes/memory.js";
import { npuRoutes } from "./routes/npu.js";
import { uiChangeRiskRoutes } from "./routes/ui-change-risk.js";
import { agentsRoutes } from "./routes/agents.js";
import { toolsRoutes } from "./routes/tools.js";
import { commsRoutes } from "./routes/comms.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { authRoutes } from "./routes/auth.js";
import { secretsRoutes } from "./routes/secrets.js";
import { chatRoutes } from "./routes/chat.js";
import { promptPackRoutes } from "./routes/prompt-packs.js";
import { adminRoutes } from "./routes/admin.js";
import { docsRoutes } from "./routes/docs.js";
import { devDiagnosticsRoutes } from "./routes/dev-diagnostics.js";
import { devVerificationRoutes } from "./routes/dev-verification.js";
import { mcpRoutes } from "./routes/mcp.js";
import { addonsRoutes } from "./routes/addons.js";
import { voiceRoutes } from "./routes/voice.js";
import { mediaRoutes } from "./routes/media.js";
import { daemonRoutes } from "./routes/daemon.js";
import { improvementRoutes } from "./routes/improvement.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { hooksRoutes } from "./routes/hooks.js";
import { durableRoutes } from "./routes/durable.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { createGatewayLogger, isVerboseLoggingEnabled } from "./runtime-ux.js";
import { isLoopbackDevOrigin, isTailnetDevOrigin, resolveTailnetShortHostAllowlist } from "./cors-origin-guard.js";
import { assertDeploymentProfileStartupSafety } from "./deployment-profile-guard.js";
import { isSuspiciousEncodedPath } from "./path-guard.js";
import { enterDevDiagnosticsContext } from "./dev-diagnostics/service.js";

loadLocalEnvFile();

const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BROWSER_MUTATION_INTENT_HEADER = "x-goatcitadel-browser-intent";
const BROWSER_MUTATION_INTENT_VALUE = "mutation";

export async function buildApp() {
  const verbose = isVerboseLoggingEnabled();
  const app = Fastify({
    loggerInstance: createGatewayLogger(verbose),
    disableRequestLogging: !verbose,
  });
  const allowedOrigins = resolveAllowedOrigins();
  const allowTailnetDevOrigins = resolveAllowTailnetDevOrigins();
  const tailnetShortHostAllowlist = resolveTailnetShortHostAllowlist();
  const rateLimitConfig = resolveRateLimitConfig();

  /**
   * CORS origin validation — three-tier allowlist:
   *
   * 1. **Explicit origins** (`GOATCITADEL_ALLOWED_ORIGINS` env var or defaults):
   *    Always accepted. Defaults include localhost:5173 (dev), localhost:4173 (preview),
   *    and 127.0.0.1:8787 (gateway self-reference).
   *
   * 2. **Loopback dev origins** (non-production only):
   *    Any origin resolving to 127.0.0.1/::1 on any port is accepted in
   *    non-production environments, enabling local dev tooling on arbitrary ports.
   *
   * 3. **Tailnet dev origins** (opt-in via `GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS`):
   *    Origins matching Tailscale `.ts.net` patterns are accepted when enabled,
   *    allowing access from other devices on the same tailnet. Enabled by default
   *    in non-production environments.
   *
   * Requests with no `Origin` header (e.g., server-to-server, curl) are always accepted.
   */
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.has(origin)) {
        cb(null, true);
        return;
      }
      if (process.env.NODE_ENV !== "production" && isLoopbackDevOrigin(origin)) {
        cb(null, true);
        return;
      }
      if (allowTailnetDevOrigins && isTailnetDevOrigin(origin, tailnetShortHostAllowlist)) {
        cb(null, true);
        return;
      }
      cb(new Error("Origin not allowed by CORS policy"), false);
    },
  });

  const isNonLoopbackBind = !["127.0.0.1", "::1", "localhost"].includes(process.env.GATEWAY_HOST ?? "127.0.0.1");

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-XSS-Protection", "0");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (isNonLoopbackBind) {
      reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = readRequestHeader(request.headers["x-goatcitadel-correlation-id"]) ?? randomUUID();
    const traceId = readTraceId(request.headers.traceparent, correlationId);
    const originSurface = readRequestHeader(request.headers["x-goatcitadel-origin-surface"]);
    const sessionId = readRequestHeader(request.headers["x-goatcitadel-session-id"]);
    const browserOrigin = readRequestHeader(request.headers.origin);
    const browserIntent = readRequestHeader(request.headers[BROWSER_MUTATION_INTENT_HEADER]);
    (
      request as typeof request & {
        correlationId?: string;
        traceId?: string;
        originSurface?: string;
        requestSessionId?: string;
      }
    ).correlationId = correlationId;
    (
      request as typeof request & {
        correlationId?: string;
        traceId?: string;
        originSurface?: string;
        requestSessionId?: string;
      }
    ).traceId = traceId;
    (
      request as typeof request & {
        correlationId?: string;
        traceId?: string;
        originSurface?: string;
        requestSessionId?: string;
      }
    ).originSurface = originSurface;
    (
      request as typeof request & {
        correlationId?: string;
        traceId?: string;
        originSurface?: string;
        requestSessionId?: string;
      }
    ).requestSessionId = sessionId;
    reply.header("x-goatcitadel-correlation-id", correlationId);
    enterRequestAttribution({
      correlationId,
      traceId,
      originSurface,
    });
    enterDevDiagnosticsContext({
      correlationId,
      route: request.routeOptions.url || request.url,
      sessionId,
    });
    app.gateway?.recordDevDiagnostic({
      level: "debug",
      category: "api",
      event: "request.start",
      message: `${request.method} ${request.url}`,
      route: request.routeOptions.url || request.url,
      sessionId,
      context: {
        method: request.method,
        url: request.url,
        originSurface,
      },
    });
    const rawUrl = request.raw.url ?? request.url;
    if (isSuspiciousEncodedPath(rawUrl)) {
      return reply.code(400).send({
        error: "Rejected request path due to suspicious encoded path segments.",
      });
    }
    if (
      MUTATING_HTTP_METHODS.has(request.method.toUpperCase()) &&
      browserOrigin &&
      browserIntent !== BROWSER_MUTATION_INTENT_VALUE
    ) {
      return reply.code(400).send({
        error: `Missing ${BROWSER_MUTATION_INTENT_HEADER}: ${BROWSER_MUTATION_INTENT_VALUE} for browser-origin mutating request.`,
      });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    app.gateway?.recordDevDiagnostic({
      level: reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "debug",
      category: "api",
      event: "request.finish",
      message: `${request.method} ${request.url} -> ${reply.statusCode}`,
      route: request.routeOptions.url || request.url,
      sessionId: (request as typeof request & { requestSessionId?: string }).requestSessionId,
      context: {
        statusCode: reply.statusCode,
        method: request.method,
      },
    });
  });

  app.addHook("onError", async (request, reply, error) => {
    app.gateway?.recordDevDiagnostic({
      level: "error",
      category: "api",
      event: "request.error",
      message: `${request.method} ${request.url} failed`,
      route: request.routeOptions.url || request.url,
      sessionId: (request as typeof request & { requestSessionId?: string }).requestSessionId,
      context: {
        statusCode: reply.statusCode,
        error: error.message,
      },
    });
  });

  if (rateLimitConfig.enabled) {
    await app.register(rateLimit, {
      global: false,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
      allowList: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
      max: rateLimitConfig.maxGeneral,
      skipOnError: true,
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
      },
    });

    app.addHook("onRoute", (routeOptions) => {
      const bucket = classifyRateLimitBucket(routeOptions.url, routeOptions.method);
      const max =
        bucket === "auth"
          ? rateLimitConfig.maxAuth
          : bucket === "mutation"
            ? rateLimitConfig.maxMutation
            : bucket === "sse"
              ? rateLimitConfig.maxSseConnect
              : rateLimitConfig.maxGeneral;
      const currentConfig = (routeOptions.config ?? {}) as Record<string, unknown>;
      const currentRateLimit = isRecord(currentConfig.rateLimit) ? currentConfig.rateLimit : {};
      const existingMax = typeof currentRateLimit.max === "number" ? currentRateLimit.max : undefined;
      routeOptions.config = {
        ...currentConfig,
        rateLimit: {
          ...currentRateLimit,
          max: existingMax === undefined ? max : Math.min(existingMax, max),
        },
      };
    });
  }

  await app.register(gatewayPlugin);
  assertDeploymentProfileStartupSafety(app.gatewayConfig, allowedOrigins);
  await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin);

  await app.register(healthRoute);
  await app.register(authRoutes);
  await app.register(secretsRoutes);
  await app.register(gatewayEventsRoute);
  await app.register(sessionsListRoute);
  await app.register(toolsInvokeRoute);
  await app.register(approvalsRoutes);
  await app.register(costsRoutes);
  await app.register(skillsRoutes);
  await app.register(orchestrationRoutes);
  await app.register(assemblyRoutes);
  await app.register(tasksRoutes);
  await app.register(eventsRoutes);
  await app.register(dashboardRoutes);
  await app.register(capabilitiesRoutes);
  await app.register(filesRoutes);
  await app.register(llmRoutes);
  await app.register(llamaCppRoutes);
  await app.register(integrationsRoutes);
  await app.register(integrationWebhookRoutes);
  await app.register(meshRoutes);
  await app.register(onboardingRoutes);
  await app.register(memoryRoutes);
  await app.register(npuRoutes);
  await app.register(uiChangeRiskRoutes);
  await app.register(agentsRoutes);
  await app.register(toolsRoutes);
  await app.register(commsRoutes);
  await app.register(knowledgeRoutes);
  await app.register(chatRoutes);
  await app.register(promptPackRoutes);
  await app.register(mcpRoutes);
  await app.register(voiceRoutes);
  await app.register(mediaRoutes);
  await app.register(daemonRoutes);
  await app.register(improvementRoutes);
  await app.register(workspacesRoutes);
  await app.register(hooksRoutes);
  await app.register(durableRoutes);
  await app.register(connectorsRoutes);
  await app.register(addonsRoutes);
  await app.register(adminRoutes);
  await app.register(docsRoutes);
  await app.register(devDiagnosticsRoutes);
  await app.register(devVerificationRoutes);

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRequestHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => item.trim().length > 0);
    return first?.trim();
  }
  return undefined;
}

function readTraceId(traceparent: string | string[] | undefined, fallbackCorrelationId: string): string {
  const rawTraceparent = readRequestHeader(traceparent);
  if (rawTraceparent) {
    const parts = rawTraceparent.split("-");
    if (parts.length >= 4 && parts[1]?.trim()) {
      return parts[1].trim();
    }
  }
  return fallbackCorrelationId;
}

function resolveAllowedOrigins(): Set<string> {
  const defaults = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://127.0.0.1:8787",
  ];
  const envRaw = process.env.GOATCITADEL_ALLOWED_ORIGINS;
  if (!envRaw?.trim()) {
    return new Set(defaults);
  }
  const fromEnv = envRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(fromEnv.length > 0 ? fromEnv : defaults);
}

function resolveRateLimitConfig(): {
  enabled: boolean;
  maxGeneral: number;
  maxMutation: number;
  maxAuth: number;
  maxSseConnect: number;
} {
  const enabledRaw = process.env.GOATCITADEL_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  const enabled = enabledRaw === undefined ? true : enabledRaw === "1" || enabledRaw === "true";
  return {
    enabled,
    maxGeneral: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_GENERAL, 500),
    maxMutation: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_MUTATION, 180),
    maxAuth: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_AUTH, 60),
    maxSseConnect: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT, 45),
  };
}

function classifyRateLimitBucket(url: string, method: string | string[]): "general" | "mutation" | "auth" | "sse" {
  const normalizedUrl = url.toLowerCase();
  const normalizedMethod = Array.isArray(method) ? (method[0]?.toUpperCase() ?? "GET") : method.toUpperCase();
  if (normalizedUrl.includes("/events/stream")) {
    return "sse";
  }
  if (normalizedUrl.startsWith("/api/v1/auth") || normalizedUrl.startsWith("/api/v1/secrets")) {
    return "auth";
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") {
    return "general";
  }
  return "mutation";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveAllowTailnetDevOrigins(): boolean {
  const raw = process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS?.trim().toLowerCase();
  if (!raw) {
    return process.env.NODE_ENV !== "production";
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
