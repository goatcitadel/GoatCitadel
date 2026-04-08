/**
 * Pure helpers + supplementary constants extracted from SettingsPage.tsx
 * as part of Step 10 (page decomposition). No React/state dependencies.
 * `scrollToSettingsSection` is the only DOM-touching helper and is
 * SSR-guarded.
 */

import type { GatewayAuthStorageMode, RuntimeSettingsResponse } from "../../api/client";
import type { SelectOption } from "../../components/SelectOrCustom";
import { dedupeProviderModels } from "../../hooks/useProviderModelCatalog";
import type { SettingsTab } from "../../content/page-registry";
import type { NormalizedRuntimeSettingsResponse, SettingsSectionId } from "./settings-page-constants";

export const ALLOWLIST_PRESETS: Array<{ id: string; label: string; hosts: string[] }> = [
  { id: "strict", label: "Strict (no outbound hosts)", hosts: [] },
  { id: "local", label: "Local models only", hosts: ["127.0.0.1", "localhost"] },
  {
    id: "web-research",
    label: "Web research (browser tools + local)",
    hosts: [
      "127.0.0.1",
      "localhost",
      "*.duckduckgo.com",
      "*.google.com",
      "*.bing.com",
      "*.wikipedia.org",
      "*.github.com",
      "*.developer.mozilla.org",
    ],
  },
  {
    id: "common-llm",
    label: "Common providers + local",
    hosts: ["127.0.0.1", "localhost", "api.openai.com", "openrouter.ai"],
  },
  {
    id: "tailnet-genie",
    label: "Tailnet + Genie IR20",
    hosts: ["127.0.0.1", "localhost", "100.64.0.4", "ir20"],
  },
];

export function scrollToSettingsSection(sectionId: string, behavior: ScrollBehavior = "smooth"): void {
  if (typeof document === "undefined") {
    return;
  }
  document.getElementById(sectionId)?.scrollIntoView({ behavior, block: "start" });
}

export function resolveSettingsTabSection(tab: SettingsTab): SettingsSectionId {
  switch (tab) {
    case "providers":
      return "settings-models";
    case "access":
      return "settings-access";
    case "runtime":
      return "settings-voice";
    case "budget":
      return "settings-runtime";
    case "general":
    default:
      return "settings-overview";
  }
}

export function resolveSettingsTabSections(tab: SettingsTab): SettingsSectionId[] {
  switch (tab) {
    case "providers":
      return ["settings-models", "settings-tests"];
    case "access":
      return ["settings-access"];
    case "runtime":
      return ["settings-voice", "settings-runtime"];
    case "budget":
      return ["settings-runtime"];
    case "general":
    default:
      return ["settings-overview"];
  }
}

export interface ProviderScopedModelOptionSource {
  providerId: string;
  defaultModel: string;
  models: string[];
}

export function matchAllowlistPreset(allowlist: string[]): string {
  for (const preset of ALLOWLIST_PRESETS) {
    if (preset.hosts.length !== allowlist.length) {
      continue;
    }
    const left = [...preset.hosts].sort().join("|");
    const right = [...allowlist].sort().join("|");
    if (left === right) {
      return preset.id;
    }
  }
  return "custom";
}

export function buildProviderScopedModelOptions(input: {
  providerId: string;
  providers: ProviderScopedModelOptionSource[];
  previewedProviderId?: string;
  previewedModels?: string[];
  currentModel?: string;
  fallbackModel?: string;
}): SelectOption[] {
  const provider = input.providers.find((item) => item.providerId === input.providerId);
  const previewModels = input.previewedProviderId === input.providerId ? (input.previewedModels ?? []) : [];
  const items = dedupeProviderModels([
    provider?.defaultModel,
    ...(provider?.models ?? []),
    ...previewModels,
    input.fallbackModel,
    input.currentModel,
  ]);
  return items.map((item) => ({ value: item, label: item }));
}

export function getModelPreviewFallbackModel(currentModel: string, providerDefaultModel: string): string | undefined {
  return currentModel.trim() || providerDefaultModel.trim() || undefined;
}

export function resolveModelDraftHydration(
  preserveModelDrafts: boolean,
  hasUnsavedActiveLlmDraft: boolean,
  hasUnsavedProviderDraft: boolean,
): { activeSelection: boolean; providerEditor: boolean } {
  if (!preserveModelDrafts) {
    return { activeSelection: true, providerEditor: true };
  }
  return {
    activeSelection: !hasUnsavedActiveLlmDraft,
    providerEditor: !hasUnsavedActiveLlmDraft && !hasUnsavedProviderDraft,
  };
}

export function resolveProviderModelSelection(
  providerId: string,
  providers: ProviderScopedModelOptionSource[],
  currentModel: string,
): string {
  const provider = providers.find((item) => item.providerId === providerId);
  const options = dedupeProviderModels([provider?.defaultModel, ...(provider?.models ?? [])]);
  const normalizedCurrent = currentModel.trim();
  if (normalizedCurrent && options.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return options[0] ?? "";
}

export function resolveAuthStorageMode(
  authMode: "none" | "token" | "basic",
  rememberCredentials: boolean,
): GatewayAuthStorageMode {
  if (authMode === "none") {
    return "session";
  }
  return rememberCredentials ? "persistent" : "session";
}

export function normalizeRuntimeSettingsResponse(settings: RuntimeSettingsResponse): NormalizedRuntimeSettingsResponse {
  return {
    ...settings,
    web: {
      firecrawl: {
        enabled: settings.web?.firecrawl?.enabled ?? false,
        baseUrl: settings.web?.firecrawl?.baseUrl ?? "http://127.0.0.1:3002",
        apiKeyEnv: settings.web?.firecrawl?.apiKeyEnv ?? "FIRECRAWL_API_KEY",
        timeoutMs: settings.web?.firecrawl?.timeoutMs ?? 20000,
        defaultReadBackend: settings.web?.firecrawl?.defaultReadBackend ?? "native",
        fallbackToNative: settings.web?.firecrawl?.fallbackToNative ?? true,
      },
    },
  };
}
