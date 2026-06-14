import YAML from "yaml";
import { z } from "zod";
import type { SkillFrontmatter } from "@goatcitadel/contracts";

export interface ParsedSkillMarkdown {
  frontmatter: SkillFrontmatter;
  body: string;
}

// Validate the SKILL.md frontmatter shape with Zod instead of an unchecked
// `as SkillFrontmatter` cast. A bad shape (e.g. `tools: "read"` instead of a
// list) previously slipped through the cast and only surfaced later as a
// downstream TypeError; here it fails fast with an attributable message that
// the loader logs per-skill.
const stringListSchema = z.array(z.string());

const SkillMetadataSchema = z
  .object({
    version: z.string().optional(),
    tags: stringListSchema.optional(),
    tools: stringListSchema.optional(),
    requires: stringListSchema.optional(),
    keywords: stringListSchema.optional(),
  })
  // Tolerate extra/unknown metadata keys (forward-compatible authoring) while
  // still validating the known list shapes above.
  .passthrough();

const REQUIRED_FIELDS_MESSAGE = "SKILL.md frontmatter requires name and description";

export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string({ required_error: REQUIRED_FIELDS_MESSAGE, invalid_type_error: REQUIRED_FIELDS_MESSAGE })
      .min(1, REQUIRED_FIELDS_MESSAGE),
    description: z
      .string({ required_error: REQUIRED_FIELDS_MESSAGE, invalid_type_error: REQUIRED_FIELDS_MESSAGE })
      .min(1, REQUIRED_FIELDS_MESSAGE),
    metadata: SkillMetadataSchema.optional(),
  })
  .passthrough();

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
  const rawParsed = YAML.parse(frontmatterRaw) as unknown;
  if (!rawParsed || typeof rawParsed !== "object") {
    throw new Error("Invalid SKILL.md frontmatter");
  }

  const withNormalizedMetadata = {
    ...(rawParsed as Record<string, unknown>),
    metadata: normalizeMetadata((rawParsed as { metadata?: unknown }).metadata),
  };

  const validated = SkillFrontmatterSchema.safeParse(withNormalizedMetadata);
  if (!validated.success) {
    throw new Error(`Invalid SKILL.md frontmatter: ${formatFrontmatterIssues(validated.error)}`);
  }

  return {
    frontmatter: validated.data as SkillFrontmatter,
    body: lines
      .slice(secondFence + 1)
      .join("\n")
      .trim(),
  };
}

function formatFrontmatterIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function normalizeMetadata(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  return value;
}
