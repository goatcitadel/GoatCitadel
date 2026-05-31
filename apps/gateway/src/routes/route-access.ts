import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
  RouteShorthandOptions,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from "fastify";

export type RouteAccessClass =
  | "public"
  | "authenticated-read"
  | "operator"
  | "loopback"
  | "device"
  | "companion"
  | "sse-read"
  | "webhook";

type RoutePreHandler =
  | preHandlerHookHandler
  | preHandlerAsyncHookHandler
  | Array<preHandlerHookHandler | preHandlerAsyncHookHandler>;

export interface RouteAccessManifestEntry {
  method: string;
  url: string;
  accessClass?: RouteAccessClass;
  classificationSource?: "explicit" | "policy" | "default";
  tracked: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    goatcitadelRouteAccessClass?: RouteAccessClass;
  }

  interface FastifyInstance {
    routeAccessManifest: RouteAccessManifestEntry[];
  }
}

const TRACKED_ROUTE_PREFIXES = ["/api/v1"] as const;

const DEFAULT_API_ROUTE_ACCESS_CLASS: RouteAccessClass = "operator";

const ROUTE_ACCESS_POLICIES: Array<{ prefix: string; accessClass: RouteAccessClass }> = [
  { prefix: "/api/v1/auth/device-requests", accessClass: "public" },
  { prefix: "/api/v1/auth/companion/session/refresh", accessClass: "public" },
  { prefix: "/api/v1/auth/settings", accessClass: "operator" },
  { prefix: "/api/v1/approvals/remote-resolve", accessClass: "public" },
  { prefix: "/api/v1/events/stream", accessClass: "sse-read" },
  { prefix: "/api/v1/events", accessClass: "authenticated-read" },
  { prefix: "/api/v1/a2a", accessClass: "operator" },
  { prefix: "/api/v1/agentic", accessClass: "operator" },
  { prefix: "/api/v1/gateway", accessClass: "operator" },
  { prefix: "/api/v1/runtime", accessClass: "operator" },
  { prefix: "/api/v1/system", accessClass: "operator" },
  { prefix: "/api/v1/observe", accessClass: "operator" },
  { prefix: "/api/v1/ops", accessClass: "operator" },
  { prefix: "/api/v1/secrets", accessClass: "operator" },
  { prefix: "/api/v1/sessions", accessClass: "operator" },
  { prefix: "/api/v1/chat", accessClass: "operator" },
  { prefix: "/api/v1/llm", accessClass: "operator" },
  { prefix: "/api/v1/llamacpp", accessClass: "operator" },
  { prefix: "/api/v1/tools", accessClass: "operator" },
  { prefix: "/api/v1/mcp", accessClass: "operator" },
  { prefix: "/api/v1/addons", accessClass: "operator" },
  { prefix: "/api/v1/capability-packs", accessClass: "operator" },
  { prefix: "/api/v1/evidence", accessClass: "operator" },
  { prefix: "/api/v1/capabilities", accessClass: "operator" },
  { prefix: "/api/v1/code-mode", accessClass: "operator" },
  { prefix: "/api/v1/costs", accessClass: "operator" },
  { prefix: "/api/v1/cron", accessClass: "operator" },
  { prefix: "/api/v1/dashboard", accessClass: "operator" },
  { prefix: "/api/v1/skills", accessClass: "operator" },
  { prefix: "/api/v1/orchestration", accessClass: "operator" },
  { prefix: "/api/v1/operators", accessClass: "operator" },
  { prefix: "/api/v1/assembly", accessClass: "operator" },
  { prefix: "/api/v1/tasks", accessClass: "operator" },
  { prefix: "/api/v1/files", accessClass: "operator" },
  { prefix: "/api/v1/memory", accessClass: "operator" },
  { prefix: "/api/v1/mesh", accessClass: "operator" },
  { prefix: "/api/v1/mobile", accessClass: "operator" },
  { prefix: "/api/v1/onboarding", accessClass: "operator" },
  { prefix: "/api/v1/demo", accessClass: "operator" },
  { prefix: "/api/v1/npu", accessClass: "operator" },
  { prefix: "/api/v1/ui/change-risk", accessClass: "operator" },
  { prefix: "/api/v1/ui-change-risk", accessClass: "operator" },
  { prefix: "/api/v1/agents", accessClass: "operator" },
  { prefix: "/api/v1/subagents", accessClass: "operator" },
  { prefix: "/api/v1/comms", accessClass: "operator" },
  { prefix: "/api/v1/knowledge", accessClass: "operator" },
  { prefix: "/api/v1/prompt-packs", accessClass: "operator" },
  { prefix: "/api/v1/replay", accessClass: "operator" },
  { prefix: "/api/v1/admin", accessClass: "operator" },
  { prefix: "/api/v1/docs", accessClass: "operator" },
  { prefix: "/api/v1/voice", accessClass: "operator" },
  { prefix: "/api/v1/media", accessClass: "operator" },
  { prefix: "/api/v1/daemon", accessClass: "operator" },
  { prefix: "/api/v1/curator", accessClass: "operator" },
  { prefix: "/api/v1/improvement", accessClass: "operator" },
  { prefix: "/api/v1/research", accessClass: "operator" },
  { prefix: "/api/v1/update-scout", accessClass: "operator" },
  { prefix: "/api/v1/workspaces", accessClass: "operator" },
  { prefix: "/api/v1/hooks", accessClass: "operator" },
  { prefix: "/api/v1/durable", accessClass: "operator" },
  { prefix: "/api/v1/connectors", accessClass: "operator" },
  { prefix: "/api/v1/settings", accessClass: "operator" },
  { prefix: "/api/v1/personalities", accessClass: "operator" },
  { prefix: "/api/v1/channels", accessClass: "operator" },
  { prefix: "/api/v1/guidance", accessClass: "operator" },
  { prefix: "/api/v1/dev/diagnostics/stream", accessClass: "sse-read" },
  { prefix: "/api/v1/dev", accessClass: "operator" },
  { prefix: "/api/v1/integrations/slack/oauth/callback", accessClass: "public" },
  { prefix: "/api/v1/integrations/connections/:connectionId/:channel/inbound", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/connections/:connectionId/telegram/webhook", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/connections/:connectionId/whatsapp/webhook", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/connections/:connectionId/slack/webhook", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/connections/:connectionId/line/webhook", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/connections/:connectionId/nextcloud-talk/webhook", accessClass: "webhook" },
  { prefix: "/api/v1/integrations", accessClass: "operator" },
];

export function withRouteAccess(
  fastify: FastifyInstance,
  accessClass: RouteAccessClass,
  options: RouteShorthandOptions = {},
): RouteShorthandOptions {
  return {
    ...options,
    config: {
      ...(options.config ?? {}),
      goatcitadelRouteAccessClass: accessClass,
    },
    preHandler: mergePreHandlers(resolveAccessPreHandler(fastify, accessClass), options.preHandler),
  };
}

function resolveAccessPreHandler(fastify: FastifyInstance, accessClass: RouteAccessClass): RoutePreHandler | undefined {
  const enforce = async (request: FastifyRequest, reply: FastifyReply) =>
    enforceRouteAccessClass(fastify, request, reply, accessClass);
  switch (accessClass) {
    case "authenticated-read":
    case "operator":
    case "loopback":
    case "device":
    case "companion":
    case "sse-read":
      return enforce;
    case "public":
    case "webhook":
    default:
      return undefined;
  }
}

async function enforceRouteAccessClass(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  accessClass: RouteAccessClass,
): Promise<void | ReturnType<FastifyReply["send"]>> {
  switch (accessClass) {
    case "authenticated-read":
      return requireAuthenticatedAccess(fastify, request, reply, accessClass);
    case "operator":
      if (!hasOperatorAuthHandler(fastify)) {
        return reply.code(500).send({
          error: "Operator authentication is not installed for this route.",
        });
      }
      return fastify.requireOperatorAuth(request, reply);
    case "loopback":
      return requireAuthActorSource(request, reply, "loopback", accessClass);
    case "device":
      return requireAuthActorSource(request, reply, "device", accessClass);
    case "companion":
      return requireAuthActorSource(request, reply, "companion", accessClass);
    case "sse-read": {
      const authMode = resolveConfiguredAuthMode(fastify);
      if (!authMode || authMode === "none") {
        return;
      }
      if (request.authActorSource === "companion" && request.authCompanionSessionId) {
        return;
      }
      const allowedSources = new Set(["sse", "token", "basic", "loopback"]);
      if (allowedSources.has(request.authActorSource)) {
        return;
      }
      return reply.code(403).send({
        error: "SSE bridge or operator authentication is required for this route.",
      });
    }
    case "public":
    case "webhook":
    default:
      return;
  }
}

function requireAuthenticatedAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  accessClass: RouteAccessClass,
): void | ReturnType<FastifyReply["send"]> {
  const authMode = resolveConfiguredAuthMode(fastify);
  if (!authMode || authMode === "none") {
    return;
  }
  if (request.authActorSource !== "none") {
    return;
  }
  return reply.code(403).send({
    error: `Authenticated access is required for ${accessClass} routes.`,
  });
}

