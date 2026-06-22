import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-agent-orchestrator-test-fixtures.js";

function emptyAssistantCompletion(): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [{ index: 0, message: { role: "assistant", content: "" } }],
  };
}

function assistantTextCompletion(content: string): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}

function toolTurn(sessionId: string, content: string): ChatAgentTurnInput {
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

  it("records distinct degraded.reason for a deterministic vs a model-synthesized empty-output recovery", async () => {
    // A turn WITH tool runs that ends empty bypasses the no-tool nudge and falls
    // straight to the empty-output synthesis pass, so the synthesis ternary — not
    // the nudge — sets the degraded reason. The two outcomes must be auditably
    // distinct (regression for the dead `... ? "empty_answer" : "empty_answer"`).
    const invokeResult: ToolInvokeResult = {
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search",
      result: { results: [{ title: "T", url: "https://example.com", snippet: "s" }] },
    };

    // memory.search is used (not browser.search) because web tools are gated off
    // when webMode is "off"; a knowledge-pack tool stays in the active schema so
    // the call actually executes and the turn carries a tool run.

    // Model-synthesized branch: tool call -> empty terminal -> synthesis returns text.
    const modelSynthesized = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "q" }))
      .mockResolvedValueOnce(emptyAssistantCompletion())
      .mockResolvedValue(assistantTextCompletion("Here is the synthesized final answer for you."));
    const recoveredOrchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion: modelSynthesized,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue(invokeResult),
    });
    const recovered = await recoveredOrchestrator.run(toolTurn("sess-empty-synth-model", "Find something."));

    expect(recovered.turnTrace.completion?.degraded?.reason).toBe("empty_recovered");
    expect(recovered.turnTrace.completion?.degraded?.recoveredByModel).toBe(true);

    // Deterministic branch: tool call -> empty terminal -> synthesis also returns
    // empty, so the deterministic template floor is used.
    const deterministic = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "q" }))
      .mockResolvedValue(emptyAssistantCompletion());
    const deterministicOrchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion: deterministic,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue(invokeResult),
    });
    const floored = await deterministicOrchestrator.run(toolTurn("sess-empty-synth-det", "Find something."));

    expect(floored.turnTrace.completion?.degraded?.reason).toBe("empty_answer");
    expect(floored.turnTrace.completion?.degraded?.recoveredByModel).toBe(false);

    // The whole point: the two outcomes are auditably different.
    expect(recovered.turnTrace.completion?.degraded?.reason).not.toBe(
      floored.turnTrace.completion?.degraded?.reason,
    );
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
