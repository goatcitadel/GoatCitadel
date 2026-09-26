import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatToolRunRecord } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";
import { applyCodingToolReceipts, buildCodingCheckpoint, chargeCodingActiveTime } from "./chat-sustained-coding-state.js";

const toolNames = ["fs.list", "fs.stat", "code.search_files", "code.search", "file.read_range", "fs.read", "fs.write", "fs.patch", "shell.exec", "tests.run", "lint.run", "browser.search", "documents.create"];
const input = {
  sessionId: "session-1", turnId: "turn-1", userMessageId: "user-1",
  content: "Build and test a PowerShell project with LogAnalyzer.psm1; write report.json as output.",
  mode: "chat" as const, providerId: "llamacpp", model: "local-model", webMode: "off" as const,
  memoryMode: "off" as const, retrievalMode: "standard" as const, thinkingLevel: "standard" as const,
  toolAutonomy: "safe_auto" as const, historyMessages: [], policyRunId: "run-1",
  executionProfile: "sustained_local_coding" as const,
};

describe("sustained coding compact tool catalog", () => {
  it("refuses to run an admitted coding profile without a durable binding", async () => {
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });
    const preflight = await runner.resolveCapabilityToolSchema({ ...input, policyRunId: undefined });
    expect(preflight.tools).toEqual([]);
    await expect(runner.run({ ...input, policyRunId: undefined })).rejects.toThrow(/durable run binding/iu);
  });

  it("pins coding tools while respecting current denial and Web Off", async () => {
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createDefaultToolRegistry().toCatalog().filter((tool) => toolNames.includes(tool.toolName)),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
      evaluateToolAccess: vi.fn(({ toolName }: { toolName: string }) => ({
        allowed: toolName !== "fs.patch", requiresApproval: toolName === "fs.write", reasonCodes: [],
      })),
    });
    const schema = await runner.resolveCapabilityToolSchema(input);
    expect([...schema.canonicalToModel.keys()]).toEqual([
      "fs.list", "fs.stat", "code.search_files", "code.search", "file.read_range", "fs.read", "fs.write", "shell.exec", "tests.run", "lint.run",
    ]);
    expect(schema.canonicalToModel.has("fs.patch")).toBe(false);
    expect(schema.canonicalToModel.has("browser.search")).toBe(false);
    expect(schema.canonicalToModel.has("documents.create")).toBe(false);
    expect(schema.policyDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "fs.patch", allowed: false }),
      expect.objectContaining({ toolName: "fs.write", allowed: true, requiresApproval: true }),
    ]));
    const webAllowed = await runner.resolveCapabilityToolSchema({
      ...input,
      content: "Build a local project and search the web for official documentation.",
      webMode: "auto",
    });
    expect(webAllowed.canonicalToModel.has("browser.search")).toBe(true);
  });

  it("keeps asking for missing evidence and ends partial after two idle windows", async () => {
    const checkpoints: Array<{ state: Record<string, unknown>; createdAt: string }> = [];
    const storage = createMockStorage() as Record<string, unknown>;
    storage.durableRuns = {
      getLatestCheckpointByKind: vi.fn(async () => checkpoints.at(-1)),
      createCheckpoint: vi.fn(async (checkpoint: { state: Record<string, unknown>; createdAt: string }) => {
        checkpoints.push(checkpoint);
        return { ...checkpoint, checkpointId: `checkpoint-${checkpoints.length}` };
      }),
    };
    const createChatCompletion = vi.fn(async () => ({
      model: "local-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "All tests passed." } }],
    }));
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const result = await runner.run({
      ...input,
      content: "Build Example.ps1 and run tests.ps1.",
      historyMessages: [{ role: "user", content: "Build Example.ps1 and run tests.ps1." }],
    });
    expect(createChatCompletion.mock.calls.length).toBeGreaterThan(1);
    expect(result.turnTrace.status).toBe("partial");
    expect(result.assistantContent).not.toContain("All tests passed.");
    expect(checkpoints.at(-1)?.state).toMatchObject({ windowIndex: 2, noProgressWindows: 2 });
  });

  it("completes only after a test and fresh file receipts follow the writes", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    const checkpoints: Array<{ state: Record<string, unknown>; createdAt: string }> = [];
    storage.durableRuns = {
      getLatestCheckpointByKind: vi.fn(async () => checkpoints.at(-1)),
      createCheckpoint: vi.fn(async (checkpoint: { state: Record<string, unknown>; createdAt: string }) => {
        checkpoints.push(checkpoint);
        return { ...checkpoint, checkpointId: `checkpoint-${checkpoints.length}` };
      }),
    };
    const calls = [
      ["fs.write", { path: "C:\\work\\Example.ps1", content: "Write-Host 'example'" }],
      ["fs.write", { path: "C:\\work\\tests.ps1", content: "Write-Host 'test'" }],
      ["tests.run", { command: "powershell.exe -File tests.ps1" }],
      ["fs.stat", { path: "C:\\work\\Example.ps1" }],
      ["fs.stat", { path: "C:\\work\\tests.ps1" }],
    ] as const;
    let modelCall = 0;
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createDefaultToolRegistry().toCatalog().filter((tool) => toolNames.includes(tool.toolName)),
      evaluateToolAccess: vi.fn(async ({ toolName }: { toolName: string }) => ({
        toolName, allowed: true, requiresApproval: false, reasonCodes: [],
      })),
      createChatCompletion: vi.fn(async () => {
        const next = calls[modelCall++];
        return next
          ? { model: "local-model", choices: [{ index: 0, finish_reason: "tool_calls", message: {
              role: "assistant", content: null, tool_calls: [{ id: `call-${modelCall}`, type: "function", function: {
                name: next[0], arguments: JSON.stringify(next[1]),
              } }],
            } }] }
          : { model: "local-model", choices: [{ index: 0, finish_reason: "stop", message: {
              role: "assistant", content: "27/27 tests passed. Files remain present.",
            } }] };
      }),
      invokeTool: vi.fn(async (request: { toolName: string; args: Record<string, unknown> }) => ({
        outcome: "executed" as const,
        result: request.toolName === "tests.run"
          ? { exitCode: 0, stdout: "27/27 tests passed" }
          : request.toolName === "fs.stat"
            ? { path: request.args.path, isFile: true }
            : { path: request.args.path },
      })),
    });
    const result = await runner.run({
      ...input,
      content: "Build Example.ps1 and run tests.ps1.",
      historyMessages: [{ role: "user", content: "Build Example.ps1 and run tests.ps1." }],
    });
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.routing.codingRun?.latestTest?.passed).toBe(true);
    expect(checkpoints.at(-1)?.state).toMatchObject({ toolRunCursor: 5 });
  });

  it("allows final synthesis at exactly 120 settled tool calls without exposing another tool", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    const checkpoints: Array<{ state: Record<string, unknown>; createdAt: string }> = [];
    storage.durableRuns = {
      getLatestCheckpointByKind: vi.fn(async () => checkpoints.at(-1)),
      createCheckpoint: vi.fn(async (checkpoint: { state: Record<string, unknown>; createdAt: string }) => {
        checkpoints.push(checkpoint);
        return { ...checkpoint, checkpointId: `checkpoint-${checkpoints.length}` };
      }),
    };
    const toolStore = (storage as { chatToolRuns: { create: (run: ChatToolRunRecord) => unknown } }).chatToolRuns;
    const receipts: Array<Pick<ChatToolRunRecord, "toolName" | "args" | "result">> = [
      ...Array.from({ length: 115 }, (_, index) => ({ toolName: "fs.stat", args: { path: `C:\\work\\prior-${index}.txt` }, result: { path: `C:\\work\\prior-${index}.txt`, isFile: true } })),
      { toolName: "fs.write", args: { path: "C:\\work\\Example.ps1", content: "example" }, result: { path: "C:\\work\\Example.ps1" } },
      { toolName: "fs.write", args: { path: "C:\\work\\tests.ps1", content: "test" }, result: { path: "C:\\work\\tests.ps1" } },
      { toolName: "tests.run", args: { command: "powershell.exe -File tests.ps1" }, result: { exitCode: 0, stdout: "27/27 tests passed" } },
      { toolName: "fs.stat", args: { path: "C:\\work\\Example.ps1" }, result: { path: "C:\\work\\Example.ps1", isFile: true } },
      { toolName: "fs.stat", args: { path: "C:\\work\\tests.ps1" }, result: { path: "C:\\work\\tests.ps1", isFile: true } },
    ];
    receipts.forEach((receipt, index) => toolStore.create({
      ...receipt, toolRunId: `run-${index}`, turnId: input.turnId, sessionId: input.sessionId,
      status: "executed", startedAt: "2026-09-25T00:00:00Z",
    } as ChatToolRunRecord));
    const completionRequests: ChatCompletionRequest[] = [];
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createDefaultToolRegistry().toCatalog().filter((tool) => toolNames.includes(tool.toolName)),
      createChatCompletion: vi.fn(async (request: ChatCompletionRequest) => {
        completionRequests.push(request);
        return { model: "local-model", choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant", content: "27/27 tests passed. Files remain present.",
        } }] };
      }),
      invokeTool: vi.fn(),
    });
    const result = await runner.run({
      ...input,
      content: "Build Example.ps1 and run tests.ps1.",
      historyMessages: [{ role: "user", content: "Build Example.ps1 and run tests.ps1." }],
    });
    expect(result.turnTrace.status).toBe("completed");
    expect(completionRequests).toHaveLength(1);
    expect(completionRequests[0]?.tools).toBeUndefined();
    expect(result.turnTrace.routing.codingRun?.toolRunsUsed).toBe(120);
  });

  it("counts a started read against the durable 120-call ceiling after restart", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    const checkpoints: Array<{ state: Record<string, unknown>; createdAt: string }> = [];
    storage.durableRuns = {
      getLatestCheckpointByKind: vi.fn(async () => checkpoints.at(-1)),
      createCheckpoint: vi.fn(async (checkpoint: { state: Record<string, unknown>; createdAt: string }) => {
        checkpoints.push(checkpoint);
        return { ...checkpoint, checkpointId: `checkpoint-${checkpoints.length}` };
      }),
    };
    const toolStore = (storage as { chatToolRuns: { create: (run: ChatToolRunRecord) => unknown } }).chatToolRuns;
    for (let index = 0; index < 120; index += 1) {
      toolStore.create({
        toolRunId: `run-${index}`, turnId: input.turnId, sessionId: input.sessionId,
        toolName: "fs.stat", args: { path: `C:\\work\\prior-${index}.txt` },
        ...(index < 119 ? { result: { path: `C:\\work\\prior-${index}.txt`, isFile: true } } : {}),
        status: index < 119 ? "executed" : "started", effectPotential: "none",
        startedAt: "2026-09-25T00:00:00Z",
      } as ChatToolRunRecord);
    }
    const createChatCompletion = vi.fn();
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const request = "Build Example.ps1 and run tests.ps1.";
    const result = await runner.run({ ...input, content: request,
      historyMessages: [{ role: "user", content: request }] });
    expect(result.turnTrace.status).toBe("partial");
    expect(result.turnTrace.routing.codingRun?.toolRunsUsed).toBe(120);
    expect(checkpoints.at(-1)?.state.toolCallsConsumed).toBe(120);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("resumes from the saved coding checkpoint and settled read receipt", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    const request = "Debug the project.";
    const receipt: ChatToolRunRecord = {
      toolRunId: "read-1", turnId: input.turnId, sessionId: input.sessionId,
      toolName: "fs.read", args: { path: "C:\\work\\module.ps1" },
      result: { path: "C:\\work\\module.ps1", sha256: "observed-hash", content: "source" },
      status: "executed", startedAt: "2026-09-25T00:00:00Z",
    };
    (storage as { chatToolRuns: { create: (run: ChatToolRunRecord) => unknown } }).chatToolRuns.create(receipt);
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    const initial = buildCodingCheckpoint({ turnId: input.turnId, userMessageId: input.userMessageId,
      request, webOff: true, now: tenMinutesAgo });
    const recovered = applyCodingToolReceipts(chargeCodingActiveTime(initial), [receipt]);
    const checkpoints: Array<{ state: Record<string, unknown>; createdAt: string }> = [
      { state: recovered as unknown as Record<string, unknown>, createdAt: new Date().toISOString() },
    ];
    storage.durableRuns = {
      getLatestCheckpointByKind: vi.fn(async () => ({ ...checkpoints.at(-1), checkpointId: "saved-coding" })),
      createCheckpoint: vi.fn(async (checkpoint: { state: Record<string, unknown>; createdAt: string }) => {
        checkpoints.push(checkpoint);
        return { ...checkpoint, checkpointId: `checkpoint-${checkpoints.length}` };
      }),
    };
    const completionRequests: ChatCompletionRequest[] = [];
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion: vi.fn(async (completionRequest: ChatCompletionRequest) => {
        completionRequests.push(completionRequest);
        return { model: "local-model", choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant", content: "Inspected the source; no change was needed.",
        } }] };
      }),
      invokeTool: vi.fn(),
    });
    const result = await runner.run({ ...input, content: request,
      historyMessages: [{ role: "user", content: request }] });
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.routing.codingRun?.activeUsedMs).toBeGreaterThanOrEqual(600_000);
    expect(completionRequests[0]?.messages.some((message) =>
      message.role === "system" && typeof message.content === "string" &&
      message.content.includes("Resume the original coding request from durable checkpoint saved-coding"))).toBe(true);
  });
});
