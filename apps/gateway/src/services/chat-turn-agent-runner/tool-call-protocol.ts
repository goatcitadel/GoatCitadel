import type { ToolCallProtocolIssue } from "../chat-agent-completion-adapters.js";

export function hasIncompleteToolCalls(message: Record<string, unknown>): boolean {
  const rawToolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  if (rawToolCalls.length === 0) {
    return false;
  }
  return rawToolCalls.some((toolCall) => {
    const fn = toolCall.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    const args = typeof fn?.arguments === "string" ? fn.arguments.trim() : "";
    if (!name || !args) {
      return true;
    }
    try {
      JSON.parse(args);
      return false;
    } catch {
      return true;
    }
  });
}

export function buildToolCallProtocolFailureMessage(issues: ToolCallProtocolIssue[]): string {
  const firstIssue = issues[0];
  const issueSummary = issues
    .slice(0, 3)
    .map((issue) => {
      const rawName = issue.rawName ? ` (${issue.rawName})` : "";
      return `${issue.kind}${rawName}`;
    })
    .join(", ");
  return [
    "The provider returned an invalid tool-call batch, so GoatCitadel stopped before executing tools.",
    firstIssue?.detail ?? "Tool-call protocol validation failed.",
    issueSummary ? `Detected: ${issueSummary}.` : undefined,
    "Retry with a narrower request or switch providers if this repeats.",
  ]
    .filter(Boolean)
    .join(" ");
}
