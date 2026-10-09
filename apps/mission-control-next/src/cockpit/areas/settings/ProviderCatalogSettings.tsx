import { useRef, useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentProviderReadiness } from "@goatcitadel/mission-control-shared/content/provider-readiness";
import {
  useProviderModelCatalog,
  type ProviderModelCatalogOption,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { ProviderConnectionEvidence } from "./ProviderConnectionEvidence";

const MODEL_PAGE_SIZE = 40;

function catalogEvidence(provider: ProviderModelCatalogOption): { label: string; detail: string } {
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "fresh") {
    return { label: "Live catalog", detail: "The latest model request returned this provider's account catalog." };
  }
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "stale") {
    return { label: "Last known catalog", detail: "These recorded models have not been verified by a current request. Refresh before relying on availability." };
  }
  if (provider.modelProbeState === "error" || provider.modelRefreshStatus === "error") {
    return { label: "Catalog unavailable", detail: "The model request failed. Any suggested names below do not prove account availability." };
  }
  if (provider.modelProbeState === "fallback" || provider.modelProbeSource) {
    return { label: "Suggested models", detail: "These names come from fallback data. A successful model refresh is needed to verify account availability." };
  }
  return { label: "Catalog not checked", detail: "Refresh models to ask the Gateway for the current account catalog." };
}

