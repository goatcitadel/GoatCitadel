/**
 * Pure helpers extracted from SkillsPage.tsx (Step 10 page slimming).
 */

import type { SkillListItem, SkillMergedSourceResult, SkillSourceProvider } from "@goatcitadel/contracts";
import type { validateSkillImport } from "../../api/client";

export const STATE_OPTIONS = ["enabled", "sleep", "disabled"] as const;
// "external" is intentionally omitted: external sources are reference-only and not importable.
export const IMPORT_PROVIDER_OPTIONS: SkillSourceProvider[] = ["local", "github", "clawhub", "agentskill", "skillsmp"];

export const SKILL_CATEGORY_RULES: Array<{ label: string; tokens: string[] }> = [
  {
    label: "Games & Experiments",
    tokens: ["animalhouse", "game", "virtual-pet", "creature", "pixel-art", "tamagotchi", "playful"],
  },
  {
    label: "Browser & Automation",
    tokens: ["browser", "playwright", "devtools", "automation", "screenshot", "web", "e2e", "chrome"],
  },
  {
    label: "Code & Engineering",
    tokens: [
      "code",
      "coding",
      "engineering",
      "implement",
      "refactor",
      "git",
      "fs.read",
      "fs.write",
      "shell.exec",
      "qa",
      "test",
    ],
  },
  {
    label: "Ops & Reliability",
    tokens: ["ops", "runtime", "sre", "incident", "monitoring", "safety", "observability"],
  },
  {
    label: "Research & Knowledge",
    tokens: ["research", "investigate", "source", "citations", "knowledge", "notebook", "discovery"],
  },
  {
    label: "Planning & Product",
    tokens: ["plan", "planning", "scope", "roadmap", "architecture", "product", "milestone"],
  },
  { label: "Docs & Writing", tokens: ["docs", "documentation", "readme", "runbook", "writing", "guide", "changelog"] },
  {
    label: "Communication & Productivity",
    tokens: ["assistant", "coordination", "productivity", "reminder", "follow-up", "organize", "summarize"],
  },
  { label: "Integrations & MCP", tokens: ["mcp", "connector", "integration", "server", "tooling"] },
];

export const SKILL_FAMILY_TO_CATEGORY: Record<string, string> = {
  browser_automation: "Browser & Automation",
  mcp_integrations: "Integrations & MCP",
  docs_authoring: "Docs & Writing",
  notebook_research: "Research & Knowledge",
  games_and_experiments: "Games & Experiments",
};

// Rules are evaluated in priority order: first matching rule wins.
// Place higher-priority categories earlier in SKILL_CATEGORY_RULES.
export function deriveCategoryLabel(corpus: string): string {
  for (const rule of SKILL_CATEGORY_RULES) {
    if (rule.tokens.some((token) => corpus.includes(token))) {
      return rule.label;
    }
  }
  return "General";
}

export function deriveSkillCategoryLabel(
  skill: Pick<SkillListItem, "skillId" | "name" | "tags" | "declaredTools" | "requires" | "keywords">,
): string {
  const corpus = [
    skill.skillId,
    skill.name,
    ...(skill.tags ?? []),
    ...skill.declaredTools,
    ...skill.requires,
    ...skill.keywords,
  ]
    .join(" ")
    .toLowerCase();
  return deriveCategoryLabel(corpus);
}

export function deriveSourceCategoryLabel(
  item: Pick<
    SkillMergedSourceResult,
    "name" | "description" | "tags" | "skillFamily" | "sourceUrl" | "repositoryUrl" | "upstreamUrl"
  >,
): string {
  const familyCategory = item.skillFamily ? SKILL_FAMILY_TO_CATEGORY[item.skillFamily] : undefined;
  if (familyCategory) {
    return familyCategory;
  }
  const corpus = [
    item.name,
    item.description,
    ...(item.tags ?? []),
    item.sourceUrl,
    item.repositoryUrl ?? "",
    item.upstreamUrl ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return deriveCategoryLabel(corpus);
}

export function groupByCategory<T>(items: T[], derive: (item: T) => string): Array<{ category: string; items: T[] }> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const category = derive(item);
    const existing = grouped.get(category);
    if (existing) {
      existing.push(item);
    } else {
      grouped.set(category, [item]);
    }
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, categoryItems]) => ({ category, items: categoryItems }));
}

export function formatValidationList(items: string[], fallback: string): string {
  if (items.length === 0) {
    return fallback;
  }
  return items.join(", ");
}

export function describeValidationTrust(validation: Awaited<ReturnType<typeof validateSkillImport>>): string {
  const status = validation.valid ? "ready for operator review" : "not installable yet";
  const network = validation.networkSignals.length > 0 ? "network-touching" : "self-contained";
  const suspicious =
    validation.suspiciousSignals.length > 0 ? "flagged signals detected" : "no suspicious signals detected";
  return `${validation.riskLevel} risk, ${network}, ${suspicious}, and ${status}.`;
}
