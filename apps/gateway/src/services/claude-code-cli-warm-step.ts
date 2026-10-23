import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { CLAUDE_CLI_RESULTS_DIR, CLAUDE_CLI_TOOL_USE_ID_PATTERN } from "./claude-code-cli-mcp-stub.js";
import { ClaudeCliError, runClaudeCli, type ClaudeCliExit, type RunClaudeCliInput } from "./claude-code-cli-process.js";
import {
  startClaudeCliSession,
  type ClaudeCliSegmentOptions,
  type ClaudeCliSession,
} from "./claude-code-cli-session.js";
import {
  claudeCliUserMessage,
  createClaudeCliStreamMapper,
  type ClaudeCliStreamMapper,
  type ClaudeCliStreamOutcome,
  type ClaudeCliToolStep,
  type ClaudeCliUsage,
} from "./claude-code-cli-stream.js";
import type { ClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import type { ClaudeCliWarmFingerprint } from "./claude-code-cli-warm-match.js";
import {
  CLAUDE_CLI_WARM_ECHO_DEADLINE_MS,
  CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS,
  logBackgroundReapFailure,
  type ClaudeCliWarmRegistry,
} from "./claude-code-cli-warm-registry.js";

/**
 * One Claude Code CLI step's line pump, plus warm continuation: parking a bridged
 * step's live process at its tool_use stop, and resuming it when the runner's next
 * request is exactly that step's continuation. The adapter owns the usage attempt
 * around each step; this module owns what runs inside it.
 */

const log = logger.child("claude-code-cli-warm-step");

export interface ClaudeCliStepOutcome {
  chunks: readonly Record<string, unknown>[];
  usage?: ClaudeCliUsage;
}

/** What a step body gets from the usage attempt that wraps it. */
export interface ClaudeCliStepContext {
  tag(chunk: Record<string, unknown>): Record<string, unknown>;
  renewLease(): Promise<void>;
}

/** A step body the adapter runs inside one usage attempt. */
export interface ClaudeCliAccountedStep {
  /** The usage intent was refused: undo local preparation. Nothing else has run. */
  abandon(): Promise<void>;
  /** Streams the step's chunks and returns its outcome for settlement. */
  run(context: ClaudeCliStepContext): AsyncGenerator<Record<string, unknown>, ClaudeCliStepOutcome>;
  /** Runs once the step is over, however it ended. */
  cleanup(): Promise<void>;
}

/** A bridged step's child env while the warm flag is on: a copy of the scrubbed env plus the CLI's tool timeout. */
export function withClaudeCliWarmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, MCP_TOOL_TIMEOUT: String(CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS) };
}

/**
 * A cold step's line source. A step that may park runs as a session, so its process can outlive
 * the segment; any other step keeps today's single-segment `runClaudeCli`.
 */
export function openClaudeCliStepLines(
  input: RunClaudeCliInput,
  parkable: boolean,
): { lines: AsyncGenerator<string, ClaudeCliExit>; session?: ClaudeCliSession } {
  if (!parkable) return { lines: runClaudeCli(input) };
  if (input.signal?.aborted) {
    throw new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was cancelled before it started");
  }
  const session = startClaudeCliSession(input);
  return { lines: session.segment(input), session };
}

/**
 * Feeds one segment's lines through the mapper and yields tagged chunks. A tool step ends the
 * segment at its message_stop; `park` runs then, while the segment is still open, so a parked
 * process survives the segment's close. Anything not parked is killed by that close, as today.
 */
export async function* streamClaudeCliStep(input: {
  lines: AsyncGenerator<string, ClaudeCliExit>;
  mapper: ClaudeCliStreamMapper;
  request: ChatCompletionRequest;
  context: ClaudeCliStepContext;
  /** Called at a tool step's end; true once the registry owns the process. */
  park?: () => boolean;
  onYield?: () => void;
}): AsyncGenerator<Record<string, unknown>, { outcome: ClaudeCliStepOutcome; parked: boolean }> {
  const { lines, mapper, context } = input;
  let ended: { exit: ClaudeCliExit } | { toolStep: ClaudeCliToolStep } | undefined;
  let parked = false;
  try {
    while (!ended) {
      const next = await lines.next();
      if (next.done) {
        ended = { exit: next.value };
        break;
      }
      for (const chunk of mapper.push(next.value)) {
        input.onYield?.();
        await context.renewLease();
        yield context.tag(chunk);
      }
      // Step mode: the CLI now waits on the stub, so the step ends here.
      const toolStep = mapper.toolStep();
      if (toolStep) ended = { toolStep };
    }
    if ("toolStep" in ended) parked = input.park?.() ?? false;
  } finally {
    // Closing the line source runs its cleanup, which kills a still-running CLI unless it was parked.
    if (!ended || !("exit" in ended)) await lines.return({ exitCode: null, stderrTail: "" });
  }
  const outcome =
    "exit" in ended ? finishedOutcome(mapper.finish(ended.exit)) : toolStepOutcome(ended.toolStep, input.request);
  return { outcome, parked };
}