/** The shared catalog owns discovery, freshness, and credential evidence. */
export function ProviderCatalogSettings() {
  const { navigate } = useCockpitRoute();
  const catalog = useProviderModelCatalog("system");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<{ providerId: string; message: string } | null>(null);
  const refreshing = useRef(false);
  const provider = catalog.providers.find((item) => item.providerId === selectedId)
    ?? catalog.providers.find((item) => item.providerId === catalog.config?.activeProviderId)
    ?? catalog.providers[0];
  const ready = Boolean(catalog.config && !catalog.error);
  const activeProvider = catalog.providers.find((item) => item.providerId === catalog.config?.activeProviderId);

  async function refreshModels() {
    if (!ready || !provider || catalog.loading || refreshing.current) return;
    const providerId = provider.providerId;
    refreshing.current = true;
    setRefreshingId(providerId);
    setRefreshError(null);
    try {
      await catalog.loadModelsForProvider(providerId, { force: true });
    } catch (error) {
      setRefreshError({ providerId, message: describeApiError(error).summary });
    } finally {
      refreshing.current = false;
      setRefreshingId(null);
    }
  }

  const evidence = provider ? catalogEvidence(provider) : null;
  const activeModel = provider?.providerId === catalog.config?.activeProviderId ? catalog.config?.activeModel : undefined;
  const missingActiveModel = Boolean(activeModel && !provider?.models.includes(activeModel));
  const models = provider?.models.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const lastPage = Math.max(0, Math.ceil(models.length / MODEL_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleModels = models.slice(currentPage * MODEL_PAGE_SIZE, (currentPage + 1) * MODEL_PAGE_SIZE);

  return <section aria-labelledby="provider-catalog-title" className="mt-4 rounded-lg border border-line bg-sunken p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id="provider-catalog-title" className="font-display text-md font-semibold text-fg">Providers and model catalogs</h3>
        <p className="mt-1 text-sm text-fg-secondary">Inspect configured providers and refresh the models the Gateway can discover.</p></div>
      <Button size="sm" disabled={catalog.loading || refreshingId !== null} onClick={() => void catalog.reload()}>Refresh providers</Button>
    </div>
    {catalog.loading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading provider settings…</p> : null}
    {catalog.error ? <p role="alert" className="mt-3 text-sm text-status-failed">Provider settings unavailable: {catalog.error}. Refresh providers to retry.</p> : null}
    {ready ? <>
      <p className="mt-3 break-words text-sm text-fg-secondary">Saved Chat default: <strong className="text-fg">{activeProvider?.label ?? catalog.config?.activeProviderId ?? "No provider"} / {catalog.config?.activeModel || "No model"}</strong></p>
      {!activeProvider && catalog.config?.activeProviderId ? <p role="status" className="mt-1 text-sm text-status-waiting">The saved provider is missing from the current configuration. Choose a replacement through guided setup.</p> : null}
      {provider && evidence ? <>
        <label className="mt-4 block text-sm font-medium text-fg">Inspect provider
          <select value={provider.providerId} disabled={catalog.loading || refreshingId !== null}
            onChange={(event) => { setSelectedId(event.target.value); setQuery(""); setPage(0); }}
            className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-fg">
            {catalog.providers.map((item) => <option key={item.providerId} value={item.providerId}>{item.label}{item.providerId === catalog.config?.activeProviderId ? " (Chat default)" : ""}</option>)}
          </select>
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={presentProviderReadiness(provider)} />
          <span className="break-all text-xs text-fg-muted">{provider.sanitizedEndpointIdentity}</span></div>
        <ProviderConnectionEvidence key={provider.providerId} provider={provider}
          request={catalog.config?.providerConfigs?.find((item) => item.providerId === provider.providerId)?.request} />
        <div className="mt-4 rounded-md border border-line bg-raised p-3" aria-busy={refreshingId === provider.providerId}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-fg">{refreshingId === provider.providerId ? "Checking catalog…" : evidence.label}</h4>
            <Button size="sm" disabled={catalog.loading || refreshingId !== null} onClick={() => void refreshModels()}>Refresh models</Button></div>
          <p className="mt-2 text-sm text-fg-secondary">{evidence.detail}</p>
          <p className="mt-1 text-xs text-fg-muted">{provider.modelProbeCheckedAt ? <>Last check: <time dateTime={provider.modelProbeCheckedAt}>{provider.modelProbeCheckedAt}</time></> : "No model check recorded."}</p>
          {provider.modelProbeWarning ? <p role="status" className="mt-2 break-words text-sm text-status-waiting">{provider.modelProbeWarning}</p> : null}
          {refreshError?.providerId === provider.providerId ? <p role="alert" className="mt-2 text-sm text-status-failed">Refresh could not complete: {refreshError.message}</p> : null}
          {missingActiveModel ? <div role="status" className="mt-3 rounded-md border border-status-waiting/40 p-3 text-sm">
            <p className="break-words font-medium text-fg">Saved model: {activeModel}</p>
            <p className="mt-1 text-status-waiting">{provider.modelProbeSource === "live" && provider.modelRefreshStatus === "fresh"
              ? "This saved model is absent from the live catalog. Review a replacement through guided setup."
              : "This saved model is not in the displayed catalog. Refresh to verify its availability."}</p>
          </div> : null}
          <label className="mt-3 block text-sm font-medium text-fg">Filter models
            <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }}
              className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-3 text-fg" placeholder="Find a model" />
          </label>
          {visibleModels.length ? <ul aria-label="Discovered models" className="mt-3 divide-y divide-line-subtle">
            {visibleModels.map((model) => <li key={model} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm text-fg">
              <span className="min-w-0 break-all">{model}</span>{model === activeModel ? <span className="text-xs font-medium text-accent">Saved Chat default</span> : null}
            </li>)}
          </ul> : <p className="mt-3 text-sm text-fg-muted">{query.trim() ? "No models match this filter." : provider.modelProbeSource === "live" && provider.modelRefreshStatus === "fresh" ? "The live catalog returned no models." : "No model names are available. Refresh models to check the provider."}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-fg-muted">{models.length ? `${currentPage * MODEL_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * MODEL_PAGE_SIZE, models.length)} of ${models.length} model names` : "0 displayed model names"}</p>
            {models.length > MODEL_PAGE_SIZE ? <div className="flex gap-2"><Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous models</Button>
              <Button size="sm" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next models</Button></div> : null}
          </div>
        </div>
      </> : <p className="mt-3 text-sm text-fg-muted">No providers are configured. Use guided setup to connect one.</p>}
      <a href="/settings/models?shell=cockpit#providers" className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate("/settings/models?shell=cockpit#providers");
        }}>Manage provider credentials and endpoints</a>
    </> : null}
  </section>;
}
