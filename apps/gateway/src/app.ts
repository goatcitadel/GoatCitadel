import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { enterRequestAttribution } from "@goatcitadel/storage";
import { loadLocalEnvFile } from "./env-file.js";
import { gatewayPlugin } from "./plugins/storage.js";
import { routeServicesPlugin } from "./plugins/route-services.js";
import { createAppSharedHostLifecycle, sharedHostLifecyclePlugin } from "./plugins/shared-host-lifecycle.js";
import { authPlugin } from "./plugins/auth.js";
import { idempotencyHeaderPlugin } from "./plugins/idempotency.js";
import { healthRoute } from "./routes/health.js";
import { sharedHostLifecycleRoutes } from "./routes/shared-host-lifecycle.js";
import { livezRoute } from "./routes/livez.js";
import { gatewayEventsRoute } from "./routes/gateway-events.js";
import { sessionsListRoute } from "./routes/sessions-list.js";
import { toolsInvokeRoute } from "./routes/tools-invoke.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { capabilityScopeRoutes } from "./routes/capability-scope-routes.js";
import { citadelsRoutes } from "./routes/citadels.js";
import { complianceRoutes } from "./routes/compliance.js";
import { costsRoutes } from "./routes/costs.js";
import { browserSessionsRoutes } from "./routes/browser-sessions.js";
import { reviewReadinessRoutes } from "./routes/review-readiness.js";
import { runtimeAuthorityRoutes } from "./routes/runtime-authority.js";
import { skillsRoutes } from "./routes/skills.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { assemblyRoutes } from "./routes/assembly.js";
import { tasksRoutes } from "./routes/tasks.js";
import { eventsRoutes } from "./routes/events.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { filesRoutes } from "./routes/files.js";
import { llmRoutes } from "./routes/llm.js";
import { turnsRoutes } from "./routes/turns.js";
import { localAiRoutes } from "./routes/local-ai.js";
import { llamaCppRoutes } from "./routes/llamacpp.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { integrationWebhookRoutes } from "./routes/integration-webhooks.js";
import { meshRoutes } from "./routes/mesh.js";
import { meshCapabilityRoutes } from "./routes/mesh-capabilities.js";
import { mobileRoutes } from "./routes/mobile.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { demoRoutes } from "./routes/demo.js";
import { memoryRoutes } from "./routes/memory.js";
import { journeyRoutes } from "./routes/journey.js";
import { npuRoutes } from "./routes/npu.js";
import { uiChangeRiskRoutes } from "./routes/ui-change-risk.js";
import { agentsRoutes } from "./routes/agents.js";
import { toolsRoutes } from "./routes/tools.js";
import { commsRoutes } from "./routes/comms.js";
import { communicationsRoutes } from "./routes/communications.js";
import { personalOpsRoutes } from "./routes/personal-ops.js";
import { opsSavedBoardRoutes } from "./routes/ops-boards.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { authRoutes } from "./routes/auth.js";
import { secretsRoutes } from "./routes/secrets.js";
import { chatRoutes } from "./routes/chat.js";
import { promptPackRoutes } from "./routes/prompt-packs.js";
import { modelComparisonRoutes } from "./routes/model-comparisons.js";
import { adminRoutes } from "./routes/admin.js";
import { autonomyControlRoutes } from "./routes/autonomy-control.js";
import { docsRoutes } from "./routes/docs.js";
import { devDiagnosticsRoutes } from "./routes/dev-diagnostics.js";
import { devVerificationRoutes } from "./routes/dev-verification.js";
import { mcpRoutes } from "./routes/mcp.js";
import { addonsRoutes } from "./routes/addons.js";
import { capabilityPacksRoutes } from "./routes/capability-packs.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { evidenceReceiptsRoutes } from "./routes/evidence-receipts.js";
import { voiceRoutes } from "./routes/voice.js";
import { mediaRoutes } from "./routes/media.js";
import { daemonRoutes } from "./routes/daemon.js";
import { curatorRoutes } from "./routes/curator.js";
import { improvementRoutes } from "./routes/improvement.js";
import { researchSearchRoutes } from "./routes/research-search.js";
import { remoteWorkersRoutes } from "./routes/remote-workers.js";
import { updateScoutRoutes } from "./routes/update-scout.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { workspacePathBridgeRoutes } from "./routes/workspace-path-bridge.js";
import { externalSourceRoutes } from "./routes/external-sources.js";
import { hooksRoutes } from "./routes/hooks.js";
import { durableRoutes } from "./routes/durable.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { trustRoutes } from "./routes/trust.js";
import { surfaceRoutes } from "./routes/surface.js";
import { createGatewayLogger, isVerboseLoggingEnabled } from "./runtime-ux.js";
import { isLoopbackDevOrigin, isTailnetDevOrigin, resolveTailnetShortHostAllowlist } from "./cors-origin-guard.js";
import { projectPublicErrorValue } from "./services/public-secret-projection.js";
import { assertDeploymentProfileStartupSafety } from "./deployment-profile-guard.js";
import { assertAuthTokenIsNotPlaceholder } from "./startup-guard.js";
import { isSuspiciousEncodedPath } from "./path-guard.js";
import { installEmptyBodyTolerantJsonParser } from "./empty-json-body-parser.js";
import { enterDevDiagnosticsContext } from "./dev-diagnostics/service.js";
import { installRouteAccessTracking } from "./routes/route-access.js";
import { isLoopbackRateLimitAllowlisted, resolveWebhookRateLimitConfig } from "./services/webhook-rate-limit.js";

