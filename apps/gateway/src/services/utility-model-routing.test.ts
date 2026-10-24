import { describe, expect, it, vi } from "vitest";
import {
  resolveBackgroundJobModel,
  resolveBackgroundJobModelDefaults,
  resolveJudgeModelDefaults,
  resolveUtilityModelOverride,
} from "./utility-model-routing.js";

const provider = { providerId: "glm", hasApiKey: true, defaultModel: "glm-5" };

describe("resolveUtilityModelOverride", () => {
  it("returns undefined when the flag is off", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: false,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no utility provider is configured", () => {
    expect(resolveUtilityModelOverride({ flagEnabled: true, provider })).toBeUndefined();
    expect(resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "  ", provider })).toBeUndefined();
  });

  it("returns undefined when the provider is unknown or mismatched", () => {
    expect(
      resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "glm", utilityModel: "x" }),
    ).toBeUndefined();
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        provider: { ...provider, providerId: "moonshot" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the provider has no API key", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider: { ...provider, hasApiKey: false },
      }),
    ).toBeUndefined();
  });

  it("returns the configured utility model when all preconditions hold", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider,
      }),
    ).toEqual({ providerId: "glm", model: "glm-4-flash" });
  });

  it("falls back to the provider default model when no utility model is set", () => {
    expect(resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "glm", provider })).toEqual({
      providerId: "glm",
      model: "glm-5",
    });
  });

  it("returns undefined when neither a utility model nor a default model exists", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        provider: { ...provider, defaultModel: "" },
      }),
    ).toBeUndefined();
  });
});

describe("resolveJudgeModelDefaults", () => {
  const codex = {
    providerId: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    hasApiKey: true,
    defaultModel: "gpt-6-sol",
  };
  const cli = { providerId: "claude-code-cli", baseUrl: "", hasApiKey: true, defaultModel: "claude-sonnet-5-5" };
  const ollama = {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    hasApiKey: false,
    defaultModel: "llama3",
  };

  it("prefers the ready active provider over a signed-in Codex account", () => {
    expect(
      resolveJudgeModelDefaults({
        activeProviderId: "claude-code-cli",
        activeModel: "claude-opus-5-5",
        providers: [codex, cli],
      }),
    ).toEqual({ providerId: "claude-code-cli", model: "claude-opus-5-5" });
  });

  it("uses the active provider's default model when no active model is set", () => {
    expect(
      resolveJudgeModelDefaults({ activeProviderId: "claude-code-cli", activeModel: "", providers: [codex, cli] }),
    ).toEqual({ providerId: "claude-code-cli", model: "claude-sonnet-5-5" });
  });

  it("falls back to Codex with its configured default model, never a hard-coded one", () => {
    expect(
      resolveJudgeModelDefaults({
        activeProviderId: "claude-code-cli",
        activeModel: "claude-opus-5-5",
        providers: [codex, { ...cli, hasApiKey: false }],
      }),
    ).toEqual({ providerId: "openai-codex", model: "gpt-6-sol" });
  });

  it("returns the active provider when no keyed fallback exists", () => {
    expect(
      resolveJudgeModelDefaults({
        activeProviderId: "ollama",
        activeModel: "qwen3",
        providers: [ollama],
      }),
    ).toEqual({ providerId: "ollama", model: "qwen3" });
  });

  it("keeps a keyless active provider on this machine ahead of a signed-in Codex account", () => {
    expect(
      resolveJudgeModelDefaults({ activeProviderId: "ollama", activeModel: "qwen3", providers: [codex, ollama] }),
    ).toEqual({ providerId: "ollama", model: "qwen3" });
  });

  it("does not treat a keyless remote active provider as ready", () => {
    expect(
      resolveJudgeModelDefaults({
        activeProviderId: "ollama",
        activeModel: "qwen3",
        providers: [codex, { ...ollama, baseUrl: "https://ollama.example.com/v1" }],
      }),
    ).toEqual({ providerId: "openai-codex", model: "gpt-6-sol" });
  });
});

