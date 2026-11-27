import { NotFoundError, redactSecretText, type ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { resolveChannelSendReviewRoute } from "./tool-executor/comms-executor.js";

const reviewableArguments = new Set(["connectionId", "message", "target", "replyToMessageId", "__gcSafety"]);

export async function reviewDefaultChannelSend(
  request: ToolInvokeRequest,
  connections: AsyncStorage["integrationConnections"],
): Promise<{ connectionRevision: string; preview: Record<string, unknown> } | undefined> {
  const { connectionId, target, message, replyToMessageId } = request.args;
  if (
    request.toolName !== "channel.send" ||
    (target !== undefined && (typeof target !== "string" || target.trim())) ||
    typeof connectionId !== "string" ||
    !connectionId.trim() ||
    typeof message !== "string" ||
    !message.trim() ||
    Buffer.byteLength(message, "utf8") > 16_384 ||
    (replyToMessageId !== undefined && (typeof replyToMessageId !== "string" || replyToMessageId.length > 512)) ||
    Object.keys(request.args).some((key) => !reviewableArguments.has(key))
  ) {
    return undefined;
  }
  const connection = await connections.get(connectionId.trim()).catch((error: unknown) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  if (
    !connection?.revision ||
    connection.kind !== "channel" ||
    (connection.workspaceId !== undefined && connection.workspaceId !== request.workspaceId)
  ) {
    return undefined;
  }
  const route = resolveChannelSendReviewRoute(connection.key, connection.config);
  if (!route || route.target.length > 512) return undefined;

  const redact = (value: string) => redactSecretText(value, { env: process.env }).value;
  return {
    connectionRevision: connection.revision,
    preview: {
      reviewKind: "communications.operation",
      toolName: request.toolName,
      sessionId: request.sessionId,
      taskId: request.taskId,
      target: redact(route.target),
      summary:
        route.kind === "webhook"
          ? `Send a message using the webhook saved on ${redact(connection.label)}.`
          : `Send a message to the default destination for ${redact(connection.label)}.`,
      input: [
        replyToMessageId?.trim() ? `Reply to message ${redact(replyToMessageId.trim())}` : "",
        redact(message.trim()),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}
