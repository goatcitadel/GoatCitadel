import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

export function computeUsageTotals(thread: MissionThreadedActiveSessionSurfaceProps["thread"]) {
  let tokens = 0,
    costUsd = 0,
    tokenFields = 0,
    costFields = 0,
    messages = 0;
  for (const turn of thread?.turns ?? [])
    for (const message of [turn.userMessage, turn.assistantMessage]) {
      if (!message) continue;
      messages += 1;
      for (const value of [message.tokenInput, message.tokenOutput])
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          tokens += value;
          tokenFields += 1;
        }
      if (typeof message.costUsd === "number" && Number.isFinite(message.costUsd) && message.costUsd >= 0) {
        costUsd += message.costUsd;
        costFields += 1;
      }
    }
  return {
    tokens: tokenFields ? tokens : null,
    costUsd: costFields ? costUsd : null,
    partialTokens: tokenFields < messages * 2,
    partialCost: costFields < messages,
  };
}

export function formatTokenLabel(tokens: number | null): string {
  if (tokens === null) return "Tokens unavailable";
  return `${new Intl.NumberFormat("en-US").format(tokens)} tokens`;
}

export function formatCostLabel(costUsd: number | null): string {
  if (costUsd === null) return "Cost unavailable";
  if (costUsd <= 0) {
    return "$0.00";
  }
  if (costUsd >= 10) {
    return `$${costUsd.toFixed(1)}`;
  }
  if (costUsd >= 0.01) {
    return `$${costUsd.toFixed(2)}`;
  }
  // Sub-cent costs are kept truthful: report three significant figures so a
  // long delegation that has crossed $0.005 reads as $0.005 rather than the
  // misleading flat "<$0.01" placeholder it used to show.
  return "$" + Number(costUsd.toPrecision(3));
}

export function formatUsageLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string {
  const totals = computeUsageTotals(thread);
  return `${formatTokenLabel(totals.tokens)}${totals.partialTokens && totals.tokens !== null ? " recorded" : ""} / ${formatCostLabel(totals.costUsd)}${totals.partialCost && totals.costUsd !== null ? " recorded" : ""}`;
}
