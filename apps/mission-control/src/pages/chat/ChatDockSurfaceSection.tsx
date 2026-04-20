import type {
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatThinkingLevel,
  ChatWebMode,
} from "@goatcitadel/contracts";
import { useState } from "react";
import { ChatPlanningPill } from "../../components/chat/ChatPlanningPill";
import { ChatModelPicker } from "../../components/ChatModelPicker";
import { DataToolbar } from "../../components/DataToolbar";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { GCSelect, GCSwitch } from "../../components/ui";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

function toThinkingLevel(value: string): ChatThinkingLevel {
  return value as ChatThinkingLevel;
}

function toWebMode(value: string): ChatWebMode {
  return value as ChatWebMode;
}

function toProactiveMode(value: string): ChatProactiveMode {
  return value as ChatProactiveMode;
}

function toRetrievalMode(value: string): ChatRetrievalMode {
  return value as ChatRetrievalMode;
}

function toReflectionMode(value: string): ChatReflectionMode {
  return value as ChatReflectionMode;
}

function describeProviderRuntime(provider: ChatContextDockPanelsProps["providerOptions"][number] | undefined): string {
  if (!provider) {
    return "Runtime not checked";
  }
  if (provider.disabled) {
    return "Provider setup required";
  }
  switch (provider.modelProbeState) {
    case "ready":
      return provider.isLocalRuntime ? "Runtime reachable" : "Provider reachable";
    case "empty":
      return provider.isLocalRuntime ? "Runtime degraded" : "Models unavailable";
    case "error":
      return provider.isLocalRuntime ? "Runtime unreachable" : "Provider unreachable";
    default:
      return "Runtime not checked";
  }
}

