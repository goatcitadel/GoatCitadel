import type { MeshService } from "@goatcitadel/mesh-core";
import { replaceMutableConfigValue } from "../../config-sync-lib.js";
import type { GatewayRuntimeConfig } from "../../config.js";
import type { LlamaCppRuntimeService } from "../llama-cpp-runtime-service.js";
import type { LlmService } from "../llm-service.js";
import type { NpuSidecarService } from "../npu-sidecar-service.js";
import type { SettingsConfigCandidate } from "../settings-auth-service.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import type { StoredFeatureFlags } from "./feature-flags.js";

interface SettingsRuntimeCandidateDeps {
  readonly config: GatewayRuntimeConfig;
  readonly llamaCppRuntime: Pick<
    LlamaCppRuntimeService,
    | "getConfigSnapshot"
    | "getLifecycleSnapshot"
    | "assessConfigTransition"
    | "assertCanApplyConfig"
    | "stop"
    | "updateConfig"
    | "restoreLifecycleSnapshot"
  >;
  readonly npuSidecar: Pick<NpuSidecarService, "getConfigSnapshot" | "updateConfig" | "stop">;
  readonly meshService: Pick<MeshService, "replaceOptionsReversibly">;
  readonly llmService: Pick<
    LlmService,
    "snapshotRuntimeConfigForPersistence" | "replaceRuntimeConfig" | "updateNetworkAllowlist"
  >;
  readFeatureFlags(): Promise<RuntimeSettings["features"]>;
  updateFeatureFlags(
    patch: Partial<RuntimeSettings["features"]>,
    options: { resumeParkedRuns: false; replaceStore?: StoredFeatureFlags },
  ): Promise<RuntimeSettings["features"]>;
}

async function transitionLlamaCppRuntimeConfig(
  runtime: SettingsRuntimeCandidateDeps["llamaCppRuntime"],
  nextConfig: GatewayRuntimeConfig["assistant"]["llamaCpp"],
  lifecycle: ReturnType<LlamaCppRuntimeService["getLifecycleSnapshot"]>,
  reason: string,
): Promise<void> {
  const assessment = runtime.assessConfigTransition(nextConfig);
  runtime.assertCanApplyConfig(nextConfig);
  if (assessment.identityChanged) {
    await runtime.stop(reason);
  }
  runtime.updateConfig(nextConfig);
  await runtime.restoreLifecycleSnapshot(lifecycle);
}

