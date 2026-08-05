import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayService } from "./gateway-service.js";
import { LlmService } from "./llm-service.js";
import { buildSettingsCandidate, type SettingsConfigCandidate } from "./settings-auth-service.js";
import {
  ConfigGenerationApplyError,
  ConfigGenerationCommitDecisionError,
  ConfigGenerationService,
  recoverLastGoodConfigGeneration,
  type CompleteUnifiedConfigPayload,
  type ConfigGenerationServiceHooks,
} from "./config-generation-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true })));
});

describe("Gateway settings owner transaction", () => {
  it("fences the public settings revision accessor during owner reconciliation", () => {
    const fence = new Error("settings generation is reconciling");
    const getRevision = vi.fn(() => 2);
    const runtime = {
      configGenerationService: {
        assertRuntimeReadsReady: vi.fn(() => {
          throw fence;
        }),
        getRevision,
      },
    };

    expect(() => GatewayService.prototype.readSettingsRevision.call(runtime as GatewayService)).toThrow(fence);
    expect(getRevision).not.toHaveBeenCalled();
  });

  it.each(["llama", "npu", "mesh", "llm", "allowlist", "features"] as const)(
    "reverse-compensates already-entered owners when %s apply fails",
    async (boundary) => {
      const { runtime, candidate, initialConfig, owners } = buildHarness();
      const error = new Error(`${boundary} owner failed`);
      if (boundary === "llama") owners.llamaCppRuntime.restoreLifecycleSnapshot.mockRejectedValueOnce(error);
      if (boundary === "npu") owners.npuSidecar.stop.mockRejectedValueOnce(error);
      if (boundary === "mesh")
        owners.meshService.replaceOptionsReversibly.mockImplementationOnce(() => {
          throw error;
        });
      if (boundary === "llm")
        owners.llmService.replaceRuntimeConfig.mockImplementationOnce(() => {
          throw error;
        });
      if (boundary === "allowlist")
        owners.llmService.updateNetworkAllowlist.mockImplementationOnce(() => {
          throw error;
        });
      if (boundary === "features")
        owners.updateFeatureFlags.mockImplementationOnce(() => {
          throw error;
        });

      let rollbackReceipt: { rollback(): Promise<void> } | undefined;
      await expect(
        GatewayService.prototype.applySettingsRuntimeCandidate.call(runtime as GatewayService, candidate, (receipt) => {
          rollbackReceipt = receipt;
        }),
      ).rejects.toBe(error);
      await rollbackReceipt?.rollback();

      expect(runtime.config).toEqual(initialConfig);
      expect(owners.llamaCppRuntime.updateConfig).toHaveBeenLastCalledWith(initialConfig.assistant.llamaCpp);
      if (boundary !== "llama") {
        expect(owners.npuSidecar.updateConfig).toHaveBeenLastCalledWith(initialConfig.assistant.npu);
      }
      if (boundary === "llm" || boundary === "allowlist" || boundary === "features") {
        expect(owners.meshRollback).toHaveBeenCalledOnce();
      }
      if (boundary === "features") {
        expect(owners.updateFeatureFlags).toHaveBeenLastCalledWith(owners.initialFeatures, {
          resumeParkedRuns: false,
        });
      }
    },
  );

  it("transitions llama identity with exact persistent demand and restores it on rollback", async () => {
    const { runtime, candidate, owners } = buildHarness();
    const previousLifecycle = {
      persistentDemand: { manual: true, api: false, autostart: false },
      idleShutdownRemainingMs: 12_000,
    };
    owners.llamaCppRuntime.getLifecycleSnapshot.mockReturnValue(previousLifecycle);
    let rollbackReceipt: { rollback(): Promise<void> } | undefined;

    await GatewayService.prototype.applySettingsRuntimeCandidate.call(
      runtime as GatewayService,
      candidate,
      (receipt) => {
        rollbackReceipt = receipt;
      },
    );

    expect(owners.llamaCppRuntime.stop).toHaveBeenCalledWith("settings_update");
    expect(owners.llamaCppRuntime.restoreLifecycleSnapshot).toHaveBeenNthCalledWith(1, {
      persistentDemand: { manual: true, api: false, autostart: true },
    });
    expect(owners.llamaCppRuntime.start).not.toHaveBeenCalled();

    await rollbackReceipt?.rollback();

    expect(owners.llamaCppRuntime.stop).toHaveBeenLastCalledWith("rollback");
    expect(owners.llamaCppRuntime.restoreLifecycleSnapshot).toHaveBeenLastCalledWith(previousLifecycle);
  });

  it("builds and validates a candidate without mutating live owners, persistence, or config", async () => {
    const unified = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
    ) as Record<string, any>;
    const config = {
      rootDir: path.resolve(process.cwd(), "../.."),
      assistant: structuredClone(unified.assistant),
      toolPolicy: structuredClone(unified.toolPolicy),
      budgets: structuredClone(unified.budgets),
      llm: structuredClone(unified.llm),
    };
    const before = structuredClone(config);
    const llmService = new LlmService(
      config.llm,
      {},
      {
        networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
        enforceNetworkAllowlist: true,
      },
    );
    const liveLlmBefore = llmService.exportConfigFile();
    const ownerSpies = {
      mesh: vi.fn(),
      npuUpdate: vi.fn(),
      npuStart: vi.fn(),
      npuStop: vi.fn(),
      llamaUpdate: vi.fn(),
      llamaStart: vi.fn(),
      llamaStop: vi.fn(),
      featureUpdate: vi.fn(),
    };
    const features = structuredClone(config.assistant.features);

    const candidate = await buildSettingsCandidate(
      {
        config: config as never,
        llmService,
        meshService: { updateOptions: ownerSpies.mesh },
        npuSidecar: {
          getStatus: () => ({ desiredState: "stopped", processState: "stopped" }) as never,
          updateConfig: ownerSpies.npuUpdate,
          start: ownerSpies.npuStart,
          stop: ownerSpies.npuStop,
        },
        llamaCppRuntime: {
          getStatus: () => ({ desiredState: "stopped", processState: "stopped" }) as never,
          updateConfig: ownerSpies.llamaUpdate,
          start: ownerSpies.llamaStart,
          stop: ownerSpies.llamaStop,
        },
        readFeatureFlags: async () => structuredClone(features),
        readSettingsRevision: () => 9,
        updateFeatureFlags: ownerSpies.featureUpdate,
        assertDeploymentProfileUpdate: () => undefined,
        assertFirecrawlRuntimeUpdate: () => undefined,
      },
      { expectedRevision: 9, budgetMode: "saver" },
    );

    expect(candidate.config.budgets.mode).toBe("saver");
    expect(config).toEqual(before);
    expect(llmService.exportConfigFile()).toEqual(liveLlmBefore);
    for (const spy of Object.values(ownerSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("does not enter runtime owners until the durable commit decision exists", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "goatcitadel-settings-owner-marker-"));
    tempRoots.push(root);
    const payload = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
    ) as CompleteUnifiedConfigPayload;
    await fsPromises.mkdir(path.join(root, "config"), { recursive: true });
    await fsPromises.writeFile(
      path.join(root, "config", "goatcitadel.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    let failCommittedMarker = true;
    const generation = new ConfigGenerationService(root, undefined, {
      beforeTransactionMarkerWrite: (state) => {
        if (state === "committed" && failCommittedMarker) {
          failCommittedMarker = false;
          throw new Error("injected committed marker failure");
        }
      },
    });
    const { runtime, candidate, initialConfig, owners } = buildHarness();
    let ownerReceipt: { rollback(): Promise<void> } | undefined;
    const nextPayload = structuredClone(payload);
    (nextPayload.budgets as { mode: string }).mode = "power";

    await expect(
      generation.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: candidate,
        buildCandidate: () => ({ payload: nextPayload, runtime: candidate }),
        apply: async (next) => {
          await GatewayService.prototype.applySettingsRuntimeCandidate.call(
            runtime as GatewayService,
            next,
            (receipt) => {
              ownerReceipt = receipt;
            },
          );
        },
        restore: async () => {
          await ownerReceipt?.rollback();
        },
      }),
    ).rejects.toBeInstanceOf(ConfigGenerationCommitDecisionError);

    expect(owners.meshService.replaceOptionsReversibly).not.toHaveBeenCalled();
    expect(owners.meshRollback).not.toHaveBeenCalled();
    expect(runtime.config).toEqual(initialConfig);
    expect(owners.updateFeatureFlags).not.toHaveBeenCalled();
    expect(generation.getRevision()).toBe(3);
  });

  it("replaces stale feature system_settings exactly during committed forward recovery without waking autonomy", async () => {
    const { initialConfig } = buildHarness();
    const canonicalFeatures = {
      ...structuredClone(initialConfig.assistant.features),
      autonomyV1Disabled: false,
    };
    const staleFeatures = {
      ...canonicalFeatures,
      autonomyV1Disabled: true,
      replayRegressionV1Enabled: !canonicalFeatures.replayRegressionV1Enabled,
    };
    const set = vi.fn(async () => undefined);
    const resumeRunsWaitingForAutonomyKillSwitch = vi.fn();
    const runtime = {
      config: { assistant: { features: structuredClone(canonicalFeatures) } },
      storage: { systemSettings: { set } },
      configGenerationService: { isRuntimeOwnerReconciliationPending: () => true },
      featureFlagsCache: structuredClone(staleFeatures),
      featureFlagsCacheAtMs: 0,
      durableRunService: { resumeRunsWaitingForAutonomyKillSwitch },
    };

    await (
      GatewayService.prototype as unknown as {
        applyStartupFeatureFlags(this: typeof runtime): Promise<void>;
      }
    ).applyStartupFeatureFlags.call(runtime);

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith("feature_flags_v1", canonicalFeatures);
    expect(runtime.config.assistant.features).toEqual(canonicalFeatures);
    expect(runtime.featureFlagsCache).toEqual(canonicalFeatures);
    expect(resumeRunsWaitingForAutonomyKillSwitch).not.toHaveBeenCalled();
  });

  it("serializes two kill-switch clients, rejects the stale revision, and wakes only after the winning commit", async () => {
    const { runtime, generation, updateFeatureFlags, resumeParkedRuns } = await buildAutonomySettingsGatewayHarness();

    const first = await GatewayService.prototype.updateSettings.call(runtime as GatewayService, {
      expectedRevision: 1,
      features: { autonomyV1Disabled: false },
    });

    expect(first.revision).toBe(2);
    expect(first.features.autonomyV1Disabled).toBe(false);
    expect(resumeParkedRuns).toHaveBeenCalledOnce();
    expect(updateFeatureFlags).toHaveBeenCalledOnce();
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 2, transactionState: "idle" });

    await expect(
      GatewayService.prototype.updateSettings.call(runtime as GatewayService, {
        expectedRevision: 1,
        features: { autonomyV1Disabled: true },
      }),
    ).rejects.toMatchObject({
      name: "ConflictError",
      details: { expectedRevision: 1, currentRevision: 2 },
    });

    expect(updateFeatureFlags).toHaveBeenCalledOnce();
    expect(resumeParkedRuns).toHaveBeenCalledOnce();
    expect((generation.getActivePayload().assistant.features as Record<string, boolean>).autonomyV1Disabled).toBe(
      false,
    );
  });

  it("rejects an active-lease llama identity change before staging a config generation", async () => {
    const { runtime, generation } = await buildAutonomySettingsGatewayHarness();
    const conflict = new Error("llama.cpp runtime has an active lease");
    runtime.llamaCppRuntime.assertCanApplyConfig = vi.fn(() => {
      throw conflict;
    });

    await expect(
      GatewayService.prototype.updateSettings.call(runtime as GatewayService, {
        expectedRevision: 1,
        llamaCpp: { enabled: true, modelPath: "models/replacement.gguf" },
      }),
    ).rejects.toBe(conflict);

    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 1, transactionState: "idle" });
    expect(runtime.llamaCppRuntime.updateConfig).not.toHaveBeenCalled();
  });

  it("restores canonical/runtime kill-switch state and never wakes parked runs when feature owner apply fails", async () => {
    const { runtime, generation, updateFeatureFlags, resumeParkedRuns } = await buildAutonomySettingsGatewayHarness({
      failFeatureApply: true,
    });

    await expect(
      GatewayService.prototype.updateSettings.call(runtime as GatewayService, {
        expectedRevision: 1,
        features: { autonomyV1Disabled: false },
      }),
    ).rejects.toBeInstanceOf(ConfigGenerationApplyError);

    expect((await runtime.readFeatureFlags()).autonomyV1Disabled).toBe(true);
    expect(runtime.config.assistant.features.autonomyV1Disabled).toBe(true);
    expect((generation.getActivePayload().assistant.features as Record<string, boolean>).autonomyV1Disabled).toBe(true);
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 3, transactionState: "idle" });
    expect(updateFeatureFlags).toHaveBeenCalledTimes(2);
    expect(resumeParkedRuns).not.toHaveBeenCalled();
  });

  it("routes compatibility auth writes through positive revision CAS without persisting credential bytes", async () => {
    const { runtime, generation } = await buildAutonomySettingsGatewayHarness();

    const updated = await GatewayService.prototype.updateAuthSettings.call(runtime as GatewayService, {
      expectedRevision: 1,
      mode: "token",
      token: "gateway-compat-secret",
      allowLoopbackBypass: false,
    });

    expect(updated).toMatchObject({ mode: "token", tokenConfigured: true });
    expect(runtime.config.assistant.auth.token.value).toBe("gateway-compat-secret");
    expect(generation.getRevision()).toBe(2);
    expect(JSON.stringify(generation.getActivePayload())).not.toContain("gateway-compat-secret");

    await expect(
      GatewayService.prototype.updateAuthSettings.call(runtime as GatewayService, {
        expectedRevision: 1,
        mode: "token",
        token: "stale-compat-secret",
      }),
    ).rejects.toMatchObject({
      name: "ConflictError",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(runtime.config.assistant.auth.token.value).toBe("gateway-compat-secret");
    expect(JSON.stringify(generation.getActivePayload())).not.toContain("stale-compat-secret");

    await expect(
      GatewayService.prototype.updateAuthSettings.call(runtime as GatewayService, {
        expectedRevision: 0,
        mode: "none",
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(runtime.config.assistant.auth.mode).toBe("token");
  });

  it("retains a secret-free committed auth generation when process death precedes owner apply", async () => {
    const { runtime, generation, root } = await buildAutonomySettingsGatewayHarness({
      generationHooks: {
        afterCommitMarker: () => {
          throw new Error("simulated auth compatibility process death");
        },
      },
    });

    await expect(
      GatewayService.prototype.updateAuthSettings.call(runtime as GatewayService, {
        expectedRevision: 1,
        mode: "token",
        token: "never-persist-auth-secret",
      }),
    ).rejects.toThrow("simulated auth compatibility process death");

    expect(runtime.config.assistant.auth.token.value).not.toBe("never-persist-auth-secret");
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 2, transactionState: "committed" });
    expect(await fsPromises.readFile(path.join(root, "config", "goatcitadel.json"), "utf8")).not.toContain(
      "never-persist-auth-secret",
    );
    expect(
      await fsPromises.readFile(path.join(root, "config", ".generations", "transaction.json"), "utf8"),
    ).not.toContain("never-persist-auth-secret");
    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 2 });
    expect(new ConfigGenerationService(root).isRuntimeOwnerReconciliationPending()).toBe(true);
  });
});

