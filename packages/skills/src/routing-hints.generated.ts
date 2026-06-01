import type { SkillRoutingHints } from "@goatcitadel/contracts";

export const GENERATED_SKILL_ROUTING_HINTS: Record<string, SkillRoutingHints> = {
  "agentic-skill-architect": {
    phrases: ["design an agentic skill", "skill vs runtime", "skill architecture"],
    keywords: ["agentic", "skill", "runtime", "governance"],
    surfaces: ["library", "cowork"],
    whenToUse: ["Review whether a workflow belongs in a governed runtime skill or platform infrastructure."],
    whenNotToUse: ["Do not use for ordinary code implementation without a skill-boundary question."],
    confidenceBoost: 0.12,
  },
  coding: {
    phrases: ["implement", "refactor", "fix", "patch", "bug fix", "feature"],
    keywords: ["code", "test", "typecheck", "implementation"],
    surfaces: ["code"],
    whenToUse: ["Make minimal, testable code changes with repo-grounded validation."],
    whenNotToUse: ["Do not use for pure product strategy or documentation-only work."],
    confidenceBoost: 0.1,
  },
  "design-intelligence": {
    phrases: [
      "design review",
      "design quality",
      "visual polish",
      "layout critique",
      "ux review",
      "anti-slop",
      "design-system audit",
    ],
    keywords: ["design", "design-quality", "anti-slop", "layout", "visual", "accessibility", "ux"],
    surfaces: ["code", "cowork"],
    whenToUse: [
      "Review or improve UI quality, visual hierarchy, responsive behavior, accessibility, anti-slop posture, or design-system fit.",
    ],
    whenNotToUse: ["Do not use for backend-only changes without user-visible UI implications."],
    confidenceBoost: 0.08,
  },
  documentation: {
    phrases: ["write docs", "update documentation", "release notes", "operator guide"],
    keywords: ["docs", "documentation", "readme", "guide"],
    surfaces: ["library", "ops"],
    whenToUse: ["Create or update truthful operator-facing documentation."],
    whenNotToUse: ["Do not use to make product claims that are not implementation-backed."],
    confidenceBoost: 0.08,
  },
  "goatcitadel native safe improvement": {
    phrases: ["log this routing gap", "post-task reflection", "self-improvement log"],
    keywords: ["routing gap", "correction", "workflow friction", "reflection"],
    surfaces: ["cowork", "library"],
    whenToUse: ["Capture governed improvement observations as proposals or reviewable notes."],
    whenNotToUse: ["Do not silently mutate durable memory or runtime policy."],
    confidenceBoost: 0.12,
  },
  "goatcitadel-native-safe-self-improvement": {
    phrases: ["log this routing gap", "post-task reflection", "self-improvement log"],
    keywords: ["routing gap", "correction", "workflow friction", "reflection"],
    surfaces: ["cowork", "library"],
    whenToUse: ["Capture governed improvement observations as proposals or reviewable notes."],
    whenNotToUse: ["Do not silently mutate durable memory or runtime policy."],
    confidenceBoost: 0.12,
  },
  "mcp-vetter": {
    phrases: ["vet this mcp", "mcp install review", "review this mcp server"],
    keywords: ["mcp", "server", "tool", "install"],
    surfaces: ["library", "settings"],
    whenToUse: ["Evaluate MCP servers before installation or activation."],
    whenNotToUse: ["Do not activate or install an MCP server without the normal approval path."],
    confidenceBoost: 0.1,
  },
  "n8n-workflow-architect": {
    phrases: ["n8n workflow", "automation workflow", "workflow architect"],
    keywords: ["n8n", "workflow", "automation", "node"],
    surfaces: ["cowork", "settings"],
    whenToUse: ["Design or review n8n automation workflows and node choices."],
    whenNotToUse: ["Do not create external automations without operator approval."],
    confidenceBoost: 0.08,
  },
  operations: {
    phrases: ["runtime health", "diagnostics", "release proof", "ops"],
    keywords: ["ops", "runtime", "diagnostics", "backup", "release"],
    surfaces: ["ops"],
    whenToUse: ["Investigate operational health, diagnostics, release proof, backups, or runtime status."],
    whenNotToUse: ["Do not treat diagnostics as product behavior without proof."],
    confidenceBoost: 0.08,
  },
  "personal-assistant": {
    phrases: ["personal assistant", "summarize this", "help me organize"],
    keywords: ["assistant", "summary", "schedule", "organize"],
    surfaces: ["chat"],
    whenToUse: ["Handle lightweight operator support, summaries, and personal productivity requests."],
    whenNotToUse: ["Do not perform external side effects without an explicit approved integration path."],
    confidenceBoost: 0.06,
  },
  planning: {
    phrases: ["make a plan", "implementation plan", "break this down"],
    keywords: ["plan", "scope", "milestone", "tradeoff"],
    surfaces: ["cowork"],
    whenToUse: ["Decompose multi-step work into scoped, reviewable implementation plans."],
    whenNotToUse: ["Do not stop at planning when the user explicitly requested implementation and scope is clear."],
    confidenceBoost: 0.08,
  },
  qa: {
    phrases: ["verify", "regression", "test plan", "repro"],
    keywords: ["test", "qa", "verify", "regression", "repro"],
    surfaces: ["code", "ops"],
    whenToUse: ["Build focused validation matrices and capture regression evidence."],
    whenNotToUse: ["Do not replace code fixes with test descriptions when a confirmed bug is in scope."],
    confidenceBoost: 0.08,
  },
  research: {
    phrases: ["research", "compare", "source analysis", "benchmark review"],
    keywords: ["research", "compare", "source", "benchmark"],
    surfaces: ["chat", "cowork"],
    whenToUse: ["Analyze external sources or compare repos with confidence labels and evidence."],
    whenNotToUse: ["Do not present stale external claims without current verification."],
    confidenceBoost: 0.08,
  },
};

export function resolveGeneratedRoutingHints(skillName: string): SkillRoutingHints | undefined {
  const normalized = skillName.trim().toLowerCase();
  return GENERATED_SKILL_ROUTING_HINTS[normalized] ?? GENERATED_SKILL_ROUTING_HINTS[normalized.replace(/\s+/g, "-")];
}
