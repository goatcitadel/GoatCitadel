import type { ChatCompletionMessage } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM,
  buildStreamJsonUserMessage,
  classifyClaudeCliFailure,
  claudeCliUserMessage,
  createClaudeCliStreamMapper,
  renderClaudeCliPrompt,
} from "./claude-code-cli-stream.js";

const line = (value: unknown) => JSON.stringify(value);
const textDelta = (text: string) =>
  line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const successResult = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hello world",
  total_cost_usd: 0.42,
  usage: { input_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 2 },
});

describe("createClaudeCliStreamMapper", () => {
  it("maps text deltas and the success result to OpenAI-shaped chunks with summed usage", () => {
    const mapper = createClaudeCliStreamMapper("claude-sonnet-5-5");
    const chunks = [
      ...mapper.push(line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" })),
      ...mapper.push(textDelta("hello ")),
      ...mapper.push(textDelta("world")),
      ...mapper.push(successResult),
    ];
    const final = mapper.finish({ exitCode: 0, stderrTail: "" });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      object: "chat.completion.chunk",
      model: "claude-sonnet-5-5",
      choices: [{ index: 0, delta: { content: "hello " } }],
    });
    expect(chunks[1]).toMatchObject({ choices: [{ delta: { content: "world" } }] });
    // Same shape as the Anthropic Messages adapter: uncached input, cache fields passed through.
    expect(final.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    expect(final.text).toBe("hello world");
    expect(final.finalChunk).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, cache_read_input_tokens: 2 },
    });
    // The CLI's notional API price is not a subscription charge.
    expect(JSON.stringify(final.finalChunk)).not.toContain("0.42");
  });

  it("maps thinking deltas to reasoning_content", () => {
    const mapper = createClaudeCliStreamMapper("claude-opus-5-5");
    const chunks = mapper.push(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      }),
    );
    expect(chunks).toEqual([expect.objectContaining({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] })]);
  });

  it("uses full assistant text only when no partial deltas arrived", () => {
    const assistant = line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "whole reply" }] },
    });
    const withoutDeltas = createClaudeCliStreamMapper("sonnet");
    expect(withoutDeltas.push(assistant)).toEqual([
      expect.objectContaining({ choices: [{ index: 0, delta: { content: "whole reply" } }] }),
    ]);

    const withDeltas = createClaudeCliStreamMapper("sonnet");
    withDeltas.push(textDelta("whole reply"));
    expect(withDeltas.push(assistant)).toEqual([]);
  });

  it("blocks any CLI tool use as a governance fault", () => {
    const start = createClaudeCliStreamMapper("sonnet");
    expect(() =>
      start.push(
        line({
          type: "stream_event",
          event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash" } },
        }),
      ),
    ).toThrow(expect.objectContaining({ reasonCode: "claude_cli_tool_use_blocked" }));

    const full = createClaudeCliStreamMapper("sonnet");
    expect(() =>
      full.push(
        line({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        }),
      ),
    ).toThrow(expect.objectContaining({ reasonCode: "claude_cli_tool_use_blocked" }));
  });

  it("leaves usage unknown when the CLI reports none", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    mapper.push(line({ type: "result", subtype: "success", is_error: false, result: "ok" }));
    const final = mapper.finish({ exitCode: 0, stderrTail: "" });
    expect(final.usage).toBeUndefined();
    expect(final.finalChunk).not.toHaveProperty("usage");
  });

  it("never streams the CLI's synthetic auth-failure message as reply text (captured from Claude Code 2.1.212)", () => {
    const mapper = createClaudeCliStreamMapper("claude-sonnet-5-5");
    const synthetic = line({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }],
      },
    });
    const result = line({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    });
    expect(mapper.push(synthetic)).toEqual([]);
    expect(mapper.push(result)).toEqual([]);
    expect(() => mapper.finish({ exitCode: 1, stderrTail: "" })).toThrow(
      expect.objectContaining({ reasonCode: "claude_cli_logged_out" }),
    );
  });

  it("fails the turn closed when any hook event appears", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    expect(() =>
      mapper.push(line({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" })),
    ).toThrow(expect.objectContaining({ reasonCode: "claude_cli_hook_blocked" }));
    expect(mapper.push(line({ type: "system", subtype: "init", tools: [] }))).toEqual([]);
  });

  it("maps error results to typed reason codes", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    mapper.push(
      line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }),
    );
    expect(() => mapper.finish({ exitCode: 1, stderrTail: "" })).toThrow(
      expect.objectContaining({ reasonCode: "claude_cli_logged_out" }),
    );
  });

  it("fails a run that exits cleanly without a result line", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    mapper.push(textDelta("partial"));
    expect(() => mapper.finish({ exitCode: 0, stderrTail: "" })).toThrow(
      expect.objectContaining({ reasonCode: "claude_cli_failed" }),
    );
  });

  it("classifies a non-zero exit from its stderr tail", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    expect(() => mapper.finish({ exitCode: 1, stderrTail: "error: unknown option '--safe-mode'" })).toThrow(
      expect.objectContaining({ reasonCode: "claude_cli_incompatible" }),
    );
  });

  it("ignores non-JSON and unrelated lines", () => {
    const mapper = createClaudeCliStreamMapper("sonnet");
    expect(mapper.push("not json at all")).toEqual([]);
    expect(mapper.push(line({ type: "rate_limit_event" }))).toEqual([]);
    expect(mapper.push(line([1, 2, 3]))).toEqual([]);
  });
});

