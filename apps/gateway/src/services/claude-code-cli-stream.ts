import { randomUUID } from "node:crypto";
import type { ChatCompletionMessage } from "@goatcitadel/contracts";
import { ClaudeCliError, type ClaudeCliExit, type ClaudeCliReasonCode } from "./claude-code-cli-process.js";
import { normalizeAnthropicUsage } from "./llm-provider-anthropic.js";

/**
 * Maps Claude Code CLI `--output-format stream-json` lines onto the
 * OpenAI-shaped chunks every GoatCitadel provider adapter yields.
 */

/** Anthropic-shaped usage (prompt_tokens = uncached input; cache fields passed through), like the Messages adapter. */
export type ClaudeCliUsage = Record<string, unknown>;

export interface ClaudeCliStreamOutcome {
  finalChunk: Record<string, unknown>;
  /** Undefined when the CLI reported no usage, so it is recorded as unknown rather than zero. */
  usage?: ClaudeCliUsage;
  text: string;
}

export interface ClaudeCliStreamMapper {
  push(line: string): Record<string, unknown>[];
  finish(exit: ClaudeCliExit): ClaudeCliStreamOutcome;
}

const USER_FACING_MESSAGES: Record<ClaudeCliReasonCode, string> = {
  claude_cli_missing: "Claude Code is not installed on this host. Install it, then retry",
  claude_cli_logged_out: "The local Claude Code CLI is not logged in. Run `claude auth login`, then retry",
  claude_cli_usage_limited: "Your Claude subscription usage limit was reached",
  claude_cli_incompatible: "The installed Claude Code CLI does not support a required flag. Update Claude Code",
  claude_cli_model_unavailable: "The selected model is not available through your Claude Code login",
  claude_cli_tool_use_blocked: "The Claude Code CLI attempted a tool call, which GoatCitadel blocks on this provider",
  claude_cli_timeout: "The Claude Code CLI timed out",
  claude_cli_failed: "The Claude Code CLI run failed",
  claude_cli_tools_unsupported:
    "This turn requires tool calls, which the Claude Code CLI provider does not support. Switch providers for agentic or Code Mode turns",
  claude_cli_not_subscription_login:
    "The local Claude Code CLI is signed in with an API key, not a Claude subscription login",
  claude_cli_unsupported_shim:
    "Only an unsupported Claude Code launcher was found. Install the native build or set GOATCITADEL_CLAUDE_CLI_PATH",
  claude_cli_cancelled: "The Claude Code CLI run was cancelled",
  claude_cli_hook_blocked:
    "A Claude Code hook ran during this turn, which GoatCitadel blocks because hooks bypass its approvals",
  claude_cli_managed_hooks_active:
    "This Claude Code install has organization-managed hooks, which GoatCitadel cannot disable. Use another provider",
};

export function claudeCliUserMessage(reasonCode: ClaudeCliReasonCode): string {
  return USER_FACING_MESSAGES[reasonCode];
}

export function classifyClaudeCliFailure(text: string): ClaudeCliReasonCode {
  const normalized = text.toLowerCase();
  if (
    /not logged in|please run \/login|invalid api key|authentication_error|failed to authenticate|(?:oauth|session|token)\b[^.\n]{0,40}\bexpired|login required/.test(
      normalized,
    )
  ) {
    return "claude_cli_logged_out";
  }
  if (/usage limit|rate_limit|rate limit|quota/.test(normalized)) return "claude_cli_usage_limited";
  if (/unknown option|unrecognized option|unknown argument|invalid option/.test(normalized)) {
    return "claude_cli_incompatible";
  }
  if (/model\b.*\b(?:not found|not available|invalid|does not exist)|not_found_error/.test(normalized)) {
    return "claude_cli_model_unavailable";
  }
  return "claude_cli_failed";
}

