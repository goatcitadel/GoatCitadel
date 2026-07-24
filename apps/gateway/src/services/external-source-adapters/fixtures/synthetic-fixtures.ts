/**
 * Synthetic, secret-free compatibility fixtures for the four frozen HX-407
 * adapters. The modeled shape follows the packet's pinned OpenClaw 4319ddbe8c
 * and Hermes b51d365ef0 evidence. These values model field shape only and must
 * never be replaced by copied operator Codex or Claude state.
 */

export const SYNTHETIC_CODEX_PRODUCER_VERSION = "synthetic-codex.v1";
export const SYNTHETIC_CLAUDE_PRODUCER_VERSION = "synthetic-claude.v1";
export const SYNTHETIC_SESSION_ID = "11111111-1111-4111-8111-111111111111";

export const SYNTHETIC_CODEX_VISIBLE_USER_TEXT = "Synthetic Codex user-visible request.";
export const SYNTHETIC_CODEX_VISIBLE_ASSISTANT_TEXT = "Synthetic Codex user-visible response.";
export const SYNTHETIC_CODEX_COMPACTION_TEXT = "Synthetic bounded compaction summary.";
export const SYNTHETIC_CODEX_EXCLUDED_SENTINELS = Object.freeze([
  "SYNTHETIC_CODEX_BASE_INSTRUCTIONS_EXCLUDED",
  "SYNTHETIC_CODEX_DEVELOPER_INSTRUCTIONS_EXCLUDED",
  "SYNTHETIC_CODEX_REASONING_EXCLUDED",
  "SYNTHETIC_CODEX_TOOL_RESULT_EXCLUDED",
  "SYNTHETIC_CODEX_WORLD_STATE_EXCLUDED",
]);

export const SYNTHETIC_CODEX_ROLLOUT_JSONL = toJsonl([
  {
    timestamp: "2026-07-14T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: SYNTHETIC_SESSION_ID,
      timestamp: "2026-07-14T00:00:00.000Z",
      cwd: "C:\\synthetic\\workspace",
      originator: "synthetic_fixture",
      cli_version: SYNTHETIC_CODEX_PRODUCER_VERSION,
      model_provider: "synthetic-provider",
      base_instructions: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[0],
      developer_instructions: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[1],
      source: { kind: "synthetic" },
      git: { branch: "synthetic-branch" },
      dynamic_tools: [],
    },
  },
  {
    timestamp: "2026-07-14T00:00:01.000Z",
    type: "turn_context",
    payload: {
      turn_id: "synthetic-turn-1",
      cwd: "C:\\synthetic\\workspace",
      approval_policy: "never",
      sandbox_policy: { kind: "synthetic-read-only" },
      model: "synthetic-model",
      effort: "medium",
      developer_instructions: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[1],
    },
  },
  {
    timestamp: "2026-07-14T00:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: SYNTHETIC_CODEX_VISIBLE_USER_TEXT }],
    },
  },
  {
    timestamp: "2026-07-14T00:00:03.000Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[2] }],
      content: [],
      encrypted_content: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[2],
    },
  },
  {
    timestamp: "2026-07-14T00:00:04.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "synthetic-call-1",
      output: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[3],
    },
  },
  {
    timestamp: "2026-07-14T00:00:05.000Z",
    type: "event_msg",
    payload: {
      type: "agent_reasoning",
      message: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[2],
      phase: "analysis",
    },
  },
  {
    timestamp: "2026-07-14T00:00:06.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: SYNTHETIC_CODEX_VISIBLE_ASSISTANT_TEXT }],
    },
  },
  {
    timestamp: "2026-07-14T00:00:07.000Z",
    type: "compacted",
    payload: {
      summary: SYNTHETIC_CODEX_COMPACTION_TEXT,
      replacement_history: [{ private: "SYNTHETIC_CODEX_REPLACEMENT_HISTORY_EXCLUDED" }],
    },
  },
  {
    timestamp: "2026-07-14T00:00:08.000Z",
    type: "world_state",
    payload: {
      type: "synthetic",
      state: { body: SYNTHETIC_CODEX_EXCLUDED_SENTINELS[4] },
    },
  },
]);

