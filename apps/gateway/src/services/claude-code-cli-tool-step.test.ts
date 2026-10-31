import { describe, expect, it } from "vitest";
import { createClaudeCliStreamMapper } from "./claude-code-cli-stream.js";
import { buildClaudeCliToolManifest, type ClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";

// Synthetic lines modelled on live Claude Code 2.1.305 stream-json transcripts of a bridged step.
const MODEL = "claude-haiku-5-5";
const ECHO = "mcp__goatcitadel__notes_echo";
const CREATE = "mcp__goatcitadel__documents_create";
const CONNECTED = { name: "goatcitadel", status: "connected", source: "dynamic" };

const line = (value: unknown) => JSON.stringify(value);
const streamEvent = (event: Record<string, unknown>) => line({ type: "stream_event", event });

const manifest = (): ClaudeCliToolManifest =>
  buildClaudeCliToolManifest([
    { type: "function", function: { name: "documents_create", description: "Create a document", parameters: {} } },
    { type: "function", function: { name: "notes_echo", description: "Echo", parameters: {} } },
  ]);

const init = (overrides: { tools?: unknown; mcp_servers?: unknown } = {}) =>
  line({
    type: "system",
    subtype: "init",
    tools: [CREATE, ECHO],
    mcp_servers: [CONNECTED],
    model: MODEL,
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    ...overrides,
  });
const status = line({ type: "system", subtype: "status", status: "requesting" });
const messageStart = streamEvent({
  type: "message_start",
  message: { model: MODEL, id: "msg_01", type: "message", role: "assistant", content: [], stop_reason: null },
});
const toolStart = (index: number, id: string, name: string, type = "tool_use") =>
  streamEvent({ type: "content_block_start", index, content_block: { type, id, name, input: {} } });
const jsonDelta = (index: number, partial: string) =>
  streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });
const textStart = (index: number) =>
  streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) =>
  streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => streamEvent({ type: "content_block_stop", index });
const assistant = (content: unknown[]) =>
  line({ type: "assistant", message: { model: MODEL, id: "msg_01", type: "message", role: "assistant", content } });
const assistantTool = (id: string, name: string, input: unknown, type = "tool_use") =>
  assistant([{ type, id, name, input, caller: { type: "direct" } }]);
