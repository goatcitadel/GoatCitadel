import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatCompletionRequest, LlmConfigFile } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_CLAUDE_CLI_NODE_PATH as NODE_PATH,
  FAKE_CLAUDE_CLI_STUB_PATH as STUB_PATH,
  createFakeClaudeCliHarness as createHarness,
  createFakeModelUsageAccounting as createAccounting,
  helloScript,
  line,
  toolStepScript,
  warmToolStepScript,
  type FakeClaudeCliCall as FakeCall,
  type FakeClaudeCliHarness,
  type FakeClaudeCliStaging,
} from "../test/claude-code-cli-fake-spawn.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { buildClaudeCliArgs } from "./claude-code-cli-process.js";
import { CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM } from "./claude-code-cli-stream.js";
import { LlmService } from "./llm-service.js";

/**
 * Step-mode tool bridge through LlmService: the fake CLI reports the bridged
 * tools, stops for tool_use and then keeps waiting on the (inert) stub like the
 * real CLI does, so the adapter must end the step and kill the tree itself.
 */

const config: LlmConfigFile = {
  activeProviderId: "claude-code-cli",
  activeModel: "claude-sonnet-5-5",
  providers: [
    {
      providerId: "claude-code-cli",
      label: "Claude Code CLI (local login)",
      baseUrl: "https://api.anthropic.com/v1",
      apiStyle: "claude-code-cli",
      defaultModel: "claude-sonnet-5-5",
    },
  ],
};

const tools: Array<Record<string, unknown>> = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a workspace file by path",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  { type: "function", function: { name: "list_dir", description: "List a directory", parameters: {} } },
];
const toolNames = ["read_file", "list_dir"];
const readCall: FakeCall = { id: "toolu_read", name: "read_file", input: { path: "notes/plan.md" } };
const listCall: FakeCall = { id: "toolu_list", name: "list_dir", input: { path: "notes" } };

