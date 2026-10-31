import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatOptionalUserInputReplyRecord,
  ChatStreamChunkDraft,
  ChatToolRunRecord,
  LlmConfigFile,
  ModelUsageAttributionContext,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_CLAUDE_CLI_NODE_PATH,
  FAKE_CLAUDE_CLI_STUB_PATH,
  bridgedInit,
  createFakeClaudeCliHarness,
  createFakeModelUsageAccounting,
  fakeWarmCallUsage,
  line,
  manifestToolNames,
  streamEvent,
  textStepScript,
  toolStepScript,
  warmToolStepScript,
  type FakeClaudeCliCall,
  type FakeClaudeCliHarness,
  type FakeClaudeCliScript,
} from "../test/claude-code-cli-fake-spawn.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { buildPersistedToolContinuationCallId } from "./chat-tool-result-projection.js";
import { claudeCodeCliProviderAdapter } from "./llm-provider-claude-code-cli.js";
import { LlmService } from "./llm-service.js";

/**
 * Warm continuation end to end: the real runner and LlmService drive a fake `claude -p`
 * that parks after each tool step. The runner still executes every call itself; only the
 * process that receives the results changes, so the turn's evidence must not.
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

const statusCall = (id: string, probe: number): FakeClaudeCliCall => ({
  id,
  name: "session_status",
  input: { probe },
});
const firstA = statusCall("toolu_status_a", 1);
const firstB = statusCall("toolu_status_b", 2);
const second = statusCall("toolu_status_c", 3);
const FINAL_TEXT = "session.status stayed healthy across all three probes.";

const executedStatus = async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
  outcome: "executed",
  policyReason: "allowed",
  auditEventId: `audit-status-${String(request.args.probe)}`,
  result: { status: "healthy", probe: request.args.probe },
});

/**
 * The cold twin of the warm text segment: the same stream lines and per-call usage, from a fresh
 * process. Its only model call is `callIndex`, so its result usage is that call's alone.
 */
function coldTextStepScript(text: string, callIndex: number): FakeClaudeCliScript {
  const usage = fakeWarmCallUsage(callIndex);
  return ({ stdout, exit }, spawned) => {
    // A bridged step: the init must list the step's bridged tools, as the real CLI's does.
    stdout.write(bridgedInit(manifestToolNames(spawned) ?? []));
    stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: usage.input_tokens } } }));
    stdout.write(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    stdout.write(streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }));
    stdout.write(streamEvent({ type: "message_stop" }));
    stdout.write(line({ type: "result", subtype: "success", is_error: false, usage }));
    exit(0);
  };
}

/** The runtime's parked-process count; the registry is private to LlmService. */
function parkedCount(service: LlmService): number {
  return (service as unknown as { claudeCodeCli: { warm: { size: number } } }).claudeCodeCli.warm.size;
}

