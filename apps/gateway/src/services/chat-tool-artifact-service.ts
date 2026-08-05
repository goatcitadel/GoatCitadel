import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSecretText, redactStructuredSecrets, ValidationError } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { ChatSessionRecord } from "@goatcitadel/contracts";

export interface ChatToolArtifactHost {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Pick<Storage, "chatToolArtifacts">;
  requireChatSession(sessionId: string): Promise<ChatSessionRecord>;
}

export async function persistChatToolArtifact(
  deps: ChatToolArtifactHost,
  input: {
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    content: string;
    contentType?: string;
    snippet?: string;
    createdAt?: string;
    canonicalWriteFence?: <T>(work: () => T | Promise<T>) => Promise<Awaited<T>>;
  },
): Promise<{
  artifactId: string;
  storageRelPath: string;
  byteLength: number;
  contentType?: string;
  snippet?: string;
}> {
  const projectedContent = projectToolArtifactContent(input.content, input.contentType);
  const projectedSnippet = input.snippet
    ? projectToolArtifactContent(input.snippet, input.contentType).content.slice(0, 4000)
    : undefined;
  const artifactId = randomUUID();
  const digest = createHash("sha256").update(projectedContent.content, "utf8").digest("hex");
  const extension = inferToolArtifactExtension(input.contentType);
  const storageRelPath = path.join("tool-artifacts", digest.slice(0, 2), `${digest}${extension}`);
  const absolutePath = path.resolve(deps.config.rootDir, deps.config.assistant.dataDir, storageRelPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (!fsSync.existsSync(absolutePath)) {
    await fs.writeFile(absolutePath, projectedContent.content, "utf8");
  }
  const createRecord = async () =>
    await deps.storage.chatToolArtifacts.create({
      artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolRunId: input.toolRunId,
      toolName: input.toolName,
      contentType: input.contentType,
      byteLength: Buffer.byteLength(projectedContent.content, "utf8"),
      snippet: projectedSnippet,
      storageRelPath,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  const record = input.canonicalWriteFence ? await input.canonicalWriteFence(createRecord) : await createRecord();
  return {
    artifactId: record.artifactId,
    storageRelPath: record.storageRelPath,
    byteLength: record.byteLength,
    contentType: record.contentType,
    snippet: record.snippet,
  };
}

export async function getChatToolArtifactContent(
  deps: ChatToolArtifactHost,
  artifactId: string,
  options: { workspaceId: string },
): Promise<{
  artifact: {
    artifactId: string;
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    contentType?: string;
    byteLength: number;
    snippet?: string;
    storageRelPath: string;
    createdAt: string;
  };
  content: string;
  publicProjection?: {
    contentRedacted: true;
    redactionCount: number;
    canonicalArtifactRemainsStored: true;
  };
}> {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  const artifact = await deps.storage.chatToolArtifacts.get(artifactId);
  const session = await deps.requireChatSession(artifact.sessionId);
  if (session.workspaceId !== workspaceId) {
    throw new ValidationError({ message: "Artifact does not belong to the requested workspace." });
  }
  const artifactRoot = path.resolve(deps.config.rootDir, deps.config.assistant.dataDir);
  const storageRelPath = artifact.storageRelPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(storageRelPath) || storageRelPath.split("/").includes("..")) {
    throw new ValidationError({ message: "Artifact path escapes the configured data directory." });
  }
  const absolutePath = path.resolve(artifactRoot, storageRelPath);
  const normalizedRoot = `${artifactRoot}${path.sep}`;
  if (absolutePath !== artifactRoot && !absolutePath.startsWith(normalizedRoot)) {
    throw new ValidationError({ message: "Artifact path escapes the configured data directory." });
  }
  const content = await fs.readFile(absolutePath, "utf8");
  const projectedContent = projectToolArtifactContent(content, artifact.contentType);
  const projectedArtifact = {
    ...artifact,
    ...(artifact.snippet
      ? { snippet: projectToolArtifactContent(artifact.snippet, artifact.contentType).content }
      : {}),
  };
  return {
    artifact: projectedArtifact,
    content: projectedContent.content,
    ...(projectedContent.redactionCount > 0
      ? {
          publicProjection: {
            contentRedacted: true as const,
            redactionCount: projectedContent.redactionCount,
            canonicalArtifactRemainsStored: true as const,
          },
        }
      : {}),
  };
}

function projectToolArtifactContent(
  content: string,
  contentType?: string,
): { content: string; redactionCount: number } {
  if (contentType?.toLowerCase().includes("json") || /^\s*[[{]/.test(content)) {
    try {
      const parsed = JSON.parse(content) as unknown;
      const projected = redactStructuredSecrets(parsed);
      if (projected.redactionCount > 0) {
        return {
          content: JSON.stringify(projected.value),
          redactionCount: projected.redactionCount,
        };
      }
    } catch (error) {
      // Captured tool output is often JSON-like rather than valid JSON. The
      // text projector below still protects explicit credential labels.
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  const projected = redactSecretText(content);
  return { content: projected.value, redactionCount: projected.redactionCount };
}

function inferToolArtifactExtension(contentType?: string): string {
  const normalized = contentType?.toLowerCase() ?? "";
  if (normalized.includes("json")) {
    return ".json";
  }
  if (normalized.includes("markdown")) {
    return ".md";
  }
  if (normalized.includes("html")) {
    return ".html";
  }
  if (normalized.includes("xml")) {
    return ".xml";
  }
  return ".txt";
}
