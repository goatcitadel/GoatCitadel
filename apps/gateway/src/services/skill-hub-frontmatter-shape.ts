import { checkClaudeCodeFrontmatter, type ClaudeCodeFrontmatterReading } from "./skill-hub-claude-code-dialect.js";

// Which SKILL.md frontmatter keys the Skill Hub review admits. The review reads the file and refuses on the answer;
// this file only decides, from the parsed frontmatter, so the file's bytes are never touched.

const UNKNOWN_FRONTMATTER_DIMENSION = "UNKNOWN_FRONTMATTER_DIMENSION";
const UNKNOWN_DIMENSION_MESSAGE = "Skill bundle declares an unknown permission-bearing dimension.";
const NATIVE_KEYS: ReadonlySet<string> = new Set(["name", "description", "metadata"]);
const NATIVE_METADATA_KEYS: ReadonlySet<string> = new Set(["version", "tags", "tools", "requires", "keywords"]);

export interface SkillFrontmatterShape {
  /** From `metadata.version` only; a Claude Code skill's top-level `version` is ignored. */
  declaredVersion?: string;
  /** Present only when the skill was read as Claude Code format. */
  dialect?: ClaudeCodeFrontmatterReading;
}

export type SkillFrontmatterShapeCheck =
  | { ok: true; shape: SkillFrontmatterShape }
  | { ok: false; code: string; message: string };

/**
 * Without a dialect only `name`, `description` and GoatCitadel's own metadata pass, exactly as before the dialect
 * existed. A plugin skill the plugin check marked as Claude Code format is read against that format's explicit lists.
 */
export function checkSkillFrontmatterShape(
  frontmatter: Record<string, unknown>,
  dialect: "claude_code" | undefined,
): SkillFrontmatterShapeCheck {
  let reading: ClaudeCodeFrontmatterReading | undefined;
  if (dialect === "claude_code") {
    const check = checkClaudeCodeFrontmatter(frontmatter);
    if (!check.ok) {
      // The key goes to the log only; the plugin panel words the code. An unlisted key is the skill's own text, so
      // it is bounded.
      const key = JSON.stringify(check.key.slice(0, 64));
      const message =
        check.code === UNKNOWN_FRONTMATTER_DIMENSION
          ? `Claude Code skill frontmatter declares a key GoatCitadel doesn't know: ${key}.`
          : `Claude Code skill frontmatter sets ${key}, which GoatCitadel can't keep.`;
      return { ok: false, code: check.code, message };
    }
    reading = check.reading;
  } else {
    const refusal = nativeRefusal(frontmatter);
    if (refusal) return refusal;
  }
  const metadata = frontmatter.metadata;
  const version = isRecord(metadata) ? metadata.version : undefined;
  const declaredVersion = typeof version === "string" && version.trim() ? version.normalize("NFKC").trim() : undefined;
  return {
    ok: true,
    shape: { ...(declaredVersion ? { declaredVersion } : {}), ...(reading ? { dialect: reading } : {}) },
  };
}

function nativeRefusal(frontmatter: Record<string, unknown>): { ok: false; code: string; message: string } | undefined {
  const unknown = { ok: false as const, code: UNKNOWN_FRONTMATTER_DIMENSION, message: UNKNOWN_DIMENSION_MESSAGE };
  if (Object.keys(frontmatter).some((key) => !NATIVE_KEYS.has(key))) return unknown;
  const metadata = frontmatter.metadata;
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) {
    return { ...unknown, message: "Skill metadata is not a known permission shape." };
  }
  return Object.keys(metadata).some((key) => !NATIVE_METADATA_KEYS.has(key)) ? unknown : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
