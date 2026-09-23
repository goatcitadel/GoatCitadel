/**
 * Secret-shaped environment key names. A child process spawned on behalf of the
 * model must never inherit harness or operator credentials: anything the child
 * can read it can echo into tool output, persisted artifacts, or audit rows.
 * Matching is by key NAME only — values are never inspected here; output-side
 * redaction (`redactSecretText`) remains the second line of defense.
 */
export const SECRET_ENV_KEY_PATTERN =
  // AUTH deliberately excludes AUTHOR-shaped continuations (AUTH(?!OR_|OR\b)):
  // GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL are identity, not credentials, and git
  // commit needs them. AUTHORIZATION, OAUTH, AUTH_TOKEN still match.
  /(?:API[_-]?KEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|PASSPHRASE|CONNECTION_STRING|AUTH(?!OR_|OR\b)|COOKIE|CREDENTIAL|DATABASE_URL|OPENAI|ANTHROPIC|GOOGLE|GEMINI|MOONSHOT|PERPLEXITY|MISTRAL|OPENROUTER|DEEPSEEK|GLM|GROQ|XAI|POSTGRES|PASSWORD|SECRET|TOKEN)/i;

/**
 * Variables that point git at a repository other than the one it discovers from its working directory:
 * `git rev-parse --local-env-vars`, minus the `-c` config carriers that git itself keeps when it runs in
 * another repository. Git exports some of them to hooks, so a git child aimed at an explicit repository
 * would otherwise act on whichever repository invoked the gateway or test run.
 */
export const GIT_REPOSITORY_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

export interface ScrubbedSpawnEnvOptions {
  /** Merged last with caller intent; not pattern-filtered. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Exact key names rescued despite matching the drop pattern (case-insensitive). */
  readonly passthroughKeys?: readonly string[];
  /** Override for the drop pattern; defaults to {@link SECRET_ENV_KEY_PATTERN}. */
  readonly dropPattern?: RegExp;
  /**
   * Exact key names always removed from `baseEnv` (case-insensitive), even when listed in `passthroughKeys`.
   * `extraEnv` can still set them deliberately.
   */
  readonly dropKeys?: readonly string[];
}

/**
 * Build a child-process environment from `baseEnv` with secret-shaped keys
 * removed. Returns a new object; `baseEnv` is never mutated. Key matching is
 * case-insensitive (Windows env semantics) while retained keys preserve their
 * original casing, so `ComSpec`/`Path` survive intact for win32 children.
 */
export function buildScrubbedSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: ScrubbedSpawnEnvOptions = {},
): Record<string, string> {
  // Re-create the drop pattern without global/sticky flags: a caller-supplied
  // /g or /y pattern would otherwise carry lastIndex between .test() calls and
  // silently skip alternate keys.
  const suppliedPattern = options.dropPattern ?? SECRET_ENV_KEY_PATTERN;
  const dropPattern = new RegExp(suppliedPattern.source, suppliedPattern.flags.replace(/[gy]/g, ""));
  const passthrough = new Set((options.passthroughKeys ?? []).map((key) => key.toUpperCase()));
  const dropKeys = new Set((options.dropKeys ?? []).map((key) => key.toUpperCase()));
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || dropKeys.has(key.toUpperCase())) {
      continue;
    }
    if (dropPattern.test(key) && !passthrough.has(key.toUpperCase())) {
      continue;
    }
    scrubbed[key] = value;
  }
  return {
    ...scrubbed,
    ...options.extraEnv,
  };
}
