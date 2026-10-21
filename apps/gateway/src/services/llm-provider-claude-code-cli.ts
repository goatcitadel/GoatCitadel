import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_CLI_EGRESS_BASE_URL,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type {
  LlmProviderAdapter,
  LlmProviderAdapterHost,
  LlmProviderResolution,
  LlmTrackedProcessDispatch,
} from "./llm-provider-adapter.js";
import { claudeCodeHarnessExecutableNames, listExecutableCandidates } from "./agentic-harness-availability.js";
import {
  ClaudeCliError,
  buildClaudeCliArgs,
  isClaudeCliReasonCode,
  buildClaudeCliEnv,
  resolveClaudeCliInvocation,
  runClaudeCli,
  type ClaudeCliExit,
  type ClaudeCliInvocation,
  type ClaudeCliSpawn,
} from "./claude-code-cli-process.js";
import {
  buildStreamJsonUserMessage,
  claudeCliUserMessage,
  createClaudeCliStreamMapper,
  renderClaudeCliPrompt,
  type ClaudeCliStreamOutcome,
  type ClaudeCliToolStep,
  type ClaudeCliUsage,
} from "./claude-code-cli-stream.js";
import {
  buildClaudeCliToolManifest,
  resolveClaudeCliStubPath,
  writeClaudeCliBridgeFiles,
  type ClaudeCliToolManifest,
} from "./claude-code-cli-tool-bridge.js";
import {
  ClaudeCodeCliReadiness,
  claudeManagedSettingsDirs,
  detectClaudeManagedHooks,
  type ClaudeCodeCliReadinessResult,
  type ClaudeManagedHooksState,
  type ManagedSettingsFs,
} from "./claude-code-cli-readiness.js";
import { withUsageEvent } from "./llm-pricing.js";

const DEFAULT_OVERALL_TIMEOUT_MS = 300_000;
const IDLE_TIMEOUT_MS = 120_000;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const INVOCATION_CACHE_MS = 60_000;
// A just-killed CLI tree can briefly hold its cwd open on Windows (EBUSY); retry for ~2 s.
const RUN_DIR_RM_MAX_RETRIES = 20;
const RUN_DIR_RM_RETRY_DELAY_MS = 100;

const log = logger.child("llm-provider-claude-code-cli");

/** Injection points for tests and for hosts that pin the CLI location. */
export interface ClaudeCodeCliRuntimeOptions {
  spawn?: ClaudeCliSpawn;
  killTree?: (pid: number) => void;
  resolveInvocation?: () => ClaudeCliInvocation;
  readiness?: ClaudeCodeCliReadiness;
  /** Parent of the per-run scratch dirs (cwd + system prompt file). Defaults to the OS temp dir. */
  scratchRoot?: string;
  /** Tool-bridge overrides; by default the stub is found next to this module and run by this Node binary. */
  toolBridge?: { stubPath?: () => string | undefined; nodePath?: string };
}

/** Where one bridged step runs the MCP stub from; `stubPath` is undefined when the stub cannot be found. */
export interface ClaudeCodeCliToolBridgeLaunch {
  nodePath: string;
  stubPath: string | undefined;
}

export interface ClaudeCodeCliRuntime {
  readonly readiness: ClaudeCodeCliReadiness;
  readonly env: NodeJS.ProcessEnv;
  readonly scratchRoot: string;
  readonly spawn?: ClaudeCliSpawn;
  readonly killTree?: (pid: number) => void;
  /** Step-mode tool bridge flag; read per call, never cached. */
  toolBridgeEnabled(): boolean;
  /** This step's stub launch, or undefined when the flag is off. Resolved per step, never cached. */
  resolveToolBridgeLaunch(): ClaudeCodeCliToolBridgeLaunch | undefined;
  resolveInvocation(): ClaudeCliInvocation;
}

