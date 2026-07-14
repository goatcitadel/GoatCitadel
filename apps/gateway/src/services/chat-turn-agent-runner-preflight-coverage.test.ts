import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  createEffectAwareInvokeToolForTest,
  createExecuteToolCallForTest,
  createMockStorage,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { IMPROVEMENT_TUNE_SETTING_KEYS } from "./improvement-tune-reads.js";

describe("ChatTurnAgentRunner tool preflight coverage", () => {
  it("persists blocked web tools without invoking runtime tools when web mode is off", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Fetch https://example.com/latest and summarize it.",
        webMode: "off",
      }),
      turnId: "turn-web-off-preflight",
      toolName: "http.get",
      rawArgs: { url: "https://example.com/latest" },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "http.get",
      status: "blocked",
      error: "execution skipped: live web access is disabled because Web is set to Off for this chat",
    });
    expect(result.record.failureGuidance).toContain("Retry get");
    expect(result.chunk).toMatchObject({
      type: "tool_result",
      toolRun: expect.objectContaining({
        status: "blocked",
      }),
    });
  });

  it("blocks memory writes without explicit consent and infers safe memory lookup queries", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-memory-search-1",
      result: { matches: [{ title: "Onboarding preference", content: "prefers concise status updates" }] },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const blockedWrite = await executeToolCall({
      input: turnInput({
        content: "My preference is concise status updates.",
        memoryMode: "on",
      }),
      turnId: "turn-memory-write-blocked",
      toolName: "memory.write",
      rawArgs: {
        namespace: "preferences",
        title: "Status updates",
        content: "Prefers concise updates",
      },
    });

    expect(blockedWrite.record).toMatchObject({
      toolName: "memory.write",
      status: "blocked",
      error: "memory persistence requires explicit user consent; ask before saving long-term memory",
    });
    expect(invokeTool).not.toHaveBeenCalled();

    const lookup = await executeToolCall({
      input: turnInput({
        content: "What do you remember about my onboarding preference?",
        memoryMode: "on",
      }),
      turnId: "turn-memory-search-inferred",
      toolName: "memory.search",
      rawArgs: {},
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory.search",
        args: expect.objectContaining({
          query: expect.stringContaining("onboarding preference"),
        }),
      }),
    );
    expect(lookup.record).toMatchObject({
      toolName: "memory.search",
      status: "executed",
      result: expect.objectContaining({
        matches: expect.any(Array),
      }),
    });
  });

  it("distinguishes invalid local paths from missing generic required arguments", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const unsafePath = await executeToolCall({
      input: turnInput({
        content: "Search the code for config references.",
        mode: "code",
      }),
      turnId: "turn-unsafe-path",
      toolName: "code.search",
      rawArgs: { path: "code.search", query: "config" },
    });

    expect(unsafePath.record.status).toBe("blocked");
    expect(unsafePath.record.error).toContain("path was not a safe repository path");
    expect(unsafePath.record.failureGuidance).toContain("Retry search");

    const missingUrl = await executeToolCall({
      input: turnInput({
        content: "POST the status update.",
        webMode: "auto",
      }),
      turnId: "turn-missing-http-url",
      toolName: "http.post",
      rawArgs: {},
    });

    expect(missingUrl.record).toMatchObject({
      toolName: "http.post",
      status: "failed",
      error: "execution error: url is required",
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("records blocked browser navigate hosts without weakening allowlist policy", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "blocked",
      policyReason: "browser.navigate host is not yet allowlisted",
      auditEventId: "audit-browser-navigate-blocked-1",
      result: {
        browserFailureClass: "policy_blocked",
      },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Open https://blocked.example/store-hours and collect official hours.",
        webMode: "auto",
      }),
      turnId: "turn-navigate-allowlist-blocked",
      toolName: "browser.navigate",
      rawArgs: { url: "https://blocked.example/store-hours" },
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.navigate",
        args: expect.objectContaining({ url: "https://blocked.example/store-hours" }),
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "browser.navigate",
      status: "blocked",
      error: "browser.navigate host is not yet allowlisted",
    });
    expect(result.record.failureGuidance).toContain("Host blocked.example is not allowlisted");
    expect(result.record.failureGuidance).toContain("continue from search-result evidence");
  });

  it("resolves approval expiry from storage when the tool result omits expiresAt", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval required",
      auditEventId: "audit-shell-approval-1",
      approvalId: "approval-shell-preflight-1",
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Run a harmless shell command after approval.",
        mode: "code",
      }),
      turnId: "turn-approval-expiry",
      toolName: "shell.exec",
      rawArgs: { command: "pnpm --version" },
    });

    expect(result.approvalExpiresAt).toBe("2026-03-22T12:15:00.000Z");
    expect(result.record).toMatchObject({
      toolName: "shell.exec",
      status: "approval_required",
      approvalId: "approval-shell-preflight-1",
    });
  });

  it("rethrows durable control errors from tool invocation instead of persisting an ordinary tool failure", async () => {
    const timeout = Object.assign(new Error("durable workflow deadline expired"), {
      name: "DurableWorkflowTimeoutError",
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockRejectedValueOnce(timeout);
    const executeToolCall = createExecuteToolCall({ invokeTool });

    await expect(
      executeToolCall({
        input: turnInput({
          content: "Search memory for the release decision.",
          memoryMode: "on",
        }),
        turnId: "turn-durable-control-error",
        toolName: "memory.search",
        rawArgs: { query: "release decision" },
      }),
    ).rejects.toBe(timeout);
  });

  it("strengthens blocked-tool guidance when the self-improvement tuner raises blocker strictness (P2-W3)", async () => {
    // Baseline (no tune applied): the blocked web tool gets the historical
    // generic guidance — nothing extra. This is the safe-default regression.
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const baseline = await createExecuteToolCall({ invokeTool })({
      input: turnInput({ content: "Fetch https://example.com/latest and summarize it.", webMode: "off" }),
      turnId: "turn-blocker-baseline",
      toolName: "http.get",
      rawArgs: { url: "https://example.com/latest" },
    });
    expect(baseline.record.status).toBe("blocked");
    expect(baseline.record.failureGuidance).toContain("Retry get");
    expect(baseline.record.failureGuidance).not.toContain("State the exact blocker");

    // The weekly tuner wrote a raised strictness level into system_settings.
    // The same blocked action must now carry a concrete, structured unblock path
    // — proving the written key is actually READ at the decision point.
    const tunedStorage = createMockStorage() as {
      systemSettings: { set(key: string, value: unknown): unknown };
    };
    tunedStorage.systemSettings.set(IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate, 5);
    const tunedExecute = createExecuteToolCallForTest({
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      toolNames: ["http.get"],
      storage: tunedStorage as never,
    });
    const tuned = await tunedExecute({
      input: turnInput({ content: "Fetch https://example.com/latest and summarize it.", webMode: "off" }),
      turnId: "turn-blocker-strict",
      toolName: "http.get",
      rawArgs: { url: "https://example.com/latest" },
    });
    expect(tuned.record.status).toBe("blocked");
    expect(tuned.record.failureGuidance).toContain("State the exact blocker");
    expect(tuned.record.failureGuidance).toContain("Do not silently retry the same blocked action");
  });
});

function createExecuteToolCall(input: { invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult> }) {
  return createExecuteToolCallForTest({
    invokeTool: input.invokeTool,
    invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(input.invokeTool),
    toolNames: ["browser.search", "browser.navigate", "http.get", "memory.search", "memory.write"],
  });
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-preflight-coverage",
    turnId: "turn-preflight-coverage",
    userMessageId: "msg-preflight-coverage",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}
