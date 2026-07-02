import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  McpRemotePreviewItem,
  McpRemotePreviewResponse,
  McpElicitationOwnerMetadata,
  McpServerRecord,
  McpServerTemplateRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { z } from "zod";
import {
  areExperimentalRemoteMcpTransportsEnabled,
  buildInternalMcpServerCreateBlockedMessage,
  buildUnsupportedMcpTransportMessage,
  isAllowedMcpDefinitionForCreate,
  isAllowedMcpDefinitionForCallerCreate,
  isInternalMcpServerUrl,
  isRuntimeSupportedMcpDefinition,
} from "../services/mcp-template-visibility.js";
import { MCP_APPROVAL_INBOX_URL } from "../services/mcp-approval-inbox.js";
import {
  buildMcpStaleAuthInvokeError,
  isMcpAuthReadinessInvokeBlocked,
  resolveMcpInvokeAuthReadiness,
} from "../services/mcp-oauth-token-service.js";
import {
  buildMcpToolCollisionError,
  findServersExposingTool,
  parseNamespacedMcpToolName,
} from "../services/mcp-tool-namespace.js";
import { McpElicitationServiceError } from "../services/mcp-elicitation-service.js";
import {
  buildMcpServerModeBlockedResponse,
  buildMcpServerModeCallResponse,
  buildMcpServerModeManifest,
  findServerModeToolDescriptor,
  isMcpServerModeCallPreviewAvailable,
  isServerModeDescriptorCallablePreview,
} from "./mcp-server-mode.js";
import { withRouteAccess } from "./route-access.js";

const serverParamsSchema = z.object({
  serverId: z.string().min(1),
});

const categorySchema = z.enum([
  "development",
  "browser",
  "automation",
  "research",
  "data",
  "creative",
  "orchestration",
  "other",
]);
const trustTierSchema = z.enum(["trusted", "restricted", "quarantined"]);
const costTierSchema = z.enum(["free", "mixed", "paid", "unknown"]);
const policySchema = z.object({
  requireFirstToolApproval: z.boolean().optional(),
  redactionMode: z.enum(["off", "basic", "strict"]).optional(),
  allowedToolPatterns: z.array(z.string()).optional(),
  blockedToolPatterns: z.array(z.string()).optional(),
  allowedEnvKeys: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
const oauthSchema = z.object({
  authorizationUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientIdEnv: z.string().trim().min(1).optional(),
  clientSecretEnv: z.string().trim().min(1).optional(),
  scopes: z.array(z.string().trim().min(1)).optional(),
  redirectUri: z.string().url().optional(),
  tokenRefreshSkewSeconds: z.number().int().nonnegative().optional(),
});

const createServerSchema = z.object({
  label: z.string().min(1),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  authType: z.enum(["none", "token", "oauth2"]).optional(),
  oauth: oauthSchema.optional(),
  enabled: z.boolean().optional(),
  category: categorySchema.optional(),
  trustTier: trustTierSchema.optional(),
  costTier: costTierSchema.optional(),
  policy: policySchema.optional(),
  verifiedAt: z.string().optional(),
});

const updateServerSchema = z.object({
  label: z.string().min(1).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  authType: z.enum(["none", "token", "oauth2"]).optional(),
  oauth: oauthSchema.optional(),
  enabled: z.boolean().optional(),
  category: categorySchema.optional(),
  trustTier: trustTierSchema.optional(),
  costTier: costTierSchema.optional(),
  policy: policySchema.optional(),
  verifiedAt: z.string().optional(),
});

const oauthCompleteSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
});

const invokeSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
  autonomousActivation: z.boolean().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

const serverModeCallSchema = z.object({
  descriptorName: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
});

