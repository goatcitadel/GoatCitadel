import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { LlmService } from "./llm-service.js";
import { ApprovalExplainerService } from "./approval-explainer-service.js";

const defaultApproval: ApprovalRequest = {
  approvalId: "ap-1",
  kind: "shell.exec",
  riskLevel: "danger",
  status: "pending",
  payload: { command: "dir" },
  preview: { command: "dir" },
  createdAt: "2026-02-28T00:00:00.000Z",
  explanationStatus: "not_requested",
};

function createService(options?: {
  markPendingResult?: boolean;
  response?: ChatCompletionResponse;
  throwError?: Error;
  apiStyle?: ReturnType<LlmService["resolveExecutionApiStyle"]>;
}) {
  const markExplanationPending = vi.fn(() => options?.markPendingResult ?? true);
  const setExplanation = vi.fn();
  const setExplanationFailed = vi.fn();
  const appendEvent = vi.fn();
  const publishRealtime = vi.fn();
  const chatCompletions = vi.fn(async (_request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    if (options?.throwError) {
      throw options.throwError;
    }
    return (
      options?.response ?? {
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                summary: "This command lists files.",
                riskExplanation: "It can expose sensitive filenames if run in sensitive directories.",
                saferAlternative: "Run it only inside your workspace folder.",
              }),
            },
          },
        ],
      }
    );
  });

  const storage = {
    approvals: {
      markExplanationPending,
      setExplanation,
      setExplanationFailed,
    },
    approvalEvents: {
      append: appendEvent,
    },
  } as unknown as Storage;

  const llm = {
    getRuntimeConfig: () => ({
      activeProviderId: "openai",
      activeModel: "gpt-4o-mini",
      providers: [],
    }),
    resolveExecutionApiStyle: () => options?.apiStyle ?? "openai-responses",
    chatCompletions,
  } as unknown as LlmService;

  const service = new ApprovalExplainerService(
    storage,
    llm,
    {
      enabled: true,
      mode: "async",
      minRiskLevel: "caution",
      timeoutMs: 5000,
      maxPayloadChars: 4000,
    },
    publishRealtime,
  );

  return {
    service,
    markExplanationPending,
    setExplanation,
    setExplanationFailed,
    appendEvent,
    publishRealtime,
    chatCompletions,
  };
}

describe("ApprovalExplainerService", () => {
  it("generates and stores layman explanation on success", async () => {
    const ctx = createService();
    await ctx.service.explainApproval(defaultApproval);

    expect(ctx.markExplanationPending).toHaveBeenCalledWith("ap-1");
    expect(ctx.setExplanation).toHaveBeenCalledTimes(1);
    expect(ctx.setExplanationFailed).not.toHaveBeenCalled();
    expect(ctx.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "explanation_requested" }));
    expect(ctx.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "explanation_generated" }));
    expect(ctx.publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "ap-1", status: "completed" }),
    );
  });

  it("omits sampling and response format controls for OpenAI Codex approval explanations", async () => {
    const ctx = createService({ apiStyle: "openai-codex-responses" });
    await ctx.service.explainApproval(defaultApproval);

    const request = ctx.chatCompletions.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(request.temperature).toBeUndefined();
    expect(request.response_format).toBeUndefined();
    expect(request.max_tokens).toBe(350);
  });

  it("marks explanation as failed when generation fails", async () => {
    const ctx = createService({
      throwError: new Error("provider timeout"),
    });

    await ctx.service.explainApproval(defaultApproval);

    expect(ctx.setExplanation).not.toHaveBeenCalled();
    expect(ctx.setExplanationFailed).toHaveBeenCalledWith("ap-1", "provider timeout");
    expect(ctx.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "explanation_failed" }));
    expect(ctx.publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "ap-1", status: "failed", error: "provider timeout" }),
    );
  });

  it("dedupes when explanation is already in progress", async () => {
    const ctx = createService({
      markPendingResult: false,
    });

    await ctx.service.explainApproval(defaultApproval);

    expect(ctx.chatCompletions).not.toHaveBeenCalled();
    expect(ctx.setExplanation).not.toHaveBeenCalled();
    expect(ctx.setExplanationFailed).not.toHaveBeenCalled();
  });

  it("redacts sensitive fields before sending to LLM", async () => {
    const ctx = createService();
    const approval: ApprovalRequest = {
      ...defaultApproval,
      payload: {
        command: "curl ...",
        apiKey: "SECRET123",
        nested: {
          password: "hunter2",
          token: "abc123",
        },
      },
      preview: {
        authorization: "Bearer token",
      },
    };

    await ctx.service.explainApproval(approval);

    const request = ctx.chatCompletions.mock.calls[0]?.[0] as ChatCompletionRequest;
    const prompt = request.messages[1]?.content;
    expect(typeof prompt).toBe("string");
    const promptText = String(prompt);
    expect(promptText.includes("SECRET123")).toBe(false);
    expect(promptText.includes("hunter2")).toBe(false);
    expect(promptText.includes("abc123")).toBe(false);
    expect(promptText.includes("[REDACTED]")).toBe(true);
  });

  it("skips safe risk approvals by default threshold", async () => {
    const ctx = createService();
    const safeApproval: ApprovalRequest = {
      ...defaultApproval,
      riskLevel: "safe",
    };

    await ctx.service.explainApproval(safeApproval);
    expect(ctx.markExplanationPending).not.toHaveBeenCalled();
    expect(ctx.chatCompletions).not.toHaveBeenCalled();
  });
});
