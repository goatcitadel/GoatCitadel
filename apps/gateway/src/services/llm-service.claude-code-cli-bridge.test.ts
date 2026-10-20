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
  toolStepScript,
  type FakeClaudeCliCall as FakeCall,
} from "../test/claude-code-cli-fake-spawn.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
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
