import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ProviderConnectionChangePlanAdapter } from "./provider-connection-change-plan-adapter.js";

const context = {
  origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
  actions: {
    confirmation: (input: Record<string, unknown>) => ({
      kind: "confirmation",
      actionId: "confirm-1",
      actionNonce: "nonce-confirm",
      purpose: "apply",
      ...input,
    }),
    secureInput: (input: Record<string, unknown>) => ({
      kind: "secure_input",
      actionId: "secure-1",
      actionNonce: "nonce-secure",
      ...input,
    }),
    oauth: (input: Record<string, unknown>) => ({
      kind: "oauth",
      actionId: "oauth-1",
      actionNonce: "nonce-oauth",
      ...input,
    }),
  },
} as any;

function runtimeSettings(authReadiness: "missing" | "ready" = "missing") {
  return {
    revision: 5,
    llm: {
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          authMode: "api-key",
          authReadiness: { status: authReadiness },
        },
      ],
    },
  } as any;
}

function claudeCodeSettings(authReadiness: "missing" | "ready" = "missing") {
  return {
    revision: 5,
    llm: {
      providers: [
        {
          providerId: "claude-code",
          label: "Claude Code (Claude subscription)",
          authMode: "claude-code-oauth",
          authReadiness: { status: authReadiness },
        },
      ],
    },
  } as any;
}

