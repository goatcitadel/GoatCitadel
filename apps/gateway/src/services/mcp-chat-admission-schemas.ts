import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  readChatTurnFeatureReferences,
  type ChatTurnFeatureReferences,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import {
  readMcpRequesterAdmissionTurnContext,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import type { NativeMcpChatToolSchema } from "./gateway/native-mcp-chat-catalog.js";

/** Composition only: each owner rechecks its own live authority and connection custody. */
export async function restoreMcpChatAdmissionSchemas(
  ports: {
    readAdmission(
      scope: McpRequesterAdmissionScope,
    ): Promise<{ references: ChatTurnFeatureReferences; referenceSha256: string } | undefined>;
    restoreRequester(handle: McpRequesterAdmissionTurnContextHandle): Promise<NativeMcpChatToolSchema[]>;
    restoreStatic(handle: McpRequesterAdmissionTurnContextHandle): Promise<NativeMcpChatToolSchema[]>;
  },
  handle: McpRequesterAdmissionTurnContextHandle,
): Promise<NativeMcpChatToolSchema[]> {
  const context = readMcpRequesterAdmissionTurnContext(handle);
  if (!context) throw new Error("MCP tools require a live Chat admission handle.");
  await context.assertCurrent();
  const binding = await ports.readAdmission(context.scope);
  if (!binding || binding.referenceSha256 !== context.referenceSha256) throw new Error("MCP Chat admission changed.");
  const references = readChatTurnFeatureReferences(binding.references);
  if (createHash("sha256").update(canonicalJsonString(references)).digest("hex") !== context.referenceSha256)
    throw new Error("MCP Chat admission evidence changed.");
  const tools = [
    ...(references.requesterConnections?.length ? await ports.restoreRequester(handle) : []),
    ...(references.selectedStaticMcp?.length ? await ports.restoreStatic(handle) : []),
  ];
  if (
    new Set(tools.map((tool) => tool.canonicalName)).size !== tools.length ||
    new Set(tools.map((tool) => tool.modelName)).size !== tools.length
  )
    throw new Error("Selected MCP connections contain ambiguous tool identities.");
  await context.assertCurrent();
  return tools;
}
