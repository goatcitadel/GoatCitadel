import type {
  EgressDecision,
  InternalToolCallV1,
  InternalToolResultV1,
  SecretResolutionBoundary,
  ToolAuditRecord,
  ToolCapabilityPolicy,
  ToolErrorKind,
  ToolExecutionTrustLevel,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { ToolDefinition } from "./tool-registry.js";

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "openai_key", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g },
  { label: "generic_key", pattern: /\bkey-[a-zA-Z0-9]{20,}\b/g },
  { label: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { label: "assignment_secret", pattern: /\b[A-Z][A-Z0-9_]{2,}=\S{16,}\b/g },
  { label: "keychain_ref", pattern: /\bkeychain:[^\s"']+\b/g },
];

const TRUST_RESTRICTIVENESS: Record<ToolExecutionTrustLevel, number> = {
  trusted_operator: 0,
  trusted_workspace: 1,
  mixed_untrusted: 2,
  untrusted_external: 3,
};

export function resolveToolTrustLevel(request: {
  trustLevel?: ToolExecutionTrustLevel;
  sourceAttribution?: ReadonlyArray<{ trustLevel?: ToolExecutionTrustLevel }>;
}): ToolExecutionTrustLevel {
  let effectiveTrust = normalizeToolTrustLevel(request.trustLevel) ?? "trusted_operator";
  for (const source of request.sourceAttribution ?? []) {
    const sourceTrust = normalizeToolTrustLevel(source.trustLevel);
    if (sourceTrust && TRUST_RESTRICTIVENESS[sourceTrust] > TRUST_RESTRICTIVENESS[effectiveTrust]) {
      effectiveTrust = sourceTrust;
    }
  }
  return effectiveTrust;
}

export function deriveToolCapabilityPolicy(
  toolName: string,
  toolDef?: Pick<ToolDefinition, "category">,
): ToolCapabilityPolicy {
  const category = toolDef?.category;
  const startsWith = (prefix: string) => toolName.startsWith(prefix);
  const isBrowserRead =
    toolName === "browser.search" ||
    toolName === "browser.navigate" ||
    toolName === "browser.extract" ||
    toolName === "browser.screenshot";
  const isBrowserControl =
    toolName === "browser.interact" ||
    toolName.startsWith("browser.cookies.") ||
    toolName.startsWith("browser.storage.") ||
    toolName === "browser.context.configure";
  const isNetworkRead = toolName === "http.get" || isBrowserRead;
  const isNetworkWrite = toolName === "http.post" || toolName === "webhook.send";
  const mutatesFilesystem =
    toolName === "fs.write" ||
    toolName === "fs.move" ||
    toolName === "fs.delete" ||
    toolName === "artifacts.create" ||
    toolName === "documents.create" ||
    toolName === "presentations.create";
  const mutatesRemoteState =
    isNetworkWrite ||
    startsWith("gmail.send") ||
    startsWith("calendar.create_event") ||
    startsWith("channel.") ||
    startsWith("slack.") ||
    startsWith("discord.") ||
    startsWith("telegram.") ||
    startsWith("teams.") ||
    startsWith("whatsapp.") ||
    startsWith("imessage.") ||
    startsWith("mattermost.") ||
    startsWith("google-chat.") ||
    startsWith("line.") ||
    startsWith("nextcloud-talk.") ||
    startsWith("zalo") ||
    toolName.startsWith("git.") ||
    toolName === "mcp.invoke";
  const resolvesSecrets =
    toolName === "mcp.invoke" ||
    startsWith("gmail.") ||
    startsWith("calendar.") ||
    startsWith("channel.") ||
    startsWith("slack.") ||
    startsWith("discord.") ||
    startsWith("telegram.") ||
    startsWith("teams.") ||
    startsWith("whatsapp.") ||
    startsWith("imessage.") ||
    startsWith("mattermost.") ||
    startsWith("google-chat.") ||
    startsWith("line.") ||
    startsWith("nextcloud-talk.") ||
    startsWith("zalo");
  const executesProcess =
    toolName === "shell.exec" ||
    toolName === "shell.exec_background" ||
    toolName === "tests.run" ||
    toolName === "lint.run" ||
    toolName === "build.run";

  let family: ToolCapabilityPolicy["family"] = "other";
  if (toolName.startsWith("memory.")) family = "memory";
  else if (
    toolName === "fs.read" ||
    toolName === "file.read_range" ||
    toolName === "file.find" ||
    toolName === "code.search" ||
    toolName === "code.search_files" ||
    toolName === "fs.list" ||
    toolName === "fs.stat" ||
    toolName === "fs.copy"
  )
    family = "filesystem_read";
  else if (mutatesFilesystem) family = "filesystem_write";
  else if (isNetworkRead || category === "research") family = isBrowserRead ? "browser_read" : "network_read";
  else if (isNetworkWrite) family = "network_write";
  else if (executesProcess) family = "process_execution";
  else if (isBrowserControl) family = "browser_control";
  else if (toolName === "mcp.invoke") family = "mcp";
  else if (category === "comms") family = "comms";
  else if (category === "knowledge") family = "knowledge";
  else if (category === "git") family = "git";
  else if (category === "ops") family = "ops";

  return {
    toolName,
    family,
    usesNetwork:
      isNetworkRead || isNetworkWrite || family === "mcp" || category === "comms" || toolName === "docs.ingest",
    readsFilesystem: family === "filesystem_read" || toolName === "docs.ingest",
    mutatesFilesystem,
    mutatesRemoteState,
    resolvesSecrets,
    executesProcess,
    controlsBrowser: isBrowserControl,
    invokesMcp: toolName === "mcp.invoke",
    blocksUntrustedEscalation:
      mutatesFilesystem ||
      mutatesRemoteState ||
      resolvesSecrets ||
      executesProcess ||
      isBrowserControl ||
      toolName === "mcp.invoke",
  };
}

export function isUntrustedToolEscalation(
  trustLevel: ToolExecutionTrustLevel,
  capabilityPolicy: ToolCapabilityPolicy,
): boolean {
  return (
    (trustLevel === "untrusted_external" || trustLevel === "mixed_untrusted") &&
    capabilityPolicy.blocksUntrustedEscalation
  );
}

export function collectLeakDetections(value: unknown): string[] {
  const text = stringifyUnknown(value);
  const detections = new Set<string>();
  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      detections.add(label);
    }
  }
  return Array.from(detections.values()).sort();
}