export function createClaudeCodeCliRuntime(
  env: NodeJS.ProcessEnv,
  serviceOptions: { claudeCli?: ClaudeCodeCliRuntimeOptions; claudeCliToolBridgeEnabled?: () => boolean } = {},
): ClaudeCodeCliRuntime {
  const options = serviceOptions.claudeCli ?? {};
  const bridgeEnabled = serviceOptions.claudeCliToolBridgeEnabled;
  const childEnv = buildClaudeCliEnv(env);
  let cached: { at: number; invocation: ClaudeCliInvocation } | undefined;
  const resolveInvocation =
    options.resolveInvocation ??
    (() => {
      if (cached && Date.now() - cached.at < INVOCATION_CACHE_MS) return cached.invocation;
      const resolved = resolveClaudeCliInvocation({
        env,
        candidates: claudeCodeHarnessExecutableNames().flatMap((name) => listExecutableCandidates(name)),
        fileExists: existsSync,
      });
      if ("error" in resolved) throw new ClaudeCliError(resolved.error, claudeCliUserMessage(resolved.error));
      cached = { at: Date.now(), invocation: resolved };
      return resolved;
    });
  const toolBridgeEnabled = () => bridgeEnabled?.() === true;
  const bridgeNodePath = options.toolBridge?.nodePath ?? process.execPath;
  const resolveBridgeStubPath = options.toolBridge?.stubPath ?? (() => resolveClaudeCliStubPath(existsSync));
  const runtime: ClaudeCodeCliRuntime = {
    env: childEnv,
    scratchRoot: options.scratchRoot ?? path.join(os.tmpdir(), "goatcitadel-claude-cli"),
    spawn: options.spawn,
    killTree: options.killTree,
    resolveInvocation,
    toolBridgeEnabled,
    resolveToolBridgeLaunch: () =>
      toolBridgeEnabled() ? { nodePath: bridgeNodePath, stubPath: resolveBridgeStubPath() } : undefined,
    readiness:
      options.readiness ??
      new ClaudeCodeCliReadiness({
        managedHooks: () => detectManagedHooksOnHost(env),
        run: async (args) => {
          const lines: string[] = [];
          const generator = runClaudeCli({
            invocation: resolveInvocation(),
            args,
            env: childEnv,
            cwd: os.tmpdir(),
            stdinPayload: "",
            overallTimeoutMs: AUTH_STATUS_TIMEOUT_MS,
            idleTimeoutMs: AUTH_STATUS_TIMEOUT_MS,
            spawn: options.spawn,
            killTree: options.killTree,
          });
          for (;;) {
            const next = await generator.next();
            if (next.done) return { exitCode: next.value.exitCode, stdout: lines.join("\n") };
            lines.push(next.value);
          }
        },
      }),
  };
  return runtime;
}

/** Whether this runtime may bridge Gateway tools (the feature flag, read per call). */
export function isClaudeCodeCliToolBridgeEnabled(runtime: ClaudeCodeCliRuntime | undefined): boolean {
  return runtime?.toolBridgeEnabled() === true;
}

/** Last probed readiness without spawning anything. */
export function peekClaudeCodeCliReadiness(runtime: ClaudeCodeCliRuntime): ClaudeCodeCliReadinessResult | undefined {
  return runtime.readiness.peek();
}

/** Probe-backed readiness (cached unless `refresh`). */
export async function checkClaudeCodeCliReadiness(
  runtime: ClaudeCodeCliRuntime,
  options: { refresh?: boolean } = {},
): Promise<ClaudeCodeCliReadinessResult> {
  if (options.refresh) runtime.readiness.invalidate();
  return await runtime.readiness.check();
}

