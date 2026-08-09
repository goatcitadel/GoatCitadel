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
  | "a2a-peer"
  // HX-408: admitted mesh-node publication routes. Authentication is the
  // node's durable admission credential (join-token digest plus mTLS
  // binding), verified by the mesh capability publication owner; ordinary
  // operator/companion authority never satisfies it.
  | "mesh-node"
  | "sse-read"
  | "webhook"
  // Purpose-aware session-control classes plus the generic paired-companion
  // review class. The central purpose guard keeps a session-control principal
  // out of operator-or-companion and keeps a general companion out of the
  // session-control classes.
  | "device-session-exchange"
  | "session-control-companion"
  | "operator-or-companion"
  | "operator-or-session-control-companion";

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
  // Read-only surface classifier preview (POST /api/v1/surface/classify). It takes an
  // arbitrary prompt plus workspace/citadel ids, so it stays operator-gated like the rest
  // of the console — this makes the classification explicit (was resolving to the operator
  // DEFAULT, which the auth-matrix flags as not-deliberately-classified).
  { prefix: "/api/v1/surface", accessClass: "operator" },
  { prefix: "/api/v1/llm", accessClass: "operator" },
  { prefix: "/api/v1/local-ai", accessClass: "operator" },
  { prefix: "/api/v1/llamacpp", accessClass: "operator" },
  { prefix: "/api/v1/model-comparisons", accessClass: "operator" },
  { prefix: "/api/v1/tools", accessClass: "operator" },
  { prefix: "/api/v1/mcp", accessClass: "operator" },
  { prefix: "/api/v1/addons", accessClass: "operator" },
  { prefix: "/api/v1/capability-packs", accessClass: "operator" },
  { prefix: "/api/v1/evidence", accessClass: "operator" },
  { prefix: "/api/v1/compliance", accessClass: "operator" },
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
  { prefix: "/api/v1/turns", accessClass: "operator" },
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
  { prefix: "/api/v1/trust", accessClass: "operator" },
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
  { prefix: "/api/v1/communications", accessClass: "operator" },
  { prefix: "/api/v1/mail", accessClass: "operator" },
  { prefix: "/api/v1/calendar", accessClass: "operator" },
  { prefix: "/api/v1/notes", accessClass: "operator" },
  { prefix: "/api/v1/reminders", accessClass: "operator" },
  { prefix: "/api/v1/notifications", accessClass: "operator" },
  { prefix: "/api/v1/engineering-learnings", accessClass: "operator" },
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
    case "a2a-peer":
    case "mesh-node":
    case "sse-read":
    case "device-session-exchange":
    case "session-control-companion":
    case "operator-or-companion":
    case "operator-or-session-control-companion":
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
  // The central purpose guard runs before the access-class switch so that
  // purpose-bound (session_control_client) authority is confined ahead of any
  // per-class source verification.
  const purposeDenied = enforcePrincipalPurposeIsolation(request, reply, accessClass);
  if (purposeDenied !== undefined) {
    return purposeDenied;
  }
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
    case "device-session-exchange":
      // Both generic and purpose-bound devices exchange here; the guard has
      // already confined purpose-bound devices to exactly this class.
      return requireAuthActorSource(request, reply, "device", accessClass);
    case "session-control-companion":
      return requireSessionControlCompanion(request, reply, accessClass);
    case "operator-or-companion":
      if (isGeneralCompanion(request)) {
        return;
      }
      if (!hasOperatorAuthHandler(fastify)) {
        return reply.code(500).send({
          error: "Operator authentication is not installed for this route.",
        });
      }
      return fastify.requireOperatorAuth(request, reply);
    case "operator-or-session-control-companion":
      if (isSessionControlCompanion(request)) {
        return;
      }
      if (!hasOperatorAuthHandler(fastify)) {
        return reply.code(500).send({
          error: "Operator authentication is not installed for this route.",
        });
      }
      return fastify.requireOperatorAuth(request, reply);
    case "a2a-peer":
      return requireA2APeerAccess(fastify, request, reply);
    case "mesh-node":
      return requireMeshNodeAccess(fastify, request, reply);
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

