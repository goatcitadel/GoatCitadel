import { findProviderTemplate, type LlmProviderRequestConfig } from "@goatcitadel/contracts";
import { previewLlmModels, type RuntimeSettingsResponse } from "../api/client";
import { dedupeProviderModels } from "./provider-model-values.js";

export interface ProviderModelPreviewResult {
  items: string[];
  source: "remote" | "fallback";
  warning?: string;
}

export async function previewProviderModels(
  input: {
    providerId: string;
    baseUrl: string;
    apiStyle?: RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
    fallbackModel?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<ProviderModelPreviewResult> {
  const response = await previewLlmModels(
    {
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      apiStyle: input.apiStyle,
      apiKey: input.apiKey,
      apiKeyEnv: input.apiKeyEnv,
      request: input.request,
      headers: input.headers,
    },
    {
      signal: options?.signal,
    },
  );
  const template = findProviderTemplate(input.providerId);
  return {
    items:
      response.source === "live"
        ? dedupeProviderModels(response.items.map((item) => item.id))
        : dedupeProviderModels([
            input.fallbackModel,
            ...(template?.knownModels ?? []),
            ...response.items.map((item) => item.id),
          ]),
    source: response.source === "live" ? "remote" : "fallback",
    warning: response.warning,
  };
}
