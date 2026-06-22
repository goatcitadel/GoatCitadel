import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { LOCAL_PATH_TOOL_NAMES } from "./chat-tool-families.js";

/**
 * P0-B answer-recovery ladder — pure helpers.
 *
 * cowork/chat turns that end empty, reasoning-only, or hit a tool/loop/budget
 * limit must not silently return a blank or a templated non-model string
 * reported as `completed`. These functions classify the gap, build a tool-less
 * nudge that re-asks the model for the user-visible answer, and — when the
 * outcome is genuinely degraded — surface that honestly (a calm footer plus the
 * file mutations that failed and were never superseded).
 *
 * Everything here is side-effect free so the orchestrator can compose it with
 * the existing model-based recovery passes (synthesizeToolOutcomeFallback /
 * repairIncompleteAssistantCompletion) and so the behavior is unit-testable in
 * isolation.
 */

/** The kind of "no user-visible answer" gap a terminal turn ended on. */
export type AnswerGapKind = "empty" | "reasoning_only" | "tool_use_without_answer" | "none";

export interface AnswerGapInput {
  /** The turn produced visible assistant text the user can read. */
  hasVisibleText: boolean;
  /** The turn produced reasoning/thinking content but no visible answer. */
  hasReasoningText: boolean;
  /** Number of tool calls the terminal assistant message requested. */
  toolCallCount: number;
}

/**
 * Classify how a terminal turn failed to land a user-visible answer.
 *
 * Precedence (per P0-B):
 * - visible text present => "none" (nothing to recover)
 * - else tool calls present => "tool_use_without_answer" (model called tools but never wrote the answer)
 * - else reasoning present => "reasoning_only" (model "thought" but emitted no answer)
 * - else => "empty"
 */
export function classifyAnswerGap(input: AnswerGapInput): AnswerGapKind {
  if (input.hasVisibleText) {
    return "none";
  }
  if (input.toolCallCount > 0) {
    return "tool_use_without_answer";
  }
  if (input.hasReasoningText) {
    return "reasoning_only";
  }
  return "empty";
}

/**
 * Build a short, tool-less instruction that re-asks the model to produce the
 * user-visible answer now. The text is distinct per gap so the model gets a
 * targeted prod rather than a generic "try again". Returns an empty string for
 * the "none" gap so callers can treat it as a no-op.
 */
export function buildAnswerRecoveryNudge(gap: AnswerGapKind): string {
  switch (gap) {
    case "reasoning_only":
      return [
        "You produced internal reasoning but no user-visible answer.",
        "Write the final answer for the user now, in plain language.",
        "Do not call any tools and do not narrate your reasoning — give the answer itself.",
      ].join(" ");
    case "tool_use_without_answer":
      return [
        "You requested tools but never wrote a user-visible answer.",
        "Using the tool results already gathered in this conversation, write the final answer for the user now.",
        "Do not call any more tools. If the evidence is incomplete, answer with what you have and state the remaining uncertainty briefly.",
      ].join(" ");
    case "empty":
      return [
        "Your last turn produced no user-visible answer.",
        "Write the final answer for the user now, directly addressing the request.",
        "Do not call any tools. If you cannot fully answer, give your best partial answer and say what is missing.",
      ].join(" ");
    case "none":
      return "";
  }
}

export interface DegradedAnswerOutcome {
  /** Short machine/audit reason the turn ended degraded. */
  reason: string;
  /** True when a model pass recovered a real answer (so no apology footer needed). */
  recoveredByModel: boolean;
}

/**
 * Build a single calm sentence disclosing that the turn ended degraded. Returns
 * an empty string when the answer was recovered cleanly by a model pass — an
 * honest, fully recovered answer should not carry an apology.
 */
export function buildDegradedAnswerFooter(degraded: DegradedAnswerOutcome): string {
  if (degraded.recoveredByModel) {
    return "";
  }
  return "Note: I could not fully complete this turn, so parts of this answer may be incomplete.";
}

/** A file-mutating tool run that failed and was not later superseded. */
export interface FailedFileMutation {
  toolName: string;
  path?: string;
  error: string;
}

/**
 * The file-mutating tool families. Sourced from the shared local-path tool set
 * (fs.write / fs.move / fs.delete / fs.copy) plus the artifact/document
 * generators that also commit bytes to disk, so the "what did not get written"
 * disclosure stays in sync with the rest of the orchestrator's tool taxonomy.
 */
const FILE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  [...LOCAL_PATH_TOOL_NAMES, "artifacts.create", "documents.create", "presentations.create"].filter((toolName) =>
    isFileMutationToolName(toolName),
  ),
);

function isFileMutationToolName(toolName: string): boolean {
  if (toolName === "artifacts.create" || toolName === "documents.create" || toolName === "presentations.create") {
    return true;
  }
  // fs.write / fs.move / fs.delete / fs.copy mutate the filesystem; fs.read /
  // fs.list / fs.stat / code.search and the read-only file tools do not.
  return /^fs\.(write|move|delete|copy)$/.test(toolName);
}

/** Best-effort extraction of the mutated path from a tool run's args. */
function readMutationPath(run: ChatToolRunRecord): string | undefined {
  const args = run.args;
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const candidates = [args.path, args.targetPath, args.destination, args.dest, args.to];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Given the turn's tool runs (in execution order), return the file-mutating
 * runs that FAILED and were not superseded by a later successful write to the
 * same path. A later successful mutation of the same path means the failure was
 * recovered, so it should not be reported as a lost mutation.
 *
 * Failures with no resolvable path are always reported (they cannot be proven
 * superseded). Immutable: never mutates the input array.
 */
export function collectFailedFileMutations(toolRuns: readonly ChatToolRunRecord[]): FailedFileMutation[] {
  const fileMutations = toolRuns.filter((run) => FILE_MUTATION_TOOL_NAMES.has(run.toolName));
  const succeededPaths = new Set<string>();
  for (const run of fileMutations) {
    if (run.status === "executed") {
      const path = readMutationPath(run);
      if (path) {
        succeededPaths.add(path);
      }
    }
  }

  const failures: FailedFileMutation[] = [];
  for (const run of fileMutations) {
    if (run.status !== "failed" && run.status !== "blocked") {
      continue;
    }
    const path = readMutationPath(run);
    if (path && succeededPaths.has(path)) {
      // A later successful write to the same path recovered this failure.
      continue;
    }
    failures.push({
      toolName: run.toolName,
      ...(path ? { path } : {}),
      error:
        run.error?.trim() ||
        (run.status === "blocked" ? "Tool call was blocked by policy." : "Tool call failed."),
    });
  }
  return failures;
}

/**
 * Render a compact, plain-language disclosure of file mutations that did not
 * land, suitable for appending to the assistant answer. Returns an empty string
 * when nothing failed.
 */
export function buildFailedFileMutationsFooter(failures: readonly FailedFileMutation[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.map((failure) => {
    const target = failure.path ? ` \`${failure.path}\`` : "";
    return `- \`${failure.toolName}\`${target}: ${failure.error}`;
  });
  const heading =
    failures.length === 1
      ? "One file change did not complete:"
      : `${failures.length} file changes did not complete:`;
  return [heading, ...lines].join("\n");
}