describe("classifyClaudeCliFailure", () => {
  it.each([
    ["Invalid API key · Please run /login", "claude_cli_logged_out"],
    ['{"type":"error","error":{"type":"authentication_error"}}', "claude_cli_logged_out"],
    ["Not logged in", "claude_cli_logged_out"],
    ["Failed to authenticate: OAuth session expired and could not be refreshed", "claude_cli_logged_out"],
    ["Claude AI usage limit reached|1760000000", "claude_cli_usage_limited"],
    ["rate_limit_error: too many requests", "claude_cli_usage_limited"],
    ["error: unknown option '--tools'", "claude_cli_incompatible"],
    ["model: claude-nope not found", "claude_cli_model_unavailable"],
    ["something else broke", "claude_cli_failed"],
  ])("maps %s to %s", (text, reasonCode) => {
    expect(classifyClaudeCliFailure(text)).toBe(reasonCode);
  });
});

describe("renderClaudeCliPrompt", () => {
  it("routes system and developer text to the system prompt and labels the transcript", () => {
    const rendered = renderClaudeCliPrompt([
      { role: "system", content: "You are GoatCitadel." },
      { role: "developer", content: [{ type: "text", text: "Be terse." }] },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "42", tool_call_id: "call_1" },
      {
        role: "user",
        content: [
          { type: "text", text: "and now?" },
          { type: "image_url", image_url: {} },
        ],
      },
    ]);
    expect(rendered.system).toBe("You are GoatCitadel.\n\nBe terse.");
    expect(rendered.userText).toContain("[User]\nhi");
    expect(rendered.userText).toContain("[Assistant]\nhello");
    expect(rendered.userText).toContain("[Tool result call_1]\n42");
    expect(rendered.userText).toContain("[image omitted]");
    expect(rendered.userText.trimEnd().endsWith("and now?\n[image omitted]")).toBe(true);
  });

  it("sends a lone user message without transcript labels", () => {
    expect(renderClaudeCliPrompt([{ role: "user", content: "just this" }]).userText).toBe("just this");
  });

  it("a single plain user turn still renders as before", () => {
    const rendered = renderClaudeCliPrompt([{ role: "user", content: "just this" }]);
    expect(rendered.userBlocks).toEqual(["just this"]);
    expect(rendered.userText).toBe("just this");
    expect(rendered.system).toBe("");
  });

  const toolCallMessage = (id: string, name: string, args: string, content: string | null = "") =>
    ({
      role: "assistant",
      content,
      tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
    }) as unknown as ChatCompletionMessage;

  it("assistant tool calls render with id, model name and arguments", () => {
    const rendered = renderClaudeCliPrompt([
      { role: "user", content: "make a doc" },
      toolCallMessage("call_1", "documents_create", '{"title":"T"}'),
      { role: "tool", content: "created", tool_call_id: "call_1" },
    ]);
    expect(rendered.userBlocks).toContain('[Assistant tool call call_1: documents_create] {"title":"T"}');
    expect(rendered.userBlocks.some((block) => block.startsWith("[Assistant]"))).toBe(false);
    expect(rendered.userBlocks).toContain("[Tool result call_1]\ncreated");
  });

  it("renders assistant text first, one block per tool call, and defaults empty arguments to {}", () => {
    const message = {
      role: "assistant",
      content: "Looking that up.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "alpha", arguments: "" } },
        { id: "call_b", type: "function", function: { name: "beta", arguments: '{"x":1}' } },
      ],
    } as unknown as ChatCompletionMessage;
    const rendered = renderClaudeCliPrompt([{ role: "user", content: "go" }, message]);
    expect(rendered.userBlocks.slice(-3)).toEqual([
      "[Assistant]\nLooking that up.",
      "[Assistant tool call call_a: alpha] {}",
      '[Assistant tool call call_b: beta] {"x":1}',
    ]);
  });

  it("resume continuation ids render like any id", () => {
    const rendered = renderClaudeCliPrompt([
      { role: "user", content: "go" },
      toolCallMessage("toolu_01ABC-resume.7", "files_read", '{"path":"a"}', null),
      { role: "tool", content: "ok", tool_call_id: "toolu_01ABC-resume.7" },
    ]);
    expect(rendered.userBlocks).toContain('[Assistant tool call toolu_01ABC-resume.7: files_read] {"path":"a"}');
    expect(rendered.userBlocks).toContain("[Tool result toolu_01ABC-resume.7]\nok");
  });

  it("bridged prompts append the addendum to the system text; unbridged prompts do not", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ];
    expect(renderClaudeCliPrompt(messages).system).toBe("Be brief.");
    expect(renderClaudeCliPrompt(messages, { bridged: false }).system).toBe("Be brief.");
    expect(renderClaudeCliPrompt(messages, { bridged: true }).system).toBe(
      `Be brief.\n\n${CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM}`,
    );
    expect(renderClaudeCliPrompt([{ role: "user", content: "hi" }], { bridged: true }).system).toBe(
      CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM,
    );
    expect(CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM).not.toMatch(/You are Claude Code/i);
  });

  it("userText equals userBlocks joined, so the two forms never diverge", () => {
    const rendered = renderClaudeCliPrompt([
      { role: "user", content: "make a doc" },
      toolCallMessage("call_1", "documents_create", '{"title":"T"}', "ok"),
      { role: "tool", content: "created", tool_call_id: "call_1" },
      { role: "user", content: "thanks" },
    ]);
    expect(rendered.userText).toBe(rendered.userBlocks.join("\n\n"));
    expect(rendered.userBlocks[0]).toBe(
      "The conversation so far is below. Reply as the assistant to the final user turn.",
    );
  });
});

