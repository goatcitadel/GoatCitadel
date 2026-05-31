import type { FastifyPluginAsync } from "fastify";
import type {
  CapabilityCatalogEntry,
  McpRemotePreviewItem,
  McpRemotePreviewResponse,
  McpServerModeCallResponse,
  McpServerModeManifestResponse,
  McpServerModeToolDescriptor,
  McpServerRecord,
  McpServerTemplateRecord,
  ToolInvokeResult,
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
        callPreviewAvailable: isMcpServerModeCallPreviewAvailable(fastify.services),
      }),
    );
  });

  fastify.post("/api/v1/mcp/server-mode/call", MUTATION_ROUTE_OPTIONS, async (request, reply) => {
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
  callPreviewAvailable?: boolean;
}): McpServerModeManifestResponse {
  const callPreviewAvailable = Boolean(input.callPreviewAvailable);
  const tools = input.callableCatalog.map((entry) => buildServerModeToolDescriptor(entry, callPreviewAvailable));
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: callPreviewAvailable ? "call_preview" : "manifest_only",
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
      reason:
        "MCP protocol serving and stdio launch are not wired yet; the Gateway exposes only an operator-authenticated call preview endpoint.",
    },
    runtime: {
      callPreview: {
        supported: callPreviewAvailable,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
        reason: callPreviewAvailable
          ? "Read-only, closed-world Gateway tool descriptors can re-enter the tool coordinator through this preview."
          : "Gateway tool invocation services were not available when this manifest was generated.",
      },
      stdio: {
        supported: false,
        reason: "No launchable MCP stdio server has been shipped or proven.",
      },
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
      "The call preview re-enters Gateway-owned deny-wins policy, approvals, path jails, and memory governance for eligible descriptors.",
      "Only the callable capability catalog is described as exportable; inspectable-only candidates and proposals are withheld.",
    ],
    limitations: [
      "MCP server protocol serving and stdio launch are not available from this endpoint.",
      "The call preview is limited to read-only, closed-world Gateway tool descriptors and requires Gateway authentication.",
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

function buildServerModeToolDescriptor(
  entry: CapabilityCatalogEntry,
  callPreviewAvailable = true,
): McpServerModeToolDescriptor {
  const name = normalizeServerModeToolName(entry);
  const eligibleForCallPreview = isCapabilityEntryCallPreviewEligible(entry);
  const callPreviewEligible = callPreviewAvailable && eligibleForCallPreview;
  const governance = [
    `Gateway callable state: ${entry.callable ? "callable" : "not callable"}.`,
    callPreviewEligible
      ? "Eligible for the operator-authenticated server-mode call preview; MCP protocol serving is still not launched."
      : eligibleForCallPreview
        ? "Eligible for a future server-mode call preview, but this runtime has not exposed the preview route."
        : "Descriptor-only until the protocol runner or a safer capability-specific adapter is implemented.",
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
    serverModeState: entry.callable ? (callPreviewEligible ? "call_preview" : "descriptor_only") : "blocked",
    blockers: entry.callable
      ? callPreviewEligible
        ? ["MCP protocol serving and stdio launch are not wired yet; only the Gateway call preview is available."]
        : eligibleForCallPreview
          ? ["MCP server-mode call preview is not available in this runtime; MCP protocol serving is not wired."]
          : ["Server-mode call preview is limited to read-only, closed-world Gateway tool descriptors."]
      : ["Capability is not callable in the Gateway catalog."],
    governance,
    annotations: {
      readOnlyHint: Boolean(entry.wrapperVisibility?.readOnly),
      destructiveHint: !entry.wrapperVisibility?.readOnly,
      openWorldHint: isServerModeOpenWorldCapability(entry),
    },
  };
}

function isMcpServerModeCallPreviewAvailable(services: {
  tools?: { resolveToolPolicyContext?: unknown };
  toolsInvoke?: { invokeTool?: unknown };
}): boolean {
  return (
    typeof services.tools?.resolveToolPolicyContext === "function" &&
    typeof services.toolsInvoke?.invokeTool === "function"
  );
}

function findServerModeToolDescriptor(
  callableCatalog: CapabilityCatalogEntry[],
  descriptorName: string,
): McpServerModeToolDescriptor | undefined {
  return callableCatalog
    .map((entry) => buildServerModeToolDescriptor(entry, true))
    .find((descriptor) => descriptor.name === descriptorName);
}

function isCapabilityEntryCallPreviewEligible(entry: CapabilityCatalogEntry): boolean {
  return (
    entry.kind === "tool" &&
    Boolean(entry.toolName) &&
    entry.callable &&
    Boolean(entry.wrapperVisibility?.readOnly) &&
    !isServerModeOpenWorldCapability(entry)
  );
}

function isServerModeDescriptorCallablePreview(descriptor: McpServerModeToolDescriptor): boolean {
  return (
    descriptor.serverModeState === "call_preview" &&
    descriptor.gatewayCallable &&
    descriptor.annotations.readOnlyHint &&
    !descriptor.annotations.destructiveHint &&
    !descriptor.annotations.openWorldHint
  );
}

function isServerModeOpenWorldCapability(entry: CapabilityCatalogEntry): boolean {
  const toolName = (entry.toolName ?? "").toLowerCase();
  return Boolean(entry.wrapperVisibility && !entry.wrapperVisibility.deterministic) || toolName.includes("search");
}

function buildMcpServerModeBlockedResponse(
  descriptorName: string,
  descriptor: McpServerModeToolDescriptor,
  blockers: string[],
): McpServerModeCallResponse {
  return {
    readOnly: true,
    mutationSemantics: "governed_tool_invocation",
    descriptorName,
    capabilityId: descriptor.capabilityId,
    outcome: "blocked",
    policyReason: blockers.join(" "),
    governance: buildMcpServerModeCallGovernance(),
    limitations: buildMcpServerModeCallLimitations(),
    evidence: {
      serverModeState: descriptor.serverModeState,
      gatewayCallable: descriptor.gatewayCallable,
      readOnlyHint: descriptor.annotations.readOnlyHint,
      destructiveHint: descriptor.annotations.destructiveHint,
      openWorldHint: descriptor.annotations.openWorldHint,
    },
  };
}

function buildMcpServerModeCallResponse(
  descriptorName: string,
  descriptor: McpServerModeToolDescriptor,
  result: ToolInvokeResult,
  toolName: string,
): McpServerModeCallResponse {
  return {
    readOnly: true,
    mutationSemantics: "governed_tool_invocation",
    descriptorName,
    capabilityId: descriptor.capabilityId,
    toolName,
    outcome: result.outcome,
    policyReason: result.policyReason,
    auditEventId: result.auditEventId,
    approvalId: result.approvalId,
    result: result.result,
    governance: buildMcpServerModeCallGovernance(),
    limitations: buildMcpServerModeCallLimitations(),
    evidence: {
      serverModeState: descriptor.serverModeState,
      gatewayCallable: descriptor.gatewayCallable,
      readOnlyHint: descriptor.annotations.readOnlyHint,
      destructiveHint: descriptor.annotations.destructiveHint,
      openWorldHint: descriptor.annotations.openWorldHint,
    },
  };
}

function buildMcpServerModeCallGovernance(): string[] {
  return [
    "This preview re-enters Gateway tool invocation, deny-wins policy, approval gates, and audit evidence.",
    "It does not grant unauthenticated or direct MCP protocol access.",
  ];
}

function buildMcpServerModeCallLimitations(): string[] {
  return [
    "Only read-only, closed-world Gateway tool descriptors are eligible.",
    "MCP protocol serving and stdio launch remain unavailable until separately implemented and proven.",
  ];
}

function buildServerModeInputSchema(entry: CapabilityCatalogEntry): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["agentId", "sessionId"],
    properties: {
      args: {
        type: "object",
        description: `Tool arguments passed through Gateway governance for ${entry.title}.`,
        additionalProperties: true,
      },
      agentId: { type: "string", description: "Calling agent identity recorded in Gateway policy/audit." },
      sessionId: { type: "string", description: "Gateway session id used for policy, approvals, and audit." },
      workspaceId: { type: "string" },
      taskId: { type: "string" },
      runId: { type: "string" },
      permissionProfileId: { type: "string" },
      localOperatorOverrideId: { type: "string" },
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
