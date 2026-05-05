import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { getSettings, updateSettings, type SettingsRuntimeDependencies } from "./settings-auth-service.js";

function buildHost(): SettingsRuntimeDependencies {
  let flags = {
    durableKernelV1Enabled: true,
    replayOverridesV1Enabled: false,
    memoryLifecycleAdminV1Enabled: false,
    memoryLifecycleAutoForgetEnabled: true,
    memoryMaintenanceV1Enabled: false,
    connectorDiagnosticsV1Enabled: false,
    computerUseGuardrailsV1Enabled: true,
    bankrBuiltinEnabled: false,
    cronReviewQueueV1Enabled: false,
    replayRegressionV1Enabled: false,
    codeModeV1Enabled: false,
    improvementLedgerV1Enabled: false,
    improvementActivationV1Enabled: false,
  };

  return {
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: {
        environment: "local",
        deploymentProfile: "local_dev",
        workspaceDir: "./workspace",
        approvalExplainer: {
          enabled: true,
        },
        memory: {
          enabled: true,
          qmd: {
            enabled: true,
            applyToChat: true,
            applyToOrchestration: true,
            minPromptChars: 48,
            maxContextTokens: 1400,
            cacheTtlSeconds: 300,
            distiller: {
              providerId: undefined,
              model: undefined,
            },
          },
        },
        web: {
          firecrawl: {
            enabled: false,
            baseUrl: "http://127.0.0.1:3002",
            apiKeyEnv: undefined,
            timeoutMs: 20000,
            defaultReadBackend: "native",
            fallbackToNative: true,
          },
        },
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
          token: {},
          basic: {},
        },
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "node-1",
          discovery: {
            mdns: true,
            staticPeers: [],
          },
          security: {
            requireMtls: true,
            tailnet: {
              enabled: false,
            },
          },
        },
        npu: {
          enabled: false,
          autoStart: false,
          sidecar: {
            baseUrl: "http://127.0.0.1:11440",
          },
        },
        llamaCpp: {
          enabled: false,
          autoStart: false,
          server: {
            baseUrl: "http://127.0.0.1:8080/v1",
            command: "llama-server",
            extraArgs: [],
          },
          launch: {
            modelsRootPath: undefined,
            modelPath: undefined,
            alias: "llama",
            ctxSize: undefined,
            threads: undefined,
            gpuLayers: undefined,
            parallel: undefined,
            batchSize: undefined,
            ubatchSize: undefined,
            flashAttention: undefined,
          },
        },
      },
      toolPolicy: {
        tools: {
          profile: "minimal",
        },
        profiles: {
          minimal: [],
        },
        sandbox: {
          writeJailRoots: [],
          readOnlyRoots: [],
          readAccessMode: "roots_only",
          networkAllowlist: [],
        },
      },
      budgets: {
        mode: "balanced",
      },
    } as never,
    llmService: {
      deleteProviderApiKey: vi.fn(),
      getRuntimeConfig: vi.fn(() => ({ providers: [] })),
      getProviderSecretStatus: vi.fn(),
      setProviderApiKey: vi.fn(),
      updateNetworkAllowlist: vi.fn(),
      updateRuntimeConfig: vi.fn(),
    },
    meshService: {
      updateOptions: vi.fn(),
    },
    npuSidecar: {
      getStatus: vi.fn(() => "stopped"),
      updateConfig: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    },
    llamaCppRuntime: {
      getStatus: vi.fn(() => "stopped"),
      updateConfig: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    },
    readFeatureFlags: vi.fn(() => ({ ...flags })),
    updateFeatureFlags: vi.fn((patch) => {
      flags = { ...flags, ...patch, durableKernelV1Enabled: true };
      return { ...flags };
    }),
    assertDeploymentProfileUpdate: vi.fn(),
    assertFirecrawlRuntimeUpdate: vi.fn(),
    persistLlmConfig: vi.fn(),
    persistToolPolicyConfig: vi.fn(),
    persistBudgetsConfig: vi.fn(),
    persistAssistantConfig: vi.fn(),
  };
}

describe("settings-auth-service durable settings", () => {
  it("rejects attempts to disable the durable kernel through updateSettings", () => {
    const host = buildHost();
    host.updateFeatureFlags = vi.fn(() => {
      throw new Error("features.durableKernelV1Enabled is a shipped baseline runtime setting and cannot be disabled.");
    });

    expect(() =>
      updateSettings(host, {
        features: {
          durableKernelV1Enabled: false,
        },
      }),
    ).toThrow(/cannot be disabled/i);
  });

  it("still applies unrelated feature flag updates through updateSettings", () => {
    const host = buildHost();

    const settings = updateSettings(host, {
      features: {
        replayRegressionV1Enabled: true,
      },
    });

    expect(host.updateFeatureFlags).toHaveBeenCalledWith({
      replayRegressionV1Enabled: true,
    });
    expect(settings.features.durableKernelV1Enabled).toBe(true);
    expect(settings.features.replayRegressionV1Enabled).toBe(true);
    expect(getSettings(host).features.durableKernelV1Enabled).toBe(true);
  });

  it("accepts legacy tool profile names when the profile map is empty", () => {
    const host = buildHost();
    host.config.toolPolicy.profiles = {};

    const settings = updateSettings(host, {
      defaultToolProfile: "minimal",
    });

    expect(settings.defaultToolProfile).toBe("minimal");
    expect(host.persistToolPolicyConfig).toHaveBeenCalled();
    expect(host.persistAssistantConfig).toHaveBeenCalled();
  });

  it("rejects unknown legacy tool profile names when profiles are explicit", () => {
    const host = buildHost();

    expect(() =>
      updateSettings(host, {
        defaultToolProfile: "unknown",
      }),
    ).toThrow("Unknown legacy tool profile: unknown");
  });
});
