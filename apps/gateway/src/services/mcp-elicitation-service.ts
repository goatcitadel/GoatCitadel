import { randomUUID } from "node:crypto";
import {
  MCP_ELICITATION_LIMITS,
  type McpElicitationAuditMetadata,
  type McpElicitationBoundedJsonBody,
  type McpElicitationBoundedTextBody,
  type McpElicitationOwnerMetadata,
  type McpElicitationPolicyMetadata,
  type McpElicitationRequest,
  type McpElicitationResponse,
  type McpElicitationResponseAction,
  type McpElicitationSourceMetadata,
  type McpElicitationSourceType,
  type McpElicitationStatus,
  type McpElicitationStatusEvidence,
  type McpTransport,
  type PermissionSurface,
} from "@goatcitadel/contracts";

export const MCP_ROUTE_ELICITATION_LIMITS = MCP_ELICITATION_LIMITS;

export interface McpElicitationCreateInput {
  prompt: string;
  requestedSchema: Record<string, unknown>;
  owner?: McpElicitationOwnerMetadata;
  source?: Partial<McpElicitationSourceMetadata>;
  serverId?: string;
  toolName?: string;
  jsonRpcRequestId?: string | number;
  transport?: McpTransport;
}

export interface McpElicitationRespondInput {
  action: McpElicitationResponseAction;
  content?: Record<string, unknown>;
  owner?: McpElicitationOwnerMetadata;
}

export interface McpElicitationListFilter {
  status?: McpElicitationStatus;
  serverId?: string;
  sessionId?: string;
}

export class McpElicitationServiceError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export class McpElicitationService {
  private readonly requests = new Map<string, McpElicitationRequest>();

