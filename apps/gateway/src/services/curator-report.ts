import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CuratorRunReport, CuratorRunReportEntry } from "@goatcitadel/contracts";

export interface WriteCuratorReportOptions {
  logsRoot: string;
}

export async function writeCuratorReport(
  report: CuratorRunReport,
  options: WriteCuratorReportOptions,
): Promise<string> {
  const dir = path.join(options.logsRoot, "logs", "curator", report.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(report, null, 2), "utf-8");
  await writeFile(path.join(dir, "REPORT.md"), renderMarkdown(report), "utf-8");
  return dir;
}

function renderMarkdown(report: CuratorRunReport): string {
  const archived = report.entries.filter((e) => e.action === "archived");
  const immune = report.entries.filter((e) => e.action === "skipped_immune");
  const skipped = report.entries.filter((e) => e.action === "skipped_below_threshold");
  const kept = report.entries.filter((e) => e.action === "none");
  const lines: string[] = [
    `# Curator Run ${report.runId}`,
    "",
    `- Trigger: \`${report.triggerMode}\``,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Cycle days: ${report.cycleDays}`,
    `- Dry run: ${report.dryRun}`,
    `- Total skills: ${report.totalSkills}`,
    `- Archived: ${report.archivedCount}`,
    `- Immune: ${report.immuneCount}`,
    `- Scored: ${report.scoredCount}`,
    "",
    `## Archived (${archived.length})`,
    ...renderEntries(archived),
    "",
    `## Immune (${immune.length})`,
    ...renderEntries(immune),
    "",
    `## Skipped below threshold (${skipped.length})`,
    ...renderEntries(skipped),
    "",
    `## Kept (${kept.length})`,
    ...renderEntries(kept),
    "",
  ];
  return lines.join("\n");
}

function renderEntries(entries: CuratorRunReportEntry[]): string[] {
  if (entries.length === 0) {
    return ["_none_"];
  }
  return entries.map(
    (entry) =>
      `- **${entry.name}** (\`${entry.skillId}\`) — mean ${entry.score.mean.toFixed(2)} ` +
      `[${entry.signals.join(", ") || "no_signals"}]${entry.actionReason ? ` — ${entry.actionReason}` : ""}`,
  );
}
