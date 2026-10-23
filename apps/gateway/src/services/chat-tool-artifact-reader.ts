import { z } from "zod";
import { ValidationError } from "@goatcitadel/contracts";
import { getChatToolArtifactContent, type ChatToolArtifactHost } from "./chat-tool-artifact-service.js";
const toolArtifactReadSchema = z
  .object({
    artifactId: z.guid(),
    offset: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(1).max(12000).default(8000),
  })
  .strict();

export async function readChatToolArtifactForTool(
  deps: ChatToolArtifactHost,
  request: { sessionId: string; args: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const args = toolArtifactReadSchema.parse(request.args);
  const session = await deps.requireChatSession(request.sessionId);
  if (!session.workspaceId?.trim()) {
    throw new ValidationError({ message: "Current chat session has no owning workspace." });
  }
  const loaded = await getChatToolArtifactContent(deps, args.artifactId, {
    workspaceId: session.workspaceId,
    sessionId: request.sessionId,
  });
  if (args.offset > loaded.content.length) {
    throw new ValidationError({ message: "Artifact offset exceeds the stored content length." });
  }
  const content = loaded.content.slice(args.offset, args.offset + args.maxChars);
  const nextOffset = args.offset + content.length;
  return {
    artifactId: loaded.artifact.artifactId,
    sourceToolName: loaded.artifact.toolName,
    contentType: loaded.artifact.contentType,
    content,
    offset: args.offset,
    totalChars: loaded.content.length,
    truncated: nextOffset < loaded.content.length,
    ...(nextOffset < loaded.content.length ? { nextOffset } : {}),
  };
}
