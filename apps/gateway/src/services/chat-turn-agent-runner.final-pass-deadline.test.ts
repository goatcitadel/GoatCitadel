import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";

type FinalPass = (input: {
  input: ChatTurnAgentRunnerInput;
  toolRuns: [];
  conversationMessages: [];
  partialAssistantContent: string;
  turnBudgetDeadline: number;
}) => Promise<{ content: string; providerCalls: number; usage: unknown }>;

const response = (): ChatCompletionResponse => ({
  model: "model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "A repaired answer." } }],
  usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
});

function fixture() {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const prepare = vi.fn(async (_input: ChatTurnAgentRunnerInput, request: ChatCompletionRequest) => request);
  const complete = vi.fn(async (_request: ChatCompletionRequest) => response());
  const input: ChatTurnAgentRunnerInput = {
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    userMessageId: "user",
    content: "Answer briefly.",
    mode: "chat",
    providerId: "provider",
    model: "model",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [],
    policyRunId: "run",
    canonicalDurableRunId: "run",
    canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
    featureAdmission: {
      referenceSha256: "a".repeat(64),
      references: {
        version: "chat.turn.feature-references.v1",
        explicitContext: { snapshotId: "snapshot", snapshotHash: "b".repeat(64) },
      },
    },
  };
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => [],
    invokeTool: vi.fn(),
    createChatCompletion: complete,
    prepareExplicitContextRequest: prepare,
    assertFeatureReferencesCurrent: vi.fn(async () => {}),
  });
  return {
    runner,
    input,
    prepare,
    complete,
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("keeps an expired truncated turn incomplete without an extra repair request", async () => {
  const f = fixture();
  f.input.featureAdmission = undefined;
  f.complete.mockImplementationOnce(async () => {
    f.setNow(1_000_000_000);
    return {
      model: "model",
      choices: [
        { index: 0, finish_reason: "length", message: { role: "assistant", content: "The incomplete answer begins" } },
      ],
    };
  });
  const result = await f.runner.run(f.input);
  expect(f.complete).toHaveBeenCalledOnce();
  expect(result.turnTrace.completion?.repaired).not.toBe(true);
  expect(result.turnTrace.completion?.status).not.toBe("complete");
  expect(result.assistantContent).not.toContain("A repaired answer.");
});

it("persists a canonical failed turn when final response authority is revoked", async () => {
  const f = fixture();
  f.input.featureAdmission = undefined;
  const complete = vi
    .fn(async () => response())
    .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "notes" }))
    .mockResolvedValueOnce({
      model: "model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
    })
    .mockRejectedValue(new LlmDispatchGuardRejectedError(new Error("authority revoked")));
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["memory.search"]),
    createChatCompletion: complete,
    invokeTool: vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "allowed",
      auditEventId: "audit",
      result: { hits: [{ title: "Recorded note", snippet: "Previously captured evidence." }] },
    })),
  });
  const result = await runner.run(f.input);
  expect(result.turnTrace.status).toBe("failed");
  expect(result.turnTrace.completion).toMatchObject({ status: "interrupted", repaired: false });
  expect(result.turnTrace.completion?.degraded?.recoveredByModel).not.toBe(true);
  expect(result.turnTrace.failure?.message).toContain("blocked by changed Chat authority");
  expect(complete).toHaveBeenCalledTimes(3);
});

describe.each(["synthesizeToolOutcomeFallback", "repairIncompleteAssistantCompletion"] as const)(
  "%s deadline",
  (method) => {
    async function run(f: ReturnType<typeof fixture>, deadline = 2000) {
      return await (f.runner as unknown as Record<typeof method, FinalPass>)[method]({
        input: f.input,
        toolRuns: [],
        conversationMessages: [],
        partialAssistantContent: "Partial answer",
        turnBudgetDeadline: deadline,
      });
    }

    it("does not dispatch or return repaired text after the turn deadline", async () => {
      const f = fixture();
      const result = await run(f, 1000);
      expect(result).toMatchObject({ content: "", providerCalls: 0, usage: null });
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
    });

    it("rechecks the deadline after awaited admission and context preparation", async () => {
      const f = fixture();
      f.prepare.mockImplementationOnce(async (_input, request) => {
        f.setNow(2000);
        return request;
      });
      const result = await run(f);
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.complete).not.toHaveBeenCalled();
      expect(result).toMatchObject({ content: "", providerCalls: 0 });
    });

    it("uses only the remaining milliseconds without a three-second floor", async () => {
      const f = fixture();
      f.prepare.mockImplementationOnce(async (_input, request) => {
        f.setNow(1250);
        return request;
      });
      const result = await run(f);
      expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 750 }), expect.anything());
      expect(result).toMatchObject({ content: "A repaired answer.", providerCalls: 1 });
    });

    it("retains usage but cannot claim a late provider result as repaired completion", async () => {
      const f = fixture();
      f.complete.mockImplementationOnce(async () => {
        f.setNow(2001);
        return response();
      });
      const result = await run(f);
      expect(result).toMatchObject({ content: "", providerCalls: 1 });
      expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    });

    it.each(["preparation", "transport"])("never turns rejected %s authority into fallback text", async (boundary) => {
      const f = fixture();
      if (boundary === "preparation") f.prepare.mockRejectedValueOnce(new Error("feature revoked"));
      else f.complete.mockRejectedValueOnce(new LlmDispatchGuardRejectedError(new Error("feature revoked")));
      const result = await run(f);
      expect(result).toMatchObject({
        content: "",
        authorityRejected: true,
        providerCalls: boundary === "preparation" ? 0 : 1,
      });
    });
  },
);
