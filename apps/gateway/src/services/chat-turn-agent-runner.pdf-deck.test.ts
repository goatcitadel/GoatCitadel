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

  it("steers the deck to presentations.create as a PDF and delivers it as a PDF slide deck", async () => {
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/fun-things-tonight-91303.pdf",
          format: "pdf",
          title: "Fun Things To Do Tonight Near 91303",
          slides: [
            {
              title: "Evening Plans Around 91303",
              bullets: [
                "Westfield Topanga in Canoga Park offers dining and entertainment until 7 PM tonight.",
                "The Village at Topanga adds outdoor dining and an easy evening walk.",
              ],
            },
            {
              title: "Late Fun Tonight",
              bullets: ["Catch a late movie or go bowling after dinner.", "Check showtimes before heading out."],
            },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return completion("Your deck of fun things to do tonight near 91303 is ready as a PDF.");
      });
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {
          path: `${WORKSPACE_ROOT}/goatcitadel_out/fun-things-tonight-91303.pdf`,
          bytesWritten: 9_216,
          format: "pdf",
          mimeType: "application/pdf",
          title: request.args.title,
          slideCount: 3,
        },
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

    expect(
      providerRequests[0]?.messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes('presentations.create using format "pdf"'),
      ),
    ).toBe(true);
    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual(["presentations.create"]);
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({ format: "pdf" });
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain(
      "[Download the PDF slide deck](/api/v1/files/download?relativePath=goatcitadel_out%2Ffun-things-tonight-91303.pdf)",
    );
    expect(result.assistantContent).not.toContain("PowerPoint");
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
