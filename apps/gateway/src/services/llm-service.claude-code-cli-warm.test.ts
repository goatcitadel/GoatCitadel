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
  fakeWarmCallUsage,
  helloScript,
  toolStepScript,
  warmToolStepScript,
  type FakeClaudeCliCall as FakeCall,
  type FakeClaudeCliHarness,
  type FakeClaudeCliStaging,
} from "../test/claude-code-cli-fake-spawn.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { buildClaudeCliArgs } from "./claude-code-cli-process.js";
import { CLAUDE_CLI_WARM_ECHO_DEADLINE_MS } from "./claude-code-cli-warm-registry.js";
import { LlmService } from "./llm-service.js";

/**
 * Warm continuation through LlmService: the fake CLI parks after a tool step like the
 * real CLI, echoes each result file the Gateway stages, then plays its next segment.
 */

// Lets a test hold a result file's final rename, to open a window between two result files.
const renameHook = vi.hoisted(() => ({ before: undefined as ((target: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    await renameHook.before?.(String(to));
    await actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

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

/** The usage a step settles when its model call reported `fakeWarmCallUsage(n)`. */
function settledUsage(n: number): Record<string, number> {
  const usage = fakeWarmCallUsage(n);
  return {
    prompt_tokens: usage.input_tokens as number,
    completion_tokens: usage.output_tokens as number,
    total_tokens: (usage.input_tokens as number) + (usage.output_tokens as number),
    cache_read_input_tokens: usage.cache_read_input_tokens as number,
    cache_creation_input_tokens: usage.cache_creation_input_tokens as number,
  };
}

/** The runtime's parked-process count; the registry is private to LlmService. */
function parkedCount(service: LlmService): number {
  return (service as unknown as { claudeCodeCli: { warm: { size: number } } }).claudeCodeCli.warm.size;
}

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
  let bridgeEnabled: boolean;
  let stubPath: string | undefined;
  let services: LlmService[];

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-warm-test-"));
    // The spill check reads <CLAUDE_CONFIG_DIR>/projects; keep it off the operator's real profile.
    configRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-warm-config-"));
    warmEnabled = true;
    bridgeEnabled = true;
    stubPath = STUB_PATH;
    services = [];
  });

  afterEach(async () => {
    renameHook.before = undefined;
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
        claudeCliToolBridgeEnabled: () => bridgeEnabled,
        claudeCliWarmContinuationEnabled: () => warmEnabled,
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
      usage: settledUsage(1),
    });
    expect(accounting.prepareDispatch).toHaveBeenCalledTimes(2);
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(2);
    expect(accounting.handle.fail).not.toHaveBeenCalled();
    expect(accounting.handle.cancel).not.toHaveBeenCalled();
    expect(accounting.handle.observe).toHaveBeenLastCalledWith(settledUsage(1));
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

  it("each step of a 3-step warm turn settles its own segment's usage, never the process total", async () => {
    const harness = createHarness([warmToolStepScript([readCall], [{ calls: [listCall] }, { text: "Listed." }])]);
    const { service, accounting } = createService(harness);

    await collect(service, { messages: firstMessages, tools });
    await collect(service, { messages: secondMessages, tools });
    const third = await collect(service, {
      messages: [...secondMessages, assistantFor([listCall]), toolResult(listCall.id, "plan.md")],
      tools,
    });

    expect(harness.spawns).toHaveLength(1);
    // The fake's final result.usage sums all three calls, like the real CLI's.
    expect(accounting.handle.observe.mock.calls).toEqual([[settledUsage(0)], [settledUsage(1)], [settledUsage(2)]]);
    expect(third.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: settledUsage(2) });
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(3);
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
    // The miss reap is fire-and-forget; only its kill is ordered before the cold spawn.
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
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
    // The first step parked; the unbridged request for the same turn reaped it before spawning.
    expect(harness.killTree).toHaveBeenNthCalledWith(1, 7000);
    expect(harness.killTree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[1] as number,
    );
    expect(parkedCount(service)).toBe(0);
  });

  it.each([
    ["the warm flag is off", () => (warmEnabled = false), { tools }],
    ["the bridge flag is off", () => (bridgeEnabled = false), { tools }],
    ["the step is unbridged", () => undefined, { tools, tool_choice: "none" as const }],
  ])("a same-turn request reaps the parked entry before it spawns when %s", async (_when, flip, extra) => {
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "unused" }])]);
    const { service } = createService(harness);
    await collect(service, { messages: firstMessages, tools });
    expect(parkedCount(service)).toBe(1);

    flip();
    await collect(service, { messages: secondMessages, ...extra });

    expect(harness.spawns).toHaveLength(2);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(harness.killTree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[1] as number,
    );
    expect(parkedCount(service)).toBe(0);
    // The reap is fire-and-forget: the kill comes first, the run-dir removal later.
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it.each([
    ["a required tool call", "claude_cli_tools_unsupported", { tool_choice: "required" as const }],
    ["a missing stub", "claude_cli_bridge_unavailable", {}],
  ])("a same-turn request that fails its early checks (%s) still reaps the parked entry", async (_why, code, extra) => {
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "unused" }])]);
    const { service } = createService(harness);
    await collect(service, { messages: firstMessages, tools });

    if (code === "claude_cli_bridge_unavailable") stubPath = undefined;
    await expect(collect(service, { messages: secondMessages, tools, ...extra })).rejects.toMatchObject({
      reasonCode: code,
    });

    expect(harness.spawns).toHaveLength(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(parkedCount(service)).toBe(0);
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it("a staged result that is never echoed fails the step as claude_cli_bridge_mismatch within the echo deadline", async () => {
    const staging: FakeClaudeCliStaging = { read: [] };
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "unused" }], staging, { echo: false })]);
    const { service, accounting } = createService(harness);
    await collect(service, { messages: firstMessages, tools });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // An overall timeout far past the echo deadline, so only the echo deadline can end the step.
      const outcome = expect(
        collect(service, { messages: secondMessages, tools, timeoutMs: 3_600_000 }),
      ).rejects.toMatchObject({
        reasonCode: "claude_cli_bridge_mismatch",
      });
      await vi.waitFor(() => expect(staging.read).toEqual([`${readCall.id}.json`]));
      expect(harness.killTree).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CLAUDE_CLI_WARM_ECHO_DEADLINE_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(harness.spawns).toHaveLength(1);
    expect(accounting.handle.fail).toHaveBeenCalledTimes(1);
    expect(parkedCount(service)).toBe(0);
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it("a request cancelled while its usage intent is in flight stages nothing and reaps the parked step", async () => {
    const staged: string[] = [];
    const harness = createHarness([warmToolStepScript([readCall], [{ text: "unused" }])]);
    const { service, accounting } = createService(harness);
    await collect(service, { messages: firstMessages, tools });
    renameHook.before = async (target) => {
      staged.push(path.basename(target));
    };

    const controller = new AbortController();
    const accept = accounting.prepareDispatch.getMockImplementation();
    accounting.prepareDispatch.mockImplementationOnce(async (...args: unknown[]) => {
      const dispatch = await accept?.(...args);
      controller.abort();
      return dispatch;
    });
    await expect(
      collect(service, { messages: secondMessages, tools, signal: controller.signal }),
    ).rejects.toMatchObject({ reasonCode: "claude_cli_cancelled" });

    expect(staged).toEqual([]);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(accounting.handle.cancel).toHaveBeenCalledTimes(1);
    expect(parkedCount(service)).toBe(0);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("an echo of the first result before the second is staged is accepted", async () => {
    const staging: FakeClaudeCliStaging = { read: [] };
    const harness = createHarness([warmToolStepScript([readCall, listCall], [{ text: "Both read." }], staging)]);
    const { service, accounting } = createService(harness);
    await collect(service, { messages: firstMessages, tools });

    // Hold the second file until the CLI has echoed the first (and the line has reached the Gateway).
    renameHook.before = async (target) => {
      if (path.basename(target) !== `${listCall.id}.json`) return;
      await vi.waitFor(() => expect(staging.read).toEqual([`${readCall.id}.json`]));
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const chunks = await collect(service, {
      messages: [
        ...firstMessages,
        assistantFor([readCall, listCall]),
        toolResult(readCall.id, "PLAN TEXT"),
        toolResult(listCall.id, "plan.md"),
      ],
      tools,
    });

    expect(textOf(chunks)).toBe("Both read.");
    expect(staging.read).toEqual([`${readCall.id}.json`, `${listCall.id}.json`]);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.killTree).not.toHaveBeenCalled();
    expect(accounting.handle.fail).not.toHaveBeenCalled();
    expect(accounting.handle.succeed).toHaveBeenCalledTimes(2);
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
      // Every CLI run disables auto-memory, warm or not.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
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