export function createClaudeCliStreamMapper(model: string): ClaudeCliStreamMapper {
  const id = `chatcmpl-claude-cli-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sawDelta = false;
  let text = "";
  let result: Record<string, unknown> | undefined;

  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, ...extra }],
  });
  const blockToolUse = (): never => {
    throw new ClaudeCliError("claude_cli_tool_use_blocked", claudeCliUserMessage("claude_cli_tool_use_blocked"));
  };

  return {
    push(line) {
      const event = parseRecord(line);
      if (!event) return [];
      if (isHookEvent(event)) {
        throw new ClaudeCliError("claude_cli_hook_blocked", claudeCliUserMessage("claude_cli_hook_blocked"));
      }
      if (event.type === "stream_event" && isRecord(event.event)) {
        const inner = event.event;
        if (inner.type === "content_block_start" && isRecord(inner.content_block)) {
          if (isToolUseBlock(inner.content_block)) blockToolUse();
          return [];
        }
        if (inner.type === "content_block_delta" && isRecord(inner.delta)) {
          if (inner.delta.type === "text_delta" && typeof inner.delta.text === "string" && inner.delta.text) {
            sawDelta = true;
            text += inner.delta.text;
            return [chunk({ content: inner.delta.text })];
          }
          if (
            inner.delta.type === "thinking_delta" &&
            typeof inner.delta.thinking === "string" &&
            inner.delta.thinking
          ) {
            return [chunk({ reasoning_content: inner.delta.thinking })];
          }
          if (inner.delta.type === "input_json_delta") blockToolUse();
        }
        return [];
      }
      if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
        if (event.message.content.some((block) => isRecord(block) && isToolUseBlock(block))) blockToolUse();
        if (sawDelta) return [];
        // The CLI reports its own failures (e.g. "Failed to authenticate") as a synthetic assistant
        // message before the error result; that text is not a model reply.
        if (event.message.model === "<synthetic>") return [];
        const full = event.message.content
          .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .join("");
        if (!full) return [];
        text += full;
        return [chunk({ content: full })];
      }
      if (event.type === "result") result = event;
      return [];
    },

    finish(exit) {
      if (!result) {
        const reasonCode = exit.exitCode === 0 ? "claude_cli_failed" : classifyClaudeCliFailure(exit.stderrTail);
        throw new ClaudeCliError(reasonCode, claudeCliUserMessage(reasonCode), {
          exitCode: exit.exitCode,
          stderrTail: exit.stderrTail,
        });
      }
      if (result.is_error === true || result.subtype !== "success") {
        const detail = [
          typeof result.result === "string" ? result.result : "",
          stringifyErrors(result.errors),
          exit.stderrTail,
        ]
          .filter(Boolean)
          .join("\n");
        const reasonCode = classifyClaudeCliFailure(detail);
        throw new ClaudeCliError(reasonCode, claudeCliUserMessage(reasonCode), {
          exitCode: exit.exitCode,
          stderrTail: exit.stderrTail,
        });
      }
      const usage = isRecord(result.usage) ? normalizeAnthropicUsage(result.usage) : undefined;
      return {
        finalChunk: { ...chunk({}, { finish_reason: "stop" }), ...(usage ? { usage } : {}) },
        ...(usage ? { usage } : {}),
        text: text || (typeof result.result === "string" ? result.result : ""),
      };
    },
  };
}

export function renderClaudeCliPrompt(messages: readonly ChatCompletionMessage[]): {
  system: string;
  userText: string;
} {
  const system: string[] = [];
  const turns: Array<{ label: string; body: string }> = [];
  for (const message of messages) {
    const body = renderContent(message.content);
    if (message.role === "system" || message.role === "developer") {
      if (body) system.push(body);
      continue;
    }
    const label =
      message.role === "assistant"
        ? "Assistant"
        : message.role === "tool"
          ? `Tool result${message.tool_call_id ? ` ${message.tool_call_id}` : ""}`
          : "User";
    turns.push({ label, body });
  }
  const only = turns[0];
  const userText =
    turns.length === 1 && only?.label === "User"
      ? only.body
      : [
          "The conversation so far is below. Reply as the assistant to the final user turn.",
          ...turns.map((turn) => `[${turn.label}]\n${turn.body}`),
        ].join("\n\n");
  return { system: system.join("\n\n"), userText };
}

export function buildStreamJsonUserMessage(userText: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: userText }] } })}\n`;
}

function renderContent(content: ChatCompletionMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyErrors(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n") : "";
}

/** Hook lifecycle lines from `--include-hook-events` (e.g. system/hook_started, hook_response). */
function isHookEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === "string" ? event.type : "";
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  return /hook/i.test(type) || /hook/i.test(subtype) || "hook_event_name" in event || "hook_name" in event;
}

function isToolUseBlock(block: Record<string, unknown>): boolean {
  return block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use";
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