function readDelta(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  return (chunk.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta;
}

describe("claude-code-cli tool bridge through LlmService", () => {
  let scratchRoot: string;
  let bridgeEnabled: boolean;
  let stubPath: string | undefined;

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-bridge-test-"));
    bridgeEnabled = true;
    stubPath = STUB_PATH;
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  function createService(harness: ReturnType<typeof createHarness>, accounting = createAccounting()) {
    const service = new LlmService(
      config,
      { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op" },
      {
        secretStore: createNoopSecretStore(),
        enforceNetworkAllowlist: false,
        modelUsageAccounting: accounting.service,
        claudeCliToolBridgeEnabled: () => bridgeEnabled,
        claudeCli: {
          spawn: harness.spawn,
          killTree: harness.killTree,
          readiness: harness.readiness,
          resolveInvocation: () => ({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] }),
          scratchRoot,
          toolBridge: { stubPath: () => stubPath, nodePath: NODE_PATH },
        },
      },
    );
    return { service, accounting };
  }

  async function collect(service: LlmService, request: ChatCompletionRequest) {
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(request)) chunks.push(chunk);
    return chunks;
  }

  it("a bridged step spawns with the bridge args, writes tools.json and mcp.json, yields tool_calls, and kills the tree after message_stop", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall])]);
    const { service, accounting } = createService(harness);

    const chunks = await collect(service, {
      messages: [
        { role: "system", content: "You are GoatCitadel." },
        { role: "user", content: "open the plan" },
      ],
      tools,
      tool_choice: "auto",
    });

    const spawned = harness.spawns[0];
    expect(spawned?.args.slice(0, 3)).toEqual(["-p", "--mcp-config", expect.stringMatching(/mcp\.json$/)]);
    expect(spawned?.args).not.toContain("--safe-mode");
    expect(spawned?.args.slice(-4)).toEqual(["--allowedTools", "mcp__goatcitadel", "--permission-prompts", "none"]);
    expect(spawned?.mcpConfigAtSpawn).toMatchObject({
      mcpServers: { goatcitadel: { type: "stdio", command: NODE_PATH, args: [STUB_PATH, expect.any(String)] } },
    });
    expect(spawned?.toolsFileAtSpawn).toMatchObject({
      tools: [
        { name: "read_file", description: "Read a workspace file by path" },
        { name: "list_dir", description: "List a directory" },
      ],
    });
    const stdin = JSON.parse(spawned?.stdin() ?? "{}") as { message: { content: Array<{ text: string }> } };
    expect(stdin.message.content).toEqual([{ type: "text", text: "open the plan" }]);

    const toolCallChunk = chunks.find((chunk) => Array.isArray(readDelta(chunk)?.tool_calls));
    expect(readDelta(toolCallChunk ?? {})?.tool_calls).toEqual([
      {
        index: 0,
        id: "toolu_read",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify(readCall.input) },
      },
    ]);
    expect(chunks.at(-1)).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    });

    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(1);
    expect(accounting.handle.cancel).not.toHaveBeenCalled();
    expect(accounting.handle.fail).not.toHaveBeenCalled();
    expect(accounting.handle.observe).toHaveBeenCalledWith(expect.objectContaining({ completion_tokens: 9 }));
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("puts the bridge addendum in the system prompt file of a bridged step", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);
    await collect(service, {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "go" },
      ],
      tools,
    });
    expect(harness.spawns[0]?.systemPromptAtSpawn).toBe(`Be terse.\n\n${CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM}`);
  });

  it("keeps the inline system fallback on a bridged step, as the first user block", async () => {
    const harness = createHarness([
      ({ stderr, exit }) => {
        stderr.write("error: unknown option '--system-prompt-file'\n");
        exit(1);
      },
      toolStepScript(toolNames, [readCall]),
    ]);
    const { service, accounting } = createService(harness);
    const chunks = await collect(service, {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "go" },
      ],
      tools,
    });
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]?.args).not.toContain("--system-prompt-file");
    expect(harness.spawns[1]?.args).toContain("--mcp-config");
    const stdin = JSON.parse(harness.spawns[1]?.stdin() ?? "{}") as { message: { content: Array<{ text: string }> } };
    expect(stdin.message.content.map((block) => block.text)).toEqual([
      `[System instructions]\nBe terse.\n\n${CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM}`,
      "go",
    ]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(1);
  });

  it("flag off: tools are dropped and argv equals today's", async () => {
    bridgeEnabled = false;
    const harness = createHarness([]);
    const { service } = createService(harness);
    const messages: ChatCompletionRequest["messages"] = [{ role: "user", content: "hi" }];

    await collect(service, { messages });
    await collect(service, { messages, tools, tool_choice: "auto" });

    const [plain, withTools] = harness.spawns;
    expect(withTools?.args).toEqual(plain?.args);
    expect(withTools?.args).toContain("--safe-mode");
    expect(withTools?.args).not.toContain("--mcp-config");
    expect(withTools?.stdin()).toBe(plain?.stdin());
    expect(withTools?.stdin()).not.toContain("read_file");
  });

  it("reads the flag per step", async () => {
    const harness = createHarness([helloScript, toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);
    bridgeEnabled = false;
    await collect(service, { messages: [{ role: "user", content: "hi" }], tools });
    bridgeEnabled = true;
    await collect(service, { messages: [{ role: "user", content: "hi" }], tools });
    expect(harness.spawns[0]?.args).not.toContain("--mcp-config");
    expect(harness.spawns[1]?.args).toContain("--mcp-config");
  });

  it('tool_choice "none": unbridged', async () => {
    const harness = createHarness([]);
    const { service } = createService(harness);
    const chunks = await collect(service, { messages: [{ role: "user", content: "hi" }], tools, tool_choice: "none" });
    expect(harness.spawns[0]?.args).toContain("--safe-mode");
    expect(harness.spawns[0]?.args).not.toContain("--mcp-config");
    expect(harness.spawns[0]?.stdin()).not.toContain("read_file");
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });

  it('tool_choice "required": still claude_cli_tools_unsupported before spawn', async () => {
    const harness = createHarness([]);
    const { service, accounting } = createService(harness);
    for (const toolChoice of ["required", { type: "function", function: { name: "read_file" } }] as const) {
      await expect(
        collect(service, { messages: [{ role: "user", content: "hi" }], tools, tool_choice: toolChoice }),
      ).rejects.toMatchObject({ reasonCode: "claude_cli_tools_unsupported" });
    }
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(accounting.prepareDispatch).not.toHaveBeenCalled();
  });

  it("a missing stub fails claude_cli_bridge_unavailable before any usage intent", async () => {
    stubPath = undefined;
    const harness = createHarness([]);
    const { service, accounting } = createService(harness);
    await expect(collect(service, { messages: [{ role: "user", content: "hi" }], tools })).rejects.toMatchObject({
      reasonCode: "claude_cli_bridge_unavailable",
    });
    expect(accounting.prepareDispatch).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("abort during a bridged step kills the tree and cancels the usage attempt", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall], { stop: false })]);
    const { service, accounting } = createService(harness);
    const controller = new AbortController();
    const stream = service.chatCompletionsStream({
      messages: [{ role: "user", content: "hi" }],
      tools,
      signal: controller.signal,
    });
    const pending = stream.next();
    await vi.waitFor(() => expect(harness.spawns).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reasonCode: "claude_cli_cancelled" });
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(accounting.handle.cancel).toHaveBeenCalledTimes(1);
    expect(accounting.handle.succeed).not.toHaveBeenCalled();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("an init that lists a tool outside the manifest fails claude_cli_bridge_mismatch and kills the tree", async () => {
    const harness = createHarness([
      ({ stdout }) => {
        stdout.write(
          line({
            type: "system",
            subtype: "init",
            tools: [...toolNames.map((name) => `mcp__goatcitadel__${name}`), "Bash"],
            mcp_servers: [{ name: "goatcitadel", status: "connected" }],
          }),
        );
      },
    ]);
    const { service, accounting } = createService(harness);
    await expect(collect(service, { messages: [{ role: "user", content: "hi" }], tools })).rejects.toMatchObject({
      reasonCode: "claude_cli_bridge_mismatch",
    });
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(accounting.handle.fail).toHaveBeenCalledTimes(1);
    expect(accounting.handle.succeed).not.toHaveBeenCalled();
    expect(accounting.handle.cancel).not.toHaveBeenCalled();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a consumer that stops right after the tool_calls chunk keeps the settled success", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall])]);
    const { service, accounting } = createService(harness);
    let sawToolCalls = false;
    for await (const chunk of service.chatCompletionsStream({ messages: [{ role: "user", content: "hi" }], tools })) {
      if (Array.isArray(readDelta(chunk)?.tool_calls)) {
        sawToolCalls = true;
        break;
      }
    }
    expect(sawToolCalls).toBe(true);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(1);
    expect(accounting.handle.cancel).not.toHaveBeenCalled();
    expect(accounting.handle.fail).not.toHaveBeenCalled();
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("no user text or tool definition appears in argv", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);
    await collect(service, {
      messages: [
        { role: "system", content: "SYSTEM-SECRET-MARKER" },
        { role: "user", content: "USER-TEXT-MARKER" },
      ],
      tools,
    });
    const argv = harness.spawns[0]?.args.join("\n") ?? "";
    for (const forbidden of ["USER-TEXT-MARKER", "SYSTEM-SECRET-MARKER", "read_file", "list_dir", "Read a workspace"]) {
      expect(argv).not.toContain(forbidden);
    }
  });

  it('chatCompletions returns message.tool_calls and finish_reason "tool_calls" for a bridged step', async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall, listCall])]);
    const { service } = createService(harness);
    const response = await service.chatCompletions({ messages: [{ role: "user", content: "look" }], tools });
    expect(response.choices?.[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [
          {
            id: "toolu_read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify(readCall.input) },
          },
          {
            id: "toolu_list",
            type: "function",
            function: { name: "list_dir", arguments: JSON.stringify(listCall.input) },
          },
        ],
      },
    });
    expect(response.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 9 });
  });

  it("parallel_tool_calls false emits only the first tool call", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall, listCall])]);
    const { service } = createService(harness);
    const chunks = await collect(service, {
      messages: [{ role: "user", content: "look" }],
      tools,
      parallel_tool_calls: false,
    });
    const calls = chunks.flatMap((chunk) => (readDelta(chunk)?.tool_calls as unknown[] | undefined) ?? []);
    expect(calls).toEqual([expect.objectContaining({ index: 0, id: "toolu_read" })]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
  });

  it('tool_choice absent is bridged like "auto"', async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall]), toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);
    await collect(service, { messages: [{ role: "user", content: "hi" }], tools });
    await collect(service, { messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "auto" } });
    for (const spawned of harness.spawns) {
      expect(spawned.args).toContain("--mcp-config");
      expect(spawned.args).not.toContain("--safe-mode");
    }
  });
});

