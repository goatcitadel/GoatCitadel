import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { ApprovalCreateInput, ApprovalRequest, ApprovalResolveInput } from "@goatcitadel/contracts";
import {
  createDeviceAccessRequest,
  expireDeviceAccessRequestIfNeeded,
  exchangeCompanionSessionFromDeviceGrant,
  getActiveAuthDeviceGrantById,
  getAuthDeviceRequestById,
  getCompanionSessionInfo,
  getCompanionSessionRecord,
  getDeviceAccessRequestStatus,
  listCompanionAuditEvents,
  listCompanionSessions,
  listDeviceAccessGrants,
  resolveDeviceAccessApproval,
  revokeCompanionSession,
  revokeDeviceAccessGrant,
  rotateCompanionSession,
  validateCompanionAccessToken,
  validateDeviceAccessToken,
  verifyCompanionRequestSignature,
  getSettings,
  updateAuthSettings,
  updateSettings,
  type SettingsAuthRuntimeDependencies,
  type SettingsRuntimeDependencies,
} from "./settings-auth-service.js";
import { buildCompanionSigningPayload } from "./companion-auth-helpers.js";

interface AuthHarness {
  deps: SettingsAuthRuntimeDependencies;
  rootDir: string;
  storage: Storage;
  auditRecords: Record<string, unknown>[];
  realtimeEvents: Array<{
    eventType: string;
    source: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }>;
}

const authHarnesses: AuthHarness[] = [];

