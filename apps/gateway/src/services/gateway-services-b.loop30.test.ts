import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ApprovalExplainerService } from "./approval-explainer-service.js";
import type { LlmService } from "./llm-service.js";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
} from "./secret-store-service.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const spawnSyncMock = vi.mocked(spawnSync);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalDisableSecretStore = process.env.GOATCITADEL_DISABLE_SECRET_STORE;

const approval: ApprovalRequest = {
  approvalId: "approval-loop30",
  kind: "tool.invoke",
  riskLevel: "danger",
  status: "pending",
  payload: { command: "write-file" },
  preview: { path: "notes.md" },
  createdAt: "2026-05-15T12:00:00.000Z",
  explanationStatus: "not_requested",
};

afterEach(() => {
  spawnSyncMock.mockReset();
  vi.useRealTimers();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalDisableSecretStore === undefined) {
    delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
  } else {
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = originalDisableSecretStore;
  }
});

describe("Gateway Services B loop 30 coverage", () => {
  it("skips approval explanations when disabled, synchronous, or already resolved", async () => {
    for (const ctx of [
      createApprovalHarness({ config: { enabled: false } }),
      createApprovalHarness({ config: { mode: "sync" } }),
      createApprovalHarness(),
    ]) {
      expect(ctx.service.shouldExplain({ ...approval, explanationStatus: "pending" })).toBe(false);
      expect(ctx.service.shouldExplain({ ...approval, explanationStatus: "completed" })).toBe(false);
      await ctx.service.explainApproval({ ...approval, explanationStatus: "completed" });
      expect(ctx.markExplanationPending).not.toHaveBeenCalled();
      expect(ctx.chatCompletions).not.toHaveBeenCalled();
    }

    const nuclearOnly = createApprovalHarness({ config: { minRiskLevel: "nuclear" } });
    expect(nuclearOnly.service.shouldExplain({ ...approval, riskLevel: "nuclear" })).toBe(true);
    expect(
      nuclearOnly.service.shouldExplain({
        ...approval,
        riskLevel: "unknown-risk" as ApprovalRequest["riskLevel"],
      }),
    ).toBe(false);
  });

  it("parses JSON from text-array approval responses and stores configured model metadata", async () => {
    const ctx = createApprovalHarness({
      config: {
        providerId: "anthropic",
        model: "claude-loop30",
        maxPayloadChars: 160,
      },
      response: {
        choices: [
          {
            index: 0,
            message: {
              content: [
                { text: "Operator summary follows." },
                {
                  text: JSON.stringify({
                    summary: "  Writes a file.  ",
                    riskExplanation: "  It can overwrite local work.  ",
                    saferAlternative: "   ",
                  }),
                },
              ],
            },
          },
        ],
      } as ChatCompletionResponse,
    });

    await ctx.service.explainApproval({
      ...approval,
      payload: {
        nested: [
          {
            token: "SECRET_TOKEN",
            value: "safe context".repeat(20),
          },
        ],
      },
    });

    const request = ctx.chatCompletions.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(String(request.messages[1]?.content)).not.toContain("SECRET_TOKEN");
    expect(String(request.messages[1]?.content)).toContain("...");
    expect(ctx.setExplanation).toHaveBeenCalledWith(
      "approval-loop30",
      expect.objectContaining({
        providerId: "anthropic",
        model: "claude-loop30",
        summary: "Writes a file.",
        riskExplanation: "It can overwrite local work.",
        saferAlternative: undefined,
      }),
    );
    expect(ctx.publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", providerId: "anthropic", model: "claude-loop30" }),
    );
  });

  it("marks malformed and empty approval explanations as failed", async () => {
    const malformed = createApprovalHarness({
      response: {
        choices: [
          {
            index: 0,
            message: {
              content: [{ type: "metadata" }],
            },
          },
        ],
      } as ChatCompletionResponse,
    });
    await malformed.service.explainApproval(approval);
    expect(malformed.setExplanationFailed).toHaveBeenCalledWith(
      "approval-loop30",
      "approval explainer missing required field: summary",
    );

    const empty = createApprovalHarness({
      response: {
        choices: [
          {
            index: 0,
            message: undefined,
          },
        ],
      } as unknown as ChatCompletionResponse,
    });
    await empty.service.explainApproval(approval);
    expect(empty.setExplanationFailed).toHaveBeenCalledWith(
      "approval-loop30",
      "approval explainer returned empty content",
    );

    const nonStringContent = createApprovalHarness({
      response: {
        choices: [
          {
            index: 0,
            message: {
              content: 42,
            },
          },
        ],
      } as unknown as ChatCompletionResponse,
    });
    await nonStringContent.service.explainApproval(approval);
    expect(nonStringContent.setExplanationFailed).toHaveBeenCalledWith(
      "approval-loop30",
      "approval explainer returned empty content",
    );

    const nonJson = createApprovalHarness({
      response: {
        choices: [
          {
            index: 0,
            message: {
              content: "plain text only",
            },
          },
        ],
      } as ChatCompletionResponse,
    });
    await nonJson.service.explainApproval(approval);
    expect(nonJson.setExplanationFailed).toHaveBeenCalledWith(
      "approval-loop30",
      "approval explainer returned non-JSON content",
    );

    const missingOptionalAlternative = createApprovalHarness({
      response: {
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                summary: "Proceed carefully.",
                riskExplanation: "The approval can change local state.",
              }),
            },
          },
        ],
      } as ChatCompletionResponse,
    });
    await missingOptionalAlternative.service.explainApproval(approval);
    expect(missingOptionalAlternative.setExplanation).toHaveBeenCalledWith(
      "approval-loop30",
      expect.objectContaining({ saferAlternative: undefined }),
    );
  });

  it("fails approval explanations when the model call exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    const ctx = createApprovalHarness({
      timeoutMs: 25,
      chatCompletions: () => new Promise<ChatCompletionResponse>(() => undefined),
    });

    const pending = ctx.service.explainApproval(approval);
    await vi.advanceTimersByTimeAsync(25);
    await pending;

    expect(ctx.setExplanationFailed).toHaveBeenCalledWith("approval-loop30", "approval explainer timed out");
    expect(ctx.publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "approval explainer timed out" }),
    );
  });

  it("reports keychain status and unavailable status without exposing secret-store failures", () => {
    setPlatform("linux");
    const service = new SecretStoreService();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "  sk-live  \n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" } as never);

    expect(service.status("openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "keychain",
    });
    expect(service.status("anthropic")).toEqual({
      providerId: "anthropic",
      hasSecret: false,
      source: "none",
    });
    expect(isSecretStoreUnavailableLikeError(new SecretStoreUnavailableError("secret store unavailable"))).toBe(true);
    expect(isSecretStoreUnavailableLikeError(new Error("Windows.Security.Credentials failed"))).toBe(true);
    expect(isSecretStoreUnavailableLikeError(new Error("System.Runtime.WindowsRuntime unavailable"))).toBe(true);
  });

  it("normalizes blank host-keychain reads and tolerates macOS delete misses", () => {
    const service = new SecretStoreService();

    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "   \n", stderr: "" } as never);
    expect(service.getSecret("provider:openai")).toBeUndefined();

    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "   \n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 44, stdout: "", stderr: "" } as never);
    expect(service.getSecret("provider:anthropic")).toBeUndefined();
    service.deleteSecret("provider:anthropic");

    setPlatform("linux");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" } as never);
    expect(service.getSecret("provider:google")).toBeUndefined();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "security",
      ["delete-generic-password", "-a", "provider:anthropic", "-s", "goatcitadel"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });
});