describe("claude-code-cli warm continuation through LlmService", () => {
  const MODEL = "claude-sonnet-5-5";
  const attribution = { sessionId: "session-warm", turnId: "turn-warm" };
  type Message = ChatCompletionRequest["messages"][number];
  const firstMessages: Message[] = [
    { role: "system", content: "You are GoatCitadel." },
    { role: "user", content: "open the plan" },
  ];
  const assistantFor = (calls: readonly FakeCall[]): Message =>
    ({
      role: "assistant",
      content: "",
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    }) as Message;
  const toolResult = (id: string, content: string): Message => ({ role: "tool", tool_call_id: id, content }) as Message;
  const secondMessages = [...firstMessages, assistantFor([readCall]), toolResult(readCall.id, "PLAN TEXT")];

  let scratchRoot: string;
  let configRoot: string;
  let warmEnabled: boolean;
  let services: LlmService[];

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-warm-test-"));
    // The spill check reads <CLAUDE_CONFIG_DIR>/projects; keep it off the operator's real profile.
    configRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-warm-config-"));
    warmEnabled = true;
    services = [];
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.close()));
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  function createService(harness: FakeClaudeCliHarness, accounting = createAccounting()) {
    const service = new LlmService(
      config,
      // MCP_TOOL_TIMEOUT from the host must never reach the child.
      { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op", CLAUDE_CONFIG_DIR: configRoot, MCP_TOOL_TIMEOUT: "5" },
      {
        secretStore: createNoopSecretStore(),
        enforceNetworkAllowlist: false,
        modelUsageAccounting: accounting.service,
        claudeCliToolBridgeEnabled: () => true,
        claudeCliWarmContinuationEnabled: () => warmEnabled,
        claudeCli: {
          spawn: harness.spawn,
          killTree: harness.killTree,
          readiness: harness.readiness,
          resolveInvocation: () => ({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] }),
          scratchRoot,
          toolBridge: { stubPath: () => STUB_PATH, nodePath: NODE_PATH },
        },
      },
    );
    services.push(service);
    return { service, accounting };
  }

  async function collect(service: LlmService, request: ChatCompletionRequest, attr: object = attribution) {
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(request, attr)) chunks.push(chunk);
    return chunks;
  }

  const textOf = (chunks: Array<Record<string, unknown>>) =>
    chunks.map((chunk) => readDelta(chunk)?.content ?? "").join("");
  const toolCallIds = (chunks: Array<Record<string, unknown>>) =>
    chunks.flatMap((chunk) => ((readDelta(chunk)?.tool_calls as Array<{ id: string }>) ?? []).map((call) => call.id));
  const spawnEnv = (harness: FakeClaudeCliHarness, index: number) => harness.spawn.mock.calls[index]?.[2].env;
  const runDirOf = (harness: FakeClaudeCliHarness, index: number) => {
    const args = harness.spawns[index]?.args ?? [];
    return path.dirname(args[args.indexOf("--mcp-config") + 1] as string);
  };
  /** argv with this spawn's run-dir paths reduced to their file names. */
  const normalizedArgs = (harness: FakeClaudeCliHarness, index: number) =>
    (harness.spawns[index]?.args ?? []).map((arg) => (arg.startsWith(scratchRoot) ? path.basename(arg) : arg));

  it("a parked step's run dir survives the call, and the tree is not killed", async () => {
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "done" }])]);
    const { service, accounting } = createService(harness);

    const chunks = await collect(service, { messages: firstMessages, tools });

    expect(toolCallIds(chunks)).toEqual(["toolu_read"]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
    expect(harness.killTree).not.toHaveBeenCalled();
    expect(readdirSync(scratchRoot)).toEqual([path.basename(runDirOf(harness, 0))]);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(1);

    await service.close();
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("the next matching request resumes the same pid: no second spawn, and usage is two attempts", async () => {
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "All done." }])]);
    const { service, accounting } = createService(harness);

    await collect(service, { messages: firstMessages, tools });
    const chunks = await collect(service, { messages: secondMessages, tools });

    expect(harness.spawns).toHaveLength(1);
    expect(textOf(chunks)).toBe("All done.");
    expect(chunks.at(-1)).toMatchObject({
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    expect(accounting.prepareDispatch).toHaveBeenCalledTimes(2);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(2);
    expect(accounting.handle.fail).not.toHaveBeenCalled();
    expect(accounting.handle.cancel).not.toHaveBeenCalled();
    expect(accounting.handle.observe).toHaveBeenLastCalledWith(expect.objectContaining({ completion_tokens: 4 }));
    // The process ended on its own; its run dir goes with the resumed step.
    expect(harness.killTree).not.toHaveBeenCalled();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a resumed step that stops for tools again parks again and continues a third time", async () => {
    const harness = createHarness([warmToolStepScript([readCall], [{ calls: [listCall] }, { text: "Listed." }])]);
    const { service, accounting } = createService(harness);

    await collect(service, { messages: firstMessages, tools });
    const second = await collect(service, { messages: secondMessages, tools });
    expect(toolCallIds(second)).toEqual(["toolu_list"]);
    expect(harness.killTree).not.toHaveBeenCalled();
    const third = await collect(service, {
      messages: [...secondMessages, assistantFor([listCall]), toolResult(listCall.id, "plan.md")],
      tools,
    });

    expect(textOf(third)).toBe("Listed.");
    expect(harness.spawns).toHaveLength(1);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(3);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("no result file exists until beginTrackedDispatch resolves", async () => {
    const staging: FakeClaudeCliStaging = { read: [] };
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "done" }], staging)]);
    const { service, accounting } = createService(harness);
    await collect(service, { messages: firstMessages, tools });
    const resultsDir = path.join(runDirOf(harness, 0), "results");

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accept = accounting.prepareDispatch.getMockImplementation();
    accounting.prepareDispatch.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return await accept?.(...args);
    });
    const pending = collect(service, { messages: secondMessages, tools });
    await vi.waitFor(() => expect(accounting.prepareDispatch).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readdirSync(resultsDir)).toEqual([]);
    expect(staging.read).toEqual([]);

    release();
    expect(textOf(await pending)).toBe("done");
    expect(staging.read).toEqual(["toolu_read.json"]);
  });

  it("a failed dispatch reaps the parked step and writes no file", async () => {
    const staging: FakeClaudeCliStaging = { read: [] };
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "done" }], staging)]);
    const { service, accounting } = createService(harness);
    await collect(service, { messages: firstMessages, tools });

    accounting.prepareDispatch.mockRejectedValueOnce(new Error("usage intent refused"));
    await expect(collect(service, { messages: secondMessages, tools })).rejects.toThrow();

    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(harness.spawns).toHaveLength(1);
    expect(staging.read).toEqual([]);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a miss kills the parked tree, then spawns cold", async () => {
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "unused" }])]);
    const { service } = createService(harness);
    await collect(service, { messages: firstMessages, tools });

    // A steering message after the tool result: not a continuation of the parked step.
    const chunks = await collect(service, {
      messages: [...secondMessages, { role: "user", content: "actually, stop" }],
      tools,
    });

    expect(textOf(chunks)).toBe("hello");
    expect(harness.spawns).toHaveLength(2);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(harness.killTree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[1] as number,
    );
    expect(normalizedArgs(harness, 1)).toEqual(normalizedArgs(harness, 0));
    expect(normalizedArgs(harness, 1)).toEqual(
      buildClaudeCliArgs({
        model: MODEL,
        systemPromptFile: "system-prompt.txt",
        bridge: { mcpConfigPath: "mcp.json" },
      }),
    );
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("MCP_TOOL_TIMEOUT is 660000 on bridged steps with the warm flag on, absent otherwise, and never copied from the host env", async () => {
    const harness = createHarness([
      toolStepScript(toolNames, [readCall]),
      helloScript,
      toolStepScript(toolNames, [readCall]),
    ]);
    const { service } = createService(harness);

    await collect(service, { messages: firstMessages, tools });
    await collect(service, { messages: [{ role: "user", content: "no tools" }] });
    warmEnabled = false;
    await collect(service, { messages: firstMessages, tools });

    expect(spawnEnv(harness, 0)?.MCP_TOOL_TIMEOUT).toBe("660000");
    expect(spawnEnv(harness, 1)).not.toHaveProperty("MCP_TOOL_TIMEOUT");
    expect(spawnEnv(harness, 2)).not.toHaveProperty("MCP_TOOL_TIMEOUT");
  });

  it("warm flag off is byte-identical to today: argv, env and kill-at-stop", async () => {
    warmEnabled = false;
    const harness = createHarness([toolStepScript(toolNames, [readCall]), toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);

    await collect(service, { messages: firstMessages, tools });

    const runDir = runDirOf(harness, 0);
    expect(harness.spawns[0]?.args).toEqual(
      buildClaudeCliArgs({
        model: MODEL,
        systemPromptFile: path.join(runDir, "system-prompt.txt"),
        bridge: { mcpConfigPath: path.join(runDir, "mcp.json") },
      }),
    );
    expect(spawnEnv(harness, 0)).toEqual({
      PATH: "C:\\Windows",
      USERPROFILE: "C:\\Users\\op",
      CLAUDE_CONFIG_DIR: configRoot,
    });
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(readdirSync(scratchRoot)).toEqual([]);

    // The warm flag changes the env only, never argv.
    warmEnabled = true;
    await collect(service, { messages: firstMessages, tools });
    expect(normalizedArgs(harness, 1)).toEqual(normalizedArgs(harness, 0));
  });

  it("parallel_tool_calls false with two tool_use blocks is not parked", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall, listCall])]);
    const { service } = createService(harness);

    const chunks = await collect(service, { messages: firstMessages, tools, parallel_tool_calls: false });

    expect(toolCallIds(chunks)).toEqual(["toolu_read"]);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a step without session and turn attribution is not parked", async () => {
    const harness = createHarness([toolStepScript(toolNames, [readCall])]);
    const { service } = createService(harness);

    await collect(service, { messages: firstMessages, tools }, {});

    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});
