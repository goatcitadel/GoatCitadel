import { describe, expect, it, vi } from "vitest";
import { LlamaCppSetupService } from "./llama-cpp-setup-service.js";

function fixture() {
  const getSettings = vi.fn(async () => ({
    revision: 42,
    llm: { activeProviderId: "llamacpp", activeModel: "local-model", defaultThinkingLevel: "off" },
    llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
  }));
  const createChatSession = vi.fn(async () => ({ sessionId: "diagnostic-session" }));
  const sendChatMessage = vi.fn(async () => ({
    model: "local-model",
    turnId: "turn-1",
    assistantMessage: { content: "I can respond." },
    routing: { effectiveProviderId: "llamacpp", effectiveModel: "local-model" },
    trace: { status: "completed" },
  }));
  const listPlans = vi.fn(async (): Promise<any[]> => []);
  const service = new LlamaCppSetupService({
    getSettings,
    runtime: {
      refresh: vi.fn(async () => ({ healthy: true, leaseDiagnostics: { ownership: "external" } })),
      detectLocalInstall: vi.fn(async () => ({ found: false })),
      listModels: vi.fn(async () => []),
    } as any,
    selections: {} as any,
    plans: { list: listPlans } as any,
    previewModels: vi.fn(async () => ({ source: "live", items: [{ id: "local-model" }] })) as any,
    createChatSession,
    sendChatMessage: sendChatMessage as any,
  });
  return { service, getSettings, createChatSession, sendChatMessage, listPlans };
}

describe("LlamaCppSetupService", () => {
  it("projects the completed plan after reopening without calling it pending", async () => {
    const f = fixture();
    f.listPlans.mockResolvedValueOnce([
      {
        planId: "plan-done",
        revision: 6,
        status: "completed",
        request: { kind: "runtime_configuration", change: { operation: "llama_cpp_setup" } },
        result: { summary: "Chat model selected." },
      },
    ]);
    const projection = await f.service.get("default");
    expect(projection.recentPlan).toMatchObject({
      planId: "plan-done",
      status: "completed",
      summary: "Chat model selected.",
    });
    expect(projection.pendingPlan).toBeUndefined();
  });

  it("uses hidden normal Chat routing with tools, web, memory, and delegation disabled", async () => {
    const f = fixture();
    const result = await f.service.chatTest("default");
    expect(f.createChatSession).toHaveBeenCalledWith({
      workspaceId: "default",
      origin: "system",
      includeInHistory: false,
      title: "llama.cpp setup diagnostic",
    });
    expect(f.sendChatMessage).toHaveBeenCalledWith(
      "diagnostic-session",
      expect.objectContaining({
        webMode: "off",
        memoryMode: "off",
        useMemory: false,
        subagentPolicy: "off",
        thinkingLevel: "off",
        prefsOverride: expect.objectContaining({ toolAutonomy: "manual", orchestrationEnabled: false }),
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      success: true,
      providerId: "llamacpp",
      model: "local-model",
      responseExcerpt: "I can respond.",
      settingsRevision: 42,
      traceRef: "turn-1",
    });
  });

  it("does not call a model-list probe a Chat success when completion fails", async () => {
    const f = fixture();
    f.sendChatMessage.mockResolvedValueOnce({
      model: "local-model",
      turnId: "turn-failed",
      routing: { effectiveProviderId: "llamacpp", effectiveModel: "local-model" },
      trace: { status: "failed" },
    } as any);
    const result = await f.service.chatTest("default");
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not complete");
  });

  it("marks a Chat result stale when settings change during the turn", async () => {
    const f = fixture();
    f.getSettings
      .mockResolvedValueOnce({
        revision: 42,
        llm: { activeProviderId: "llamacpp", activeModel: "local-model", defaultThinkingLevel: "off" },
        llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
      })
      .mockResolvedValueOnce({
        revision: 43,
        llm: { activeProviderId: "llamacpp", activeModel: "local-model", defaultThinkingLevel: "off" },
        llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
      });
    expect(await f.service.chatTest("default")).toMatchObject({
      success: false,
      error: "Settings changed during the test. Run it again.",
    });
  });

  it("returns actionable failure details even before a Chat route or after a thrown turn", async () => {
    const f = fixture();
    f.getSettings.mockResolvedValueOnce({
      revision: 42,
      llm: { activeProviderId: "openai", activeModel: "remote-model", defaultThinkingLevel: "off" },
      llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    expect(await f.service.chatTest("default")).toMatchObject({
      success: false,
      settingsRevision: 42,
      error: "Select a verified llama.cpp model for Chat before sending a test message.",
    });
    expect(f.createChatSession).not.toHaveBeenCalled();
    f.sendChatMessage.mockRejectedValueOnce(new Error("Completion connection closed"));
    expect(await f.service.chatTest("default")).toMatchObject({
      success: false,
      traceRef: "diagnostic-session",
      error: "Completion connection closed",
    });
  });
});
