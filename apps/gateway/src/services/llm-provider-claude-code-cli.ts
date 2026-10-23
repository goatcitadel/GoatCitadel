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
import { ClaudeCliWarmRegistry } from "./claude-code-cli-warm-registry.js";
import {
  ClaudeCliError,
  buildClaudeCliArgs,
  isClaudeCliReasonCode,
  buildClaudeCliEnv,
  resolveClaudeCliInvocation,
  runClaudeCli,
  type ClaudeCliInvocation,
  type ClaudeCliSpawn,
} from "./claude-code-cli-process.js";
import {
  buildStreamJsonUserMessage,
  claudeCliUserMessage,
  createClaudeCliStreamMapper,
  renderClaudeCliPrompt,
  type ClaudeCliUsage,
} from "./claude-code-cli-stream.js";
import { fingerprintClaudeCliStep } from "./claude-code-cli-warm-match.js";
import {
  openClaudeCliStepLines,
  parkClaudeCliStep,
  readClaudeCliDelta,
  streamClaudeCliStep,
  tryResumeClaudeCliWarmStep,
  withClaudeCliWarmEnv,
  type ClaudeCliAccountedStep,
} from "./claude-code-cli-warm-step.js";
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
// A just-killed CLI tree can briefly hold its cwd open on Windows (EBUSY). fs.rm's backoff is
// linear (retry n waits n × the delay), so 6 retries of 100 ms wait at most ~2.1 s in total.
const RUN_DIR_RM_MAX_RETRIES = 6;
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
  /** Warm continuation flag; true only while the bridge flag is also on. Read per call, never cached. */
  warmContinuationEnabled(): boolean;
  /** Parked `claude -p` processes awaiting their tool results. */
  readonly warm: ClaudeCliWarmRegistry;
  resolveInvocation(): ClaudeCliInvocation;
}

