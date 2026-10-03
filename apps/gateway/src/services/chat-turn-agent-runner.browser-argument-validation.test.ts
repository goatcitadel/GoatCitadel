import { randomUUID } from "node:crypto";
import type {
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner browser argument feedback", () => {
  it("uses a supported read tool after malformed interaction steps are blocked before approval", async () => {
    const policyConfig: ToolPolicyConfig = {
      tools: { approvalMode: "approve_risky", allow: ["*"], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: ["./workspace"],
        readOnlyRoots: ["./skills"],
        networkAllowlist: ["localhost"],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    };
    const createApproval = vi.fn(async () => {
      throw new Error("malformed browser action must not create an approval");
    });
    const policyStorage = {
      runImmediateTransaction: vi.fn(async <T>(work: () => T | Promise<T>) => await work()),
      approvals: { createWithTtlDuration: createApproval },
      pendingApprovalActions: { upsertPending: vi.fn(async () => undefined) },
      audit: { append: vi.fn(async () => undefined) },
      db: { prepare: vi.fn(() => ({ run: vi.fn(async () => undefined) })) },
      toolGrants: { listActive: vi.fn(async () => []) },
      toolAccessDecisions: {
        record: vi.fn(async () => undefined),
        countToolCallsInLastHourInScope: vi.fn(async () => 0),
        countWritesInLastHourInScope: vi.fn(async () => 0),
      },
    } as unknown as AsyncStorage;
    const policy = new ToolPolicyEngine(policyConfig, policyStorage);
    const url = "http://localhost/app";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.interact", { url, steps: [{ action: "snapshot" }] }))
      .mockResolvedValueOnce(namedToolCallCompletion("browser.navigate", { url }))
      .mockResolvedValueOnce({
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "The page shows Chat and System navigation." } }],
      });
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.interact") {
        return policy.invoke(request);
      }
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-read-page",
        result: { url, textSnippet: "Chat | System" },
      };
    });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        policy.listCatalog().filter((tool) => ["browser.interact", "browser.navigate"].includes(tool.toolName)),
      createChatCompletion,
      invokeTool,
    });
    const content = `Use browser.interact to inspect ${url} read-only. If it fails, try a supported alternative.`;
    const result = await runner.run({
      sessionId: "sess-browser-argument-feedback",
      turnId: randomUUID(),
      userMessageId: "msg-browser-argument-feedback",
      content,
      mode: "chat",
      providerId: "test-provider",
      model: "test-model",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(createApproval).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", content: expect.stringContaining("Supported actions:") }),
        ]),
      }),
      expect.anything(),
    );
    expect(result.requiresApproval).toBeUndefined();
    expect(result.turnTrace.toolRuns).toEqual([
      expect.objectContaining({
        toolName: "browser.interact",
        status: "blocked",
        error: expect.stringContaining("Supported actions:"),
      }),
      expect.objectContaining({ toolName: "browser.navigate", status: "executed" }),
    ]);
    expect(result.assistantContent).toContain("The page shows Chat and System navigation.");
    expect(result.assistantContent).not.toContain("Approved tool action failed");
  });
});
