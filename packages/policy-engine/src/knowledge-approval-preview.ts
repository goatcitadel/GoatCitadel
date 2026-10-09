import { createHash } from "node:crypto";
import { redactSecretText, type ToolInvokeRequest } from "@goatcitadel/contracts";

/** Allowlisted review projection only: never copy executable args or metadata wholesale. */
export function knowledgeApprovalPreview(request: ToolInvokeRequest): Record<string, unknown> | undefined {
  if (!["memory.write", "memory.upsert", "docs.ingest", "embeddings.index", "embeddings.query"].includes(request.toolName)) return undefined;
  const args = request.args;
  const text = (value: unknown, fallback: string) => typeof value === "string" && value.length ? redactSecretText(value, { env: process.env }).value : fallback;
  const namespace = text(args.namespace, request.toolName.startsWith("embeddings.") ? "all namespaces" : "unspecified (runtime validation applies)");
  if (!["memory.write", "memory.upsert"].includes(request.toolName)) {
    const profile = args.embeddingProfile && typeof args.embeddingProfile === "object" ? args.embeddingProfile as Record<string, unknown> : {};
    const chunking = args.chunking && typeof args.chunking === "object" ? args.chunking as Record<string, unknown> : {};
    const options = Object.entries({ provider: profile.provider, model: profile.modelId, dimensions: profile.dimensions, profile: profile.profileId, targetCharacters: chunking.targetChars, overlapCharacters: chunking.overlapChars, maxChunks: chunking.maxChunks }).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => `${key}: ${text(String(value), "unspecified")}`).join("; ");
    return {
      reviewKind: "knowledge.operation", toolName: request.toolName,
      target: `Knowledge namespace: ${namespace}`,
      title: text(args.title, request.toolName),
      scopeSummary: `Workspace: ${text(request.workspaceId, "not supplied")}; conversation: ${text(request.sessionId, "not supplied")}. Namespace is a storage selector, not an authorization boundary.`,
      ...(typeof args.query === "string" ? { query: text(args.query, "Empty query") } : {}),
      ...(typeof args.source === "string" ? { source: text(args.source, "Empty source"), sourceSummary: `Source type: ${text(args.sourceType, "unspecified")}` } : {}),
      ...(typeof args.documentId === "string" ? { documentTarget: text(args.documentId, "unspecified") } : {}),
      summary: request.toolName === "docs.ingest" ? "Persist this exact source and its chunks, subject to source admission and path/network policy." : request.toolName === "embeddings.index" ? "Index selected documents; this may invoke an embedding provider and replace stored embeddings." : "Retrieve matching source excerpts; this may invoke an embedding provider and repair stored embeddings. Current source access remains authoritative.",
      optionsSummary: `Limit: ${typeof args.limit === "number" ? args.limit : "runtime default"}; force: ${args.force === true ? "yes" : "no"}. Secret-looking text is redacted; arbitrary metadata is withheld.`,
      ...(options ? { executionOptionsSummary: options } : {}),
    };
  }
  const preview: Record<string, unknown> = {
    toolName: request.toolName,
    sessionId: text(request.sessionId, "not supplied"),
    target: `Memory namespace: ${namespace}`,
    title: text(args.title, request.toolName),
    scopeSummary: `Workspace: ${text(request.workspaceId, "not supplied")}; session: ${text(request.sessionId, "not supplied")}. Namespace is the storage target; workspace/session identify the requesting context, not a separate storage boundary.`,
    summary: "Approval permits this exact request to persist a memory document and indexed content. Admission is not proof of a saved document; execution and lifecycle policy still apply. Secret-looking content is redacted for review; arbitrary metadata is not displayed.",
  };
  if (typeof args.content === "string") {
    preview.content = text(args.content, "Empty content (runtime validation applies)");
    preview.contentSummary = `Exact original content: ${Buffer.byteLength(args.content, "utf8")} UTF-8 bytes; SHA-256 ${createHash("sha256").update(args.content).digest("hex")}. Redaction does not change approved executable arguments.`;
  }
  return preview;
}