function resolveConfiguredAuthMode(fastify: FastifyInstance): "none" | "token" | "basic" | undefined {
  return (
    fastify as unknown as {
      gatewayConfig?: {
        assistant?: {
          auth?: {
            mode?: "none" | "token" | "basic";
          };
        };
      };
    }
  ).gatewayConfig?.assistant?.auth?.mode;
}

function hasOperatorAuthHandler(fastify: FastifyInstance): fastify is FastifyInstance & {
  requireOperatorAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void | ReturnType<FastifyReply["send"]>>;
} {
  return typeof (fastify as unknown as { requireOperatorAuth?: unknown }).requireOperatorAuth === "function";
}

function requireAuthActorSource(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedSource: FastifyRequest["authActorSource"],
  accessClass: RouteAccessClass,
): void | ReturnType<FastifyReply["send"]> {
  if (request.authActorSource === expectedSource) {
    return;
  }
  return reply.code(403).send({
    error: `Auth source ${expectedSource} is required for ${accessClass} routes.`,
  });
}

function mergePreHandlers(
  left: RoutePreHandler | undefined,
  right: RouteShorthandOptions["preHandler"],
): RoutePreHandler | undefined {
  const merged = [...normalizePreHandlers(left), ...normalizePreHandlers(right as RoutePreHandler | undefined)];
  if (merged.length === 0) {
    return undefined;
  }
  if (merged.length === 1) {
    return merged[0];
  }
  return merged;
}

