import { describe, expect, it } from "vitest";
import {
  buildStreamJsonUserMessage,
  classifyClaudeCliFailure,
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
    expect(final.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
    expect(final.text).toBe("hello world");
    expect(final.finalChunk).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
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
});
