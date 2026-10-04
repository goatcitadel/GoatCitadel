import type { TargetInfo } from "../gateway-target/detect-target";
import type { CoverageReport } from "./routes";
import { countStatuses, recordFor, type RunState } from "./state";
import type { CheckDef } from "./types";

export interface ReportInput {
  readonly target: TargetInfo;
  readonly coverage: CoverageReport | undefined;
  readonly checks: readonly CheckDef[];
  readonly state: RunState;
  readonly generatedAt: string;
}

export function buildMarkdownReport(input: ReportInput): string {
  const counts = countStatuses(
    input.state,
    input.checks.map((check) => check.id),
  );
  const header = [
    "# GoatCitadel test bench report",
    "",
    `- Generated: ${input.generatedAt}`,
    `- Target: ${describeTarget(input.target)}`,
    `- Coverage: ${describeCoverage(input.coverage)}`,
    `- Results: ${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.cancelled} cancelled, ${counts["not-run"]} not run`,
  ];
  const problems = input.checks.filter((check) => {
    const status = recordFor(input.state, check.id).status;
    return status === "fail" || status === "blocked";
  });
  if (problems.length === 0) {
    return `${header.join("\n")}\n`;
  }
  const rows = problems.map((check) => {
    const record = recordFor(input.state, check.id);
    return `| ${record.status} | ${check.domain} | ${escapeCell(check.title)} | ${escapeCell(record.summary ?? "")} |`;
  });
  return `${[...header, "", "## Failing and blocked", "", "| Status | Area | Check | Summary |", "| --- | --- | --- | --- |", ...rows].join("\n")}\n`;
}

export function describeTarget(target: TargetInfo): string {
  if (target.kind === "sandbox") {
    return `sandbox ${target.origin} (root ${target.rootDir ?? "unknown"})`;
  }
  return target.reason
    ? `real gateway ${target.origin} (sandbox check failed: ${target.reason})`
    : `real gateway ${target.origin}`;
}

export function describeCoverage(coverage: CoverageReport | undefined): string {
  if (!coverage) {
    return "unavailable (the gateway did not serve its route list)";
  }
  const percent = coverage.total === 0 ? 0 : Math.round((coverage.covered / coverage.total) * 100);
  return `${coverage.covered} / ${coverage.total} routes (${percent}%)`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