  public createRequest(input: McpElicitationCreateInput): McpElicitationRequest {
    const now = new Date().toISOString();
    const elicitationId = `mcp-elicit-${randomUUID()}`;
    const prompt = buildBoundedPrompt(input.prompt);
    const requestedSchema = buildBoundedJsonBody(
      input.requestedSchema,
      MCP_ROUTE_ELICITATION_LIMITS.requestedSchemaMaxBytes,
      "requestedSchema",
    );
    const owner = normalizeOwner(input.owner);
    const source = normalizeSource(input);
    const createdAuditEventId = buildAuditEventId(elicitationId, "created");
    const audit = buildAudit({
      auditEventIds: [createdAuditEventId],
      createdAt: now,
      updatedAt: now,
      actor: owner.operatorId ?? owner.agentId,
      reasonCodes: ["mcp_elicitation_created", "gateway_route_local_evidence"],
    });
    const statusEvidence = buildStatusEvidence({
      status: "pending",
      reason: "MCP elicitation request recorded by the Gateway route before operator response.",
      recordedAt: now,
      auditEventId: createdAuditEventId,
    });
    const request: McpElicitationRequest = {
      elicitationId,
      method: "elicitation/create",
      status: "pending",
      prompt,
      requestedSchema,
      protocol: {
        method: "elicitation/create",
        message: prompt.text,
        requestedSchema: requestedSchema.value,
      },
      owner,
      source,
      policy: buildPolicyMetadata(),
      audit,
      evidence: {
        owner,
        source,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        statusHistory: [statusEvidence],
        prompt: summarizeTextBody(prompt),
        requestedSchema: summarizeJsonBody(requestedSchema),
      },
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(elicitationId, request);
    return request;
  }

  public listRequests(filter: McpElicitationListFilter = {}): McpElicitationRequest[] {
    return [...this.requests.values()]
      .filter((request) => (filter.status ? request.status === filter.status : true))
      .filter((request) => (filter.serverId ? request.source.serverId === filter.serverId : true))
      .filter((request) => (filter.sessionId ? request.owner.sessionId === filter.sessionId : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MCP_ROUTE_ELICITATION_LIMITS.listMaxItems);
  }

  public respondToRequest(elicitationId: string, input: McpElicitationRespondInput): McpElicitationRequest {
    const existing = this.requests.get(elicitationId);
    if (!existing) {
      throw new McpElicitationServiceError("Unknown MCP elicitation request.", 404);
    }
    if (existing.status !== "pending") {
      throw new McpElicitationServiceError("MCP elicitation request has already been resolved.", 409);
    }
    if (input.action === "accept" && !input.content) {
      throw new McpElicitationServiceError("MCP elicitation accept responses require bounded content.", 400);
    }
    if (input.action !== "accept" && input.content !== undefined) {
      throw new McpElicitationServiceError("MCP elicitation decline/cancel responses must not include content.", 400);
    }

    const now = new Date().toISOString();
    const nextStatus = statusForAction(input.action);
    const responseContent =
      input.action === "accept"
        ? buildBoundedJsonBody(
            input.content ?? {},
            MCP_ROUTE_ELICITATION_LIMITS.responseContentMaxBytes,
            "responseContent",
          )
        : undefined;
    const owner = normalizeOwner(input.owner);
    const auditEventId = buildAuditEventId(elicitationId, input.action);
    const responseEvidence = buildStatusEvidence({
      status: nextStatus,
      previousStatus: existing.status,
      reason: `MCP elicitation ${input.action} response recorded by Gateway route storage.`,
      recordedAt: now,
      auditEventId,
    });
    const response: McpElicitationResponse = {
      action: input.action,
      content: responseContent,
      owner,
      respondedAt: now,
      audit: buildAudit({
        auditEventIds: [...existing.audit.auditEventIds, auditEventId],
        createdAt: existing.audit.createdAt,
        updatedAt: now,
        actor: owner.operatorId ?? owner.agentId,
        reasonCodes: ["mcp_elicitation_responded", `mcp_elicitation_${input.action}`],
      }),
      evidence: responseEvidence,
    };
    const updated: McpElicitationRequest = {
      ...existing,
      status: nextStatus,
      response,
      audit: {
        ...existing.audit,
        auditEventIds: [...existing.audit.auditEventIds, auditEventId],
        updatedBy: owner.operatorId ?? owner.agentId ?? existing.audit.updatedBy,
        updatedAt: now,
        reasonCodes: [...existing.audit.reasonCodes, "mcp_elicitation_responded", `mcp_elicitation_${input.action}`],
      },
      evidence: {
        ...existing.evidence,
        status: nextStatus,
        updatedAt: now,
        statusHistory: [...existing.evidence.statusHistory, responseEvidence],
        responseContent: responseContent ? summarizeJsonBody(responseContent) : undefined,
      },
      updatedAt: now,
    };
    this.requests.set(elicitationId, updated);
    return updated;
  }
}

function buildBoundedPrompt(prompt: string): McpElicitationBoundedTextBody {
  const redacted = redactSecrets(prompt);
  const maxChars = MCP_ROUTE_ELICITATION_LIMITS.promptMaxChars;
  const truncated = redacted.value.length > maxChars;
  const text = truncated ? `${redacted.value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[prompt truncated]` : redacted.value;
  return {
    text,
    charLength: text.length,
    maxChars,
    truncated,
    redactedSecretCount: redacted.count,
  };
}

function buildBoundedJsonBody(
  body: Record<string, unknown>,
  maxBytes: number,
  label: string,
): McpElicitationBoundedJsonBody {
  const redaction = { count: 0 };
  const sanitized = sanitizeJsonValue(body, redaction) as Record<string, unknown>;
  const byteLength = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (byteLength > maxBytes) {
    throw new McpElicitationServiceError(`MCP elicitation ${label} exceeded ${maxBytes} bytes.`, 413);
  }
  return {
    value: sanitized,
    byteLength,
    maxBytes,
    truncated: false,
    redactedSecretCount: redaction.count,
  };
}

function sanitizeJsonValue(value: unknown, redaction: { count: number }): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    redaction.count += redacted.count;
    return redacted.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, redaction));
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeJsonValue(child, redaction);
    }
    return sanitized;
  }
  return value;
}

function redactSecrets(value: string): { value: string; count: number } {
  let count = 0;
  const replace = () => {
    count += 1;
    return "[REDACTED]";
  };
  const redacted = value
    .replace(/\b(Bearer|token|api[-_]?key|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}/gi, () =>
      replace(),
    )
    .replace(/\bauthorization\s*:\s*Bearer\s+\S+/gi, () => replace())
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => replace())
    .replace(
      /\b(?=[A-Za-z0-9_.-]*(?:secret|token|api[-_]?key))(?=[A-Za-z0-9_.-]*[-_])(?=[A-Za-z0-9_.-]{16,}\b)[A-Za-z0-9_.-]+\b/gi,
      () => replace(),
    )
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{12,}@/g, () => `${replace()}@`)
    .replace(/sk-[A-Za-z0-9]{20,}/g, () => replace());
  return { value: redacted, count };
}

