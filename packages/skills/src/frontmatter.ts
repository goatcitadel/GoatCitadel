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

/**
 * Guard skill names against characters the capability-profile seal rejects.
 *
 * A skill's frontmatter name becomes `<source>:<name>` (the skill id) and then
 * `skill:<skillId>` (the capability id) inside sealed chat-turn capability
 * profiles. The storage verifier (`assertSafeId` in
 * packages/storage/src/chat-turn-capability-profile-repo.ts) rejects
 * whitespace, ASCII control characters, and over-long identifiers — so a name
 * that fails this check would fail every routed-context send at seal time.
 * Mirror that contract here so unsafe names are rejected at load/authoring
 * time instead.
 */
export function resolveSkillNameViolation(name: string): string | undefined {
  if (name.length > 200) {
    return "must be at most 200 characters so derived capability ids stay bounded";
  }
  if (/\s/u.test(name)) {
    return 'must not contain whitespace; use a hyphenated identifier such as "my-skill-name"';
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return "must not contain control characters";
    }
  }
  return undefined;
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
