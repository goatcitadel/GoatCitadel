import type { ChatCompletionRequest, ChatTurnFeatureReferences } from "@goatcitadel/contracts";
import { assertMcpRequesterAdmissionConnection } from "./mcp-requester-admission-authority.js";
import { assertStaticMcpAdmissionReceipt } from "./mcp-static-admission.js";

/** Read-only pre-bind sizing. These definitions carry no executable MCP authority. */
export function projectMcpAdmissionContextBudgetTools(
  base: NonNullable<ChatCompletionRequest["tools"]>,
  references: ChatTurnFeatureReferences | undefined,
): NonNullable<ChatCompletionRequest["tools"]> {
  const receipts = [
    ...(references?.requesterConnections ?? []).map(assertMcpRequesterAdmissionConnection),
    ...(references?.selectedStaticMcp ?? []).map(assertStaticMcpAdmissionReceipt),
  ];
  const tools = [...base];
  const aliases = new Set(
    base.flatMap((tool) => {
      const definition = tool.function;
      return definition && typeof definition === "object" && "name" in definition && typeof definition.name === "string"
        ? [definition.name]
        : [];
    }),
  );
  const canonicalNames = new Set<string>();
  for (const receipt of receipts) {
    for (const tool of receipt.selectedTools) {
      if (aliases.has(tool.modelName) || canonicalNames.has(tool.canonicalToolName)) {
        throw new Error("Selected MCP context-budget descriptors are ambiguous.");
      }
      aliases.add(tool.modelName);
      canonicalNames.add(tool.canonicalToolName);
      tools.push({
        type: "function",
        function: {
          name: tool.modelName,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: structuredClone(tool.inputSchema),
        },
      });
    }
  }
  return tools;
}
