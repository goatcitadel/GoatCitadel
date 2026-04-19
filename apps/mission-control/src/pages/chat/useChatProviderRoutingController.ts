import type { ChatSessionPrefsRecord, McpServerRecord, McpServerTemplateRecord, SkillListItem } from "@goatcitadel/contracts";
import { useEffect, useMemo, useState } from "react";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import type { RuntimeSettingsResponse } from "../../api/client";
import { buildModelCommandSuggestions, type CommandSuggestionItem } from "../chat-command-suggestions";
import { dedupeStrings } from "./chat-page-derivations";
import { isLikelyLocalProviderUrl, resolveProviderModelSelection } from "./chat-page-helpers";
import type { CommandCatalogItem } from "./useChatSessionData";

export function useChatProviderRoutingController(input: {
  runtimeLlmConfig: RuntimeSettingsResponse["llm"] | null;
  runtimeProviderCatalog: Array<{
    providerId: string;
    label: string;
    defaultModel?: string;
    hasApiKey?: boolean;
    baseUrl?: string;
    models: string[];
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
    return input.runtimeProviderCatalog.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      defaultModel: provider.defaultModel,
      disabled: !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl),
      availabilityLabel:
        !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
          ? `${provider.label} · setup required`
          : undefined,
      availabilityHint:
        !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
          ? `${provider.label} is not configured yet. Add an API key before using it.`
          : undefined,
      models: dedupeStrings([
        ...provider.models,
        provider.providerId === activeProviderId ? activeModel : undefined,
        input.prefs?.providerId === provider.providerId ? input.prefs.model : undefined,
      ]),
    }));
  }, [
    input.prefs?.model,
    input.prefs?.providerId,
    input.runtimeLlmConfig?.activeModel,
    input.runtimeLlmConfig?.activeProviderId,
    input.runtimeProviderCatalog,
    input.settings?.llm?.activeModel,
    input.settings?.llm?.activeProviderId,
  ]);

  const selectedProviderId = useMemo(() => {
    const preferredProviderId =
      input.prefs?.providerId ?? input.runtimeLlmConfig?.activeProviderId ?? input.settings?.llm?.activeProviderId;
    return providerOptions.find((provider) => provider.providerId === preferredProviderId)?.providerId;
  }, [input.prefs?.providerId, input.runtimeLlmConfig?.activeProviderId, input.settings?.llm?.activeProviderId, providerOptions]);

  const selectedProviderSelection = useMemo(() => {
    const provider = providerOptions.find((item) => item.providerId === selectedProviderId);
    return resolveProviderModelSelection({
      provider,
      loadedModels: selectedProviderId ? input.getCachedModels(selectedProviderId) : [],
      selectedModel: input.prefs?.model ?? input.runtimeLlmConfig?.activeModel ?? input.settings?.llm?.activeModel,
    });
  }, [
    input.getCachedModels,
    input.prefs?.model,
    input.runtimeLlmConfig?.activeModel,
    input.settings?.llm?.activeModel,
    providerOptions,
    selectedProviderId,
  ]);
  const selectedModel = selectedProviderSelection.model;
  const selectedProviderLabel = useMemo(
    () => providerOptions.find((item) => item.providerId === selectedProviderId)?.label ?? "Provider auto",
    [providerOptions, selectedProviderId],
  );
  const selectedModelLabel = selectedModel ?? "Model auto";

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
    selectedModel,
    selectedProviderLabel,
    selectedModelLabel,
  };
}
