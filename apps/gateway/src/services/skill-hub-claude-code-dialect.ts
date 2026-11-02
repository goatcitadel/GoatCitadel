// How the Skill Hub review reads a Claude Code-format skill's frontmatter. Only a plugin skill the Gateway's plugin check
// marked as Claude Code format is read this way; every other skill keeps the native rule (name, description and
// metadata only). Nothing here rewrites the file: the review keeps the exact bytes and records what it left out.
// Every key is on an explicit list. A key no list names is refused, as it is for a native skill.

export const CLAUDE_CODE_SKILL_DIALECT = {
  /** Left out, and recorded. Leaving them out never widens what the model may do. */
  ignoredKeys: [
    "allowed-tools",
    "argument-hint",
    "license",
    "compatibility",
    "version",
    "model",
    "effort",
    "when_to_use",
  ],
  /** Left out with a warning: `user-invocable: false` widens what the operator can start (never the model). */
  warnedKeys: ["user-invocable"],
  /** Refused: leaving them out would loosen the skill or change where it runs. */
  refusedKeys: ["disable-model-invocation", "disallowed-tools", "paths", "hooks", "context", "agent", "background"],
  /** Under `metadata`, beside GoatCitadel's own version, tags, tools, requires and keywords. */
  ignoredMetadataKeys: ["author", "organization", "date", "abstract"],
} as const;

export const CLAUDE_CODE_SETTING_NOT_KEPT = "CLAUDE_CODE_SETTING_NOT_KEPT" as const;
export const SKILL_RUNS_SHELL_COMMANDS = "SKILL_RUNS_SHELL_COMMANDS" as const;

// Claude Code runs these lines before the model reads the skill. A false match costs one skill; a miss hands the model
// a command, so the patterns lean wide: an inline !`command` after anything but a backtick or word character, and a
// fence of three or more backticks opened with `!`. Code blocks are not exempt.
const INLINE_SHELL_LINE = /(^|[^`\w])!`[^`\n]+`/m;
const FENCED_SHELL_BLOCK = /^\s*`{3,}!/m;

export interface ClaudeCodeFrontmatterReading {
  /** Sorted; metadata keys as `metadata.<key>`. */
  ignoredKeys: string[];
  /** `user-invocable` when its value is `false`; a `true` value is only ignored. */
  widenedKeys: string[];
}

export type ClaudeCodeFrontmatterCheck =
  | { ok: true; reading: ClaudeCodeFrontmatterReading }
  | { ok: false; code: typeof CLAUDE_CODE_SETTING_NOT_KEPT | "UNKNOWN_FRONTMATTER_DIMENSION"; key: string };

const UNKNOWN_FRONTMATTER_DIMENSION = "UNKNOWN_FRONTMATTER_DIMENSION" as const;
const NATIVE_KEYS: readonly string[] = ["name", "description", "metadata"];
const NATIVE_METADATA_KEYS: readonly string[] = ["version", "tags", "tools", "requires", "keywords"];
const IGNORED_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_CODE_SKILL_DIALECT.ignoredKeys,
  ...CLAUDE_CODE_SKILL_DIALECT.warnedKeys,
]);
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...NATIVE_KEYS, ...IGNORED_KEYS]);
const IGNORED_METADATA_KEYS: ReadonlySet<string> = new Set<string>(CLAUDE_CODE_SKILL_DIALECT.ignoredMetadataKeys);
const KNOWN_METADATA_KEYS: ReadonlySet<string> = new Set<string>([...NATIVE_METADATA_KEYS, ...IGNORED_METADATA_KEYS]);

/**
 * Checks a Claude Code skill's frontmatter against the explicit lists. A refused key answers first, the first in the
 * list's order so the answer is stable; then any key no list names; then metadata that isn't an object or holds an
 * unlisted key. A skill that passes gets the keys the review left out, sorted.
 */
export function checkClaudeCodeFrontmatter(frontmatter: Record<string, unknown>): ClaudeCodeFrontmatterCheck {
  const keys = Object.keys(frontmatter);
  const refused = CLAUDE_CODE_SKILL_DIALECT.refusedKeys.find((key) => Object.hasOwn(frontmatter, key));
  if (refused !== undefined) return { ok: false, code: CLAUDE_CODE_SETTING_NOT_KEPT, key: refused };
  const unknown = keys.find((key) => !KNOWN_KEYS.has(key));
  if (unknown !== undefined) return { ok: false, code: UNKNOWN_FRONTMATTER_DIMENSION, key: unknown };
  const metadata = frontmatter.metadata;
  const metadataKeys = metadata === undefined ? [] : isPlainObject(metadata) ? Object.keys(metadata) : undefined;
  if (metadataKeys === undefined) return { ok: false, code: UNKNOWN_FRONTMATTER_DIMENSION, key: "metadata" };
  const unknownMetadata = metadataKeys.find((key) => !KNOWN_METADATA_KEYS.has(key));
  if (unknownMetadata !== undefined) {
    return { ok: false, code: UNKNOWN_FRONTMATTER_DIMENSION, key: `metadata.${unknownMetadata}` };
  }
  const ignoredKeys = [
    ...keys.filter((key) => IGNORED_KEYS.has(key)),
    ...metadataKeys.filter((key) => IGNORED_METADATA_KEYS.has(key)).map((key) => `metadata.${key}`),
  ].sort(compareStrings);
  // Only a literal `true` keeps the skill one the operator can start by name, as it is here; anything else is warned.
  const widenedKeys = CLAUDE_CODE_SKILL_DIALECT.warnedKeys.filter(
    (key) => Object.hasOwn(frontmatter, key) && frontmatter[key] !== true,
  );
  return { ok: true, reading: { ignoredKeys, widenedKeys } };
}

/** The finding codes a review records for a skill read as Claude Code format. */
export function claudeCodeDialectFindingCodes(reading: ClaudeCodeFrontmatterReading): string[] {
  return [
    "CLAUDE_CODE_DIALECT_APPLIED",
    ...(reading.ignoredKeys.length > 0 ? ["CLAUDE_CODE_KEYS_IGNORED"] : []),
    ...(reading.widenedKeys.length > 0 ? ["CLAUDE_CODE_USER_INVOCABLE_WIDENED"] : []),
  ];
}

/** Whether SKILL.md holds a Claude Code shell line: an inline !`command`, or a fenced block opened with ```!. */
export function hasClaudeCodeShellLines(skillMarkdown: string): boolean {
  return INLINE_SHELL_LINE.test(skillMarkdown) || FENCED_SHELL_BLOCK.test(skillMarkdown);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
