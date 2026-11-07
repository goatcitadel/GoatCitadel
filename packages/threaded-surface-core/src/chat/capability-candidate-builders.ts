import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";

export const CODE_MODE_CAPABILITY_CANDIDATE_SOURCE = `
const skillMarkdown = typeof input.candidateSkillMarkdown === "string" ? input.candidateSkillMarkdown : "";
if (!skillMarkdown.trim()) {
  throw new Error("Candidate skill markdown is required.");
}
return {
  candidateKind: "self_generated_skill",
  candidateSkillMarkdown: skillMarkdown,
  proposedCapability: input.capabilityProposal ?? {},
  validationNotes: [
    "Generated as a non-callable candidate.",
    "Activation remains governed by capability proposal approval."
  ]
};
`.trim();

export function buildCapabilityCandidateId(sessionId: string, turnId: string | null, title: string): string {
  const seed = `${sessionId}:${turnId ?? "none"}:${title}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `candidate-${hash.toString(16).padStart(8, "0")}`;
}

export function buildCandidateSkillMarkdown(suggestion: ChatCapabilityUpgradeSuggestion): string {
  const skillName = buildSkillName(suggestion.title);
  const description = sanitizeSkillMarkdownText(
    suggestion.intendedBehavior ??
      suggestion.summary ??
      "Reusable GoatCitadel capability candidate generated from a capability gap.",
  );
  const requiredPermissions =
    suggestion.requiredPermissions && suggestion.requiredPermissions.length > 0
      ? suggestion.requiredPermissions.map((item) => `- ${sanitizeSkillMarkdownText(item)}`).join("\n")
      : "- No additional permissions requested by the initial candidate.";
  return [
    "---",
    `name: ${quoteYamlScalar(skillName)}`,
    `description: ${quoteYamlScalar(description)}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    "## When to use",
    sanitizeSkillMarkdownText(
      suggestion.intendedBehavior ??
        "Use this candidate after it has been approved to handle requests matching the original capability gap.",
    ),
    "",
    "## When not to use",
    "- Do not use while this candidate is proposed, validating, rejected, revoked, deprecated, or failed.",
    "- Do not bypass GoatCitadel policy, approvals, path jails, or capability lifecycle checks.",
    "",
    "## Required inputs",
    "- The user request that triggered the reusable workflow.",
    "- Any workspace context the approved skill explicitly asks for.",
    "",
    "## Required permissions",
    requiredPermissions,
    "",
    "## Workflow",
    "- Confirm the request still matches this approved skill.",
    "- Gather the minimum context needed for the workflow.",
    "- Use only callable tools and approved runtime capabilities.",
    "- Return concise output with evidence, uncertainty, and any required next action.",
    "",
    "## Output contract",
    "- State what was done.",
    "- Link or name any artifacts produced.",
    "- State validation performed and anything not validated.",
    "",
    "## Validation notes",
    `- ${sanitizeSkillMarkdownText(
      suggestion.validationExpectation ??
        "The governed capability build must validate the skill content and record artifact hashes.",
    )}`,
    "",
    "## Provenance",
    `- Source session: ${sanitizeSkillMarkdownText(suggestion.sourceSessionId ?? "current session")}`,
    `- Source turn: ${sanitizeSkillMarkdownText(suggestion.sourceTurnId ?? "current turn")}`,
    `- Gap summary: ${sanitizeSkillMarkdownText(suggestion.summary)}`,
    `- Rationale: ${sanitizeSkillMarkdownText(suggestion.reason)}`,
    "",
    "## Rollback",
    `- ${sanitizeSkillMarkdownText(
      suggestion.rollbackPosture ??
        "Rollback restores the previously approved version and records durable lifecycle evidence.",
    )}`,
  ].join("\n");
}

export function buildSkillName(title: string): string {
  const cleaned = title
    .replace(/^build reusable skill:\s*/i, "")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
  if (!cleaned) {
    return "Generated Capability Candidate";
  }
  return cleaned
    .split(" ")
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeSkillMarkdownText(value: string): string {
  const redacted = value
    .replace(/https?:\/\/\S+/gi, "[external source]")
    .replace(/\b(api[_-]?key|secret|password|token|credential)\b/gi, "sensitive value")
    .replace(/\b(sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,})\b/gi, "[redacted]")
    .replace(/\b(fetch\s*\(|axios\.|curl\s+)\b/gi, "[network step]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted || "No additional detail provided.";
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}