export async function applySettingsRuntimeCandidate(
  deps: SettingsRuntimeCandidateDeps,
  candidate: SettingsConfigCandidate,
  registerRollback: (receipt: { rollback(): Promise<void> }) => void,
  reason: "settings_update" | "rollback",
): Promise<{ rollback(): Promise<void> }> {
  const input = candidate.input;
  const compensations: Array<() => void | Promise<void>> = [];
  const previousConfig = structuredClone(deps.config);
  const previousFeatures = structuredClone(await deps.readFeatureFlags());
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    const compensationErrors: unknown[] = [];
    for (const compensate of [...compensations].reverse()) {
      try {
        await compensate();
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
    }
    if (compensationErrors.length > 0) {
      throw new AggregateError(compensationErrors, "One or more settings owner reverse compensations failed.");
    }
  };
  const rollbackReceipt = { rollback };
  // Registration precedes every owner effect. ConfigGenerationService invokes
  // this receipt only after its monotonic rollback canonical and committed
  // recovery marker are durable.
  registerRollback(rollbackReceipt);

  // Process transitions can fail after changing desired state. Run them
  // first and register semantic compensation before each attempt.
  if (input.llamaCpp) {
    const previousLlamaConfig = deps.llamaCppRuntime.getConfigSnapshot();
    const previousLlamaLifecycle = deps.llamaCppRuntime.getLifecycleSnapshot();
    const candidateLlamaEnabled = candidate.config.assistant.llamaCpp.enabled;
    const candidateLlamaLifecycle = {
      persistentDemand: {
        manual: candidateLlamaEnabled && previousLlamaLifecycle.persistentDemand.manual,
        api: candidateLlamaEnabled && previousLlamaLifecycle.persistentDemand.api,
        autostart: candidateLlamaEnabled && candidate.config.assistant.llamaCpp.autoStart,
      },
      ...(deps.llamaCppRuntime.assessConfigTransition(candidate.config.assistant.llamaCpp).identityChanged
        ? {}
        : previousLlamaLifecycle.idleShutdownRemainingMs === undefined
          ? {}
          : { idleShutdownRemainingMs: previousLlamaLifecycle.idleShutdownRemainingMs }),
    };
    compensations.push(async () => {
      await transitionLlamaCppRuntimeConfig(
        deps.llamaCppRuntime,
        previousLlamaConfig,
        previousLlamaLifecycle,
        "rollback",
      );
    });
    await transitionLlamaCppRuntimeConfig(
      deps.llamaCppRuntime,
      candidate.config.assistant.llamaCpp,
      candidateLlamaLifecycle,
      reason,
    );
  }

  if (input.npu) {
    const previousNpuConfig = deps.npuSidecar.getConfigSnapshot();
    compensations.push(async () => {
      deps.npuSidecar.updateConfig(previousNpuConfig);
      await deps.npuSidecar.stop("rollback");
    });
    deps.npuSidecar.updateConfig(candidate.config.assistant.npu);
    await deps.npuSidecar.stop(reason);
  }

  if (input.mesh) {
    const meshReplacement = await deps.meshService.replaceOptionsReversibly({
      enabled: candidate.config.assistant.mesh.enabled,
      mode: candidate.config.assistant.mesh.mode,
      localNodeId: candidate.config.assistant.mesh.nodeId,
      localNodeLabel: candidate.config.assistant.mesh.label,
      advertiseAddress: candidate.config.assistant.mesh.advertiseAddress,
      requireMtls: candidate.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: candidate.config.assistant.mesh.security.tailnet.enabled,
      joinToken: process.env[candidate.config.assistant.mesh.security.joinTokenEnv],
      defaultLeaseTtlSeconds: candidate.config.assistant.mesh.leases.ttlSeconds,
    });
    compensations.push(() => meshReplacement.rollback());
  }

  if (input.llm || input.llamaCpp) {
    const previousLlm = deps.llmService.snapshotRuntimeConfigForPersistence();
    compensations.push(() => {
      deps.llmService.replaceRuntimeConfig(previousLlm);
    });
    deps.llmService.replaceRuntimeConfig(candidate.llm);
  }
  if (input.toolApprovalMode || input.networkAllowlist) {
    const previousAllowlist = [...previousConfig.toolPolicy.sandbox.networkAllowlist];
    compensations.push(() => deps.llmService.updateNetworkAllowlist(previousAllowlist, { enforce: true }));
    deps.llmService.updateNetworkAllowlist(candidate.config.toolPolicy.sandbox.networkAllowlist, { enforce: true });
  }

  compensations.push(() => {
    replaceMutableConfigValue(deps.config.assistant, previousConfig.assistant);
    replaceMutableConfigValue(deps.config.toolPolicy, previousConfig.toolPolicy);
    replaceMutableConfigValue(deps.config.budgets, previousConfig.budgets);
    replaceMutableConfigValue(deps.config.llm, previousConfig.llm);
  });
  replaceMutableConfigValue(deps.config.assistant, candidate.config.assistant);
  replaceMutableConfigValue(deps.config.toolPolicy, candidate.config.toolPolicy);
  replaceMutableConfigValue(deps.config.budgets, candidate.config.budgets);
  replaceMutableConfigValue(deps.config.llm, candidate.llm);

  // Feature publication is last because it is durable and can wake parked
  // autonomous runs. No later owner step is allowed to fail after it.
  if (input.features || input.featureReview) {
    compensations.push(async () => {
      deps.config.featureSources = previousConfig.featureSources;
      await deps.updateFeatureFlags(previousFeatures, {
        resumeParkedRuns: false,
        replaceStore: previousConfig.featureSources?.canonicalStore,
      });
    });
    deps.config.featureSources = candidate.config.featureSources;
    await deps.updateFeatureFlags(input.features ?? {}, {
      resumeParkedRuns: false,
      replaceStore: candidate.config.featureSources?.canonicalStore,
    });
  }
  return rollbackReceipt;
}