function normalizeOwner(owner: McpElicitationOwnerMetadata | undefined): McpElicitationOwnerMetadata {
  return {
    operatorId: normalizeString(owner?.operatorId),
    agentId: normalizeString(owner?.agentId),
    workspaceId: normalizeString(owner?.workspaceId),
    sessionId: normalizeString(owner?.sessionId),
    taskId: normalizeString(owner?.taskId),
    runId: normalizeString(owner?.runId),
    surface: normalizeSurface(owner?.surface),
  };
}

function normalizeSource(input: McpElicitationCreateInput): McpElicitationSourceMetadata {
  return {
    sourceType: normalizeSourceType(input.source?.sourceType),
    serverId: normalizeString(input.source?.serverId ?? input.serverId),
    toolName: normalizeString(input.source?.toolName ?? input.toolName),
    jsonRpcRequestId: input.source?.jsonRpcRequestId ?? input.jsonRpcRequestId,
    transport: input.source?.transport ?? input.transport,
    sourceRef: normalizeString(input.source?.sourceRef),
  };
}

function normalizeSourceType(sourceType: McpElicitationSourceType | undefined): McpElicitationSourceType {
  return sourceType ?? "mcp_server";
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSurface(value: PermissionSurface | undefined): PermissionSurface | undefined {
  return value;
}

function buildPolicyMetadata(): McpElicitationPolicyMetadata {
  return {
    redactionMode: "strict",
    sensitiveInformationAllowed: false,
    requiresOperatorResponse: true,
    transportBoundary: "gateway_local_mcp",
    remoteTransportSupport: "unchanged",
    limits: MCP_ROUTE_ELICITATION_LIMITS,
    governance: [
      "MCP elicitation is recorded at the Gateway route boundary before operator response.",
      "MCP servers must not request sensitive information through elicitation.",
      "Local MCP transport, deny-wins policy, approval gates, network allowlists, and audit posture remain unchanged.",
      "This route does not claim direct or unauthenticated remote MCP protocol support.",
    ],
  };
}

function buildAudit(input: {
  auditEventIds: string[];
  createdAt: string;
  updatedAt: string;
  actor?: string;
  reasonCodes: string[];
}): McpElicitationAuditMetadata {
  return {
    auditEventIds: input.auditEventIds,
    createdBy: input.actor,
    updatedBy: input.actor,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    reasonCodes: input.reasonCodes,
  };
}

function buildStatusEvidence(input: {
  status: McpElicitationStatus;
  previousStatus?: McpElicitationStatus;
  reason: string;
  recordedAt: string;
  auditEventId: string;
}): McpElicitationStatusEvidence {
  return {
    status: input.status,
    previousStatus: input.previousStatus,
    reason: input.reason,
    recordedAt: input.recordedAt,
    auditEventId: input.auditEventId,
  };
}

function buildAuditEventId(elicitationId: string, action: string): string {
  return `gateway:mcp:elicitation:${elicitationId}:${action}`;
}

function summarizeTextBody(
  body: McpElicitationBoundedTextBody,
): Pick<McpElicitationBoundedTextBody, "charLength" | "maxChars" | "truncated" | "redactedSecretCount"> {
  return {
    charLength: body.charLength,
    maxChars: body.maxChars,
    truncated: body.truncated,
    redactedSecretCount: body.redactedSecretCount,
  };
}

function summarizeJsonBody(
  body: McpElicitationBoundedJsonBody,
): Pick<McpElicitationBoundedJsonBody, "byteLength" | "maxBytes" | "truncated" | "redactedSecretCount"> {
  return {
    byteLength: body.byteLength,
    maxBytes: body.maxBytes,
    truncated: body.truncated,
    redactedSecretCount: body.redactedSecretCount,
  };
}

function statusForAction(action: McpElicitationResponseAction): McpElicitationStatus {
  if (action === "accept") {
    return "accepted";
  }
  if (action === "decline") {
    return "declined";
  }
  return "cancelled";
}
