import { parseSkillMarkdown } from "@goatcitadel/skills";
import { normalizeSkillId } from "./skill-import-service.js";

/**
 * Shared skill-content validation + security scan.
 *
 * The directory-based skill import path ({@link file://./skill-import-service.ts})
 * historically inlined these regexes. They are extracted here so the governed
 * self-authoring write path ({@link file://./skill-mutation-service.ts}) can apply
 * exactly the same suspicious-script / network / secret screening to an
 * in-memory `SKILL.md` body without round-tripping through the filesystem scanner.
 *
 * These patterns are intentionally identical to the import scanner so a draft that
 * import would reject is also rejected here.
 */

/** High-risk shell/script indicators (matches the import directory scanner). */
export const SUSPICIOUS_SCRIPT_PATTERN = /(rm\s+-rf|del\s+\/f|powershell\s+-enc|invoke-webrequest\s+.*\|\s*iex)/i;

/** Outbound-network indicators (matches the import directory scanner). */
export const NETWORK_INDICATOR_PATTERN = /(https?:\/\/|fetch\s*\(|axios\.|curl\s+)/i;

/**
 * Secret-like content. Mirrors the learned-memory write gate
 * ({@link file://./memory-write-gate-service.ts}) so secrets are blocked from
 * skill content with the same rule that blocks them from memory.
 */
export const SECRET_CONTENT_PATTERN =
  /(?:api[_-]?key|secret|password|token|credential|sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,})/i;

export interface SkillContentValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  readonly inferredSkillName?: string;
  readonly inferredSkillId?: string;
  readonly checks: {
    readonly frontmatterValid: boolean;
    readonly descriptionQuality: boolean;
    readonly suspiciousScripts: boolean;
    readonly networkIndicators: boolean;
    readonly containsSecret: boolean;
  };
}

export interface ValidateSkillContentInput {
  /** Raw `SKILL.md` markdown (frontmatter + body). */
  readonly skillMarkdown: string;
  /**
   * When true (default) network indicators are a hard error rather than a
   * warning. The self-authoring path rejects network/script-laden drafts; the
   * import path treats network usage as an advisory warning instead.
   */
  readonly rejectNetworkIndicators?: boolean;
}

/**
 * Validate + security-scan an in-memory skill draft.
 *
 * Pure: no filesystem access, no mutation. Suspicious scripts and secrets are
 * always hard errors; network indicators are a hard error when
 * `rejectNetworkIndicators` is set (the self-authoring default).
 */
export function validateSkillContent(input: ValidateSkillContentInput): SkillContentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let inferredSkillName: string | undefined;
  let inferredSkillId: string | undefined;
  let frontmatterValid = false;
  let descriptionQuality = false;

  try {
    const parsed = parseSkillMarkdown(input.skillMarkdown);
    frontmatterValid = true;
    inferredSkillName = parsed.frontmatter.name.trim();
    try {
      inferredSkillId = normalizeSkillId(parsed.frontmatter.name);
    } catch (error) {
      errors.push(`Invalid skill name: ${(error as Error).message}`);
    }
    const description = parsed.frontmatter.description.trim();
    descriptionQuality = description.length >= 24 && description.split(/\s+/).length >= 4;
    if (!descriptionQuality) {
      warnings.push("Description is very short; quality score reduced.");
    }
  } catch (error) {
    errors.push(`Invalid SKILL.md: ${(error as Error).message}`);
  }

  const suspiciousScripts = SUSPICIOUS_SCRIPT_PATTERN.test(input.skillMarkdown);
  const networkIndicators = NETWORK_INDICATOR_PATTERN.test(input.skillMarkdown);
  const containsSecret = SECRET_CONTENT_PATTERN.test(input.skillMarkdown);

  if (suspiciousScripts) {
    errors.push("Skill draft contains high-risk script indicators and cannot be authored automatically.");
  }
  if (containsSecret) {
    errors.push("Skill draft contains secret-like content; secrets are blocked from skill files.");
  }
  if (networkIndicators) {
    if (input.rejectNetworkIndicators ?? true) {
      errors.push("Skill draft contains outbound-network indicators and cannot be authored automatically.");
    } else {
      warnings.push("Network usage indicators detected in skill content.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    inferredSkillName,
    inferredSkillId,
    checks: {
      frontmatterValid,
      descriptionQuality,
      suspiciousScripts,
      networkIndicators,
      containsSecret,
    },
  };
}
