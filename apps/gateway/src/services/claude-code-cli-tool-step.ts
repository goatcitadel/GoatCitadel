import type { ClaudeCliReasonCode } from "./claude-code-cli-process.js";
import type { ClaudeCliUsage } from "./claude-code-cli-stream.js";
import type { ClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";

/**
 * Bridged ("step mode") handling for the Claude Code CLI stream mapper: the
 * init tripwire, the governance faults, and the collection of one model step's
 * `tool_use` blocks into OpenAI-shaped `tool_calls`. Anything the bridge does
 * not expect fails the step closed.
 *
 * This module has no runtime imports from the stream or bridge modules (the
 * bridge imports the stream module), so the server name lives here and the
 * bridge re-exports it.
 */

export const CLAUDE_CLI_MCP_SERVER_NAME = "goatcitadel";
export const CLAUDE_CLI_MCP_TOOL_PREFIX = "mcp__goatcitadel__";

export interface ClaudeCliToolStep {
  chunks: Record<string, unknown>[];
  usage?: ClaudeCliUsage;
}

export interface ClaudeCliToolStepDeps {
  chunk: (delta: Record<string, unknown>, extra?: Record<string, unknown>) => Record<string, unknown>;
  /** Throws the typed CLI error; `detail` is a fixed diagnostic phrase, never CLI-provided text. */
  fail: (reasonCode: ClaudeCliReasonCode, detail?: string) => never;
  normalizeUsage: (usage: Record<string, unknown>) => ClaudeCliUsage | undefined;
}

export interface ClaudeCliToolStepCollector {
  /** Inspects a non-hook line. Returns true when the line is fully handled and the mapper must emit nothing. */
  observe(event: Record<string, unknown>): boolean;
  /** Defined once `message_stop` follows `stop_reason` "tool_use" or "max_tokens"; the same object on every call. */
  step(): ClaudeCliToolStep | undefined;
}

export function isClaudeCliToolUseBlock(block: Record<string, unknown>): boolean {
  return block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use";
}

interface StartedCall {
  id: string;
  modelName: string;
}

export function createClaudeCliToolStepCollector(
  manifest: ClaudeCliToolManifest,
  deps: ClaudeCliToolStepDeps,
): ClaudeCliToolStepCollector {
  const fail = (reasonCode: ClaudeCliReasonCode, detail?: string): never => deps.fail(reasonCode, detail);
  /** In `content_block_start` order, which is the order of the emitted tool_calls. */
  const calls: StartedCall[] = [];
  const argumentsById = new Map<string, string>();
  let sawInit = false;
  let messageStarts = 0;
  let stopReason: string | undefined;
  let usage: ClaudeCliUsage | undefined;
  let completed: ClaudeCliToolStep | undefined;

  const requireInit = (): void => {
    if (!sawInit) fail("claude_cli_bridge_mismatch", "model output arrived before the CLI reported its tools");
  };

  /** Validates a tool block's type and name and returns the runner's model-facing name. */
  const admitToolBlock = (block: Record<string, unknown>): string => {
    requireInit();
    if (block.type !== "tool_use") fail("claude_cli_tool_use_blocked");
    const modelName = typeof block.name === "string" ? manifest.cliNameToModelName.get(block.name) : undefined;
    return modelName ?? fail("claude_cli_tool_use_blocked");
  };

  const onInit = (event: Record<string, unknown>): void => {
    if (sawInit) fail("claude_cli_bridge_mismatch", "the CLI reported a second init");
    checkInitServers(event.mcp_servers, fail);
    checkInitTools(event.tools, manifest, fail);
    sawInit = true;
  };

  const onBlockStart = (block: Record<string, unknown>): boolean => {
    if (!isClaudeCliToolUseBlock(block)) return false;
    const modelName = admitToolBlock(block);
    const id = typeof block.id === "string" && block.id ? block.id : fail("claude_cli_bridge_mismatch");
    if (calls.some((call) => call.id === id)) fail("claude_cli_bridge_mismatch", "a tool call id repeated");
    calls.push({ id, modelName });
    return true;
  };

  const onAssistant = (content: unknown[]): void => {
    for (const block of content) {
      if (!isRecord(block) || !isClaudeCliToolUseBlock(block)) continue;
      const modelName = admitToolBlock(block);
      const call = calls.find((entry) => entry.id === block.id);
      if (!call || call.modelName !== modelName || argumentsById.has(call.id)) {
        return fail("claude_cli_bridge_mismatch", "a tool call arrived without its stream start");
      }
      argumentsById.set(call.id, toArguments(block.input));
    }
  };

  const onMessageStop = (): void => {
    if (stopReason === "max_tokens") {
      // A cut-off step never emits a partial tool call; the runner's truncation handling applies.
      completed = finalStep("length");
      return;
    }
    if (stopReason !== "tool_use") {
      if (calls.length > 0) fail("claude_cli_bridge_mismatch", "a tool call ended without a tool_use stop");
      return;
    }
    if (calls.length === 0) fail("claude_cli_bridge_mismatch", "a tool_use stop carried no tool call");
    const toolCalls = calls.map((call, index) => {
      const args = argumentsById.get(call.id) ?? fail("claude_cli_bridge_mismatch", "a tool call never completed");
      return { index, id: call.id, type: "function", function: { name: call.modelName, arguments: args } };
    });
    const step = finalStep("tool_calls");
    completed = { ...step, chunks: [deps.chunk({ tool_calls: toolCalls }), ...step.chunks] };
  };

  const finalStep = (finishReason: string): ClaudeCliToolStep => ({
    chunks: [{ ...deps.chunk({}, { finish_reason: finishReason }), ...(usage ? { usage } : {}) }],
    ...(usage ? { usage } : {}),
  });

  const onStreamEvent = (inner: Record<string, unknown>): boolean => {
    switch (inner.type) {
      case "message_start":
        requireInit();
        messageStarts += 1;
        if (messageStarts > 1) fail("claude_cli_bridge_mismatch", "a second model message started");
        return false;
      case "content_block_start":
        return isRecord(inner.content_block) ? onBlockStart(inner.content_block) : false;
      case "content_block_delta":
        // The complete input comes from the block's assistant line.
        return isRecord(inner.delta) && inner.delta.type === "input_json_delta";
      case "message_delta":
        requireInit();
        if (isRecord(inner.delta) && typeof inner.delta.stop_reason === "string") stopReason = inner.delta.stop_reason;
        if (isRecord(inner.usage)) usage = deps.normalizeUsage(inner.usage);
        return true;
      case "message_stop":
        onMessageStop();
        return true;
      default:
        return false;
    }
  };

  return {
    observe(event) {
      if (event.type === "system" && event.subtype === "init") {
        onInit(event);
        return true;
      }
      if (event.type === "system" && event.subtype === "permission_denied") {
        fail("claude_cli_bridge_mismatch", "the CLI denied a tool call itself");
      }
      if (event.type === "user" && hasToolResult(event.message)) {
        fail("claude_cli_bridge_mismatch", "the CLI produced a tool result itself");
      }
      if (event.type === "stream_event" && isRecord(event.event)) return onStreamEvent(event.event);
      if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
        onAssistant(event.message.content);
        return false;
      }
      if (event.type === "result") requireInit();
      return false;
    },
    step() {
      return completed;
    },
  };
}

