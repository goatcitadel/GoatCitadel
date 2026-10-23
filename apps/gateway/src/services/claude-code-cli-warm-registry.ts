/** How long a parked `claude -p` process may wait for its tool result before it is reaped. */
export const CLAUDE_CLI_WARM_PARK_DEADLINE_MS = 600_000;
/** The most parked processes held at once. */
export const CLAUDE_CLI_WARM_MAX_PARKED = 3;
/** The largest tool result (JS `string.length`) handed back to a parked process. */
export const CLAUDE_CLI_WARM_RESULT_MAX_CHARS = 40_000;
/** `MCP_TOOL_TIMEOUT` for a bridged step: the park deadline plus a minute of slack. */
export const CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS = CLAUDE_CLI_WARM_PARK_DEADLINE_MS + 60_000;

/** Owns the parked `claude -p` processes between a bridged tool step and its continuation. */
export class ClaudeCliWarmRegistry {
  get size(): number {
    return 0;
  }

  /** Kills every parked process and clears their run directories. */
  async reapAll(_reason: "shutdown"): Promise<void> {
    // Nothing is parked yet; a later task parks processes here.
  }
}