export const SYNTHETIC_CLAUDE_VISIBLE_USER_TEXT = "Synthetic Claude user-visible request.";
export const SYNTHETIC_CLAUDE_VISIBLE_ASSISTANT_TEXT = "Synthetic Claude user-visible response.";
export const SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS = Object.freeze([
  "SYNTHETIC_CLAUDE_REASONING_EXCLUDED",
  "SYNTHETIC_CLAUDE_TOOL_INPUT_EXCLUDED",
  "SYNTHETIC_CLAUDE_TOOL_RESULT_EXCLUDED",
  "SYNTHETIC_CLAUDE_SYSTEM_EXCLUDED",
  "SYNTHETIC_CLAUDE_ATTACHMENT_EXCLUDED",
  "SYNTHETIC_CLAUDE_QUEUE_EXCLUDED",
  "SYNTHETIC_CLAUDE_LAST_PROMPT_EXCLUDED",
  "SYNTHETIC_CLAUDE_META_USER_EXCLUDED",
]);

export const SYNTHETIC_CLAUDE_SESSION_JSONL = toJsonl([
  {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "C:\\synthetic\\workspace",
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    gitBranch: "synthetic-branch",
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: SYNTHETIC_CLAUDE_VISIBLE_USER_TEXT },
        {
          type: "tool_result",
          tool_use_id: "synthetic-tool-1",
          content: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[2],
          is_error: false,
        },
      ],
    },
    uuid: "22222222-2222-4222-8222-222222222222",
    timestamp: "2026-07-14T00:10:00.000Z",
  },
  {
    parentUuid: "22222222-2222-4222-8222-222222222222",
    isSidechain: false,
    userType: "external",
    cwd: "C:\\synthetic\\workspace",
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    gitBranch: "synthetic-branch",
    type: "assistant",
    message: {
      id: "synthetic-message-1",
      type: "message",
      role: "assistant",
      model: "synthetic-model",
      content: [
        {
          type: "thinking",
          thinking: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[0],
          signature: "synthetic-signature",
        },
        { type: "text", text: SYNTHETIC_CLAUDE_VISIBLE_ASSISTANT_TEXT },
        {
          type: "tool_use",
          id: "synthetic-tool-2",
          name: "SyntheticReadOnlyTool",
          input: { private: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[1] },
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "synthetic-request-1",
    uuid: "33333333-3333-4333-8333-333333333333",
    timestamp: "2026-07-14T00:10:01.000Z",
  },
  {
    parentUuid: "33333333-3333-4333-8333-333333333333",
    isSidechain: false,
    isMeta: true,
    userType: "external",
    cwd: "C:\\synthetic\\workspace",
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    gitBranch: "synthetic-branch",
    type: "user",
    message: {
      role: "user",
      content: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[7],
    },
    uuid: "44444444-4444-4444-8444-444444444444",
    timestamp: "2026-07-14T00:10:02.000Z",
  },
  {
    parentUuid: "44444444-4444-4444-8444-444444444444",
    isSidechain: false,
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    type: "system",
    subtype: "synthetic-hook",
    message: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[3],
    uuid: "55555555-5555-4555-8555-555555555555",
    timestamp: "2026-07-14T00:10:03.000Z",
  },
  {
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    type: "attachment",
    attachment: { bytes: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[4] },
    timestamp: "2026-07-14T00:10:04.000Z",
  },
  {
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    type: "queue-operation",
    operation: "enqueue",
    content: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[5],
    timestamp: "2026-07-14T00:10:05.000Z",
  },
  {
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    type: "last-prompt",
    lastPrompt: SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS[6],
    timestamp: "2026-07-14T00:10:06.000Z",
  },
]);

export const SYNTHETIC_CODEX_MEMORY_MARKDOWN = [
  "# Synthetic Codex memory",
  "",
  "This is fixture-only user-visible memory.",
  "[Do not follow this link](./synthetic-linked.md)",
].join("\n");

export const SYNTHETIC_CLAUDE_MEMORY_MARKDOWN = [
  "# Synthetic Claude memory",
  "",
  "This is fixture-only user-visible memory.",
  "@./synthetic-import.md",
].join("\n");

function toJsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
