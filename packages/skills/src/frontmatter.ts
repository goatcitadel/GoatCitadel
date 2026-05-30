import YAML from "yaml";
import type { SkillFrontmatter } from "@goatcitadel/contracts";

export interface ParsedSkillMarkdown {
  frontmatter: SkillFrontmatter;
  body: string;
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const normalizedMarkdown = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const lines = normalizedMarkdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter delimiter ---");
  }

  const secondFence = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (secondFence < 0) {
    throw new Error("SKILL.md frontmatter closing delimiter --- not found");
  }

  const frontmatterRaw = lines.slice(1, secondFence).join("\n");
  const parsed = YAML.parse(frontmatterRaw) as SkillFrontmatter | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid SKILL.md frontmatter");
  }

  if (!parsed.name || !parsed.description) {
    throw new Error("SKILL.md frontmatter requires name and description");
  }

  const metadata = normalizeMetadata(parsed.metadata);
  return {
    frontmatter: {
      ...parsed,
      metadata,
    },
    body: lines
      .slice(secondFence + 1)
      .join("\n")
      .trim(),
  };
}

function normalizeMetadata(value: SkillFrontmatter["metadata"]): SkillFrontmatter["metadata"] {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as SkillFrontmatter["metadata"];
    } catch {
      return undefined;
    }
  }

  return value;
}
