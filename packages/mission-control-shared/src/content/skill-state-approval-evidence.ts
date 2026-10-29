import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ApprovalEvidenceModel, ApprovalTargetEntry } from "./approval-helpers.js";

/** A skill's switch states as the Gateway stores them, in the words the Skills tab uses. */
const STATE_WORDS: ReadonlyMap<unknown, string> = new Map([
  ["enabled", "On"],
  ["sleep", "Paused"],
  ["disabled", "Off"],
]);

const SKILL_STATE_CONSEQUENCE =
  "Approving switches this one skill once, as listed, for every workspace. Denying leaves it as it is.";

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/**
 * A skill switch change (`skill.lifecycle`, action `skill_state_set`), reviewed from the request the approval stores:
 * its binding hashes that request, and the Gateway applies it once approved, only to the state it was asked against.
 * Listed only when the binding, the stored request and the preview name the same skill and the same new state; anything
 * less keeps the generic model, which offers nothing exact to approve. A skill's switch is the install's, not one
 * workspace's, so the scope says so.
 */
export function skillStateApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = recordOf(approval.payload);
  const binding = recordOf(payload?.skillLifecycle);
  const mutation = recordOf(recordOf(payload?.request)?.mutation);
  const preview = recordOf(approval.preview);
  const skillId = textOf(mutation?.skillId);
  const target = STATE_WORDS.get(mutation?.state);
  if (
    binding?.action !== "skill_state_set" ||
    binding.subjectKind !== "skill" ||
    binding.scopeKind !== "global" ||
    !skillId ||
    !target ||
    binding.subjectId !== skillId ||
    preview?.skillId !== skillId ||
    preview.state !== mutation?.state
  )
    return null;
  const now = STATE_WORDS.get(preview.currentState);
  const note = textOf(mutation?.note);
  const entries: ApprovalTargetEntry[] = [
    { label: "Skill", value: skillId },
    ...(now ? [{ label: "Now", value: now }] : []),
    { label: "Switch to", value: target },
    ...(note ? [{ label: "Note", value: note }] : []),
  ];
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries,
    commands: [],
    changes: [],
    supporting: [],
    scopeSummary: "Every workspace on this install.",
    consequence: SKILL_STATE_CONSEQUENCE,
  };
}
