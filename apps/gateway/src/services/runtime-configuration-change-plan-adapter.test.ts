import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { RuntimeConfigurationChangePlanAdapter } from "./runtime-configuration-change-plan-adapter.js";

const context = {
  origin: { surface: "settings", workspaceId: "default", actorId: "operator-1" },
  actions: {
    confirmation: (input: Record<string, unknown>) => ({
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-1",
      purpose: "apply",
      ...input,
    }),
    secureInput: (input: Record<string, unknown>) => ({
      kind: "secure_input",
      actionId: "secure-1",
      actionNonce: "secure-nonce-123456",
      ...input,
    }),
  },
} as any;

const authCredentialDeps = {
  hasTemporaryAuthCredential: vi.fn(async () => false),
  consumeTemporaryAuthCredential: vi.fn(async () => "temporary-credential"),
  discardTemporaryAuthCredential: vi.fn(),
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    revision: 7,
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    features: {
      evolutionControlPlaneV1Enabled: true,
      improvementLocalObservationV1Enabled: false,
      improvementModelEvaluationV1Enabled: false,
      productSourceEvolutionV1Enabled: false,
    },
    ...overrides,
  } as any;
}

describe("RuntimeConfigurationChangePlanAdapter", () => {
  it("requires a fresh external catalog and preserves the prior Chat default if runtime verification fails", async () => {
    let current = settings({
      llm: { activeProviderId: "openai", activeModel: "current", defaultThinkingLevel: "standard" },
      llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    const updateSettings = vi.fn(async (input) => {
      current = settings({
        ...current,
        revision: current.revision + 1,
        llamaCpp: { ...current.llamaCpp, ...input.llamaCpp },
        llm: { ...current.llm, ...input.llm },
      });
      return current;
    });
    const previewLlamaModels = vi.fn(async () => ({
      source: "error_fallback" as const,
      items: [{ id: "template-alias" }],
    }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
      previewLlamaModels,
      refreshLlamaRuntime: async () => ({ healthy: false }) as any,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "llama_cpp_setup" as const,
        managementMode: "external" as const,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-model",
      },
    };
    await expect(adapter.prepare(context, request)).rejects.toThrow("did not freshly advertise");
    expect(updateSettings).not.toHaveBeenCalled();
    previewLlamaModels.mockResolvedValue({ source: "live", items: [{ id: "local-model" }] });
    const prepared = await adapter.prepare(context, request);
    await expect(
      adapter.apply(context, { request, target: prepared.target, origin: context.origin } as ChangePlanRecord),
    ).rejects.toThrow("previous Chat default was retained");
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(current.llm).toMatchObject({ activeProviderId: "openai", activeModel: "current" });
  });

  it("applies managed setup only after revalidating the opaque file selection", async () => {
    let current = settings({
      llm: { activeProviderId: "openai", activeModel: "current", defaultThinkingLevel: "standard" },
      llamaCpp: { managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    const updateSettings = vi.fn(async (input) => {
      current = settings({
        ...current,
        revision: current.revision + 1,
        llamaCpp: { ...current.llamaCpp, ...input.llamaCpp },
        llm: { ...current.llm, ...input.llm },
      });
      return current;
    });
    const resolveManagedSelection = vi.fn(
      async () =>
        ({
          modelId: "file.gguf",
          alias: "file",
          command: "C:/llama/llama-server.exe",
          modelPath: "C:/models/file.gguf",
        }) as any,
    );
    const discardManagedSelection = vi.fn();
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
      resolveManagedSelection,
      discardManagedSelection,
      previewLlamaModels: async () => ({ source: "live", items: [{ id: "file" }] }),
      refreshLlamaRuntime: async () => ({ healthy: true, leaseDiagnostics: { ownership: "owned" } }) as any,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "llama_cpp_setup" as const,
        managementMode: "managed" as const,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "file",
        selectionId: "selection-1",
        autoStart: true,
      },
    };
    const prepared = await adapter.prepare(context, request);
    const plan = { request, target: prepared.target, origin: context.origin } as ChangePlanRecord;
    resolveManagedSelection.mockRejectedValueOnce(new Error("GGUF missing"));
    await expect(adapter.apply(context, plan)).rejects.toThrow("GGUF missing");
    expect(updateSettings).not.toHaveBeenCalled();
    const applied = await adapter.apply(context, plan);
    expect(applied.status).toBe("verifying");
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 7,
      llamaCpp: { managementMode: "managed", autoStart: true, modelPath: "C:/models/file.gguf" },
    });
    expect(updateSettings.mock.calls[1]?.[0]).toEqual({
      expectedRevision: 8,
      llm: { activeProviderId: "llamacpp", activeModel: "file", defaultThinkingLevel: "off" },
    });
    const receiver = resolveManagedSelection.mock.contexts[0];
    expect(receiver).toMatchObject({ resolveManagedSelection, updateSettings, discardManagedSelection });
    expect(resolveManagedSelection.mock.contexts.every((current) => current === receiver)).toBe(true);
    expect(updateSettings.mock.contexts.every((current) => current === receiver)).toBe(true);
    expect(discardManagedSelection.mock.contexts).toEqual([receiver]);
    expect(current.llm).toMatchObject({
      activeProviderId: "llamacpp",
      activeModel: "file",
      defaultThinkingLevel: "off",
    });
    expect(discardManagedSelection).toHaveBeenCalledWith("selection-1");
    expect((await adapter.verify(context, plan)).status).toBe("completed");
  });

  it("rejects a persisted named tool profile plan after retirement", async () => {
    const updateSettings = vi.fn();
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => settings(),
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration",
      change: { operation: "default_tool_profile", profileId: "danger" },
    } as never;

    await expect(adapter.prepare(context, request)).rejects.toThrow("Named tool profile changes are retired");
    await expect(adapter.apply(context, { request } as ChangePlanRecord)).rejects.toThrow(
      "Named tool profile changes are retired",
    );
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("applies reviewed pack flags together at one revision and keeps protected flags dangerous", async () => {
    let current = settings();
    const updateSettings = vi.fn(async (input) => {
      current = settings({ revision: 8, features: { ...current.features, ...input.features } });
      return current;
    });
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: async () => current,
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration",
      change: {
        operation: "feature_flags",
        flags: {
          memoryLifecycleAdminV1Enabled: true,
          memoryMaintenanceV1Enabled: true,
        },
      },
    } as const;
    const prepared = await adapter.prepare(context, request);
    const plan = { request, target: prepared.target } as ChangePlanRecord;
    await adapter.apply(context, plan);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ expectedRevision: 7, features: request.change.flags });
    expect((await adapter.verify(context, plan)).status).toBe("completed");
    expect(
      (
        await adapter.prepare(context, {
          kind: "runtime_configuration",
          change: { operation: "feature_flags", flags: { productSourceEvolutionV1Enabled: true } },
        })
      ).risk,
    ).toBe("danger");
  });
  it("maps only registered typed operations to the settings owner", async () => {
    const updateSettings = vi.fn(async (input) => settings({ revision: 8, budgetMode: input.budgetMode }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings,
    });
    const prepared = await adapter.prepare(context, {
      kind: "runtime_configuration",
      change: { operation: "budget_mode", mode: "power" },
    });
    expect(prepared.target).toEqual({
      ownerId: "runtime_settings",
      resourceId: "budget_mode",
      expectedRevision: 7,
    });

    const outcome = await adapter.apply(context, {
      request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "power" } },
      target: prepared.target,
    } as ChangePlanRecord);

    expect(updateSettings).toHaveBeenCalledWith({ expectedRevision: 7, budgetMode: "power" });
    expect(outcome.status).toBe("verifying");
  });

  it("fails closed when the settings revision changed after preparation", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings({ revision: 8 })),
      updateSettings: vi.fn(),
    });
    await expect(
      adapter.apply(context, {
        request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "power" } },
        target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 7 },
      } as ChangePlanRecord),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("classifies enabling source evolution as danger", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => settings()),
      updateSettings: vi.fn(),
    });
    const prepared = await adapter.prepare(context, {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "productSourceEvolutionV1Enabled", enabled: true },
    });
    expect(prepared.risk).toBe("danger");
  });

  it("maps a typed memory group without exposing arbitrary setting keys", async () => {
    const current = settings({
      memory: {
        enabled: false,
        qmd: {
          enabled: false,
          applyToChat: false,
          applyToOrchestration: false,
          maxContextTokens: 4_096,
          minPromptChars: 80,
          cacheTtlSeconds: 300,
        },
      },
    });
    const updateSettings = vi.fn(async () => settings({ revision: 8 }));
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () => current),
      updateSettings,
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: { operation: "memory_configuration" as const, config: { enabled: true, qmdEnabled: true } },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.risk).toBe("caution");
    await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      memory: { enabled: true, qmdEnabled: true },
    });
  });

  it("validates utility models against the live provider catalog before confirmation", async () => {
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      ...authCredentialDeps,
      getSettings: vi.fn(async () =>
        settings({
          llm: {
            providers: [{ providerId: "openai", label: "OpenAI", authReadiness: { status: "ready" } }],
          },
        }),
      ),
      updateSettings: vi.fn(),
      listModels: vi.fn(async () => [{ id: "gpt-5.5" }, { id: "gpt-5-mini" }]),
    });
    await expect(
      adapter.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "utility_model", providerId: "openai", model: "missing-model" },
      }),
    ).rejects.toMatchObject({ httpStatus: 422, details: { alternatives: ["gpt-5.5", "gpt-5-mini"] } });
  });

  it("keeps Gateway auth credentials in the dedicated owner flow", async () => {
    const current = settings({
      auth: { mode: "none", allowLoopbackBypass: true, tokenConfigured: false, basicConfigured: false },
    });
    const updateSettings = vi.fn(async () =>
      settings({
        revision: 8,
        auth: { mode: "token", allowLoopbackBypass: false, tokenConfigured: true, basicConfigured: false },
      }),
    );
    const consumeTemporaryAuthCredential = vi.fn(async () => "private-token-value");
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      getSettings: vi.fn(async () => current),
      updateSettings,
      hasTemporaryAuthCredential: vi.fn(async () => true),
      consumeTemporaryAuthCredential,
      discardTemporaryAuthCredential: vi.fn(),
    });
    const request = {
      kind: "runtime_configuration" as const,
      change: {
        operation: "gateway_auth_configuration" as const,
        mode: "token" as const,
        allowLoopbackBypass: false,
        replaceCredential: true,
      },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.status).toBe("awaiting_input");
    expect(JSON.stringify(prepared)).not.toContain("private-token-value");
    const resumed = await adapter.resumeOwnerInput(
      context,
      {
        planId: "plan-auth",
        request,
      } as ChangePlanRecord,
      {
        actionId: "secure-1",
        actionKind: "secure_input",
        ownerId: "gateway_auth_temporary_secret",
        ownerResourceId: "gateway-auth",
        evidenceRefs: ["gateway-auth:temporary-credential-captured"],
      },
    );
    expect(resumed.status).toBe("awaiting_confirmation");
    await adapter.apply(context, {
      planId: "plan-auth",
      request,
      target: prepared.target,
    } as ChangePlanRecord);
    expect(consumeTemporaryAuthCredential).toHaveBeenCalledWith("plan-auth");
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      auth: { mode: "token", allowLoopbackBypass: false, token: "private-token-value" },
    });
  });
});
