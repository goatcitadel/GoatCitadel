import { useEffect, useState } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useProviderRouting } from "../../../features/native-routes/settings/sections/use-provider-routing";
import { useProviderPlanActions } from "../../../features/native-routes/settings/sections/use-provider-plan-actions";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import type { Notice } from "../../../features/native-routes/settings/SettingsShared";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ProviderChangeStatus } from "./ProviderChangeStatus";
import { ProviderOutcomeCheck } from "./ProviderOutcomeCheck";
import { providerFieldClass } from "./ProviderProfileFields";
import { ProviderModelSearch } from "./ProviderModelSearch";

export function ProviderRoutingSettings() {
  const catalog = useProviderModelCatalog("system");
  const [open, setOpen] = useState(false),
    [notice, setNotice] = useState<Notice | null>(null);
  const [review, setReview] = useState<{ revision: number; providerId: string; model: string } | null>(null);
  const routing = useProviderRouting({ ...catalog, active: open, setNotice });
  const [plan, setPlan] = useState<ChangePlanRecord | null>(null);
  const actions = useProviderPlanActions({
    plan,
    setPlan,
    setNotice,
    viewIdentity: open,
    onSettled: async () => {
      await routing.routingChange.refresh();
      await catalog.reload();
    },
  });
  const { routingEditor, routingProvider, routingModel, routingProviderId, routingChange } = routing;
  const { loadModelsForProvider } = catalog;
  useEffect(() => {
    if (open && routingProviderId) void loadModelsForProvider(routingProviderId);
  }, [open, routingProviderId, loadModelsForProvider]);
  const locked = routingChange.hasPending || routing.mutation.pending || Boolean(routing.mutation.uncertain);
  const valid = Boolean(
    catalog.config &&
    !catalog.loading &&
    !catalog.error &&
    routingProvider &&
    routingProviderId &&
    routingModel &&
    !routingEditor.hasRemoteChanges &&
    !routing.routingLlamaNeedsSetup &&
    !routing.routingModelUnavailable &&
    !routing.routingModelNeedsRefresh,
  );
  const reviewCurrent = Boolean(
    review &&
    valid &&
    review.revision === routingEditor.baseRevision &&
    review.providerId === routingProviderId &&
    review.model === routingModel,
  );
  return (
    <section
      aria-label="Installation default routing"
      className="mt-4 space-y-3 rounded-lg border border-line bg-raised p-4"
    >
      <h3 className="font-display text-md font-semibold text-fg">Installation default routing</h3>
      <p className="text-sm text-fg-secondary">
        Gateway default: {catalog.config?.activeProviderId ?? "Unavailable"} ·{" "}
        {catalog.config?.activeModel ?? "Unavailable"}. Existing saved Chat choices retain their own routing.
      </p>
      <Button size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        Review installation routing
      </Button>
      <div hidden={!open} className="space-y-3">
        <ProviderModelSearch
          providers={catalog.providers}
          activeProviderId={catalog.config?.activeProviderId}
          activeModel={catalog.config?.activeModel}
          disabled={locked || catalog.loading}
          onSelect={(choice) => {
            routing.setRoutingProviderId(choice.providerId);
            routing.setRoutingModel(choice.model);
          }}
        />
        <label className="block text-sm text-fg-secondary">
          Default provider
          <select
            className={providerFieldClass}
            value={routingProviderId}
            disabled={locked || catalog.loading}
            onChange={(event) => routing.setRoutingProviderId(event.target.value)}
          >
            {!routingProvider ? <option value={routingProviderId}>Selected provider unavailable</option> : null}
            {catalog.providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-fg-secondary">
          Default model
          <select
            className={providerFieldClass}
            value={routingModel}
            disabled={locked || catalog.loading}
            onChange={(event) => routing.setRoutingModel(event.target.value)}
          >
            {!routingProvider?.models.includes(routingModel) ? (
              <option value={routingModel}>
                {routingModel || "Choose a model"}
                {routingModel ? " · Not in current catalog" : ""}
              </option>
            ) : null}
            {routingProvider?.models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-fg-muted">
          Catalog: {routingProvider?.modelProbeSource ?? "Unavailable"} ·{" "}
          {routingProvider?.modelRefreshStatus ?? "Unverified"}. Refresh does not substitute your selected model.
        </p>
        {routing.routingModelUnavailable || routing.routingModelNeedsRefresh || routing.routingLlamaNeedsSetup ? (
          <p role="status" className="text-sm text-status-waiting">
            This model is not verified as available. Refresh its provider catalog and choose a current model.
          </p>
        ) : null}
        {routingEditor.hasRemoteChanges ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-status-waiting">
              Routing changed elsewhere. Your draft is retained.
            </p>
            <Button disabled={locked} onClick={routingEditor.rebaseToCurrent}>
              Apply routing draft to current revision
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!routingProviderId || catalog.loading}
            onClick={() => void loadModelsForProvider(routingProviderId, { force: true })}
          >
            Refresh routing models
          </Button>
          <Button
            variant="primary"
            disabled={!valid || locked}
            onClick={() =>
              setReview({
                revision: Number(routingEditor.baseRevision),
                providerId: routingProviderId,
                model: routingModel,
              })
            }
          >
            Review default routing change
          </Button>
        </div>
      </div>
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">
          {notice.message}
        </p>
      ) : null}
      {catalog.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Routing evidence unavailable: {catalog.error}
        </p>
      ) : null}
      <ProviderOutcomeCheck mutation={routing.mutation} reload={catalog.reload} />
      <ProviderChangeStatus change={routingChange.change} onRefresh={routingChange.refresh} onReview={setPlan} />
      <Dialog
        open={Boolean(review)}
        title="Change installation default routing?"
        description="Apply the reviewed provider and model through the Gateway. Existing saved Chat selections keep their own preferences."
        onOpenChange={(next) => {
          if (!next && !locked) setReview(null);
        }}
      >
        <p className="mb-3 text-sm text-fg-secondary">
          Provider: {review?.providerId} · Model: {review?.model} · Settings revision {review?.revision}.
        </p>
        {routing.routingUsesFallbackModels || routing.routingUsesStaleCatalog ? (
          <p className="mb-3 text-sm text-status-waiting">
            This uses suggested or last-known model evidence; refresh has not verified availability.
          </p>
        ) : null}
        {!reviewCurrent ? (
          <p role="alert" className="mb-3 text-sm text-status-waiting">
            This review is stale. Close it and review the current draft.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!reviewCurrent || locked}
            onClick={() => {
              if (reviewCurrent && review) {
                setReview(null);
                void routing.persistRouting(review.providerId, review.model);
              }
            }}
          >
            Apply reviewed routing
          </Button>
          <Button disabled={locked} onClick={() => setReview(null)}>
            Keep current routing
          </Button>
        </div>
      </Dialog>
      <ChatChangePlanActionDialog
        plan={plan}
        pending={actions.mutation.pending || Boolean(actions.mutation.uncertain)}
        onClose={() => setPlan(null)}
        onConfirm={actions.confirm}
        onSubmitSecureInput={actions.secure}
        renderApprovalAction={(reviewed, pending) => <SettingsApprovalOwnerAction
          plan={reviewed} owner="provider-routing" workspaceId="default" disabled={pending}
          viewIdentity={[open, routingProviderId, routingModel, routingEditor.baseRevision]}
        />}
        onContinueOAuth={() => undefined}
        onSubmitPublicForm={() => undefined}
        onReviewArtifacts={() => undefined}
        onOpenNativePathPicker={() => undefined}
      />
    </section>
  );
}
