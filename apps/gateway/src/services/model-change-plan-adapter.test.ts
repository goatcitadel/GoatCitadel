import { describe, expect, it, vi } from "vitest";
import { ModelChangePlanAdapter } from "./model-change-plan-adapter.js";

function fixture(modelEfforts: readonly string[]) {
  const settings = {
    revision: 9,
    llm: {
      activeProviderId: "openai",
      activeModel: "gpt-5",
      defaultThinkingLevel: "standard",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          defaultModel: "gpt-5",
          authReadiness: { status: "ready" },
          capabilities: { reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        },
      ],
    },
  } as any;
  const updateChatSessionPrefs = vi.fn();
  const updateSettings = vi.fn();
  const adapter = new ModelChangePlanAdapter({
    getChatSessionPrefs: vi.fn(
      async () =>
        ({
          sessionId: "session-1",
          revision: 3,
          providerId: "openai",
          model: "gpt-5",
          thinkingLevel: "standard",
        }) as any,
    ),
    updateChatSessionPrefs,
    getSettings: vi.fn(async () => settings),
    updateSettings,
    listModels: vi.fn(async () => [{ id: "gpt-5" }, { id: "gpt-5-mini" }] as any),
    getModelReasoningMetadata: vi.fn(() => ({ supportedEfforts: modelEfforts }) as any),
  });
  const context = {
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    actions: {
      confirmation: (input: any) => ({ kind: "confirmation", actionId: "action-1", actionNonce: "nonce-1", ...input }),
    },
  } as any;
  return { adapter, context, updateChatSessionPrefs, updateSettings };
}

describe("ModelChangePlanAdapter", () => {
  it("validates effort against exact model metadata instead of provider-wide capability", async () => {
    const { adapter, context } = fixture(["low"]);
    await expect(
      adapter.prepare(context, {
        kind: "session_model",
        providerId: "openai",
        model: "gpt-5",
        thinkingLevel: "deep",
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      details: expect.objectContaining({ requestedEffort: "deep", supportedEfforts: ["minimal"] }),
    });
  });

  it("offers verified model alternatives when the requested model is unavailable", async () => {
    const { adapter, context } = fixture(["low", "medium"]);
    await expect(
      adapter.prepare(context, {
        kind: "installation_default_model",
        providerId: "openai",
        model: "missing-model",
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      details: expect.objectContaining({ alternatives: ["gpt-5", "gpt-5-mini"] }),
    });
  });
});
