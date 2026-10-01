import { Save } from "lucide-react";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import { SettingsChangeStatus } from "../use-settings-change";
import {
  SettingsField,
  SettingsFieldGrid,
  SettingsNotice,
  SettingsButtonRow,
  SettingsConfigSourceLegend,
  type SettingsSectionProps,
} from "../SettingsShared";
import type { ProviderCatalog } from "./provider-section-types";
import type { useProviderRouting } from "./use-provider-routing";

export function ProviderRoutingPanel({
  routing,
  providers,
  config,
  route,
  navigate,
  onSelectProvider,
}: Pick<SettingsSectionProps, "route" | "navigate"> & {
  routing: ReturnType<typeof useProviderRouting>;
  providers: ProviderCatalog["providers"];
  config: ProviderCatalog["config"];
  onSelectProvider: (providerId: string) => void;
}) {
  const {
    routingEditor,
    routingChange,
    routingProviderId,
    routingModel,
    setRoutingModel,
    routingProvider,
    routingLlamaNeedsSetup,
    routingUsesFallbackModels,
    routingUsesStaleCatalog,
    routingModelUnavailable,
    routingModelNeedsRefresh,
    handleSaveRouting,
  } = routing;
  return (
    <NativeCard
      id="providers-routing"
      density="compact"
      className="mc-next-settings-panel mc-next-provider-routing-card"
      title="Active routing"
      subtitle="Change the provider/model pair Mission Control uses by default."
    >
      {routing.mutation.uncertain ? <SettingsNotice notice={{ tone: "error", message: routing.mutation.uncertain }} /> : null}
      <SettingsChangeStatus
        change={routingChange.change}
        onRefresh={routingChange.refresh}
        route={route}
        navigate={navigate}
      />
      {routingEditor.hasRemoteChanges ? (
        <>
          <SettingsNotice
            notice={{
              tone: "warning",
              message: `Current default is ${config?.activeProviderId ?? "Unavailable"} / ${config?.activeModel ?? "Unavailable"}. Your staged routing has been kept.`,
            }}
          />
          <NativeButton variant="outline" onClick={routingEditor.rebaseToCurrent}>
            Apply routing draft to current settings
          </NativeButton>
        </>
      ) : null}
      <SettingsFieldGrid>
        <SettingsField label="Provider">
          <select
            className="mc-next-settings-input"
            value={routingProviderId}
            onChange={(event) => {
              const nextProviderId = event.target.value;
              if (nextProviderId === routingProviderId) {
                return;
              }
              onSelectProvider(nextProviderId);
            }}
          >
            <option value="">Choose a provider</option>
            {providers.map((item) => (
              <option key={item.providerId} value={item.providerId}>
                {item.label}
              </option>
            ))}
          </select>
        </SettingsField>
        <SettingsField label="Model">
          <select
            className="mc-next-settings-input"
            value={routingModel}
            onChange={(event) => setRoutingModel(event.target.value)}
            disabled={!routingProviderId}
          >
            <option value="">Choose a model</option>
            {routingModelUnavailable ? (
              <option value={routingModel} disabled>
                {routingModel} · Unavailable
              </option>
            ) : null}
            {routingModelNeedsRefresh ? (
              <option value={routingModel} disabled>
                {routingModel} · Needs refresh
              </option>
            ) : null}
            {routingLlamaNeedsSetup && routingModel && !routingModelNeedsRefresh ? (
              <option value={routingModel} disabled>
                {routingModel} · Endpoint check required
              </option>
            ) : null}
            {(routingLlamaNeedsSetup ? [] : (routingProvider?.models ?? [])).map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </SettingsField>
      </SettingsFieldGrid>
      <SettingsConfigSourceLegend />
      {!config?.activeProviderId || !config.activeModel ? (
        <SettingsNotice
          notice={{
            tone: routingProviderId && routingModel ? "info" : "warning",
            message:
              routingProviderId && routingModel
                ? "No active Chat route is saved yet. Save this provider and model to enable Chat."
                : "No active Chat route is configured. Choose a provider and model, then save routing.",
          }}
        />
      ) : null}
      {routingUsesFallbackModels ? (
        <SettingsNotice
          notice={{
            tone: "warning",
            message:
              "These models are suggested from GoatCitadel's provider template, not verified from your account catalog yet.",
          }}
        />
      ) : null}
      {routingUsesStaleCatalog ? (
        <SettingsNotice
          notice={{
            tone: "warning",
            message:
              "Showing the last known account model list. Refresh this provider to verify availability before changing routing.",
          }}
        />
      ) : null}
      {routingLlamaNeedsSetup ? (
        <SettingsButtonRow>
          <NativeButton
            variant="outline"
            onClick={() => navigate({ area: "settings", section: "onboarding", view: "llamacpp", theme: route.theme })}
          >
            Check llama.cpp endpoint in Get started
          </NativeButton>
        </SettingsButtonRow>
      ) : null}
      {routingModelUnavailable ? (
        <SettingsNotice
          notice={{
            tone: "warning",
            message: `${routingModel} is no longer listed in ${routingProvider?.label ?? "this provider"}'s live model catalog. Choose an available model to continue.`,
          }}
        />
      ) : null}
      {routingModelNeedsRefresh ? (
        <SettingsNotice
          notice={{
            tone: "warning",
            message: `${routingModel} was not in the last known account model list. Refresh the catalog to verify it before saving routing.`,
          }}
        />
      ) : null}
      <SettingsButtonRow>
        <NativeButton
          variant="default"
          disabled={
            routingChange.hasPending ||
            routing.mutation.pending || Boolean(routing.mutation.uncertain) ||
            !routingProviderId.trim() ||
            !routingModel.trim() ||
            routingLlamaNeedsSetup ||
            routingModelUnavailable ||
            routingModelNeedsRefresh
          }
          onClick={() => void handleSaveRouting()}
        >
          <Save size={16} />
          Save routing
        </NativeButton>
      </SettingsButtonRow>
    </NativeCard>
  );
}