afterEach(() => {
  for (const harness of authHarnesses.splice(0)) {
    harness.storage.close();
    rmSync(harness.rootDir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

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
          label: "Node 1",
          advertiseAddress: "127.0.0.1",
          discovery: {
            mdns: true,
            staticPeers: [],
          },
          security: {
            requireMtls: true,
            joinTokenEnv: "GOATCITADEL_MESH_JOIN_TOKEN",
            tailnet: {
              enabled: false,
            },
          },
          leases: {
            ttlSeconds: 60,
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
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    },
    llamaCppRuntime: {
      getStatus: vi.fn(() => "stopped"),
      updateConfig: vi.fn(),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
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

function buildAuthHarness(): AuthHarness {
  const rootDir = join(tmpdir(), `goatcitadel-settings-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(rootDir, { recursive: true });
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: join(rootDir, "transcripts"),
    auditDir: join(rootDir, "audit"),
  });
  const auditRecords: Record<string, unknown>[] = [];
  const realtimeEvents: AuthHarness["realtimeEvents"] = [];
  const deps: SettingsAuthRuntimeDependencies = {
    config: {
      assistant: {
        auth: {
          mode: "token",
        },
      },
    } as never,
    gatewaySql: storage.gatewaySql,
    storage: {
      approvals: storage.approvals,
      approvalEvents: storage.approvalEvents,
      runImmediateTransaction: storage.runImmediateTransaction.bind(storage),
      audit: {
        append: vi.fn(async (_stream: string, payload: Record<string, unknown>) => {
          auditRecords.push({
            timestamp: new Date().toISOString(),
            ...payload,
          });
        }),
        list: vi.fn(async () => [...auditRecords]),
      },
    } as never,
    createApproval: vi.fn(async (input: ApprovalCreateInput) => {
      const approval = storage.approvals.create(input);
      return { approvalId: approval.approvalId };
    }),
    resolveApproval: vi.fn(async (approvalId: string, input: ApprovalResolveInput) =>
      storage.approvals.resolve(approvalId, input),
    ),
    enqueueApprovalResolutionEffects: vi.fn(() => []),
    listApprovalEffects: vi.fn(() => []),
    buildApprovalRealtimeLinks: vi.fn((approval: ApprovalRequest) => ({ approvalId: approval.approvalId })),
    recordImprovementApprovalResolutionSignal: vi.fn(),
    handleActivationApprovalResolution: vi.fn(),
    publishRealtime: vi.fn((eventType, source, payload, options) => {
      realtimeEvents.push({ eventType, source, payload, options: options as Record<string, unknown> | undefined });
    }),
  };
  const harness = { deps, rootDir, storage, auditRecords, realtimeEvents };
  authHarnesses.push(harness);
  return harness;
}

async function approveDeviceRequest(harness: AuthHarness, approvalId: string): Promise<string> {
  const approval = harness.storage.approvals.get(approvalId);
  await resolveDeviceAccessApproval(harness.deps, approval, {
    decision: "approve",
    resolvedBy: "operator:test",
  });
  const grant = listDeviceAccessGrants(harness.deps)[0];
  expect(grant).toBeDefined();
  return grant.grantId;
}

async function createApprovedDeviceGrant(harness: AuthHarness): Promise<{
  requestId: string;
  requestSecret: string;
  approvalId: string;
  grantId: string;
  deviceToken: string;
}> {
  const request = await createDeviceAccessRequest(
    harness.deps,
    {
      deviceLabel: "Field tablet",
      deviceType: "tablet",
      platform: "Android",
    },
    {
      requestedOrigin: "http://127.0.0.1:5173",
      requestedIp: "127.0.0.1",
      userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/130",
      correlationId: "corr-device-1",
      traceId: "trace-device-1",
      originSurface: "mission-control",
    },
  );
  const grantId = await approveDeviceRequest(harness, request.approvalId);
  const approved = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
  expect(approved.status).toBe("approved");
  expect(approved.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/);
  return {
    requestId: request.requestId,
    requestSecret: request.requestSecret,
    approvalId: request.approvalId,
    grantId,
    deviceToken: approved.deviceToken!,
  };
}

function createCompanionSigningKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function signCompanionRequest(input: {
  privateKeyPem: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  const payload = buildCompanionSigningPayload(input);
  return sign(null, Buffer.from(payload, "utf8"), input.privateKeyPem).toString("base64url");
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

  it("rejects empty runtime endpoints before mutating persisted settings", () => {
    expect(() =>
      updateSettings(buildHost(), {
        web: {
          firecrawl: {
            baseUrl: "   ",
          },
        },
      }),
    ).toThrow("web.firecrawl.baseUrl cannot be empty");
    expect(() =>
      updateSettings(buildHost(), {
        mesh: {
          nodeId: "   ",
        },
      }),
    ).toThrow("mesh.nodeId cannot be empty");
    expect(() =>
      updateSettings(buildHost(), {
        npu: {
          sidecarUrl: "   ",
        },
      }),
    ).toThrow("npu.sidecarUrl cannot be empty");
    expect(() =>
      updateSettings(buildHost(), {
        llamaCpp: {
          baseUrl: "   ",
        },
      }),
    ).toThrow("llamaCpp.baseUrl cannot be empty");
    expect(() =>
      updateSettings(buildHost(), {
        llamaCpp: {
          command: "   ",
        },
      }),
    ).toThrow("llamaCpp.command cannot be empty");
    expect(() =>
      updateSettings(buildHost(), {
        llamaCpp: {
          alias: "   ",
        },
      }),
    ).toThrow("llamaCpp.alias cannot be empty");
  });

  it("applies profile, budget, memory, web, and read policy updates through the durable settings surface", () => {
    const host = buildHost();

    const settings = updateSettings(host, {
      deploymentProfile: "trusted_local",
      toolApprovalMode: "approve_all",
      budgetMode: "power",
      readAccessMode: "approval_required",
      networkAllowlist: [" api.openai.com ", "", "localhost"],
      auth: {
        mode: "token",
        allowLoopbackBypass: true,
        token: " local-token ",
      },
      memory: {
        enabled: false,
        qmdEnabled: false,
        qmdApplyToChat: false,
        qmdApplyToOrchestration: false,
        qmdMaxContextTokens: 50,
        qmdMinPromptChars: -10,
        qmdCacheTtlSeconds: 1,
        qmdDistillerProviderId: " openai ",
        qmdDistillerModel: " gpt-5.4-mini ",
      },
      web: {
        firecrawl: {
          enabled: true,
          baseUrl: " http://127.0.0.1:3002/v1 ",
          apiKeyEnv: " FIRECRAWL_API_KEY ",
          timeoutMs: 999_999,
          defaultReadBackend: "firecrawl",
          fallbackToNative: false,
        },
      },
    });

    expect(settings).toMatchObject({
      deploymentProfile: "trusted_local",
      toolApprovalMode: "approve_all",
      budgetMode: "power",
      readAccessMode: "approval_required",
      networkAllowlist: ["api.openai.com", "localhost"],
      auth: {
        mode: "token",
        allowLoopbackBypass: true,
        tokenConfigured: true,
      },
      memory: {
        enabled: false,
        qmd: {
          enabled: false,
          applyToChat: false,
          applyToOrchestration: false,
          maxContextTokens: 100,
          minPromptChars: 0,
          cacheTtlSeconds: 10,
          distillerProviderId: "openai",
          distillerModel: "gpt-5.4-mini",
        },
      },
      web: {
        firecrawl: {
          enabled: true,
          baseUrl: "http://127.0.0.1:3002/v1",
          apiKeyEnv: "FIRECRAWL_API_KEY",
          timeoutMs: 120_000,
          defaultReadBackend: "firecrawl",
          fallbackToNative: false,
        },
      },
    });
    expect(host.config.toolPolicy.sandbox.networkAllowlist).toEqual(["api.openai.com", "localhost"]);
    expect(host.llmService.updateNetworkAllowlist).toHaveBeenLastCalledWith(["api.openai.com", "localhost"], {
      enforce: true,
    });
    expect(host.persistAssistantConfig).toHaveBeenCalledTimes(1);
    expect(host.persistToolPolicyConfig).toHaveBeenCalledTimes(1);
    expect(host.persistBudgetsConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe Firecrawl API key env-name settings", () => {
    const host = buildHost();

    expect(() =>
      updateSettings(host, {
        web: {
          firecrawl: {
            apiKeyEnv: "OPENAI_API_KEY",
          },
        },
      }),
    ).toThrow("web.firecrawl.apiKeyEnv must be FIRECRAWL_API_KEY, FIRECRAWL_KEY, or GOATCITADEL_FIRECRAWL_API_KEY");
    expect(host.config.assistant.web.firecrawl.apiKeyEnv).toBeUndefined();
  });

  it("applies mesh, NPU, and llama.cpp runtime updates with persistence and autostart hooks", () => {
    const host = buildHost();
    process.env.GOATCITADEL_MESH_JOIN_TOKEN = "join-token-test";

    try {
      const settings = updateSettings(host, {
        mesh: {
          enabled: true,
          mode: "tailnet",
          nodeId: " node-ops ",
          mdns: false,
          staticPeers: [" peer-a ", "", "peer-b"],
          requireMtls: false,
          tailnetEnabled: true,
        },
        npu: {
          enabled: true,
          autoStart: true,
          sidecarUrl: " http://127.0.0.1:11441 ",
        },
        llamaCpp: {
          enabled: true,
          autoStart: true,
          baseUrl: " http://127.0.0.1:18080/v1 ",
          command: " llama-server ",
          extraArgs: [" --mlock ", "", " --no-warmup "],
          modelsRootPath: " models ",
          modelPath: " models/gemma.gguf ",
          alias: " gemma-local ",
          ctxSize: 8192,
          threads: 12,
          gpuLayers: 40,
          parallel: 2,
          batchSize: 1024,
          ubatchSize: 512,
          flashAttention: true,
        },
      });

      expect(settings.mesh).toMatchObject({
        enabled: true,
        mode: "tailnet",
        nodeId: "node-ops",
        mdns: false,
        staticPeers: ["peer-a", "peer-b"],
        requireMtls: false,
        tailnetEnabled: true,
      });
      expect(host.meshService.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          mode: "tailnet",
          localNodeId: "node-ops",
          joinToken: "join-token-test",
          defaultLeaseTtlSeconds: 60,
        }),
      );
      expect(host.npuSidecar.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          autoStart: true,
          sidecar: {
            baseUrl: "http://127.0.0.1:11441",
          },
        }),
      );
      expect(host.npuSidecar.start).toHaveBeenCalledWith("config_autostart");
      expect(host.llamaCppRuntime.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          autoStart: true,
          server: expect.objectContaining({
            baseUrl: "http://127.0.0.1:18080/v1",
            command: "llama-server",
            extraArgs: ["--mlock", "--no-warmup"],
          }),
          launch: expect.objectContaining({
            modelsRootPath: "models",
            modelPath: "models/gemma.gguf",
            alias: "gemma-local",
            ctxSize: 8192,
            threads: 12,
            gpuLayers: 40,
            parallel: 2,
            batchSize: 1024,
            ubatchSize: 512,
            flashAttention: true,
          }),
        }),
      );
      expect(host.llamaCppRuntime.start).toHaveBeenCalledWith("config_autostart");
      expect(host.llmService.updateRuntimeConfig).toHaveBeenCalledWith({
        upsertProvider: expect.objectContaining({
          providerId: "llamacpp",
          baseUrl: "http://127.0.0.1:18080/v1",
          defaultModel: "gemma-local",
        }),
      });
      expect(host.persistAssistantConfig).toHaveBeenCalled();
      expect(host.persistLlmConfig).toHaveBeenCalled();
    } finally {
      delete process.env.GOATCITADEL_MESH_JOIN_TOKEN;
    }
  });

  it("stops disabled NPU and llama.cpp runtimes after settings updates", () => {
    const host = buildHost();
    host.config.assistant.npu.enabled = true;
    host.config.assistant.llamaCpp.enabled = true;

    const settings = updateSettings(host, {
      npu: {
        enabled: false,
      },
      llamaCpp: {
        enabled: false,
      },
    });

    expect(settings.npu.enabled).toBe(false);
    expect(settings.llamaCpp.enabled).toBe(false);
    expect(host.npuSidecar.stop).toHaveBeenCalledWith("disabled");
    expect(host.llamaCppRuntime.stop).toHaveBeenCalledWith("disabled");
  });

  it("keeps settings updates synchronous when runtime stop and autostart hooks reject", async () => {
    const host = buildHost();
    host.npuSidecar.stop = vi.fn(async () => {
      throw new Error("npu stop failed");
    });
    host.npuSidecar.start = vi.fn(async () => {
      throw new Error("npu start failed");
    });
    host.llamaCppRuntime.stop = vi.fn(async () => {
      throw new Error("llama stop failed");
    });
    host.llamaCppRuntime.start = vi.fn(async () => {
      throw new Error("llama start failed");
    });

    host.config.assistant.npu.enabled = true;
    host.config.assistant.llamaCpp.enabled = true;
    expect(
      updateSettings(host, {
        npu: { enabled: false },
        llamaCpp: { enabled: false },
      }),
    ).toMatchObject({
      npu: { enabled: false },
      llamaCpp: { enabled: false },
    });

    expect(
      updateSettings(host, {
        npu: { enabled: true, autoStart: true },
        llamaCpp: { enabled: true, autoStart: true },
      }),
    ).toMatchObject({
      npu: { enabled: true, autoStart: true },
      llamaCpp: { enabled: true, autoStart: true },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(host.npuSidecar.stop).toHaveBeenCalledWith("disabled");
    expect(host.llamaCppRuntime.stop).toHaveBeenCalledWith("disabled");
    expect(host.npuSidecar.start).toHaveBeenCalledWith("config_autostart");
    expect(host.llamaCppRuntime.start).toHaveBeenCalledWith("config_autostart");
  });

  it("persists submitted provider keys through the secret path before updating LLM runtime config", () => {
    const host = buildHost();
    host.llmService.getProviderSecretStatus = vi.fn((providerId: string) => ({
      providerId,
      hasApiKey: true,
      apiKeySource: "keychain",
      hasKeychainSecret: true,
      apiKeyRef: `keychain:goatcitadel:provider:${providerId}`,
    }));

    const settings = updateSettings(host, {
      llm: {
        upsertProvider: {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
          apiKey: " sk-live ",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
    });

    expect(host.llmService.setProviderApiKey).toHaveBeenCalledWith("openai", "sk-live");
    expect(host.llmService.updateRuntimeConfig).toHaveBeenCalledWith({
      upsertProvider: expect.objectContaining({
        providerId: "openai",
        apiKey: undefined,
        apiKeyEnv: "OPENAI_API_KEY",
      }),
    });
    expect(host.persistLlmConfig).toHaveBeenCalled();
    expect(settings.llm.providers).toEqual([]);
  });

  it("clears blank auth fields while preserving explicit loopback bypass updates in open mode", () => {
    const host = buildHost();
    host.config.assistant.auth.mode = "basic";
    host.config.assistant.auth.allowLoopbackBypass = true;
    host.config.assistant.auth.token.value = "old-token";
    host.config.assistant.auth.basic.username = "old-user";
    host.config.assistant.auth.basic.password = "old-pass";

    const settings = updateAuthSettings(host, {
      mode: "none",
      allowLoopbackBypass: false,
      token: "   ",
      basicUsername: "   ",
      basicPassword: "   ",
    });

    expect(settings).toMatchObject({
      mode: "none",
      allowLoopbackBypass: false,
      tokenConfigured: false,
      basicConfigured: false,
    });
    expect(host.config.assistant.auth.token.value).toBeUndefined();
    expect(host.config.assistant.auth.basic.username).toBeUndefined();
    expect(host.config.assistant.auth.basic.password).toBeUndefined();
  });

  it("rejects protected auth modes until their credentials are effectively configured", () => {
    const originalToken = process.env.GOATCITADEL_AUTH_TOKEN;
    const originalBasicUsername = process.env.GOATCITADEL_AUTH_BASIC_USERNAME;
    const originalBasicPassword = process.env.GOATCITADEL_AUTH_BASIC_PASSWORD;
    delete process.env.GOATCITADEL_AUTH_TOKEN;
    delete process.env.GOATCITADEL_AUTH_BASIC_USERNAME;
    delete process.env.GOATCITADEL_AUTH_BASIC_PASSWORD;
    const host = buildHost();
    host.config.assistant.auth.mode = "none";
    host.config.assistant.auth.token.value = undefined;
    host.config.assistant.auth.basic.username = "operator";
    host.config.assistant.auth.basic.password = undefined;

    try {
      expect(() =>
        updateAuthSettings(host, {
          mode: "token",
          token: "   ",
        }),
      ).toThrow("Token auth mode requires a configured token before it can be saved.");
      expect(host.config.assistant.auth.mode).toBe("none");

      expect(() =>
        updateAuthSettings(host, {
          mode: "basic",
        }),
      ).toThrow("Basic auth mode requires both a username and password before it can be saved.");
      expect(host.config.assistant.auth.mode).toBe("none");

      const settings = updateAuthSettings(host, {
        mode: "token",
        token: "new-token",
      });
      expect(settings).toMatchObject({
        mode: "token",
        tokenConfigured: true,
      });
    } finally {
      restoreEnv("GOATCITADEL_AUTH_TOKEN", originalToken);
      restoreEnv("GOATCITADEL_AUTH_BASIC_USERNAME", originalBasicUsername);
      restoreEnv("GOATCITADEL_AUTH_BASIC_PASSWORD", originalBasicPassword);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("settings-auth-service device access lifecycle", () => {
  it("creates, approves, delivers, validates, and revokes a durable device grant", async () => {
    const harness = buildAuthHarness();

    const request = await createDeviceAccessRequest(
      harness.deps,
      {
        deviceLabel: "Operator laptop",
        deviceType: "desktop",
        platform: "Windows",
      },
      {
        requestedOrigin: "http://127.0.0.1:5173",
        requestedIp: "127.0.0.1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130",
        correlationId: "corr-device-lifecycle",
        traceId: "trace-device-lifecycle",
        originSurface: "mission-control",
      },
    );

    expect(request.status).toBe("pending");
    expect(await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret)).toMatchObject({
      requestId: request.requestId,
      status: "pending",
    });
    await expect(getDeviceAccessRequestStatus(harness.deps, request.requestId, "wrong-secret")).rejects.toThrow(
      "Device access request not found.",
    );

    const grantId = await approveDeviceRequest(harness, request.approvalId);
    const approved = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(approved).toMatchObject({
      requestId: request.requestId,
      approvalId: request.approvalId,
      status: "approved",
    });
    expect(approved.deviceToken).toBeDefined();

    const delivered = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(delivered.status).toBe("approved");
    expect(delivered.deviceToken).toBeUndefined();
    expect(validateDeviceAccessToken(harness.deps, approved.deviceToken!)).toEqual({
      actorId: `device:${grantId}`,
      deviceId: grantId,
      grantId,
    });

    const grant = listDeviceAccessGrants(harness.deps)[0];
    expect(grant).toMatchObject({
      grantId,
      requestId: request.requestId,
      deviceLabel: "Operator laptop",
      deviceType: "desktop",
      platform: "Windows",
      grantedBy: "operator:test",
    });
    expect(grant.lastUsedAt).toBeDefined();

    const revoked = await revokeDeviceAccessGrant(harness.deps, grantId, "operator:test");
    expect(revoked.revokedAt).toBeDefined();
    expect(validateDeviceAccessToken(harness.deps, approved.deviceToken!)).toBeUndefined();
    expect(harness.auditRecords.map((record) => record.event)).toEqual(
      expect.arrayContaining([
        "auth.device_request.create",
        "approval.resolve",
        "auth.device_request.resolve",
        "auth.device_grant.revoke",
      ]),
    );
    expect(harness.realtimeEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "auth_device_request_created",
        "approval_resolved",
        "auth_device_request_resolved",
        "auth_device_grant_revoked",
      ]),
    );
  });

  it("expires stale pending device requests through status polling", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(
      harness.deps,
      {
        deviceLabel: "Dormant browser",
        deviceType: "browser",
      },
      {
        requestedOrigin: "http://127.0.0.1:5173",
      },
    );

    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET expires_at = @expiresAt
        WHERE request_id = @requestId
      `,
      )
      .run({
        requestId: request.requestId,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });

    const expired = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(expired).toMatchObject({
      requestId: request.requestId,
      approvalId: request.approvalId,
      status: "expired",
      message: "This device request expired before it was approved.",
    });
    expect(harness.storage.approvals.get(request.approvalId).status).toBe("rejected");
    expect(listDeviceAccessGrants(harness.deps)).toEqual([]);
    expect(harness.auditRecords.map((record) => record.event)).toEqual(
      expect.arrayContaining(["auth.device_request.expire", "approval.resolve"]),
    );
  });

  it("rejects the approval when device request persistence fails", async () => {
    const harness = buildAuthHarness();
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO auth_device_requests")) {
        throw new Error("sqlite write failed");
      }
      return originalPrepare(sql);
    });

    await expect(createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {})).rejects.toThrow(
      "sqlite write failed",
    );

    const approvalId = vi.mocked(harness.deps.createApproval).mock.results[0]?.value
      ? (await vi.mocked(harness.deps.createApproval).mock.results[0].value).approvalId
      : undefined;
    expect(approvalId).toBeDefined();
    expect(vi.mocked(harness.deps.resolveApproval)).toHaveBeenCalledWith(
      approvalId,
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system:auth-device-request",
        resolutionNote: "Device request registration failed.",
      }),
    );
    expect(harness.storage.approvals.get(approvalId!).status).toBe("rejected");
    expect(harness.auditRecords.map((record) => record.event)).not.toContain("auth.device_request.create");
  });

  it("rejects unsupported device request and approval edit paths", async () => {
    const harness = buildAuthHarness();
    harness.deps.config.assistant.auth.mode = "none";
    await expect(createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {})).rejects.toThrow(
      "Device approvals are not needed when gateway auth mode is none.",
    );

    harness.deps.config.assistant.auth.mode = "token";
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await expect(
      resolveDeviceAccessApproval(harness.deps, harness.storage.approvals.get(request.approvalId), {
        decision: "edit",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow("Editing device access approvals is not supported.");
  });

  it("rejects stale, missing, and already-resolved device approval paths", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    const approval = harness.storage.approvals.get(request.approvalId);

    await expect(
      resolveDeviceAccessApproval(
        harness.deps,
        { ...approval, status: "approved" },
        {
          decision: "approve",
          resolvedBy: "operator:test",
        },
      ),
    ).rejects.toThrow(`Approval ${request.approvalId} is already resolved`);

    await expect(
      resolveDeviceAccessApproval(
        harness.deps,
        { ...approval, approvalId: "approval_missing" },
        {
          decision: "approve",
          resolvedBy: "operator:test",
        },
      ),
    ).rejects.toThrow("Device access request not found.");

    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET expires_at = @expiresAt
        WHERE request_id = @requestId
      `,
      )
      .run({
        requestId: request.requestId,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });

    await expect(
      resolveDeviceAccessApproval(harness.deps, approval, {
        decision: "approve",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow("Device access request expired before it could be approved.");
  });

  it("rejects non-pending device request status and missing status polling rows", async () => {
    const harness = buildAuthHarness();
    await expect(getDeviceAccessRequestStatus(harness.deps, "missing-request", "secret")).rejects.toThrow(
      "Device access request not found.",
    );

    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    const approval = harness.storage.approvals.get(request.approvalId);
    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET status = 'rejected'
        WHERE request_id = @requestId
      `,
      )
      .run({
        requestId: request.requestId,
      });

    await expect(
      resolveDeviceAccessApproval(harness.deps, approval, {
        decision: "approve",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow(`Approval ${request.approvalId} is already resolved`);
  });

  it("keeps device request rejection and expiry races observable without issuing grants", async () => {
    const harness = buildAuthHarness();
    const rejectedRequest = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});

    await resolveDeviceAccessApproval(harness.deps, harness.storage.approvals.get(rejectedRequest.approvalId), {
      decision: "reject",
      resolvedBy: "operator:test",
      resolutionNote: "unrecognized browser",
    });

    expect(listDeviceAccessGrants(harness.deps)).toEqual([]);
    await expect(
      getDeviceAccessRequestStatus(harness.deps, rejectedRequest.requestId, rejectedRequest.requestSecret),
    ).resolves.toMatchObject({
      status: "rejected",
      message: "This device request was rejected from another authenticated session.",
    });

    const expiringRequest = await createDeviceAccessRequest(harness.deps, { deviceType: "browser" }, {});
    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET expires_at = @expiresAt
        WHERE request_id = @requestId
      `,
      )
      .run({
        requestId: expiringRequest.requestId,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
    const stored = getAuthDeviceRequestById(harness.deps, expiringRequest.requestId);
    expect(stored).toBeDefined();
    harness.storage.gatewaySql
      .prepare("DELETE FROM auth_device_requests WHERE request_id = @requestId")
      .run({ requestId: expiringRequest.requestId });

    const expired = await expireDeviceAccessRequestIfNeeded(harness.deps, stored!);
    expect(expired).toMatchObject({
      requestId: expiringRequest.requestId,
      status: "expired",
      resolvedBy: "system:auth-device-expiry",
      resolutionNote: "Device access request expired before approval.",
    });
    expect(harness.storage.approvals.get(expiringRequest.approvalId).status).toBe("rejected");
  });

  it("handles status-delivery races, cleanup failures, and inactive device grants", async () => {
    const deliveryHarness = buildAuthHarness();
    const request = await createDeviceAccessRequest(deliveryHarness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(deliveryHarness, request.approvalId);
    const originalPrepare = deliveryHarness.deps.gatewaySql.prepare.bind(deliveryHarness.deps.gatewaySql);
    let interceptedDeliveryUpdate = false;
    vi.spyOn(deliveryHarness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (
        !interceptedDeliveryUpdate &&
        sql.includes("SET delivered_at = @deliveredAt") &&
        sql.includes("approved_token_plaintext = NULL")
      ) {
        interceptedDeliveryUpdate = true;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (params: { requestId: string }) => {
                originalPrepare(
                  `
                  UPDATE auth_device_requests
                  SET delivered_at = @deliveredAt,
                      approved_token_plaintext = NULL
                  WHERE request_id = @requestId
                `,
                ).run({
                  requestId: params.requestId,
                  deliveredAt: new Date().toISOString(),
                });
                return target.run(params);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as never;
      }
      return statement;
    });

    const racedStatus = await getDeviceAccessRequestStatus(
      deliveryHarness.deps,
      request.requestId,
      request.requestSecret,
    );
    expect(racedStatus).toMatchObject({ status: "approved" });
    expect(racedStatus.deviceToken).toBeUndefined();

    const cleanupHarness = buildAuthHarness();
    const cleanupPrepare = cleanupHarness.deps.gatewaySql.prepare.bind(cleanupHarness.deps.gatewaySql);
    vi.spyOn(cleanupHarness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO auth_device_requests")) {
        throw new Error("sqlite write failed");
      }
      return cleanupPrepare(sql);
    });
    vi.mocked(cleanupHarness.deps.resolveApproval).mockRejectedValueOnce(new Error("approval store offline"));
    await expect(createDeviceAccessRequest(cleanupHarness.deps, { deviceType: "desktop" }, {})).rejects.toThrow(
      "sqlite write failed",
    );

    const grantHarness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(grantHarness);
    expect(getActiveAuthDeviceGrantById(grantHarness.deps, grant.grantId)).toBeDefined();
    await revokeDeviceAccessGrant(grantHarness.deps, grant.grantId, "operator:test");
    expect(getActiveAuthDeviceGrantById(grantHarness.deps, grant.grantId)).toBeUndefined();

    const expiredGrant = await createApprovedDeviceGrant(grantHarness);
    grantHarness.storage.gatewaySql
      .prepare(
        `
        UPDATE auth_device_grants
        SET expires_at = @expiresAt
        WHERE grant_id = @grantId
      `,
      )
      .run({
        grantId: expiredGrant.grantId,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
    expect(getActiveAuthDeviceGrantById(grantHarness.deps, expiredGrant.grantId)).toBeUndefined();
  });
});

describe("settings-auth-service companion session lifecycle", () => {
  it("exchanges, rotates, lists, validates, and revokes companion sessions", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();

    const exchanged = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
      clientName: "GoatCitadel mobile",
      appVersion: "1.2.3",
    });
    expect(exchanged).toMatchObject({
      contractId: "companion.android.v1",
      grantId: grant.grantId,
      actorId: `companion:${exchanged.sessionId}`,
      deviceLabel: "Field tablet",
      deviceType: "tablet",
      platform: "Android",
      signatureAlgorithm: "ed25519",
    });
    expect(validateCompanionAccessToken(harness.deps, exchanged.accessToken)).toEqual({
      actorId: `companion:${exchanged.sessionId}`,
      deviceId: grant.grantId,
      grantId: grant.grantId,
      sessionId: exchanged.sessionId,
    });

    const rotated = await rotateCompanionSession(harness.deps, {
      refreshToken: exchanged.refreshToken,
    });
    expect(rotated.sessionId).toBe(exchanged.sessionId);
    expect(rotated.accessToken).not.toBe(exchanged.accessToken);
    expect(rotated.refreshToken).not.toBe(exchanged.refreshToken);
    expect(validateCompanionAccessToken(harness.deps, exchanged.accessToken)).toBeUndefined();
    expect(validateCompanionAccessToken(harness.deps, rotated.accessToken)).toEqual({
      actorId: `companion:${exchanged.sessionId}`,
      deviceId: grant.grantId,
      grantId: grant.grantId,
      sessionId: exchanged.sessionId,
    });
    await expect(rotateCompanionSession(harness.deps, { refreshToken: "   " })).rejects.toThrow(
      "Refresh token is required.",
    );

    expect(listCompanionSessions(harness.deps).items).toHaveLength(1);
    expect(
      listCompanionSessions(harness.deps, { grantId: grant.grantId, view: "all", limit: 500 }).items[0],
    ).toMatchObject({
      sessionId: exchanged.sessionId,
      grantId: grant.grantId,
      actorId: `companion:${exchanged.sessionId}`,
    });
    expect(getCompanionSessionInfo(harness.deps, exchanged.sessionId)).toMatchObject({
      sessionId: exchanged.sessionId,
      actorId: `companion:${exchanged.sessionId}`,
      deviceLabel: "Field tablet",
      signatureAlgorithm: "ed25519",
    });
    expect(getCompanionSessionRecord(harness.deps, exchanged.sessionId)).toMatchObject({
      sessionId: exchanged.sessionId,
      grantId: grant.grantId,
      actorId: `companion:${exchanged.sessionId}`,
      revokedAt: undefined,
    });
    expect(() => getCompanionSessionInfo(harness.deps, "missing-session")).toThrow("Companion session not found.");
    expect(() => getCompanionSessionRecord(harness.deps, "missing-session")).toThrow("Companion session not found.");

    const revoked = await revokeCompanionSession(harness.deps, exchanged.sessionId, "operator:test");
    expect(revoked.session.revokedAt).toBeDefined();
    expect(validateCompanionAccessToken(harness.deps, rotated.accessToken)).toBeUndefined();
    expect(listCompanionSessions(harness.deps).items).toEqual([]);
    expect(listCompanionSessions(harness.deps, { view: "all" }).items[0].revokedAt).toBeDefined();

    const auditEvents = await listCompanionAuditEvents(harness.deps, {
      sessionId: exchanged.sessionId,
      limit: 10,
    });
    expect(auditEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "auth.companion_session.exchange",
        "auth.companion_session.refresh",
        "auth.companion_session.revoke",
      ]),
    );
    expect(harness.realtimeEvents.map((event) => event.eventType)).toContain("auth_companion_session_revoked");
  });

  it("records accepted, replayed, invalid-signature, stale-timestamp, and inactive signature checks", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });
    const timestamp = new Date().toISOString();
    const body = { action: "sync", nested: { value: 1 } };
    const signature = signCompanionRequest({
      privateKeyPem: keys.privateKeyPem,
      method: "post",
      path: "/api/v1/companion/sync",
      timestamp,
      nonce: "nonce-accepted-1",
      body,
    });

    verifyCompanionRequestSignature(harness.deps, {
      sessionId: session.sessionId,
      method: "post",
      path: "/api/v1/companion/sync",
      timestamp,
      nonce: "nonce-accepted-1",
      signature,
      body,
    });
    expect(() =>
      verifyCompanionRequestSignature(harness.deps, {
        sessionId: session.sessionId,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp,
        nonce: "nonce-accepted-1",
        signature,
        body,
      }),
    ).toThrow("Companion request replay detected.");
    expect(() =>
      verifyCompanionRequestSignature(harness.deps, {
        sessionId: session.sessionId,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp,
        nonce: "nonce-invalid-1",
        signature: "invalid-signature",
        body,
      }),
    ).toThrow("Invalid companion request signature.");
    expect(() =>
      verifyCompanionRequestSignature(harness.deps, {
        sessionId: session.sessionId,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        nonce: "nonce-stale-1",
        signature,
        body,
      }),
    ).toThrow("Companion request timestamp is outside the accepted skew window.");

    await revokeCompanionSession(harness.deps, session.sessionId, "operator:test");
    expect(() =>
      verifyCompanionRequestSignature(harness.deps, {
        sessionId: session.sessionId,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp,
        nonce: "nonce-inactive-1",
        signature,
        body,
      }),
    ).toThrow("Companion session is no longer active.");

    const auditEvents = await listCompanionAuditEvents(harness.deps, {
      sessionId: session.sessionId,
      limit: 20,
    });
    expect(auditEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "auth.companion_request.accepted",
        "auth.companion_request.replay_rejected",
        "auth.companion_request.signature_invalid",
        "auth.companion_request.timestamp_invalid",
        "auth.companion_request.session_inactive",
      ]),
    );
  });

  it("rejects missing, revoked, expired, and already-rotated companion credentials", async () => {
    const harness = buildAuthHarness();
    await expect(
      exchangeCompanionSessionFromDeviceGrant(harness.deps, "grant_missing", {
        signingPublicKeyPem: createCompanionSigningKeys().publicKeyPem,
      }),
    ).rejects.toThrow("Device access grant not found.");
    await expect(revokeDeviceAccessGrant(harness.deps, "grant_missing", "operator:test")).rejects.toThrow(
      "Device access grant not found.",
    );
    await expect(revokeCompanionSession(harness.deps, "session_missing", "operator:test")).rejects.toThrow(
      "Companion session not found.",
    );
    await expect(rotateCompanionSession(harness.deps, { refreshToken: "missing-refresh-token" })).rejects.toThrow(
      "Companion session not found.",
    );

    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });
    const rotated = await rotateCompanionSession(harness.deps, { refreshToken: session.refreshToken });
    await expect(rotateCompanionSession(harness.deps, { refreshToken: session.refreshToken })).rejects.toThrow(
      "Companion session not found.",
    );

    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE companion_sessions
        SET refresh_token_expires_at = @expiredAt, revoked_at = NULL
        WHERE session_id = @sessionId
      `,
      )
      .run({
        sessionId: session.sessionId,
        expiredAt: new Date(Date.now() - 1_000).toISOString(),
      });
    await expect(rotateCompanionSession(harness.deps, { refreshToken: rotated.refreshToken })).rejects.toThrow(
      "Companion session not found.",
    );

    const auditEvents = await listCompanionAuditEvents(harness.deps, {
      sessionId: session.sessionId,
      grantId: grant.grantId,
      limit: 20,
    });
    expect(auditEvents.every((event) => event.companionSessionId === session.sessionId)).toBe(true);
    expect(auditEvents.every((event) => event.grantId === grant.grantId)).toBe(true);
  });

  it("surfaces companion refresh/revoke races and filters audit events by session and grant", async () => {
    const refreshHarness = buildAuthHarness();
    const refreshGrant = await createApprovedDeviceGrant(refreshHarness);
    const refreshKeys = createCompanionSigningKeys();
    const refreshSession = await exchangeCompanionSessionFromDeviceGrant(refreshHarness.deps, refreshGrant.grantId, {
      signingPublicKeyPem: refreshKeys.publicKeyPem,
    });
    const originalRefreshPrepare = refreshHarness.deps.gatewaySql.prepare.bind(refreshHarness.deps.gatewaySql);
    let interceptedRefresh = false;
    vi.spyOn(refreshHarness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalRefreshPrepare(sql);
      if (!interceptedRefresh && sql.includes("SET access_token_hash = @accessTokenHash")) {
        interceptedRefresh = true;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (params: { sessionId: string }) => {
                originalRefreshPrepare(
                  `
                  UPDATE companion_sessions
                  SET refresh_token_hash = 'rotated-before-refresh'
                  WHERE session_id = @sessionId
                `,
                ).run({ sessionId: params.sessionId });
                return target.run(params);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as never;
      }
      return statement;
    });
    await expect(
      rotateCompanionSession(refreshHarness.deps, { refreshToken: refreshSession.refreshToken }),
    ).rejects.toThrow("Companion session refresh token has already been rotated.");

    const revokeHarness = buildAuthHarness();
    const revokeGrant = await createApprovedDeviceGrant(revokeHarness);
    const revokeKeys = createCompanionSigningKeys();
    const revokeSession = await exchangeCompanionSessionFromDeviceGrant(revokeHarness.deps, revokeGrant.grantId, {
      signingPublicKeyPem: revokeKeys.publicKeyPem,
    });
    const originalRevokePrepare = revokeHarness.deps.gatewaySql.prepare.bind(revokeHarness.deps.gatewaySql);
    let interceptedRevoke = false;
    vi.spyOn(revokeHarness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalRevokePrepare(sql);
      if (!interceptedRevoke && sql.includes("SET revoked_at = COALESCE(revoked_at, @revokedAt)")) {
        interceptedRevoke = true;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (params: { sessionId: string }) => {
                const result = target.run(params);
                originalRevokePrepare("DELETE FROM companion_sessions WHERE session_id = @sessionId").run({
                  sessionId: params.sessionId,
                });
                return result;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as never;
      }
      return statement;
    });

    const revoked = await revokeCompanionSession(revokeHarness.deps, revokeSession.sessionId, "operator:test");
    expect(revoked.session).toMatchObject({
      sessionId: revokeSession.sessionId,
      revokedAt: expect.any(String),
    });

    const auditHarness = buildAuthHarness();
    auditHarness.auditRecords.push(
      {
        timestamp: "2026-05-10T00:00:03.000Z",
        event: "auth.companion_session.exchange",
        companionSessionId: "session-target",
        grantId: "grant-target",
      },
      {
        timestamp: "2026-05-10T00:00:02.000Z",
        event: "auth.companion_session.refresh",
        companionSessionId: "session-other",
        grantId: "grant-target",
      },
      {
        timestamp: "2026-05-10T00:00:01.000Z",
        event: "auth.companion_request.accepted",
        companionSessionId: "session-target",
        grantId: "grant-other",
      },
      {
        timestamp: "2026-05-10T00:00:00.000Z",
        event: "auth.device_request.create",
        companionSessionId: "session-target",
        grantId: "grant-target",
      },
    );

    await expect(
      listCompanionAuditEvents(auditHarness.deps, {
        sessionId: "session-target",
        grantId: "grant-target",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        event: "auth.companion_session.exchange",
        companionSessionId: "session-target",
        grantId: "grant-target",
      }),
    ]);
  });
});