export function ChatDockSurfaceSection(
  props: Pick<
    ChatContextDockPanelsProps,
    | "isChatSurface"
    | "isCoworkSurface"
    | "isCodeSurface"
    | "activeModePreset"
    | "planningMode"
    | "effectiveToolAutonomy"
    | "codeModeNeedsProjectBinding"
    | "selectedProjectBindingCandidateId"
    | "selectedProjectBindingCandidateName"
    | "sending"
    | "sessionControlPending"
    | "providerOptions"
    | "selectedProviderId"
    | "selectedModel"
    | "streamEnabled"
    | "onStreamEnabledChange"
    | "prefs"
    | "selectedSessionId"
    | "proactiveStatus"
    | "loadModelsForProvider"
    | "getCachedModels"
    | "resolveProviderModelSelection"
    | "onPrefPatch"
    | "onSuggestDelegation"
    | "onTriggerProactive"
    | "onProactivePolicyPatch"
    | "onRunCodeDelegation"
    | "onAssignProject"
  >,
) {
  const {
    isChatSurface,
    isCoworkSurface,
    isCodeSurface,
    activeModePreset,
    planningMode,
    effectiveToolAutonomy,
    codeModeNeedsProjectBinding,
    selectedProjectBindingCandidateId,
    selectedProjectBindingCandidateName,
    sending,
    sessionControlPending,
    providerOptions,
    selectedProviderId,
    selectedModel,
    streamEnabled,
    onStreamEnabledChange,
    prefs,
    selectedSessionId,
    proactiveStatus,
    loadModelsForProvider,
    getCachedModels,
    resolveProviderModelSelection,
    onPrefPatch,
    onSuggestDelegation,
    onTriggerProactive,
    onProactivePolicyPatch,
    onRunCodeDelegation,
    onAssignProject,
  } = props;
  const [coworkSettingsExpanded, setCoworkSettingsExpanded] = useState(false);
  const selectedProvider = providerOptions.find((item) => item.providerId === selectedProviderId);
  const coworkRouteSummary = `${selectedProvider?.label ?? "Provider auto"} / ${selectedModel ?? "Model auto"}`;
  const coworkRuntimeSummary = describeProviderRuntime(selectedProvider);

  return (
    <Panel
      className="chat-v11-topbar-panel chat-v11-panel-surface"
      padding="compact"
      title={isCodeSurface ? "Execution controls" : isCoworkSurface ? "Session controls" : "Surface controls"}
      subtitle={
        isCodeSurface
          ? "Project binding, model, and review settings for this session."
          : isCoworkSurface
            ? "Model, delegation, and proactive policy for this workflow."
            : activeModePreset.summary
      }
    >
      <ChatPlanningPill planningMode={planningMode} effectiveToolAutonomy={effectiveToolAutonomy} />
      <div className="chat-v11-surface-identity">
        <div className="chat-v11-surface-chip-row">
          <StatusChip tone={isChatSurface ? "live" : isCoworkSurface ? "warning" : "critical"}>
            {activeModePreset.teamBehaviorLabel}
          </StatusChip>
          <StatusChip tone={activeModePreset.allowsDynamicTeamGrowth ? "warning" : "muted"}>
            {activeModePreset.growthPolicyLabel}
          </StatusChip>
        </div>
        {!isCoworkSurface ? (
          <>
            <p className="chat-v11-surface-copy">{activeModePreset.teamBehaviorSummary}</p>
            <p className="chat-v11-surface-copy secondary">{activeModePreset.growthPolicySummary}</p>
          </>
        ) : null}
      </div>
      {codeModeNeedsProjectBinding ? (
        <div className="status-banner warning">
          Code mode is unbound. Assign a project in Session management before execution-heavy work. Until then
          GoatCitadel stays in manual execution mode.
          {selectedProjectBindingCandidateId ? (
            <>
              {" "}
              <button
                type="button"
                disabled={sending || Boolean(sessionControlPending)}
                onClick={() => void onAssignProject(selectedProjectBindingCandidateId)}
                className="gc-button"
              >
                Bind {selectedProjectBindingCandidateName ?? "selected project"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {isCodeSurface ? (
        <div className="chat-v11-settings-grid">
          <div className="chat-v11-setting-row chat-v11-setting-row-stack chat-v11-setting-row-wide">
            <div className="chat-v11-setting-copy">
              <span className="chat-v11-setting-label">Model</span>
              <span className="chat-v11-setting-hint">Provider and model used for this code session.</span>
            </div>
            <div className="chat-v11-setting-control">
              <ChatModelPicker
                providers={providerOptions}
                providerId={selectedProviderId}
                model={selectedModel}
                disabled={!selectedSessionId || sending}
                onChangeProvider={(providerId) => {
                  const provider = providerOptions.find((item) => item.providerId === providerId);
                  const selection = resolveProviderModelSelection({
                    provider,
                    loadedModels: providerId ? getCachedModels(providerId) : [],
                    selectedModel: undefined,
                  });
                  void loadModelsForProvider(providerId);
                  void onPrefPatch({ providerId, model: selection.model ?? "" });
                }}
                onChangeModel={(model) => void onPrefPatch({ model })}
              />
            </div>
          </div>
          <div className="chat-v11-setting-row">
            <span className="chat-v11-setting-label">Thinking</span>
            <div className="chat-v11-setting-control">
              <GCSelect
                value={prefs?.thinkingLevel ?? "standard"}
                disabled={!selectedSessionId || sending}
                onChange={(value) => void onPrefPatch({ thinkingLevel: toThinkingLevel(value) })}
                options={[
                  { value: "minimal", label: "Minimal" },
                  { value: "standard", label: "Standard" },
                  { value: "extended", label: "Extended" },
                ]}
              />
            </div>
          </div>
          <div className="chat-v11-setting-row">
            <span className="chat-v11-setting-label">Web</span>
            <div className="chat-v11-setting-control">
              <GCSelect
                value={prefs?.webMode ?? "auto"}
                disabled={!selectedSessionId || sending}
                onChange={(value) => void onPrefPatch({ webMode: toWebMode(value) })}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "off", label: "Off" },
                  { value: "quick", label: "Quick" },
                  { value: "deep", label: "Deep" },
                ]}
              />
            </div>
          </div>
          <div className="chat-v11-setting-row">
            <span className="chat-v11-setting-label">Stream</span>
            <div className="chat-v11-setting-control">
              <GCSwitch checked={streamEnabled} onCheckedChange={onStreamEnabledChange} />
            </div>
          </div>
          <div className="chat-v11-setting-row">
            <span className="chat-v11-setting-label">Orchestration</span>
            <div className="chat-v11-setting-control">
              <GCSwitch
                checked={prefs?.orchestrationEnabled ?? true}
                disabled={!selectedSessionId || sending}
                onCheckedChange={(checked) => void onPrefPatch({ orchestrationEnabled: checked })}
              />
            </div>
          </div>
          <div className="chat-v11-row-actions">
            <button
              type="button"
              disabled={sending}
              onClick={() => void onRunCodeDelegation("implement")}
              className="gc-button"
            >
              Implement
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void onRunCodeDelegation("review")}
              className="gc-button"
            >
              Review
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void onRunCodeDelegation("test")}
              className="gc-button"
            >
              Test
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void onRunCodeDelegation("ship")}
              className="gc-button"
            >
              Ship cycle
            </button>
          </div>
        </div>
      ) : isCoworkSurface ? (
        <>
          <div className="chat-v11-cowork-settings-summary">
            <div className="chat-v11-cowork-settings-copy">
              <span className="chat-v11-setting-label">Route</span>
              <strong>{coworkRouteSummary}</strong>
            </div>
            <div className="chat-v11-cowork-settings-copy">
              <span className="chat-v11-setting-label">Runtime</span>
              <strong>{coworkRuntimeSummary}</strong>
            </div>
            <div className="chat-v11-row-actions">
              <button type="button" className="gc-button" onClick={() => setCoworkSettingsExpanded((value) => !value)}>
                {coworkSettingsExpanded ? "Hide run settings" : "Adjust run settings"}
              </button>
            </div>
          </div>
          {coworkSettingsExpanded ? (
            <div className="chat-v11-settings-grid">
              <div className="chat-v11-setting-row chat-v11-setting-row-stack chat-v11-setting-row-wide">
                <div className="chat-v11-setting-copy">
                  <span className="chat-v11-setting-label">Model</span>
                </div>
                <div className="chat-v11-setting-control">
                  <ChatModelPicker
                    providers={providerOptions}
                    providerId={selectedProviderId}
                    model={selectedModel}
                    disabled={!selectedSessionId || sending}
                    onChangeProvider={(providerId) => {
                      const provider = providerOptions.find((item) => item.providerId === providerId);
                      const selection = resolveProviderModelSelection({
                        provider,
                        loadedModels: providerId ? getCachedModels(providerId) : [],
                        selectedModel: undefined,
                      });
                      void loadModelsForProvider(providerId);
                      void onPrefPatch({ providerId, model: selection.model ?? "" });
                    }}
                    onChangeModel={(model) => void onPrefPatch({ model })}
                  />
                </div>
              </div>
              <div className="chat-v11-setting-row">
                <span className="chat-v11-setting-label">Thinking</span>
                <div className="chat-v11-setting-control">
                  <GCSelect
                    value={prefs?.thinkingLevel ?? "standard"}
                    disabled={!selectedSessionId || sending}
                    onChange={(value) => void onPrefPatch({ thinkingLevel: toThinkingLevel(value) })}
                    options={[
                      { value: "minimal", label: "Minimal" },
                      { value: "standard", label: "Standard" },
                      { value: "extended", label: "Extended" },
                    ]}
                  />
                </div>
              </div>
              <div className="chat-v11-setting-row">
                <span className="chat-v11-setting-label">Web</span>
                <div className="chat-v11-setting-control">
                  <GCSelect
                    value={prefs?.webMode ?? "auto"}
                    disabled={!selectedSessionId || sending}
                    onChange={(value) => void onPrefPatch({ webMode: toWebMode(value) })}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "off", label: "Off" },
                      { value: "quick", label: "Quick" },
                      { value: "deep", label: "Deep" },
                    ]}
                  />
                </div>
              </div>
              <div className="chat-v11-setting-row">
                <span className="chat-v11-setting-label">Proactive</span>
                <div className="chat-v11-setting-control">
                  <GCSelect
                    value={proactiveStatus?.mode ?? prefs?.proactiveMode ?? "off"}
                    disabled={!selectedSessionId || sending}
                    onChange={(value) => void onProactivePolicyPatch({ proactiveMode: toProactiveMode(value) })}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "suggest", label: "Suggest" },
                      { value: "auto_safe", label: "Auto-safe" },
                      { value: "auto_full", label: "Auto-full" },
                    ]}
                  />
                </div>
              </div>
              <div className="chat-v11-setting-row">
                <span className="chat-v11-setting-label">Retrieval</span>
                <div className="chat-v11-setting-control">
                  <GCSelect
                    value={proactiveStatus?.retrievalMode ?? prefs?.retrievalMode ?? "standard"}
                    disabled={!selectedSessionId || sending}
                    onChange={(value) => void onProactivePolicyPatch({ retrievalMode: toRetrievalMode(value) })}
                    options={[
                      { value: "standard", label: "Standard" },
                      { value: "layered", label: "Layered" },
                    ]}
                  />
                </div>
              </div>
              <div className="chat-v11-setting-row">
                <span className="chat-v11-setting-label">Reflection</span>
                <div className="chat-v11-setting-control">
                  <GCSelect
                    value={proactiveStatus?.reflectionMode ?? prefs?.reflectionMode ?? "off"}
                    disabled={!selectedSessionId || sending}
                    onChange={(value) => void onProactivePolicyPatch({ reflectionMode: toReflectionMode(value) })}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "on", label: "On" },
                    ]}
                  />
                </div>
              </div>
              <div className="chat-v11-row-actions">
                <button
                  type="button"
                  disabled={!selectedSessionId || sending}
                  onClick={() => void onSuggestDelegation()}
                  className="gc-button"
                >
                  Suggest delegation
                </button>
                <button
                  type="button"
                  disabled={!selectedSessionId || sending}
                  onClick={() => void onTriggerProactive()}
                  className="gc-button"
                >
                  Run proactive
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <DataToolbar
          primary={
            <>
              <ChatModelPicker
                providers={providerOptions}
                providerId={selectedProviderId}
                model={selectedModel}
                disabled={!selectedSessionId || sending}
                onChangeProvider={(providerId) => {
                  const provider = providerOptions.find((item) => item.providerId === providerId);
                  const selection = resolveProviderModelSelection({
                    provider,
                    loadedModels: providerId ? getCachedModels(providerId) : [],
                    selectedModel: undefined,
                  });
                  void loadModelsForProvider(providerId);
                  void onPrefPatch({ providerId, model: selection.model ?? "" });
                }}
                onChangeModel={(model) => void onPrefPatch({ model })}
              />
              <label className="chat-v11-select">
                Thinking
                <GCSelect
                  value={prefs?.thinkingLevel ?? "standard"}
                  disabled={!selectedSessionId || sending}
                  onChange={(value) => void onPrefPatch({ thinkingLevel: toThinkingLevel(value) })}
                  options={[
                    { value: "minimal", label: "Minimal" },
                    { value: "standard", label: "Standard" },
                    { value: "extended", label: "Extended" },
                  ]}
                />
              </label>
              <label className="chat-v11-select">
                Web
                <GCSelect
                  value={prefs?.webMode ?? "auto"}
                  disabled={!selectedSessionId || sending}
                  onChange={(value) => void onPrefPatch({ webMode: toWebMode(value) })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "off", label: "Off" },
                    { value: "quick", label: "Quick" },
                    { value: "deep", label: "Deep" },
                  ]}
                />
              </label>
            </>
          }
          secondary={
            <>
              {!isChatSurface ? (
                <>
                  <label className="chat-v11-select">
                    Proactive
                    <GCSelect
                      value={proactiveStatus?.mode ?? prefs?.proactiveMode ?? "off"}
                      disabled={!selectedSessionId || sending}
                      onChange={(value) => void onProactivePolicyPatch({ proactiveMode: toProactiveMode(value) })}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "suggest", label: "Suggest" },
                        { value: "auto_safe", label: "Auto-safe" },
                        { value: "auto_full", label: "Auto-full" },
                      ]}
                    />
                  </label>
                  <label className="chat-v11-select">
                    Retrieval
                    <GCSelect
                      value={proactiveStatus?.retrievalMode ?? prefs?.retrievalMode ?? "standard"}
                      disabled={!selectedSessionId || sending}
                      onChange={(value) => void onProactivePolicyPatch({ retrievalMode: toRetrievalMode(value) })}
                      options={[
                        { value: "standard", label: "Standard" },
                        { value: "layered", label: "Layered" },
                      ]}
                    />
                  </label>
                  <label className="chat-v11-select">
                    Reflection
                    <GCSelect
                      value={proactiveStatus?.reflectionMode ?? prefs?.reflectionMode ?? "off"}
                      disabled={!selectedSessionId || sending}
                      onChange={(value) => void onProactivePolicyPatch({ reflectionMode: toReflectionMode(value) })}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "on", label: "On" },
                      ]}
                    />
                  </label>
                  {isCoworkSurface ? (
                    <button
                      type="button"
                      disabled={!selectedSessionId || sending}
                      onClick={() => void onSuggestDelegation()}
                      className="gc-button"
                    >
                      Suggest delegation
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={!selectedSessionId || sending}
                    onClick={() => void onTriggerProactive()}
                    className="gc-button"
                  >
                    Run proactive
                  </button>
                </>
              ) : null}
            </>
          }
        />
      )}
    </Panel>
  );
}
