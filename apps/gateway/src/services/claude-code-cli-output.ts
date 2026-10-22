import { ClaudeCliError, type ClaudeCliReasonCode } from "./claude-code-cli-process.js";

/**
 * Leaf helpers shared by the Claude Code CLI stream mapper and its bridged
 * tool-step collector: the user-facing failure text, the typed step failure,
 * and the OpenAI-shaped chunk both of them emit. It imports neither module,
 * so the collector can use these directly instead of having them injected.
 */

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
    "This request forces a specific tool call, which the Claude Code CLI provider cannot do. Ask without forcing a tool, or use another provider",
  claude_cli_not_subscription_login:
    "The local Claude Code CLI is signed in with an API key, not a Claude subscription login",
  claude_cli_unsupported_shim:
    "Only an unsupported Claude Code launcher was found. Install the native build or set GOATCITADEL_CLAUDE_CLI_PATH",
  claude_cli_cancelled: "The Claude Code CLI run was cancelled",
  claude_cli_hook_blocked:
    "A Claude Code hook ran during this turn, which GoatCitadel blocks because hooks bypass its approvals",
  claude_cli_managed_hooks_active:
    "This Claude Code install has organization-managed hooks, which GoatCitadel cannot disable. Use another provider",
  claude_cli_bridge_unavailable: "GoatCitadel could not connect its tools to the Claude Code CLI for this step",
  claude_cli_bridge_mismatch:
    "The Claude Code CLI reported tools or activity outside the GoatCitadel tool bridge, so GoatCitadel stopped the step",
};

export function claudeCliUserMessage(reasonCode: ClaudeCliReasonCode): string {
  return USER_FACING_MESSAGES[reasonCode];
}

/** Throws the typed CLI error; `detail` is a fixed diagnostic phrase, never CLI-provided text. */
export function failClaudeCliStep(reasonCode: ClaudeCliReasonCode, detail?: string): never {
  const base = claudeCliUserMessage(reasonCode);
  throw new ClaudeCliError(reasonCode, detail ? `${base}: ${detail}` : base);
}

/** The per-run identity every chunk of one CLI run carries. */
export interface ClaudeCliChunkIdentity {
  id: string;
  created: number;
  model: string;
}

export function buildClaudeCliChunk(
  identity: ClaudeCliChunkIdentity,
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta, ...extra }],
  };
}
