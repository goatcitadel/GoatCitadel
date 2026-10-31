/** Bounds for `code_mode.request` arguments; the registry schema states the same limits to the model. */
export const CODE_MODE_REQUEST_GOAL_MAX_CHARS = 120;
export const CODE_MODE_REQUEST_SOURCE_MAX_CHARS = 20_000;
export const CODE_MODE_REQUEST_READS_MAX = 10;

const CODE_MODE_REQUEST_ARG_KEYS = new Set(["goal", "source", "language", "input", "reads"]);

export interface CodeModeRequestArgs {
  goal: string;
  source: string;
  language: "javascript" | "typescript";
  input?: Record<string, unknown>;
  reads?: string[];
}

/** Validates `code_mode.request` arguments and returns them with the default language applied. */
export function readCodeModeRequestArgs(args: Record<string, unknown>): CodeModeRequestArgs {
  const unknownKey = Object.keys(args).find((key) => !CODE_MODE_REQUEST_ARG_KEYS.has(key));
  if (unknownKey) throw new Error(`code_mode.request does not accept the argument "${unknownKey}".`);
  const { goal, source, language, input, reads } = args;
  if (typeof goal !== "string" || !goal.trim() || goal.length > CODE_MODE_REQUEST_GOAL_MAX_CHARS) {
    throw new Error(`code_mode.request needs a goal of 1 to ${CODE_MODE_REQUEST_GOAL_MAX_CHARS} characters.`);
  }
  if (typeof source !== "string" || !source.trim() || source.length > CODE_MODE_REQUEST_SOURCE_MAX_CHARS) {
    throw new Error(`code_mode.request needs a script of 1 to ${CODE_MODE_REQUEST_SOURCE_MAX_CHARS} characters.`);
  }
  if (language !== undefined && language !== "javascript" && language !== "typescript") {
    throw new Error('code_mode.request language must be "javascript" or "typescript".');
  }
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new Error("code_mode.request input must be an object.");
  }
  if (
    reads !== undefined &&
    (!Array.isArray(reads) ||
      reads.length > CODE_MODE_REQUEST_READS_MAX ||
      reads.some((entry) => typeof entry !== "string" || !entry.trim()))
  ) {
    throw new Error(`code_mode.request reads must be a list of at most ${CODE_MODE_REQUEST_READS_MAX} paths or IDs.`);
  }
  return {
    goal,
    source,
    language: language ?? "javascript",
    ...(input !== undefined ? { input: input as Record<string, unknown> } : {}),
    ...(reads !== undefined ? { reads: reads as string[] } : {}),
  };
}