function checkInitServers(servers: unknown, fail: ClaudeCliToolStepDeps["fail"]): void {
  const list = Array.isArray(servers) ? servers : [];
  const ours = list.filter((server) => isRecord(server) && server.name === CLAUDE_CLI_MCP_SERVER_NAME);
  if (list.length !== ours.length || ours.length > 1) {
    fail("claude_cli_bridge_mismatch", "the CLI reported an MCP server outside the bridge");
  }
  const [server] = ours;
  if (!isRecord(server) || server.status !== "connected") fail("claude_cli_bridge_unavailable");
}

function checkInitTools(tools: unknown, manifest: ClaudeCliToolManifest, fail: ClaudeCliToolStepDeps["fail"]): void {
  const expected = manifest.cliNameToModelName;
  const reported = Array.isArray(tools) ? tools : undefined;
  const exact =
    reported !== undefined &&
    reported.length === expected.size &&
    new Set(reported).size === reported.length &&
    reported.every((tool) => typeof tool === "string" && expected.has(tool));
  if (!exact) fail("claude_cli_bridge_mismatch", "the CLI's tool list does not match this step's manifest");
}

/** Object inputs are serialized; anything else passes through for the runner's protocol checks and repair. */
function toArguments(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? null);
}

function hasToolResult(message: unknown): boolean {
  return (
    isRecord(message) &&
    Array.isArray(message.content) &&
    message.content.some((block) => isRecord(block) && block.type === "tool_result")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
