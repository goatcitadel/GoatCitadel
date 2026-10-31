/**
 * One plain category and one origin label for every skill. The Gateway computes both for the Skills
 * tab; callers never derive them. Shipped skills are pinned in `SHIPPED_SKILL_CATEGORIES`; any other
 * skill is placed by its tags and keywords, and falls back to "other".
 */
export type SkillCategoryId =
  | "coding"
  | "writing"
  | "research"
  | "planning"
  | "design"
  | "automation"
  | "email"
  | "operations"
  | "personal"
  | "local_ai"
  | "other";

export interface SkillCategoryDefinition {
  readonly id: SkillCategoryId;
  readonly label: string;
  /** Lower-case terms a tag or keyword must equal. "other" has none. */
  readonly matchTerms: readonly string[];
}

/** Table order decides ties between categories; "other" stays last. */
export const SKILL_CATEGORIES: readonly SkillCategoryDefinition[] = [
  {
    id: "coding",
    label: "Coding",
    matchTerms: ["code", "coding", "programming", "git", "github", "testing", "qa", "debugging", "refactoring"],
  },
  {
    id: "writing",
    label: "Writing and docs",
    matchTerms: ["docs", "documentation", "writing", "readme", "runbook", "content"],
  },
  {
    id: "research",
    label: "Research",
    matchTerms: ["research", "web", "search", "citations"],
  },
  {
    id: "planning",
    label: "Planning",
    matchTerms: ["planning", "plan", "product", "roadmap", "architecture"],
  },
  {
    id: "design",
    label: "Design",
    matchTerms: ["design", "ui", "ux", "frontend", "css"],
  },
  {
    id: "automation",
    label: "Automation",
    matchTerms: ["automation", "workflow", "n8n", "integration"],
  },
  {
    id: "email",
    label: "Email and messages",
    matchTerms: ["email", "mail", "imap", "smtp", "messaging"],
  },
  {
    id: "operations",
    label: "Operations",
    matchTerms: ["operations", "ops", "devops", "infrastructure", "incident", "monitoring"],
  },
  {
    id: "personal",
    label: "Personal",
    matchTerms: ["personal", "productivity", "reminders", "notes"],
  },
  {
    id: "local_ai",
    label: "Local AI",
    matchTerms: ["inference", "llm", "npu", "local-ai"],
  },
  {
    id: "other",
    label: "Other",
    matchTerms: [],
  },
];

/**
 * The category of every skill listed in `skills/catalog-coverage.json`, keyed by skill id. A test keeps
 * the two in step, so a new shipped skill fails it until it is given a category here.
 */
export const SHIPPED_SKILL_CATEGORIES: Readonly<Record<string, SkillCategoryId>> = {
  "bundled:coding": "coding",
  "bundled:debugging": "coding",
  "bundled:opencode": "coding",
  "bundled:qa": "coding",
  "bundled:tdd": "coding",
  "extra:github-cli": "coding",
  "bundled:documentation": "writing",
  "bundled:research": "research",
  "bundled:planning": "planning",
  "bundled:agentic-skill-architect": "planning",
  "bundled:impeccable": "design",
  "bundled:n8n-workflow-architect": "automation",
  "bundled:sendclaw": "email",
  "extra:himalaya": "email",
  "bundled:operations": "operations",
  "bundled:mcp-vetter": "operations",
  "bundled:goatcitadel-native-safe-self-improvement": "operations",
  "extra:citadel-mason": "operations",
  "bundled:personal-assistant": "personal",
  "extra:genie-npu-ir20": "local_ai",
};

/**
 * Shipped map first; else the first category (table order) with a term equal to a lower-cased tag or
 * keyword; else "other".
 */
export function skillCategoryFor(input: {
  skillId: string;
  tags?: readonly string[];
  keywords?: readonly string[];
}): SkillCategoryId {
  const shipped = Object.hasOwn(SHIPPED_SKILL_CATEGORIES, input.skillId)
    ? SHIPPED_SKILL_CATEGORIES[input.skillId]
    : undefined;
  if (shipped) {
    return shipped;
  }
  const words = new Set([...(input.tags ?? []), ...(input.keywords ?? [])].map((word) => word.toLowerCase()));
  if (words.size === 0) {
    return "other";
  }
  const match = SKILL_CATEGORIES.find((category) => category.matchTerms.some((term) => words.has(term)));
  return match?.id ?? "other";
}

export type SkillOrigin = "built_in" | "imported" | "self_authored" | "workspace";

export const SKILL_ORIGIN_LABELS: Readonly<Record<SkillOrigin, string>> = {
  built_in: "Built in",
  imported: "Imported",
  self_authored: "Self-authored",
  workspace: "Workspace",
};
