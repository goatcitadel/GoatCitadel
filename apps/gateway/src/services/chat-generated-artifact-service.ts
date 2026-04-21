import { createHash, randomUUID } from "node:crypto";
import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactReference,
  ChatGeneratedArtifactSourceSurface,
  ChatSessionRecord,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface ChatGeneratedArtifactHost {
  readonly storage: Pick<Storage, "chatGeneratedArtifacts" | "chatSessionPrefs" | "chatTurnTraces" | "gatewaySql">;
  requireChatSession(sessionId: string): ChatSessionRecord;
}

export function listChatGeneratedArtifacts(
  host: ChatGeneratedArtifactHost,
  input: {
    sessionId?: string;
    workspaceId?: string;
    sourceSurface?: ChatGeneratedArtifactSourceSurface;
    kind?: ChatGeneratedArtifactKind;
    limit?: number;
  } = {},
): ChatGeneratedArtifactRecord[] {
  if (input.sessionId?.trim()) {
    host.requireChatSession(input.sessionId.trim());
    return host.storage.chatGeneratedArtifacts.listBySession(input.sessionId.trim(), input.limit ?? 300);
  }
  return host.storage.chatGeneratedArtifacts.listVisible({
    workspaceId: input.workspaceId?.trim() || undefined,
    sourceSurface: input.sourceSurface,
    kind: input.kind,
    limit: input.limit ?? 500,
  });
}

export function getChatGeneratedArtifact(
  host: ChatGeneratedArtifactHost,
  artifactId: string,
): ChatGeneratedArtifactRecord {
  const normalizedArtifactId = artifactId.trim();
  if (!normalizedArtifactId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "artifactId" });
  }
  const artifact = host.storage.chatGeneratedArtifacts.get(normalizedArtifactId);
  host.requireChatSession(artifact.sessionId);
  return artifact;
}

