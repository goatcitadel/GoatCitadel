import {
  MCP_ELICITATION_LIMITS,
  type McpElicitationRequest,
  type McpElicitationResponseAction,
} from "@goatcitadel/contracts";
export function elicitationFixture(): McpElicitationRequest {
  const createdAt = "2026-09-30T00:00:00Z",
    owner = { operatorId: "operator", workspaceId: "workspace", surface: "mcp" as const };
  const source = {
    sourceType: "mcp_server" as const,
    serverId: "server",
    toolName: "inspect",
    transport: "stdio" as const,
  };
  const value = {
    type: "object",
    properties: {
      name: { type: "string", title: "Display name", minLength: 2, maxLength: 30 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      enabled: { type: "boolean" },
    },
    required: ["name"],
    additionalProperties: false,
  };
  const prompt = {
    text: "Choose display settings",
    charLength: 23,
    maxChars: 4096,
    truncated: false,
    redactedSecretCount: 0,
  };
  const schema = {
    value,
    byteLength: JSON.stringify(value).length,
    maxBytes: 16384,
    truncated: false,
    redactedSecretCount: 0,
  };
  const statusHistory = [
    { status: "pending" as const, reason: "Recorded", recordedAt: createdAt, auditEventId: "event-created" },
  ];
  return {
    elicitationId: "request-one",
    method: "elicitation/create",
    status: "pending",
    prompt,
    requestedSchema: schema,
    protocol: { method: "elicitation/create", message: prompt.text, requestedSchema: value },
    owner,
    source,
    policy: {
      redactionMode: "strict",
      sensitiveInformationAllowed: false,
      requiresOperatorResponse: true,
      transportBoundary: "gateway_local_mcp",
      remoteTransportSupport: "unchanged",
      limits: MCP_ELICITATION_LIMITS,
      governance: [],
    },
    audit: {
      auditEventIds: ["event-created"],
      createdAt,
      updatedAt: createdAt,
      reasonCodes: ["mcp_elicitation_created"],
    },
    evidence: {
      owner,
      source,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      statusHistory,
      prompt,
      requestedSchema: schema,
    },
    createdAt,
    updatedAt: createdAt,
  };
}
export function respondedFixture(
  request: McpElicitationRequest,
  action: McpElicitationResponseAction,
  content?: Record<string, unknown>,
): McpElicitationRequest {
  const updatedAt = "2026-09-30T00:00:01Z",
    status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
  const evidence: McpElicitationRequest["evidence"]["statusHistory"][number] = {
    status,
    previousStatus: "pending",
    reason: "Recorded",
    recordedAt: updatedAt,
    auditEventId: "event-response",
  };
  const audit = { ...request.audit, updatedAt, auditEventIds: [...request.audit.auditEventIds, "event-response"] };
  return {
    ...request,
    status,
    updatedAt,
    audit,
    evidence: { ...request.evidence, status, updatedAt, statusHistory: [...request.evidence.statusHistory, evidence] },
    response: {
      action,
      owner: request.owner,
      respondedAt: updatedAt,
      audit,
      evidence,
      content:
        content === undefined
          ? undefined
          : {
              value: content,
              byteLength: JSON.stringify(content).length,
              maxBytes: 16384,
              truncated: false,
              redactedSecretCount: 0,
            },
    },
  };
}
