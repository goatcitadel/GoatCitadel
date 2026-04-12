/**
 * Shared helpers for follow-on parity proof-lane builders.
 *
 * Consolidates patterns previously duplicated across browser-proof-lane.ts,
 * packaging-proof-lane.ts, a2ui-proof-lane.ts and voice-proof-lane.ts:
 *   - artifact path naming (date slice + sanitized timestamp)
 *   - blocking-issues aggregation from a step list
 *   - markdown header + step-list footer formatting
 */

import type { FollowOnProofLaneStepRecord } from "@goatcitadel/contracts";

interface ProofLaneSpec {
  artifactRoot: string;
  checklistPath: string;
  templatePath: string;
}

/**
 * Build the standard artifact storage path:
 *   {artifactRoot}/{YYYY-MM-DD}/{slug}-{deploymentProfile}-{safeTimestamp}.md
 */
export function buildProofLaneArtifactPath(input: {
  spec: Pick<ProofLaneSpec, "artifactRoot">;
  generatedAt: string;
  deploymentProfile: string;
  slug: string;
}): string {
  const day = input.generatedAt.slice(0, 10);
  const timestamp = input.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  return `${input.spec.artifactRoot}/${day}/${input.slug}-${input.deploymentProfile}-${timestamp}.md`;
}

/**
 * Merge a report's pre-existing blocking issues with one synthesized
 * entry per blocked step, deduped.
 */
export function mergeProofLaneBlockingIssues(
  reportIssues: readonly string[],
  steps: readonly FollowOnProofLaneStepRecord[],
): string[] {
  return Array.from(
    new Set([
      ...reportIssues,
      ...steps.filter((step) => step.status === "blocked").map((step) => `${step.title} is blocked.`),
    ]),
  );
}

/**
 * Standard header lines used by every proof-lane markdown bundle.
 */
export function formatProofLaneMarkdownHeader(input: {
  title: string;
  generatedAt: string;
  deploymentProfile: string;
  authMode: string;
  spec: Pick<ProofLaneSpec, "checklistPath" | "templatePath">;
  summary: string;
}): string[] {
  return [
    `# ${input.title}`,
    "",
    `Generated: ${input.generatedAt}`,
    `Deployment profile: ${input.deploymentProfile}`,
    `Auth mode: ${input.authMode}`,
    `Checklist: ${input.spec.checklistPath}`,
    `Template: ${input.spec.templatePath}`,
    "",
    "## Summary",
    input.summary,
    "",
  ];
}

/**
 * Standard "## Lane Steps" footer used by every proof-lane markdown
 * bundle. Returns the lines to splice into the document.
 */
export function formatProofLaneStepsSection(steps: readonly FollowOnProofLaneStepRecord[]): string[] {
  return [
    "## Lane Steps",
    ...steps.flatMap((step, index) => [
      `${index + 1}. ${step.title} [${step.status}]`,
      `Instructions: ${step.instructions}`,
      `Evidence: ${step.evidenceHint}`,
      "",
    ]),
  ];
}
