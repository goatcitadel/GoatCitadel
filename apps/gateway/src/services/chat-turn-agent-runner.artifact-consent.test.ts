import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest } from "@goatcitadel/contracts";
import {
  EffectAwareChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { updateChatTurnControl } from "./chat-turn-control.js";

const answer =
  "Example Domain is reserved for documentation examples. Authors can use it without relying on a privately owned site. ".repeat(
    2,
  );
const body = "# Example Domain\n\n" + answer;
function harness(
  responses: ChatCompletionResponse["choices"][number]["message"][] = [{ role: "assistant", content: answer }],
) {
  const storage = createMockStorage() as never;
  const invokeTool = vi.fn(async (request: ToolInvokeRequest) => ({
    outcome: "executed" as const,
    policyReason: "allowed",
    auditEventId: "audit-artifact",
    result: { path: request.args.path, bytesWritten: 100, format: "pdf" },
  }));
  let index = 0;
  const createChatCompletion = vi.fn(
    async (): Promise<ChatCompletionResponse> => ({
      model: "test-model",
      choices: [{ index: 0, message: responses[Math.min(index++, responses.length - 1)]! }],
    }),
  );
  const runner = new EffectAwareChatTurnAgentRunner({
    storage,
    listToolCatalog: () => createToolCatalog(["documents.create", "presentations.create"]),
    invokeTool,
    createChatCompletion,
  });
  const input = (content: string) => ({
    sessionId: "artifact-session",
    turnId: "artifact-turn",
    userMessageId: "artifact-user",
    content,
    mode: "chat" as const,
    providerId: "test-provider",
    model: "test-model",
    webMode: "off" as const,
    memoryMode: "off" as const,
    thinkingLevel: "standard" as const,
    toolAutonomy: "safe_auto" as const,
    historyMessages: [
      { role: "assistant" as const, content: "UNRELATED DESK TIPS ".repeat(30) },
      { role: "user" as const, content },
    ],
  });
  return { storage, invokeTool, createChatCompletion, runner, input };
}

describe("model-authored artifacts and durable consent", () => {
  it.each([
    "Write a short report directly in this chat.",
    "Write a Markdown table comparing three colors.",
    "Write a JSON example in your answer.",
    "Write a Markdown summary of existing report.pdf.",
    "Create a table using existing notes.docx.",
    "Report the page title and explain its purpose. Do not use subagents, change files, or write long-term memory.",
  ])("does not request artifact tools for prose: %s", async (content) => {
    const h = harness();
    await h.runner.run(h.input(content));
    expect(h.invokeTool).not.toHaveBeenCalled();
    expect(h.createChatCompletion).toHaveBeenCalledTimes(1);
  });
  it("gives a file request exactly one retry and never synthesizes a write or success", async () => {
    const h = harness([{ role: "assistant", content: "I created your PDF at /fake.pdf." }]);
    const result = await h.runner.run(h.input("Create a PDF report about Example Domain."));
    expect(h.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(h.invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("file was not created");
    expect(result.assistantContent).not.toContain("fake.pdf");
  });
  it.each(["pdf", "docx"])("executes only the model-authored structured %s call on the one retry", async (format) => {
    const h = harness([
      { role: "assistant", content: answer },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "artifact-call",
            type: "function",
            function: {
              name: "documents_create",
              arguments: JSON.stringify({
                path: `./workspace/goatcitadel_out/example.${format}`,
                format,
                title: "Example Domain",
                body,
              }),
            },
          },
        ],
      },
      { role: "assistant", content: "The requested PDF was created." },
    ]);
    const result = await h.runner.run(h.input(`Create a ${format.toUpperCase()} report about Example Domain.`));
    expect(h.invokeTool).toHaveBeenCalledTimes(1);
    expect(h.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "documents.create", args: expect.objectContaining({ body }) }),
    );
    expect(JSON.stringify(h.invokeTool.mock.calls)).not.toContain("UNRELATED");
    expect(result.turnTrace.toolRuns.some((run) => run.status === "executed")).toBe(true);
  });
  it("does not reset the retry marker when the same turn is re-entered", async () => {
    const h = harness();
    const input = h.input("Create a DOCX report about Example Domain.");
    await h.runner.run(input);
    expect(h.createChatCompletion).toHaveBeenCalledTimes(2);
    await h.runner.run(input);
    expect(h.createChatCompletion).toHaveBeenCalledTimes(3);
  });
  it("finalizes a denied turn without another provider call, tool, or approval", async () => {
    const h = harness();
    const input = h.input("Create a PDF report about Example Domain.");
    await h.runner.run(input);
    await updateChatTurnControl(h.storage, input.sessionId, input.turnId, (state) => ({
      ...state,
      toolClosure: {
        outcome: "denied",
        approvalId: "denied-approval",
        actorId: "operator",
        closedAt: new Date().toISOString(),
      },
    }));
    h.createChatCompletion.mockClear();
    h.invokeTool.mockClear();
    const result = await h.runner.run(input);
    expect(result.assistantContent).toContain("You denied the action");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.routing?.turnControl?.toolClosure).toMatchObject({ outcome: "denied" });
    expect(h.invokeTool).not.toHaveBeenCalled();
    expect(h.createChatCompletion).not.toHaveBeenCalled();
  });
  it("fences a tool call returned by a retry after denial committed", async () => {
    const h = harness();
    const input = h.input("Create a PDF report about Example Domain.");
    h.createChatCompletion.mockImplementationOnce(async () => ({
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: answer } }],
    }));
    h.createChatCompletion.mockImplementationOnce(async () => {
      await updateChatTurnControl(h.storage, input.sessionId, input.turnId, (state) => ({
        ...state,
        toolClosure: { outcome: "denied", actorId: "operator", closedAt: new Date().toISOString() },
      }));
      return {
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "late-artifact",
                  type: "function",
                  function: {
                    name: "documents_create",
                    arguments: JSON.stringify({ path: "late.pdf", format: "pdf", body }),
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const result = await h.runner.run(input);
    expect(h.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(h.invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("You denied");
  });
  it("does not report creation when the artifact tool failed", async () => {
    const h = harness([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "failed-file",
            type: "function",
            function: {
              name: "documents_create",
              arguments: JSON.stringify({ path: "failed.pdf", format: "pdf", body }),
            },
          },
        ],
      },
      { role: "assistant", content: "Your PDF is ready." },
    ]);
    h.invokeTool.mockResolvedValue({
      outcome: "blocked",
      policyReason: "Creation failed",
      auditEventId: "failed",
    } as never);
    const result = await h.runner.run(h.input("Create a PDF report about Example Domain."));
    expect(result.assistantContent).toContain("file was not created");
    expect(result.assistantContent).not.toContain("is ready");
  });
});
