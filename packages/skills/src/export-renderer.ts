import { createHash } from "node:crypto";
import type {
  LoadedSkill,
  SkillExportPreviewResponse,
  SkillExportRenderedFile,
  SkillExportRequest,
  SkillExportTarget,
  SkillExportTargetProfile,
} from "@goatcitadel/contracts";

const BOUNDARY_WARNING =
  "Exported GoatCitadel skills are portable instructions only. They do not grant tools, bypass approvals, weaken path jails, or make inactive/proposed capabilities callable.";

export const SKILL_EXPORT_TARGETS: SkillExportTargetProfile[] = [
  {
    target: "codex",
    label: "Codex",
    description: "Codex-friendly AGENTS-style Markdown with GoatCitadel boundary warnings.",
    supportsFrontmatter: false,
    suppressesInternalMetadata: true,
    previewOnly: true,
  },
  {
    target: "claude",
    label: "Claude",
    description: "Claude-compatible skill Markdown with reduced internal metadata.",
    supportsFrontmatter: true,
    suppressesInternalMetadata: true,
    previewOnly: true,
  },
  {
    target: "generic-markdown",
    label: "Generic Markdown",
    description: "Plain Markdown export for review or handoff.",
    supportsFrontmatter: false,
    suppressesInternalMetadata: true,
    previewOnly: true,
  },
];

export function listSkillExportTargets(): SkillExportTargetProfile[] {
  return SKILL_EXPORT_TARGETS.map((target) => ({ ...target }));
}

export function renderSkillExportPreview(
  request: SkillExportRequest,
  allSkills: LoadedSkill[],
): SkillExportPreviewResponse {
  const target = requireSupportedTarget(request.target);
  const selected = selectSkills(request.skillIds, allSkills);
  const files = selected.map((skill) => renderSkillFile(skill, target));
  return {
    target,
    generatedAt: new Date().toISOString(),
    boundaryWarning: BOUNDARY_WARNING,
    files,
  };
}

function renderSkillFile(skill: LoadedSkill, target: SkillExportTarget): SkillExportRenderedFile {
  const safeName = slugify(skill.name);
  const content = renderSkillMarkdown(skill, target);
  return {
    relativePath: `${safeName}/SKILL.md`,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function renderSkillMarkdown(skill: LoadedSkill, target: SkillExportTarget): string {
  const lines: string[] = [];
  if (target === "claude") {
    lines.push("---");
    lines.push(`name: ${JSON.stringify(skill.name)}`);
    lines.push(`description: ${JSON.stringify(firstParagraph(skill.instructionBody) || skill.name)}`);
    lines.push("---", "");
  }
  lines.push(`# ${skill.name}`, "");
  lines.push(`> ${BOUNDARY_WARNING}`, "");
  lines.push("## GoatCitadel Runtime Boundary", "");
  lines.push("- This export is advisory instruction content only.");
  lines.push(
    "- Tool access, approvals, memory writes, path jails, and capability activation remain owned by GoatCitadel.",
  );
  lines.push("- Do not claim hostile-code sandboxing or autonomous high-risk activation from this skill.", "");
  if (skill.routingHints) {
    lines.push("## When To Use", "");
    for (const hint of skill.routingHints.whenToUse) {
      lines.push(`- ${hint}`);
    }
    if (skill.routingHints.whenNotToUse.length > 0) {
      lines.push("", "## When Not To Use", "");
      for (const hint of skill.routingHints.whenNotToUse) {
        lines.push(`- ${hint}`);
      }
    }
    lines.push("");
  }
  lines.push("## Instructions", "", skill.instructionBody.trim(), "");
  return lines.join("\n");
}

function requireSupportedTarget(target: SkillExportTarget): SkillExportTarget {
  if (SKILL_EXPORT_TARGETS.some((entry) => entry.target === target)) {
    return target;
  }
  throw new Error(`Unsupported skill export target: ${target}`);
}

function selectSkills(skillIds: string[], allSkills: LoadedSkill[]): LoadedSkill[] {
  const requested = new Set(skillIds.map((id) => id.trim()).filter(Boolean));
  if (requested.size === 0) {
    throw new Error("At least one skill id is required.");
  }
  const selected = allSkills.filter((skill) => requested.has(skill.skillId) || requested.has(skill.name));
  if (selected.length !== requested.size) {
    const matched = new Set(selected.flatMap((skill) => [skill.skillId, skill.name]));
    const missing = [...requested].filter((id) => !matched.has(id));
    throw new Error(`Unknown skill export id(s): ${missing.join(", ")}`);
  }
  return selected;
}

function firstParagraph(markdown: string): string {
  return (
    markdown
      .split(/\n{2,}/)
      .map((part) => part.replace(/^#+\s+/gm, "").trim())
      .find(Boolean) ?? ""
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
