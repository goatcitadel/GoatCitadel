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
    defaultToolProfile: "standard",
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