describe("buildStreamJsonUserMessage", () => {
  it("emits one stream-json user line", () => {
    const payload = buildStreamJsonUserMessage("héllo 🐐");
    expect(payload.endsWith("\n")).toBe(true);
    expect(JSON.parse(payload)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "héllo 🐐" }] },
    });
  });

  it("each prior message becomes its own content block in order", () => {
    const { userBlocks } = renderClaudeCliPrompt([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    const payload = buildStreamJsonUserMessage(userBlocks);
    const parsed = JSON.parse(payload) as { message: { content: Array<{ type: string; text: string }> } };
    expect(parsed.message.content.length).toBe(userBlocks.length);
    expect(parsed.message.content.map((block) => block.text)).toEqual(userBlocks);
    expect(parsed.message.content.every((block) => block.type === "text")).toBe(true);
  });

  it("a string is one text block, identical to a one-element block array", () => {
    expect(buildStreamJsonUserMessage("abc")).toBe(buildStreamJsonUserMessage(["abc"]));
  });

  it("a transcript over 2 MiB stays one stdin line with blocks intact", () => {
    const big = `line one\nline two\n${"x".repeat(1024 * 1024)}`;
    const { userBlocks } = renderClaudeCliPrompt([
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "next" },
    ]);
    const payload = buildStreamJsonUserMessage(userBlocks);
    expect(payload.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(payload.indexOf("\n")).toBe(payload.length - 1);
    const parsed = JSON.parse(payload) as { message: { content: Array<{ text: string }> } };
    expect(parsed.message.content.map((block) => block.text)).toEqual(userBlocks);
  });
});

describe("claudeCliUserMessage", () => {
  it("explains a forced tool call without sending agentic or Code Mode turns to another provider", () => {
    const message = claudeCliUserMessage("claude_cli_tools_unsupported");
    expect(message).toMatch(/forces a specific tool call/);
    expect(message).not.toMatch(/agentic|Code Mode/i);
  });
});
