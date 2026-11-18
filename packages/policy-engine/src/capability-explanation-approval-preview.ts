import { redactSecretText } from "@goatcitadel/contracts";

/** Exact, allowlisted read scope. The preview never activates a capability or authorizes its use. */
export function capabilityExplanationApprovalPreview(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { query, limit = 5 } = args;
  if (
    Object.keys(args).some((key) => key !== "query" && key !== "limit") ||
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 512 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5
  )
    return undefined;
  return {
    reviewKind: "knowledge.operation",
    toolName: "capabilities.explain",
    target: "Capabilities and setup status for this conversation",
    query: redactSecretText(query.trim(), { env: process.env }).value,
    optionsSummary: `Maximum results: ${limit}`,
    summary:
      "Read capability, connection, policy and setup status for this conversation. Does not activate capabilities, change settings or perform the requested task.",
  };
}
