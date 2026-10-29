import { describe, expect, it, vi } from "vitest";
import { ModelChangePlanAdapter } from "./model-change-plan-adapter.js";

type DispatchEfforts = (providerId: string, model: string) => readonly string[] | undefined;

function fixture(dispatchEfforts: DispatchEfforts) {
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
        {
          providerId: "llamacpp",
          label: "llama.cpp",
          defaultModel: "gemma-4-local",
          authReadiness: { status: "ready" },
          capabilities: { reasoning: false },
        },
        {
          providerId: "vertex",
          label: "Vertex",
          defaultModel: "google/gemini-2.5-flash",
          authReadiness: { status: "ready" },
          capabilities: { reasoning: false, reasoningEfforts: ["low", "medium", "high"] },
        },
        {
          providerId: "claude-code-cli",
          label: "Claude Code CLI",
          defaultModel: "claude-sonnet-5-5",
          authReadiness: { status: "ready" },
          capabilities: { reasoning: true, reasoningEfforts: ["low", "medium", "high"] },
        },
        {
          providerId: "custom",
          label: "Custom",
          defaultModel: "custom-model",
          authReadiness: { status: "ready" },
          capabilities: { reasoning: true },
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
    listModels: vi.fn(
      async () =>
        [
          { id: "gpt-5" },
          { id: "gpt-5-mini" },
          { id: "gemma-4-local" },
          { id: "google/gemini-2.5-flash" },
          { id: "claude-sonnet-5-5" },
          { id: "custom-model" },
        ] as any,
    ),
    getDispatchReasoningEfforts: vi.fn(dispatchEfforts) as any,
  });
  const context = {
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    actions: {
      confirmation: (input: any) => ({ kind: "confirmation", actionId: "action-1", actionNonce: "nonce-1", ...input }),
    },
  } as any;
  return { adapter, context, updateChatSessionPrefs, updateSettings };
}

function defaultModel(adapterFixture: ReturnType<typeof fixture>, providerId: string, model: string, level: string) {
  return adapterFixture.adapter.prepare(adapterFixture.context, {
    kind: "installation_default_model",
    providerId,
    model,
    thinkingLevel: level as any,
  });
}

describe("ModelChangePlanAdapter", () => {
  it("validates effort against the exact model's dispatch efforts instead of provider-wide capability", async () => {
    const { adapter, context } = fixture(() => ["low"]);
    await expect(
      adapter.prepare(context, {
        kind: "session_model",
        providerId: "openai",
        model: "gpt-5",
        thinkingLevel: "deep",
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      details: expect.objectContaining({ requestedEffort: "deep", supportedEfforts: ["off", "minimal"] }),
    });
  });

  it("tells the operator to use Off effort for local runtimes without reasoning support", async () => {
    await expect(
      defaultModel(
        fixture(() => ["none"]),
        "llamacpp",
        "gemma-4-local",
        "standard",
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      message: "llama.cpp / gemma-4-local does not support standard effort. Choose off effort instead.",
      details: expect.objectContaining({ supportedEfforts: ["off"] }),
    });
  });

  it("accepts Off effort for local runtimes without reasoning support", async () => {
    await expect(
      defaultModel(
        fixture(() => ["none"]),
        "llamacpp",
        "gemma-4-local",
        "off",
      ),
    ).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
  });

  it("accepts an effort dispatch honors even when the provider summary says reasoning is off", async () => {
    // Vertex Gemini: capability inference says "no reasoning", but dispatch honors the catalog list.
    const adapterFixture = fixture(() => ["low", "medium", "high"]);
    await expect(defaultModel(adapterFixture, "vertex", "google/gemini-2.5-flash", "standard")).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
    await expect(defaultModel(adapterFixture, "vertex", "google/gemini-2.5-flash", "deep")).rejects.toMatchObject({
      httpStatus: 422,
      details: expect.objectContaining({ supportedEfforts: ["off", "minimal", "standard", "extended"] }),
    });
  });

  it("keeps adapters that omit the effort field on none only, whatever the summary claims", async () => {
    const adapterFixture = fixture(() => ["none"]);
    await expect(defaultModel(adapterFixture, "claude-code-cli", "claude-sonnet-5-5", "minimal")).rejects.toMatchObject(
      {
        httpStatus: 422,
        details: expect.objectContaining({ supportedEfforts: ["off"] }),
      },
    );
    await expect(defaultModel(adapterFixture, "claude-code-cli", "claude-sonnet-5-5", "off")).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
  });

  it("falls back to the provider summary when the LLM owner has no dispatch view of the provider", async () => {
    const adapterFixture = fixture(() => undefined);
    await expect(defaultModel(adapterFixture, "llamacpp", "gemma-4-local", "standard")).rejects.toMatchObject({
      details: expect.objectContaining({ supportedEfforts: ["off"] }),
    });
    await expect(defaultModel(adapterFixture, "openai", "gpt-5", "ultra")).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
    // No declared list at all: the plan does not invent a limit.
    await expect(defaultModel(adapterFixture, "custom", "custom-model", "deep")).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
  });

  it("offers verified model alternatives when the requested model is unavailable", async () => {
    const { adapter, context } = fixture(() => ["low", "medium"]);
    await expect(
      adapter.prepare(context, {
        kind: "installation_default_model",
        providerId: "openai",
        model: "missing-model",
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      details: expect.objectContaining({
        alternatives: [
          "gpt-5",
          "gpt-5-mini",
          "gemma-4-local",
          "google/gemini-2.5-flash",
          "claude-sonnet-5-5",
          "custom-model",
        ],
      }),
    });
  });
});
