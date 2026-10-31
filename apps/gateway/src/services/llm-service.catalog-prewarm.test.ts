import { describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { ClaudeCodeCliReadiness } from "./claude-code-cli-readiness.js";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

function createSecretStore(keys: Record<string, string>) {
  const getProviderApiKey = vi.fn((providerId: string) => keys[providerId]);
  const store = {
    isAvailable: () => true,
    setProviderApiKey: () => undefined,
    getProviderApiKey,
    deleteProviderApiKey: () => undefined,
    setSecret: () => undefined,
    getSecret: () => undefined,
    deleteSecret: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: Boolean(keys[providerId]), source: "keychain" }),
  } as unknown as SecretStoreService;
  return { store, getProviderApiKey };
}

function buildConfig(activeProviderId: string): LlmConfigFile {
  return {
    activeProviderId,
    activeModel: "",
    providers: [
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-sonnet-5-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      {
        providerId: "mistral",
        label: "Mistral",
        baseUrl: "https://api.mistral.ai/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "mistral-small-latest",
        apiKeyEnv: "MISTRAL_API_KEY",
      },
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      {
        providerId: "claude-code-cli",
        label: "Claude Code CLI (local login)",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "claude-code-cli",
        defaultModel: "claude-sonnet-5-5",
        authMode: "claude-code-cli-login",
      },
    ],
  };
}

function cliReadiness(loggedIn: boolean) {
  const run = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }),
  }));
  return { readiness: new ClaudeCodeCliReadiness({ run }), run };
}

describe("LlmService.resolveCatalogPrewarmTargets", () => {
  it("adds the active provider's saved keychain key, which the quick boot listing misses", async () => {
    const { store, getProviderApiKey } = createSecretStore({ anthropic: "sk-ant", openai: "sk-openai" });
    const service = new LlmService(
      buildConfig("anthropic"),
      { MISTRAL_API_KEY: "mistral-env" },
      {
        secretStore: store,
        claudeCli: { readiness: cliReadiness(true).readiness },
      },
    );

    const quick = service.getRuntimeConfig({ useCache: true }).providers.filter((p) => p.hasApiKey);
    expect(quick.map((p) => p.providerId)).toEqual(["mistral"]);

    await expect(service.resolveCatalogPrewarmTargets()).resolves.toEqual({
      activeProviderId: "anthropic",
      providerIds: ["anthropic", "mistral"],
    });
    // Each keychain read is a blocking OS call on Windows: only the active provider's key is read.
    expect(getProviderApiKey.mock.calls.map(([providerId]) => providerId)).toEqual(["anthropic"]);
  });

  it("probes the active Claude Code CLI sign-in instead of reporting it unprobed", async () => {
    const { store } = createSecretStore({});
    const { readiness, run } = cliReadiness(true);
    const service = new LlmService(
      buildConfig("claude-code-cli"),
      { MISTRAL_API_KEY: "mistral-env" },
      {
        secretStore: store,
        claudeCli: { readiness },
      },
    );

    await expect(service.resolveCatalogPrewarmTargets()).resolves.toEqual({
      activeProviderId: "claude-code-cli",
      providerIds: ["claude-code-cli", "mistral"],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves a signed-out active Claude Code CLI out of the warm set", async () => {
    const { store } = createSecretStore({});
    const service = new LlmService(
      buildConfig("claude-code-cli"),
      { MISTRAL_API_KEY: "mistral-env" },
      {
        secretStore: store,
        claudeCli: { readiness: cliReadiness(false).readiness },
      },
    );

    await expect(service.resolveCatalogPrewarmTargets()).resolves.toEqual({
      activeProviderId: "claude-code-cli",
      providerIds: ["mistral"],
    });
  });

  it("does not probe the Claude Code CLI when another provider is active", async () => {
    const { store } = createSecretStore({});
    const { readiness, run } = cliReadiness(true);
    const service = new LlmService(
      buildConfig("mistral"),
      { MISTRAL_API_KEY: "mistral-env" },
      {
        secretStore: store,
        claudeCli: { readiness },
      },
    );

    await expect(service.resolveCatalogPrewarmTargets()).resolves.toEqual({
      activeProviderId: "mistral",
      providerIds: ["mistral"],
    });
    expect(run).not.toHaveBeenCalled();
  });
});