async function buildAutonomySettingsGatewayHarness(
  options: { failFeatureApply?: boolean; generationHooks?: ConfigGenerationServiceHooks } = {},
): Promise<{
  runtime: any;
  generation: ConfigGenerationService;
  updateFeatureFlags: ReturnType<typeof vi.fn>;
  resumeParkedRuns: ReturnType<typeof vi.fn>;
  root: string;
}> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "goatcitadel-autonomy-settings-generation-"));
  tempRoots.push(root);
  const payload = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  (payload.assistant.features as Record<string, boolean>).autonomyV1Disabled = true;
  await fsPromises.mkdir(path.join(root, "config"), { recursive: true });
  await fsPromises.writeFile(
    path.join(root, "config", "goatcitadel.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  const generation = new ConfigGenerationService(root, undefined, options.generationHooks);
  const config = {
    rootDir: root,
    assistant: structuredClone(payload.assistant),
    toolPolicy: structuredClone(payload.toolPolicy),
    budgets: structuredClone(payload.budgets),
    llm: structuredClone(payload.llm),
  };
  let features = structuredClone(config.assistant.features) as Record<string, boolean>;
  let injectedFailureUsed = false;
  const updateFeatureFlags = vi.fn(
    async (patch: Partial<Record<string, boolean>>, _options: { resumeParkedRuns?: boolean } = {}) => {
      if (options.failFeatureApply && !injectedFailureUsed && patch.autonomyV1Disabled === false) {
        injectedFailureUsed = true;
        throw new Error("injected autonomy feature owner failure");
      }
      features = { ...features, ...patch };
      config.assistant.features = structuredClone(features) as typeof config.assistant.features;
      return structuredClone(features);
    },
  );
  const resumeParkedRuns = vi.fn(() => {
    expect(generation.getHealthSnapshot().transactionState).toBe("idle");
  });
  const llmService = new LlmService(
    config.llm as never,
    {},
    {
      networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
      enforceNetworkAllowlist: true,
    },
  );
  const stoppedStatus = {
    desiredState: "stopped",
    processState: "stopped",
  };
  const runtime: any = {
    config,
    configGenerationService: generation,
    llmService,
    meshService: { updateOptions: vi.fn() },
    npuSidecar: { getStatus: () => stoppedStatus },
    llamaCppRuntime: {
      getStatus: () => stoppedStatus,
      assertCanApplyConfig: vi.fn(() => undefined),
      getConfigSnapshot: vi.fn(() => structuredClone(config.assistant.llamaCpp)),
      getLifecycleSnapshot: vi.fn(() => ({
        persistentDemand: { manual: false, api: false, autostart: false },
      })),
      assessConfigTransition: vi.fn(() => ({ allowed: true, identityChanged: false, activeLeaseCount: 0 })),
      updateConfig: vi.fn(() => undefined),
      stop: vi.fn(async () => stoppedStatus),
      restoreLifecycleSnapshot: vi.fn(async () => stoppedStatus),
    },
    storage: {
      mesh: { snapshotRuntimeArtifacts: vi.fn(async () => undefined) },
      cronJobs: { list: vi.fn(async () => structuredClone(payload.cronJobs.jobs ?? [])) },
    },
    readFeatureFlags: async () => structuredClone(features),
    updateFeatureFlags,
    assertDeploymentProfileUpdate: () => undefined,
    assertFirecrawlRuntimeUpdate: () => undefined,
    resumeRunsAfterAutonomyKillSwitchDisengaged: resumeParkedRuns,
  };
  runtime.getRouteCompositionPort = () => runtime;
  runtime.readSettingsRevision = () => GatewayService.prototype.readSettingsRevision.call(runtime as GatewayService);
  runtime.getSettings = async () => await GatewayService.prototype.getSettings.call(runtime as GatewayService);
  runtime.updateSettings = (input: unknown) =>
    GatewayService.prototype.updateSettings.call(runtime as GatewayService, input as never);
  runtime.applySettingsRuntimeCandidate = (
    candidate: SettingsConfigCandidate,
    registerRollback: (receipt: { rollback(): Promise<void> }) => void,
    reason?: "settings_update" | "rollback",
  ) =>
    GatewayService.prototype.applySettingsRuntimeCandidate.call(
      runtime as GatewayService,
      candidate,
      registerRollback,
      reason,
    );
  runtime.serializeRootPath = (value: string) => value;
  runtime.buildUnifiedConfigPayloadForRuntime = async (
    candidateConfig: unknown,
    candidateLlm: CompleteUnifiedConfigPayload["llm"],
    candidateFeatures: Record<string, boolean>,
  ) =>
    await (
      GatewayService.prototype as unknown as {
        buildUnifiedConfigPayloadForRuntime(
          config: unknown,
          llm: CompleteUnifiedConfigPayload["llm"],
          features: Record<string, boolean>,
        ): Promise<CompleteUnifiedConfigPayload>;
      }
    ).buildUnifiedConfigPayloadForRuntime.call(runtime, candidateConfig, candidateLlm, candidateFeatures);
  runtime.buildUnifiedConfigPayloadFromRuntime = (
    candidateConfig: unknown,
    candidateLlm: CompleteUnifiedConfigPayload["llm"],
    candidateFeatures: Record<string, boolean>,
    cronJobs: CompleteUnifiedConfigPayload["cronJobs"],
  ) =>
    (
      GatewayService.prototype as unknown as {
        buildUnifiedConfigPayloadFromRuntime(
          config: unknown,
          llm: CompleteUnifiedConfigPayload["llm"],
          features: Record<string, boolean>,
          cronJobs: CompleteUnifiedConfigPayload["cronJobs"],
        ): CompleteUnifiedConfigPayload;
      }
    ).buildUnifiedConfigPayloadFromRuntime.call(runtime, candidateConfig, candidateLlm, candidateFeatures, cronJobs);

  return { runtime, generation, updateFeatureFlags, resumeParkedRuns, root };
}

function buildHarness() {
  const unified = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as Record<string, any>;
  const initialConfig = {
    rootDir: "C:/goatcitadel-test",
    assistant: structuredClone(unified.assistant),
    toolPolicy: structuredClone(unified.toolPolicy),
    budgets: structuredClone(unified.budgets),
    llm: structuredClone(unified.llm),
  };
  const nextConfig = structuredClone(initialConfig);
  nextConfig.assistant.llamaCpp.enabled = true;
  nextConfig.assistant.llamaCpp.autoStart = true;
  nextConfig.assistant.npu.sidecar.baseUrl = "http://127.0.0.1:49999";
  nextConfig.assistant.mesh.nodeId = "candidate-node";
  nextConfig.toolPolicy.sandbox.networkAllowlist = ["candidate.example"];
  nextConfig.llm.activeModel = "candidate-model";
  nextConfig.assistant.features = {
    ...nextConfig.assistant.features,
    autonomyV1Disabled: !nextConfig.assistant.features.autonomyV1Disabled,
  };

  const initialFeatures = structuredClone(initialConfig.assistant.features);
  const initialMeshOptions = {
    enabled: initialConfig.assistant.mesh.enabled,
    mode: initialConfig.assistant.mesh.mode,
    localNodeId: initialConfig.assistant.mesh.nodeId,
    localNodeLabel: initialConfig.assistant.mesh.label,
    advertiseAddress: initialConfig.assistant.mesh.advertiseAddress,
    requireMtls: initialConfig.assistant.mesh.security.requireMtls,
    tailnetEnabled: initialConfig.assistant.mesh.security.tailnet.enabled,
    joinToken: undefined,
    defaultLeaseTtlSeconds: initialConfig.assistant.mesh.leases.ttlSeconds,
  };
  const llmService = {
    exportConfigFile: vi.fn(() => structuredClone(initialConfig.llm)),
    replaceRuntimeConfig: vi.fn(() => undefined),
    updateNetworkAllowlist: vi.fn(() => undefined),
  };
  const meshRollback = vi.fn();
  const meshService = {
    getOptionsSnapshot: vi.fn(() => structuredClone(initialMeshOptions)),
    replaceOptionsReversibly: vi.fn(() => ({ rollback: meshRollback })),
  };
  const npuSidecar = {
    getConfigSnapshot: vi.fn(() => structuredClone(initialConfig.assistant.npu)),
    updateConfig: vi.fn(() => undefined),
    stop: vi.fn(async () => ({})),
  };
  const llamaCppRuntime = {
    getConfigSnapshot: vi.fn(() => structuredClone(initialConfig.assistant.llamaCpp)),
    getStatus: vi.fn(() => ({ desiredState: "stopped", processState: "stopped" })),
    getLifecycleSnapshot: vi.fn(() => ({
      persistentDemand: { manual: false, api: false, autostart: false },
    })),
    assessConfigTransition: vi.fn(() => ({
      allowed: true,
      identityChanged: true,
      activeLeaseCount: 0,
    })),
    assertCanApplyConfig: vi.fn(() => undefined),
    updateConfig: vi.fn(() => undefined),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
    restoreLifecycleSnapshot: vi.fn(async () => ({})),
  };
  const updateFeatureFlags = vi.fn(async (features) => features);
  const runtime = {
    config: structuredClone(initialConfig),
    llmService,
    meshService,
    npuSidecar,
    llamaCppRuntime,
    readFeatureFlags: vi.fn(async () => structuredClone(initialFeatures)),
    updateFeatureFlags,
  };
  const candidate: SettingsConfigCandidate = {
    config: nextConfig as never,
    features: structuredClone(nextConfig.assistant.features),
    llm: structuredClone(nextConfig.llm),
    settings: {} as never,
    input: {
      expectedRevision: 1,
      defaultToolProfile: nextConfig.assistant.defaultToolProfile,
      networkAllowlist: nextConfig.toolPolicy.sandbox.networkAllowlist,
      llm: { activeModel: nextConfig.llm.activeModel },
      mesh: { nodeId: nextConfig.assistant.mesh.nodeId },
      npu: { sidecarUrl: nextConfig.assistant.npu.sidecar.baseUrl },
      llamaCpp: { enabled: true, autoStart: true },
      features: nextConfig.assistant.features,
    },
  };
  return {
    runtime,
    candidate,
    initialConfig,
    owners: {
      llmService,
      meshService,
      npuSidecar,
      llamaCppRuntime,
      updateFeatureFlags,
      meshRollback,
      initialMeshOptions,
      initialFeatures,
    },
  };
}
