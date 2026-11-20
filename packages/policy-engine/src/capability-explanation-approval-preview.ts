import { parseCapabilityExplanationArgs, redactSecretText } from "@goatcitadel/contracts";

/** Exact, allowlisted read scope. The preview never activates a capability or authorizes its use. */
export function capabilityExplanationApprovalPreview(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parsed = parseCapabilityExplanationArgs(args);
  if (!parsed) return undefined;
  const { topics, limit } = parsed;
  const redacted = topics.map((topic) => redactSecretText(topic, { env: process.env }).value);
  const query =
    redacted.length === 1
      ? redacted[0]
      : redacted.map((topic, index) => `${index + 1}. ${topic.replace(/\s+/gu, " ")}`).join("\n");
  return {
    reviewKind: "knowledge.operation",
    toolName: "capabilities.explain",
    target: "Capabilities and setup status for this conversation",
    query,
    optionsSummary: redacted.length === 1 ? `Maximum results: ${limit}` : `Maximum results per topic: ${limit}`,
    summary:
      "Read capability, connection, policy and setup status for this conversation. Does not activate capabilities, change settings or perform the requested task.",
  };
}