const STEP_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 1591,
  cache_read_input_tokens: 0,
  output_tokens: 117,
};
const messageDelta = (stopReason: string, usage: Record<string, unknown> = STEP_USAGE) =>
  streamEvent({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
const messageStop = streamEvent({ type: "message_stop" });
const rateLimit = line({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
const toolProgress = line({
  type: "tool_progress",
  tool_use_id: "toolu_echo-heartbeat-0",
  tool_name: ECHO,
  elapsed_time_seconds: 30,
  heartbeat: true,
});

function toolCallLines(index: number, id: string, name: string, input: unknown): string[] {
  return [toolStart(index, id, name), jsonDelta(index, ""), jsonDelta(index, "{}"), assistantTool(id, name, input)];
}

function pushAll(mapper: ReturnType<typeof createClaudeCliStreamMapper>, lines: string[]) {
  return lines.flatMap((entry) => mapper.push(entry));
}

function bridged(bridge: ClaudeCliToolManifest = manifest()) {
  return createClaudeCliStreamMapper(MODEL, { bridge });
}

function toolCallsOf(chunks: Record<string, unknown>[]): unknown[] {
  return chunks.flatMap((entry) => {
    const choices = entry.choices as Array<{ delta?: { tool_calls?: unknown[] } }>;
    return choices[0]?.delta?.tool_calls ?? [];
  });
}

const expectReason = (fn: () => unknown, reasonCode: string) =>
  expect(fn).toThrow(expect.objectContaining({ reasonCode }));

describe("bridged Claude Code CLI step mapping", () => {
  it("a single tool call becomes tool_calls with the model name and the toolu id", () => {
    const mapper = bridged();
    const streamed = pushAll(mapper, [
      init(),
      status,
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" }),
      blockStop(0),
      messageDelta("tool_use"),
    ]);
    expect(streamed).toEqual([]);
    expect(mapper.toolStep()).toBeUndefined();

    expect(mapper.push(messageStop)).toEqual([]);
    const step = mapper.toolStep();
    expect(step).toBeDefined();
    expect(step?.chunks).toHaveLength(2);
    expect(step?.chunks[0]).toMatchObject({
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "toolu_01Echo",
                type: "function",
                function: { name: "notes_echo", arguments: '{"text":"hi"}' },
              },
            ],
          },
        },
      ],
    });
    expect(step?.chunks[1]).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

    // The adapter is about to kill the tree: trailing CLI lines are ignored and the step is stable.
    expect(mapper.push(rateLimit)).toEqual([]);
    expect(mapper.push(toolProgress)).toEqual([]);
    expect(mapper.push(messageStart)).toEqual([]);
    expect(mapper.toolStep()).toBe(step);
  });

  it("an aliased long tool name maps back to the runner's model name", () => {
    const longName = `ops_${"x".repeat(60)}`;
    const bridge = buildClaudeCliToolManifest([{ type: "function", function: { name: longName } }]);
    const [cliName] = [...bridge.cliNameToModelName.keys()];
    expect(cliName).not.toContain(longName);
    const mapper = bridged(bridge);
    pushAll(mapper, [
      init({ tools: [cliName] }),
      messageStart,
      ...toolCallLines(0, "toolu_long", cliName as string, {}),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({ function: { name: longName, arguments: "{}" } }),
    ]);
  });

  it("parallel tool calls keep their order and indexes", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" }),
      blockStop(0),
      ...toolCallLines(1, "toolu_02Create", CREATE, { title: "T" }),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop,
    ]);
    const step = mapper.toolStep();
    expect(step?.chunks).toHaveLength(2);
    expect(toolCallsOf(step?.chunks ?? [])).toEqual([
      { index: 0, id: "toolu_01Echo", type: "function", function: { name: "notes_echo", arguments: '{"text":"hi"}' } },
      {
        index: 1,
        id: "toolu_02Create",
        type: "function",
        function: { name: "documents_create", arguments: '{"title":"T"}' },
      },
    ]);
  });

  it("text before a tool call streams as content first", () => {
    const mapper = bridged();
    const streamed = pushAll(mapper, [
      init(),
      messageStart,
      textStart(0),
      textDelta(0, "Let me "),
      textDelta(0, "save that."),
      assistant([{ type: "text", text: "Let me save that." }]),
      blockStop(0),
      ...toolCallLines(1, "toolu_02Create", CREATE, { title: "T" }),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(streamed).toEqual([
      expect.objectContaining({ choices: [{ index: 0, delta: { content: "Let me " } }] }),
      expect.objectContaining({ choices: [{ index: 0, delta: { content: "save that." } }] }),
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({
        id: "toolu_02Create",
        function: expect.objectContaining({ name: "documents_create" }),
      }),
    ]);
  });

  it("non-ASCII input round-trips through arguments", () => {
    const mapper = bridged();
    const input = { title: "報告 📄" };
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Create", CREATE, input),
      messageDelta("tool_use"),
      messageStop,
    ]);
    const [call] = toolCallsOf(mapper.toolStep()?.chunks ?? []) as Array<{ function: { arguments: string } }>;
    expect(call?.function.arguments).toContain("報告 📄");
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual(input);
  });

  it('an empty input becomes arguments "{}"', () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, {}),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({ function: { name: "notes_echo", arguments: "{}" } }),
    ]);
  });

  it("usage comes from message_delta", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" }),
      messageDelta("tool_use", STEP_USAGE),
      messageStop,
    ]);
    const expected = {
      prompt_tokens: 1593,
      completion_tokens: 117,
      total_tokens: 1710,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1591,
    };
    const step = mapper.toolStep();
    expect(step?.usage).toEqual(expected);
    expect(step?.chunks[1]).toMatchObject({ usage: expected });
  });

  it("end_turn with the bridge attached completes through result as today", () => {
    const mapper = bridged();
    const streamed = pushAll(mapper, [
      init(),
      status,
      messageStart,
      textStart(0),
      textDelta(0, "No tools needed."),
      assistant([{ type: "text", text: "No tools needed." }]),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
      rateLimit,
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "No tools needed.",
        usage: { input_tokens: 4, output_tokens: 3 },
      }),
    ]);
    expect(streamed).toEqual([
      expect.objectContaining({ choices: [{ index: 0, delta: { content: "No tools needed." } }] }),
    ]);
    expect(mapper.toolStep()).toBeUndefined();
    const outcome = mapper.finish({ exitCode: 0, stderrTail: "" });
    expect(outcome.text).toBe("No tools needed.");
    expect(outcome.finalChunk).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });

  it("max_tokens mid-call yields finish_reason length and no tool_calls", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      textStart(0),
      textDelta(0, "Writing the document now."),
      blockStop(0),
      toolStart(1, "toolu_02Create", CREATE),
      jsonDelta(1, '{"title": "a very long'),
      messageDelta("max_tokens"),
      messageStop,
    ]);
    const step = mapper.toolStep();
    expect(step?.chunks).toHaveLength(1);
    expect(step?.chunks[0]).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
    expect(toolCallsOf(step?.chunks ?? [])).toEqual([]);
  });

  it("still fails closed on hook events after the step is complete", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, {}),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(mapper.toolStep()).toBeDefined();
    expectReason(
      () => mapper.push(line({ type: "system", subtype: "hook_started", hook_name: "PreToolUse" })),
      "claude_cli_hook_blocked",
    );
  });
});

