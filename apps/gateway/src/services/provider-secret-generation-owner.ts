import { ValidationError } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { replaceMutableConfigValue } from "../config-sync-lib.js";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import type { LlmService } from "./llm-service.js";
import type { ConfigGenerationService, CompleteUnifiedConfigPayload } from "./config-generation-service.js";
import {
  prepareProviderSecretMutation,
  type SaveProviderSecretInput,
  type DeleteProviderSecretInput,
  type PreparedProviderSecretMutation,
  type ProviderSecretMutationResponse,
} from "./provider-secret-persistence.js";

export interface ProviderSecretGenerationHost {
  config: GatewayRuntimeConfig;
  llmService: Pick<
    LlmService,
    | "snapshotRuntimeConfigForPersistence"
    | "exportConfigFile"
    | "replaceRuntimeConfig"
    | "getProviderSecretStatus"
    | "isProviderKeychainAvailable"
    | "readProviderKeychainApiKeyForPersistence"
    | "readInlineProviderApiKeyForPersistence"
    | "restoreInlineProviderApiKeyForPersistence"
    | "clearInlineProviderApiKey"
    | "invalidateProviderSecretStatus"
    | "setProviderApiKey"
    | "deleteProviderApiKey"
  >;
  configGenerationService: Pick<ConfigGenerationService, "commit">;
  buildPayload(config: GatewayRuntimeConfig, llm: LlmConfigFile): Promise<CompleteUnifiedConfigPayload>;
}

/** Configuration generation retains the CAS, durable recovery intent and compensation boundary. */
export async function commitProviderSecretGeneration(
  host: ProviderSecretGenerationHost,
  input: (SaveProviderSecretInput & { operation: "set" }) | (DeleteProviderSecretInput & { operation: "delete" }),
): Promise<ProviderSecretMutationResponse> {
  type ProviderSecretRuntimeState = {
    config: GatewayRuntimeConfig;
    llm: LlmConfigFile;
    runtimeLlm: LlmConfigFile;
    prepared?: PreparedProviderSecretMutation;
  };
  const previousConfig = structuredClone(host.config);
  const previousRuntimeLlm = host.llmService.snapshotRuntimeConfigForPersistence();
  let appliedStatus: Omit<ProviderSecretMutationResponse, "revision"> | undefined;
  let preparedMutation: PreparedProviderSecretMutation | undefined;

  const commit = await host.configGenerationService.commit<ProviderSecretRuntimeState>({
    expectedRevision: input.expectedRevision,
    requireExpectedRevision: true,
    previousRuntime: {
      config: previousConfig,
      llm: host.llmService.exportConfigFile(),
      runtimeLlm: previousRuntimeLlm,
    },
    buildCandidate: async () => {
      const prepared = prepareProviderSecretMutation({
        operation: input.operation,
        providerId: input.providerId,
        ...(input.operation === "set" ? { apiKey: input.apiKey, envVar: input.envVar } : {}),
        storage: input.storage,
        rootDir: host.config.rootDir,
        llmService: host.llmService,
      });
      preparedMutation = prepared;
      const llm = host.llmService.exportConfigFile();
      const runtimeLlm = host.llmService.snapshotRuntimeConfigForPersistence();
      if (prepared.apiKeyEnv) {
        const provider = llm.providers.find((entry) => entry.providerId === prepared.providerId);
        const runtimeProvider = runtimeLlm.providers.find((entry) => entry.providerId === prepared.providerId);
        if (!provider || !runtimeProvider) {
          throw new ValidationError({ message: `Unknown LLM provider: ${prepared.providerId}` });
        }
        provider.apiKeyEnv = prepared.apiKeyEnv;
        runtimeProvider.apiKeyEnv = prepared.apiKeyEnv;
      }
      const runtimeProvider = runtimeLlm.providers.find((entry) => entry.providerId === prepared.providerId);
      if (!runtimeProvider) {
        throw new ValidationError({ message: `Unknown LLM provider: ${prepared.providerId}` });
      }
      runtimeProvider.apiKey = undefined;
      const config = structuredClone(host.config);
      config.llm = structuredClone(llm);
      return {
        runtime: { config, llm, runtimeLlm, prepared },
        payload: await host.buildPayload(config, llm),
      };
    },
    captureRuntimeOwnerRecoveryIntent: (candidate) => ({
      version: 1,
      providerSecretEffects: candidate.prepared?.effects ?? [],
    }),
    apply: (candidate) => {
      if (!candidate.prepared) {
        throw new Error("Provider secret candidate is missing its prepared owner transition.");
      }
      candidate.prepared.apply();
      // The inline value is cleared only after its selected external owner
      // has been written and verified. Replacing the provider snapshot then
      // makes live runtime/config agree with the secret-free canonical file.
      host.llmService.replaceRuntimeConfig(candidate.runtimeLlm);
      replaceMutableConfigValue(host.config.llm, candidate.llm);
      const status = host.llmService.getProviderSecretStatus(candidate.prepared.providerId, {
        useCache: false,
      });
      appliedStatus = {
        providerId: status.providerId,
        hasSecret: status.hasApiKey,
        source: status.apiKeySource,
      };
    },
    restore: async (previous) => {
      const errors: unknown[] = [];
      // The prepared mutation owns exact keychain/env/inline compensation.
      // It is captured inside buildCandidate after the CAS fence, so stale
      // clients never read or mutate secret owners. Attempt every owner even
      // if one reverse step fails so a config-owner fault cannot strand an
      // otherwise-restorable credential effect.
      for (const restoreOwner of [
        () => preparedMutation?.restore(),
        () => host.llmService.replaceRuntimeConfig(previous.runtimeLlm),
        () => replaceMutableConfigValue(host.config.llm, previous.config.llm),
      ]) {
        try {
          await restoreOwner();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Provider secret owner compensation did not fully complete.");
      }
    },
  });

  if (!appliedStatus) {
    throw new Error("Provider secret generation committed without applying its runtime owner.");
  }
  return { revision: commit.revision, ...appliedStatus };
}