function createApprovalHarness(
  options: {
    config?: Partial<ConstructorParameters<typeof ApprovalExplainerService>[2]>;
    response?: ChatCompletionResponse;
    timeoutMs?: number;
    chatCompletions?: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  } = {},
) {
  const markExplanationPending = vi.fn(() => true);
  const setExplanation = vi.fn();
  const setExplanationFailed = vi.fn();
  const appendEvent = vi.fn();
  const publishRealtime = vi.fn();
  const chatCompletions = vi.fn(
    options.chatCompletions ??
      (async (): Promise<ChatCompletionResponse> =>
        options.response ?? {
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  summary: "This approval changes local state.",
                  riskExplanation: "The action can modify files or settings.",
                  saferAlternative: "Review the target path first.",
                }),
              },
            },
          ],
        }),
  );

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

  const llmService = {
    getRuntimeConfig: () => ({
      activeProviderId: "openai",
      activeModel: "gpt-loop30",
      providers: [],
    }),
    resolveExecutionApiStyle: () => "openai-chat-completions",
    chatCompletions,
  } as unknown as LlmService;

  const service = new ApprovalExplainerService(
    storage,
    llmService,
    {
      enabled: true,
      mode: "async",
      minRiskLevel: "caution",
      timeoutMs: options.timeoutMs ?? 5000,
      maxPayloadChars: 4000,
      ...options.config,
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

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
