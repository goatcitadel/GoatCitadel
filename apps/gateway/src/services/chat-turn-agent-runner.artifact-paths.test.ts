import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
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

// #505: the answer printed the absolute local path (with the OS user profile) and paraphrased the
// design report's receipt warning, because the model saw both in the raw tool result.
const PROMPT = 'Create a one-page PDF titled "Sandbox Test Brief" with two short sections.';
const WORKSPACE_ROOT = path.join(os.tmpdir(), "goatcitadel-505-runner", "workspace");
const PDF_PATH = path.join(WORKSPACE_ROOT, "artifacts", "Sandbox_Test_Brief.pdf");
const RECEIPT_WARNING =
  "Renderer design defaults ran, but no governed runtime design-instruction receipt was attached.";

describe("ChatTurnAgentRunner artifact answers (#505)", () => {
  it("feeds the model a workspace-relative path and plain caveats, and keeps the local path out of the answer", async () => {
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("documents.create", {
          path: "artifacts/Sandbox_Test_Brief.pdf",
          format: "pdf",
          title: "Sandbox Test Brief",
          sections: [
            { heading: "Purpose", body: "A short brief for the sandbox." },
            { heading: "Next steps", body: "Review and share." },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return completion(`Created the brief. The full path is ${PDF_PATH}.`);
      });
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {
          path: PDF_PATH,
          bytesWritten: 4_096,
          format: "pdf",
          mimeType: "application/pdf",
          title: "Sandbox Test Brief",
          designReport: {
            preset: "clean-professional",
            validation: [{ id: "design-skill-applied", status: "warning", detail: RECEIPT_WARNING }],
            localPath: PDF_PATH,
            google: { requested: false, status: "not_requested", mode: "convert" },
            residualRisks: ["PDF reports use standard Helvetica text; custom fonts are not embedded."],
            designQuality: { status: "warning", runtimeInstructions: { status: "not_injected", skills: [] } },
          },
        },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool,
      workspaceFileRootDir: WORKSPACE_ROOT,
    });

    const result = await orchestrator.run(turnInput(PROMPT));

    const toolMessage = providerRequests[1]?.messages.find((message) => message.role === "tool");
    const toolContent = typeof toolMessage?.content === "string" ? toolMessage.content : "";
    expect(toolContent).toContain('"path":"artifacts/Sandbox_Test_Brief.pdf"');
    expect(toolContent).not.toContain(path.basename(path.dirname(WORKSPACE_ROOT)));
    expect(toolContent).not.toMatch(/receipt|governed/iu);
    expect(toolContent).toContain("custom fonts are not embedded");

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("The full path is artifacts/Sandbox_Test_Brief.pdf.");
    expect(result.assistantContent).not.toContain(WORKSPACE_ROOT);
    expect(result.assistantContent).toContain("/api/v1/files/download?relativePath=artifacts%2FSandbox_Test_Brief.pdf");
    // The stored run keeps the absolute path for the trace and the download receipt.
    expect(result.turnTrace.toolRuns[0]?.result?.path).toBe(PDF_PATH);
  });
});

function turnInput(content: string): ChatTurnAgentRunnerInput {
  return {
    sessionId: "sess-artifact-paths",
    turnId: randomUUID(),
    userMessageId: "msg-artifact-paths",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
  };
}

function completion(content: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}
