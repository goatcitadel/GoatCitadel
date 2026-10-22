import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, WebSearchCredentialStatus } from "@goatcitadel/contracts";
import { settingsChangePlanRequest } from "../routes/dashboard-settings-change-plan.js";
import { RuntimeConfigurationChangePlanAdapter } from "./runtime-configuration-change-plan-adapter.js";
import {
  submitEvolutionWebSearchCredential,
  WEB_SEARCH_CREDENTIAL_OWNER_ID,
  type WebSearchCredentialChangeOwner,
} from "./web-search-credential-change.js";

const context = {
  origin: { surface: "settings", workspaceId: "default", actorId: "operator-1" },
  actions: {
    confirmation: (input: Record<string, unknown>) => ({
      kind: "confirmation",
      actionId: "a-1",
      actionNonce: "n-1",
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

function owner(configured = false) {
  let keychainConfigured = configured;
  const temporary = new Map<string, string>();
  const status = (): WebSearchCredentialStatus => ({
    targetId: "search.firecrawl",
    label: "Firecrawl",
    endpointHost: "api.firecrawl.dev",
    endpointAllowlisted: true,
    keychainAvailable: true,
    keychainConfigured,
    envNames: ["FIRECRAWL_API_KEY"],
    envConfigured: false,
    activeSource: keychainConfigured ? "keychain" : "none",
    acquisitionUrl: "https://www.firecrawl.dev/app/api-keys",
  });
  const credentials: WebSearchCredentialChangeOwner = {
    status: vi.fn(status),
    store: vi.fn(async () => {
      keychainConfigured = true;
      return status();
    }),
    clear: vi.fn(async () => {
      keychainConfigured = false;
      return status();
    }),
    holdTemporary: vi.fn((planId, secret) => void temporary.set(planId, secret)),
    hasTemporary: vi.fn((planId) => temporary.has(planId)),
    consumeTemporary: vi.fn((planId) => {
      const secret = temporary.get(planId)!;
      temporary.delete(planId);
      return secret;
    }),
    discardTemporary: vi.fn((planId) => void temporary.delete(planId)),
  };
  return credentials;
}

function adapter(credentials: WebSearchCredentialChangeOwner, engineOrder = ["duckduckgo", "bing", "google"]) {
  let current = { revision: 7, web: { search: { engineOrder } } } as any;
  const updateSettings = vi.fn(async (input: any) => {
    current = { ...current, revision: current.revision + 1, web: { ...current.web, ...input.web } };
    return current;
  });
  return {
    updateSettings,
    adapter: new RuntimeConfigurationChangePlanAdapter({
      getSettings: async () => current,
      updateSettings,
      hasTemporaryAuthCredential: () => false,
      consumeTemporaryAuthCredential: () => "",
      discardTemporaryAuthCredential: () => undefined,
      webSearchCredentials: credentials,
    }),
  };
}

const plan = (change: Record<string, unknown>, expectedRevision = 7) =>
  ({
    planId: "plan-1",
    revision: 3,
    request: { kind: "runtime_configuration", change },
    target: { ownerId: "runtime_settings", resourceId: "x", expectedRevision },
  }) as unknown as ChangePlanRecord;

describe("web-search Change Plans", () => {
  it("maps a Settings engine-order save to its own governed operation", () => {
    expect(
      settingsChangePlanRequest({ expectedRevision: 7, web: { search: { engineOrder: ["bing", "duckduckgo"] } } }),
    ).toEqual({
      kind: "runtime_configuration",
      change: { operation: "web_search_configuration", config: { engineOrder: ["bing", "duckduckgo"] } },
    });
    expect(
      settingsChangePlanRequest({
        expectedRevision: 7,
        web: { firecrawl: { enabled: true }, search: { engineOrder: ["bing"] } },
      }),
    ).toBeNull();
  });

  it("applies and verifies the engine order through the settings owner", async () => {
    const { adapter: runtime, updateSettings } = adapter(owner());
    const prepared = await runtime.prepare(context, {
      kind: "runtime_configuration",
      change: { operation: "web_search_configuration", config: { engineOrder: ["google", "bing"] } },
    });
    expect(prepared.summary).toBe("Search with google, then bing.");
    expect(prepared.requiredAction).toMatchObject({ kind: "confirmation" });

    const change = { operation: "web_search_configuration", config: { engineOrder: ["google", "bing"] } };
    await runtime.apply(context, plan(change));
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      web: { search: { engineOrder: ["google", "bing"] } },
    });
    await expect(runtime.verify(context, plan(change, 8))).resolves.toMatchObject({ status: "completed" });
  });

  it("refuses to prepare a Firecrawl plan the settings owner would reject at apply", async () => {
    const validateSettingsUpdate = vi.fn(async () => {
      throw new Error(
        "web.firecrawl.baseUrl must be present in the outbound allowlist before Firecrawl can be enabled",
      );
    });
    const runtime = new RuntimeConfigurationChangePlanAdapter({
      getSettings: async () => ({ revision: 7 }) as any,
      updateSettings: vi.fn(),
      validateSettingsUpdate,
      hasTemporaryAuthCredential: () => false,
      consumeTemporaryAuthCredential: () => "",
      discardTemporaryAuthCredential: () => undefined,
    });

    await expect(
      runtime.prepare(context, {
        kind: "runtime_configuration",
        change: { operation: "web_firecrawl_configuration", config: { baseUrl: "https://api.firecrawl.dev" } },
      }),
    ).rejects.toThrow("outbound allowlist");
    expect(validateSettingsUpdate).toHaveBeenCalledWith({
      expectedRevision: 7,
      web: { firecrawl: { baseUrl: "https://api.firecrawl.dev" } },
    });
  });

  it("asks for the key through secure input, then confirms, stores, and verifies it", async () => {
    const credentials = owner();
    const { adapter: runtime } = adapter(credentials);
    const change = { operation: "web_search_credential", targetId: "search.firecrawl", action: "replace" } as const;

    const prepared = await runtime.prepare(context, { kind: "runtime_configuration", change });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction).toMatchObject({ kind: "secure_input", targetId: "web-search:search.firecrawl" });
    expect(JSON.stringify(prepared)).not.toContain("fc-");

    const evolution = {
      get: vi.fn(
        async () => ({ ...plan(change), requiredAction: prepared.requiredAction }) as unknown as ChangePlanRecord,
      ),
      resumeOwnerInput: vi.fn(async (_actor, _planId, _revision, _nonce, receipt) => {
        const outcome = await runtime.resumeOwnerInput(context, plan(change), receipt);
        return { ...plan(change), ...outcome } as unknown as ChangePlanRecord;
      }),
    };
    const resumed = await submitEvolutionWebSearchCredential(evolution as never, credentials, {
      actor: { workspaceId: "default", actorId: "operator-1", surface: "settings" },
      planId: "plan-1",
      expectedRevision: 3,
      actionId: "secure-1",
      actionNonce: "secure-nonce-123456",
      apiKey: "fc-live-key",
    });
    expect(evolution.resumeOwnerInput.mock.calls[0]![4]).toMatchObject({
      ownerId: WEB_SEARCH_CREDENTIAL_OWNER_ID,
      ownerResourceId: "search.firecrawl",
    });
    expect(resumed.requiredAction).toMatchObject({ kind: "confirmation" });

    await runtime.apply(context, plan(change));
    expect(credentials.store).toHaveBeenCalledWith("search.firecrawl", "fc-live-key");
    expect(credentials.hasTemporary("plan-1")).toBe(false);
    await expect(runtime.verify(context, plan(change))).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects a stale secure-input action without holding the key", async () => {
    const credentials = owner();
    const change = { operation: "web_search_credential", targetId: "search.firecrawl", action: "replace" };
    const evolution = {
      get: vi.fn(async () => ({
        ...plan(change),
        requiredAction: {
          kind: "secure_input",
          actionId: "secure-1",
          actionNonce: "other",
          targetId: "web-search:search.firecrawl",
        },
      })),
      resumeOwnerInput: vi.fn(),
    };

    await expect(
      submitEvolutionWebSearchCredential(evolution as never, credentials, {
        actor: { workspaceId: "default", actorId: "operator-1", surface: "settings" },
        planId: "plan-1",
        expectedRevision: 3,
        actionId: "secure-1",
        actionNonce: "secure-nonce-123456",
        apiKey: "fc-live-key",
      }),
    ).rejects.toThrow("stale");
    expect(credentials.holdTemporary).not.toHaveBeenCalled();
  });

  it("removes a key after plain confirmation", async () => {
    const credentials = owner(true);
    const { adapter: runtime } = adapter(credentials);
    const change = { operation: "web_search_credential", targetId: "search.firecrawl", action: "remove" } as const;

    const prepared = await runtime.prepare(context, { kind: "runtime_configuration", change });
    expect(prepared.requiredAction).toMatchObject({ kind: "confirmation" });
    await runtime.apply(context, plan(change));
    expect(credentials.clear).toHaveBeenCalledWith("search.firecrawl");
    await expect(runtime.verify(context, plan(change))).resolves.toMatchObject({ status: "completed" });
  });
});
