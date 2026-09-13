import { WORKFLOW_SKILL_CAPTURE_MARKER } from "@goatcitadel/contracts";

/** Display projection only. The Gateway independently validates the exact saved request. */
export function getWorkflowSkillCaptureDisplay(
  content: string,
): { summary: string; request: string; result: string } | null {
  if (!content.startsWith(WORKFLOW_SKILL_CAPTURE_MARKER) || content.length > 150_000) return null;
  try {
    const seed = JSON.parse(content.split("\n", 1)[0]!.slice(WORKFLOW_SKILL_CAPTURE_MARKER.length));
    const evidenceText = content.split("<workflow_evidence>\n\n")[1]?.split("\n\n</workflow_evidence>")[0];
    if (typeof seed.sourceTurnId !== "string" || typeof seed.guidance !== "string" || !evidenceText) return null;
    const evidence = JSON.parse(evidenceText);
    if (typeof evidence.request !== "string" || typeof evidence.result !== "string") return null;
    return {
      summary: `Draft reusable skill instructions from the completed task.${seed.guidance ? `\n\nPreserve: ${seed.guidance}` : ""}\n\nI will review the draft before saving or activating it.`,
      request: evidence.request,
      result: evidence.result,
    };
  } catch {
    return null;
  }
}
