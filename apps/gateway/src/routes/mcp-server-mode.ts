import type {
  CapabilityCatalogEntry,
  McpServerModeCallResponse,
  McpServerModeManifestResponse,
  McpServerModeToolDescriptor,
  ToolInvokeResult,
} from "@goatcitadel/contracts";

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
    runtimeSupport: callPreviewAvailable ? "stdio_proxy" : "manifest_only",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: callPreviewAvailable
        ? "Launches the stdio MCP protocol proxy, which re-enters authenticated Gateway server-mode manifest and call-preview endpoints."
        : "Launches the stdio MCP protocol proxy for manifest listing; tools/call remains unavailable until Gateway tool invocation services are exposed.",
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
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: callPreviewAvailable
          ? "The stdio proxy is shipped as a launcher command; it lists and calls only read-only, closed-world Gateway descriptors through authenticated Gateway APIs."
          : "The stdio proxy is shipped as a launcher command; this runtime can list the manifest but cannot execute tools/call until Gateway tool invocation services are present.",
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
      "The stdio server is a Gateway-backed proxy, not a standalone Gateway-free MCP server.",
      "The stdio proxy and HTTP call preview are limited to read-only, closed-world Gateway tool descriptors and require Gateway authentication.",
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

export function isMcpServerModeCallPreviewAvailable(services: {
  tools?: { resolveToolPolicyContext?: unknown };
  toolsInvoke?: { invokeTool?: unknown };
}): boolean {
  return (
    typeof services.tools?.resolveToolPolicyContext === "function" &&
    typeof services.toolsInvoke?.invokeTool === "function"
  );
}

export function findServerModeToolDescriptor(
  callableCatalog: CapabilityCatalogEntry[],
  descriptorName: string,
): McpServerModeToolDescriptor | undefined {
  return callableCatalog
    .map((entry) => buildServerModeToolDescriptor(entry, true))
    .find((descriptor) => descriptor.name === descriptorName);
}

export function isServerModeDescriptorCallablePreview(descriptor: McpServerModeToolDescriptor): boolean {
  return (
    descriptor.serverModeState === "call_preview" &&
    descriptor.gatewayCallable &&
    descriptor.annotations.readOnlyHint &&
    !descriptor.annotations.destructiveHint &&
    !descriptor.annotations.openWorldHint
  );
}

export function buildMcpServerModeBlockedResponse(
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

export function buildMcpServerModeCallResponse(
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
      ? "Eligible for the operator-authenticated server-mode stdio proxy and HTTP call preview."
      : eligibleForCallPreview
        ? "Descriptor can be listed through the stdio proxy, but this runtime has not exposed Gateway tool invocation for tools/call."
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
        ? [
            "Only the Gateway-backed stdio proxy and HTTP call preview are available; no standalone MCP server is exposed.",
          ]
        : eligibleForCallPreview
          ? [
              "MCP server-mode tools/call is not available in this runtime because Gateway tool invocation is not exposed.",
            ]
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

function isCapabilityEntryCallPreviewEligible(entry: CapabilityCatalogEntry): boolean {
  return (
    entry.kind === "tool" &&
    Boolean(entry.toolName) &&
    entry.callable &&
    Boolean(entry.wrapperVisibility?.readOnly) &&
    !isServerModeOpenWorldCapability(entry)
  );
}

function isServerModeOpenWorldCapability(entry: CapabilityCatalogEntry): boolean {
  const toolName = (entry.toolName ?? "").toLowerCase();
  return Boolean(entry.wrapperVisibility && !entry.wrapperVisibility.deterministic) || toolName.includes("search");
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
    "The MCP stdio path is a Gateway-backed proxy; it is not a standalone Gateway-free server.",
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
