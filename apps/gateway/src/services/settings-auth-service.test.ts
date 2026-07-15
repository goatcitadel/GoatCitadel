import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  PostgresSyncDatabaseClient,
  Storage,
  runPostgresMigrations,
} from "@goatcitadel/storage";
import {
  APPROVAL_EXPIRY_ACTOR_ID,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type ApprovalResolveInput,
} from "@goatcitadel/contracts";
import {
  createDeviceAccessRequest,
  expireDeviceAccessRequestIfNeeded,
  expirePendingDeviceAccessRequests,
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
import {
  COMPANION_ACCESS_TOKEN_TTL_MS,
  COMPANION_REFRESH_TOKEN_TTL_MS,
  COMPANION_REQUEST_CLOCK_SKEW_MS,
  DEVICE_ACCESS_REQUEST_TTL_MS,
  DEVICE_ACCESS_TOKEN_TTL_MS,
} from "./device-access-helpers.js";
import { DeviceTokenVault } from "./device-token-vault.js";
import {
  preserveSettingsSecretsForPublicUpdate,
  projectProviderRuntimePublicValue,
  projectSettingsPublicValue,
} from "./provider-settings-public-projection.js";

interface AuthHarness {
  deps: SettingsAuthRuntimeDependencies;
  deviceTokenVault: DeviceTokenVault;
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

function buildAuthHarness(options: { storage?: Storage; rootDir?: string } = {}): AuthHarness {
  const rootDir =
    options.rootDir ?? join(tmpdir(), `goatcitadel-settings-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(rootDir, { recursive: true });
  const storage =
    options.storage ??
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: join(rootDir, "transcripts"),
      auditDir: join(rootDir, "audit"),
    });
  const auditRecords: Record<string, unknown>[] = [];
  const realtimeEvents: AuthHarness["realtimeEvents"] = [];
  const deviceTokenVault = new DeviceTokenVault();
  const deps: SettingsAuthRuntimeDependencies = {
    config: {
      assistant: {
        auth: {
          mode: "token",
        },
      },
    } as never,
    gatewaySql: storage.gatewaySql,
    deviceTokenVault,
    storage: {
      approvals: storage.approvals,
      approvalEvents: storage.approvalEvents,
      sessionControls: storage.sessionControls,
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
    enqueueApprovalObservabilityEffects: vi.fn((_approvalId, items) => {
      for (const item of items) {
        if (item.delivery.kind === "audit") {
          auditRecords.push({
            timestamp: new Date().toISOString(),
            ...item.delivery.payload,
          });
        } else {
          realtimeEvents.push({
            eventType: item.delivery.eventType,
            source: item.delivery.source,
            payload: item.delivery.payload,
            options: item.delivery.options as Record<string, unknown> | undefined,
          });
        }
      }
      return [];
    }),
    listApprovalEffects: vi.fn(() => []),
    buildApprovalRealtimeLinks: vi.fn((approval: ApprovalRequest) => ({ approvalId: approval.approvalId })),
    recordImprovementApprovalResolutionSignal: vi.fn(),
    handleActivationApprovalResolution: vi.fn(),
    publishRealtime: vi.fn((eventType, source, payload, options) => {
      realtimeEvents.push({ eventType, source, payload, options: options as Record<string, unknown> | undefined });
    }),
  };
  const harness = { deps, deviceTokenVault, rootDir, storage, auditRecords, realtimeEvents };
  authHarnesses.push(harness);
  return harness;
}

function readPersistedTokenPlaintext(harness: AuthHarness, requestId: string): string | null {
  const row = harness.storage.gatewaySql
    .prepare("SELECT approved_token_plaintext FROM auth_device_requests WHERE request_id = @requestId")
    .get({ requestId }) as { approved_token_plaintext: string | null } | undefined;
  return row?.approved_token_plaintext ?? null;
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

interface ActiveCompanionControlFixture {
  grantId: string;
  companionSessionId: string;
  activeChatSessionId: string;
  pendingChatSessionId: string;
  pendingRequestId: string;
}

async function createActiveCompanionControlFixture(
  harness: AuthHarness,
  seed: string,
): Promise<ActiveCompanionControlFixture> {
  const grantId = `grant-control-${seed}`;
  const authRequestId = `auth-request-control-${seed}`;
  const now = harness.storage.gatewaySql.readDatabaseNow();
  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();
  harness.storage.gatewaySql
    .prepare(
      `INSERT INTO auth_device_requests (
         request_id, approval_id, request_secret_hash, device_label, device_type, platform,
         status, created_at, expires_at, resolved_at, resolved_by, principal_purpose
       ) VALUES (
         @requestId, @approvalId, @secretHash, 'Control client', 'desktop', 'test',
         'approved', @now, @expiresAt, @now, 'operator:test', 'session_control_client'
       )`,
    )
    .run({
      requestId: authRequestId,
      approvalId: `approval-control-${seed}`,
      secretHash: testSha256(`secret:${seed}`),
      now,
      expiresAt,
    });
  harness.storage.gatewaySql
    .prepare(
      `INSERT INTO auth_device_grants (
         grant_id, request_id, token_hash, device_label, device_type, platform, granted_by,
         created_at, expires_at, metadata_json, principal_purpose
       ) VALUES (
         @grantId, @requestId, @tokenHash, 'Control client', 'desktop', 'test', 'operator:test',
         @now, @expiresAt, '{}', 'session_control_client'
       )`,
    )
    .run({
      grantId,
      requestId: authRequestId,
      tokenHash: testSha256(`device-token:${seed}`),
      now,
      expiresAt,
    });
  const keys = createCompanionSigningKeys();
  const companion = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grantId, {
    signingPublicKeyPem: keys.publicKeyPem,
    clientName: `Control client ${seed}`,
  });
  const activeChatSessionId = `chat-active-${seed}`;
  const pendingChatSessionId = `chat-pending-${seed}`;
  for (const sessionId of [activeChatSessionId, pendingChatSessionId]) {
    harness.storage.chatSessionLifecycles.initialize({
      workspaceId: "default",
      sessionId,
      actorId: "operator:test",
      idempotencyKey: `lifecycle:init:${sessionId}`,
      correlationId: `correlation:lifecycle:init:${sessionId}`,
    });
  }
  const createControlRequest = (sessionId: string, suffix: string) =>
    harness.storage.sessionControls.createExternalRequest({
      workspaceId: "default",
      sessionId,
      companionSessionId: companion.sessionId,
      deviceGrantId: grantId,
      clientInstanceId: `client-${seed}`,
      principalPurpose: "session_control_client",
      expectedGeneration: 1,
      tokenHashSha256: testSha256(`control-token:${seed}:${suffix}`),
      capabilities: ["send", "read"],
      idempotencyKey: `control-request:${seed}:${suffix}`,
      correlationId: `correlation:control-request:${seed}:${suffix}`,
    });
  const activeRequest = createControlRequest(activeChatSessionId, "active");
  harness.storage.sessionControls.handoff({
    workspaceId: "default",
    sessionId: activeChatSessionId,
    requestId: activeRequest.request.requestId,
    expectedGeneration: 1,
    effectiveCapabilities: ["send", "read"],
    operatorActorId: "operator:test",
    idempotencyKey: `control-handoff:${seed}`,
    correlationId: `correlation:control-handoff:${seed}`,
  });
  const pendingRequest = createControlRequest(pendingChatSessionId, "pending");
  return {
    grantId,
    companionSessionId: companion.sessionId,
    activeChatSessionId,
    pendingChatSessionId,
    pendingRequestId: pendingRequest.request.requestId,
  };
}

function testSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

  it("ignores inherited settings mutation fields and rejects dangerous own keys", () => {
    const host = buildHost();
    const inheritedInput = Object.create({ budgetMode: "power" });

    const settings = updateSettings(host, inheritedInput as never);

    expect(settings.budgetMode).toBe("balanced");
    expect(host.persistBudgetsConfig).not.toHaveBeenCalled();

    const dangerousInput: Record<string, unknown> = {};
    Object.defineProperty(dangerousInput, "__proto__", {
      enumerable: true,
      value: { budgetMode: "power" },
    });
    expect(() => updateSettings(host, dangerousInput as never)).toThrow(
      "Unsafe config key is not allowed: settings.__proto__",
    );
  });

  it("accepts legacy tool profile names when the profile map is empty", () => {
    const host = buildHost();
    host.config.toolPolicy.profiles = {};

    const settings = updateSettings(host, {
      defaultToolProfile: "minimal",
    });

    expect(settings.defaultToolProfile).toBe("minimal");
    expect(host.persistToolPolicyConfig).not.toHaveBeenCalled();
    expect(host.persistAssistantConfig).not.toHaveBeenCalled();
  });

  it("builds first-run tool profile and approval mode without direct mirror persistence", () => {
    const host = buildHost();

    const settings = updateSettings(host, {
      defaultToolProfile: "minimal",
      toolApprovalMode: "approve_all",
    });

    expect(settings.defaultToolProfile).toBe("minimal");
    expect(settings.toolApprovalMode).toBe("approve_all");
    expect(host.config.toolPolicy.tools.profile).toBe("minimal");
    expect(host.config.toolPolicy.tools.approvalMode).toBe("approve_all");
    expect(host.config.assistant.defaultToolProfile).toBe("minimal");
    expect(host.config.assistant.toolApprovalMode).toBe("approve_all");
    expect(host.persistToolPolicyConfig).not.toHaveBeenCalled();
    expect(host.persistAssistantConfig).not.toHaveBeenCalled();
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
    expect(host.persistAssistantConfig).not.toHaveBeenCalled();
    expect(host.persistToolPolicyConfig).not.toHaveBeenCalled();
    expect(host.persistBudgetsConfig).not.toHaveBeenCalled();
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

  it("applies mesh and llama.cpp updates while normalizing retired NPU settings", () => {
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
          enabled: false,
          autoStart: false,
          sidecar: {
            baseUrl: "http://127.0.0.1:11441",
          },
        }),
      );
      expect(settings.npu).toMatchObject({
        enabled: false,
        autoStart: false,
        sidecarUrl: "http://127.0.0.1:11441",
      });
      expect(host.npuSidecar.stop).toHaveBeenCalledWith("disabled");
      expect(host.npuSidecar.start).not.toHaveBeenCalled();
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
      expect(host.persistAssistantConfig).not.toHaveBeenCalled();
      expect(host.persistLlmConfig).not.toHaveBeenCalled();
    } finally {
      delete process.env.GOATCITADEL_MESH_JOIN_TOKEN;
    }
  });

  it("preserves hidden llama.cpp command credentials during a public settings round trip", () => {
    const host = buildHost();
    host.config.assistant.llamaCpp.server.command = "llama-server --api-key command-secret";
    host.config.assistant.llamaCpp.server.extraArgs = ["--api-key", "argument-secret", "--port", "8080"];
    const displayed = projectSettingsPublicValue(getSettings(host));

    const updated = updateSettings(host, {
      llamaCpp: {
        ...displayed.llamaCpp,
        threads: 8,
      },
    });

    expect(host.config.assistant.llamaCpp.server.command).toBe("llama-server --api-key command-secret");
    expect(host.config.assistant.llamaCpp.server.extraArgs).toEqual(["--api-key", "argument-secret", "--port", "8080"]);
    expect(updated.llamaCpp.threads).toBe(8);
  });

  it("projects the full credential-flag family while preserving executable secret references", () => {
    const flags = [
      "--auth",
      "--authentication",
      "--authorization",
      "--proxy-authorization",
      "--bearer",
      "--cookie",
      "--cookies",
      "--credential",
      "--credentials",
      "--api-key",
      "--client-key",
      "--access-key",
      "--private-key",
      "--consumer-key",
      "--signing-key",
      "--access-token",
      "--refresh-token",
      "--client-secret",
      "--secret",
      "--password",
      "--passwd",
      "--signature",
      "--webhook-url",
      "--webhook-uri",
      "--webhook-endpoint",
    ];
    const extraArgs = flags.flatMap((flag, index) => [flag, `raw-secret-${index}`]);
    const command = flags.map((flag, index) => `${flag}=raw-command-secret-${index}`).join(" ");

    const projected = projectProviderRuntimePublicValue({ command, extraArgs });

    expect(projected.extraArgs).toEqual(flags.flatMap((flag) => [flag, "[REDACTED]"]));
    expect(projected.command).toBe(flags.map((flag) => `${flag}=[REDACTED]`).join(" "));
    expect(JSON.stringify(projected)).not.toContain("raw-secret");
    expect(JSON.stringify(projected)).not.toContain("raw-command-secret");

    const safeReferences = {
      command:
        "runner --api-key $API_KEY --access-key process.env.ACCESS_KEY --private-key %PRIVATE_KEY% --signing-key $env:SIGNING_KEY",
      extraArgs: [
        "--api-key",
        "$API_KEY",
        "--access-key=process.env.ACCESS_KEY",
        "--private-key",
        "%PRIVATE_KEY%",
        "--signing-key=$env:SIGNING_KEY",
      ],
    };
    expect(projectProviderRuntimePublicValue(safeReferences)).toEqual(safeReferences);
  });

  it.each([
    "--auth",
    "--authentication",
    "--authorization",
    "--proxy-authorization",
    "--proxy_authorization",
    "--bearer",
  ])("projects and safely reconciles %s schemes with their following credentials", (flag) => {
    const current = {
      llamaCpp: {
        command: `runner ${flag} Bearer command-secret --threads 4`,
        extraArgs: [flag, "Basic", "argument-secret", "--threads", "4"],
      },
    };
    const projected = projectProviderRuntimePublicValue(current);

    expect(projected).toEqual({
      llamaCpp: {
        command: `runner ${flag} [REDACTED] [REDACTED] --threads 4`,
        extraArgs: [flag, "[REDACTED]", "[REDACTED]", "--threads", "4"],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("command-secret");
    expect(JSON.stringify(projected)).not.toContain("argument-secret");

    expect(
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: projected.llamaCpp.command.replace("--threads 4", "--threads 8"),
          extraArgs: projected.llamaCpp.extraArgs.map((value) => (value === "4" ? "8" : value)),
        },
      }),
    ).toEqual({
      llamaCpp: {
        command: `runner ${flag} Bearer command-secret --threads 8`,
        extraArgs: [flag, "Basic", "argument-secret", "--threads", "8"],
      },
    });
  });

  it("restores anchored command secret slots without discarding safe sibling edits", () => {
    const current = {
      llamaCpp: {
        command: "runner --api-key hunter2 --password password-secret --threads 4",
      },
    };
    const projected = projectProviderRuntimePublicValue(current);
    const incoming = {
      llamaCpp: {
        command: projected.llamaCpp.command.replace("--threads 4", "--threads 8"),
      },
    };
    const snapshot = structuredClone(incoming);

    expect(preserveSettingsSecretsForPublicUpdate(current, incoming)).toEqual({
      llamaCpp: {
        command: "runner --api-key hunter2 --password password-secret --threads 8",
      },
    });
    expect(incoming).toEqual(snapshot);

    expect(
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: "runner --api-key replacement --password [REDACTED] --threads 10",
        },
      }),
    ).toEqual({
      llamaCpp: {
        command: "runner --api-key replacement --password password-secret --threads 10",
      },
    });
  });

  it("rejects moved or duplicated command markers", () => {
    const current = {
      llamaCpp: {
        command: "runner --api-key hunter2 --password password-secret --threads 4",
      },
    };

    expect(() =>
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: "runner --password [REDACTED] --api-key [REDACTED] --threads 8",
        },
      }),
    ).toThrow("Projected settings commands with hidden values cannot move or duplicate credential markers.");
    expect(() =>
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: "runner --api-key [REDACTED] --password [REDACTED] --signing-key [REDACTED] --threads 8",
        },
      }),
    ).toThrow("Projected settings commands with hidden values cannot move or duplicate credential markers.");
  });

  it("rejects ambiguous duplicate credential-flag removal or reordering while allowing safe sibling edits", () => {
    const current = {
      llamaCpp: {
        command:
          "runner --mode old --profile alpha --api-key first-secret --profile beta --api-key second-secret --threads 4",
      },
    };
    const projected = projectProviderRuntimePublicValue(current);

    expect(() =>
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: "runner --mode old --profile beta --api-key [REDACTED] --threads 8",
        },
      }),
    ).toThrow("Projected settings commands with hidden values cannot move or duplicate credential markers.");
    expect(() =>
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command:
            "runner --mode old --profile beta --api-key [REDACTED] --profile alpha --api-key [REDACTED] --threads 8",
        },
      }),
    ).toThrow("Projected settings commands with hidden values cannot move or duplicate credential markers.");

    expect(
      preserveSettingsSecretsForPublicUpdate(current, {
        llamaCpp: {
          command: projected.llamaCpp.command.replace("--mode old", "--mode new").replace("--threads 4", "--threads 8"),
        },
      }),
    ).toEqual({
      llamaCpp: {
        command:
          "runner --mode new --profile alpha --api-key first-secret --profile beta --api-key second-secret --threads 8",
      },
    });
  });

  it("restores projected settings secrets without losing partial sibling edits or mutating the patch", () => {
    const host = buildHost();
    host.config.assistant.web.firecrawl.baseUrl =
      "https://firecrawl.example.test/token/firecrawl-path-secret?token=firecrawl-query-secret&mode=read";
    host.config.assistant.mesh.discovery.staticPeers = [
      "https://peer-a.example.test/password/peer-a-secret?token=peer-a-query&mode=sync",
      "https://peer-b.example.test/v1",
    ];
    host.config.assistant.npu.sidecar.baseUrl =
      "https://npu.example.test/access-token/npu-path-secret?token=npu-query-secret&mode=accelerate";
    host.config.assistant.llamaCpp.server.baseUrl =
      "https://llama.example.test/access-token/llama-path-secret?token=llama-query-secret&mode=chat";
    host.config.assistant.llamaCpp.server.command = "llama-server --api-key command-secret --port 8080";
    host.config.assistant.llamaCpp.server.extraArgs = ["--api-key", "argument-secret", "--threads", "4"];
    host.config.assistant.llamaCpp.launch.modelsRootPath = "https://models.example.test/token/models-root-secret";
    host.config.assistant.llamaCpp.launch.modelPath = "https://models.example.test/password/model-path-secret";
    host.config.assistant.llamaCpp.launch.alias = "token=alias-secret";

    const displayed = projectSettingsPublicValue(getSettings(host));
    const patch = {
      web: {
        firecrawl: {
          baseUrl: displayed.web.firecrawl.baseUrl.replace("mode=read", "mode=write"),
          timeoutMs: 31_000,
        },
      },
      mesh: {
        staticPeers: displayed.mesh.staticPeers,
        mdns: false,
      },
      npu: {
        sidecarUrl: displayed.npu.sidecarUrl,
        autoStart: true,
      },
      llamaCpp: {
        baseUrl: displayed.llamaCpp.baseUrl,
        command: displayed.llamaCpp.command,
        extraArgs: displayed.llamaCpp.extraArgs,
        modelsRootPath: displayed.llamaCpp.modelsRootPath,
        modelPath: displayed.llamaCpp.modelPath,
        alias: displayed.llamaCpp.alias,
        threads: 8,
      },
    };
    const patchSnapshot = structuredClone(patch);

    const updated = updateSettings(host, patch);

    expect(host.config.assistant.web.firecrawl.baseUrl).toBe(
      "https://firecrawl.example.test/token/firecrawl-path-secret?token=firecrawl-query-secret&mode=write",
    );
    expect(host.config.assistant.web.firecrawl.timeoutMs).toBe(31_000);
    expect(host.config.assistant.mesh.discovery.staticPeers).toEqual([
      "https://peer-a.example.test/password/peer-a-secret?token=peer-a-query&mode=sync",
      "https://peer-b.example.test/v1",
    ]);
    expect(host.config.assistant.mesh.discovery.mdns).toBe(false);
    expect(host.config.assistant.npu.sidecar.baseUrl).toBe(
      "https://npu.example.test/access-token/npu-path-secret?token=npu-query-secret&mode=accelerate",
    );
    expect(host.config.assistant.npu.autoStart).toBe(false);
    expect(host.config.assistant.llamaCpp.server.baseUrl).toBe(
      "https://llama.example.test/access-token/llama-path-secret?token=llama-query-secret&mode=chat",
    );
    expect(host.config.assistant.llamaCpp.server.command).toBe("llama-server --api-key command-secret --port 8080");
    expect(host.config.assistant.llamaCpp.server.extraArgs).toEqual(["--api-key", "argument-secret", "--threads", "4"]);
    expect(host.config.assistant.llamaCpp.launch).toMatchObject({
      modelsRootPath: "https://models.example.test/token/models-root-secret",
      modelPath: "https://models.example.test/password/model-path-secret",
      alias: "token=alias-secret",
    });
    expect(updated.llamaCpp.threads).toBe(8);
    expect(patch).toEqual(patchSnapshot);
    expect(JSON.stringify(host.config.assistant)).not.toContain("[REDACTED]");
  });

  it("restores hidden settings array slots while preserving safe siblings and rejecting marker movement", () => {
    const host = buildHost();
    host.config.assistant.mesh.discovery.staticPeers = [
      "https://peer-a.example.test/token/peer-a-secret?mode=sync",
      "https://peer-b.example.test/v1",
    ];
    host.config.assistant.llamaCpp.server.extraArgs = [
      "--api-key",
      "argument-secret",
      "--password",
      "password-secret",
      "--threads",
      "4",
    ];
    const displayed = projectSettingsPublicValue(getSettings(host));
    const patch = {
      mesh: {
        staticPeers: [displayed.mesh.staticPeers[0]!, "https://peer-b.example.test/v2"],
      },
      llamaCpp: {
        extraArgs: [...displayed.llamaCpp.extraArgs.slice(0, 4), "--threads", "8"],
      },
    };
    const patchSnapshot = structuredClone(patch);

    updateSettings(host, patch);

    expect(host.config.assistant.mesh.discovery.staticPeers).toEqual([
      "https://peer-a.example.test/token/peer-a-secret?mode=sync",
      "https://peer-b.example.test/v2",
    ]);
    expect(host.config.assistant.llamaCpp.server.extraArgs).toEqual([
      "--api-key",
      "argument-secret",
      "--password",
      "password-secret",
      "--threads",
      "8",
    ]);
    expect(patch).toEqual(patchSnapshot);

    const partialCredentialReplacement = {
      llamaCpp: {
        extraArgs: [
          displayed.llamaCpp.extraArgs[0]!,
          displayed.llamaCpp.extraArgs[1]!,
          "--password",
          "new-password-secret",
          "--threads",
          "10",
        ],
      },
    };
    const partialCredentialReplacementSnapshot = structuredClone(partialCredentialReplacement);
    updateSettings(host, partialCredentialReplacement);
    expect(host.config.assistant.llamaCpp.server.extraArgs).toEqual([
      "--api-key",
      "argument-secret",
      "--password",
      "new-password-secret",
      "--threads",
      "10",
    ]);
    expect(partialCredentialReplacement).toEqual(partialCredentialReplacementSnapshot);

    const rawPeers = structuredClone(host.config.assistant.mesh.discovery.staticPeers);
    const rawExtraArgs = structuredClone(host.config.assistant.llamaCpp.server.extraArgs);
    expect(() =>
      updateSettings(host, {
        mesh: {
          staticPeers: ["https://peer-b.example.test/v2", displayed.mesh.staticPeers[0]!],
        },
      }),
    ).toThrow("Projected settings arrays with hidden values cannot be reordered or resized.");
    expect(() =>
      updateSettings(host, {
        llamaCpp: {
          extraArgs: [
            "--password",
            displayed.llamaCpp.extraArgs[1]!,
            "--api-key",
            displayed.llamaCpp.extraArgs[3]!,
            "--threads",
            "10",
          ],
        },
      }),
    ).toThrow("Projected settings arrays with hidden values cannot be reordered or resized.");
    expect(host.config.assistant.mesh.discovery.staticPeers).toEqual(rawPeers);
    expect(host.config.assistant.llamaCpp.server.extraArgs).toEqual(rawExtraArgs);
  });

  it("keeps omitted projected fields omitted and accepts explicit non-marker replacements", () => {
    const host = buildHost();
    host.config.assistant.web.firecrawl.baseUrl = "https://firecrawl.example.test/token/firecrawl-secret";
    host.config.assistant.mesh.discovery.staticPeers = ["https://peer.example.test/token/peer-secret"];
    host.config.assistant.npu.sidecar.baseUrl = "https://npu.example.test/token/npu-secret";
    host.config.assistant.llamaCpp.server.baseUrl = "https://llama.example.test/token/llama-secret";
    host.config.assistant.llamaCpp.server.command = "llama-server --api-key command-secret";
    host.config.assistant.llamaCpp.server.extraArgs = ["--api-key", "argument-secret"];
    host.config.assistant.llamaCpp.launch.modelsRootPath = "https://models.example.test/token/models-root-secret";
    host.config.assistant.llamaCpp.launch.modelPath = "https://models.example.test/password/model-path-secret";
    host.config.assistant.llamaCpp.launch.alias = "token=alias-secret";
    const current = getSettings(host);
    const currentSnapshot = structuredClone(current);
    const partialPatch = {
      web: { firecrawl: { timeoutMs: 19_000 } },
      mesh: { mdns: false },
      npu: { autoStart: true },
      llamaCpp: { threads: 6 },
    };
    const partialPatchSnapshot = structuredClone(partialPatch);

    expect(preserveSettingsSecretsForPublicUpdate(current, partialPatch)).toEqual(partialPatch);
    expect(current).toEqual(currentSnapshot);
    expect(partialPatch).toEqual(partialPatchSnapshot);

    updateSettings(host, {
      web: { firecrawl: { baseUrl: "https://firecrawl-new.example.test/v2" } },
      mesh: { staticPeers: ["https://peer-new.example.test/v1"] },
      npu: { sidecarUrl: "https://npu-new.example.test/v1" },
      llamaCpp: {
        baseUrl: "https://llama-new.example.test/v1",
        command: "llama-server --port 9090",
        extraArgs: ["--threads", "8"],
        modelsRootPath: "D:/Models",
        modelPath: "D:/Models/model.gguf",
        alias: "llama-new",
      },
    });

    expect(host.config.assistant.web.firecrawl.baseUrl).toBe("https://firecrawl-new.example.test/v2");
    expect(host.config.assistant.mesh.discovery.staticPeers).toEqual(["https://peer-new.example.test/v1"]);
    expect(host.config.assistant.npu.sidecar.baseUrl).toBe("https://npu-new.example.test/v1");
    expect(host.config.assistant.llamaCpp.server).toMatchObject({
      baseUrl: "https://llama-new.example.test/v1",
      command: "llama-server --port 9090",
      extraArgs: ["--threads", "8"],
    });
    expect(host.config.assistant.llamaCpp.launch).toMatchObject({
      modelsRootPath: "D:/Models",
      modelPath: "D:/Models/model.gguf",
      alias: "llama-new",
    });
  });

  it("does not persist a public API-key projection marker as a provider credential", () => {
    const host = buildHost();

    updateSettings(host, {
      llm: {
        upsertProvider: {
          providerId: "custom",
          apiKey: "[REDACTED]",
        },
      },
    });

    expect(host.llmService.setProviderApiKey).not.toHaveBeenCalled();
    expect(host.llmService.updateRuntimeConfig).toHaveBeenCalledWith({
      upsertProvider: {
        providerId: "custom",
        apiKey: undefined,
      },
    });
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
      npu: { enabled: false, autoStart: false },
      llamaCpp: { enabled: true, autoStart: true },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(host.npuSidecar.stop).toHaveBeenCalledWith("disabled");
    expect(host.llamaCppRuntime.stop).toHaveBeenCalledWith("disabled");
    expect(host.npuSidecar.start).not.toHaveBeenCalled();
    expect(host.llamaCppRuntime.start).toHaveBeenCalledWith("config_autostart");
  });

  it("rejects submitted provider keys before mutating secret, config, or persistence owners", () => {
    const host = buildHost();
    host.llmService.getProviderSecretStatus = vi.fn((providerId: string) => ({
      providerId,
      hasApiKey: true,
      apiKeySource: "keychain",
      hasKeychainSecret: true,
      apiKeyRef: `keychain:goatcitadel:provider:${providerId}`,
    }));

    expect(() =>
      updateSettings(host, {
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
      }),
    ).toThrow(/provider secret endpoint/i);

    expect(host.llmService.setProviderApiKey).not.toHaveBeenCalled();
    expect(host.llmService.updateRuntimeConfig).not.toHaveBeenCalled();
    expect(host.persistLlmConfig).not.toHaveBeenCalled();
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
    expect(
      harness.storage.gatewaySql
        .prepare(
          `SELECT binding_kind, binding_id
           FROM chat_session_control_auth_revoke_receipts
           WHERE binding_kind = 'device_grant' AND binding_id = @grantId`,
        )
        .get({ grantId }),
    ).toEqual({ binding_kind: "device_grant", binding_id: grantId });
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

  it("rolls back device-grant auth revocation and session-control evidence when projection fails", async () => {
    const harness = buildAuthHarness();
    const fixture = await createActiveCompanionControlFixture(harness, "device-rollback");
    const receiptCountBefore = harness.storage.gatewaySql
      .prepare(
        `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_receipts
         WHERE binding_kind = 'device_grant' AND binding_id = @grantId`,
      )
      .get<{ count: number }>({ grantId: fixture.grantId })!.count;
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    let grantSelectCount = 0;
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("SELECT * FROM auth_device_grants") && ++grantSelectCount === 2) {
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "get")
              return () => {
                throw new Error("projection failed");
              };
            return Reflect.get(target, prop, receiver);
          },
        }) as never;
      }
      return statement;
    });

    await expect(revokeDeviceAccessGrant(harness.deps, fixture.grantId, "operator:test")).rejects.toThrow(
      "projection failed",
    );
    expect(
      harness.storage.gatewaySql
        .prepare("SELECT revoked_at FROM auth_device_grants WHERE grant_id = @grantId")
        .get({ grantId: fixture.grantId }),
    ).toEqual({ revoked_at: null });
    expect(
      harness.storage.gatewaySql
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_receipts
           WHERE binding_kind = 'device_grant' AND binding_id = @grantId`,
        )
        .get<{ count: number }>({ grantId: fixture.grantId })!.count,
    ).toBe(receiptCountBefore);
    expect(harness.storage.sessionControls.getControl("default", fixture.activeChatSessionId)).toMatchObject({
      ownerKind: "external_companion",
      leaseState: "external_live",
    });
    expect(
      harness.storage.gatewaySql
        .prepare("SELECT status FROM chat_session_control_requests WHERE request_id = @requestId")
        .get({ requestId: fixture.pendingRequestId }),
    ).toEqual({ status: "pending" });
  });

  it.each(["2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"])(
    "issues device-request TTLs from database time under a %s host clock",
    async (hostClock) => {
      const databaseNowBefore = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(hostClock));
      try {
        const harness = buildAuthHarness();
        const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
        const stored = getAuthDeviceRequestById(harness.deps, request.requestId);

        expect(stored).toBeDefined();
        expect(Math.abs(Date.parse(stored!.createdAt) - databaseNowBefore)).toBeLessThan(5_000);
        expect(Date.parse(stored!.expiresAt) - Date.parse(stored!.createdAt)).toBe(DEVICE_ACCESS_REQUEST_TTL_MS);
        expect(request.expiresAt).toBe(stored!.expiresAt);

        vi.setSystemTime(new Date(databaseNowBefore));
        await expect(
          getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret),
        ).resolves.toMatchObject({ status: "pending" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"])(
    "issues device grants and secure handoff TTLs from database time under a %s host clock",
    async (hostClock) => {
      const databaseNowBefore = Date.now();
      const harness = buildAuthHarness();
      const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
      vi.useFakeTimers();
      vi.setSystemTime(new Date(hostClock));
      try {
        await approveDeviceRequest(harness, request.approvalId);
        const grant = listDeviceAccessGrants(harness.deps)[0]!;
        expect(Math.abs(Date.parse(grant.createdAt) - databaseNowBefore)).toBeLessThan(5_000);
        expect(Date.parse(grant.expiresAt!) - Date.parse(grant.createdAt)).toBe(DEVICE_ACCESS_TOKEN_TTL_MS);

        const delivered = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
        expect(delivered.deviceToken).toBeDefined();
        expect(delivered.deviceTokenExpiresAt).toBe(grant.expiresAt);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("validates device grants against database time and fails closed for malformed expiry", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    try {
      expect(getActiveAuthDeviceGrantById(harness.deps, grant.grantId)).toBeDefined();
      expect(validateDeviceAccessToken(harness.deps, grant.deviceToken)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }

    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = NULL, revoked_at = NULL WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    expect(getActiveAuthDeviceGrantById(harness.deps, grant.grantId)).toBeDefined();
    expect(validateDeviceAccessToken(harness.deps, grant.deviceToken)).toBeDefined();

    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = 'not-a-timestamp' WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    expect(getActiveAuthDeviceGrantById(harness.deps, grant.grantId)).toBeUndefined();
    expect(validateDeviceAccessToken(harness.deps, grant.deviceToken)).toBeUndefined();

    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = NULL, revoked_at = '' WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    expect(getActiveAuthDeviceGrantById(harness.deps, grant.grantId)).toBeUndefined();
    expect(validateDeviceAccessToken(harness.deps, grant.deviceToken)).toBeUndefined();
  });

  it("terminalizes malformed and boundary-expired device requests using database timestamp parsing", async () => {
    const malformedHarness = buildAuthHarness();
    const malformed = await createDeviceAccessRequest(malformedHarness.deps, { deviceType: "desktop" }, {});
    malformedHarness.storage.gatewaySql
      .prepare("UPDATE auth_device_requests SET expires_at = 'not-a-timestamp' WHERE request_id = @requestId")
      .run({ requestId: malformed.requestId });

    await expect(expirePendingDeviceAccessRequests(malformedHarness.deps, 10)).resolves.toBe(1);
    expect(getAuthDeviceRequestById(malformedHarness.deps, malformed.requestId)?.status).toBe("expired");
    expect(malformedHarness.storage.approvals.get(malformed.approvalId).status).toBe("rejected");

    const boundaryHarness = buildAuthHarness();
    const boundary = await createDeviceAccessRequest(boundaryHarness.deps, { deviceType: "desktop" }, {});
    const databaseNow = boundaryHarness.storage.gatewaySql.readDatabaseNow();
    boundaryHarness.storage.gatewaySql
      .prepare("UPDATE auth_device_requests SET expires_at = @expiresAt WHERE request_id = @requestId")
      .run({ requestId: boundary.requestId, expiresAt: databaseNow.replace("Z", "+00:00") });

    await expect(expirePendingDeviceAccessRequests(boundaryHarness.deps, 10)).resolves.toBe(1);
    expect(getAuthDeviceRequestById(boundaryHarness.deps, boundary.requestId)?.status).toBe("expired");

    const futureHarness = buildAuthHarness();
    const future = await createDeviceAccessRequest(futureHarness.deps, { deviceType: "desktop" }, {});
    futureHarness.storage.gatewaySql
      .prepare("UPDATE auth_device_requests SET expires_at = @expiresAt WHERE request_id = @requestId")
      .run({
        requestId: future.requestId,
        expiresAt: new Date(Date.parse(futureHarness.storage.gatewaySql.readDatabaseNow()) + 60_000)
          .toISOString()
          .replace("Z", "+00:00"),
      });
    await expect(expirePendingDeviceAccessRequests(futureHarness.deps, 10)).resolves.toBe(0);
    expect(getAuthDeviceRequestById(futureHarness.deps, future.requestId)?.status).toBe("pending");
  });

  it("rolls back the device grant, request, approval, and plaintext handoff when effect enqueue fails", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(
      harness.deps,
      {
        deviceLabel: "Rollback laptop",
        deviceType: "desktop",
        platform: "Windows",
      },
      {
        requestedOrigin: "http://127.0.0.1:5173",
        requestedIp: "127.0.0.1",
      },
    );
    vi.mocked(harness.deps.enqueueApprovalObservabilityEffects).mockImplementationOnce(() => {
      throw new Error("approval observability store unavailable");
    });

    await expect(
      resolveDeviceAccessApproval(harness.deps, harness.storage.approvals.get(request.approvalId), {
        decision: "approve",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow("approval observability store unavailable");

    expect(harness.storage.approvals.get(request.approvalId).status).toBe("pending");
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.status).toBe("pending");
    expect(listDeviceAccessGrants(harness.deps)).toEqual([]);
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(false);
  });

  it("preserves the winning device token when concurrent approval attempts race", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    const staleApproval = harness.storage.approvals.get(request.approvalId);

    const outcomes = await Promise.allSettled([
      resolveDeviceAccessApproval(harness.deps, staleApproval, {
        decision: "approve",
        resolvedBy: "operator:first",
      }),
      resolveDeviceAccessApproval(harness.deps, staleApproval, {
        decision: "approve",
        resolvedBy: "operator:second",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(listDeviceAccessGrants(harness.deps)).toHaveLength(1);
    const winningToken = harness.deviceTokenVault.claim(request.requestId);
    expect(winningToken?.token).toBeDefined();
    expect(validateDeviceAccessToken(harness.deps, winningToken!.token)).toMatchObject({
      actorId: expect.stringMatching(/^device:/),
      grantId: expect.any(String),
    });
  });

  it("refuses a device grant when the request expires at the winning transaction boundary", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    const originalTransaction = harness.deps.storage.runImmediateTransaction.bind(harness.deps.storage);
    vi.spyOn(harness.deps.storage, "runImmediateTransaction").mockImplementation((operation) => {
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
      return originalTransaction(operation);
    });

    await expect(
      resolveDeviceAccessApproval(harness.deps, harness.storage.approvals.get(request.approvalId), {
        decision: "approve",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow(/no longer pending or has expired/i);

    expect(harness.storage.approvals.get(request.approvalId).status).toBe("pending");
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.status).toBe("pending");
    expect(listDeviceAccessGrants(harness.deps)).toEqual([]);
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(false);
  });

  it("rolls back when a device request expires while its approval transaction is in flight", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    vi.mocked(harness.deps.enqueueApprovalObservabilityEffects).mockImplementationOnce(() => {
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
          expiresAt: new Date(Date.parse(harness.storage.gatewaySql.readDatabaseNow()) - 1_000).toISOString(),
        });
      return [];
    });

    await expect(
      resolveDeviceAccessApproval(harness.deps, harness.storage.approvals.get(request.approvalId), {
        decision: "approve",
        resolvedBy: "operator:test",
      }),
    ).rejects.toThrow(/expired before the approval transaction committed/i);

    expect(harness.storage.approvals.get(request.approvalId).status).toBe("pending");
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.status).toBe("pending");
    expect(listDeviceAccessGrants(harness.deps)).toEqual([]);
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(false);
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
    expect(harness.deps.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: request.approvalId, status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: APPROVAL_EXPIRY_ACTOR_ID }),
      { allowExpired: true },
    );
    expect(harness.auditRecords.map((record) => record.event)).toEqual(
      expect.arrayContaining(["auth.device_request.expire", "approval.resolve"]),
    );
  });

  it("proactively expires stale device requests that are never polled", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(
      harness.deps,
      { deviceLabel: "Unpolled browser", deviceType: "browser" },
      {},
    );
    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_requests SET expires_at = @expiresAt WHERE request_id = @requestId")
      .run({ requestId: request.requestId, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(expirePendingDeviceAccessRequests(harness.deps, 10)).resolves.toBe(1);

    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.status).toBe("expired");
    expect(harness.storage.approvals.get(request.approvalId).status).toBe("rejected");
    expect(harness.deps.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: request.approvalId, status: "rejected" }),
      expect.objectContaining({ resolvedBy: APPROVAL_EXPIRY_ACTOR_ID }),
      { allowExpired: true },
    );
  });

  it("preserves wait-wake effect authority when a hook-shortened device approval has elapsed", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    harness.storage.gatewaySql
      .prepare("UPDATE approvals SET expires_at = @expiresAt WHERE approval_id = @approvalId")
      .run({ approvalId: request.approvalId, expiresAt: new Date(Date.now() - 2_000).toISOString() });
    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_requests SET expires_at = @expiresAt WHERE request_id = @requestId")
      .run({ requestId: request.requestId, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(expirePendingDeviceAccessRequests(harness.deps, 10)).resolves.toBe(1);
    expect(harness.deps.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: request.approvalId, status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: APPROVAL_EXPIRY_ACTOR_ID }),
      { allowExpired: true },
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
    expect(vi.mocked(harness.deps.resolveApproval)).not.toHaveBeenCalled();
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
      status: "pending",
    });
    expect(harness.storage.approvals.get(expiringRequest.approvalId).status).toBe("pending");
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
    await expect(createDeviceAccessRequest(cleanupHarness.deps, { deviceType: "desktop" }, {})).rejects.toThrow(
      "sqlite write failed",
    );
    const cleanupApprovalId = (await vi.mocked(cleanupHarness.deps.createApproval).mock.results[0]!.value).approvalId;
    expect(cleanupHarness.storage.approvals.get(cleanupApprovalId).status).toBe("rejected");

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

describe("settings-auth-service device token is never at rest", () => {
  it("never persists the approved token plaintext after approval", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});

    await approveDeviceRequest(harness, request.approvalId);

    // The operator-equivalent token must NOT sit in SQLite in plaintext.
    expect(readPersistedTokenPlaintext(harness, request.requestId)).toBeNull();
    // It must instead live (single-use) in the ephemeral in-memory vault.
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(true);
  });

  it("delivers the token on the first poll and never on the second (single-use)", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(harness, request.approvalId);

    const first = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(first.status).toBe("approved");
    expect(first.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.deviceTokenExpiresAt).toBeDefined();

    // Plaintext never touched disk, and the vault entry is consumed on delivery.
    expect(readPersistedTokenPlaintext(harness, request.requestId)).toBeNull();
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(false);

    const second = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(second.status).toBe("approved");
    expect(second.deviceToken).toBeUndefined();
    // Absence is framed as "awaiting handoff", never as a rejection.
    expect(second.message).toContain("secure handoff");
  });

  it("uses database time for secure delivery when the polling node clock is fast", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(harness, request.approvalId);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    try {
      const first = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
      expect(first.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.deviceTokenExpiresAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not burn the handoff when a different gateway node lacks the plaintext", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(harness, request.approvalId);
    const otherNodeDeps = {
      ...harness.deps,
      deviceTokenVault: new DeviceTokenVault(),
    };

    const remotePoll = await getDeviceAccessRequestStatus(otherNodeDeps, request.requestId, request.requestSecret);
    expect(remotePoll.status).toBe("approved");
    expect(remotePoll.deviceToken).toBeUndefined();
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.deliveredAt).toBeUndefined();
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(true);

    const approvingNodePoll = await getDeviceAccessRequestStatus(
      harness.deps,
      request.requestId,
      request.requestSecret,
    );
    expect(approvingNodePoll.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.deliveredAt).toBeDefined();
  });

  it("restores the plaintext vault entry when the delivery CAS throws", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(harness, request.approvalId);
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("SET delivered_at = @deliveredAt")) {
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === "run") {
              return () => {
                throw new Error("delivery CAS unavailable");
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }) as never;
      }
      return statement;
    });

    await expect(getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret)).rejects.toThrow(
      "delivery CAS unavailable",
    );
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(true);
    expect(getAuthDeviceRequestById(harness.deps, request.requestId)?.deliveredAt).toBeUndefined();
  });

  it("does not deliver a token whose vault entry has already expired", async () => {
    const harness = buildAuthHarness();
    const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
    await approveDeviceRequest(harness, request.approvalId);

    // Simulate the device token expiring before the device ever polled.
    expect(harness.deviceTokenVault.has(request.requestId)).toBe(true);
    harness.deviceTokenVault.store(request.requestId, "stale-token", new Date(Date.now() - 1_000).toISOString());

    const status = await getDeviceAccessRequestStatus(harness.deps, request.requestId, request.requestSecret);
    expect(status.status).toBe("approved");
    expect(status.deviceToken).toBeUndefined();
    expect(status.message).toContain("secure handoff");
    expect(readPersistedTokenPlaintext(harness, request.requestId)).toBeNull();
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

  it.each(["companion_revoke", "device_revoke", "exchange"] as const)(
    "%s revokes active and pending session-control authority in the auth transaction",
    async (operation) => {
      const harness = buildAuthHarness();
      const fixture = await createActiveCompanionControlFixture(harness, operation);
      expect(harness.storage.sessionControls.getControl("default", fixture.activeChatSessionId)).toMatchObject({
        ownerKind: "external_companion",
        leaseState: "external_live",
      });

      let replacementSessionId: string | undefined;
      if (operation === "companion_revoke") {
        await revokeCompanionSession(harness.deps, fixture.companionSessionId, "operator:test");
      } else if (operation === "device_revoke") {
        await revokeDeviceAccessGrant(harness.deps, fixture.grantId, "operator:test");
      } else {
        const replacement = await exchangeCompanionSessionFromDeviceGrant(harness.deps, fixture.grantId, {
          signingPublicKeyPem: createCompanionSigningKeys().publicKeyPem,
          clientName: "Replacement control client",
        });
        replacementSessionId = replacement.sessionId;
      }

      expect(harness.storage.sessionControls.getControl("default", fixture.activeChatSessionId)).toMatchObject({
        ownerKind: "operator",
        leaseState: "operator_active",
        lastEventReasonCode: "auth_revoked",
      });
      expect(
        harness.storage.gatewaySql
          .prepare("SELECT status FROM chat_session_control_requests WHERE request_id = @requestId")
          .get({ requestId: fixture.pendingRequestId }),
      ).toEqual({ status: "cancelled" });
      const bindingKind = operation === "companion_revoke" ? "companion_session" : "device_grant";
      const bindingId = operation === "companion_revoke" ? fixture.companionSessionId : fixture.grantId;
      expect(
        harness.storage.gatewaySql
          .prepare(
            `SELECT target_count, session_count
             FROM chat_session_control_auth_revoke_receipts
             WHERE binding_kind = @bindingKind AND binding_id = @bindingId
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get<{ target_count: number; session_count: number }>({ bindingKind, bindingId }),
      ).toMatchObject({ target_count: 2, session_count: 2 });
      if (replacementSessionId) {
        expect(replacementSessionId).not.toBe(fixture.companionSessionId);
        expect(getCompanionSessionRecord(harness.deps, fixture.companionSessionId).revokedAt).toBeDefined();
        expect(getCompanionSessionRecord(harness.deps, replacementSessionId).revokedAt).toBeUndefined();
      }
    },
  );

  it("rolls companion-session control revocation back when the auth projection fails", async () => {
    const harness = buildAuthHarness();
    const fixture = await createActiveCompanionControlFixture(harness, "companion-rollback");
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    let sessionProjectionCount = 0;
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("FROM companion_sessions s") && sql.includes("WHERE s.session_id = @sessionId")) {
        sessionProjectionCount += 1;
        if (sessionProjectionCount === 2) {
          return new Proxy(statement, {
            get(target, prop, receiver) {
              if (prop === "get")
                return () => {
                  throw new Error("companion projection failed");
                };
              return Reflect.get(target, prop, receiver);
            },
          }) as never;
        }
      }
      return statement;
    });

    await expect(revokeCompanionSession(harness.deps, fixture.companionSessionId, "operator:test")).rejects.toThrow(
      "companion projection failed",
    );
    expect(getCompanionSessionRecord(harness.deps, fixture.companionSessionId).revokedAt).toBeUndefined();
    expect(harness.storage.sessionControls.getControl("default", fixture.activeChatSessionId)).toMatchObject({
      ownerKind: "external_companion",
      leaseState: "external_live",
    });
    expect(
      harness.storage.gatewaySql
        .prepare(
          `SELECT 1 FROM chat_session_control_auth_revoke_receipts
           WHERE binding_kind = 'companion_session' AND binding_id = @sessionId`,
        )
        .get({ sessionId: fixture.companionSessionId }),
    ).toBeUndefined();
  });

  it("rolls replacement exchange control/auth revocation back when session insertion fails", async () => {
    const harness = buildAuthHarness();
    const fixture = await createActiveCompanionControlFixture(harness, "exchange-rollback");
    const receiptCountBefore = harness.storage.gatewaySql
      .prepare(
        `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_receipts
         WHERE binding_kind = 'device_grant' AND binding_id = @grantId`,
      )
      .get<{ count: number }>({ grantId: fixture.grantId })!.count;
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    let intercepted = false;
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (!intercepted && sql.includes("INSERT INTO companion_sessions")) {
        intercepted = true;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (params: unknown) => {
                target.run(params);
                throw new Error("replacement insert failed");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as never;
      }
      return statement;
    });

    await expect(
      exchangeCompanionSessionFromDeviceGrant(harness.deps, fixture.grantId, {
        signingPublicKeyPem: createCompanionSigningKeys().publicKeyPem,
      }),
    ).rejects.toThrow("replacement insert failed");
    expect(getCompanionSessionRecord(harness.deps, fixture.companionSessionId).revokedAt).toBeUndefined();
    expect(harness.storage.sessionControls.getControl("default", fixture.activeChatSessionId)).toMatchObject({
      ownerKind: "external_companion",
      leaseState: "external_live",
    });
    expect(
      harness.storage.gatewaySql
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_session_control_auth_revoke_receipts
           WHERE binding_kind = 'device_grant' AND binding_id = @grantId`,
        )
        .get<{ count: number }>({ grantId: fixture.grantId })!.count,
    ).toBe(receiptCountBefore);
    expect(
      harness.storage.gatewaySql
        .prepare("SELECT COUNT(*) AS count FROM companion_sessions WHERE grant_id = @grantId")
        .get<{ count: number }>({ grantId: fixture.grantId })!.count,
    ).toBe(1);
  });

  it("issues and validates companion credentials from database time under host-clock skew", async () => {
    const databaseNowBefore = Date.now();
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    try {
      const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
        signingPublicKeyPem: keys.publicKeyPem,
      });
      expect(Math.abs(Date.parse(session.issuedAt) - databaseNowBefore)).toBeLessThan(5_000);
      expect(Date.parse(session.accessTokenExpiresAt) - Date.parse(session.issuedAt)).toBe(
        COMPANION_ACCESS_TOKEN_TTL_MS,
      );
      expect(Date.parse(session.refreshTokenExpiresAt) - Date.parse(session.issuedAt)).toBe(
        COMPANION_REFRESH_TOKEN_TTL_MS,
      );
      expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeDefined();
      expect(listCompanionSessions(harness.deps).items).toEqual([
        expect.objectContaining({ sessionId: session.sessionId }),
      ]);

      const timestamp = new Date(databaseNowBefore).toISOString();
      const body = { action: "clock-safe-sync" };
      const signature = signCompanionRequest({
        privateKeyPem: keys.privateKeyPem,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp,
        nonce: "nonce-db-clock-1",
        body,
      });
      const signedRequest = {
        sessionId: session.sessionId,
        method: "post",
        path: "/api/v1/companion/sync",
        timestamp,
        nonce: "nonce-db-clock-1",
        signature,
        body,
      };
      expect(() => verifyCompanionRequestSignature(harness.deps, signedRequest)).not.toThrow();
      harness.storage.gatewaySql
        .prepare(
          `
            UPDATE companion_request_replays
            SET expires_at = 'not-a-timestamp'
            WHERE session_id = @sessionId AND nonce = @nonce
          `,
        )
        .run({ sessionId: session.sessionId, nonce: "nonce-db-clock-1" });
      expect(() => verifyCompanionRequestSignature(harness.deps, signedRequest)).toThrow(
        "Companion request replay detected.",
      );
      const replay = harness.storage.gatewaySql
        .prepare(
          "SELECT created_at, expires_at FROM companion_request_replays WHERE session_id = @sessionId AND nonce = @nonce",
        )
        .get({ sessionId: session.sessionId, nonce: "nonce-db-clock-1" }) as
        | { created_at: string; expires_at: string }
        | undefined;
      expect(replay).toBeDefined();
      expect(Math.abs(Date.parse(replay!.created_at) - databaseNowBefore)).toBeLessThan(5_000);
    } finally {
      vi.useRealTimers();
    }
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

  it("preserves nullable legacy grant expiry across companion exchange, access, refresh, and listing", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = NULL WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });

    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeDefined();
    expect(listCompanionSessions(harness.deps).items).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, grantExpiresAt: undefined }),
    ]);
    const rotated = await rotateCompanionSession(harness.deps, { refreshToken: session.refreshToken });
    expect(validateCompanionAccessToken(harness.deps, rotated.accessToken)).toBeDefined();
  });

  it("fails closed for malformed companion expiries and empty revocation markers", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });
    const grantExpiresAt = listDeviceAccessGrants(harness.deps).find(
      (candidate) => candidate.grantId === grant.grantId,
    )!.expiresAt!;

    harness.storage.gatewaySql
      .prepare("UPDATE companion_sessions SET access_token_expires_at = '' WHERE session_id = @sessionId")
      .run({ sessionId: session.sessionId });
    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeUndefined();
    harness.storage.gatewaySql
      .prepare(
        "UPDATE companion_sessions SET access_token_expires_at = @expiresAt, revoked_at = NULL WHERE session_id = @sessionId",
      )
      .run({ sessionId: session.sessionId, expiresAt: session.accessTokenExpiresAt });

    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = '' WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeUndefined();
    expect(listCompanionSessions(harness.deps).items).toEqual([]);
    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET expires_at = @expiresAt WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId, expiresAt: grantExpiresAt });

    harness.storage.gatewaySql
      .prepare("UPDATE companion_sessions SET revoked_at = '' WHERE session_id = @sessionId")
      .run({ sessionId: session.sessionId });
    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeUndefined();
    harness.storage.gatewaySql
      .prepare("UPDATE companion_sessions SET revoked_at = NULL WHERE session_id = @sessionId")
      .run({ sessionId: session.sessionId });

    harness.storage.gatewaySql
      .prepare("UPDATE auth_device_grants SET revoked_at = '' WHERE grant_id = @grantId")
      .run({ grantId: grant.grantId });
    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeUndefined();
  });

  it("rechecks companion refresh and grant authority in the winning update", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    let intercepted = false;
    const preparedSql: string[] = [];
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      preparedSql.push(sql);
      const statement = originalPrepare(sql);
      if (!intercepted && sql.includes("SET access_token_hash = @accessTokenHash")) {
        intercepted = true;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (params: { sessionId: string }) => {
                originalPrepare("UPDATE auth_device_grants SET revoked_at = '' WHERE grant_id = @grantId").run({
                  grantId: grant.grantId,
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

    await expect(rotateCompanionSession(harness.deps, { refreshToken: session.refreshToken })).rejects.toThrow(
      "Companion session refresh token has already been rotated.",
    );
    const grantLockIndex = preparedSql.findIndex(
      (sql) =>
        sql.includes("SELECT *") && sql.includes("FROM auth_device_grants") && sql.includes("grant_id = @grantId"),
    );
    const sessionLockIndex = preparedSql.findIndex(
      (sql) =>
        sql.includes("SELECT *") && sql.includes("FROM companion_sessions") && sql.includes("session_id = @sessionId"),
    );
    expect(grantLockIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLockIndex).toBeGreaterThan(grantLockIndex);
  });

  it("locks companion access authority in grant then session order", async () => {
    const harness = buildAuthHarness();
    const grant = await createApprovedDeviceGrant(harness);
    const keys = createCompanionSigningKeys();
    const session = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
      signingPublicKeyPem: keys.publicKeyPem,
    });
    const originalPrepare = harness.deps.gatewaySql.prepare.bind(harness.deps.gatewaySql);
    const preparedSql: string[] = [];
    vi.spyOn(harness.deps.gatewaySql, "prepare").mockImplementation((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });

    expect(validateCompanionAccessToken(harness.deps, session.accessToken)).toBeDefined();
    const grantLockIndex = preparedSql.findIndex(
      (sql) =>
        sql.includes("SELECT *") && sql.includes("FROM auth_device_grants") && sql.includes("grant_id = @grantId"),
    );
    const sessionLockIndex = preparedSql.findIndex(
      (sql) =>
        sql.includes("SELECT *") && sql.includes("FROM companion_sessions") && sql.includes("session_id = @sessionId"),
    );
    expect(grantLockIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLockIndex).toBeGreaterThan(grantLockIndex);
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

const realPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

describe.skipIf(!realPostgresUrl)("settings-auth-service real PostgreSQL authority", { timeout: 120_000 }, () => {
  it("preserves device, rotation, and replay expiry fences across row-lock waits", async () => {
    expect(realPostgresUrl).toBeTruthy();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `settings_auth_${suffix}`;
    const rootDir = join(tmpdir(), `goatcitadel-settings-auth-pg-${suffix}`);
    const adminPool = new Pool({ connectionString: realPostgresUrl });
    const scopedUrl = new URL(realPostgresUrl!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let storage: Storage | undefined;
    let harness: AuthHarness | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-settings-auth-real-postgres-test",
        pool: { max: 2, connectionTimeoutMs: 10_000 },
      });
      syncClient.prepare("SELECT 1 AS ready").get();
      storage = new Storage({
        db: syncClient,
        transcriptsDir: join(rootDir, "transcripts"),
        auditDir: join(rootDir, "audit"),
      });
      harness = buildAuthHarness({ storage, rootDir });

      const databaseWindow = harness.storage.gatewaySql.createDatabaseTtlWindow(60_000);
      expect(harness.storage.gatewaySql.isDatabaseInstantFuture(databaseWindow.expiresAt.replace("Z", "+00:00"))).toBe(
        true,
      );
      for (const malformed of [
        "",
        "infinity",
        "-infinity",
        "tomorrow",
        "now",
        "epoch",
        "not-a-timestamp",
        "2026-07-11T12:00:00.1234567890Z",
      ]) {
        expect(harness.storage.gatewaySql.isDatabaseInstantFuture(malformed), malformed).toBe(false);
        expect(harness.storage.gatewaySql.isDatabaseInstantExpired(malformed), malformed).toBe(true);
        expect(harness.storage.gatewaySql.isDatabaseInstantWithinSkew(malformed, 1_000), malformed).toBe(false);
      }

      const strictGrant = await createApprovedDeviceGrant(harness);
      for (const malformed of [
        "",
        "infinity",
        "-infinity",
        "tomorrow",
        "now",
        "epoch",
        "not-a-timestamp",
        "2026-07-11T12:00:00.1234567890Z",
      ]) {
        harness.storage.gatewaySql
          .prepare("UPDATE auth_device_grants SET expires_at = @expiresAt WHERE grant_id = @grantId")
          .run({ grantId: strictGrant.grantId, expiresAt: malformed });
        expect(getActiveAuthDeviceGrantById(harness.deps, strictGrant.grantId), malformed).toBeUndefined();
        expect(validateDeviceAccessToken(harness.deps, strictGrant.deviceToken), malformed).toBeUndefined();
      }
      harness.storage.gatewaySql
        .prepare("UPDATE auth_device_grants SET expires_at = @expiresAt WHERE grant_id = @grantId")
        .run({ grantId: strictGrant.grantId, expiresAt: databaseWindow.expiresAt.replace("Z", "+00:00") });
      expect(validateDeviceAccessToken(harness.deps, strictGrant.deviceToken)).toBeDefined();

      const request = await createDeviceAccessRequest(harness.deps, { deviceType: "desktop" }, {});
      const requestLock = await scopedPool.connect();
      try {
        await requestLock.query("BEGIN");
        await requestLock.query("SELECT request_id FROM auth_device_requests WHERE request_id = $1 FOR UPDATE", [
          request.requestId,
        ]);
        const releaseRequestLock = requestLock.query(`
          SELECT pg_sleep(0.35);
          UPDATE auth_device_requests
          SET expires_at = to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
          WHERE request_id = '${escapePostgresTestLiteral(request.requestId)}';
          COMMIT;
        `);

        await expect(
          resolveDeviceAccessApproval(harness.deps, storage.approvals.get(request.approvalId), {
            decision: "approve",
            resolvedBy: "operator:postgres-test",
          }),
        ).rejects.toThrow(/no longer pending or has expired/i);
        await releaseRequestLock;
      } finally {
        requestLock.release();
      }
      expect(storage.approvals.get(request.approvalId).status).toBe("pending");
      expect(listDeviceAccessGrants(harness.deps).filter((item) => item.requestId === request.requestId)).toEqual([]);

      const grant = await createApprovedDeviceGrant(harness);
      const keys = createCompanionSigningKeys();
      const firstSession = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
        signingPublicKeyPem: keys.publicKeyPem,
      });
      expect(Math.abs(Date.parse(firstSession.issuedAt) - Date.now())).toBeLessThan(5_000);
      expect(validateCompanionAccessToken(harness.deps, firstSession.accessToken)).toBeDefined();

      const rotationLock = await scopedPool.connect();
      try {
        await rotationLock.query("BEGIN");
        await rotationLock.query("SELECT session_id FROM companion_sessions WHERE session_id = $1 FOR UPDATE", [
          firstSession.sessionId,
        ]);
        const releaseRotationLock = rotationLock.query(`
          SELECT pg_sleep(0.35);
          UPDATE companion_sessions
          SET refresh_token_expires_at = to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
          WHERE session_id = '${escapePostgresTestLiteral(firstSession.sessionId)}';
          COMMIT;
        `);

        await expect(rotateCompanionSession(harness.deps, { refreshToken: firstSession.refreshToken })).rejects.toThrow(
          "Companion session not found.",
        );
        await releaseRotationLock;
      } finally {
        rotationLock.release();
      }

      const replayKeys = createCompanionSigningKeys();
      const replaySession = await exchangeCompanionSessionFromDeviceGrant(harness.deps, grant.grantId, {
        signingPublicKeyPem: replayKeys.publicKeyPem,
      });
      const malformedReplayTimestamp = harness.storage.gatewaySql.readDatabaseNow();
      for (const [index, malformed] of [
        "",
        "infinity",
        "-infinity",
        "tomorrow",
        "now",
        "epoch",
        "not-a-timestamp",
        "2026-07-11T12:00:00.1234567890Z",
      ].entries()) {
        const malformedNonce = `nonce-pg-malformed-${index}`;
        const malformedBody = { action: "postgres-malformed-replay", malformed };
        await scopedPool.query(
          `
            INSERT INTO companion_request_replays (
              session_id, nonce, method, path, request_hash, created_at, expires_at
            ) VALUES (
              $1, $2, 'POST', '/api/v1/companion/sync', 'malformed-replay',
              to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              $3
            )
          `,
          [replaySession.sessionId, malformedNonce, malformed],
        );
        const malformedSignature = signCompanionRequest({
          privateKeyPem: replayKeys.privateKeyPem,
          method: "POST",
          path: "/api/v1/companion/sync",
          timestamp: malformedReplayTimestamp,
          nonce: malformedNonce,
          body: malformedBody,
        });
        expect(
          () =>
            verifyCompanionRequestSignature(harness!.deps, {
              sessionId: replaySession.sessionId,
              method: "POST",
              path: "/api/v1/companion/sync",
              timestamp: malformedReplayTimestamp,
              nonce: malformedNonce,
              signature: malformedSignature,
              body: malformedBody,
            }),
          malformed,
        ).toThrow("Companion request replay detected.");
      }

      const cleanupNonce = "nonce-pg-cleanup-lock";
      await scopedPool.query(
        `
          INSERT INTO companion_request_replays (
            session_id, nonce, method, path, request_hash, created_at, expires_at
          ) VALUES (
            $1, $2, 'POST', '/cleanup-lock', 'cleanup-lock',
            to_char(
              (clock_timestamp() - interval '2 minutes') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            to_char(
              (clock_timestamp() - interval '1 minute') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          )
        `,
        [replaySession.sessionId, cleanupNonce],
      );
      const cleanupLock = await scopedPool.connect();
      try {
        await cleanupLock.query("BEGIN");
        await cleanupLock.query(
          "SELECT nonce FROM companion_request_replays WHERE session_id = $1 AND nonce = $2 FOR UPDATE",
          [replaySession.sessionId, cleanupNonce],
        );
        const boundaryTimestamp = new Date(
          Date.parse(harness.storage.gatewaySql.readDatabaseNow()) - COMPANION_REQUEST_CLOCK_SKEW_MS + 2_000,
        ).toISOString();
        const boundaryNonce = "nonce-pg-boundary-1";
        const boundaryBody = { action: "postgres-cleanup-boundary" };
        const boundarySignature = signCompanionRequest({
          privateKeyPem: replayKeys.privateKeyPem,
          method: "POST",
          path: "/api/v1/companion/sync",
          timestamp: boundaryTimestamp,
          nonce: boundaryNonce,
          body: boundaryBody,
        });
        const releaseCleanupLock = cleanupLock.query("SELECT pg_sleep(3); COMMIT;");

        expect(() =>
          verifyCompanionRequestSignature(harness!.deps, {
            sessionId: replaySession.sessionId,
            method: "POST",
            path: "/api/v1/companion/sync",
            timestamp: boundaryTimestamp,
            nonce: boundaryNonce,
            signature: boundarySignature,
            body: boundaryBody,
          }),
        ).toThrow("Companion request timestamp is outside the accepted skew window.");
        await releaseCleanupLock;
        expect(
          harness.storage.gatewaySql
            .prepare("SELECT nonce FROM companion_request_replays WHERE session_id = @sessionId AND nonce = @nonce")
            .get({ sessionId: replaySession.sessionId, nonce: boundaryNonce }),
        ).toBeUndefined();
      } finally {
        cleanupLock.release();
      }

      const timestamp = harness.storage.gatewaySql.readDatabaseNow();
      const nonce = "nonce-pg-concurrent-1";
      const method = "POST";
      const path = "/api/v1/companion/sync";
      const body = { action: "postgres-replay-fence" };
      const signature = signCompanionRequest({
        privateKeyPem: replayKeys.privateKeyPem,
        method,
        path,
        timestamp,
        nonce,
        body,
      });
      const replayLock = await scopedPool.connect();
      try {
        await replayLock.query("BEGIN");
        await replayLock.query(
          `
            INSERT INTO companion_request_replays (
              session_id, nonce, method, path, request_hash, created_at, expires_at
            ) VALUES (
              $1, $2, $3, $4, 'held-by-concurrent-request',
              to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              to_char(
                (clock_timestamp() + interval '5 minutes') AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            )
          `,
          [replaySession.sessionId, nonce, method, path],
        );
        const releaseReplayLock = replayLock.query("SELECT pg_sleep(0.35); COMMIT;");

        expect(() =>
          verifyCompanionRequestSignature(harness!.deps, {
            sessionId: replaySession.sessionId,
            method,
            path,
            timestamp,
            nonce,
            signature,
            body,
          }),
        ).toThrow("Companion request replay detected.");
        await releaseReplayLock;
      } finally {
        replayLock.release();
      }
    } finally {
      if (harness) {
        const harnessIndex = authHarnesses.indexOf(harness);
        if (harnessIndex >= 0) {
          authHarnesses.splice(harnessIndex, 1);
        }
      }
      storage?.close();
      rmSync(rootDir, { recursive: true, force: true });
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });
});

function escapePostgresTestLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