describe("init tripwire", () => {
  it.each([
    ["server status failed", { mcp_servers: [{ ...CONNECTED, status: "failed" }] }, "claude_cli_bridge_unavailable"],
    ["no MCP servers (the --safe-mode shape)", { mcp_servers: [], tools: [] }, "claude_cli_bridge_unavailable"],
    ["an extra tool Bash", { tools: [CREATE, ECHO, "Bash"] }, "claude_cli_bridge_mismatch"],
    [
      "an extra server",
      { mcp_servers: [CONNECTED, { name: "other", status: "connected" }] },
      "claude_cli_bridge_mismatch",
    ],
    ["a missing manifest tool", { tools: [ECHO] }, "claude_cli_bridge_mismatch"],
    ["a duplicated tool name", { tools: [CREATE, ECHO, ECHO] }, "claude_cli_bridge_mismatch"],
  ])("%s throws", (_label, overrides, reasonCode) => {
    expectReason(() => bridged().push(init(overrides)), reasonCode);
  });

  it("accepts the exact manifest set in any order", () => {
    expect(bridged().push(init({ tools: [ECHO, CREATE] }))).toEqual([]);
  });

  it.each([
    ["message_start", [messageStart]],
    ["a tool_use block", [toolStart(0, "toolu_01Echo", ECHO)]],
    ["message_delta", [messageDelta("end_turn")]],
    ["result", [line({ type: "result", subtype: "success", is_error: false, result: "x" })]],
  ])("%s before system/init throws claude_cli_bridge_mismatch", (_label, lines) => {
    const mapper = bridged();
    expectReason(() => pushAll(mapper, lines), "claude_cli_bridge_mismatch");
  });

  it("a second system/init throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    mapper.push(init());
    expectReason(() => mapper.push(init()), "claude_cli_bridge_mismatch");
  });
});