export function createChatGeneratedArtifactFromTurn(
  host: ChatGeneratedArtifactHost,
  input: {
    sessionId: string;
    turnId: string;
    supersedeLatest?: boolean;
  },
): ChatGeneratedArtifactRecord {
  const sessionId = input.sessionId.trim();
  const turnId = input.turnId.trim();
  if (!sessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  if (!turnId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
  }
  const session = host.requireChatSession(sessionId);
  const trace = host.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new ValidationError({ message: `Turn ${turnId} does not belong to session ${sessionId}.` });
  }
  if (!trace.assistantMessageId) {
    throw new ValidationError({ message: "Artifacts can only be created from assistant turns." });
  }
  const prefs = host.storage.chatSessionPrefs.ensure(sessionId);
  const sourceSurface = prefs.mode;
  const turnArtifacts = host.storage.chatGeneratedArtifacts.listByTurn(turnId, 50);
  const latestSameTurnArtifact = turnArtifacts[0];
  if (!input.supersedeLatest && latestSameTurnArtifact) {
    return latestSameTurnArtifact;
  }
  const assistantText = resolveAssistantTextFromTrace(host, turnId);
  const inferred = inferGeneratedArtifactFromAssistantText(assistantText);
  const now = new Date().toISOString();
  const nextVersion =
    input.supersedeLatest && latestSameTurnArtifact ? Math.max(1, latestSameTurnArtifact.version + 1) : 1;
  const artifactId = input.supersedeLatest
    ? randomUUID()
    : buildStableGeneratedArtifactId(turnId, inferred.kind, inferred.contentHash, inferred.sourceBlockIndex);
  try {
    return host.storage.chatGeneratedArtifacts.create({
      artifactId,
      sessionId,
      workspaceId: session.workspaceId,
      turnId,
      title: inferred.title,
      kind: inferred.kind,
      content: inferred.content,
      language: inferred.language,
      sourceSurface,
      version: nextVersion,
      supersedesArtifactId: input.supersedeLatest ? latestSameTurnArtifact?.artifactId : undefined,
      providerId: trace.routing.effectiveProviderId ?? trace.routing.primaryProviderId,
      model: trace.routing.effectiveModel ?? trace.routing.primaryModel ?? trace.model,
      sourceBlockIndex: inferred.sourceBlockIndex,
      contentHash: inferred.contentHash,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (!input.supersedeLatest) {
      const currentArtifact = host.storage.chatGeneratedArtifacts.listByTurn(turnId, 50)[0];
      if (currentArtifact) {
        return currentArtifact;
      }
    }
    throw error;
  }
}

export function buildGeneratedArtifactReference(artifact: ChatGeneratedArtifactRecord): ChatGeneratedArtifactReference {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    sourceSurface: artifact.sourceSurface,
    version: artifact.version,
    supersedesArtifactId: artifact.supersedesArtifactId,
    turnId: artifact.turnId,
    language: artifact.language,
    providerId: artifact.providerId,
    model: artifact.model,
    sourceBlockIndex: artifact.sourceBlockIndex,
    contentHash: artifact.contentHash,
    createdAt: artifact.createdAt,
  };
}

export function attachGeneratedArtifactsToThreadTurns(
  turns: ChatThreadTurnRecord[],
  artifactsByTurnId: Map<string, ChatGeneratedArtifactRecord[]>,
): ChatThreadTurnRecord[] {
  return turns.map((turn) => ({
    ...turn,
    generatedArtifacts: (artifactsByTurnId.get(turn.turnId) ?? []).map(buildGeneratedArtifactReference),
  }));
}

function resolveAssistantTextFromTrace(host: ChatGeneratedArtifactHost, turnId: string): string {
  const trace = host.storage.chatTurnTraces.get(turnId);
  const assistantMessageId = trace.assistantMessageId?.trim();
  if (!assistantMessageId) {
    throw new ValidationError({ message: "Assistant output is missing for this turn." });
  }
  const result = host.storage.gatewaySql
    .prepare("SELECT content FROM chat_messages WHERE message_id = ? LIMIT 1")
    .get(assistantMessageId) as { content?: string } | undefined;
  const content = typeof result?.content === "string" ? result.content.trim() : "";
  if (!content) {
    throw new ValidationError({ message: "Assistant output is empty for this turn." });
  }
  return content;
}

function inferGeneratedArtifactFromAssistantText(input: string): {
  title: string;
  kind: ChatGeneratedArtifactKind;
  content: string;
  language?: string;
  sourceBlockIndex?: number;
  contentHash: string;
} {
  const fencedBlocks = [...input.matchAll(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g)];
  const mermaidMatch = fencedBlocks.find((entry) => (entry[1] ?? "").trim().toLowerCase() === "mermaid");
  if (mermaidMatch?.[2]?.trim()) {
    return withArtifactContentHash({
      title: "Mermaid diagram",
      kind: "mermaid",
      content: mermaidMatch[2].trim(),
      language: "mermaid",
      sourceBlockIndex: fencedBlocks.indexOf(mermaidMatch),
    });
  }

  const htmlMatch = fencedBlocks.find((entry) => (entry[1] ?? "").trim().toLowerCase() === "html");
  if (htmlMatch?.[2]?.trim()) {
    return withArtifactContentHash({
      title: "HTML preview",
      kind: "html",
      content: htmlMatch[2].trim(),
      language: "html",
      sourceBlockIndex: fencedBlocks.indexOf(htmlMatch),
    });
  }
  if (/<(?:!doctype\s+html|html|body|div|main|section|article|table|svg)[\s>]/i.test(input.trim())) {
    return withArtifactContentHash({
      title: "HTML preview",
      kind: "html",
      content: input.trim(),
      language: "html",
    });
  }

  const firstCode = fencedBlocks.find(
    (entry) => (entry[1] ?? "").trim().toLowerCase() !== "mermaid" && (entry[1] ?? "").trim().toLowerCase() !== "html",
  );
  if (firstCode?.[2]?.trim()) {
    const language = (firstCode[1] ?? "").trim() || undefined;
    return withArtifactContentHash({
      title: language ? `${language.toUpperCase()} snippet` : "Code snippet",
      kind: "code",
      content: firstCode[2].trim(),
      language,
      sourceBlockIndex: fencedBlocks.indexOf(firstCode),
    });
  }

  if (looksLikeMarkdown(input)) {
    return withArtifactContentHash({
      title: "Markdown draft",
      kind: "markdown",
      content: input.trim(),
      language: "markdown",
    });
  }

  return withArtifactContentHash({
    title: "Generated note",
    kind: "text",
    content: input.trim(),
    language: "text",
  });
}

function looksLikeMarkdown(value: string): boolean {
  const sample = value.trim();
  if (!sample) {
    return false;
  }
  return /(^#|\n#|\n- |\n\d+\. |\n> |\n```|\[[^\]]+\]\([^)]+\)|\|.+\|)/m.test(sample);
}

function withArtifactContentHash(input: {
  title: string;
  kind: ChatGeneratedArtifactKind;
  content: string;
  language?: string;
  sourceBlockIndex?: number;
}): {
  title: string;
  kind: ChatGeneratedArtifactKind;
  content: string;
  language?: string;
  sourceBlockIndex?: number;
  contentHash: string;
} {
  return {
    ...input,
    contentHash: createHash("sha256").update(input.content).digest("hex"),
  };
}

function buildStableGeneratedArtifactId(
  turnId: string,
  kind: ChatGeneratedArtifactKind,
  contentHash: string,
  sourceBlockIndex?: number,
): string {
  const digest = createHash("sha256")
    .update(`${turnId}:${kind}:${sourceBlockIndex ?? "root"}:${contentHash}`)
    .digest("hex");
  return `gart_${digest.slice(0, 24)}`;
}
