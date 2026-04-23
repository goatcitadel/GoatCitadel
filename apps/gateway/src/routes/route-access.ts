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

const TRACKED_ROUTE_PREFIXES = [
  "/api/v1/admin",
  "/api/v1/approvals",
  "/api/v1/auth",
  "/api/v1/durable",
  "/api/v1/events",
  "/api/v1/memory",
  "/api/v1/orchestration",
] as const;

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
  switch (accessClass) {
    case "authenticated-read":
      return async (request: FastifyRequest, reply: FastifyReply) =>
        requireAuthenticatedAccess(fastify, request, reply, accessClass);
    case "operator":
      return fastify.requireOperatorAuth;
    case "loopback":
      return async (request: FastifyRequest, reply: FastifyReply) =>
        requireAuthActorSource(request, reply, "loopback", accessClass);
    case "device":
      return async (request: FastifyRequest, reply: FastifyReply) =>
        requireAuthActorSource(request, reply, "device", accessClass);
    case "companion":
      return async (request: FastifyRequest, reply: FastifyReply) =>
        requireAuthActorSource(request, reply, "companion", accessClass);
    case "sse-read":
      return async (request: FastifyRequest, reply: FastifyReply) => {
        if (fastify.gatewayConfig.assistant.auth.mode === "none") {
          return;
        }
        const allowedSources = new Set(["sse", "token", "basic", "loopback"]);
        if (allowedSources.has(request.authActorSource)) {
          return;
        }
        return reply.code(403).send({
          error: "SSE bridge or operator authentication is required for this route.",
        });
      };
    case "public":
    case "webhook":
    default:
      return undefined;
  }
}

function requireAuthenticatedAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  accessClass: RouteAccessClass,
): void | ReturnType<FastifyReply["send"]> {
  if (fastify.gatewayConfig.assistant.auth.mode === "none") {
    return;
  }
  if (request.authActorSource !== "none") {
    return;
  }
  return reply.code(403).send({
    error: `Authenticated access is required for ${accessClass} routes.`,
  });
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

  fastify.addHook("onRoute", (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const accessClass = routeOptions.config?.goatcitadelRouteAccessClass;
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