describe("tool names the step does not offer", () => {
  const GONE = "mcp__goatcitadel__code_mode_request";
  /** The CLI's own answer to a tool it does not have, as Claude Code prints it. */
  const selfAnswer = (id: string, name: string, isError = true) =>
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`,
            is_error: isError,
          },
        ],
      },
      parent_tool_use_id: null,
    });

  it("an unknown tool name becomes a tool call under its bare name for the runner to answer", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Shell", "mcp__goatcitadel__shell_exec", { command: "ls" }),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      {
        index: 0,
        id: "toolu_01Shell",
        type: "function",
        function: { name: "shell_exec", arguments: '{"command":"ls"}' },
      },
    ]);
    expect(mapper.everyCallOffered()).toBe(false);

    // A name without the bridge prefix passes through as written.
    const bare = bridged();
    pushAll(bare, [init(), messageStart, ...toolCallLines(0, "toolu_01Bash", "Bash", {}), messageDelta("tool_use")]);
    bare.push(messageStop);
    expect(toolCallsOf(bare.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({ function: { name: "Bash", arguments: "{}" } }),
    ]);
  });

  it("a tool offered before a Gateway restart but not by this step is answered by the runner, not failed", () => {
    // The history shows an earlier code_mode_request call; this step's manifest no longer offers it.
    const mapper = bridged();
    expect(manifest().cliNameToModelName.has(GONE)).toBe(false);
    const streamed = pushAll(mapper, [
      init(),
      messageStart,
      textStart(0),
      textDelta(0, "Running it again."),
      assistant([{ type: "text", text: "Running it again." }]),
      blockStop(0),
      ...toolCallLines(1, "toolu_02Gone", GONE, { task: "rerun" }),
      // The CLI has no such tool, so it answers the call itself, before message_stop.
      selfAnswer("toolu_02Gone", GONE),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(streamed).toEqual([
      expect.objectContaining({ choices: [{ index: 0, delta: { content: "Running it again." } }] }),
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({
        id: "toolu_02Gone",
        function: { name: "code_mode_request", arguments: '{"task":"rerun"}' },
      }),
    ]);
    expect(mapper.emittedAssistant()).toEqual({
      text: "Running it again.",
      calls: [{ id: "toolu_02Gone", name: "code_mode_request", arguments: '{"task":"rerun"}' }],
    });
    expect(mapper.everyCallOffered()).toBe(false);
    // The CLI then moves on to its next model call; the adapter is killing the tree, so it is ignored.
    expect(mapper.push(messageStart)).toEqual([]);
  });

  it("an offered call beside an unknown one keeps both, in order, and the step is not offered-only", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" }),
      blockStop(0),
      ...toolCallLines(1, "toolu_02Gone", GONE, {}),
      selfAnswer("toolu_02Gone", GONE),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop,
    ]);
    expect(toolCallsOf(mapper.toolStep()?.chunks ?? [])).toEqual([
      expect.objectContaining({
        index: 0,
        id: "toolu_01Echo",
        function: expect.objectContaining({ name: "notes_echo" }),
      }),
      expect.objectContaining({
        index: 1,
        id: "toolu_02Gone",
        function: expect.objectContaining({ name: "code_mode_request" }),
      }),
    ]);
    expect(mapper.everyCallOffered()).toBe(false);
  });

  it("a step of offered calls only is offered-only", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_01Echo", ECHO, {}), messageDelta("tool_use")]);
    mapper.push(messageStop);
    expect(mapper.everyCallOffered()).toBe(true);
  });

  it.each([
    ["a non-error answer", [selfAnswer("toolu_02Gone", GONE, false)]],
    ["a second answer", [selfAnswer("toolu_02Gone", GONE), selfAnswer("toolu_02Gone", GONE)]],
  ])("%s to an unknown call throws claude_cli_bridge_mismatch", (_label, answers) => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_02Gone", GONE, {})]);
    expectReason(() => pushAll(mapper, answers), "claude_cli_bridge_mismatch");
  });

  it("the CLI answering an offered call itself still throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      ...toolCallLines(0, "toolu_01Echo", ECHO, {}),
      ...toolCallLines(1, "toolu_02Gone", GONE, {}),
      selfAnswer("toolu_02Gone", GONE),
    ]);
    expectReason(() => mapper.push(selfAnswer("toolu_01Echo", ECHO)), "claude_cli_bridge_mismatch");
  });

  it("a call whose name changes between its start and its assistant line throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, toolStart(0, "toolu_01", ECHO)]);
    expectReason(() => mapper.push(assistantTool("toolu_01", "Bash", {})), "claude_cli_bridge_mismatch");

    // The same model-facing name, offered at the start but outside the manifest on the assistant line.
    const sameName = bridged();
    pushAll(sameName, [init(), messageStart, toolStart(0, "toolu_01", ECHO)]);
    expectReason(() => sameName.push(assistantTool("toolu_01", "notes_echo", {})), "claude_cli_bridge_mismatch");
  });

  it("a tool_use block without a name still throws claude_cli_tool_use_blocked", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart]);
    expectReason(() => mapper.push(toolStart(0, "toolu_01", "")), "claude_cli_tool_use_blocked");
  });
});

describe("bridged governance faults", () => {
  it("server_tool_use throws claude_cli_tool_use_blocked", () => {
    const atStart = bridged();
    pushAll(atStart, [init(), messageStart]);
    expectReason(
      () => atStart.push(toolStart(0, "srvtoolu_01", "web_search", "server_tool_use")),
      "claude_cli_tool_use_blocked",
    );

    const atAssistant = bridged();
    pushAll(atAssistant, [init(), messageStart]);
    expectReason(
      () => atAssistant.push(assistantTool("mcptoolu_01", ECHO, {}, "mcp_tool_use")),
      "claude_cli_tool_use_blocked",
    );
  });

  it("system/permission_denied throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" })]);
    expectReason(
      () =>
        mapper.push(
          line({
            type: "system",
            subtype: "permission_denied",
            tool_name: ECHO,
            tool_use_id: "toolu_01Echo",
            decision_reason_type: "mode",
          }),
        ),
      "claude_cli_bridge_mismatch",
    );
  });

  it("a user tool_result line throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" }), blockStop(0)]);
    expectReason(
      () =>
        mapper.push(
          line({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_01Echo", content: "denied", is_error: true }],
            },
          }),
        ),
      "claude_cli_bridge_mismatch",
    );
  });

  it("a second message_start throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, textStart(0), textDelta(0, "hi"), messageDelta("end_turn"), messageStop]);
    expectReason(() => mapper.push(messageStart), "claude_cli_bridge_mismatch");
  });

  it("a tool_use stop whose block never got its assistant line throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [
      init(),
      messageStart,
      toolStart(0, "toolu_01Echo", ECHO),
      jsonDelta(0, "{}"),
      messageDelta("tool_use"),
    ]);
    expectReason(() => mapper.push(messageStop), "claude_cli_bridge_mismatch");
    expect(mapper.toolStep()).toBeUndefined();
  });

  it("an assistant tool_use for a block that never started throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart]);
    expectReason(() => mapper.push(assistantTool("toolu_01Echo", ECHO, {})), "claude_cli_bridge_mismatch");
  });

  it("a tool_use stop with no tool block throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, messageDelta("tool_use")]);
    expectReason(() => mapper.push(messageStop), "claude_cli_bridge_mismatch");
  });

  it("an end_turn stop after a tool block throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_01Echo", ECHO, {}), messageDelta("end_turn")]);
    expectReason(() => mapper.push(messageStop), "claude_cli_bridge_mismatch");
  });

  it("a result before message_stop after a started tool call throws claude_cli_bridge_mismatch", () => {
    const mapper = bridged();
    pushAll(mapper, [init(), messageStart, ...toolCallLines(0, "toolu_01Echo", ECHO, { text: "hi" })]);
    const result = line({ type: "result", subtype: "success", is_error: false, usage: STEP_USAGE });
    expect(() => mapper.push(result)).toThrow(
      expect.objectContaining({
        reasonCode: "claude_cli_bridge_mismatch",
        message: expect.stringContaining("a result arrived before the tool step ended"),
      }),
    );
    expect(mapper.toolStep()).toBeUndefined();
  });

  it("an unbridged mapper still blocks any tool_use", () => {
    const mapper = createClaudeCliStreamMapper(MODEL);
    mapper.push(init({ mcp_servers: [], tools: [] }));
    mapper.push(messageStart);
    expectReason(() => mapper.push(toolStart(0, "toolu_01Echo", ECHO)), "claude_cli_tool_use_blocked");
    expectReason(() => createClaudeCliStreamMapper(MODEL).push(jsonDelta(0, "{}")), "claude_cli_tool_use_blocked");
    expectReason(
      () => createClaudeCliStreamMapper(MODEL).push(assistantTool("toolu_01Echo", ECHO, {})),
      "claude_cli_tool_use_blocked",
    );
    expect(mapper.toolStep()).toBeUndefined();
  });
});
