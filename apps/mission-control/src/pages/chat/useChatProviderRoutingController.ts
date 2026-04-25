import type {
  ChatSessionPrefsRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import { useEffect, useMemo, useState } from "react";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import type { RuntimeSettingsResponse } from "../../api/client";
import { buildModelCommandSuggestions, type CommandSuggestionItem } from "../chat-command-suggestions";
import { dedupeStrings } from "./chat-page-derivations";
import { isLikelyLocalProviderUrl, resolveProviderModelSelection } from "./chat-page-helpers";
import type { WorkTrustTone } from "./work-trust";
import type { CommandCatalogItem } from "./useChatSessionData";

type RoutingSelectionSource = "manual" | "session" | "global";
type RuntimeHealthState = "not_checked" | "reachable" | "unreachable" | "degraded";

function describeSelectionSource(input: {
  prefsProviderId?: string | null;
  prefsModel?: string | null;
  runtimeProviderId?: string | null;
  runtimeModel?: string | null;
  settingsProviderId?: string | null;
  settingsModel?: string | null;
}): RoutingSelectionSource {
  if (input.prefsProviderId || input.prefsModel) {
    return "session";
  }
  if (input.runtimeProviderId || input.runtimeModel || input.settingsProviderId || input.settingsModel) {
    return "global";
  }
  return "manual";
}

function formatSelectionSourceLabel(source: RoutingSelectionSource): string {
  switch (source) {
    case "session":
      return "Selection: session";
    case "global":
      return "Selection: global";
    default:
      return "Selection: manual";
  }
}

function describeRuntimeStatus(provider: ChatModelProviderOption | undefined): {
  status: RuntimeHealthState;
  summary: string;
  tone: WorkTrustTone;
} {
  if (!provider) {
    return {
      status: "not_checked",
      summary: "Runtime not checked",
      tone: "muted",
    };
  }
  if (provider.disabled) {
    return {
      status: "degraded",
      summary: "Provider setup required",
      tone: "critical",
    };
  }
  switch (provider.modelProbeState) {
    case "ready":
      return {
        status: "reachable",
        summary: provider.isLocalRuntime ? "Runtime reachable" : "Provider reachable",
        tone: "success",
      };
    case "fallback":
      return {
        status: "degraded",
        summary: "Model list suggested, not account-verified",
        tone: "warning",
      };
    case "empty":
      return {
        status: "degraded",
        summary: provider.isLocalRuntime ? "Runtime degraded" : "Models unavailable",
        tone: "warning",
      };
    case "error":
      return {
        status: "unreachable",
        summary: provider.isLocalRuntime ? "Runtime unreachable" : "Provider unreachable",
        tone: "critical",
      };
    default:
      return {
        status: "not_checked",
        summary: "Runtime not checked",
        tone: "muted",
      };
  }
}

export function useChatProviderRoutingController(input: {
  runtimeLlmConfig: RuntimeSettingsResponse["llm"] | null;
  runtimeProviderCatalog: Array<{
    providerId: string;
    label: string;
    defaultModel?: string;
    hasApiKey?: boolean;
    baseUrl?: string;
    capabilities?: {
      voiceInput?: boolean;
      voiceOutput?: boolean;
      imageGenerate?: boolean;
      imageEdit?: boolean;
    };
    models: string[];
    modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
    modelProbeSource?: "remote" | "fallback";
    modelProbeCheckedAt?: string;
  }>;
  getCachedModels: (providerId: string) => string[];
  loadModelsForProvider: (providerId: string) => Promise<string[]>;
  prefs: ChatSessionPrefsRecord | null;
  settings: RuntimeSettingsResponse | null;
  draft: string;
  commandCatalog: CommandCatalogItem[];
  installedSkills: SkillListItem[];
  mcpServers: McpServerRecord[];
  mcpTemplates: Array<McpServerTemplateRecord & { installed: boolean }>;
}) {
  const [commandIndex, setCommandIndex] = useState(0);

  const providerOptions = useMemo<ChatModelProviderOption[]>(() => {
    const settingsLlm = input.settings?.llm;
    const activeProviderId = input.runtimeLlmConfig?.activeProviderId ?? settingsLlm?.activeProviderId;
    const activeModel = input.runtimeLlmConfig?.activeModel ?? settingsLlm?.activeModel;
    return input.runtimeProviderCatalog.map((provider) => {
      const isLocalRuntime = isLikelyLocalProviderUrl(provider.baseUrl);
      return {
        providerId: provider.providerId,
        label: provider.label,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        isLocalRuntime,
        disabled: !provider.hasApiKey && !isLocalRuntime,
        availabilityLabel: !provider.hasApiKey && !isLocalRuntime ? `${provider.label} · setup required` : undefined,
        availabilityHint:
          !provider.hasApiKey && !isLocalRuntime
            ? `${provider.label} is not configured yet. Add an API key before using it.`
            : undefined,
        capabilities: provider.capabilities,
        models: dedupeStrings([
          ...provider.models,
          provider.providerId === activeProviderId ? activeModel : undefined,
          input.prefs?.providerId === provider.providerId ? input.prefs.model : undefined,
        ]),
        modelProbeState: provider.modelProbeState,
        modelProbeSource: provider.modelProbeSource,
        modelProbeCheckedAt: provider.modelProbeCheckedAt,
      };
    });
  }, [
    input.prefs?.model,
    input.prefs?.providerId,
    input.runtimeLlmConfig?.activeModel,
    input.runtimeLlmConfig?.activeProviderId,
    input.runtimeProviderCatalog,
    input.settings?.llm?.activeModel,
    input.settings?.llm?.activeProviderId,
  ]);

  const requestedProviderId =
    input.prefs?.providerId ?? input.runtimeLlmConfig?.activeProviderId ?? input.settings?.llm?.activeProviderId;
  const requestedModelId =
    input.prefs?.model ?? input.runtimeLlmConfig?.activeModel ?? input.settings?.llm?.activeModel;

  const selectedProviderId = useMemo(
    () => providerOptions.find((provider) => provider.providerId === requestedProviderId)?.providerId,
    [providerOptions, requestedProviderId],
  );
  const selectedProviderOption = useMemo(
    () => providerOptions.find((item) => item.providerId === selectedProviderId),
    [providerOptions, selectedProviderId],
  );

  const selectedProviderSelection = useMemo(() => {
    return resolveProviderModelSelection({
      provider: selectedProviderOption,
      loadedModels: selectedProviderId ? input.getCachedModels(selectedProviderId) : [],
      selectedModel: requestedModelId,
    });
  }, [input.getCachedModels, requestedModelId, selectedProviderId, selectedProviderOption]);

  const selectedModel = selectedProviderSelection.model;
  const selectedProviderLabel = selectedProviderOption?.label ?? "Provider auto";
  const selectedModelLabel = selectedModel ?? "Model auto";
  const requestedProviderLabel = selectedProviderOption?.label ?? "Provider auto";
  const requestedModelLabel = requestedModelId ?? "Model auto";
  const selectionSource = describeSelectionSource({
    prefsProviderId: input.prefs?.providerId,
    prefsModel: input.prefs?.model,
    runtimeProviderId: input.runtimeLlmConfig?.activeProviderId,
    runtimeModel: input.runtimeLlmConfig?.activeModel,
    settingsProviderId: input.settings?.llm?.activeProviderId,
    settingsModel: input.settings?.llm?.activeModel,
  });
  const selectionSourceLabel = formatSelectionSourceLabel(selectionSource);
  const runtimeDescriptor = useMemo(() => describeRuntimeStatus(selectedProviderOption), [selectedProviderOption]);
  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void input.loadModelsForProvider(selectedProviderId);
  }, [input.loadModelsForProvider, selectedProviderId]);

  const commandSuggestions = useMemo(() => {
    const trimmed = input.draft.trimStart();
    if (!trimmed.startsWith("/")) {
      return [] as CommandSuggestionItem[];
    }
    const normalized = trimmed.toLowerCase();
    if (/^\/plan(\s+\w*)?$/.test(normalized)) {
      return [
        {
          key: "plan-on",
          command: "/plan on",
          description: "Switch this session into advisory planning mode.",
          applyValue: "/plan on",
        },
        {
          key: "plan-off",
          command: "/plan off",
          description: "Return this session to normal execution mode.",
          applyValue: "/plan off",
        },
      ];
    }
    const modelSuggestions = buildModelCommandSuggestions({
      draft: input.draft,
      providers: providerOptions,
      activeProviderId: selectedProviderId,
    });
    if (modelSuggestions.length > 0) {
      return modelSuggestions;
    }
    const skillStateMatch = normalized.match(/^\/skill\s+(enable|disable|sleep)\s+(.+)?$/);
    if (skillStateMatch) {
      const query = (skillStateMatch[2] ?? "").trim();
      return input.installedSkills
        .filter((skill) => !query || skill.skillId.toLowerCase().includes(query))
        .slice(0, 8)
        .map((skill) => ({
          key: `${skillStateMatch[1]}-${skill.skillId}`,
          command: `/skill ${skillStateMatch[1]} ${skill.skillId}`,
          description: `${skill.state} · ${skill.name}`,
          applyValue: `/skill ${skillStateMatch[1]} ${skill.skillId}`,
        }));
    }
    const mcpServerMatch = normalized.match(/^\/mcp\s+(connect|disconnect)\s+(.+)?$/);
    if (mcpServerMatch) {
      const query = (mcpServerMatch[2] ?? "").trim();
      return input.mcpServers
        .filter((server) => !query || `${server.serverId} ${server.label}`.toLowerCase().includes(query))
        .slice(0, 8)
        .map((server) => ({
          key: `${mcpServerMatch[1]}-${server.serverId}`,
          command: `/mcp ${mcpServerMatch[1]} ${server.serverId}`,
          description: `${server.label} · ${server.status}`,
          applyValue: `/mcp ${mcpServerMatch[1]} ${server.serverId}`,
        }));
    }
    const mcpTemplateMatch = normalized.match(/^\/mcp\s+add-template\s+(.+)?$/);
    if (mcpTemplateMatch) {
      const query = (mcpTemplateMatch[1] ?? "").trim();
      return input.mcpTemplates
        .filter((template) => !query || `${template.templateId} ${template.label}`.toLowerCase().includes(query))
        .slice(0, 8)
        .map((template) => ({
          key: `template-${template.templateId}`,
          command: `/mcp add-template ${template.templateId}`,
          description: `${template.label}${template.installed ? " · installed" : ""}`,
          applyValue: `/mcp add-template ${template.templateId}`,
        }));
    }
    const query = trimmed.slice(1).toLowerCase();
    if (!query) {
      return input.commandCatalog.slice(0, 8).map((item) => ({
        key: item.usage,
        command: item.command,
        description: item.description,
        applyValue: item.command,
      }));
    }
    return input.commandCatalog
      .filter((item) => `${item.command} ${item.usage} ${item.description}`.toLowerCase().includes(query))
      .map((item) => ({
        key: item.usage,
        command: item.command,
        description: item.description,
        applyValue: item.command,
      }))
      .slice(0, 8);
  }, [
    input.commandCatalog,
    input.draft,
    input.installedSkills,
    input.mcpServers,
    input.mcpTemplates,
    providerOptions,
    selectedProviderId,
  ]);

  useEffect(() => {
    setCommandIndex(0);
  }, [input.draft]);

  return {
    commandIndex,
    setCommandIndex,
    commandSuggestions,
    providerOptions,
    selectedProviderId,
    selectedProviderOption,
    selectedModel,
    selectedProviderLabel,
    selectedModelLabel,
    requestedProviderLabel,
    requestedModelLabel,
    selectionSource,
    selectionSourceLabel,
    runtimeStatus: runtimeDescriptor.status,
    runtimeSummary: runtimeDescriptor.summary,
    runtimeTone: runtimeDescriptor.tone,
  };
}
