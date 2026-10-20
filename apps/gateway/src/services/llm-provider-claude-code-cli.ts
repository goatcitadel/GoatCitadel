import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type { LlmProviderAdapter, LlmProviderAdapterHost, LlmProviderResolution } from "./llm-provider-adapter.js";
import { claudeCodeHarnessExecutableNames, listExecutableCandidates } from "./agentic-harness-availability.js";
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
import { ClaudeCodeCliReadiness } from "./claude-code-cli-readiness.js";
import { withUsageEvent } from "./llm-pricing.js";

const DEFAULT_OVERALL_TIMEOUT_MS = 300_000;
const IDLE_TIMEOUT_MS = 120_000;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const INVOCATION_CACHE_MS = 60_000;

/** Injection points for tests and for hosts that pin the CLI location. */
export interface ClaudeCodeCliRuntimeOptions {
  spawn?: ClaudeCliSpawn;
  killTree?: (pid: number) => void;
  resolveInvocation?: () => ClaudeCliInvocation;
  readiness?: ClaudeCodeCliReadiness;
  /** Parent of the per-run scratch dirs (cwd + system prompt file). Defaults to the OS temp dir. */
  scratchRoot?: string;
}

export interface ClaudeCodeCliRuntime {
  readonly readiness: ClaudeCodeCliReadiness;
  readonly env: NodeJS.ProcessEnv;
  readonly scratchRoot: string;
  readonly spawn?: ClaudeCliSpawn;
  readonly killTree?: (pid: number) => void;
  resolveInvocation(): ClaudeCliInvocation;
}

export function createClaudeCodeCliRuntime(
  env: NodeJS.ProcessEnv,
  options: ClaudeCodeCliRuntimeOptions = {},
): ClaudeCodeCliRuntime {
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
  const runtime: ClaudeCodeCliRuntime = {
    env: childEnv,
    scratchRoot: options.scratchRoot ?? path.join(os.tmpdir(), "goatcitadel-claude-cli"),
    spawn: options.spawn,
    killTree: options.killTree,
    resolveInvocation,
    readiness:
      options.readiness ??
      new ClaudeCodeCliReadiness({
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

export const claudeCodeCliProviderAdapter: LlmProviderAdapter = {
  apiStyle: "claude-code-cli",

  async chatCompletions(request, resolved, model, host, attribution = {}): Promise<ChatCompletionResponse> {
    let text = "";
    let id: string | undefined;
    let usage: ClaudeCliUsage | undefined;
    let eventIds: string[] | undefined;
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
      if (chunk.usage) usage = chunk.usage as ClaudeCliUsage;
      if (Array.isArray(chunk.model_usage_event_ids)) eventIds = chunk.model_usage_event_ids as string[];
    }
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
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
    const prompt = renderClaudeCliPrompt(request.messages);

    const dispatch = await host.beginTrackedDispatch({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      targetUrl: `${resolved.provider.baseUrl}/messages`,
    });
    const accounting = dispatch.usage;
    const tag = <T extends object>(value: T) =>
      withUsageEvent(value, accounting, dispatch.priorModelUsageEventIds ?? []);
    let settled = false;
    const runDir = await mkdtempSafe(runtime.scratchRoot);
    try {
      let inlineSystem = false;
      for (;;) {
        let yielded = false;
        try {
          const systemPromptFile = prompt.system && !inlineSystem ? path.join(runDir, "system-prompt.txt") : undefined;
          if (systemPromptFile) await writeFile(systemPromptFile, prompt.system, "utf8");
          const userText =
            prompt.system && inlineSystem
              ? `[System instructions]\n${prompt.system}\n\n${prompt.userText}`
              : prompt.userText;
          const mapper = createClaudeCliStreamMapper(model);
          const lines = runClaudeCli({
            invocation,
            args: buildClaudeCliArgs({ model, systemPromptFile }),
            env: runtime.env,
            cwd: runDir,
            stdinPayload: buildStreamJsonUserMessage(userText),
            signal: request.signal,
            overallTimeoutMs: positiveOr(request.timeoutMs, DEFAULT_OVERALL_TIMEOUT_MS),
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            spawn: runtime.spawn,
            killTree: runtime.killTree,
          });
          let exit;
          try {
            for (;;) {
              const next = await lines.next();
              if (next.done) {
                exit = next.value;
                break;
              }
              for (const chunk of mapper.push(next.value)) {
                yielded = true;
                await accounting?.renewLease();
                yield tag(chunk);
              }
            }
          } finally {
            // Closing the line source runs its cleanup, which kills a still-running CLI.
            if (!exit) await lines.return({ exitCode: null, stderrTail: "" });
          }
          const outcome = mapper.finish(exit);
          accounting?.observe(outcome.usage);
          accounting?.observeNormalized({ effectiveModelId: model });
          settled = true;
          await accounting?.succeed();
          yield tag(outcome.finalChunk);
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
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
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

async function assertCliReady(runtime: ClaudeCodeCliRuntime): Promise<void> {
  const readiness = await runtime.readiness.check();
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
