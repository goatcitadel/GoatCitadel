import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { GuidedModelSetup } from "../../../features/native-routes/settings/sections/GuidedModelSetup";
import { buildAppHref } from "../../../app/route-model";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { ProviderCatalogSettings } from "./ProviderCatalogSettings";
import { ProviderConnectionSettings } from "./ProviderConnectionSettings";
import { ProviderManagementSettings } from "./ProviderManagementSettings";
import { ProviderRoutingSettings } from "./ProviderRoutingSettings";
import { ProviderAdviceSettings } from "./ProviderAdviceSettings";

/** The governed model setup owner also serves the first-run route. */
export function ModelsSettings() {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const [notice, setNotice] = useState<string | null>(null);
  const onboarding = useQuery({
    queryKey: ["system", "onboarding"],
    queryFn: fetchOnboardingState,
    refetchOnWindowFocus: true,
  });
  return (
    <>
      <ProviderCatalogSettings />
      <ProviderConnectionSettings />
      <ProviderManagementSettings />
      <ProviderRoutingSettings />
      <ProviderAdviceSettings />
      <section aria-label="Model setup" className="mt-4 border-t border-line-subtle pt-4">
        <h3 className="font-display text-md font-semibold text-fg">Guided model setup</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Review the Gateway default, connection evidence, and model choices before using Chat.
        </p>
        {onboarding.isLoading ? (
          <p role="status" className="mt-3 text-sm text-fg-muted">
            Checking model setup…
          </p>
        ) : null}
        {onboarding.isError ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            Model setup unavailable: {describeApiError(onboarding.error).summary}
          </p>
        ) : null}
        {onboarding.isError ? (
          <Button size="sm" onClick={() => void onboarding.refetch()}>
            Try again
          </Button>
        ) : null}
        {!onboarding.isError && onboarding.data ? (
          <div className="cockpit-model-setup mt-4">
            <GuidedModelSetup
              workspaceId={workspaceId}
              onboarding={onboarding.data}
              route={{ area: "settings", section: "onboarding" }}
              navigate={(route) => navigate(buildAppHref(route))}
              renderApprovalAction={(plan, pending, selection) => (
                <SettingsApprovalOwnerAction
                  plan={plan}
                  owner="guided-model"
                  workspaceId={workspaceId}
                  disabled={pending}
                  viewIdentity={selection}
                />
              )}
              reloadOnboarding={async () => {
                await onboarding.refetch();
              }}
              setNotice={(next) => setNotice(next?.message ?? null)}
              onEnterChat={() => navigate("/chat")}
            />
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {notice}
          </p>
        ) : null}
      </section>
    </>
  );
}