export interface ClaudeCliParkInput {
  registry: ClaudeCliWarmRegistry;
  /** The warm flag as read for this step. */
  enabled: boolean;
  session: ClaudeCliSession;
  runDir: string;
  manifest: ClaudeCliToolManifest;
  /** Undefined without session and turn attribution. */
  fingerprint: ClaudeCliWarmFingerprint | undefined;
  mapper: ClaudeCliStreamMapper;
  request: ChatCompletionRequest;
}

/** Hands a finished tool step's live process to the registry; false when a park condition fails. */
export function parkClaudeCliStep(input: ClaudeCliParkInput): boolean {
  const { request, fingerprint } = input;
  if (!input.enabled || !fingerprint || request.signal?.aborted) return false;
  if (!isToolCallsStep(input.mapper.toolStep())) return false;
  const emitted = input.mapper.emittedAssistant();
  if (!emitted || emitted.calls.length === 0) return false;
  // keepFirstToolCall: the runner never sees the dropped calls, so the CLI's history would disagree.
  if (request.parallel_tool_calls === false && emitted.calls.length > 1) return false;
  const pendingIds = emitted.calls.map((call) => call.id);
  if (!pendingIds.every((id) => CLAUDE_CLI_TOOL_USE_ID_PATTERN.test(id))) return false;
  try {
    input.registry.park({
      session: input.session,
      runDir: input.runDir,
      manifest: input.manifest,
      fingerprint,
      emitted,
      pendingIds,
      turnSignal: request.signal,
    });
    return true;
  } catch (error) {
    log.warn("Claude Code CLI warm park failed", { code: errorName(error) });
    return false;
  }
}

/**
 * On a warm hit, the resumed step as the adapter's accounted step: its usage intent first,
 * then the result files, then the parked process's next segment. Undefined on a miss, which
 * the registry has already reaped and logged.
 */
export function tryResumeClaudeCliWarmStep(input: {
  registry: ClaudeCliWarmRegistry;
  fingerprint: ClaudeCliWarmFingerprint;
  request: ChatCompletionRequest;
  model: string;
  timeouts: Pick<ClaudeCliSegmentOptions, "overallTimeoutMs" | "idleTimeoutMs">;
  runAccounted: (step: ClaudeCliAccountedStep) => AsyncGenerator<Record<string, unknown>>;
}): AsyncGenerator<Record<string, unknown>> | undefined {
  const { registry, request } = input;
  const take = registry.take(input.fingerprint, request);
  if (!take.hit) return undefined;
  const { step, results } = take;
  // Never resume with nothing delivered: an empty map would also disable the init tripwire.
  if (results.length === 0) {
    registry.reapInBackground(step, "resumed_failure");
    return undefined;
  }
  let parked = false;
  let finished = false;
  return input.runAccounted({
    abandon: () => registry.reap(step, "resumed_failure"),
    async *run(context) {
      // Opened before any result is staged: segment() detaches the heartbeat-only drain at once, so an
      // echo of the first result, arriving while a later one is still being written, queues for this
      // segment instead of poisoning the park. If staging fails, cleanup's reap kills the session.
      const lines = step.session.segment({ signal: request.signal, ...input.timeouts });
      // Cancelled while the usage intent was in flight: stage nothing; cleanup's reap kills the session.
      if (request.signal?.aborted) {
        throw new ClaudeCliError("claude_cli_cancelled", claudeCliUserMessage("claude_cli_cancelled"));
      }
      await stageClaudeCliWarmResults(step.runDir, step.manifest.nonce, results);
      const mapper = createClaudeCliStreamMapper(input.model, {
        bridge: step.manifest,
        continuation: { delivered: new Map(results.map((result) => [result.toolUseId, result.text])) },
      });
      // A result the stub never delivered is never echoed; fail fast instead of waiting out the overall
      // timeout, and well before the CLI's own MCP_TOOL_TIMEOUT could invent an error result.
      let echoDeadlineHit = false;
      const echoTimer = setTimeout(() => {
        if (!mapper.awaitingEchoes()) return;
        echoDeadlineHit = true;
        void step.session.kill().catch(logBackgroundReapFailure);
      }, CLAUDE_CLI_WARM_ECHO_DEADLINE_MS);
      echoTimer.unref?.();
      try {
        const streamed = yield* streamClaudeCliStep({
          lines,
          mapper,
          request,
          context,
          park: () =>
            parkClaudeCliStep({
              registry,
              enabled: true,
              session: step.session,
              runDir: step.runDir,
              manifest: step.manifest,
              fingerprint: input.fingerprint,
              mapper,
              request,
            }),
        });
        parked = streamed.parked;
        finished = true;
        return streamed.outcome;
      } catch (error) {
        if (!echoDeadlineHit) throw error;
        throw new ClaudeCliError(
          "claude_cli_bridge_mismatch",
          `${claudeCliUserMessage("claude_cli_bridge_mismatch")}: a delivered tool result was never echoed`,
          { cause: error },
        );
      } finally {
        clearTimeout(echoTimer);
      }
    },
    // Kills what is left of the tree, removes the run dir and runs the registry's spill check.
    cleanup: async () => {
      if (!parked) await registry.reap(step, finished ? "resumed_done" : "resumed_failure");
    },
  });
}