export function createClaudeCodeCliRuntime(
  env: NodeJS.ProcessEnv,
  serviceOptions: {
    claudeCli?: ClaudeCodeCliRuntimeOptions;
    claudeCliToolBridgeEnabled?: () => boolean;
    claudeCliWarmContinuationEnabled?: () => boolean;
  } = {},
): ClaudeCodeCliRuntime {
  const options = serviceOptions.claudeCli ?? {};
  const bridgeEnabled = serviceOptions.claudeCliToolBridgeEnabled;
  const warmEnabled = serviceOptions.claudeCliWarmContinuationEnabled;
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
  const warmContinuationEnabled = () => toolBridgeEnabled() && warmEnabled?.() === true;
  const bridgeNodePath = options.toolBridge?.nodePath ?? process.execPath;
  const resolveBridgeStubPath = options.toolBridge?.stubPath ?? (() => resolveClaudeCliStubPath(existsSync));
  const runtime: ClaudeCodeCliRuntime = {
    env: childEnv,
    scratchRoot: options.scratchRoot ?? path.join(os.tmpdir(), "goatcitadel-claude-cli"),
    spawn: options.spawn,
    killTree: options.killTree,
    resolveInvocation,
    toolBridgeEnabled,
    warmContinuationEnabled,
    warm: new ClaudeCliWarmRegistry({ removeRunDir, claudeProjectsDir: () => resolveClaudeProjectsDir(childEnv) }),
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

/** Kills every parked warm process (Gateway shutdown). A helper keeps LlmService's architecture-metrics member-access count flat. */
export async function reapClaudeCodeCliWarm(
  owner: { readonly warm: ClaudeCliWarmRegistry },
  reason: "shutdown",
): Promise<void> {
  await owner.warm.reapAll(reason);
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
      const delta = readClaudeCliDelta(chunk);
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
    // Read once per step; warm continuation applies to bridged steps only.
    const warmFlag = runtime.warmContinuationEnabled();
    // A request for this turn that will not continue warm ends the turn's parked process first. Like a
    // take() miss, the reap is fire-and-forget: its tree kill is signalled synchronously, before any
    // cold spawn below, and only the bounded close wait and run-dir removal finish in the background.
    const { sessionId, turnId } = attribution;
    const releaseTurn = () => {
      if (sessionId && turnId) void runtime.warm.reapTurn(sessionId, turnId);
    };
    if (!(warmFlag && offersAutoTools(request))) releaseTurn();
    let invocation: ClaudeCliInvocation;
    let bridge: PreparedToolBridge | undefined;
    try {
      assertNoRequiredToolCall(request);
      await assertCliReady(runtime);
      invocation = runtime.resolveInvocation();
      buildClaudeCliArgs({ model }); // Validate the model id before any usage intent exists.
      // Resolved before the usage intent, so a missing stub leaves nothing to settle.
      bridge = prepareToolBridge(request, () => runtime.resolveToolBridgeLaunch());
    } catch (error) {
      releaseTurn();
      throw error;
    }
    const prompt = renderClaudeCliPrompt(request.messages, { bridged: bridge !== undefined });
    const timeouts = {
      overallTimeoutMs: positiveOr(request.timeoutMs, DEFAULT_OVERALL_TIMEOUT_MS),
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    };
    const runAccounted = (step: ClaudeCliAccountedStep) =>
      runAccountedClaudeCliStep(
        () => runtime.readiness.invalidate(),
        model,
        step,
        () =>
          host.beginTrackedDispatch({
            resolved,
            model,
            requestedProviderId: attribution.requestedProviderId ?? request.providerId,
            requestedModelId: attribution.requestedModelId ?? request.model,
            attribution,
            transportAttemptIndex: 0,
            // The CLI ignores the profile baseUrl; authorize the origin it actually reaches.
            targetUrl: `${CLAUDE_CODE_CLI_EGRESS_BASE_URL}/messages`,
          }),
      );

    const warm = bridge !== undefined && warmFlag;
    const fingerprint =
      bridge && warm
        ? fingerprintClaudeCliStep({ request, attribution, model, system: prompt.system, manifest: bridge.manifest })
        : undefined;
    if (!fingerprint) releaseTurn();
    // A miss has already killed the parked tree for this turn, before the cold step below spawns.
    const resumed = fingerprint
      ? tryResumeClaudeCliWarmStep({ registry: runtime.warm, fingerprint, request, model, timeouts, runAccounted })
      : undefined;
    if (resumed) {
      yield* resumed;
      return;
    }

    // Prepare local state before the usage intent exists, so a scratch-dir failure
    // cannot leave an accepted intent unsettled.
    const runDir = await mkdtempSafe(runtime.scratchRoot);
    let parked = false;
    yield* runAccounted({
      abandon: () => removeRunDir(runDir),
      async *run(context) {
        const bridgeArgs = bridge
          ? { bridge: await writeClaudeCliBridgeFiles({ runDir, manifest: bridge.manifest, ...bridge.files }) }
          : {};
        // A copy: the warm flag adds the CLI's tool timeout and never touches the shared env.
        const env = warm ? withClaudeCliWarmEnv(runtime.env) : runtime.env;
        let inlineSystem = false;
        for (;;) {
          let yielded = false;
          try {
            const systemPromptFile =
              prompt.system && !inlineSystem ? path.join(runDir, "system-prompt.txt") : undefined;
            if (systemPromptFile) await writeFile(systemPromptFile, prompt.system, "utf8");
            const mapper = createClaudeCliStreamMapper(model, bridge ? { bridge: bridge.manifest } : {});
            const { lines, session } = openClaudeCliStepLines(
              {
                invocation,
                args: buildClaudeCliArgs({ model, systemPromptFile, ...bridgeArgs }),
                env,
                cwd: runDir,
                stdinPayload: buildStdinPayload(prompt, inlineSystem, bridge !== undefined),
                signal: request.signal,
                ...timeouts,
                spawn: runtime.spawn,
                killTree: runtime.killTree,
              },
              warm,
            );
            const park =
              session && bridge
                ? () =>
                    parkClaudeCliStep({
                      registry: runtime.warm,
                      enabled: warm,
                      session,
                      runDir,
                      manifest: bridge.manifest,
                      fingerprint,
                      mapper,
                      request,
                    })
                : undefined;
            const streamed = yield* streamClaudeCliStep({
              lines,
              mapper,
              request,
              context,
              park,
              onYield: () => {
                yielded = true;
              },
            });
            parked = streamed.parked;
            return streamed.outcome;
          } catch (error) {
            if (!yielded && !inlineSystem && prompt.system && isSystemPromptFileRejection(error)) {
              inlineSystem = true;
              continue;
            }
            throw error;
          }
        }
      },
      // A parked step's run dir now belongs to the registry.
      cleanup: async () => {
        if (!parked) await removeRunDir(runDir);
      },
    });
  },
};

/**
 * One step inside one usage attempt: the intent first (a refusal undoes the step's local
 * preparation), then the body, then settlement from the body's outcome. A consumer that
 * stops early cancels the attempt; closing the body's line source kills an unparked CLI.
 */
async function* runAccountedClaudeCliStep(
  invalidateReadiness: () => void,
  model: string,
  step: ClaudeCliAccountedStep,
  begin: () => Promise<LlmTrackedProcessDispatch>,
): AsyncGenerator<Record<string, unknown>> {
  let dispatch: LlmTrackedProcessDispatch;
  try {
    dispatch = await begin();
  } catch (error) {
    await step.abandon();
    throw error;
  }
  const accounting = dispatch.usage;
  const tag = (chunk: Record<string, unknown>) =>
    withUsageEvent(chunk, accounting, dispatch.priorModelUsageEventIds ?? []);
  let settled = false;
  try {
    const outcome = yield* step.run({
      tag,
      renewLease: async () => {
        await accounting?.renewLease();
      },
    });
    if (outcome.usage) accounting?.observe(outcome.usage);
    accounting?.observeNormalized({ effectiveModelId: model });
    settled = true;
    await accounting?.succeed();
    for (const chunk of outcome.chunks) yield tag(chunk);
  } catch (error) {
    if (error instanceof ClaudeCliError && error.reasonCode === "claude_cli_logged_out") {
      invalidateReadiness();
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
    if (!settled) await accounting?.cancel(new Error("Claude Code CLI stream closed by consumer"));
    await step.cleanup();
  }
}

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
  if (!offersAutoTools(request)) return undefined;
  const launch = resolveLaunch();
  if (!launch) return undefined;
  const manifest = buildClaudeCliToolManifest(request.tools);
  const { nodePath, stubPath } = launch;
  if (!stubPath) {
    throw new ClaudeCliError("claude_cli_bridge_unavailable", claudeCliUserMessage("claude_cli_bridge_unavailable"));
  }
  return { manifest, files: { nodePath, stubPath } };
}

/** Tools are offered and the model may choose freely: the only requests that can be bridged. */
function offersAutoTools(
  request: ChatCompletionRequest,
): request is ChatCompletionRequest & { tools: NonNullable<ChatCompletionRequest["tools"]> } {
  return request.tools !== undefined && request.tools.length > 0 && isAutoToolChoice(request.tool_choice);
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

/** The CLI's projects folder as the child sees it: `CLAUDE_CONFIG_DIR`, else `<home>/.claude`, plus `projects`. */
function resolveClaudeProjectsDir(childEnv: NodeJS.ProcessEnv): string | undefined {
  const configDir = childEnv.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return path.join(configDir, "projects");
  const home = os.homedir();
  return home ? path.join(home, ".claude", "projects") : undefined;
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
