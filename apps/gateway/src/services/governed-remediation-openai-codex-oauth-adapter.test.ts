import { createHash } from "node:crypto";
import { normalizeGovernedRemediationRecipe, type GovernedRemediationScope } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OpenAICodexOAuthStatus } from "./openai-codex-oauth-service.js";
import {
  GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE,
  GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_REGISTRATION,
  GovernedRemediationOpenAICodexOAuthAdapter,
  governedOpenAICodexOAuthRecipeSha256,
  governedOpenAICodexOAuthScope,
} from "./governed-remediation-openai-codex-oauth-adapter.js";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationOwnerPort,
} from "./governed-remediation-registry.js";

describe("GovernedRemediationOpenAICodexOAuthAdapter", () => {
  it("registers an exact manual-only OAuth recipe with no callable owner", () => {
    expect(normalizeGovernedRemediationRecipe(GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE)).toEqual(
      GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE,
    );
    expect(GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_REGISTRATION.owner).toBeNull();
    expect(GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE).toMatchObject({
      repairClass: "oauth_connection",
      executionMode: "manual_required",
      inputKind: "none",
      preEffectApproval: "not_applicable",
      verificationProbeId: null,
      rollbackStrategy: "manual_required",
      maxApplyAttempts: 0,
    });

    const registry = new GovernedRemediationRecipeRegistry([GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_REGISTRATION]);
    for (const deploymentProfile of ["local_dev", "trusted_local", "remote_hardened"] as const) {
      const resolution = registry.resolve({
        recipeId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.recipeId,
        recipeVersion: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.recipeVersion,
        targetId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.targetId,
        requestedCapabilityId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.requestedCapabilityId,
        deploymentProfile,
        scope: scope(),
      });
      expect(resolution.owner).toBeNull();
      expect(resolution.recipeSha256).toBe(governedOpenAICodexOAuthRecipeSha256());
    }
  });

  it("rejects attempts to attach a callable owner to the manual OAuth recipe", () => {
    const injectedOwner = {
      ownerId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.ownerId,
      targetId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.targetId,
      requestedCapabilityId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.requestedCapabilityId,
      activationMode: "not_applicable",
    } as unknown as GovernedRemediationOwnerPort;

    expect(
      () =>
        new GovernedRemediationRecipeRegistry([
          { recipe: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE, owner: injectedOwner },
        ]),
    ).toThrow(/Manual remediation recipes cannot have callable owners/u);
  });

  it("publishes only coarse local owner state and drops token, account, expiry, and error material", () => {
    const secretCanary = "test-only-openai-oauth-access-token-canary-4091";
    const refreshCanary = "test-only-openai-oauth-refresh-token-canary-4092";
    const accountCanary = "personal-address-canary@example.test";
    const errorCanary = "provider-error-canary-with-authorization-code-4093";
    const exactExpiry = "2032-03-04T05:06:07.000Z";
    const getStatus = vi.fn(
      () =>
        ({
          providerId: "openai-codex",
          available: true,
          connected: true,
          accountLabel: accountCanary,
          expiresAt: exactExpiry,
          requiresReauth: false,
          accessToken: secretCanary,
          refreshToken: refreshCanary,
          providerError: errorCanary,
        }) as OpenAICodexOAuthStatus,
    );
    const mutation = vi.fn();
    const adapter = new GovernedRemediationOpenAICodexOAuthAdapter(
      { getStatus, startDeviceFlow: mutation, pollDeviceFlow: mutation, deleteCredential: mutation } as never,
      () => Date.parse("2030-01-01T00:00:00.000Z"),
    );

    const assessment = adapter.assess({ deploymentProfile: "trusted_local", scope: scope() });

    expect(assessment).toMatchObject({
      status: "not_required",
      ownerRevision: null,
      automaticExecution: false,
      observation: {
        secretStore: "available",
        credential: "present",
        credentialExpiry: "future",
        accountLabelPresent: true,
        liveProbe: "unavailable",
      },
    });
    expect(getStatus).toHaveBeenCalledOnce();
    expect(mutation).not.toHaveBeenCalled();

    const serialized = JSON.stringify(assessment);
    for (const forbidden of [secretCanary, refreshCanary, accountCanary, errorCanary, exactExpiry]) {
      expect(serialized).not.toContain(forbidden);
      expect(serialized).not.toContain(createHash("sha256").update(forbidden, "utf8").digest("hex"));
    }
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("providerError");
    expect(serialized).not.toContain("keychain:");
  });

  it.each([
    [
      "unavailable keychain",
      status({ available: false, connected: false }),
      "secret_store_unavailable",
      { secretStore: "unavailable", credential: "unknown", accountLabelPresent: null },
    ],
    [
      "missing credential",
      status({ connected: false }),
      "oauth_credential_missing",
      { secretStore: "available", credential: "missing" },
    ],
    [
      "owner-requested reauthentication",
      status({ connected: false, requiresReauth: true }),
      "oauth_reauthentication_required",
      { secretStore: "available", credential: "reauth_required" },
    ],
  ] as const)("classifies %s without entering the interactive owner", (_label, ownerStatus, reason, observation) => {
    const getStatus = vi.fn(() => ownerStatus);
    const adapter = new GovernedRemediationOpenAICodexOAuthAdapter({ getStatus });

    expect(adapter.assess({ deploymentProfile: "local_dev", scope: scope() })).toMatchObject({
      status: "manual_required",
      reason,
      ownerRevision: null,
      automaticExecution: false,
      observation,
    });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("fails closed without serializing an owner exception", () => {
    const errorCanary = "test-only-keychain-error-canary-4094";
    const adapter = new GovernedRemediationOpenAICodexOAuthAdapter({
      getStatus: () => {
        throw new Error(errorCanary);
      },
    });

    const assessment = adapter.assess({ deploymentProfile: "remote_hardened", scope: scope() });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "owner_status_unavailable",
      ownerRevision: null,
      automaticExecution: false,
      observation: {
        secretStore: "unknown",
        credential: "unknown",
        credentialExpiry: "unknown",
        accountLabelPresent: null,
        liveProbe: "unavailable",
      },
    });
    expect(JSON.stringify(assessment)).not.toContain(errorCanary);
  });

  it("fails closed when a status reader is bound to a different provider", () => {
    const adapter = new GovernedRemediationOpenAICodexOAuthAdapter({
      getStatus: () => ({ ...status(), providerId: "foreign-provider" }) as never,
    });

    expect(adapter.assess({ deploymentProfile: "trusted_local", scope: scope() })).toMatchObject({
      status: "manual_required",
      reason: "owner_status_unavailable",
      observation: { secretStore: "unknown", credential: "unknown" },
    });
  });

  it("keeps OAuth recovery installation-scoped and rejects mismatched authority", () => {
    const adapter = new GovernedRemediationOpenAICodexOAuthAdapter({ getStatus: () => status({ connected: false }) });
    const base = scope();

    expect(() =>
      adapter.assess({
        deploymentProfile: "trusted_local",
        scope: { ...base, scopeKind: "workspace" },
      }),
    ).toThrow(/scope kind is not allowlisted/u);
    expect(() =>
      adapter.assess({
        deploymentProfile: "trusted_local",
        scope: { ...base, targetId: "gateway.llm.provider.foreign.oauth-owner" },
      }),
    ).toThrow(/target does not match/u);
  });
});

function scope(): GovernedRemediationScope {
  return governedOpenAICodexOAuthScope({
    deploymentId: "deployment-test",
    installationId: "installation-test",
  });
}

function status(overrides: Partial<OpenAICodexOAuthStatus> = {}): OpenAICodexOAuthStatus {
  return {
    providerId: "openai-codex",
    available: true,
    connected: true,
    ...overrides,
  };
}