export function sanitizeForModel<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForModel(entry)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    output[key] = sanitizeForModel(entry);
  }
  return output as T;
}

export const sanitizeForAudit = sanitizeForModel;

export function buildInternalToolCall(
  request: ToolInvokeRequest,
  capabilityPolicy: ToolCapabilityPolicy,
  createdAt: string,
): InternalToolCallV1 {
  return {
    version: "v1",
    toolName: request.toolName,
    args: sanitizeForModel(request.args),
    agentId: request.agentId,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    trustLevel: resolveToolTrustLevel(request),
    capabilityPolicy,
    authContext: {
      boundary: request.authContext?.boundary ?? defaultSecretBoundaryForTool(request.toolName),
      secretRefs: [...(request.authContext?.secretRefs ?? [])],
    },
    sourceAttribution: request.sourceAttribution?.map((item) => ({
      sourceType: item.sourceType,
      sourceRef: item.sourceRef,
      title: item.title,
      backend: item.backend,
      ...(item.trustLevel ? { trustLevel: item.trustLevel } : {}),
    })),
    createdAt,
  };
}

export function buildInternalToolResult(input: {
  toolName: string;
  outcome: InternalToolResultV1["outcome"];
  errorKind?: ToolErrorKind;
  result?: Record<string, unknown>;
  leakDetections?: string[];
  egressDecisions?: EgressDecision[];
  completedAt: string;
}): InternalToolResultV1 {
  return {
    version: "v1",
    toolName: input.toolName,
    outcome: input.outcome,
    errorKind: input.errorKind,
    result: input.result ? sanitizeForModel(input.result) : undefined,
    leakDetections: [...(input.leakDetections ?? [])],
    egressDecisions: input.egressDecisions,
    completedAt: input.completedAt,
  };
}

export function buildToolAuditRecord(input: {
  auditEventId: string;
  request: ToolInvokeRequest;
  outcome: ToolAuditRecord["outcome"];
  policyReason: string;
  reasonCodes?: string[];
  startedAt: string;
  completedAt: string;
  approvalId?: string;
  matchedGrantId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  approvalMode?: ToolAuditRecord["approvalMode"];
  errorKind?: ToolErrorKind;
}): ToolAuditRecord {
  return {
    auditEventId: input.auditEventId,
    toolName: input.request.toolName,
    agentId: input.request.agentId,
    sessionId: input.request.sessionId,
    workspaceId: input.request.workspaceId,
    taskId: input.request.taskId,
    trustLevel: resolveToolTrustLevel(input.request),
    outcome: input.outcome,
    policyReason: input.policyReason,
    reasonCodes: input.reasonCodes,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    approvalId: input.approvalId,
    matchedGrantId: input.matchedGrantId,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    approvalMode: input.approvalMode,
    errorKind: input.errorKind,
  };
}

function sanitizeString(value: string): string {
  let scrubbed = value;
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

function normalizeToolTrustLevel(value: unknown): ToolExecutionTrustLevel | undefined {
  return value === "trusted_operator" ||
    value === "trusted_workspace" ||
    value === "mixed_untrusted" ||
    value === "untrusted_external"
    ? value
    : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function defaultSecretBoundaryForTool(toolName: string): SecretResolutionBoundary {
  if (
    toolName.startsWith("gmail.") ||
    toolName.startsWith("calendar.") ||
    toolName.startsWith("channel.") ||
    toolName.startsWith("slack.") ||
    toolName.startsWith("discord.") ||
    toolName.startsWith("telegram.") ||
    toolName.startsWith("teams.") ||
    toolName.startsWith("whatsapp.") ||
    toolName.startsWith("imessage.") ||
    toolName.startsWith("mattermost.") ||
    toolName.startsWith("google-chat.") ||
    toolName.startsWith("line.") ||
    toolName.startsWith("nextcloud-talk.") ||
    toolName.startsWith("zalo") ||
    toolName === "mcp.invoke"
  ) {
    return "tool_host_boundary";
  }
  return "provider_boundary";
}
