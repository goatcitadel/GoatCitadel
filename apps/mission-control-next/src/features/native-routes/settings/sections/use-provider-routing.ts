import { useRef } from "react";
import { fetchLlmConfig, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import {
  isModelMissingFromStaleCatalog,
  isModelUnavailableInFreshCatalog,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useSessionDraft } from "../../library/session-drafts";
import { useSettingsChange } from "../use-settings-change";
import { getErrorMessage } from "../SettingsShared";
import type { ProviderCatalog, ProviderNoticeSetter } from "./provider-section-types";
import {
  beginProviderMutation,
  dispatchProviderMutation,
  finishProviderMutation,
  isProviderPrecommitConflict,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";

export function useProviderRouting({
  config,
  providers,
  reload,
  active,
  setNotice,
}: Pick<ProviderCatalog, "config" | "providers" | "reload"> & {
  active: boolean;
  setNotice: ProviderNoticeSetter;
}) {
  const savesInFlight = useRef(new Set<string>());
  const routingEditor = useSessionDraft(
    "provider-routing:system",
    { providerId: config?.activeProviderId ?? "", model: config?.activeModel ?? "" },
    config?.revision,
    {
      label: "Default routing",
      active: active,
      available: Boolean(config),
      onSave: (): Promise<boolean> => handleSaveRouting(),
    },
  );
  const routingProviderId = routingEditor.value.providerId;
  const mutation = useProviderMutationState();
  const captureEditor = useProviderEditorEpoch({
    active,
    value: routingEditor.value,
    revision: routingEditor.baseRevision,
  });
  const captureView = useProviderEditorEpoch({ active });
  const routingModel = routingEditor.value.model;
  const setRoutingProviderId = (providerId: string) => routingEditor.setValue((value) => ({ ...value, providerId }));
  const setRoutingModel = (model: string) => routingEditor.setValue((value) => ({ ...value, model }));
  const routingChange = useSettingsChange({
    key: routingEditor.key,
    matchesPlan: (plan, submitted: typeof routingEditor.value) =>
      plan.request.kind === "installation_default_model" &&
      plan.target.ownerId === "runtime_settings" &&
      plan.target.resourceId === "llm_defaults" &&
      plan.request.providerId === submitted.providerId &&
      plan.request.model === submitted.model,
    matches: (settings, submitted) =>
      settings.llm.activeProviderId === submitted.providerId && settings.llm.activeModel === submitted.model,
    acceptSaved: routingEditor.acceptSaved,
    reload,
  });
  const routingProvider = providers.find((item) => item.providerId === routingProviderId) ?? null;
  const routingLlamaNeedsSetup =
    routingProviderId === "llamacpp" &&
    (routingProvider?.modelProbeSource !== "live" ||
      routingProvider.modelRefreshStatus !== "fresh" ||
      routingProvider.modelProbeState !== "ready");
  const routingUsesFallbackModels =
    routingProvider?.modelProbeState === "fallback" && routingProvider.modelProbeSource !== "live";
  const routingUsesStaleCatalog =
    routingProvider?.modelProbeSource === "live" && routingProvider.modelRefreshStatus === "stale";
  const routingModelUnavailable = isModelUnavailableInFreshCatalog(routingProvider, routingModel);
  const routingModelNeedsRefresh = isModelMissingFromStaleCatalog(routingProvider, routingModel);
  const persistRouting = async (providerId: string, model: string) => {
    if (mutation.pending || mutation.uncertain || routingEditor.hasRemoteChanges) return false;
    if (routingChange.isPending()) {
      await routingChange.refresh();
      return false;
    }
    if (savesInFlight.current.has(routingEditor.key)) return false;
    const normalizedProviderId = providerId.trim();
    const normalizedModel = model.trim();
    if (!normalizedProviderId || !normalizedModel) {
      setNotice({ tone: "warning", message: "Choose both a provider and a model before saving routing." });
      return false;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving routing." });
      return false;
    }
    const nextProvider = providers.find((provider) => provider.providerId === normalizedProviderId);
    if (
      normalizedProviderId === "llamacpp" &&
      (nextProvider?.modelProbeSource !== "live" ||
        nextProvider.modelRefreshStatus !== "fresh" ||
        nextProvider.modelProbeState !== "ready" ||
        !nextProvider.models.includes(normalizedModel))
    ) {
      setNotice({
        tone: "warning",
        message: "Check the llama.cpp endpoint and choose a freshly discovered model in Get started.",
      });
      return false;
    }
    if (isModelUnavailableInFreshCatalog(nextProvider ?? null, normalizedModel)) {
      setNotice({
        tone: "warning",
        message: `${normalizedModel} is no longer listed for ${nextProvider?.label ?? "this provider"}. Choose an available model before saving routing.`,
      });
      return false;
    }
    if (isModelMissingFromStaleCatalog(nextProvider ?? null, normalizedModel)) {
      setNotice({
        tone: "warning",
        message: `${normalizedModel} was not in the last known model list for ${nextProvider?.label ?? "this provider"}. Refresh the catalog before saving routing.`,
      });
      return false;
    }
    const usesFallbackModels = nextProvider?.modelProbeState === "fallback" && nextProvider.modelProbeSource !== "live";
    const usesStaleCatalog = nextProvider?.modelProbeSource === "live" && nextProvider.modelRefreshStatus === "stale";
    if (!routingChange.beginSave()) return false;
    if (!beginProviderMutation()) {
      routingChange.endSave();
      return false;
    }
    const isCurrent = captureEditor();
    const viewCurrent = captureView();
    const revision = Number(routingEditor.baseRevision ?? config.revision);
    savesInFlight.current.add(routingEditor.key);
    let attempted = false;
    let acknowledged = false;
    try {
      const latest = await fetchLlmConfig();
      if (!isCurrent()) return false;
      if (latest.revision !== revision) {
        setNotice({
          tone: "warning",
          message:
            "Provider settings changed. Your routing draft is preserved; refresh and review the current revision.",
        });
        await reload();
        return false;
      }
      attempted = true;
      const updated = await dispatchProviderMutation(() =>
        patchSettings({
          expectedRevision: revision,
          llm: {
            activeProviderId: normalizedProviderId,
            activeModel: normalizedModel,
          },
        }),
      );
      const settled = routingChange.receive(
        updated,
        { providerId: normalizedProviderId, model: normalizedModel },
        Number(routingEditor.baseRevision ?? config.revision),
      );
      acknowledged = true;
      if (settled && viewCurrent())
        setNotice({
          tone: usesFallbackModels || usesStaleCatalog ? "warning" : "success",
          message: usesFallbackModels
            ? "Provider routing updated with a suggested model that has not been account-verified."
            : usesStaleCatalog
              ? "Provider routing updated using the last known account catalog; refresh has not verified it yet."
              : "Provider routing updated.",
        });
      await reload();
      return settled;
    } catch (saveError) {
      if (attempted && !acknowledged && isProviderPrecommitConflict(saveError, revision)) {
        await reload();
        if (viewCurrent())
          setNotice({
            tone: "warning",
            message:
              "Provider settings changed elsewhere. Your routing draft is preserved; review the current settings, then save again to retry.",
          });
        return false;
      }
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (isCurrent())
        setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged the routing change, but refreshing its evidence failed."
            : getErrorMessage(saveError),
        });
      return false;
    } finally {
      savesInFlight.current.delete(routingEditor.key);
      routingChange.endSave();
      finishProviderMutation();
    }
  };

  const handleSaveRouting = async () => persistRouting(routingProviderId, routingModel);

  return {
    routingEditor,
    mutation,
    routingChange,
    routingProviderId,
    routingModel,
    setRoutingProviderId,
    setRoutingModel,
    routingProvider,
    routingLlamaNeedsSetup,
    routingUsesFallbackModels,
    routingUsesStaleCatalog,
    routingModelUnavailable,
    routingModelNeedsRefresh,
    persistRouting,
    handleSaveRouting,
  };
}
