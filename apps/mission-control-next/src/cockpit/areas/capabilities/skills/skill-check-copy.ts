import type { SkillHubBlockerCode } from "@goatcitadel/contracts";

// What GoatCitadel's checks found, in plain words. The codes themselves come from the Gateway as it stored them, and
// appear on screen only inside Technical details; nothing here decides whether a skill can be installed.

/** One plain sentence for each blocker code with a meaning of its own (contracts' `SKILL_HUB_BLOCKER_CODES`). */
export const SKILL_BLOCKER_COPY: Readonly<Record<SkillHubBlockerCode, string>> = {
  PROMPT_INJECTION_DETECTED: "Its instructions try to override GoatCitadel's rules.",
  PROMPTWARE_SCAN_INCOMPLETE: "Some of its files couldn't be checked.",
  SUSPICIOUS_SCRIPT_INDICATOR: "It includes scripts that look unsafe.",
  REFERENCE_ONLY_SOURCE: "This source can be read for reference but not installed.",
  CONDITIONAL_REVIEW_REQUIRED: "It needs a closer review before it can be installed.",
  AUDIT_MISSING: "Some of GoatCitadel's checks didn't run on it.",
  AUDIT_DOWNGRADE: "It passes fewer of GoatCitadel's checks than an earlier copy did.",
  UPSTREAM_VERSION_BYTE_DRIFT: "Its files changed without a new version number.",
  PERMISSION_WIDENED: "It asks for more than an earlier copy did.",
  PERMISSION_UNKNOWN: "GoatCitadel can't tell everything it asks for.",
  FOREIGN_SCOPE: "It was checked for another workspace.",
  MALFORMED_SOURCE_REFERENCE: "Its address isn't valid.",
  SECRET_LIKE_CONTENT: "It contains something that looks like a password or key.",
  UNTRUSTED_CORRECTION_ORIGIN: "It was changed by someone GoatCitadel couldn't confirm.",
  VALIDATION_FAILED: "Its files aren't valid.",
  CONFLICTING_CORRECTION: "It conflicts with another change to the same skill.",
  SOURCE_ALREADY_INSTALLED: "It's already installed.",
  CANDIDATE_ALREADY_EXISTS: "It's already installed.",
  RUNTIME_ALREADY_EXISTS: "It's already installed.",
};

/** The sentence for a code the map doesn't hold: it is one of GoatCitadel's checks all the same. */
export const UNKNOWN_BLOCKER_COPY = "It didn't pass one of GoatCitadel's checks.";

/** The line that ends a blocked check, unless the only reason is that it is installed already. */
export const CANT_BE_INSTALLED = "So it can't be installed.";

/** The codes that only say the source is installed already: nothing about it is wrong. */
const ALREADY_INSTALLED: ReadonlySet<string> = new Set([
  "SOURCE_ALREADY_INSTALLED",
  "CANDIDATE_ALREADY_EXISTS",
  "RUNTIME_ALREADY_EXISTS",
]);

/** The plain sentence for one blocker code. */
export function blockerSentence(code: string): string {
  return Object.hasOwn(SKILL_BLOCKER_COPY, code)
    ? SKILL_BLOCKER_COPY[code as SkillHubBlockerCode]
    : UNKNOWN_BLOCKER_COPY;
}

/**
 * The lines that explain a blocked check: one per sentence (codes that read the same say it once), then the closing
 * line, which a check blocked only because it is installed already doesn't get.
 */
export function blockerLines(codes: readonly string[]): string[] {
  const sentences = [...new Set((codes.length > 0 ? codes : [""]).map(blockerSentence))];
  const onlyInstalled = codes.length > 0 && codes.every((code) => ALREADY_INSTALLED.has(code));
  return onlyInstalled ? sentences : [...sentences, CANT_BE_INSTALLED];
}

/** The refusals whose own wording names what was wrong. Anything else keeps the plain line the request came back with. */
const CHECK_FAILURE_COPY: Readonly<Record<string, string>> = {
  UNKNOWN_FRONTMATTER_DIMENSION: "Its SKILL.md has settings GoatCitadel doesn't recognise.",
  BUNDLE_MANIFEST_INVALID: "Its list of files isn't valid.",
  UNKNOWN_BUNDLE_DIMENSION: "Its list of files isn't valid.",
  UNTRUSTED_GIT_HOST: "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
  // These two stop the check itself rather than marking it blocked, so they read like the blocker they are.
  PROMPT_INJECTION_DETECTED: `${SKILL_BLOCKER_COPY.PROMPT_INJECTION_DETECTED} ${CANT_BE_INSTALLED}`,
  PROMPTWARE_SCAN_INCOMPLETE: `${SKILL_BLOCKER_COPY.PROMPTWARE_SCAN_INCOMPLETE} ${CANT_BE_INSTALLED}`,
};

/**
 * Why a check was refused, from the refusal's `details.reason`. `fallback` is the plain line the request came back
 * with (`describeApiError(...).summary`), used for every reason without its own wording and when there is none.
 */
export function describeCheckFailure(code: string | undefined, fallback: string): string {
  return code !== undefined && Object.hasOwn(CHECK_FAILURE_COPY, code) ? CHECK_FAILURE_COPY[code]! : fallback;
}
