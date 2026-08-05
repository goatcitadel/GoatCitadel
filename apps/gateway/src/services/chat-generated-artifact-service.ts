import { createHash } from "node:crypto";
import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactReference,
  ChatGeneratedArtifactSourceSurface,
  ChatSessionRecord,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { redactStructuredSecrets, ValidationError } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export interface ChatGeneratedArtifactDependencies {
  readonly storage: Pick<Storage, "chatGeneratedArtifacts" | "chatTurnTraces" | "gatewaySql">;
  requireChatSession(sessionId: string): Promise<ChatSessionRecord>;
}

export async function listChatGeneratedArtifacts(
  deps: ChatGeneratedArtifactDependencies,
  input: {
    sessionId?: string;
    workspaceId?: string;
    projectId?: string;
    sourceSurface?: ChatGeneratedArtifactSourceSurface;
    kind?: ChatGeneratedArtifactKind;
    limit?: number;
  } = {},
): Promise<ChatGeneratedArtifactRecord[]> {
  if (input.sessionId?.trim()) {
    await deps.requireChatSession(input.sessionId.trim());
    return await deps.storage.chatGeneratedArtifacts.listBySession(input.sessionId.trim(), input.limit ?? 300);
  }
  return await deps.storage.chatGeneratedArtifacts.listVisible({
    workspaceId: input.workspaceId?.trim() || undefined,
    projectId: input.projectId?.trim() || undefined,
    sourceSurface: input.sourceSurface,
    kind: input.kind,
    limit: input.limit ?? 500,
  });
}

export async function getChatGeneratedArtifact(
  deps: ChatGeneratedArtifactDependencies,
  artifactId: string,
  options: { workspaceId: string },
): Promise<ChatGeneratedArtifactRecord> {
  const normalizedArtifactId = artifactId.trim();
  if (!normalizedArtifactId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "artifactId" });
  }
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  const artifact = await deps.storage.chatGeneratedArtifacts.get(normalizedArtifactId);
  const session = await deps.requireChatSession(artifact.sessionId);
  if (session.workspaceId !== workspaceId) {
    throw new ValidationError({ message: "Artifact does not belong to the requested workspace." });
  }
  return artifact;
}

export async function createChatGeneratedArtifactFromTurn(
  deps: ChatGeneratedArtifactDependencies,
  input: {
    sessionId: string;
    turnId: string;
    supersedeLatest?: boolean;
  },
): Promise<ChatGeneratedArtifactRecord> {
  const sessionId = input.sessionId.trim();
  const turnId = input.turnId.trim();
  if (!sessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  if (!turnId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
  }
  const session = await deps.requireChatSession(sessionId);
  const trace = await deps.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new ValidationError({ message: `Turn ${turnId} does not belong to session ${sessionId}.` });
  }
  if (!trace.assistantMessageId) {
    throw new ValidationError({ message: "Artifacts can only be created from assistant turns." });
  }
  const sourceSurface = trace.mode;
  const turnArtifacts = await deps.storage.chatGeneratedArtifacts.listByTurn(turnId, 50);
  const latestSameTurnArtifact = turnArtifacts[0];
  if (!input.supersedeLatest && latestSameTurnArtifact) {
    return latestSameTurnArtifact;
  }
  const assistantText = await resolveAssistantTextFromTrace(deps, turnId);
  const inferred = inferGeneratedArtifactFromAssistantText(assistantText);
  if (
    input.supersedeLatest &&
    latestSameTurnArtifact?.supersedesArtifactId &&
    latestSameTurnArtifact.kind === inferred.kind &&
    latestSameTurnArtifact.sourceBlockIndex === inferred.sourceBlockIndex &&
    latestSameTurnArtifact.contentHash === inferred.contentHash
  ) {
    return latestSameTurnArtifact;
  }
  const now = new Date().toISOString();
  const nextVersion =
    input.supersedeLatest && latestSameTurnArtifact ? Math.max(1, latestSameTurnArtifact.version + 1) : 1;
  const artifactId = input.supersedeLatest
    ? buildStableSupersededArtifactId(
        turnId,
        latestSameTurnArtifact?.artifactId,
        inferred.kind,
        inferred.contentHash,
        inferred.sourceBlockIndex,
      )
    : buildStableGeneratedArtifactId(turnId, inferred.kind, inferred.contentHash, inferred.sourceBlockIndex);
  const expectedSupersedesArtifactId = input.supersedeLatest ? latestSameTurnArtifact?.artifactId : undefined;
  try {
    return await deps.storage.chatGeneratedArtifacts.create({
      artifactId,
      sessionId,
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      turnId,
      title: inferred.title,
      kind: inferred.kind,
      content: inferred.content,
      language: inferred.language,
      sourceSurface,
      version: nextVersion,
      supersedesArtifactId: expectedSupersedesArtifactId,
      providerId: trace.routing.effectiveProviderId ?? trace.routing.primaryProviderId,
      model: trace.routing.effectiveModel ?? trace.routing.primaryModel ?? trace.model,
      sourceBlockIndex: inferred.sourceBlockIndex,
      contentHash: inferred.contentHash,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    try {
      const currentArtifact = await deps.storage.chatGeneratedArtifacts.get(artifactId);
      if (
        currentArtifact.turnId === turnId &&
        currentArtifact.kind === inferred.kind &&
        currentArtifact.sourceBlockIndex === inferred.sourceBlockIndex &&
        currentArtifact.contentHash === inferred.contentHash &&
        currentArtifact.supersedesArtifactId === expectedSupersedesArtifactId
      ) {
        return currentArtifact;
      }
    } catch {
      // Fall through and rethrow the original persistence error.
    }
    throw error;
  }
}

export function buildGeneratedArtifactReference(artifact: ChatGeneratedArtifactRecord): ChatGeneratedArtifactReference {
  return redactStructuredSecrets({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    projectId: artifact.projectId,
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
  }).value;
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

async function resolveAssistantTextFromTrace(deps: ChatGeneratedArtifactDependencies, turnId: string): Promise<string> {
  const trace = await deps.storage.chatTurnTraces.get(turnId);
  const assistantMessageId = trace.assistantMessageId?.trim();
  if (!assistantMessageId) {
    throw new ValidationError({ message: "Assistant output is missing for this turn." });
  }
  const statement = await deps.storage.gatewaySql.prepare(
    "SELECT content FROM chat_messages WHERE message_id = ? LIMIT 1",
  );
  const result = await statement.get<{ content?: string }>(assistantMessageId);
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

function buildStableSupersededArtifactId(
  turnId: string,
  supersedesArtifactId: string | undefined,
  kind: ChatGeneratedArtifactKind,
  contentHash: string,
  sourceBlockIndex?: number,
): string {
  const hash = createHash("sha256");
  hash.update("generated-artifact-supersede");
  hash.update("\u0000");
  hash.update(turnId.trim());
  hash.update("\u0000");
  hash.update((supersedesArtifactId ?? "").trim());
  hash.update("\u0000");
  hash.update(kind);
  hash.update("\u0000");
  hash.update(contentHash);
  hash.update("\u0000");
  hash.update(sourceBlockIndex !== undefined ? String(sourceBlockIndex) : "");
  return `gartv-${hash.digest("hex")}`;
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
