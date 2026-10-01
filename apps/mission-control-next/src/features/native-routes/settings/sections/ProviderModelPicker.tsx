import type {
  ProviderModelCatalogOption,
  UniversalModelPickerOption,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { NativeCard } from "../../NativeRoutePageLayout";
import { SettingsActionList, SettingsField, SettingsNotice } from "../SettingsShared";

export interface ProviderModelPickerProps {
  providers: ProviderModelCatalogOption[];
  universalModelOptions: UniversalModelPickerOption[];
  activeProviderId?: string;
  activeModel?: string;
  modelPickerQuery: string;
  setModelPickerQuery: (query: string) => void;
  onSetupLlamaCpp: () => void;
  onSelect: (selection: { providerId: string; model: string }) => void;
}

/** Stages a caller-owned choice. This view never saves routing. */
export function ProviderModelPicker({
  providers,
  universalModelOptions,
  activeProviderId,
  activeModel,
  modelPickerQuery,
  setModelPickerQuery,
  onSetupLlamaCpp,
  onSelect,
}: ProviderModelPickerProps) {
  return (
    <NativeCard
      id="providers-models"
      density="compact"
      className="mc-next-settings-panel mc-next-provider-model-picker-card"
      title="Universal model picker"
      subtitle="Search configured provider catalogs with runtime fallback and availability evidence."
      stats={[
        { label: "Matches", value: String(universalModelOptions.length) },
        {
          label: "Ready",
          value: String(universalModelOptions.filter((item) => item.availability === "ready").length),
        },
        {
          label: "Blocked",
          value: String(universalModelOptions.filter((item) => item.availability === "blocked").length),
        },
      ]}
    >
      <SettingsField label="Search provider or model">
        <input
          className="mc-next-settings-input"
          value={modelPickerQuery}
          onChange={(event) => setModelPickerQuery(event.target.value)}
          placeholder="gpt, claude, local, fallback, blocked"
        />
      </SettingsField>
      <SettingsActionList
        ariaLabel="Universal model choices"
        items={universalModelOptions.map((item) => {
          const llamaProvider = providers.find((provider) => provider.providerId === item.providerId);
          const llamaNeedsSetup =
            item.providerId === "llamacpp" &&
            (llamaProvider?.modelProbeSource !== "live" ||
              llamaProvider.modelRefreshStatus !== "fresh" ||
              llamaProvider.modelProbeState !== "ready");
          return {
            id: item.id,
            label: item.label,
            description: item.availabilityReason,
            meta: [
              item.availability,
              item.credentialStatus,
              item.contextWindowTokens ? `${item.contextWindowTokens.toLocaleString()} tokens` : undefined,
              item.contextLimitSource,
              item.endpointIdentity,
            ]
              .filter(Boolean)
              .join(" · "),
            actionLabel: llamaNeedsSetup
              ? "Check endpoint"
              : item.availability === "blocked"
                ? "Blocked"
                : item.providerId === activeProviderId && item.model === activeModel
                  ? "Active"
                  : "Select",
            onClick: llamaNeedsSetup
              ? () => onSetupLlamaCpp()
              : item.availability === "blocked"
                ? undefined
                : () => {
                    onSelect({
                      providerId: item.providerId,
                      model: item.model,
                    });
                  },
          };
        })}
        emptyLabel="No provider models match this search."
        maxHeight="min(42vh, 24rem)"
      />
      <SettingsNotice
        notice={{
          tone: "info",
          message:
            "Selecting here stages the provider/model in Active routing; Save routing is still required before runtime changes.",
        }}
      />
    </NativeCard>
  );
}