/** Writes each result as `<toolUseId>.tmp`, then renames it, so the stub never reads a partial file. */
async function stageClaudeCliWarmResults(
  runDir: string,
  nonce: string,
  results: ReadonlyArray<{ toolUseId: string; text: string }>,
): Promise<void> {
  const resultsDir = path.join(runDir, CLAUDE_CLI_RESULTS_DIR);
  try {
    for (const { toolUseId, text } of results) {
      if (!CLAUDE_CLI_TOOL_USE_ID_PATTERN.test(toolUseId)) {
        throw new Error("a tool-use id is not a plain toolu_ token");
      }
      const staged = path.join(resultsDir, `${toolUseId}.tmp`);
      await writeFile(staged, JSON.stringify({ nonce, toolUseId, text }), { mode: 0o600 });
      await rename(staged, path.join(resultsDir, `${toolUseId}.json`));
    }
  } catch (error) {
    throw new ClaudeCliError("claude_cli_bridge_unavailable", claudeCliUserMessage("claude_cli_bridge_unavailable"), {
      cause: error,
    });
  }
}

function isToolCallsStep(step: ClaudeCliToolStep | undefined): boolean {
  const last = step?.chunks.at(-1);
  const choice = last && Array.isArray(last.choices) ? (last.choices[0] as { finish_reason?: unknown }) : undefined;
  return choice?.finish_reason === "tool_calls";
}

function finishedOutcome(outcome: ClaudeCliStreamOutcome): ClaudeCliStepOutcome {
  return { chunks: [outcome.finalChunk], ...(outcome.usage ? { usage: outcome.usage } : {}) };
}

function toolStepOutcome(step: ClaudeCliToolStep, request: ChatCompletionRequest): ClaudeCliStepOutcome {
  const { chunks, usage } = step;
  return {
    chunks: request.parallel_tool_calls === false ? keepFirstToolCall(chunks) : chunks,
    ...(usage ? { usage } : {}),
  };
}

/** `parallel_tool_calls: false`: only the step's first tool call reaches the runner. */
function keepFirstToolCall(chunks: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return chunks.map((chunk) => {
    const delta = readClaudeCliDelta(chunk);
    if (!delta || !Array.isArray(delta.tool_calls) || delta.tool_calls.length <= 1) return chunk;
    const choice = (chunk.choices as Record<string, unknown>[])[0];
    return { ...chunk, choices: [{ ...choice, delta: { ...delta, tool_calls: delta.tool_calls.slice(0, 1) } }] };
  });
}

export function readClaudeCliDelta(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  return typeof choice === "object" && choice !== null && typeof (choice as { delta?: unknown }).delta === "object"
    ? ((choice as { delta: Record<string, unknown> }).delta ?? undefined)
    : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 32) : "unknown";
}
