import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { isRecognizedCoworkRole, normalizeCoworkRoleLabel } from "./chat-agent-cowork-sections.js";
import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";
import { resolvePromptLabCronReportEvidencePaths } from "./chat-agent-prompt-lab-routing.js";
import { looksLikePromptLabCronReportCoworkPrompt } from "./chat-agent-prompt-lab-taxonomy.js";
import { collectObservedToolEvidencePaths } from "./chat-agent-recovered-answer.js";

export function buildCronReportCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabCronReportCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 8);
  const { cronPath, executionPath, reportPath } = resolvePromptLabCronReportEvidencePaths(evidencePaths);
  const sections: string[] = [];
  const roleSections = input.effectiveSections.filter((section) =>
    isRecognizedCoworkRole(normalizeCoworkRoleLabel(section)),
  );
  const effectiveSections = roleSections.length > 0 ? roleSections : ["Architect", "Ops", "QA"];
  for (const section of effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- Start with one cron-to-review chain anchored in \`${cronPath}\` and \`${executionPath}\`: it should prove the built-in job reaches scheduled update-review execution instead of only persisting schedule metadata.\n- Pair that with one operator-visible assertion in \`${reportPath}\` so the same regression proves humans can see the resulting review/report, surfaced artifact identity, review item, and cost/status state from the API layer.\n- Source quality and gaps: high confidence only when cron wiring, scheduled review execution, and the route/client surface were concretely read; report-only behavior, manual recovery instructions, long-run failure surfacing, and exact UI copy stay explicit unknowns unless their consumer files are also read.`,
      );
      continue;
    }
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Shape the first regression as a built-in report-only cron flow, not a generic scheduler test: \`${cronPath}\` should enqueue or run \`update-review-daily\`, \`${executionPath}\` should produce the report/review artifact, and \`${reportPath}\` should surface that artifact plus review-item state to the operator.\n- Required seams: scheduled job due/not-due gating, report artifact identity, review item visibility, cost/status projection, and manual recovery after a long run fails or stops at report-only output.\n- Ambiguity to preserve: if only cron storage was read, source quality is low; if the route/client consumer was not read, operator-visible copy remains unproven rather than assumed.`,
      );
      continue;
    }
    if (normalized === "ops") {
      sections.push(
        `## ${section}\n- Add a due-job path for \`update-review-daily\` that executes through \`${cronPath}\` and \`${executionPath}\`, then assert the operator-facing surface in \`${reportPath}\` reflects the new review/report state without requiring a hidden manual refresh.\n- Add the inverse paused-or-not-due path and assert the operator surface stays unchanged when the cron gate should block execution.\n- Add one failure/manual-recovery path: when the long-running review executor errors or only produces a report artifact for later review, the surfaced state must show the failed/manual recovery item, job id, report id/path, source-quality caveat, and resume/inspect affordance instead of treating the cron as silently healthy.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Fail if cron metadata mutates but the scheduled review executor in \`${executionPath}\` never runs; that catches false confidence from wiring-only coverage.\n- Fail if scheduled review execution succeeds but \`${reportPath}\` still hides the resulting report artifact, review item, or cost/status state, because that breaks operator trust even though the job ran.\n- Fail if a long-run error is swallowed, if report-only output is counted as a completed review, or if manual recovery lacks the job id, report id/path, source-quality caveat, and next operator action.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Prioritize one cron-to-review-to-operator chain before broader coverage, anchored in \`${cronPath}\`, \`${executionPath}\`, and \`${reportPath}\`.\n- Keep the regression decision-oriented: prove the scheduled job runs, prove surfaced report/cost/review-item state reflects it, and prove failures/manual recovery are visible when the long-running review cannot complete automatically.`,
    );
  }
  return sections.join("\n").trim();
}