function normalizePreHandlers(
  value: RoutePreHandler | undefined,
): Array<preHandlerHookHandler | preHandlerAsyncHookHandler> {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function installRouteAccessTracking(fastify: FastifyInstance): void {
  if (!Object.prototype.hasOwnProperty.call(fastify, "routeAccessManifest")) {
    fastify.decorate("routeAccessManifest", []);
  }

  fastify.addHook("preHandler", async (request, reply) => {
    const accessClass = resolveRouteAccessClass(request.routeOptions.config?.goatcitadelRouteAccessClass, request);
    if (!accessClass) {
      return;
    }
    return enforceRouteAccessClass(fastify, request, reply, accessClass);
  });

  fastify.addHook("onRoute", (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const classification = resolveRouteAccessClassification(
      routeOptions.url,
      routeOptions.config?.goatcitadelRouteAccessClass,
    );
    for (const method of methods) {
      fastify.routeAccessManifest.push({
        method: method.toUpperCase(),
        url: routeOptions.url,
        accessClass: classification.accessClass,
        classificationSource: classification.source,
        tracked: requiresTrackedRouteAccessClass(routeOptions.url),
      });
    }
  });
}

export function listMissingTrackedRouteAccessClasses(fastify: FastifyInstance): RouteAccessManifestEntry[] {
  return fastify.routeAccessManifest.filter(
    (entry) =>
      entry.tracked &&
      entry.method !== "HEAD" &&
      entry.method !== "OPTIONS" &&
      (!entry.accessClass || entry.classificationSource === "default"),
  );
}

function requiresTrackedRouteAccessClass(url: string): boolean {
  return TRACKED_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function resolveRouteAccessClass(
  declaredAccessClass: RouteAccessClass | undefined,
  request: FastifyRequest,
): RouteAccessClass | undefined {
  return resolveRouteAccessClassification(request.routeOptions.url || request.url, declaredAccessClass).accessClass;
}

function resolveRouteAccessClassification(
  url: string,
  declaredAccessClass?: RouteAccessClass,
): { accessClass?: RouteAccessClass; source?: RouteAccessManifestEntry["classificationSource"] } {
  if (declaredAccessClass) {
    return { accessClass: declaredAccessClass, source: "explicit" };
  }
  if (!requiresTrackedRouteAccessClass(url)) {
    return {};
  }
  const policy = ROUTE_ACCESS_POLICIES.find((item) => url.startsWith(item.prefix));
  return policy
    ? { accessClass: policy.accessClass, source: "policy" }
    : { accessClass: DEFAULT_API_ROUTE_ACCESS_CLASS, source: "default" };
}