/**
 * Central purpose guard. A principal whose stored, immutable purpose is
 * `session_control_client` is confined to exactly its matching class: a device
 * to `device-session-exchange`, a companion to the two control classes. Every
 * other class — generic device/companion, authenticated-read, sse-read,
 * operator (default), any unrelated class, and unscoped routes (undefined) —
 * rejects it. Public routes ignore attached bearer authority entirely. Generic
 * (`general_companion`) principals, operator tokens, and every non-device/
 * companion source are not purpose-bound and are deferred to the access-class
 * switch unchanged.
 */
export function enforcePrincipalPurposeIsolation(
  request: FastifyRequest,
  reply: FastifyReply,
  accessClass: RouteAccessClass | undefined,
): void | ReturnType<FastifyReply["send"]> {
  if (accessClass === "public") {
    return;
  }
  const source = request.authActorSource;
  const purposeBound =
    (source === "device" || source === "companion") && request.authPrincipalPurpose === "session_control_client";
  if (!purposeBound) {
    return;
  }
  if (source === "device" && accessClass === "device-session-exchange") {
    return;
  }
  if (
    source === "companion" &&
    (accessClass === "session-control-companion" || accessClass === "operator-or-session-control-companion")
  ) {
    return;
  }
  return reply.code(403).send({
    error: "Purpose-bound session-control authority cannot access this route.",
  });
}

function isSessionControlCompanion(request: FastifyRequest): boolean {
  return (
    request.authActorSource === "companion" &&
    request.authPrincipalPurpose === "session_control_client" &&
    Boolean(request.authCompanionSessionId)
  );
}

function isGeneralCompanion(request: FastifyRequest): boolean {
  return (
    request.authActorSource === "companion" &&
    request.authPrincipalPurpose === "general_companion" &&
    Boolean(request.authCompanionSessionId)
  );
}

function requireSessionControlCompanion(
  request: FastifyRequest,
  reply: FastifyReply,
  accessClass: RouteAccessClass,
): void | ReturnType<FastifyReply["send"]> {
  if (isSessionControlCompanion(request)) {
    return;
  }
  return reply.code(403).send({
    error: `Session-control companion authentication is required for ${accessClass} routes.`,
  });
}

function requireA2APeerAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): void | ReturnType<FastifyReply["send"]> {
  const service = (fastify as unknown as { services?: { a2a?: { authenticatePeerRequest?: unknown } } }).services?.a2a;
  if (typeof service?.authenticatePeerRequest !== "function") {
    return reply.code(500).send({
      error: "A2A peer authentication is not installed for this route.",
    });
  }
  const result = service.authenticatePeerRequest(request) as
    | { peerId: string; scopes?: string[] }
    | { statusCode: number; reason: string; message: string };
  if ("statusCode" in result) {
    return reply.code(result.statusCode).send({
      error: result.message,
      reason: result.reason,
    });
  }
  request.authActorId = `a2a:${result.peerId}`;
  request.authActorSource = "a2a_peer";
  request.a2aPeerId = result.peerId;
}

/**
 * HX-408: verifies the admitted mesh-node credential through the mesh
 * capability publication owner. Identity comes exclusively from the durable
 * node-admission authority the service reads; on success the request carries
 * the resolved identity tuple for the route handler. Operator, device, and
 * companion credentials always fail this check, keeping the publication
 * surface isolated from ordinary console authority.
 */
async function requireMeshNodeAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | ReturnType<FastifyReply["send"]>> {
  const service = (
    fastify as unknown as {
      services?: { meshCapabilityPublication?: { authenticateNodeRequest?: unknown } };
    }
  ).services?.meshCapabilityPublication;
  if (typeof service?.authenticateNodeRequest !== "function") {
    return reply.code(500).send({
      error: "Admitted mesh-node authentication is not installed for this route.",
    });
  }
  const result = (await service.authenticateNodeRequest(request)) as
    | {
        identity: {
          workspaceId: string;
          nodeId: string;
          admissionGeneration: number;
          mtlsRequired: boolean;
          tlsFingerprint?: string;
        };
      }
    | { statusCode: number; reason: string; message: string };
  if ("statusCode" in result) {
    return reply.code(result.statusCode).send({
      error: result.message,
      reason: result.reason,
    });
  }
  request.authActorId = `mesh-node:${result.identity.nodeId}`;
  request.authActorSource = "mesh_node";
  request.meshNodeIdentity = result.identity;
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
      // Unscoped routes carry no access class, but purpose-bound authority must
      // still be centrally rejected there rather than silently allowed.
      return enforcePrincipalPurposeIsolation(request, reply, undefined);
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
