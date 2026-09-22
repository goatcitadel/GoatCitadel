import type { ChatCompletionReasoningEffort, ChatThinkingLevel } from "@goatcitadel/contracts";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";

export const GUIDED_THINKING_LEVELS: ReadonlyArray<{ value: ChatThinkingLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "deep", label: "Deep" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const THINKING_LEVEL_FOR_EFFORT: Readonly<Record<ChatCompletionReasoningEffort, ChatThinkingLevel>> = {
  none: "off",
  low: "minimal",
  medium: "standard",
  high: "extended",
  xhigh: "deep",
  max: "max",
  ultra: "ultra",
};

/**
 * Mirrors the Gateway's Model Change Plan effort gate so the wizard never
 * offers (or silently submits) an effort the selected provider rejects with
 * a 422. The Gateway stays authoritative for model-specific effort metadata.
 */
export function supportedGuidedThinkingLevels(
  capabilities: ProviderModelCatalogOption["capabilities"] | undefined,
): ChatThinkingLevel[] {
  if (capabilities?.reasoning === false) return ["off"];
  const efforts = capabilities?.reasoningEfforts;
  if (!efforts?.length) return GUIDED_THINKING_LEVELS.map((option) => option.value);
  const supported = new Set<ChatThinkingLevel>(["off", ...efforts.map((effort) => THINKING_LEVEL_FOR_EFFORT[effort])]);
  return GUIDED_THINKING_LEVELS.map((option) => option.value).filter((level) => supported.has(level));
}

export function clampGuidedThinkingLevel(
  requested: ChatThinkingLevel,
  supported: readonly ChatThinkingLevel[],
): ChatThinkingLevel {
  if (supported.includes(requested)) return requested;
  const order = GUIDED_THINKING_LEVELS.map((option) => option.value);
  const requestedRank = order.indexOf(requested);
  // Prefer the strongest supported effort that does not exceed the request.
  const fallback = [...supported]
    .filter((level) => order.indexOf(level) <= requestedRank)
    .sort((left, right) => order.indexOf(right) - order.indexOf(left))[0];
  return fallback ?? supported[0] ?? "off";
}

export interface LocalRuntimeSetupGuide {
  title: string;
  steps: readonly string[];
  command?: string;
}

const LOCAL_RUNTIME_GUIDES: Readonly<Record<string, (baseUrl: string) => LocalRuntimeSetupGuide>> = {
  llamacpp: (baseUrl) => ({
    title: "Start llama.cpp before connecting",
    steps: [
      "Download a GGUF model, or let GoatCitadel manage llama-server from Settings → Runtime.",
      `Run llama-server so it answers at ${baseUrl} (the /v1 OpenAI-compatible API).`,
      "Pass --alias so the model name you pick here matches what the server reports from /v1/models.",
      "Select Connect provider — the Gateway probes the endpoint and lists the served models.",
    ],
    command: "llama-server -m path/to/model.gguf --alias gemma-4-local --host 127.0.0.1 --port 8080 --jinja",
  }),
  localai: (baseUrl) => ({
    title: "Start LocalAI before connecting",
    steps: [
      `Run LocalAI so it answers at ${baseUrl}. LocalAI and llama.cpp both default to port 8080 — run only one there, or move one and edit its base URL in Providers.`,
      "Install at least one model (LocalAI gallery or a models/ folder); the model name is the one LocalAI lists at /v1/models.",
      "If you started LocalAI with an API key, set LOCALAI_API_KEY or enter it when the connection plan asks.",
      "Select Connect provider — the Gateway probes the endpoint and lists the installed models.",
    ],
    command: "docker run -p 8080:8080 --name local-ai -ti localai/localai:latest",
  }),
};

export function localRuntimeSetupGuide(
  provider: Pick<ProviderModelCatalogOption, "providerId" | "baseUrl"> | null,
): LocalRuntimeSetupGuide | null {
  if (!provider) return null;
  const build = LOCAL_RUNTIME_GUIDES[provider.providerId.trim().toLowerCase()];
  return build ? build(provider.baseUrl) : null;
}