describe("ProviderConnectionChangePlanAdapter", () => {
  it("uses a dedicated secure-input action and retains no credential material", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings()),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const prepared = await adapter.prepare(context, { kind: "provider_connection", providerId: "openai" });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("secure_input");
    expect(JSON.stringify(prepared)).not.toMatch(/api.?key|credentialValue|password/iu);
  });

  it("binds the secure owner receipt before presenting final confirmation", async () => {
    const hasTemporarySecret = vi.fn(async () => true);
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings()),
      updateSettings: vi.fn(),
      hasTemporarySecret,
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const outcome = await adapter.resumeOwnerInput(
      context,
      {
        planId: "plan-1",
        request: { kind: "provider_connection", providerId: "openai" },
      } as ChangePlanRecord,
      {
        actionId: "secure-1",
        actionKind: "secure_input",
        ownerId: "provider_temporary_secret",
        ownerResourceId: "openai",
        ownerRevision: 1,
        evidenceRefs: ["provider-probe:openai:ready"],
      },
    );
    expect(hasTemporarySecret).toHaveBeenCalledWith("plan-1", "openai");
    expect(outcome.status).toBe("awaiting_confirmation");
    expect(outcome.requiredAction?.kind).toBe("confirmation");
  });

  it("does not replay credential promotion during recovery", async () => {
    const promoteTemporarySecret = vi.fn();
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(),
      promoteTemporarySecret,
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(async () => ({ evidenceRefs: ["provider-catalog:openai:live"] })),
    });
    const outcome = await adapter.reconcile(context, {
      planId: "plan-1",
      request: { kind: "provider_connection", providerId: "openai" },
    } as ChangePlanRecord);
    expect(outcome.effectObserved).toBe(true);
    expect(promoteTemporarySecret).not.toHaveBeenCalled();
  });

  it("confirms a new secret-free profile before asking the dedicated credential owner", async () => {
    let settings = { ...runtimeSettings(), llm: { providers: [] } } as any;
    const updateSettings = vi.fn(async () => {
      settings = runtimeSettings();
      return settings;
    });
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => settings),
      updateSettings,
      getProviderConfig: () => undefined,
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const request = {
      kind: "provider_connection" as const,
      providerId: "openai",
      profile: {
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses" as const,
        authMode: "api-key" as const,
        defaultModel: "gpt-5",
      },
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.status).toBe("awaiting_confirmation");

    const outcome = await adapter.apply(context, {
      planId: "plan-profile",
      request,
      target: prepared.target,
    } as ChangePlanRecord);

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 5,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai", authMode: "api-key" }) },
      }),
    );
    expect(outcome.status).toBe("awaiting_input");
    expect(outcome.requiredAction?.kind).toBe("secure_input");
  });

  it("requires dedicated secure input when replacing an already-ready API key", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const prepared = await adapter.prepare(context, {
      kind: "provider_connection",
      providerId: "openai",
      credentialAction: "replace_api_key",
      credentialStorage: "keychain",
    });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("secure_input");
  });

  it("removes only the exact approved API-key scope and verifies owner state", async () => {
    const removeProviderApiKey = vi.fn(async () => ({ revision: 6, evidenceRefs: ["secret-owner:6"] }));
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey,
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const request = {
      kind: "provider_connection" as const,
      providerId: "openai",
      credentialAction: "remove_api_key" as const,
      credentialDeleteScope: "all" as const,
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.risk).toBe("caution");
    const applied = await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(removeProviderApiKey).toHaveBeenCalledWith("openai", 5, "all");
    expect(applied.status).toBe("verifying");
    await expect(adapter.verify(context, { request } as ChangePlanRecord)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("promotes a plan-bound OAuth credential only from the confirmed apply hook", async () => {
    const settings = {
      revision: 5,
      llm: {
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            authMode: "codex-oauth",
            oauthStatus: { connected: false },
          },
        ],
      },
    } as any;
    const promoteTemporaryOAuthCredential = vi.fn(async () => ({
      revision: 5,
      evidenceRefs: ["oauth-owner:promoted"],
    }));
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      hasTemporaryOAuthCredential: vi.fn(async () => true),
      promoteTemporarySecret: vi.fn(),
      promoteTemporaryOAuthCredential,
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      discardTemporaryOAuthCredential: vi.fn(),
      verifyProvider: vi.fn(async () => ({ evidenceRefs: ["provider:openai-codex:verified"] })),
    });
    const request = { kind: "provider_connection" as const, providerId: "openai-codex" };
    const prepared = await adapter.prepare(context, request);
    expect(prepared.requiredAction?.kind).toBe("oauth");
    const resumed = await adapter.resumeOwnerInput(
      context,
      {
        planId: "plan-oauth",
        request,
      } as ChangePlanRecord,
      {
        actionId: "oauth-1",
        actionKind: "oauth",
        ownerId: "provider_oauth",
        ownerResourceId: "openai-codex",
        evidenceRefs: ["oauth-exchange:verified"],
      },
    );
    expect(resumed.status).toBe("awaiting_confirmation");
    expect(promoteTemporaryOAuthCredential).not.toHaveBeenCalled();

    const applied = await adapter.apply(context, {
      planId: "plan-oauth",
      request,
      target: prepared.target,
    } as ChangePlanRecord);
    expect(promoteTemporaryOAuthCredential).toHaveBeenCalledWith("plan-oauth", "openai-codex", 5);
    expect(applied.status).toBe("verifying");
  });

  it("stages OAuth replacement without disturbing the active credential before confirmation", async () => {
    const settings = {
      revision: 5,
      llm: {
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            authMode: "codex-oauth",
            oauthStatus: { connected: true },
          },
        ],
      },
    } as any;
    const promoteTemporaryOAuthCredential = vi.fn();
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      hasTemporaryOAuthCredential: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      promoteTemporaryOAuthCredential,
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      discardTemporaryOAuthCredential: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const prepared = await adapter.prepare(context, {
      kind: "provider_connection",
      providerId: "openai-codex",
      credentialAction: "replace_oauth",
    });
    expect(prepared).toMatchObject({
      status: "awaiting_input",
      requiredAction: { kind: "oauth" },
    });
    expect(promoteTemporaryOAuthCredential).not.toHaveBeenCalled();
  });

  it("governs canonical OAuth disconnect as a caution plan", async () => {
    const settings = {
      revision: 5,
      llm: {
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            authMode: "codex-oauth",
            oauthStatus: { connected: true },
          },
        ],
      },
    } as any;
    const removeProviderOAuthCredential = vi.fn(async () => ({
      revision: 5,
      evidenceRefs: ["oauth-owner:removed"],
    }));
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      removeProviderOAuthCredential,
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      getProviderOAuthCredentialStatus: vi.fn(() => ({ connected: false })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const request = {
      kind: "provider_connection" as const,
      providerId: "openai-codex",
      credentialAction: "remove_oauth" as const,
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared).toMatchObject({ risk: "caution", status: "awaiting_confirmation" });
    const applied = await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(removeProviderOAuthCredential).toHaveBeenCalledWith("openai-codex", 5);
    expect(applied.status).toBe("verifying");
  });

  it("routes the claude-code pasted token through secure input instead of the codex OAuth lifecycle", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => claudeCodeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const prepared = await adapter.prepare(context, {
      kind: "provider_connection",
      providerId: "claude-code",
      credentialAction: "replace_api_key",
      credentialStorage: "keychain",
    });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("secure_input");
  });

  it("connects an unconfigured claude-code provider through secure input, not an OAuth action", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => claudeCodeSettings("missing")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const prepared = await adapter.prepare(context, { kind: "provider_connection", providerId: "claude-code" });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("secure_input");
  });

  it("promotes the claude-code token through the secret owner and verifies the live catalog", async () => {
    const promoteTemporarySecret = vi.fn(async () => ({ revision: 6, evidenceRefs: ["secret-owner:6"] }));
    const promoteTemporaryOAuthCredential = vi.fn();
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => claudeCodeSettings("missing")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => true),
      hasTemporaryOAuthCredential: vi.fn(async () => true),
      promoteTemporarySecret,
      promoteTemporaryOAuthCredential,
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      discardTemporaryOAuthCredential: vi.fn(),
      verifyProvider: vi.fn(async () => ({ evidenceRefs: ["provider-catalog:claude-code:live"] })),
    });
    const request = {
      kind: "provider_connection" as const,
      providerId: "claude-code",
      credentialAction: "replace_api_key" as const,
      credentialStorage: "keychain" as const,
    };
    const applied = await adapter.apply(context, {
      planId: "plan-claude",
      request,
      target: { ownerId: "provider_connection", resourceId: "claude-code", expectedRevision: 5 },
    } as ChangePlanRecord);
    expect(promoteTemporarySecret).toHaveBeenCalledWith("plan-claude", "claude-code", 5, "keychain", undefined);
    expect(promoteTemporaryOAuthCredential).not.toHaveBeenCalled();
    expect(applied.status).toBe("verifying");
  });

  it("removes the claude-code token through the API-key owner", async () => {
    const removeProviderApiKey = vi.fn(async () => ({ revision: 6, evidenceRefs: ["secret-owner:6"] }));
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => claudeCodeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey,
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const request = {
      kind: "provider_connection" as const,
      providerId: "claude-code",
      credentialAction: "remove_api_key" as const,
      credentialDeleteScope: "all" as const,
    };
    const prepared = await adapter.prepare(context, request);
    expect(prepared).toMatchObject({ risk: "caution", status: "awaiting_confirmation" });
    const applied = await adapter.apply(context, { request, target: prepared.target } as ChangePlanRecord);
    expect(removeProviderApiKey).toHaveBeenCalledWith("claude-code", 5, "all");
    expect(applied.status).toBe("verifying");
  });

  it("rejects OAuth-lifecycle actions for claude-code because its lifecycle is token-based", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => claudeCodeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    await expect(
      adapter.prepare(context, {
        kind: "provider_connection",
        providerId: "claude-code",
        credentialAction: "replace_oauth",
      }),
    ).rejects.toThrow(/OAuth replacement requires an OAuth-backed provider/u);
    await expect(
      adapter.prepare(context, {
        kind: "provider_connection",
        providerId: "claude-code",
        credentialAction: "remove_oauth",
      }),
    ).rejects.toThrow(/OAuth removal requires an OAuth-backed provider/u);
  });

  it("still forces the dedicated OAuth lifecycle for codex API-key actions", async () => {
    const settings = {
      revision: 5,
      llm: {
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            authMode: "codex-oauth",
            oauthStatus: { connected: true },
          },
        ],
      },
    } as any;
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    await expect(
      adapter.prepare(context, {
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "replace_api_key",
      }),
    ).rejects.toThrow(/dedicated OAuth lifecycle/u);
  });

  it("fails closed when OAuth removal cannot be proven from the OAuth owner", async () => {
    const adapter = new ProviderConnectionChangePlanAdapter({
      getSettings: vi.fn(async () => runtimeSettings("ready")),
      updateSettings: vi.fn(),
      hasTemporarySecret: vi.fn(async () => false),
      promoteTemporarySecret: vi.fn(),
      removeProviderApiKey: vi.fn(),
      getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: false, source: "none" })),
      getProviderOAuthCredentialStatus: vi.fn(() => ({ connected: true })),
      discardTemporarySecret: vi.fn(),
      verifyProvider: vi.fn(),
    });
    const plan = {
      request: {
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "remove_oauth",
      },
    } as ChangePlanRecord;
    await expect(adapter.verify(context, plan)).resolves.toMatchObject({
      status: "manual_required",
      result: { failureCode: "provider_oauth_removal_failed" },
    });
    await expect(adapter.reconcile(context, plan)).resolves.toMatchObject({
      effectObserved: false,
      status: "manual_required",
    });
  });
});