export const claudeCodeCliProviderAdapter: LlmProviderAdapter = {
  apiStyle: "claude-code-cli",

  async chatCompletions(request, resolved, model, host, attribution = {}): Promise<ChatCompletionResponse> {
    let text = "";
    let id: string | undefined;
    let usage: ClaudeCliUsage | undefined;
    let eventIds: string[] | undefined;
    let finishReason = "stop";
    const toolCalls = new ToolCallAccumulator();
    for await (const chunk of claudeCodeCliProviderAdapter.chatCompletionsStream(
      request,
      resolved,
      model,
      host,
      attribution,
    )) {
      id ??= typeof chunk.id === "string" ? chunk.id : undefined;
      const delta = readDelta(chunk);
      if (typeof delta?.content === "string") text += delta.content;
      toolCalls.absorb(delta?.tool_calls);
      const chunkFinish = readFinishReason(chunk);
      if (chunkFinish) finishReason = chunkFinish;
      if (chunk.usage) usage = chunk.usage as ClaudeCliUsage;
      if (Array.isArray(chunk.model_usage_event_ids)) eventIds = chunk.model_usage_event_ids as string[];
    }
    const calls = toolCalls.list();
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text, ...(calls.length > 0 ? { tool_calls: calls } : {}) },
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage: { ...usage } } : {}),
      ...(eventIds && eventIds.length > 0 ? { modelUsageEventIds: eventIds } : {}),
    };
  },

  async *chatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    host: LlmProviderAdapterHost,
    attribution: ModelUsageAttributionContext = {},
  ): AsyncGenerator<Record<string, unknown>> {
    const runtime = host.claudeCodeCliRuntime?.();
    if (!runtime) throw new ClaudeCliError("claude_cli_missing", claudeCliUserMessage("claude_cli_missing"));
    assertNoRequiredToolCall(request);
    await assertCliReady(runtime);
    const invocation = runtime.resolveInvocation();
    buildClaudeCliArgs({ model }); // Validate the model id before any usage intent exists.
    // Resolved before the usage intent, so a missing stub leaves nothing to settle.
    const bridge = prepareToolBridge(request, () => runtime.resolveToolBridgeLaunch());
    const prompt = renderClaudeCliPrompt(request.messages, { bridged: bridge !== undefined });

    // Prepare local state before the usage intent exists, so a scratch-dir failure
    // cannot leave an accepted intent unsettled.
    const runDir = await mkdtempSafe(runtime.scratchRoot);
    let dispatch: LlmTrackedProcessDispatch;
    try {
      dispatch = await host.beginTrackedDispatch({
        resolved,
        model,
        requestedProviderId: attribution.requestedProviderId ?? request.providerId,
        requestedModelId: attribution.requestedModelId ?? request.model,
        attribution,
        transportAttemptIndex: 0,
        // The CLI ignores the profile baseUrl; authorize the origin it actually reaches.
        targetUrl: `${CLAUDE_CODE_CLI_EGRESS_BASE_URL}/messages`,
      });
    } catch (error) {
      await removeRunDir(runDir);
      throw error;
    }
    const accounting = dispatch.usage;
    const tag = <T extends object>(value: T) =>
      withUsageEvent(value, accounting, dispatch.priorModelUsageEventIds ?? []);
    let settled = false;
    try {
      const bridgeArgs = bridge
        ? { bridge: await writeClaudeCliBridgeFiles({ runDir, manifest: bridge.manifest, ...bridge.files }) }
        : {};
      let inlineSystem = false;
      for (;;) {
        let yielded = false;
        try {
          const systemPromptFile = prompt.system && !inlineSystem ? path.join(runDir, "system-prompt.txt") : undefined;
          if (systemPromptFile) await writeFile(systemPromptFile, prompt.system, "utf8");
          const mapper = createClaudeCliStreamMapper(model, bridge ? { bridge: bridge.manifest } : {});
          const lines = runClaudeCli({
            invocation,
            args: buildClaudeCliArgs({ model, systemPromptFile, ...bridgeArgs }),
            env: runtime.env,
            cwd: runDir,
            stdinPayload: buildStdinPayload(prompt, inlineSystem, bridge !== undefined),
            signal: request.signal,
            overallTimeoutMs: positiveOr(request.timeoutMs, DEFAULT_OVERALL_TIMEOUT_MS),
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            spawn: runtime.spawn,
            killTree: runtime.killTree,
          });
          let ended: { exit: ClaudeCliExit } | { toolStep: ClaudeCliToolStep } | undefined;
          try {
            while (!ended) {
              const next = await lines.next();
              if (next.done) {
                ended = { exit: next.value };
                break;
              }
              for (const chunk of mapper.push(next.value)) {
                yielded = true;
                await accounting?.renewLease();
                yield tag(chunk);
              }
              // Step mode: the CLI now waits on the inert stub, so the step ends here.
              const toolStep = mapper.toolStep();
              if (toolStep) ended = { toolStep };
            }
          } finally {
            // Closing the line source runs its cleanup, which kills a still-running CLI.
            if (!ended || !("exit" in ended)) await lines.return({ exitCode: null, stderrTail: "" });
          }
          const outcome =
            "exit" in ended ? finishedOutcome(mapper.finish(ended.exit)) : toolStepOutcome(ended, request);
          if (outcome.usage) accounting?.observe(outcome.usage);
          accounting?.observeNormalized({ effectiveModelId: model });
          settled = true;
          await accounting?.succeed();
          for (const chunk of outcome.chunks) yield tag(chunk);
          return;
        } catch (error) {
          if (!yielded && !inlineSystem && prompt.system && isSystemPromptFileRejection(error)) {
            inlineSystem = true;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ClaudeCliError && error.reasonCode === "claude_cli_logged_out") {
        runtime.readiness.invalidate();
      }
      if (!settled) {
        settled = true;
        if (error instanceof ClaudeCliError && error.reasonCode === "claude_cli_cancelled") {
          await accounting?.cancel(error);
        } else {
          await accounting?.fail(error);
        }
      }
      throw error;
    } finally {
      // A consumer that stops early cancels the attempt; the CLI itself is killed by runClaudeCli.
      if (!settled) await accounting?.cancel(new Error("Claude Code CLI stream closed by consumer"));
      await removeRunDir(runDir);
    }
  },
};

/** Operator decision: required tool calls fail clearly; offered tools are dropped. */
function assertNoRequiredToolCall(request: ChatCompletionRequest): void {
  if (!request.tools || request.tools.length === 0) return;
  const choice = request.tool_choice;
  const required =
    choice === "required" ||
    choice === "any" ||
    (typeof choice === "object" && choice !== null && choice.type !== "auto" && choice.type !== "none");
  if (required) {
    throw new ClaudeCliError("claude_cli_tools_unsupported", claudeCliUserMessage("claude_cli_tools_unsupported"));
  }
}

interface PreparedToolBridge {
  manifest: ClaudeCliToolManifest;
  files: { nodePath: string; stubPath: string };
}

/**
 * Step mode runs only when the flag is on for this step, tools are offered, and the
 * model may choose freely (`tool_choice` absent or auto). `"none"` keeps today's text-only run.
 */
function prepareToolBridge(
  request: ChatCompletionRequest,
  resolveLaunch: () => ClaudeCodeCliToolBridgeLaunch | undefined,
): PreparedToolBridge | undefined {
  if (!request.tools || request.tools.length === 0 || !isAutoToolChoice(request.tool_choice)) return undefined;
  const launch = resolveLaunch();
  if (!launch) return undefined;
  const manifest = buildClaudeCliToolManifest(request.tools);
  const { nodePath, stubPath } = launch;
  if (!stubPath) {
    throw new ClaudeCliError("claude_cli_bridge_unavailable", claudeCliUserMessage("claude_cli_bridge_unavailable"));
  }
  return { manifest, files: { nodePath, stubPath } };
}

function isAutoToolChoice(choice: ChatCompletionRequest["tool_choice"]): boolean {
  return (
    choice === undefined ||
    choice === "auto" ||
    (typeof choice === "object" && choice !== null && choice.type === "auto")
  );
}

/** Unbridged steps keep today's single text block; bridged steps send one block per rendered turn. */
function buildStdinPayload(
  prompt: { system: string; userText: string; userBlocks: string[] },
  inlineSystem: boolean,
  bridged: boolean,
): string {
  const systemBlock = prompt.system && inlineSystem ? `[System instructions]\n${prompt.system}` : undefined;
  if (bridged) {
    return buildStreamJsonUserMessage(systemBlock ? [systemBlock, ...prompt.userBlocks] : prompt.userBlocks);
  }
  return buildStreamJsonUserMessage(systemBlock ? `${systemBlock}\n\n${prompt.userText}` : prompt.userText);
}

interface StepOutcome {
  chunks: readonly Record<string, unknown>[];
  usage?: ClaudeCliUsage;
}

function finishedOutcome(outcome: ClaudeCliStreamOutcome): StepOutcome {
  return { chunks: [outcome.finalChunk], ...(outcome.usage ? { usage: outcome.usage } : {}) };
}

function toolStepOutcome(ended: { toolStep: ClaudeCliToolStep }, request: ChatCompletionRequest): StepOutcome {
  const { chunks, usage } = ended.toolStep;
  return {
    chunks: request.parallel_tool_calls === false ? keepFirstToolCall(chunks) : chunks,
    ...(usage ? { usage } : {}),
  };
}

/** `parallel_tool_calls: false`: only the step's first tool call reaches the runner. */
function keepFirstToolCall(chunks: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return chunks.map((chunk) => {
    const delta = readDelta(chunk);
    if (!delta || !Array.isArray(delta.tool_calls) || delta.tool_calls.length <= 1) return chunk;
    const choice = (chunk.choices as Record<string, unknown>[])[0];
    return { ...chunk, choices: [{ ...choice, delta: { ...delta, tool_calls: delta.tool_calls.slice(0, 1) } }] };
  });
}

/** Folds streamed `tool_calls` deltas (by index) into non-streaming `message.tool_calls`. */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  public absorb(deltaCalls: unknown): void {
    if (!Array.isArray(deltaCalls)) return;
    for (const entry of deltaCalls) {
      if (typeof entry !== "object" || entry === null) continue;
      const call = entry as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof call.index === "number" ? call.index : this.byIndex.size;
      const current = this.byIndex.get(index) ?? { id: "", name: "", arguments: "" };
      this.byIndex.set(index, {
        id: current.id || (typeof call.id === "string" ? call.id : ""),
        name: current.name || (typeof call.function?.name === "string" ? call.function.name : ""),
        arguments: current.arguments + (typeof call.function?.arguments === "string" ? call.function.arguments : ""),
      });
    }
  }

  public list(): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
    return [...this.byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
  }
}

