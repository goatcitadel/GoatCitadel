import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { createAssistantToolCallMessage } from "./chat-turn-agent-runner/provider-message-helpers.js";
import { INTERNAL_TOOL_EFFECT_POTENTIAL_KEY } from "./chat-message-sanitize.js";
import { buildClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import {
  fingerprintClaudeCliStep,
  matchClaudeCliWarmContinuation,
  type ClaudeCliEmittedAssistant,
  type ClaudeCliWarmFingerprint,
} from "./claude-code-cli-warm-match.js";
import { CLAUDE_CLI_WARM_RESULT_MAX_CHARS } from "./claude-code-cli-warm-registry.js";

const MODEL = "claude-haiku-5-5";
const ID_A = "toolu_01A";
const ID_B = "toolu_01B";
const ATTRIBUTION: ModelUsageAttributionContext = { sessionId: "s1", turnId: "t1", durableRunId: "d1" };
const MANIFEST = buildClaudeCliToolManifest([
  { type: "function", function: { name: "notes_echo", description: "Echo", parameters: {} } },
]);
const BASE_MESSAGES: ChatCompletionMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Echo twice." },
];
const EMITTED: ClaudeCliEmittedAssistant = {
  text: "Calling tools.",
  calls: [
    { id: ID_A, name: "notes_echo", arguments: '{"text":"a"}' },
    { id: ID_B, name: "notes_echo", arguments: '{"text":"b"}' },
  ],
};

const requestOf = (messages: ChatCompletionMessage[]): ChatCompletionRequest =>
  ({ model: MODEL, messages, tool_choice: "auto", parallel_tool_calls: true }) as ChatCompletionRequest;

const fingerprintOf = (
  messages: ChatCompletionMessage[],
  overrides: { attribution?: ModelUsageAttributionContext; system?: string } = {},
) =>
  fingerprintClaudeCliStep({
    request: requestOf(messages),
    attribution: overrides.attribution ?? ATTRIBUTION,
    model: MODEL,
    system: overrides.system ?? "You are helpful.",
    manifest: MANIFEST,
  });

const runnerToolCall = (call: { id: string; name: string; arguments: string }) => ({
  id: call.id,
  type: "function",
  [INTERNAL_TOOL_EFFECT_POTENTIAL_KEY]: "none",
  function: { name: call.name, arguments: call.arguments },
});

// The runner's real rebuild: ids kept, effect-potential key added, provider-native content carried.
const rebuiltAssistant = (calls: ReadonlyArray<{ id: string; name: string; arguments: string }> = EMITTED.calls) =>
  createAssistantToolCallMessage({
    content: EMITTED.text,
    providerNativeContent: [{ type: "thinking", thinking: "hmm" }],
    toolCalls: calls.map(runnerToolCall),
  });
const toolMessage = (id: string, content: ChatCompletionMessage["content"]): ChatCompletionMessage =>
  ({ role: "tool", tool_call_id: id, content }) as ChatCompletionMessage;

const parked = (): {
  fingerprint: ClaudeCliWarmFingerprint;
  emitted: ClaudeCliEmittedAssistant;
  pendingIds: string[];
} => ({
  fingerprint: fingerprintOf(BASE_MESSAGES)!,
  emitted: EMITTED,
  pendingIds: [ID_A, ID_B],
});

const attempt = (
  messages: ChatCompletionMessage[],
  overrides: { attribution?: ModelUsageAttributionContext; system?: string } = {},
) =>
  matchClaudeCliWarmContinuation({
    parked: parked(),
    next: fingerprintOf(messages, overrides)!,
    request: requestOf(messages),
  });

const continuation = (...tail: ChatCompletionMessage[]) => [...BASE_MESSAGES, rebuiltAssistant(), ...tail];

