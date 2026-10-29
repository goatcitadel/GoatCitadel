import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ApprovalEvidenceModel, ApprovalTargetEntry } from "./approval-helpers.js";

// The shapes below mirror the Gateway's own fail-closed parse of a skill approval's payload
// (`parseSkillLifecycleApprovalBinding` and `parseRequestEnvelope` in
// apps/gateway/src/services/skill-governance-journey-producer.ts, `parseSkillStateSetMutation` in
// apps/gateway/src/services/skill-state-service.ts). Nothing is imported from the Gateway: a payload the Gateway would
// refuse to apply is never offered as an exact action here either.

/** `SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION`. */
const BINDING_VERSION = "goatcitadel.skill-lifecycle-approval.v1";
/** `SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION`: the stored request's version (not the hashed request's own). */
const REQUEST_ENVELOPE_VERSION = "goatcitadel.skill-lifecycle-request-envelope.v1";
const BINDING_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "scopeKind",
  "subjectKind",
  "subjectId",
  "action",
  "requestSha256",
  "expectedStateSha256",
  "supersedesApprovalId",
]);
const REQUEST_KEYS = ["mutation", "requesterId", "schemaVersion"] as const;
const MUTATION_KEYS = ["note", "skillId", "state"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;

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
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

/** The binding of one skill's switch change, as the Gateway parses it; undefined for any other shape. */
function stateBindingOf(value: unknown): Record<string, unknown> | undefined {
  const binding = recordOf(value);
  if (!binding || Object.keys(binding).some((key) => !BINDING_KEYS.has(key))) return undefined;
  return binding.schemaVersion === BINDING_VERSION &&
    binding.scopeKind === "global" &&
    binding.subjectKind === "skill" &&
    binding.action === "skill_state_set" &&
    typeof binding.requestSha256 === "string" &&
    SHA256.test(binding.requestSha256) &&
    typeof binding.expectedStateSha256 === "string" &&
    SHA256.test(binding.expectedStateSha256)
    ? binding
    : undefined;
}

/** The stored request's mutation, when the envelope and the mutation have exactly the Gateway's shape. */
function stateMutationOf(value: unknown): Record<string, unknown> | undefined {
  const request = recordOf(value);
  if (!request || !hasExactly(request, REQUEST_KEYS) || request.schemaVersion !== REQUEST_ENVELOPE_VERSION) {
    return undefined;
  }
  if (!textOf(request.requesterId)) return undefined;
  const mutation = recordOf(request.mutation);
  if (!mutation || !hasExactly(mutation, MUTATION_KEYS)) return undefined;
  return mutation.note === null || typeof mutation.note === "string" ? mutation : undefined;
}

/**
 * A skill switch change (`skill.lifecycle`, action `skill_state_set`), reviewed from the request the approval stores:
 * its binding hashes that request, and the Gateway applies it once approved, only to the state it was asked against.
 * Listed only when the binding and the stored request have exactly the shape the Gateway parses, and the binding, the
 * request and the preview name the same skill and the same new state; anything else keeps the generic model, which
 * offers nothing exact to approve. A skill's switch is the install's, not one workspace's, so the scope says so.
 */
export function skillStateApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = recordOf(approval.payload);
  const binding = stateBindingOf(payload?.skillLifecycle);
  const mutation = stateMutationOf(payload?.request);
  const preview = recordOf(approval.preview);
  const skillId = textOf(mutation?.skillId);
  const target = STATE_WORDS.get(mutation?.state);
  if (
    !binding ||
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
