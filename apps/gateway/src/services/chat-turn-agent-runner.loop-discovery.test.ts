import { randomUUID } from "node:crypto";
import type { ChatCompletionResponse, ChatToolRunRecord, ToolInvokeResult } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const repositoryPath = "F:\\code\\personal-ai";
const sourcePath = `${repositoryPath}\\apps\\mission-control-next\\src\\main.tsx`;

function createResumedRunner(calls: Array<{ toolName: string; path: string }>) {
  const storage = createMockStorage() as ChatTurnAgentRunnerDeps["storage"];
  const turnId = randomUUID();
  const sessionId = "sess-discovery-resume";
  calls.forEach((call, index) => {
    const startedAt = new Date(index * 1000).toISOString();
    storage.chatToolRuns.create({
      toolRunId: randomUUID(),
      turnId,
      sessionId,
      toolName: call.toolName,
      args: { path: call.path },
      status: "executed",
      approvalId: `approved-source-read-${index}`,
      result: { inspected: call.path },
      startedAt,
      finishedAt: startedAt,
    } satisfies ChatToolRunRecord);
  });
  const createChatCompletion = vi
    .fn<() => Promise<ChatCompletionResponse>>()
    .mockResolvedValueOnce(namedToolCallCompletion("fs.read", { path: sourcePath }))
    .mockResolvedValueOnce({
      model: "test-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "Source inspected; browser behavior is unverified." } },
      ],
    });
  const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
    outcome: "executed",
    policyReason: "approved one-time read",
    auditEventId: "audit-next-source-read",
    result: { path: sourcePath, content: "createRoot(root).render(<MissionControlNextApp />);" },
  });
  const listTool = createToolCatalog(["fs.list"])[0]!;
  const runner = new ChatTurnAgentRunner({
    storage,
    listToolCatalog: () => [listTool, { ...listTool, toolName: "fs.read", description: "Read a source file" }],
    createChatCompletion,
    invokeTool,
  });
  const content = `Perform a read-only UI/UX audit of GoatCitadel in ${repositoryPath}. Inspect current source.`;
  return {
    runner,
    invokeTool,
    createChatCompletion,
    input: {
      sessionId,
      turnId,
      userMessageId: "msg-source-audit",
      content,
      mode: "chat" as const,
      providerId: "test-provider",
      model: "test-model",
      webMode: "off" as const,
      memoryMode: "off" as const,
      thinkingLevel: "standard" as const,
      toolAutonomy: "safe_auto" as const,
      historyMessages: [{ role: "user" as const, content }],
    },
  };
}

describe("ChatTurnAgentRunner resumed discovery loop guard", () => {
  it("continues the live audit's persisted directory/read sequence into source inspection and synthesis", async () => {
    const { runner, input, invokeTool, createChatCompletion } = createResumedRunner([
      { toolName: "fs.list", path: repositoryPath },
      { toolName: "fs.read", path: `${repositoryPath}\\AGENTS.md` },
      { toolName: "fs.list", path: `${repositoryPath}\\apps` },
      { toolName: "fs.list", path: `${repositoryPath}\\apps\\mission-control-next` },
      { toolName: "fs.read", path: `${repositoryPath}\\apps\\mission-control-next\\AGENTS.md` },
      { toolName: "fs.list", path: `${repositoryPath}\\apps\\mission-control-next\\src` },
    ]);

    const result = await runner.run(input);

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "fs.read", args: { path: sourcePath } }),
    );
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toBe("Source inspected; browser behavior is unverified.");
    expect(result.turnTrace.toolRuns).toHaveLength(7);
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.turnTrace.loopGuard?.events).toEqual([]);
  });
});
