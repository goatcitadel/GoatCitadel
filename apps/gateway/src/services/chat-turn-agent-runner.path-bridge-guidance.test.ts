import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner path-bridge block messaging", () => {
  it("explains an outside_jail shell block instead of suggesting a narrower input or URL", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("shell.exec", { command: "Remove-Item -Recurse temp", cwd: "C:\\Users\\example" }),
      )
      .mockResolvedValueOnce(finalCompletion("The cleanup was blocked, so no files were deleted."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "blocked",
      policyReason: "blocked: workspace path was not freshly verified for execution",
      auditEventId: "audit-path-bridge-outside-jail",
      result: { workspacePathBridge: { status: "blocked", reasonCode: "outside_jail", snapshotId: "snap-1" } },
    });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["shell.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await runner.run({
      sessionId: "sess-path-bridge",
      turnId: randomUUID(),
      userMessageId: "sess-path-bridge-message",
      content: "Delete the temp files in my user folder.",
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Delete the temp files in my user folder." }],
    });

    const blockedRun = result.turnTrace.toolRuns.find((run) => run.toolName === "shell.exec");
    expect(blockedRun?.status).toBe("blocked");
    expect(blockedRun?.failureGuidance).toContain("outside the workspace folders");
    expect(blockedRun?.failureGuidance).toMatch(/not a pending approval/i);

    const secondRequest = createChatCompletion.mock.calls[1]?.[0] as
      | { messages?: Array<{ role?: string; content?: string }> }
      | undefined;
    const toolMessage = secondRequest?.messages?.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("outside the workspace folders");
    expect(toolMessage?.content).not.toContain("narrower, more explicit input");

    expect(result.assistantContent).toContain("no files were deleted");
    expect(result.assistantContent).not.toMatch(/specific URL|narrower query|narrower, more explicit input/);
  });
});

function finalCompletion(content: string): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}
