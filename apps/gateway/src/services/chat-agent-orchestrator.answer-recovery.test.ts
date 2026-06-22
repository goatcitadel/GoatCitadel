import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

function baseTurn(sessionId: string, content: string): ChatAgentTurnInput {
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `msg-${sessionId}`,
    content,
    mode: "chat",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
  };
}

describe("ChatAgentOrchestrator P0-B answer-recovery ladder", () => {
  it("re-asks once and recovers a real answer when a no-tool turn returns empty, with no degraded footer", async () => {
    const recoveredAnswer = "Photosynthesis converts light, water, and CO2 into glucose and oxygen.";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: recoveredAnswer } }],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(baseTurn("sess-empty-recover-1", "Explain photosynthesis briefly."));

    // The empty first turn was re-asked exactly once and the model produced the answer.
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("Photosynthesis converts light");
    expect(result.turnTrace.status).toBe("completed");
    // Recovered cleanly: degraded sidecar marks recovery and no apology footer is appended.
    expect(result.turnTrace.completion?.degraded).toMatchObject({ recoveredByModel: true });
    expect(result.assistantContent).not.toContain("may be incomplete");
  });

  it("injects the recovery nudge as a tool-less system instruction", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "Here is the answer." } }],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    await orchestrator.run(baseTurn("sess-empty-nudge-1", "What is 2 plus 2?"));

    const secondRequest = createChatCompletion.mock.calls[1]?.[0] as
      | { messages?: Array<{ role?: string; content?: string }> }
      | undefined;
    const nudge = secondRequest?.messages?.find(
      (message) => message.role === "system" && /user-visible answer/i.test(message.content ?? ""),
    );
    expect(nudge).toBeDefined();
  });

  it("only nudges once, then degrades honestly when the model keeps returning empty", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(baseTurn("sess-empty-degraded-1", "Explain quantum tunneling."));

    // First completion + exactly one nudge retry, then the empty-output synthesis
    // pass (which itself re-asks once) — the loop is bounded, not spinning.
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.turnTrace.status).toBe("completed");
    // The turn is marked degraded and (no model recovery) the calm footer is surfaced.
    expect(result.turnTrace.completion?.degraded).toMatchObject({ recoveredByModel: false });
    expect(result.assistantContent.toLowerCase()).toContain("may be incomplete");
  });

  it("leaves eval-integrity turns untouched (no nudge, no degraded sidecar)", async () => {
    // The second resolve covers the existing (non-nudge) empty-output synthesis
    // re-ask, which is allowed on eval-integrity turns because it is still model
    // output; only the deterministic template and the P0-B footer are forbidden.
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      ...baseTurn("sess-eval-integrity-empty-1", "Answer the question."),
      normalizationProfile: "prompt_pack_harness",
    });

    // Eval-integrity: the P0-B nudge never fires (it is gated off), so no tool-less
    // "user-visible answer" instruction is injected, and the degraded sidecar /
    // apology footer machinery stays inert.
    const injectedNudge = createChatCompletion.mock.calls.some((call) => {
      const request = call[0] as { messages?: Array<{ role?: string; content?: string }> } | undefined;
      return request?.messages?.some(
        (message) => message.role === "system" && /user-visible answer/i.test(message.content ?? ""),
      );
    });
    expect(injectedNudge).toBe(false);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.completion?.degraded).toBeUndefined();
    expect(result.turnTrace.completion?.failedFileMutations).toBeUndefined();
    expect(result.assistantContent).not.toContain("may be incomplete");
  });
});
