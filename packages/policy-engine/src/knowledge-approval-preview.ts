import { createHash } from "node:crypto";
import { clampInt, redactSecretText, type ApprovalRequest, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { browserApprovalPreview } from "./browser-approval-preview.js";
import { toolActionApprovalPreview } from "./tool-action-approval-preview.js";
import { capabilityExplanationApprovalPreview } from "./capability-explanation-approval-preview.js";

const LOOKUP_LIMITS = new Map<string, { fallback: number; max: number }>([
  ["memory.search", { fallback: 12, max: 100 }],
  ["memory.read", { fallback: 5, max: 50 }],
  ["docs.search", { fallback: 8, max: 50 }],
  ["session.search", { fallback: 10, max: 50 }],
]);

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function lookupApprovalPreview(toolName: string, args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (toolName === "capabilities.explain") return capabilityExplanationApprovalPreview(args);
  if (toolName === "time.now") {
    return {
      reviewKind: "knowledge.operation",
      toolName,
      target: "GoatCitadel runtime clock",
      input: "Current local time and UTC",
      summary: "Read the current time for this conversation.",
    };
  }
  if (toolName === "gmail.read" || toolName === "calendar.list") {
    return googleWorkspaceLookupPreview(toolName, args);
  }
  if (toolName === "session.history") {
    const messageId = trimmedText(args.messageId);
    const sequence = clampInt(args.sequence, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!messageId || !sequence) return undefined;
    const sessionId = trimmedText(args.sessionId);
    return {
      reviewKind: "knowledge.operation",
      toolName,
      target: sessionId ? "The specified conversation in this workspace" : "This conversation",
      input: `Message ${redactSecretText(messageId).value}, sequence ${sequence}`,
      ...(sessionId ? { conversationSummary: redactSecretText(sessionId).value } : {}),
      optionsSummary: `Maximum messages: ${clampInt(args.limit, 21, 1, 101)}`,
      summary: "Return conversation excerpts around this message to the assistant.",
    };
  }
  const limits = LOOKUP_LIMITS.get(toolName);
  if (!limits) return undefined;
  const redact = (value: string) => redactSecretText(value, { env: process.env }).value;
  const query =
    trimmedText(args.query) ??
    (toolName === "memory.read" ? (trimmedText(args.title) ?? trimmedText(args.key)) : undefined);
  if ((!query && toolName !== "memory.read") || (toolName === "session.search" && (query?.length ?? 0) > 512)) {
    return undefined;
  }
  const namespace = trimmedText(args.namespace);
  const target =
    toolName === "session.search"
      ? trimmedText(args.scope) === "all"
        ? "Conversations in this workspace that are included in history"
        : "This conversation"
      : `${toolName.startsWith("memory.") ? "Memory" : "Knowledge"} namespace: ${namespace ? redact(namespace) : "all namespaces"}`;
  const limit = clampInt(typeof args.limit === "number" ? args.limit : undefined, limits.fallback, 1, limits.max);
  return {
    reviewKind: "knowledge.operation",
    toolName,
    target,
    ...(query ? { query: redact(query) } : {}),
    optionsSummary: `Maximum results: ${limit}`,
    summary: query
      ? "Return matching excerpts to the assistant."
      : "Return recent saved memory excerpts to the assistant.",
  };
}

/** Project only the selectors sent by the Gmail and Calendar read executors. */
function googleWorkspaceLookupPreview(
  toolName: "gmail.read" | "calendar.list",
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const connectionId = trimmedText(args.connectionId);
  if (!connectionId || connectionId.length > 160) return undefined;
  const redact = (value: string) => redactSecretText(value, { env: process.env }).value;
  const connection = `Google connection: ${redact(connectionId)}`;
  const gmail = toolName === "gmail.read";
  // Match the provider-facing limits rather than displaying values the executor clamps.
  const limit = clampInt(args.maxResults, 10, 1, gmail ? 25 : 100);
  const query = gmail ? trimmedText(args.query)?.slice(0, 512) : undefined;
  const calendar = gmail
    ? []
    : [
        `Calendar: ${trimmedText(args.calendarId) ?? "primary"}`,
        `From: ${trimmedText(args.fromIso) ?? "No lower bound"}`,
        `Until: ${trimmedText(args.toIso) ?? "No upper bound"}`,
      ];
  const source = [connection, ...calendar.map(redact)].join("\n");
  if (source.length > 1_200) return undefined;
  return {
    reviewKind: "knowledge.operation",
    toolName,
    target: gmail ? "Gmail messages" : "Google Calendar events",
    source,
    ...(query ? { query: redact(query) } : {}),
    optionsSummary: `Maximum results: ${limit}`,
    summary: gmail
      ? `${query ? "Search Gmail" : "List recent Gmail messages"} and return sender, subject, date and a short snippet.`
      : "List events from the selected Google Calendar within the recorded time window.",
  };
}

/** Rebuild the display preview for supported tool approvals saved without their action details. */
export function withLegacyToolApprovalPreview(approval: ApprovalRequest): ApprovalRequest {
  const { kind, linkage, payload, preview } = approval;
  if (
    linkage?.actionType !== "tool.invoke" ||
    linkage.toolName !== kind ||
    preview?.toolName !== kind ||
    preview.reviewKind !== undefined
  ) {
    return approval;
  }
  const actionPreview =
    lookupApprovalPreview(kind, payload) ??
    (preview.input === undefined ? browserApprovalPreview(kind, payload) : undefined) ??
    (preview.input === undefined &&
    preview.path === undefined &&
    preview.target === undefined &&
    preview.command === undefined
      ? toolActionApprovalPreview(kind, payload)
      : undefined);
  return actionPreview ? { ...approval, preview: { ...preview, ...actionPreview } } : approval;
}

/**
 * Plain scope wording for review. Raw workspace and session ids stay out of the sentence: the approval's
 * linkage (and the preview's own sessionId field) carries them for technical details.
 */
function knowledgeScopeSummary(request: ToolInvokeRequest, boundary: string): string {
  const origin = request.sessionId
    ? "Requested from a conversation in this workspace."
    : "Requested in this workspace, outside a conversation.";
  return `${origin} ${boundary}`;
}

/** Allowlisted review projection only: never copy executable args or metadata wholesale. */
export function knowledgeApprovalPreview(request: ToolInvokeRequest): Record<string, unknown> | undefined {
  const detail =
    lookupApprovalPreview(request.toolName, request.args) ?? toolActionApprovalPreview(request.toolName, request.args);
  if (detail !== undefined) {
    return { toolName: request.toolName, ...detail, sessionId: request.sessionId, taskId: request.taskId };
  }
  if (
    !["memory.write", "memory.upsert", "docs.ingest", "embeddings.index", "embeddings.query"].includes(request.toolName)
  )
    return undefined;
  const args = request.args;
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.length ? redactSecretText(value, { env: process.env }).value : fallback;
  const namespace = text(
    args.namespace,
    request.toolName.startsWith("embeddings.") ? "all namespaces" : "unspecified (runtime validation applies)",
  );
  if (!["memory.write", "memory.upsert"].includes(request.toolName)) {
    const profile =
      args.embeddingProfile && typeof args.embeddingProfile === "object"
        ? (args.embeddingProfile as Record<string, unknown>)
        : {};
    const chunking =
      args.chunking && typeof args.chunking === "object" ? (args.chunking as Record<string, unknown>) : {};
    const options = Object.entries({
      provider: profile.provider,
      model: profile.modelId,
      dimensions: profile.dimensions,
      profile: profile.profileId,
      targetCharacters: chunking.targetChars,
      overlapCharacters: chunking.overlapChars,
      maxChunks: chunking.maxChunks,
    })
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([key, value]) => `${key}: ${text(String(value), "unspecified")}`)
      .join("; ");
    return {
      reviewKind: "knowledge.operation",
      toolName: request.toolName,
      target: `Knowledge namespace: ${namespace}`,
      title: text(args.title, request.toolName),
      scopeSummary: knowledgeScopeSummary(request, "Namespace is a storage selector, not an authorization boundary."),
      ...(typeof args.query === "string" ? { query: text(args.query, "Empty query") } : {}),
      ...(typeof args.source === "string"
        ? {
            source: text(args.source, "Empty source"),
            sourceSummary: `Source type: ${text(args.sourceType, "unspecified")}`,
          }
        : {}),
      ...(typeof args.documentId === "string" ? { documentTarget: text(args.documentId, "unspecified") } : {}),
      summary:
        request.toolName === "docs.ingest"
          ? "Persist this exact source and its chunks, subject to source admission and path/network policy."
          : request.toolName === "embeddings.index"
            ? "Index selected documents; this may invoke an embedding provider and replace stored embeddings."
            : "Retrieve matching source excerpts; this may invoke an embedding provider and repair stored embeddings. Current source access remains authoritative.",
      optionsSummary: `Limit: ${typeof args.limit === "number" ? args.limit : "runtime default"}; force: ${args.force === true ? "yes" : "no"}. Secret-looking text is redacted; arbitrary metadata is withheld.`,
      ...(options ? { executionOptionsSummary: options } : {}),
    };
  }
  const preview: Record<string, unknown> = {
    toolName: request.toolName,
    sessionId: text(request.sessionId, "not supplied"),
    target: `Memory namespace: ${namespace}`,
    title: text(args.title, request.toolName),
    scopeSummary: knowledgeScopeSummary(
      request,
      "The namespace is the storage target; the workspace and conversation only identify who asked, not a separate storage boundary.",
    ),
    summary:
      "Approval permits this exact request to persist a memory document and indexed content. Admission is not proof of a saved document; execution and lifecycle policy still apply. Secret-looking content is redacted for review; arbitrary metadata is not displayed.",
  };
  if (typeof args.content === "string") {
    preview.content = text(args.content, "Empty content (runtime validation applies)");
    preview.contentSummary = `Exact original content: ${Buffer.byteLength(args.content, "utf8")} UTF-8 bytes; SHA-256 ${createHash("sha256").update(args.content).digest("hex")}. Redaction does not change approved executable arguments.`;
  }
  return preview;
}
