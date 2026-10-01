import type { CitadelBrief } from "@goatcitadel/contracts";
import { formatUsd } from "@next/app/mission-control-shell-model";
import { humanizeEnumToken } from "../shared/native-helpers";

export function formatBriefAge(ageMs: number): string {
  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 1) {
    return "just now";
  }
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function buildBriefMarkdown(brief: CitadelBrief): string {
  const lines = [
    `# Daily brief — ${brief.citadelName ?? brief.citadelId}`,
    `Window: ${brief.since} → ${brief.generatedAt}`,
    "",
    `- Pending approvals: ${brief.approvals.pendingCount}` +
      (brief.approvals.oldestAgeMs !== null ? ` (oldest ${formatBriefAge(brief.approvals.oldestAgeMs)})` : ""),
    `- Activity: ${brief.activity.eventsSince} events · ${brief.activity.completedSince} completed · ${brief.activity.failedSince} failed · ${brief.activity.wardHitsSince} ward hits`,
    `- Spend (${brief.spend.scope}): ${formatUsd(brief.spend.sinceUsd)} · ${brief.spend.sinceTokens} tokens` +
      (brief.spend.complete ? "" : " (partial data)"),
    "unavailable" in brief.memory
      ? `- Memory: unavailable (${brief.memory.unavailable})`
      : `- Memory: ${brief.memory.pendingRecommendations} recommendation(s) pending review`,
  ];
  if (brief.approvals.pending.length > 0) {
    lines.push("", "## Waiting on you");
    for (const item of brief.approvals.pending) {
      lines.push(
        `- ${humanizeEnumToken(item.kind)} · ${item.riskLevel} · waiting ${formatBriefAge(item.ageMs)} (${item.workspaceId})`,
      );
    }
  }
  return lines.join("\n");
}