async function assertCliReady(runtime: ClaudeCodeCliRuntime): Promise<void> {
  const readiness = await checkClaudeCodeCliReadiness(runtime);
  if (readiness.status === "ready") return;
  const reasonCode = isClaudeCliReasonCode(readiness.reasonCode) ? readiness.reasonCode : "claude_cli_failed";
  throw new ClaudeCliError(reasonCode, claudeCliUserMessage(reasonCode));
}

function isSystemPromptFileRejection(error: unknown): boolean {
  return (
    error instanceof ClaudeCliError &&
    error.reasonCode === "claude_cli_incompatible" &&
    (error.stderrTail ?? "").includes("system-prompt-file")
  );
}

/** Removes a run's scratch dir; a failure is logged (dir name and error code only) and never thrown. */
async function removeRunDir(runDir: string): Promise<void> {
  try {
    await rm(runDir, {
      recursive: true,
      force: true,
      maxRetries: RUN_DIR_RM_MAX_RETRIES,
      retryDelay: RUN_DIR_RM_RETRY_DELAY_MS,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    log.warn("Claude Code CLI run dir cleanup failed", {
      runDir: path.basename(runDir),
      code: typeof code === "string" ? code.slice(0, 32) : "unknown",
    });
  }
}

async function mkdtempSafe(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return await mkdtemp(path.join(root, "run-"));
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readDelta(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  return typeof choice === "object" && choice !== null && typeof (choice as { delta?: unknown }).delta === "object"
    ? ((choice as { delta: Record<string, unknown> }).delta ?? undefined)
    : undefined;
}

function readFinishReason(chunk: Record<string, unknown>): string | undefined {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  const reason =
    typeof choice === "object" && choice !== null ? (choice as { finish_reason?: unknown }).finish_reason : undefined;
  return typeof reason === "string" && reason ? reason : undefined;
}

const hostManagedSettingsFs: ManagedSettingsFs = {
  readFile(filePath) {
    try {
      return readFileSync(filePath, "utf8");
    } catch (error) {
      // Absent is fine; any other read failure must fail closed in the caller.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  listDir(dirPath) {
    try {
      return readdirSync(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        return [];
      }
      throw error;
    }
  },
};

function detectManagedHooksOnHost(env: NodeJS.ProcessEnv): ClaudeManagedHooksState {
  try {
    return detectClaudeManagedHooks(claudeManagedSettingsDirs(process.platform, env), hostManagedSettingsFs, path.sep);
  } catch {
    return "unreadable";
  }
}