loadLocalEnvFile();

const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BROWSER_MUTATION_INTENT_HEADER = "x-goatcitadel-browser-intent";
const BROWSER_MUTATION_INTENT_VALUE = "mutation";
const DEFAULT_FASTIFY_PLUGIN_TIMEOUT_MS = 120_000;

/**
 * Baseline Content-Security-Policy applied to responses that do not set their
 * own. It permits same-origin scripts so the Mission Control SPA can boot.
 *
 * Routes that serve user/file content (e.g. `/api/v1/files/preview`,
 * chat attachments) deliberately set a stricter, sandboxed CSP — most notably
 * `script-src 'none'` — to neutralize active content. Those route-set policies
 * MUST survive: see `applyBaselineSecurityHeaders`, which only installs this
 * baseline when no CSP is already present on the reply.
 */
const BASELINE_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

interface GatewayRequestState {
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  requestSessionId?: string;
  requestStartedAtMs?: number;
}

export async function buildApp() {
  const verbose = isVerboseLoggingEnabled();
  const app = Fastify({
    loggerInstance: createGatewayLogger(verbose),
    disableRequestLogging: !verbose,
    // Startup can legitimately spend tens of seconds waiting for bundled
    // Postgres recovery after an unclean Windows restart. Keep Fastify from
    // aborting the storage plugin before recovery finishes.
    pluginTimeout: resolveFastifyPluginTimeoutMs(),
  });
  const sharedHostLifecycle = createAppSharedHostLifecycle(app);
  try {
    // Lifecycle ownership exists before any runtime/plugin can schedule work.
    // Admission remains closed in `starting` until every route/runtime owner is
    // wired and accepting evidence has persisted below.
    await app.register(sharedHostLifecyclePlugin, {
      lifecycle: sharedHostLifecycle,
      activateImmediately: false,
    });
    installEmptyBodyTolerantJsonParser(app);
    const allowedOrigins = resolveAllowedOrigins();
    const allowTailnetDevOrigins = resolveAllowTailnetDevOrigins();
    const tailnetShortHostAllowlist = resolveTailnetShortHostAllowlist();
    const rateLimitConfig = resolveRateLimitConfig();

    installRouteAccessTracking(app);

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
     * 3. **Tailnet/private dev origins** (opt-in via `GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS`):
     *    Origins matching Tailscale `.ts.net` patterns are accepted when enabled,
     *    allowing access from other devices on the same tailnet or private network.
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

    app.addHook("preSerialization", async (_request, reply, payload) => {
      return reply.statusCode >= 400 ? projectPublicErrorValue(payload) : payload;
    });

    app.addHook("onSend", async (_request, reply) => {
      applyBaselineSecurityHeaders(reply, { isNonLoopbackBind });
    });

    app.addHook("onRequest", async (request, reply) => {
      const requestState = request as typeof request & GatewayRequestState;
      const correlationId = readRequestHeader(request.headers["x-goatcitadel-correlation-id"]) ?? randomUUID();
      const traceId = readTraceId(request.headers.traceparent, correlationId);
      const originSurface = readRequestHeader(request.headers["x-goatcitadel-origin-surface"]);
      const sessionId = readRequestHeader(request.headers["x-goatcitadel-session-id"]);
      const browserOrigin = readRequestHeader(request.headers.origin);
      const browserIntent = readRequestHeader(request.headers[BROWSER_MUTATION_INTENT_HEADER]);
      requestState.correlationId = correlationId;
      requestState.traceId = traceId;
      requestState.originSurface = originSurface;
      requestState.requestSessionId = sessionId;
      requestState.requestStartedAtMs = performance.now();
      reply.header("x-goatcitadel-correlation-id", correlationId);
      const diagnosticRequestUrl = stripDiagnosticUrlQuery(request.url);
      const diagnosticRoute = request.routeOptions.url || diagnosticRequestUrl;
      enterRequestAttribution({
        correlationId,
        traceId,
        originSurface,
      });
      enterDevDiagnosticsContext({
        correlationId,
        route: diagnosticRoute,
        sessionId,
      });
      app.gatewayRuntime?.recordDevDiagnostic({
        level: "debug",
        category: "api",
        event: "request.start",
        message: `${request.method} ${diagnosticRoute}`,
        route: diagnosticRoute,
        correlationId,
        sessionId,
        context: {
          method: request.method,
          url: diagnosticRequestUrl,
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
      const requestState = request as typeof request & GatewayRequestState;
      const durationMs = calculateRequestDurationMs(requestState);
      const diagnosticRoute = stripDiagnosticUrlQuery(request.routeOptions.url || request.url);
      app.gatewayRuntime?.recordDevDiagnostic({
        level: reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "debug",
        category: "api",
        event: "request.finish",
        message: `${request.method} ${diagnosticRoute} -> ${reply.statusCode}`,
        route: diagnosticRoute,
        correlationId: requestState.correlationId,
        sessionId: requestState.requestSessionId,
        durationMs,
        context: {
          statusCode: reply.statusCode,
          method: request.method,
          durationMs,
        },
      });
    });

    app.addHook("onError", async (request, reply, error) => {
      const requestState = request as typeof request & GatewayRequestState;
      const durationMs = calculateRequestDurationMs(requestState);
      const diagnosticRoute = stripDiagnosticUrlQuery(request.routeOptions.url || request.url);
      app.gatewayRuntime?.recordDevDiagnostic({
        level: "error",
        category: "api",
        event: "request.error",
        message: `${request.method} ${diagnosticRoute} failed`,
        route: diagnosticRoute,
        correlationId: requestState.correlationId,
        sessionId: requestState.requestSessionId,
        durationMs,
        context: {
          statusCode: reply.statusCode,
          error: error.message,
          durationMs,
        },
      });
    });

    if (rateLimitConfig.enabled) {
      app.addHook("onRoute", (routeOptions) => {
        const bucket = classifyRateLimitBucket(routeOptions.url, routeOptions.method);
        const max =
          bucket === "auth"
            ? rateLimitConfig.maxAuth
            : bucket === "mutation"
              ? rateLimitConfig.maxMutation
              : bucket === "webhook_ingress"
                ? rateLimitConfig.maxWebhookIngress
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

      await app.register(rateLimit, {
        global: false,
        timeWindow: "1 minute",
        keyGenerator: (request) => request.ip,
        allowList: (request) => isLoopbackRateLimitAllowlisted(request.ip, request),
        max: rateLimitConfig.maxGeneral,
        skipOnError: true,
        addHeaders: {
          "x-ratelimit-limit": true,
          "x-ratelimit-remaining": true,
          "x-ratelimit-reset": true,
        },
      });
    }

    await app.register(gatewayPlugin);
    await app.register(routeServicesPlugin);
    assertDeploymentProfileStartupSafety(app.gatewayConfig, allowedOrigins, {
      bindHost: process.env.GATEWAY_HOST ?? "127.0.0.1",
      tailnetDevOriginsEnabled: allowTailnetDevOrigins,
    });
    // SECURITY (codex finding #1): Refuse to boot in token mode with the
    // shipped placeholder token. Must run after the deployment profile
    // guard so deploys that legitimately use auth.mode=none (local_dev)
    // are not blocked.
    assertAuthTokenIsNotPlaceholder(app.gatewayConfig.assistant.auth);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: app.gatewayRuntime.mutationIdempotencyStore,
    });

    await app.register(healthRoute);
    await app.register(sharedHostLifecycleRoutes);
    await app.register(livezRoute);
    await app.register(authRoutes);
    await app.register(secretsRoutes);
    await app.register(gatewayEventsRoute);
    await app.register(sessionsListRoute);
    await app.register(toolsInvokeRoute);
    await app.register(approvalsRoutes);
    await app.register(capabilityScopeRoutes);
    await app.register(citadelsRoutes);
    await app.register(complianceRoutes);
    await app.register(costsRoutes);
    await app.register(browserSessionsRoutes);
    await app.register(reviewReadinessRoutes);
    await app.register(runtimeAuthorityRoutes);
    await app.register(skillsRoutes);
    await app.register(curatorRoutes);
    await app.register(orchestrationRoutes);
    await app.register(assemblyRoutes);
    await app.register(tasksRoutes);
    await app.register(eventsRoutes);
    await app.register(dashboardRoutes);
    await app.register(capabilitiesRoutes);
    await app.register(filesRoutes);
    await app.register(llmRoutes);
    await app.register(turnsRoutes);
    await app.register(localAiRoutes);
    await app.register(llamaCppRoutes);
    await app.register(integrationsRoutes);
    await app.register(integrationWebhookRoutes);
    await app.register(meshRoutes);
    // HX-408 M1: authenticated mesh capability publication surface. The
    // mesh-node access class fails closed without the composed owner, so the
    // guard keeps a miswired build from booting a dead surface.
    if (!app.services.meshCapabilityPublication) {
      throw new Error("Mesh capability publication service is not composed.");
    }
    await app.register(meshCapabilityRoutes);
    await app.register(mobileRoutes);
    await app.register(onboardingRoutes);
    await app.register(demoRoutes);
    await app.register(memoryRoutes);
    await app.register(journeyRoutes);
    await app.register(npuRoutes);
    await app.register(uiChangeRiskRoutes);
    await app.register(agentsRoutes);
    await app.register(toolsRoutes);
    await app.register(commsRoutes);
    await app.register(communicationsRoutes);
    await app.register(personalOpsRoutes);
    if (!app.services.opsSavedBoards) {
      throw new Error("Ops saved board route service is not composed.");
    }
    await app.register(opsSavedBoardRoutes, { service: app.services.opsSavedBoards });
    await app.register(knowledgeRoutes);
    await app.register(chatRoutes);
    await app.register(promptPackRoutes);
    await app.register(modelComparisonRoutes);
    await app.register(mcpRoutes);
    await app.register(voiceRoutes);
    await app.register(mediaRoutes);
    await app.register(daemonRoutes);
    await app.register(improvementRoutes);
    await app.register(researchSearchRoutes);
    await app.register(remoteWorkersRoutes);
    await app.register(updateScoutRoutes);
    await app.register(workspacesRoutes);
    // HX-407 C4: the external-source domain is part of the production route
    // surface (the proof-only environment gate is removed).
    if (!app.services.externalSources) {
      throw new Error("External source route service is not composed.");
    }
    await app.register(externalSourceRoutes, { service: app.services.externalSources });
    if (!app.services.workspacePathBridge) {
      throw new Error("Workspace path bridge route service is not composed.");
    }
    await app.register(workspacePathBridgeRoutes, { service: app.services.workspacePathBridge });
    await app.register(hooksRoutes);
    await app.register(durableRoutes);
    await app.register(connectorsRoutes);
    await app.register(trustRoutes);
    await app.register(surfaceRoutes);
    await app.register(addonsRoutes);
    await app.register(capabilityPacksRoutes);
    await app.register(evidenceRoutes);
    await app.register(evidenceReceiptsRoutes);
    await app.register(adminRoutes);
    await app.register(autonomyControlRoutes);
    await app.register(docsRoutes);
    await app.register(devDiagnosticsRoutes);
    await app.register(devVerificationRoutes);

    sharedHostLifecycle.markAccepting();
    await sharedHostLifecycle.flushSignals();
    return app;
  } catch (error) {
    // Fastify does not return a partially built app to the caller. Close it
    // here so lifecycle ownership and any critical-init storage handles are
    // released on every build failure.
    try {
      await app.close();
    } catch (cleanupError) {
      app.log.warn(cleanupError, "gateway build-failure cleanup failed");
    }
    throw error;
  }
}

/**
 * Minimal structural view of the Fastify reply used by the security-headers
 * hook. Captures only the header accessors so the baseline logic can be unit
 * tested with a lightweight fake.
 */
interface SecurityHeaderReply {
  getHeader(name: string): unknown;
  header(name: string, value: string): unknown;
}

/**
 * Applies the baseline security headers to a response. The baseline CSP is only
 * installed when the route has not already set its own `Content-Security-Policy`
 * — routes that serve user/file content set a stricter, sandboxed policy
 * (`script-src 'none'`) and must not be downgraded to the baseline
 * `script-src 'self'`. All other headers are unconditional.
 */
function applyBaselineSecurityHeaders(reply: SecurityHeaderReply, options: { isNonLoopbackBind: boolean }): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-XSS-Protection", "0");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!hasContentSecurityPolicy(reply)) {
    reply.header("Content-Security-Policy", BASELINE_CONTENT_SECURITY_POLICY);
  }
  if (options.isNonLoopbackBind) {
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

function hasContentSecurityPolicy(reply: SecurityHeaderReply): boolean {
  const existing = reply.getHeader("Content-Security-Policy");
  if (typeof existing === "string") {
    return existing.trim().length > 0;
  }
  return existing !== undefined && existing !== null;
}

function resolveFastifyPluginTimeoutMs(): number {
  const raw = process.env.GOATCITADEL_FASTIFY_PLUGIN_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_FASTIFY_PLUGIN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_FASTIFY_PLUGIN_TIMEOUT_MS;
  }
  return parsed;
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
    .filter(Boolean)
    .map((origin) => normalizeConfiguredOrigin(origin, "GOATCITADEL_ALLOWED_ORIGINS"));
  return new Set(fromEnv.length > 0 ? fromEnv : defaults);
}

function normalizeConfiguredOrigin(rawOrigin: string, envName: string): string {
  try {
    const origin = new URL(rawOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new Error("origin must use http or https");
    }
    if (
      origin.username ||
      origin.password ||
      (origin.pathname && origin.pathname !== "/") ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("origin must not include credentials, paths, query strings, or fragments");
    }
    return origin.origin;
  } catch (error) {
    throw new Error(
      `Invalid origin in ${envName}: "${rawOrigin}". Use a full http(s) origin such as https://example.com.`,
      { cause: error },
    );
  }
}

function resolveRateLimitConfig(): {
  enabled: boolean;
  maxGeneral: number;
  maxMutation: number;
  maxAuth: number;
  maxSseConnect: number;
  maxWebhookIngress: number;
} {
  const enabledRaw = process.env.GOATCITADEL_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  const enabled = enabledRaw === undefined ? true : enabledRaw === "1" || enabledRaw === "true";
  const webhookRateLimit = resolveWebhookRateLimitConfig();
  return {
    enabled,
    maxGeneral: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_GENERAL, 500),
    maxMutation: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_MUTATION, 180),
    maxAuth: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_AUTH, 60),
    maxSseConnect: parsePositiveInt(process.env.GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT, 45),
    maxWebhookIngress: webhookRateLimit.maxIngress,
  };
}