describe("resolveBackgroundJobModelDefaults", () => {
  const codex = {
    providerId: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    hasApiKey: true,
    defaultModel: "gpt-6-sol",
  };
  const cli = { providerId: "claude-code-cli", baseUrl: "", hasApiKey: true, defaultModel: "claude-sonnet-5-5" };
  const ollama = {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    hasApiKey: false,
    defaultModel: "llama3",
  };

  it("uses the ready active provider", () => {
    expect(
      resolveBackgroundJobModelDefaults({
        activeProviderId: "claude-code-cli",
        activeModel: "claude-opus-5-5",
        providers: [codex, cli],
      }),
    ).toEqual({ providerId: "claude-code-cli", model: "claude-opus-5-5" });
  });

  it("skips instead of falling back to a signed-in Codex account when the active provider is not ready", () => {
    expect(
      resolveBackgroundJobModelDefaults({
        activeProviderId: "claude-code-cli",
        activeModel: "claude-opus-5-5",
        providers: [codex, { ...cli, hasApiKey: false }],
      }),
    ).toBeUndefined();
  });

  it("keeps a keyless active provider on this machine", () => {
    expect(
      resolveBackgroundJobModelDefaults({
        activeProviderId: "ollama",
        activeModel: "qwen3",
        providers: [codex, ollama],
      }),
    ).toEqual({ providerId: "ollama", model: "qwen3" });
  });

  it("skips a keyless remote active provider", () => {
    expect(
      resolveBackgroundJobModelDefaults({
        activeProviderId: "ollama",
        activeModel: "qwen3",
        providers: [codex, { ...ollama, baseUrl: "https://ollama.example.com/v1" }],
      }),
    ).toBeUndefined();
  });

  it("skips when the active provider has no model or is not configured", () => {
    expect(
      resolveBackgroundJobModelDefaults({
        activeProviderId: "claude-code-cli",
        activeModel: "",
        providers: [codex, { ...cli, defaultModel: "" }],
      }),
    ).toBeUndefined();
    expect(
      resolveBackgroundJobModelDefaults({ activeProviderId: "missing", activeModel: "x", providers: [codex] }),
    ).toBeUndefined();
  });
});

describe("resolveBackgroundJobModel", () => {
  // A probe-backed API provider whose readiness is unknown until its check runs.
  const notReadyProbed = {
    activeProviderId: "probe-backed",
    activeModel: "probe-model",
    providers: [
      {
        providerId: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        hasApiKey: true,
        defaultModel: "gpt-6-sol",
        apiStyle: "openai-codex-responses" as const,
      },
      {
        providerId: "probe-backed",
        baseUrl: "https://api.example.invalid/v1",
        hasApiKey: false,
        defaultModel: "probe-model",
        apiStyle: "openai-chat-completions" as const,
      },
    ],
  };
  const signedInCli = {
    activeProviderId: "claude-code-cli",
    activeModel: "claude-opus-5-5",
    providers: [
      {
        providerId: "claude-code-cli",
        baseUrl: "",
        hasApiKey: true,
        defaultModel: "claude-sonnet-5-5",
        apiStyle: "claude-code-cli" as const,
      },
    ],
  };

  it("lets an explicit utility-model override win without probing the active provider", async () => {
    const ensureActiveProviderReadiness = vi.fn(async () => undefined);
    await expect(
      resolveBackgroundJobModel({
        getUtilityModelOverride: async () => ({ providerId: "openai-codex", model: "gpt-6-mini" }),
        ensureActiveProviderReadiness,
        getRuntimeConfig: () => signedInCli,
      }),
    ).resolves.toEqual({ providerId: "openai-codex", model: "gpt-6-mini" });
    expect(ensureActiveProviderReadiness).not.toHaveBeenCalled();
  });

  it("skips background jobs on the Claude Code CLI without probing it, because each call starts a CLI process (#493)", async () => {
    // Live: every plain turn ran the follow-up classifier, and every fifth turn two background-review
    // calls, each as its own CLI process on the operator's subscription.
    const ensureActiveProviderReadiness = vi.fn(async () => undefined);
    await expect(
      resolveBackgroundJobModel({
        getUtilityModelOverride: async () => undefined,
        ensureActiveProviderReadiness,
        getRuntimeConfig: () => signedInCli,
      }),
    ).resolves.toBeUndefined();
    expect(ensureActiveProviderReadiness).not.toHaveBeenCalled();
  });

  it("probes the active provider before deciding, so a not-yet-checked provider is used once it is ready", async () => {
    let probed = false;
    const result = await resolveBackgroundJobModel({
      getUtilityModelOverride: async () => undefined,
      ensureActiveProviderReadiness: async () => {
        probed = true;
      },
      getRuntimeConfig: () =>
        probed
          ? {
              ...notReadyProbed,
              providers: notReadyProbed.providers.map((item) => ({ ...item, hasApiKey: true })),
            }
          : notReadyProbed,
    });
    expect(result).toEqual({ providerId: "probe-backed", model: "probe-model" });
  });

  it("skips when the active provider is still not ready after the probe", async () => {
    await expect(
      resolveBackgroundJobModel({
        getUtilityModelOverride: async () => undefined,
        ensureActiveProviderReadiness: async () => undefined,
        getRuntimeConfig: () => notReadyProbed,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips rather than failing when the readiness probe itself throws", async () => {
    await expect(
      resolveBackgroundJobModel({
        getUtilityModelOverride: async () => undefined,
        ensureActiveProviderReadiness: async () => {
          throw new Error("probe failed");
        },
        getRuntimeConfig: () => notReadyProbed,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the probe throws even though an earlier probe still projects ready", async () => {
    const staleReady = {
      ...notReadyProbed,
      providers: notReadyProbed.providers.map((item) => ({ ...item, hasApiKey: true })),
    };
    await expect(
      resolveBackgroundJobModel({
        getUtilityModelOverride: async () => undefined,
        ensureActiveProviderReadiness: async () => {
          throw new Error("probe timed out");
        },
        getRuntimeConfig: () => staleReady,
      }),
    ).resolves.toBeUndefined();
  });
});
