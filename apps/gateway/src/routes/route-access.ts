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
  { prefix: "/api/v1/approvals/remote-resolve", accessClass: "public" },
  { prefix: "/api/v1/events/stream", accessClass: "sse-read" },
  { prefix: "/api/v1/events", accessClass: "authenticated-read" },
  { prefix: "/api/v1/llm", accessClass: "operator" },
  { prefix: "/api/v1/tools", accessClass: "operator" },
  { prefix: "/api/v1/mcp", accessClass: "operator" },
  { prefix: "/api/v1/addons", accessClass: "operator" },
  { prefix: "/api/v1/capability-packs", accessClass: "operator" },
  { prefix: "/api/v1/evidence", accessClass: "operator" },
  { prefix: "/api/v1/capabilities", accessClass: "operator" },
  { prefix: "/api/v1/code-mode", accessClass: "operator" },
  { prefix: "/api/v1/dev/diagnostics/stream", accessClass: "sse-read" },
  { prefix: "/api/v1/dev", accessClass: "operator" },
  { prefix: "/api/v1/channels/:channel/inbound", accessClass: "webhook" },
  { prefix: "/api/v1/integrations/slack/oauth/callback", accessClass: "public" },
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
    const accessClass =
      routeOptions.config?.goatcitadelRouteAccessClass ?? resolveRouteAccessClassForRouteUrl(routeOptions.url);
    for (const method of methods) {
      fastify.routeAccessManifest.push({
        method: method.toUpperCase(),
        url: routeOptions.url,
        accessClass,
        tracked: requiresTrackedRouteAccessClass(routeOptions.url),
      });
    }
  });
}

export function listMissingTrackedRouteAccessClasses(fastify: FastifyInstance): RouteAccessManifestEntry[] {
  return fastify.routeAccessManifest.filter(
    (entry) => entry.tracked && entry.method !== "HEAD" && entry.method !== "OPTIONS" && !entry.accessClass,
  );
}

function requiresTrackedRouteAccessClass(url: string): boolean {
  return TRACKED_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function resolveRouteAccessClass(
  declaredAccessClass: RouteAccessClass | undefined,
  request: FastifyRequest,
): RouteAccessClass | undefined {
  return declaredAccessClass ?? resolveRouteAccessClassForRouteUrl(request.routeOptions.url || request.url);
}

function resolveRouteAccessClassForRouteUrl(url: string): RouteAccessClass | undefined {
  if (!requiresTrackedRouteAccessClass(url)) {
    return undefined;
  }
  const policy = ROUTE_ACCESS_POLICIES.find((item) => url.startsWith(item.prefix));
  return policy?.accessClass ?? DEFAULT_API_ROUTE_ACCESS_CLASS;
}
