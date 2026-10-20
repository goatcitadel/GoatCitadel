import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ChatCompletionRequest, LlmConfigFile } from "@goatcitadel/contracts";
import type { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { ClaudeCodeCliReadiness } from "./claude-code-cli-readiness.js";
import { CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM } from "./claude-code-cli-stream.js";
import { LlmService } from "./llm-service.js";

/**
 * Step-mode tool bridge through LlmService: the fake CLI reports the bridged
 * tools, stops for tool_use and then keeps waiting on the (inert) stub like the
 * real CLI does, so the adapter must end the step and kill the tree itself.
 */

interface SpawnRecord {
  args: string[];
  stdin: () => string;
  mcpConfigAtSpawn?: Record<string, unknown>;
  toolsFileAtSpawn?: Record<string, unknown>;
  systemPromptAtSpawn?: string;
}

type Script = (child: { stdout: PassThrough; stderr: PassThrough; exit: (code: number | null) => void }) => void;

const STUB_PATH = path.join(os.tmpdir(), "gc-test-stub", "claude-code-cli-mcp-stub.js");
const NODE_PATH = path.join(os.tmpdir(), "gc-test-node", "node.exe");
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const streamEvent = (event: Record<string, unknown>) => line({ type: "stream_event", event });

const helloScript: Script = ({ stdout, exit }) => {
  stdout.write(line({ type: "system", subtype: "init" }));
  stdout.write(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }));
  stdout.write(
    line({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } }),
  );
  exit(0);
};

interface FakeCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function bridgedInit(toolNames: readonly string[]): string {
  return line({
    type: "system",
    subtype: "init",
    tools: toolNames.map((name) => `mcp__goatcitadel__${name}`),
    mcp_servers: [{ name: "goatcitadel", status: "connected" }],
  });
}

/** Modeled on the live probe: init, one message with tool_use blocks, tool_use stop, then no exit. */
function toolStepScript(toolNames: readonly string[], calls: readonly FakeCall[], options: { stop?: boolean } = {}) {
  const script: Script = ({ stdout }) => {
    stdout.write(bridgedInit(toolNames));
    stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
    calls.forEach((call, index) => {
      const name = `mcp__goatcitadel__${call.name}`;
      stdout.write(
        streamEvent({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id, name, input: {} },
        }),
      );
      stdout.write(
        streamEvent({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
        }),
      );
      stdout.write(
        line({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: call.id, name, input: call.input }] },
        }),
      );
      stdout.write(streamEvent({ type: "content_block_stop", index }));
    });
    if (options.stop === false) return;
    stdout.write(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 5, output_tokens: 9 },
      }),
    );
    stdout.write(streamEvent({ type: "message_stop" }));
    // A heartbeat after the stop is ignored; the CLI never exits on its own here.
    stdout.write(line({ type: "tool_progress", heartbeat: true }));
  };
  return script;
}

function readJson(filePath: string | undefined): Record<string, unknown> | undefined {
  return filePath ? (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>) : undefined;
}

function createHarness(scripts: Script[]) {
  const spawns: SpawnRecord[] = [];
  const killTree = vi.fn();
  const spawn = vi.fn((_command: string, args: string[], _options: SpawnOptions) => {
    const emitter = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    Object.assign(emitter, { stdout, stderr, stdin, pid: 7000 + spawns.length, exitCode: null });
    const configIndex = args.indexOf("--mcp-config");
    const mcpConfigAtSpawn = readJson(configIndex >= 0 ? args[configIndex + 1] : undefined);
    const server = (mcpConfigAtSpawn?.mcpServers as Record<string, { args?: string[] }> | undefined)?.goatcitadel;
    const systemIndex = args.indexOf("--system-prompt-file");
    spawns.push({
      args,
      stdin: () => Buffer.concat(chunks).toString("utf8"),
      mcpConfigAtSpawn,
      toolsFileAtSpawn: readJson(server?.args?.[1]),
      systemPromptAtSpawn: systemIndex >= 0 ? readFileSync(args[systemIndex + 1] as string, "utf8") : undefined,
    });
    const script = scripts[spawns.length - 1] ?? helloScript;
    setImmediate(() =>
      script({
        stdout,
        stderr,
        exit: (code) => {
          Object.assign(emitter, { exitCode: code });
          stdout.end();
          stderr.end();
          setImmediate(() => emitter.emit("close", code, null));
        },
      }),
    );
    return emitter;
  });
  const readiness = new ClaudeCodeCliReadiness({
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
    }),
  });
  return { spawns, spawn, killTree, readiness };
}

function createAccounting() {
  const handle = {
    eventId: "usage-event-bridge",
    renewLease: vi.fn(async () => undefined),
    observe: vi.fn(),
    observeNormalized: vi.fn(),
    succeed: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
  const prepareDispatch = vi.fn(async () => ({
    eventId: handle.eventId,
    accept: vi.fn(async () => handle),
    abandon: vi.fn(async () => undefined),
    markDispatchUnknown: vi.fn(async () => undefined),
  }));
  return { handle, prepareDispatch, service: { prepareDispatch } as unknown as ModelUsageAccountingService };
}

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
