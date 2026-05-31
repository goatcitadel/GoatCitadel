import type { FastifyPluginAsync } from "fastify";
import type {
  CapabilityCatalogEntry,
  McpRemotePreviewItem,
  McpRemotePreviewResponse,
  McpServerModeManifestResponse,
  McpServerModeToolDescriptor,
  McpServerRecord,
  McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import { z } from "zod";
import {
  areExperimentalRemoteMcpTransportsEnabled,
  buildUnsupportedMcpTransportMessage,
  isAllowedMcpDefinitionForCreate,
  isRuntimeSupportedMcpDefinition,
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

  fastify.get("/api/v1/mcp/remote-preview", READ_ROUTE_OPTIONS, async (_request, reply) => {
    return reply.send(
      buildMcpRemotePreview({
        servers: fastify.services.mcp.listMcpServers(),
        templates: fastify.services.mcp.listMcpTemplates(),
      }),
    );
  });

  fastify.get("/api/v1/mcp/server-mode/manifest", READ_ROUTE_OPTIONS, async (_request, reply) => {
    return reply.send(
      buildMcpServerModeManifest({
        inspectableCatalog: fastify.services.capabilities.listCapabilityCatalog("inspectable"),
        callableCatalog: fastify.services.capabilities.listCapabilityCatalog("callable"),
      }),
    );
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
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed,
    runtimeSupport: experimentalRemoteRecordsAllowed ? "experimental_records_only" : "internal_approval_inbox_only",
    summary: {
      remoteServers: serverItems.length,
      remoteTemplates: templateItems.length,
      runtimeSupported: items.filter((item) => item.runtimeSupported).length,
      blocked: items.filter((item) => item.posture === "blocked").length,
      configuredOnly: items.filter((item) => item.posture === "configured_only").length,
    },
    items,
  };
}

function buildRemotePreviewBase(
  item: McpServerRecord | McpServerTemplateRecord,
  experimentalRemoteRecordsAllowed: boolean,
  source: "server" | "template",
): Omit<McpRemotePreviewItem, "source" | "id" | "evidence"> {
  const runtimeSupported = isRuntimeSupportedMcpDefinition(item);
  const createAllowed = isAllowedMcpDefinitionForCreate(item);
  const posture = runtimeSupported
    ? "runtime_supported"
    : source === "server"
      ? "configured_only"
      : experimentalRemoteRecordsAllowed
        ? "experimental_record_allowed"
        : "blocked";
  const blockers = runtimeSupported
    ? []
    : ["Generic remote http/sse MCP runtime invocation is not supported in this shell."];
  const governance = [
    "Deny-wins tool policy and MCP approval gates still apply before invocation.",
    item.authType === "none"
      ? "No remote auth configured."
      : `${item.authType} credentials are required before connect.`,
    item.trustTier === "quarantined" ? "Quarantined servers remain non-callable." : `Trust tier is ${item.trustTier}.`,
  ];
  return {
    label: item.label,
    transport: item.transport as Extract<McpServerRecord["transport"], "http" | "sse">,
    url: item.url,
    authType: item.authType,
    trustTier: item.trustTier,
    posture,
    callableState: runtimeSupported ? "runtime_invokable" : "not_callable",
    createAllowed,
    runtimeSupported,
    blockers,
    governance,
  };
}

function isRemoteMcpDefinition(
  item: Pick<McpServerRecord | McpServerTemplateRecord, "transport">,
): item is McpServerRecord | McpServerTemplateRecord {
  return item.transport === "http" || item.transport === "sse";
}

export function buildMcpServerModeManifest(input: {
  inspectableCatalog: CapabilityCatalogEntry[];
  callableCatalog: CapabilityCatalogEntry[];
}): McpServerModeManifestResponse {
  const tools = input.callableCatalog.map(buildServerModeToolDescriptor);
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "manifest_only",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: false,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "MCP server protocol execution is not wired in this prototype; this endpoint is a descriptor manifest.",
    },
    summary: {
      inspectableCapabilities: input.inspectableCatalog.length,
      gatewayCallableCapabilities: input.callableCatalog.length,
      exportedToolDescriptors: tools.length,
      blockedDescriptors: tools.filter((tool) => tool.serverModeState === "blocked").length,
    },
    tools,
    governance: [
      "This projection is read-only and does not mutate capability, MCP, approval, or tool policy state.",
      "Any future MCP server execution must re-enter Gateway-owned deny-wins policy, approvals, path jails, and memory governance.",
      "Only the callable capability catalog is described as exportable; inspectable-only candidates and proposals are withheld.",
    ],
    limitations: [
      "MCP server protocol serving is not available from this endpoint.",
      "Tool descriptors are intentionally conservative and do not grant external clients new authority.",
      "Remote MCP transport invocation remains governed separately by the existing MCP client/runtime surfaces.",
    ],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: input.callableCatalog.map((entry) => ({
        capabilityId: entry.capabilityId,
        kind: entry.kind,
        callable: entry.callable,
      })),
    },
  };
}

function buildServerModeToolDescriptor(entry: CapabilityCatalogEntry): McpServerModeToolDescriptor {
  const name = normalizeServerModeToolName(entry);
  const governance = [
    `Gateway callable state: ${entry.callable ? "callable" : "not callable"}.`,
    "External MCP server invocation is descriptor-only until the protocol runner is implemented.",
  ];
  if (entry.lifecycleState) {
    governance.push(`Lifecycle state: ${entry.lifecycleState}.`);
  }
  if (entry.trustLabel) {
    governance.push(`Trust label: ${entry.trustLabel}.`);
  }
  if (entry.reviewWarning) {
    governance.push(`Review warning: ${entry.reviewWarning}`);
  }
  return {
    name,
    title: entry.title,
    description: entry.summary,
    capabilityId: entry.capabilityId,
    capabilityKind: entry.kind,
    sourceRef: entry.sourceRef ?? entry.toolName ?? entry.skillId,
    inputSchema: buildServerModeInputSchema(entry),
    gatewayCallable: entry.callable,
    serverModeState: entry.callable ? "descriptor_only" : "blocked",
    blockers: entry.callable
      ? ["MCP server protocol execution is not wired in this prototype."]
      : ["Capability is not callable in the Gateway catalog."],
    governance,
    annotations: {
      readOnlyHint: Boolean(entry.wrapperVisibility?.readOnly),
      destructiveHint: !entry.wrapperVisibility?.readOnly,
      openWorldHint: entry.kind === "tool",
    },
  };
}

function buildServerModeInputSchema(entry: CapabilityCatalogEntry): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      arguments: {
        type: "object",
        description: `Arguments passed through Gateway governance for ${entry.title}.`,
        additionalProperties: true,
      },
    },
  };
}

function normalizeServerModeToolName(entry: Pick<CapabilityCatalogEntry, "capabilityId" | "toolName" | "skillId">) {
  const raw = entry.toolName ?? entry.skillId ?? entry.capabilityId;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `goatcitadel.${normalized || "capability"}`;
}
