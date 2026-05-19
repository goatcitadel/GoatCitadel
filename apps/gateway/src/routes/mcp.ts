import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  buildUnsupportedMcpTransportMessage,
  isAllowedMcpDefinitionForCreate,
} from "../services/mcp-template-visibility.js";

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
  notes: z.string().optional(),
});

const createServerSchema = z.object({
  label: z.string().min(1),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  authType: z.enum(["none", "token", "oauth2"]).optional(),
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
  fastify.get("/api/v1/mcp/servers", READ_ROUTE_OPTIONS, async (_request, reply) => {
    return reply.send({ items: fastify.services.mcp.listMcpServers() });
  });

  fastify.get("/api/v1/mcp/templates", READ_ROUTE_OPTIONS, async (_request, reply) => {
    return reply.send({ items: fastify.services.mcp.listMcpTemplates() });
  });

  fastify.get("/api/v1/mcp/templates/discovery", READ_ROUTE_OPTIONS, async (_request, reply) => {
    try {
      return reply.send({ items: fastify.services.mcp.listMcpTemplateDiscovery() });
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mcp/servers", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
    const parsed = createServerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!isAllowedMcpDefinitionForCreate(parsed.data)) {
      return reply.code(400).send({ error: buildUnsupportedMcpTransportMessage(parsed.data.transport) });
    }
    try {
      return reply.code(201).send(fastify.services.mcp.createMcpServer(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/mcp/servers/:serverId", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.delete("/api/v1/mcp/servers/:serverId", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
    const params = serverParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    return reply.send(fastify.services.mcp.deleteMcpServer(params.data.serverId));
  });

  fastify.post("/api/v1/mcp/servers/:serverId/connect", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.post("/api/v1/mcp/servers/:serverId/disconnect", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.post("/api/v1/mcp/servers/:serverId/oauth/start", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.post("/api/v1/mcp/servers/:serverId/oauth/complete", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.get("/api/v1/mcp/servers/:serverId/tools", READ_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.post("/api/v1/mcp/invoke", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
    const parsed = invokeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
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

  fastify.patch("/api/v1/mcp/servers/:serverId/policy", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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

  fastify.post("/api/v1/mcp/servers/:serverId/health-check", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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