describe("ChatTurnAgentRunner with warm Claude Code CLI continuation", () => {
  let scratchRoot: string;
  let configRoot: string;
  let services: LlmService[];

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-runner-cli-warm-test-"));
    // The spill check reads <CLAUDE_CONFIG_DIR>/projects; keep it off the operator's real profile.
    configRoot = mkdtempSync(path.join(os.tmpdir(), "gc-runner-cli-warm-config-"));
    services = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(services.map((service) => service.close()));
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  function createService(harness: FakeClaudeCliHarness, warm: boolean): LlmService {
    const service = new LlmService(
      config,
      { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op", CLAUDE_CONFIG_DIR: configRoot },
      {
        secretStore: createNoopSecretStore(),
        enforceNetworkAllowlist: false,
        modelUsageAccounting: createFakeModelUsageAccounting().service,
        claudeCliToolBridgeEnabled: () => true,
        claudeCliWarmContinuationEnabled: () => warm,
        claudeCli: {
          spawn: harness.spawn,
          killTree: harness.killTree,
          readiness: harness.readiness,
          resolveInvocation: () => ({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] }),
          scratchRoot,
          toolBridge: { stubPath: () => FAKE_CLAUDE_CLI_STUB_PATH, nodePath: FAKE_CLAUDE_CLI_NODE_PATH },
        },
      },
    );
    services.push(service);
    return service;
  }

  function createRunner(
    service: LlmService,
    input: {
      invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
      storage?: ReturnType<typeof createMockStorage>;
      replies?: ChatOptionalUserInputReplyRecord[];
    },
  ) {
    const storage = input.storage ?? createMockStorage();
    const invokeTool = vi.fn(input.invokeTool);
    const decisions: unknown[] = [];
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion: (request, attribution) => service.chatCompletions(request, attribution),
      createChatCompletionStream: async (request, attribution) => service.chatCompletionsStream(request, attribution),
      describeProviderToolSupport: (providerId) => service.describeProviderToolSupport(providerId),
      invokeTool,
      recordRuntimeDecision: async (decision) => {
        decisions.push(decision);
      },
      enqueueRuntimeDecision: (decision) => {
        decisions.push(decision);
        return true;
      },
      ...(input.replies
        ? {
            chatAsyncClarificationV1Enabled: () => true,
            readOptionalUserInput: async () => ({ prompts: [], replies: input.replies ?? [] }),
          }
        : {}),
      workspaceFileRootDir: "/goatcitadel-workspace",
    });
    return { runner, storage, invokeTool, decisions };
  }

  /** The three-step turn, warm or cold: two parallel status probes, one more, then the answer. */
  async function runThreeStepTurn(warm: boolean) {
    const harness = createFakeClaudeCliHarness(
      warm
        ? [warmToolStepScript([firstA, firstB], [{ calls: [second] }, { text: FINAL_TEXT }])]
        : [
            // The warm process's per-call usage, so the turns' usage (and receipts) must match exactly.
            toolStepScript(undefined, [firstA, firstB], { usage: fakeWarmCallUsage(0) }),
            toolStepScript(undefined, [second], { usage: fakeWarmCallUsage(1) }),
            coldTextStepScript(FINAL_TEXT, 2),
          ],
    );
    const service = createService(harness, warm);
    const { runner, storage, invokeTool, decisions } = createRunner(service, { invokeTool: executedStatus });
    const input = turnInput();
    const { chunks, result } = await collectTurn(runner, input);
    return { harness, service, input, chunks, result, storage, invokeTool, decisions };
  }

  it("a three-step turn with two parallel calls resumes warm twice", async () => {
    const warm = await runThreeStepTurn(true);
    const cold = await runThreeStepTurn(false);

    // One process carried all three steps; it ended on its own after the answer.
    expect(warm.harness.spawns).toHaveLength(1);
    expectBridged(warm.harness);
    expect(warm.harness.killTree).not.toHaveBeenCalled();
    expect(parkedCount(warm.service)).toBe(0);
    expect(cold.harness.spawns).toHaveLength(3);
    expect(readdirSync(scratchRoot)).toEqual([]);

    // The runner executed the same calls through its own governed path either way.
    expect(warm.invokeTool.mock.calls.map(([request]) => request.args)).toEqual([
      { probe: 1 },
      { probe: 2 },
      { probe: 3 },
    ]);
    expect(stable(warm.invokeTool.mock.calls)).toEqual(stable(cold.invokeTool.mock.calls));
    const warmRuns = listToolRuns(warm.storage, warm.input.turnId);
    expect(warmRuns.map((run) => run.status)).toEqual(["executed", "executed", "executed"]);
    expect(stable(warmRuns)).toEqual(stable(listToolRuns(cold.storage, cold.input.turnId)));
    expect(warm.decisions.length).toBeGreaterThan(0);
    expect(stable(warm.decisions)).toEqual(stable(cold.decisions));
    const toolEvents = (chunks: ChatStreamChunkDraft[]) =>
      chunks.filter((chunk) => chunk.type === "tool_start" || chunk.type === "tool_result");
    expect(toolEvents(warm.chunks).map((chunk) => chunk.type)).toEqual([
      "tool_start",
      "tool_result",
      "tool_start",
      "tool_result",
      "tool_start",
      "tool_result",
    ]);
    expect(stable(toolEvents(warm.chunks))).toEqual(stable(toolEvents(cold.chunks)));
    // The receipt: the settled turn trace the operator sees, and the answer.
    expect(warm.result.turnTrace.status).toBe("completed");
    expect(warm.result.assistantContent).toContain(FINAL_TEXT);
    expect(stable(warm.result)).toEqual(stable(cold.result));
  });

  it("Chat tool-loop requests reach the adapter with sessionId and turnId", async () => {
    const adapterStream = vi.spyOn(claudeCodeCliProviderAdapter, "chatCompletionsStream");
    const { input, harness } = await runThreeStepTurn(true);

    const attributions = adapterStream.mock.calls.map((call) => call[4] as ModelUsageAttributionContext);
    expect(attributions).toHaveLength(3);
    for (const attribution of attributions) {
      expect(attribution).toMatchObject({ sessionId: input.sessionId, turnId: input.turnId });
    }
    expect(attributions.map((attribution) => attribution.callKind)).toEqual([
      "chat_initial",
      "chat_tool_loop",
      "chat_tool_loop",
    ]);
    expect(harness.spawns).toHaveLength(1);
  });

  it("an approval-required call ends the turn, the parked entry is reaped, and the resumed turn spawns cold", async () => {
    const approvalCall = statusCall("toolu_status_approval", 1);
    const harness = createFakeClaudeCliHarness([
      warmToolStepScript([approvalCall], [{ text: "never continued" }]),
      textStepScript("session.status is healthy after approval."),
    ]);
    const service = createService(harness, true);
    const storage = createMockStorage();
    const first = createRunner(service, {
      storage,
      invokeTool: async () => ({
        outcome: "approval_required",
        policyReason: "session.status needs operator approval",
        auditEventId: "audit-status-approval",
        approvalId: "approval-status-1",
      }),
    });
    const input = turnInput();

    const waiting = await collectTurn(first.runner, input);

    expect(waiting.result.turnTrace.status).toBe("waiting_for_approval");
    expect(waiting.result.requiresApproval).toMatchObject({ approvalId: "approval-status-1" });
    expect(harness.spawns).toHaveLength(1);
    // The turn's stream ends at the approval wait and aborts the turn signal, which reaps the park.
    expect(parkedCount(service)).toBe(0);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
    const [pending] = listToolRuns(storage, input.turnId);
    expect(pending).toMatchObject({ status: "approval_required", approvalId: "approval-status-1" });

    // The approval owner settles the row; durable execution then re-enters the same turn.
    const settled = (storage as unknown as MockToolRunStorage).chatToolRuns.patch(pending!.toolRunId, {
      status: "executed",
      result: { status: "healthy", probe: 1 },
      finishedAt: new Date().toISOString(),
    });
    const resumed = createRunner(service, { storage, invokeTool: executedStatus });

    const result = await resumed.runner.run(input);

    // Nothing was left to continue, so the resumed turn spawns cold with the continuation record.
    expect(harness.spawns).toHaveLength(2);
    expectBridged(harness);
    const continuationId = buildPersistedToolContinuationCallId(settled);
    const resumeStdin = renderedStdin(harness, 1);
    expect(resumeStdin).toContain(`[Assistant tool call ${continuationId}: session_status]`);
    expect(resumeStdin).toContain(`[Tool result ${continuationId}]`);
    expect(resumeStdin).not.toContain("toolu_status_approval");
    expect(resumed.invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("session.status is healthy after approval.");
    expect(parkedCount(service)).toBe(0);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a steering message between steps makes one cold step, and the parked process is killed", async () => {
    const harness = createFakeClaudeCliHarness([
      warmToolStepScript([firstA], [{ text: "never continued" }]),
      textStepScript("Switched to the concise summary."),
    ]);
    const service = createService(harness, true);
    const replies: ChatOptionalUserInputReplyRecord[] = [];
    const { runner } = createRunner(service, {
      replies,
      invokeTool: async (request) => {
        // The operator answers while the tool runs; the runner adds it at the next model boundary.
        replies.push(steeringReply());
        return await executedStatus(request);
      },
    });

    const result = await runner.run(
      turnInput({ policyRunId: "run-cli-warm", canonicalWriteFence: async (work) => await work() }),
    );

    expect(harness.spawns).toHaveLength(2);
    expectBridged(harness);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(harness.killTree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[1] as number,
    );
    const coldStdin = renderedStdin(harness, 1);
    expect(coldStdin).toContain("Prefer a concise summary.");
    expect(coldStdin).toContain("[Tool result toolu_status_a]");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("Switched to the concise summary.");
    expect(parkedCount(service)).toBe(0);
    // The miss reap is fire-and-forget; only its kill is ordered before the cold spawn.
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it("a cancelled turn leaves no parked entry", async () => {
    const controller = new AbortController();
    const harness = createFakeClaudeCliHarness([warmToolStepScript([firstA], [{ text: "never continued" }])]);
    const service = createService(harness, true);
    let parkedBeforeAbort: number | undefined;
    let parkedAfterAbort: number | undefined;
    const { runner, invokeTool } = createRunner(service, {
      invokeTool: async (request) => {
        const executed = await executedStatus(request);
        parkedBeforeAbort = parkedCount(service);
        controller.abort();
        parkedAfterAbort = parkedCount(service);
        return executed;
      },
    });

    const result = await runner.run(turnInput({ signal: controller.signal }));

    expect(parkedBeforeAbort).toBe(1);
    expect(parkedAfterAbort).toBe(0);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(result.turnTrace.status).toBe("cancelled");
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it("a call to a tool the turn no longer offers is answered as unavailable, and the turn ends with the reply", async () => {
    const reply = "Code Mode is not available in this chat, so here is the plan in prose instead.";
    const harness = createFakeClaudeCliHarness([
      unofferedToolStepScript({ id: "toolu_gone", name: "code_mode_request", input: { task: "rerun" } }),
      textStepScript(reply),
    ]);
    const service = createService(harness, true);
    const { runner, invokeTool, storage } = createRunner(service, { invokeTool: executedStatus });
    // After a Gateway restart the history still shows an earlier Code Mode run this turn does not offer.
    const input = turnInput({
      content: "Run that Code Mode task again.",
      historyMessages: [
        { role: "user", content: "Use Code Mode to draft the plan." },
        { role: "assistant", content: "I ran code_mode.request and drafted the plan." },
        { role: "user", content: "Run that Code Mode task again." },
      ],
    });

    const { result } = await collectTurn(runner, input);

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain(reply);
    // Nothing ran: the runner answered the call itself, and the CLI's process was not parked.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(listToolRuns(storage, input.turnId)).toEqual([]);
    expect(harness.spawns).toHaveLength(2);
    expectBridged(harness);
    expect(parkedCount(service)).toBe(0);
    const nextStdin = renderedStdin(harness, 1);
    expect(nextStdin).toContain("[Assistant tool call toolu_gone: code_mode_request]");
    expect(nextStdin).toContain("[Tool result toolu_gone]");
    expect(nextStdin).toContain('"error":"unsupported_tool"');
    expect(nextStdin).toContain("Valid tools for this turn: session.status.");
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });

  it("after an unavailable-tool answer, the model's offered call parks and the next step still resumes warm", async () => {
    const harness = createFakeClaudeCliHarness([
      unofferedToolStepScript({ id: "toolu_gone", name: "code_mode_request", input: { task: "rerun" } }),
      // The recovered step calls an offered tool, parks, and resumes warm with its result.
      warmToolStepScript([firstA], [{ text: FINAL_TEXT }]),
    ]);
    const service = createService(harness, true);
    const { runner, invokeTool, storage } = createRunner(service, { invokeTool: executedStatus });
    const input = turnInput();

    const { result } = await collectTurn(runner, input);

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain(FINAL_TEXT);
    expect(invokeTool.mock.calls.map(([request]) => request.args)).toEqual([{ probe: 1 }]);
    expect(listToolRuns(storage, input.turnId).map((run) => run.status)).toEqual(["executed"]);
    // Two processes for three steps: the first was killed at its stop, the second carried the last two.
    expect(harness.spawns).toHaveLength(2);
    expectBridged(harness);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(parkedCount(service)).toBe(0);
    // The parked step's messages, which the warm match re-hashed, carry the unavailable-tool answer.
    expect(renderedStdin(harness, 1)).toContain("[Tool result toolu_gone]");
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toEqual([]));
  });
});

/**
 * A step whose model calls a tool its manifest does not offer. Like the real CLI, which has no such
 * tool, it answers the call itself with an error before message_stop, then starts its next model call.
 */
function unofferedToolStepScript(call: FakeClaudeCliCall): FakeClaudeCliScript {
  return ({ stdout }, spawned) => {
    const name = `mcp__goatcitadel__${call.name}`;
    stdout.write(bridgedInit(manifestToolNames(spawned) ?? []));
    stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
    stdout.write(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: call.id, name, input: {} },
      }),
    );
    stdout.write(
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: call.id, name, input: call.input }] } }),
    );
    stdout.write(
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`,
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
      }),
    );
    stdout.write(streamEvent({ type: "content_block_stop", index: 0 }));
    stdout.write(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 5, output_tokens: 9 },
      }),
    );
    stdout.write(streamEvent({ type: "message_stop" }));
    stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
  };
}

type MockToolRunStorage = {
  chatToolRuns: {
    listByTurn(turnId: string): ChatToolRunRecord[];
    patch(toolRunId: string, patch: Partial<ChatToolRunRecord>): ChatToolRunRecord;
  };
};

function listToolRuns(storage: unknown, turnId: string): ChatToolRunRecord[] {
  return (storage as MockToolRunStorage).chatToolRuns.listByTurn(turnId);
}

function steeringReply(): ChatOptionalUserInputReplyRecord {
  return {
    prompt: {
      promptId: "optional-steer",
      turnId: "turn-steer",
      kind: "text",
      title: "Style",
      question: "Anything to change?",
      required: false,
      delivery: "background",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    response: { kind: "text", text: "Prefer a concise summary." },
    answeredAt: new Date().toISOString(),
    responder: { actorId: "operator", authActorSource: "token" },
    materialSha256: "a".repeat(64),
  } as ChatOptionalUserInputReplyRecord;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_TIME_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;

/** Per-run identity and timing removed, so two runs of one turn compare by their evidence alone. */
function stable(value: unknown, key = ""): unknown {
  if (typeof value === "string") return value.replace(UUID_PATTERN, "<id>").replace(ISO_TIME_PATTERN, "<time>");
  if (typeof value === "number" && /(?:Ms|At)$/u.test(key)) return "<timing>";
  if (typeof value === "function") return "<fn>";
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([entryKey, entry]) => [entryKey, stable(entry, entryKey)]),
    );
  }
  return value;
}

/** Every step the runner offered tools to is bridged: MCP config in, safe mode out. */
function expectBridged(harness: FakeClaudeCliHarness): void {
  for (const spawned of harness.spawns) {
    expect(spawned.args).toContain("--mcp-config");
    expect(spawned.args).not.toContain("--safe-mode");
  }
}

/** The step's stdin user message, text blocks joined, so assertions read like the CLI's view. */
function renderedStdin(harness: FakeClaudeCliHarness, index: number): string {
  const raw = harness.spawns[index]?.stdin() ?? "";
  const message = JSON.parse(raw) as { message: { content: Array<{ text: string }> } };
  return message.message.content.map((block) => block.text).join("\n\n");
}

async function collectTurn(runner: ChatTurnAgentRunner, input: ChatTurnAgentRunnerInput) {
  const chunks: ChatStreamChunkDraft[] = [];
  for await (const chunk of runner.runStream(input)) chunks.push(chunk);
  const trace = chunks.filter((chunk) => chunk.type === "trace_update").at(-1)?.trace;
  const approval = chunks.find((chunk) => chunk.type === "approval_required")?.approval;
  if (!trace) throw new Error("turn ended without a trace");
  return {
    chunks,
    result: {
      turnTrace: trace,
      assistantContent: chunks.filter((chunk) => chunk.type === "message_done").at(-1)?.content ?? "",
      requiresApproval: approval ? { approvalId: approval.approvalId } : undefined,
    },
  };
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = "Check session.status a few times, then tell me whether it stayed healthy.";
  const base: ChatTurnAgentRunnerInput = {
    sessionId: "sess-cli-warm",
    turnId: randomUUID(),
    userMessageId: "msg-cli-warm",
    content,
    mode: "chat",
    providerId: "claude-code-cli",
    model: "claude-sonnet-5-5",
    // The default budget allows four tool loops, so three steps stay in the tool loop.
    webMode: "auto",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
  };
  return { ...base, ...overrides } as ChatTurnAgentRunnerInput;
}
