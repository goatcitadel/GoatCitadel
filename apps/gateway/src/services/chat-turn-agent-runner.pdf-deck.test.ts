import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

// The 2026-10-04 chat that "broke": the user asked for a deck-style PDF, the
// model wrote a real PDF, and the PowerPoint-only guard replaced the answer
// with "No downloadable PowerPoint was produced" next to a working link.
const PDF_DECK_PROMPT =
  "find me fun things to do around my area, 91303, tonight, and put it into a powerpoint deck style but saved as a pdf";
const WORKSPACE_ROOT = "/goatcitadel-workspace";

describe("ChatTurnAgentRunner deck-style PDF requests", () => {
  it("accepts a verified documents.create PDF when the user asked for the deck as a PDF", async () => {
    const pdfPath = `${WORKSPACE_ROOT}/goatcitadel_out/canoga-park-tonight.pdf`;
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("documents.create", {
          path: "./workspace/goatcitadel_out/canoga-park-tonight.pdf",
          format: "pdf",
          title: "Canoga Park Tonight",
          sections: [{ heading: "Evening picks", bullets: ["Westfield Topanga is open until 7 PM on Sunday."] }],
        }),
      )
      .mockResolvedValueOnce(completion("Here are tonight's picks near 91303, saved as a PDF."));
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { path: pdfPath, bytesWritten: 4_096, format: "pdf", title: request.args.title },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create", "documents.create"]),
      createChatCompletion,
      invokeTool,
      workspaceFileRootDir: WORKSPACE_ROOT,
    });

    const result = await orchestrator.run(turnInput({ content: PDF_DECK_PROMPT }));

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual(["documents.create"]);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("Here are tonight's picks near 91303");
    expect(result.assistantContent).not.toContain("No downloadable PowerPoint");
    expect(result.assistantContent).toContain(
      "/api/v1/files/download?relativePath=goatcitadel_out%2Fcanoga-park-tonight.pdf",
    );
  });

  it("names the PDF deck, not a PowerPoint, when nothing was created", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(completion("I could not build the deck right now."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
      workspaceFileRootDir: WORKSPACE_ROOT,
    });

    const result = await orchestrator.run(turnInput({ content: PDF_DECK_PROMPT }));

    expect(result.turnTrace.status).toBe("failed");
    expect(result.assistantContent).toContain("No downloadable PDF slide deck was produced.");
    expect(result.assistantContent).not.toContain("PowerPoint");
  });
});

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Answer directly.";
  return {
    sessionId: "sess-pdf-deck",
    turnId: randomUUID(),
    userMessageId: "msg-pdf-deck",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}

function completion(content: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}
