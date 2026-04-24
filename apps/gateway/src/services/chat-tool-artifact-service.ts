import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";

export interface ChatToolArtifactHost {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Pick<Storage, "chatToolArtifacts">;
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
  },
): Promise<{
  artifactId: string;
  storageRelPath: string;
  byteLength: number;
  contentType?: string;
  snippet?: string;
}> {
  const artifactId = randomUUID();
  const digest = createHash("sha256").update(input.content, "utf8").digest("hex");
  const extension = inferToolArtifactExtension(input.contentType);
  const storageRelPath = path.join("tool-artifacts", digest.slice(0, 2), `${digest}${extension}`);
  const absolutePath = path.resolve(deps.config.rootDir, deps.config.assistant.dataDir, storageRelPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (!fsSync.existsSync(absolutePath)) {
    await fs.writeFile(absolutePath, input.content, "utf8");
  }
  const record = deps.storage.chatToolArtifacts.create({
    artifactId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolRunId: input.toolRunId,
    toolName: input.toolName,
    contentType: input.contentType,
    byteLength: Buffer.byteLength(input.content, "utf8"),
    snippet: input.snippet?.slice(0, 4000),
    storageRelPath,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
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
}> {
  const artifact = deps.storage.chatToolArtifacts.get(artifactId);
  const artifactRoot = path.resolve(deps.config.rootDir, deps.config.assistant.dataDir);
  const absolutePath = path.resolve(artifactRoot, artifact.storageRelPath);
  const normalizedRoot = `${artifactRoot}${path.sep}`;
  if (absolutePath !== artifactRoot && !absolutePath.startsWith(normalizedRoot)) {
    throw new ValidationError({ message: "Artifact path escapes the configured data directory." });
  }
  const content = await fs.readFile(absolutePath, "utf8");
  return {
    artifact,
    content,
  };
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