describe("claude cli warm match", () => {
  it("hits on the exact continuation and returns results in pending-id order", () => {
    const result = attempt(continuation(toolMessage(ID_A, "result a"), toolMessage(ID_B, "result b")));
    expect(result).toEqual({
      hit: true,
      results: [
        { toolUseId: ID_A, text: "result a" },
        { toolUseId: ID_B, text: "result b" },
      ],
    });
  });

  it("hits when the tool messages arrive in a different order", () => {
    const result = attempt(continuation(toolMessage(ID_B, "result b"), toolMessage(ID_A, "result a")));
    expect(result).toEqual({
      hit: true,
      results: [
        { toolUseId: ID_A, text: "result a" },
        { toolUseId: ID_B, text: "result b" },
      ],
    });
  });

  it("misses on a steering user message", () => {
    const steered = continuation(toolMessage(ID_A, "a"), toolMessage(ID_B, "b"), { role: "user", content: "also..." });
    expect(attempt(steered)).toEqual({ hit: false, reason: "warm_miss_messages" });
  });

  it("misses when the earlier messages changed", () => {
    const edited = [BASE_MESSAGES[0]!, { role: "user", content: "Echo thrice." } as ChatCompletionMessage];
    const messages = [...edited, rebuiltAssistant(), toolMessage(ID_A, "a"), toolMessage(ID_B, "b")];
    expect(attempt(messages)).toEqual({ hit: false, reason: "warm_miss_messages" });
  });

  it("misses when the system text changed", () => {
    const result = attempt(continuation(toolMessage(ID_A, "a"), toolMessage(ID_B, "b")), { system: "Different." });
    expect(result).toEqual({ hit: false, reason: "warm_miss_fingerprint" });
  });

  it("misses when the runner appended a repair-feedback call with empty arguments", () => {
    const repaired = createAssistantToolCallMessage({
      content: EMITTED.text,
      toolCalls: [
        ...EMITTED.calls.map(runnerToolCall),
        { id: "toolu_01C", type: "function", function: { name: "notes_ecoh", arguments: "{}" } },
      ],
    });
    const messages = [
      ...BASE_MESSAGES,
      repaired,
      toolMessage(ID_A, "a"),
      toolMessage(ID_B, "b"),
      toolMessage("toolu_01C", "unknown tool"),
    ];
    expect(attempt(messages)).toEqual({ hit: false, reason: "warm_miss_assistant" });
  });

  it("misses when a call's arguments differ from what the CLI emitted", () => {
    const messages = [
      ...BASE_MESSAGES,
      rebuiltAssistant([
        { id: ID_A, name: "notes_echo", arguments: "{}" },
        { id: ID_B, name: "notes_echo", arguments: '{"text":"b"}' },
      ]),
      toolMessage(ID_A, "a"),
      toolMessage(ID_B, "b"),
    ];
    expect(attempt(messages)).toEqual({ hit: false, reason: "warm_miss_assistant" });
  });

  it("misses when a tool message is missing", () => {
    expect(attempt(continuation(toolMessage(ID_A, "a")))).toEqual({ hit: false, reason: "warm_miss_ids" });
  });

  it("misses on an extra tool message", () => {
    const extra = continuation(toolMessage(ID_A, "a"), toolMessage(ID_B, "b"), toolMessage("toolu_01Z", "z"));
    expect(attempt(extra)).toEqual({ hit: false, reason: "warm_miss_ids" });
  });

  it("misses on a duplicated tool message", () => {
    const duplicated = continuation(toolMessage(ID_A, "a"), toolMessage(ID_A, "a"));
    expect(attempt(duplicated)).toEqual({ hit: false, reason: "warm_miss_ids" });
  });

  it("misses when a pending id fails the tool-use id pattern", () => {
    const badId = "bad id/../x";
    const emitted = { ...EMITTED, calls: [{ id: badId, name: "notes_echo", arguments: "{}" }] };
    const messages = [...BASE_MESSAGES, rebuiltAssistant(emitted.calls), toolMessage(badId, "a")];
    const result = matchClaudeCliWarmContinuation({
      parked: { ...parked(), emitted, pendingIds: [badId] },
      next: fingerprintOf(messages)!,
      request: requestOf(messages),
    });
    expect(result).toEqual({ hit: false, reason: "warm_miss_ids" });
  });

  it("hits at exactly the result size limit and misses one character over", () => {
    const at = "x".repeat(CLAUDE_CLI_WARM_RESULT_MAX_CHARS);
    expect(attempt(continuation(toolMessage(ID_A, at), toolMessage(ID_B, "b"))).hit).toBe(true);
    const over = "x".repeat(CLAUDE_CLI_WARM_RESULT_MAX_CHARS + 1);
    expect(attempt(continuation(toolMessage(ID_A, over), toolMessage(ID_B, "b")))).toEqual({
      hit: false,
      reason: "warm_miss_result_size",
    });
  });

  it("misses on an array-content tool result", () => {
    const arrayContent = [{ type: "text", text: "a" }] as unknown as ChatCompletionMessage["content"];
    expect(attempt(continuation(toolMessage(ID_A, arrayContent), toolMessage(ID_B, "b")))).toEqual({
      hit: false,
      reason: "warm_miss_result_type",
    });
  });

  it("misses when the session differs", () => {
    const result = attempt(continuation(toolMessage(ID_A, "a"), toolMessage(ID_B, "b")), {
      attribution: { ...ATTRIBUTION, sessionId: "other" },
    });
    expect(result).toEqual({ hit: false, reason: "warm_miss_attribution" });
  });

  it("returns no fingerprint without a turn id or session id", () => {
    expect(fingerprintOf(BASE_MESSAGES, { attribution: { sessionId: "s1" } })).toBeUndefined();
    expect(fingerprintOf(BASE_MESSAGES, { attribution: { turnId: "t1" } })).toBeUndefined();
  });

  it("fingerprints the step inputs", () => {
    const fingerprint = fingerprintOf(BASE_MESSAGES)!;
    expect(fingerprint).toMatchObject({
      sessionId: "s1",
      turnId: "t1",
      durableRunId: "d1",
      model: MODEL,
      manifestSha: MANIFEST.sha256,
      parallelToolCalls: true,
      messageCount: 2,
      toolChoiceSha: createHash("sha256").update(JSON.stringify("auto")).digest("hex"),
    });
    expect(fingerprint.messagesSha).toMatch(/^[0-9a-f]{64}$/);
  });
});