const elicitationStatusSchema = z.enum(["pending", "accepted", "declined", "cancelled", "expired"]);
const elicitationActionSchema = z.enum(["accept", "decline", "cancel"]);
const elicitationOwnerSchema = z.object({
  operatorId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
});
const elicitationSourceSchema = z.object({
  sourceType: z.enum(["mcp_server", "gateway", "agent", "ui"]).optional(),
  serverId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  jsonRpcRequestId: z.union([z.string().trim().min(1), z.number()]).optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  sourceRef: z.string().trim().min(1).optional(),
});
const elicitationCreateSchema = z
  .object({
    prompt: z.string().optional(),
    message: z.string().optional(),
    requestedSchema: z.record(z.unknown()),
    owner: elicitationOwnerSchema.optional(),
    source: elicitationSourceSchema.optional(),
    serverId: z.string().trim().min(1).optional(),
    toolName: z.string().trim().min(1).optional(),
    jsonRpcRequestId: z.union([z.string().trim().min(1), z.number()]).optional(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
  })
  .refine((input) => Boolean((input.prompt ?? input.message)?.trim()), {
    message: "MCP elicitation prompt/message is required.",
    path: ["prompt"],
  });
const elicitationParamsSchema = z.object({
  elicitationId: z.string().min(1),
});
const elicitationResponseSchema = z.object({
  action: elicitationActionSchema,
  content: z.record(z.unknown()).optional(),
  owner: elicitationOwnerSchema.optional(),
});
const elicitationListQuerySchema = z.object({
  status: elicitationStatusSchema.optional(),
  serverId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

const READ_ROUTE_OPTIONS = {
  config: {
    rateLimit: {
      max: 500,
    },
  },
};

const MUTATION_ROUTE_OPTIONS = {
  config: {
    rateLimit: {
      max: 180,
    },
  },
};

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // Shared elicitation store (also backs the approval-inbox respond/list tools) so either surface answers the other's requests.
  const mcpElicitations = fastify.services.mcp.elicitations;
  const operatorReadRoute = withRouteAccess(fastify, "operator", READ_ROUTE_OPTIONS);
  const operatorMutationRoute = withRouteAccess(fastify, "operator", MUTATION_ROUTE_OPTIONS);

  fastify.get("/api/v1/mcp/servers", operatorReadRoute, async (_request, reply) => {
    return reply.send({ items: fastify.services.mcp.listMcpServers() });
  });

  fastify.get("/api/v1/mcp/templates", operatorReadRoute, async (_request, reply) => {
    return reply.send({ items: fastify.services.mcp.listMcpTemplates() });
  });

  fastify.get("/api/v1/mcp/templates/discovery", operatorReadRoute, async (_request, reply) => {
    try {
      return reply.send({ items: fastify.services.mcp.listMcpTemplateDiscovery() });
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mcp/remote-preview", operatorReadRoute, async (_request, reply) => {
    return reply.send(
      buildMcpRemotePreview({
        servers: fastify.services.mcp.listMcpServers(),
        templates: fastify.services.mcp.listMcpTemplates(),
      }),
    );
  });

  fastify.get("/api/v1/mcp/elicitations", operatorReadRoute, async (request, reply) => {
    const query = elicitationListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send({
      items: mcpElicitations.listRequests({
        ...query.data,
        owner: resolveElicitationCallerOwner(request),
      }),
    });
  });

  fastify.post("/api/v1/mcp/elicitations", operatorMutationRoute, async (request, reply) => {
    const parsed = elicitationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(
        mcpElicitations.createRequest({
          ...parsed.data,
          prompt: parsed.data.prompt ?? parsed.data.message ?? "",
          owner: resolveElicitationCallerOwner(request, parsed.data.owner),
        }),
      );
    } catch (error) {
      return sendMcpElicitationError(reply, error);
    }
  });

  fastify.post("/api/v1/mcp/elicitations/:elicitationId/respond", operatorMutationRoute, async (request, reply) => {
    const params = elicitationParamsSchema.safeParse(request.params);
    const body = elicitationResponseSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        mcpElicitations.respondToRequest(params.data.elicitationId, {
          ...body.data,
          owner: resolveElicitationCallerOwner(request, body.data.owner),
        }),
      );
    } catch (error) {
      return sendMcpElicitationError(reply, error);
    }
  });

  fastify.get("/api/v1/mcp/server-mode/manifest", operatorReadRoute, async (_request, reply) => {
    return reply.send(
      buildMcpServerModeManifest({
        inspectableCatalog: fastify.services.capabilities.listCapabilityCatalog("inspectable"),
        callableCatalog: fastify.services.capabilities.listCapabilityCatalog("callable"),
        callPreviewAvailable: isMcpServerModeCallPreviewAvailable(fastify.services),
      }),
    );
  });

  fastify.post("/api/v1/mcp/server-mode/call", operatorMutationRoute, async (request, reply) => {
    const parsed = serverModeCallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!isMcpServerModeCallPreviewAvailable(fastify.services)) {
      return reply.code(409).send({
        error: "MCP server-mode call preview is not available in this Gateway runtime.",
      });
    }

    const callableCatalog = fastify.services.capabilities.listCapabilityCatalog("callable");
    const descriptor = findServerModeToolDescriptor(callableCatalog, parsed.data.descriptorName);
    if (!descriptor) {
      return reply.code(404).send({
        error: `Unknown MCP server-mode descriptor ${parsed.data.descriptorName}.`,
      });
    }
    if (!isServerModeDescriptorCallablePreview(descriptor)) {
      return reply
        .code(409)
        .send(
          buildMcpServerModeBlockedResponse(parsed.data.descriptorName, descriptor, [
            "Server-mode call preview only executes read-only, closed-world Gateway tool descriptors.",
          ]),
        );
    }

    const entry = callableCatalog.find((candidate) => candidate.capabilityId === descriptor.capabilityId);
    const toolName = entry?.toolName;
    if (!toolName) {
      return reply
        .code(409)
        .send(
          buildMcpServerModeBlockedResponse(parsed.data.descriptorName, descriptor, [
            "Descriptor does not map to a Gateway toolName that can be invoked by the tool coordinator.",
          ]),
        );
    }

    try {
      const actorId = request.authActorId?.trim() || "operator";
      const policyContext = fastify.services.tools.resolveToolPolicyContext({
        operatorId: actorId,
        authActorId: actorId,
        authActorSource: request.authActorSource,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
        taskId: parsed.data.taskId,
        runId: parsed.data.runId,
        surface: "mcp",
        permissionProfileId: parsed.data.permissionProfileId,
        localOperatorOverrideId: parsed.data.localOperatorOverrideId,
      });
      const result = await fastify.services.toolsInvoke.invokeTool({
        toolName,
        args: parsed.data.args ?? {},
        agentId: parsed.data.agentId,
        sessionId: parsed.data.sessionId,
        workspaceId: parsed.data.workspaceId,
        taskId: parsed.data.taskId,
        runId: parsed.data.runId,
        permissionProfileId: parsed.data.permissionProfileId,
        localOperatorOverrideId: parsed.data.localOperatorOverrideId,
        surface: "mcp",
        externalRuntime: true,
        sourceAttribution: [
          {
            sourceType: "mcp",
            sourceRef: "mcp_server_mode_preview",
            title: "MCP server-mode call preview",
            trustLevel: "trusted_workspace",
          },
        ],
        consentContext: {
          operatorId: actorId,
          source: "agent",
          reason: "mcp.server-mode.call-preview",
        },
        policyContext,
      });
      return reply.send(buildMcpServerModeCallResponse(parsed.data.descriptorName, descriptor, result, toolName));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers", operatorMutationRoute, async (request, reply) => {
    const parsed = createServerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!isAllowedMcpDefinitionForCallerCreate(parsed.data)) {
      const error = isInternalMcpServerUrl(parsed.data.url)
        ? buildInternalMcpServerCreateBlockedMessage()
        : buildUnsupportedMcpTransportMessage(parsed.data.transport);
      return reply.code(400).send({ error });
    }
    try {
      return reply.code(201).send(fastify.services.mcp.createMcpServer(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/mcp/servers/:serverId", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    const body = updateServerSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.services.mcp.updateMcpServer(params.data.serverId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/mcp/servers/:serverId", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    return reply.send(fastify.services.mcp.deleteMcpServer(params.data.serverId));
  });

  fastify.post("/api/v1/mcp/servers/:serverId/connect", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.mcp.connectMcpServer(params.data.serverId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers/:serverId/disconnect", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mcp.disconnectMcpServer(params.data.serverId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers/:serverId/oauth/start", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mcp.startMcpOAuth(params.data.serverId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers/:serverId/oauth/complete", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    const body = oauthCompleteSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.mcp.completeMcpOAuth(params.data.serverId, body.data.code, body.data.state),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mcp/servers/:serverId/tools", operatorReadRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: fastify.services.mcp.listMcpTools(params.data.serverId) });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/invoke", operatorMutationRoute, async (request, reply) => {
    const parsed = invokeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // Resolve the concrete (serverId, toolName) target, honoring mcp__<serverId>__<tool>
    // namespacing and rejecting ambiguous bare-name collisions BEFORE dispatch.
    const target = resolveMcpInvokeTarget(fastify.services.mcp, parsed.data.serverId, parsed.data.toolName);
    if (!target.ok) {
      return reply.code(target.statusCode).send({ error: target.error });
    }
    // Fail closed on stale / missing OAuth: never reach invokeMcpTool when the
    // server still needs (re)authentication.
    const authBlock = evaluateMcpInvokeAuthGate(fastify.services.mcp, target.serverId);
    if (authBlock) {
      return reply.code(401).send({ error: authBlock });
    }
    try {
      const actorId = request.authActorId?.trim() || parsed.data.agentId?.trim() || "operator";
      const policyContext = fastify.services.tools?.resolveToolPolicyContext?.({
        operatorId: actorId,
        authActorId: actorId,
        authActorSource: request.authActorSource,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
        taskId: parsed.data.taskId,
        runId: parsed.data.runId,
        surface: parsed.data.surface ?? "mcp",
        permissionProfileId: parsed.data.permissionProfileId,
        localOperatorOverrideId: parsed.data.localOperatorOverrideId,
      }) ?? {
        operatorId: actorId,
        authActorId: actorId,
        authActorSource: request.authActorSource,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
        taskId: parsed.data.taskId,
        runId: parsed.data.runId,
        surface: parsed.data.surface ?? "mcp",
        permissionProfileId: parsed.data.permissionProfileId,
        localOperatorOverrideId: parsed.data.localOperatorOverrideId,
      };
      return reply.send(
        await fastify.services.mcp.invokeMcpTool({
          ...parsed.data,
          serverId: target.serverId,
          toolName: target.toolName,
          policyContext,
          consentContext: {
            operatorId: actorId,
            source: "ui",
            reason: "mcp.invoke",
          },
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/mcp/servers/:serverId/policy", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    const body = policySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.services.mcp.updateMcpServerPolicy(params.data.serverId, body.data));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers/:serverId/health-check", operatorMutationRoute, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mcp.runMcpServerHealthCheck(params.data.serverId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown mcp server");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });
};

function resolveElicitationCallerOwner(
  request: { authActorId?: string },
  suppliedOwner?: McpElicitationOwnerMetadata,
): McpElicitationOwnerMetadata | undefined {
  const authActorId = request.authActorId?.trim();
  if (!authActorId) {
    return suppliedOwner;
  }
  return {
    ...suppliedOwner,
    operatorId: authActorId,
  };
}

function sendMcpElicitationError(reply: FastifyReply, error: unknown) {
  if (error instanceof McpElicitationServiceError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  return reply.code(400).send({ error: (error as Error).message });
}

/** Minimal read surface of the MCP service used by the invoke-time gates. */
interface McpInvokeGatePort {
  listMcpServers(): McpServerRecord[];
  listMcpTools(serverId: string): McpToolRecord[];
}

type McpInvokeTargetResolution =
  | { ok: true; serverId: string; toolName: string }
  | { ok: false; statusCode: number; error: string };

/**
 * Resolve the concrete server + tool to dispatch for an `/invoke` request.
 *
 * - `mcp__<serverId>__<toolName>` namespaced names resolve directly to that
 *   server (explicit disambiguation; the body `serverId` is overridden so the
 *   namespace is authoritative). Unknown namespaced servers fail closed (404).
 * - Bare tool names dispatch to the requested `serverId`, but only after a
 *   collision check: if the same bare name is exposed by more than one connected
 *   server, the request is ambiguous and is rejected (409) with guidance to use
 *   the namespaced form, rather than silently invoking an arbitrary server.
 *
 * Single-server / unique-tool invocations resolve unchanged.
 */
export function resolveMcpInvokeTarget(
  mcp: McpInvokeGatePort,
  requestedServerId: string,
  requestedToolName: string,
): McpInvokeTargetResolution {
  const servers = safeListMcpServers(mcp);
  const namespaced = parseNamespacedMcpToolName(requestedToolName);
  if (namespaced) {
    const exists = servers.some((server) => server.serverId === namespaced.serverId);
    if (!exists) {
      return {
        ok: false,
        statusCode: 404,
        error: `Unknown MCP server: ${namespaced.serverId} (resolved from namespaced tool ${requestedToolName}).`,
      };
    }
    return { ok: true, serverId: namespaced.serverId, toolName: namespaced.toolName };
  }

  const exposingServers = findServersExposingTool(requestedToolName, servers, (serverId) =>
    safeListMcpTools(mcp, serverId),
  );
  if (exposingServers.length > 1 && !exposingServers.every((serverId) => serverId === requestedServerId)) {
    return {
      ok: false,
      statusCode: 409,
      error: buildMcpToolCollisionError(requestedToolName, exposingServers),
    };
  }
  return { ok: true, serverId: requestedServerId, toolName: requestedToolName };
}

/**
 * Invoke-time auth gate: returns an actionable error string when the target
 * server's OAuth is stale/missing (`needs_auth` / `expired`) so the route can
 * fail closed before reaching `invokeMcpTool`; returns `undefined` when the
 * server is `ready` / `not_required` or cannot be resolved here (the downstream
 * service still performs its own checks).
 */
export function evaluateMcpInvokeAuthGate(mcp: McpInvokeGatePort, serverId: string): string | undefined {
  const server = safeListMcpServers(mcp).find((candidate) => candidate.serverId === serverId);
  if (!server) {
    return undefined;
  }
  const readiness = resolveMcpInvokeAuthReadiness(server);
  if (isMcpAuthReadinessInvokeBlocked(readiness)) {
    return buildMcpStaleAuthInvokeError(server, readiness);
  }
  return undefined;
}

function safeListMcpServers(mcp: McpInvokeGatePort): McpServerRecord[] {
  try {
    return mcp.listMcpServers() ?? [];
  } catch {
    // A failure to list servers must not crash the route; downstream invoke
    // still enforces its own server-resolution and policy checks.
    return [];
  }
}

function safeListMcpTools(mcp: McpInvokeGatePort, serverId: string): McpToolRecord[] {
  try {
    return mcp.listMcpTools(serverId) ?? [];
  } catch {
    return [];
  }
}

export function buildMcpRemotePreview(input: {
  servers: McpServerRecord[];
  templates: Array<McpServerTemplateRecord & { installed?: boolean }>;
}): McpRemotePreviewResponse {
  const experimentalRemoteRecordsAllowed = areExperimentalRemoteMcpTransportsEnabled();
  const serverItems = input.servers.filter(isRemoteMcpDefinition).map((server): McpRemotePreviewItem => {
    const base = buildRemotePreviewBase(server, experimentalRemoteRecordsAllowed, "server");
    return {
      ...base,
      source: "server",
      id: server.serverId,
      status: server.status,
      enabled: server.enabled,
      evidence: {
        policyNotes: server.policy.notes,
        verifiedAt: server.verifiedAt,
        lastConnectedAt: server.lastConnectedAt,
        lastError: server.lastError,
        authState: server.authState,
      },
    };
  });
  const templateItems = input.templates.filter(isRemoteMcpDefinition).map((template): McpRemotePreviewItem => {
    const base = buildRemotePreviewBase(template, experimentalRemoteRecordsAllowed, "template");
    return {
      ...base,
      source: "template",
      id: template.templateId,
      installed: template.installed ?? false,
      evidence: {
        policyNotes: template.policy.notes,
      },
    };
  });
  const items = [...serverItems, ...templateItems].sort((left, right) =>
    `${left.source}:${left.label}`.localeCompare(`${right.source}:${right.label}`),
  );
  const remoteBridgeSupported = items.some(
    (item) => item.runtimeSupported && item.runtimePath === "generic_remote_http_sse",
  );
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed,
    runtimeSupport: remoteBridgeSupported
      ? "remote_http_sse_bridge"
      : experimentalRemoteRecordsAllowed
        ? "experimental_records_only"
        : "internal_approval_inbox_only",
    summary: {
      remoteServers: serverItems.length,
      remoteTemplates: templateItems.length,
      runtimeSupported: items.filter((item) => item.runtimeSupported).length,
      blocked: items.filter((item) => item.posture === "blocked").length,
      configuredOnly: items.filter((item) => item.posture === "configured_only").length,
      notCallable: items.filter((item) => item.callableState === "not_callable").length,
      experimentalRecords: items.filter((item) => item.invocationState === "experimental_record_only").length,
      quarantined: items.filter((item) => item.invocationState === "quarantined").length,
      needsAuth: items.filter((item) => item.authReadiness !== "not_required" && item.authReadiness !== "ready").length,
    },
    items,
  };
}

function buildRemotePreviewBase(
  item: McpServerRecord | McpServerTemplateRecord,
  experimentalRemoteRecordsAllowed: boolean,
  source: "server" | "template",
): Omit<McpRemotePreviewItem, "source" | "id" | "evidence"> {
  const transportRuntimeSupported = isRuntimeSupportedMcpDefinition(item);
  const createAllowed = isAllowedMcpDefinitionForCreate(item);
  const quarantined = item.trustTier === "quarantined";
  const runtimeSupported = transportRuntimeSupported && !quarantined;
  const authReadiness = resolveRemoteMcpAuthReadiness(item);
  const authBlocksRuntime = authReadiness !== "not_required" && authReadiness !== "ready";
  const runtimePath =
    item.url?.trim().toLowerCase() === MCP_APPROVAL_INBOX_URL ? "internal_approval_inbox" : "generic_remote_http_sse";
  const posture = transportRuntimeSupported
    ? runtimeSupported
      ? "runtime_supported"
      : "blocked"
    : source === "server"
      ? "configured_only"
      : experimentalRemoteRecordsAllowed
        ? "experimental_record_allowed"
        : "blocked";
  const blockers = buildMcpRemotePreviewBlockers({
    transportRuntimeSupported,
    createAllowed,
    quarantined,
    authReadiness,
    source,
  });
  const invocationState = buildMcpRemotePreviewInvocationState({
    runtimeSupported: runtimeSupported && !authBlocksRuntime,
    transportRuntimeSupported,
    experimentalRemoteRecordsAllowed,
    source,
    quarantined,
  });
  const governance = [
    "Deny-wins tool policy and MCP approval gates still apply before invocation.",
    authReadiness === "not_required"
      ? "No remote auth configured."
      : authReadiness === "ready"
        ? "OAuth/token credentials are resolved through Gateway-owned secret handling."
        : `${item.authType} credentials are required before connect.`,
    item.trustTier === "quarantined" ? "Quarantined servers remain non-callable." : `Trust tier is ${item.trustTier}.`,
  ];
  return {
    label: item.label,
    transport: item.transport as Extract<McpServerRecord["transport"], "http" | "sse">,
    url: item.url,
    authType: item.authType,
    authReadiness,
    trustTier: item.trustTier,
    posture,
    callableState: runtimeSupported && !authBlocksRuntime ? "runtime_invokable" : "not_callable",
    invocationState,
    runtimePath,
    createAllowed,
    transportRuntimeSupported,
    runtimeSupported: runtimeSupported && !authBlocksRuntime,
    operatorNextAction: buildMcpRemotePreviewNextAction({
      invocationState,
      source,
      transportRuntimeSupported,
      createAllowed,
      authReadiness,
    }),
    blockers,
    governance,
  };
}

function buildMcpRemotePreviewBlockers(input: {
  transportRuntimeSupported: boolean;
  createAllowed: boolean;
  quarantined: boolean;
  authReadiness: McpRemotePreviewItem["authReadiness"];
  source: "server" | "template";
}): string[] {
  const blockers: string[] = [];
  if (input.quarantined) {
    blockers.push("MCP trust tier is quarantined; deny-wins trust posture keeps this record non-callable.");
  }
  if (!input.transportRuntimeSupported) {
    blockers.push("This remote MCP auth/transport combination is not runtime-invokable in this shell.");
  }
  if (input.authReadiness === "needs_auth" || input.authReadiness === "expired") {
    blockers.push("MCP OAuth credentials must be connected or refreshed before runtime invocation.");
  }
  if (input.authReadiness === "missing_oauth_config") {
    blockers.push("MCP OAuth metadata must include authorizationUrl and tokenUrl before runtime invocation.");
  }
  if (input.source === "template" && !input.createAllowed) {
    blockers.push("Creating generic remote MCP records is disabled unless experimental remote records are enabled.");
  }
  return blockers;
}

function buildMcpRemotePreviewInvocationState(input: {
  runtimeSupported: boolean;
  transportRuntimeSupported: boolean;
  experimentalRemoteRecordsAllowed: boolean;
  source: "server" | "template";
  quarantined: boolean;
}): McpRemotePreviewItem["invocationState"] {
  if (input.quarantined) {
    return "quarantined";
  }
  if (input.runtimeSupported) {
    return "runtime_invokable";
  }
  if (input.source === "server") {
    return input.transportRuntimeSupported ? "blocked" : "configured_not_callable";
  }
  return input.experimentalRemoteRecordsAllowed ? "experimental_record_only" : "blocked";
}

function buildMcpRemotePreviewNextAction(input: {
  invocationState: McpRemotePreviewItem["invocationState"];
  source: "server" | "template";
  transportRuntimeSupported: boolean;
  createAllowed: boolean;
  authReadiness: McpRemotePreviewItem["authReadiness"];
}): string {
  if (input.authReadiness === "needs_auth" || input.authReadiness === "expired") {
    return "Connect or reconnect OAuth in Settings before invoking this remote MCP server.";
  }
  if (input.authReadiness === "missing_oauth_config") {
    return "Add OAuth authorizationUrl and tokenUrl metadata before treating this remote MCP server as invokable.";
  }
  if (input.invocationState === "runtime_invokable") {
    return input.transportRuntimeSupported
      ? "Connect and invoke through the governed MCP runtime path; Gateway policy, approvals, network allowlists, and audit still apply."
      : "Use the built-in Approval Inbox path; Gateway policy, approvals, and audit still apply.";
  }
  if (input.invocationState === "quarantined") {
    return "Review trust posture before treating this MCP record as callable.";
  }
  if (input.invocationState === "experimental_record_only") {
    return "Keep as an experimental record only until a governed remote runtime bridge is shipped and proven.";
  }
  if (input.source === "server") {
    return "Keep configured for review, or replace it with local stdio or the built-in Approval Inbox path.";
  }
  if (!input.createAllowed) {
    return "Use local stdio or Approval Inbox templates for runtime work; this remote template is not installable by default.";
  }
  return "Creating the record is allowed only as experimental metadata, not runtime invocation.";
}

function resolveRemoteMcpAuthReadiness(
  item: McpServerRecord | McpServerTemplateRecord,
): McpRemotePreviewItem["authReadiness"] {
  if (item.authType === "none" || item.authType === "token") {
    return "not_required";
  }
  if (!item.oauth?.authorizationUrl?.trim() || !item.oauth.tokenUrl?.trim()) {
    return "missing_oauth_config";
  }
  if ("authState" in item && item.authState?.readiness) {
    return item.authState.readiness;
  }
  return "needs_auth";
}

function isRemoteMcpDefinition(
  item: Pick<McpServerRecord | McpServerTemplateRecord, "transport">,
): item is McpServerRecord | McpServerTemplateRecord {
  return item.transport === "http" || item.transport === "sse";
}