function classifyRateLimitBucket(
  url: string,
  method: string | string[],
): "general" | "mutation" | "auth" | "sse" | "webhook_ingress" {
  const normalizedUrl = url.toLowerCase();
  const normalizedMethod = Array.isArray(method) ? (method[0]?.toUpperCase() ?? "GET") : method.toUpperCase();
  if (normalizedUrl.includes("/events/stream") || normalizedUrl.includes("/dev/diagnostics/stream")) {
    return "sse";
  }
  if (normalizedUrl.startsWith("/api/v1/auth") || normalizedUrl.startsWith("/api/v1/secrets")) {
    return "auth";
  }
  if (normalizedMethod === "POST" && isSignedInboundWebhookRoute(normalizedUrl)) {
    return "webhook_ingress";
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") {
    return "general";
  }
  return "mutation";
}

function isSignedInboundWebhookRoute(normalizedUrl: string): boolean {
  return /^\/api\/v1\/integrations\/connections\/[^/]+\/(?:[^/]+\/inbound|(?:slack|telegram|whatsapp|line|nextcloud-talk)\/webhook)$/u.test(
    normalizedUrl,
  );
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
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function calculateRequestDurationMs(request: GatewayRequestState): number | undefined {
  if (typeof request.requestStartedAtMs !== "number") {
    return undefined;
  }
  return Math.max(0, Math.round((performance.now() - request.requestStartedAtMs) * 1000) / 1000);
}

function stripDiagnosticUrlQuery(url: string | undefined): string {
  const value = (url ?? "").trim();
  if (!value) {
    return "/";
  }
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const candidates = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : value.length;
  return value.slice(0, end) || "/";
}

export const __internal = {
  isLoopbackRateLimitAllowlisted,
  normalizeConfiguredOrigin,
  resolveAllowedOrigins,
  classifyRateLimitBucket,
  applyBaselineSecurityHeaders,
  calculateRequestDurationMs,
  stripDiagnosticUrlQuery,
  BASELINE_CONTENT_SECURITY_POLICY,
};
